"""Cost-control layer for the Costs page — reconciliation, cut-off, forecast.

ADDITIVE by design: nothing here changes how `api/routes/costs.py` builds the
existing budget/actual series. This module reuses those exact helpers (same
scoping, same repartition basis, same fiscal calendar) and adds the analysis
the controller needs on top:

  * a real CUT-OFF (`as_of`) — which slots are closed, which one is only
    partially posted, which are elapsed but not yet imported, which are future.
    "No import" is never read as "no expense";
  * period-coherent budget control — budget to the cut-off vs actual to the
    cut-off (the YTD variance), separate from the remaining annual envelope;
  * a forecast that reconciles slot by slot, so the landing chart and the
    headline number are the same arithmetic;
  * SAP ↔ KAIZO reconciliation: how much of the official ledger is explained by
    platform records, what is unclassified, what looks duplicated.

Two accounting rules are enforced everywhere in this module:
  1. A SAP actual and a platform-tracked cost are NEVER summed. They can be the
     same economic event; platform spend is coverage/explanation, not an extra.
  2. An open commitment is never counted twice — a future month lands at
     max(budget, open commitments), not budget + commitments.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.costs import (
    KINDS, OPEN_PO_STATUSES, Scope, UNASSIGNED,
    _cc_actuals, _cc_budgets_map, _cc_code_map, _commitments, _dept_map,
    _map_years, _months_map, _resolve_cc_explicit, _row_scope_ok, _sap_data,
    _site_ids, _site_of, _slot_index,
)
from app.models.models import (
    CostForecastAdjustment, Equipment, InterventionPart, LaborRecord,
    MachineIntervention, PurchaseOrder, PurchaseOrderItem, SapCostLine,
    SapCostLink, Supplier, WOCost, WOPart, WorkOrder,
)

# A trailing month whose posted actual is below this share of the average of the
# earlier posted months is treated as PARTIALLY posted, not closed. FY2026 in
# production shows exactly this: Jul posts $784 against a ~$120k monthly average.
PARTIAL_POSTING_RATIO = 0.25

# Slot status vocabulary (also the i18n key suffix on the client).
CLOSED, PARTIAL, AWAITING, FUTURE = "closed", "partial", "awaiting", "future"


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class CostContext:
    """Everything one cost-control request needs, resolved once."""
    year: int
    scope: Scope
    fiscal: bool
    source: str                       # 'sap' | 'internal'
    mmap: list                        # 12 (calendar year, month) pairs
    budget: dict                      # kind -> [12]
    actual: dict                      # kind -> [12]   (official series)
    tracked: dict                     # kind -> [12]   (platform-tracked spend)
    committed: dict                   # kind -> [12]   (open POs, by expected month)
    adjustments: dict                 # kind -> [12]   (manual forecast adjustments)
    adjustment_rows: list = field(default_factory=list)
    last_import_at: Optional[datetime] = None
    site_ids: dict = field(default_factory=dict)

    @property
    def today(self) -> date:
        return date.today()

    def slot_of(self, y: int, m: int) -> Optional[int]:
        """1-based slot of a calendar (year, month) in this context's map."""
        i = _slot_index(self.mmap).get((y, m))
        return None if i is None else i + 1

    @property
    def today_slot(self) -> Optional[int]:
        t = self.today
        return self.slot_of(t.year, t.month)


async def build_context(db: AsyncSession, scope: Scope, year: int) -> CostContext:
    """Resolve the official series for a year exactly the way /pnl does, plus the
    pieces the control layer adds (adjustments, import timestamp)."""
    site_ids = await _site_ids(db)
    sap = await _sap_data(db, year, scope)
    fiscal = sap is not None
    mmap = _months_map(year, fiscal)

    cc_actuals = await _cc_actuals(db, mmap, scope)
    cc_budgets = await _cc_budgets_map(db, mmap, scope)
    commitments = await _commitments(db, mmap, scope)

    budget = {k: [0.0] * 12 for k in KINDS}
    actual = {k: [0.0] * 12 for k in KINDS}
    tracked = {k: [0.0] * 12 for k in KINDS}

    for arrs in cc_budgets.values():
        for k in KINDS:
            for i in range(12):
                budget[k][i] += arrs[k][i]
    for a in cc_actuals.values():
        for k in KINDS:
            for i in range(12):
                tracked[k][i] += a[k]["monthly"][i]

    # Official actuals: SAP owns OPEX on an imported year; CAPEX is always the
    # platform-tracked improvement spend. Never both for the same scope.
    for i in range(12):
        actual["capex"][i] = tracked["capex"][i]
        actual["opex"][i] = tracked["opex"][i]
    if sap:
        budget["opex"] = list(sap["tot_budget"])
        actual["opex"] = list(sap["tot_actual"])

    committed = {k: [float(x) for x in commitments["totals"][k]] for k in KINDS}
    adj_rows, adjustments = await _adjustments(db, mmap, scope, site_ids)

    last_import = None
    if sap:
        last_import = (await db.execute(
            select(func.max(SapCostLine.imported_at)).where(SapCostLine.fiscal_year == year)
        )).scalar()

    return CostContext(
        year=year, scope=scope, fiscal=fiscal, source="sap" if sap else "internal",
        mmap=mmap, budget=budget, actual=actual, tracked=tracked, committed=committed,
        adjustments=adjustments, adjustment_rows=adj_rows,
        last_import_at=last_import, site_ids=site_ids,
    )


async def _adjustments(db: AsyncSession, mmap: list, scope: Scope, site_ids: dict):
    """Manual forecast adjustments mapped onto the months map, per kind."""
    rows = (await db.execute(
        select(CostForecastAdjustment).where(CostForecastAdjustment.year.in_(_map_years(mmap)))
    )).scalars().all()
    slots = _slot_index(mmap)
    out = {k: [0.0] * 12 for k in KINDS}
    kept = []
    for r in rows:
        i = slots.get((r.year, r.month))
        if i is None:
            continue
        # Same repartition basis as every other cost line on the page.
        if not _row_scope_ok(r.plant_id, r.cost_center or (r.site or ""), scope, site_ids):
            # Rows saved for the combined Quebec view carry no plant and no
            # cost center; keep them when the request is inside Quebec.
            if scope.is_plant or (r.site and scope.site and r.site != scope.site):
                continue
            if r.plant_id is not None:
                continue
        k = r.scope if r.scope in KINDS else "opex"
        out[k][i] += float(r.amount or 0)
        kept.append(r)
    return kept, out


# ─── Cut-off ─────────────────────────────────────────────────────────────────

def compute_as_of(ctx: CostContext, kind: str) -> dict:
    """Which slots are closed / partially posted / elapsed-but-unposted / future.

    On a SAP year the cut-off is the LEDGER, not the calendar: the last slot with
    a posted actual (demoted to `partial` when it is a token amount next to the
    other posted months). Elapsed months with nothing posted are `awaiting` — the
    expense exists, the import does not.

    On a platform-tracked year the cut-off is today: the running month is
    `partial`, everything before it is `closed`."""
    actual = ctx.actual[kind]
    today = ctx.today
    today_slot = ctx.today_slot
    # Slot the calendar sits at when today falls outside the map (past year → 12,
    # future year → 0, i.e. nothing elapsed).
    if today_slot is None:
        last = ctx.mmap[11]
        elapsed_slot = 12 if (last[0], last[1]) < (today.year, today.month) else 0
    else:
        elapsed_slot = today_slot

    posted = [i + 1 for i in range(12) if round(actual[i], 2) != 0]
    partial_slot = None
    last_closed = 0

    if ctx.source == "sap":
        if posted:
            last_posted = posted[-1]
            others = [abs(actual[s - 1]) for s in posted[:-1]]
            avg_others = sum(others) / len(others) if others else 0.0
            if avg_others > 0 and abs(actual[last_posted - 1]) < PARTIAL_POSTING_RATIO * avg_others:
                partial_slot = last_posted
                last_closed = last_posted - 1
            elif today_slot is not None and last_posted == today_slot and today.day < 28:
                # The month we are LIVING IN can only ever be partially posted.
                # Guarded on today_slot, not on `elapsed_slot`: outside the map
                # elapsed_slot is a synthetic 12 and a long-finished fiscal year
                # would be read as still running.
                partial_slot = last_posted
                last_closed = last_posted - 1
            else:
                last_closed = last_posted
        method = "sap_posted"
    else:
        last_closed = max(elapsed_slot - 1, 0)
        partial_slot = elapsed_slot if 1 <= elapsed_slot <= 12 else None
        method = "run_rate"

    status = []
    for s in range(1, 13):
        if s <= last_closed:
            status.append(CLOSED)
        elif partial_slot and s == partial_slot:
            status.append(PARTIAL)
        elif s <= elapsed_slot:
            status.append(AWAITING)
        else:
            status.append(FUTURE)

    cut = partial_slot or last_closed
    cut_entry = ctx.mmap[cut - 1] if 1 <= cut <= 12 else None
    awaiting = [s for s in range(1, 13) if status[s - 1] == AWAITING]
    import_age = None
    if ctx.last_import_at:
        import_age = (_now_utc() - ctx.last_import_at).days

    return {
        "today": today.isoformat(),
        "method": method,
        "source": ctx.source,
        "elapsed_slot": elapsed_slot,
        "last_closed_slot": last_closed,
        "partial_slot": partial_slot,
        "cutoff_slot": cut or None,
        "cutoff_period": ({"year": cut_entry[0], "month": cut_entry[1]} if cut_entry else None),
        "awaiting_slots": awaiting,
        "slot_status": status,
        "posted_slots": posted,
        "last_import_at": ctx.last_import_at.isoformat() if ctx.last_import_at else None,
        "import_age_days": import_age,
        # Months that already happened but carry no posted actual: the single
        # most important caveat on this page.
        "unposted_elapsed_months": len(awaiting),
    }


# ─── Forecast ────────────────────────────────────────────────────────────────

def _run_rate(ctx: CostContext, kind: str, as_of: dict, window: Optional[int] = None) -> float:
    """Average monthly spend over the CLOSED slots (optionally the last `window`
    of them). Never uses `awaiting` slots — an unimported month reads as zero and
    would drag the rate down."""
    closed = [s for s in range(1, 13) if as_of["slot_status"][s - 1] == CLOSED]
    if window:
        closed = closed[-window:]
    if not closed:
        return 0.0
    return sum(ctx.actual[kind][s - 1] for s in closed) / len(closed)


def compute_forecast(ctx: CostContext, kind: str, months: list[int], as_of: dict) -> dict:
    """Slot-by-slot forecast for the selected period, in three scenarios.

    Per-slot rules (identical in every scenario except the `to_go` basis):
      closed    → the posted actual
      partial   → max(posted actual, month budget)   (the month will finish)
      awaiting  → the `to_go` basis (the expense happened, the import did not)
      future    → the `to_go` basis
    Open commitments never stack on top of a month's budget: a month lands at
    max(basis, its open commitments). Overdue commitments (open POs expected in
    an already-closed month) DID NOT reach the actual, so they are carried on
    top of the cut-off — that is not double counting.
    Manual adjustments are added last and shown separately."""
    status = as_of["slot_status"]
    budget = ctx.budget[kind]
    actual = ctx.actual[kind]
    committed = ctx.committed[kind]
    adj = ctx.adjustments[kind]

    rate_all = _run_rate(ctx, kind, as_of)
    rate_recent = _run_rate(ctx, kind, as_of, window=3)

    def basis(scenario: str, s: int) -> float:
        b = budget[s - 1]
        if scenario == "base":
            # Awaiting months are best explained by the run rate when it is the
            # only evidence; take the higher of plan and observed pace.
            return max(b, rate_all) if status[s - 1] == AWAITING else b
        if scenario == "unfavorable":
            return max(b, rate_recent, rate_all)
        return min(b, rate_all) if rate_all > 0 else b       # favorable

    def build(scenario: str) -> dict:
        slots = []
        overdue = 0.0
        for s in range(1, 13):
            st = status[s - 1]
            a, b, c, dj = actual[s - 1], budget[s - 1], committed[s - 1], adj[s - 1]
            if st == CLOSED:
                value, kind_of = a, "actual"
                # An open PO expected in a closed month never reached the ledger.
                overdue += c
            elif st == PARTIAL:
                value, kind_of = max(a, b), "partial"
                overdue += 0.0
            else:
                base = basis(scenario, s)
                value, kind_of = max(base, c), "forecast"
            slots.append({
                "slot": s, "year": ctx.mmap[s - 1][0], "month": ctx.mmap[s - 1][1],
                "status": st, "basis": kind_of,
                "budget": round(b, 2), "actual": round(a, 2),
                "committed": round(c, 2), "adjustment": round(dj, 2),
                "forecast": round(value + dj, 2),
            })
        picked = [slots[m - 1] for m in months]
        # Overdue commitments only count when their (closed) slot is in view.
        overdue_in_period = sum(
            committed[m - 1] for m in months if status[m - 1] == CLOSED
        )
        total = sum(s["forecast"] for s in picked) + overdue_in_period
        return {
            "scenario": scenario,
            "total": round(total, 2),
            "overdue_committed": round(overdue_in_period, 2),
            "slots": slots,
        }

    scenarios = {s: build(s) for s in ("base", "favorable", "unfavorable")}

    # ── Period aggregates on a coherent time basis ──
    cut = as_of["cutoff_slot"] or 0
    to_date_months = [m for m in months if m <= cut]
    budget_period = sum(budget[m - 1] for m in months)
    actual_period = sum(actual[m - 1] for m in months)
    budget_to_date = sum(budget[m - 1] for m in to_date_months)
    actual_to_date = sum(actual[m - 1] for m in to_date_months)
    var_to_date = budget_to_date - actual_to_date
    committed_open = sum(
        committed[m - 1] for m in months
        if status[m - 1] in (CLOSED, PARTIAL, AWAITING, FUTURE)
    )
    base = scenarios["base"]

    assumptions = [
        {"key": "cutoff", "value": as_of["cutoff_period"],
         "detail": as_of["method"]},
        {"key": "closedSlots", "value": len([s for s in months if status[s - 1] == CLOSED])},
        {"key": "awaitingSlots", "value": len([s for s in months if status[s - 1] == AWAITING])},
        {"key": "futureSlots", "value": len([s for s in months if status[s - 1] == FUTURE])},
        {"key": "runRate", "value": round(rate_all, 2)},
        {"key": "runRateRecent", "value": round(rate_recent, 2)},
        {"key": "commitmentRule", "value": "max"},
        {"key": "adjustments", "value": round(sum(adj[m - 1] for m in months), 2)},
    ]

    return {
        "kind": kind,
        "months": months,
        "annual_budget": round(sum(budget), 2),
        "annual_actual": round(sum(actual), 2),
        "period_budget": round(budget_period, 2),
        "period_actual": round(actual_period, 2),
        "budget_to_date": round(budget_to_date, 2),
        "actual_to_date": round(actual_to_date, 2),
        "variance_to_date": round(var_to_date, 2),
        "variance_to_date_pct": round((var_to_date / budget_to_date) * 100, 1) if budget_to_date else None,
        "remaining_budget": round(budget_period - actual_period, 2),
        "committed_open": round(committed_open, 2),
        "adjustments_total": round(sum(adj[m - 1] for m in months), 2),
        "forecast": base["total"],
        "forecast_scenarios": {k: v["total"] for k, v in scenarios.items()},
        "projected_variance": round(budget_period - base["total"], 2),
        "projected_variance_pct": round(((budget_period - base["total"]) / budget_period) * 100, 1) if budget_period else None,
        "run_rate": round(rate_all, 2),
        "run_rate_recent": round(rate_recent, 2),
        "slots": base["slots"],
        "scenarios": scenarios,
        "assumptions": assumptions,
    }


# ─── SAP ↔ KAIZO reconciliation ──────────────────────────────────────────────

def _acct_label(line: SapCostLine) -> str:
    return (f"{line.account_code} {line.account_name}"
            if line.account_code and line.account_code != line.account_name else line.account_name)


def line_key(line: SapCostLine) -> tuple:
    return (line.fiscal_year, line.pos, line.cost_center_code, line.account_code)


async def sap_lines_for(db: AsyncSession, year: int, scope: Scope, site_ids: dict) -> list[SapCostLine]:
    lines = (await db.execute(
        select(SapCostLine).where(SapCostLine.fiscal_year == year)
    )).scalars().all()
    return [ln for ln in lines
            if 1 <= ln.pos <= 12 and _row_scope_ok(ln.plant_id, ln.cost_center, scope, site_ids)]


async def links_for(db: AsyncSession, year: int) -> dict[tuple, list[SapCostLink]]:
    rows = (await db.execute(
        select(SapCostLink).where(SapCostLink.fiscal_year == year)
    )).scalars().all()
    out: dict[tuple, list[SapCostLink]] = {}
    for r in rows:
        out.setdefault((r.fiscal_year, r.pos, r.cost_center_code, r.account_code), []).append(r)
    return out


async def reconciliation(db: AsyncSession, ctx: CostContext, months: list[int]) -> dict:
    """How much of the official ledger KAIZO can explain, and what is wrong with
    the data. Nothing here adds platform spend to the SAP actual."""
    scope, site_ids = ctx.scope, ctx.site_ids
    mapping = await _dept_map(db)
    known_ccs = {n.strip().lower() for n in (await _cc_code_map(db)).keys()}
    known_ccs |= {v.strip().lower() for v in mapping.values()}

    lines = await sap_lines_for(db, ctx.year, scope, site_ids) if ctx.source == "sap" else []
    links = await links_for(db, ctx.year)
    in_period = [ln for ln in lines if ln.pos in months]

    sap_total = sum(float(ln.actual or 0) for ln in in_period)
    linked_total = 0.0
    linked_lines = 0
    per_cc: dict[str, dict] = {}
    unclassified = {
        "no_cost_center": {"count": 0, "amount": 0.0},
        "unmapped_cost_center": {"count": 0, "amount": 0.0},
        "no_account": {"count": 0, "amount": 0.0},
    }

    for ln in in_period:
        amt = float(ln.actual or 0)
        key = line_key(ln)
        linked_amt = sum(float(l.amount or 0) for l in links.get(key, []))
        linked_amt = min(abs(linked_amt), abs(amt)) * (1 if amt >= 0 else -1)
        if links.get(key):
            linked_lines += 1
        linked_total += linked_amt
        cc = ln.cost_center or ""
        bucket = per_cc.setdefault(cc or UNASSIGNED, {
            "cost_center": cc or UNASSIGNED, "code": ln.cost_center_code or None,
            "sap_total": 0.0, "linked": 0.0, "lines": 0, "linked_lines": 0,
        })
        bucket["sap_total"] += amt
        bucket["linked"] += linked_amt
        bucket["lines"] += 1
        if links.get(key):
            bucket["linked_lines"] += 1

        if not cc.strip():
            unclassified["no_cost_center"]["count"] += 1
            unclassified["no_cost_center"]["amount"] += amt
        elif cc.strip().lower() not in known_ccs and not ln.cost_center_code:
            unclassified["unmapped_cost_center"]["count"] += 1
            unclassified["unmapped_cost_center"]["amount"] += amt
        if not (ln.account_code or "").strip():
            unclassified["no_account"]["count"] += 1
            unclassified["no_account"]["amount"] += amt

    # ── Suspicious repeats / reversals inside the fiscal year ──
    by_sig: dict[tuple, list[SapCostLine]] = {}
    for ln in lines:
        amt = round(float(ln.actual or 0), 2)
        if abs(amt) < 100:
            continue
        by_sig.setdefault((ln.cost_center_code, ln.account_code, abs(amt)), []).append(ln)
    duplicates, reversals = [], []
    for (cc_code, acct, amt), group in by_sig.items():
        if len(group) < 2:
            continue
        signs = {1 if float(g.actual or 0) >= 0 else -1 for g in group}
        entry = {
            "cost_center_code": cc_code,
            "cost_center": group[0].cost_center,
            "account_code": acct,
            "account": _acct_label(group[0]),
            "amount": amt,
            "occurrences": len(group),
            "positions": sorted(g.pos for g in group),
        }
        (reversals if len(signs) > 1 else duplicates).append(entry)
    duplicates.sort(key=lambda d: -d["amount"])
    reversals.sort(key=lambda d: -d["amount"])

    # ── Platform-tracked spend for the same window (coverage, NEVER a sum) ──
    tracked_period = sum(ctx.tracked["opex"][m - 1] for m in months)

    # ── Links pointing at a (fiscal_year, pos, cc, account) that no longer exists ──
    existing = {line_key(ln) for ln in lines}
    orphans = []
    for key, rows in links.items():
        if key in existing:
            continue
        orphans.append({
            "fiscal_year": key[0], "pos": key[1],
            "cost_center_code": key[2], "account_code": key[3],
            "links": len(rows), "amount": round(sum(float(r.amount or 0) for r in rows), 2),
        })

    cc_rows = sorted(per_cc.values(), key=lambda r: -abs(r["sap_total"]))
    for r in cc_rows:
        r["sap_total"] = round(r["sap_total"], 2)
        r["linked"] = round(r["linked"], 2)
        r["unlinked"] = round(r["sap_total"] - r["linked"], 2)
        r["linked_pct"] = round((r["linked"] / r["sap_total"]) * 100, 1) if r["sap_total"] else None

    return {
        "source": ctx.source,
        "currency": "CAD",
        "sap_total": round(sap_total, 2),
        "linked_total": round(linked_total, 2),
        "linked_pct": round((linked_total / sap_total) * 100, 1) if sap_total else None,
        "unlinked_total": round(sap_total - linked_total, 2),
        "unlinked_pct": round(((sap_total - linked_total) / sap_total) * 100, 1) if sap_total else None,
        "lines": len(in_period),
        "linked_lines": linked_lines,
        "unclassified": {k: {"count": v["count"], "amount": round(v["amount"], 2)}
                         for k, v in unclassified.items()},
        "duplicates": duplicates[:50],
        "reversals": reversals[:50],
        "orphan_links": orphans[:50],
        "tracked_total": round(tracked_period, 2),
        "tracked_coverage_pct": round((tracked_period / sap_total) * 100, 1) if sap_total else None,
        "by_cost_center": cc_rows,
    }


# ─── Commitments (open purchase orders) ──────────────────────────────────────

async def commitments_detail(db: AsyncSession, ctx: CostContext, months: list[int],
                             include_all: bool = False) -> dict:
    """Every purchase order behind the Committed (PO) indicator, with what the
    integration actually carries: ordered value, the portion already received
    (from the PO items' received_quantity), the open balance, dates and status.

    Nothing about invoicing is invented — purchase_orders has no invoice state,
    so the response says so via `has_invoice_data: false`."""
    scope, site_ids = ctx.scope, ctx.site_ids
    window = {ctx.mmap[m - 1] for m in months}
    today = ctx.today

    rows = (await db.execute(
        select(PurchaseOrder, Supplier.name)
        .join(Supplier, PurchaseOrder.supplier_id == Supplier.id, isouter=True)
    )).all()
    ids = [po.id for po, _ in rows]
    items_by_po: dict = {}
    if ids:
        item_rows = (await db.execute(
            select(PurchaseOrderItem.order_id,
                   func.sum(PurchaseOrderItem.total_cost),
                   func.sum(PurchaseOrderItem.received_quantity * PurchaseOrderItem.unit_cost),
                   func.count(PurchaseOrderItem.id),
                   func.sum(PurchaseOrderItem.quantity),
                   func.sum(PurchaseOrderItem.received_quantity))
            .where(PurchaseOrderItem.order_id.in_(ids))
            .group_by(PurchaseOrderItem.order_id)
        )).all()
        for oid, total, received_val, n, qty, rqty in item_rows:
            items_by_po[oid] = {
                "items_total": float(total or 0), "received_value": float(received_val or 0),
                "item_count": int(n or 0), "qty": float(qty or 0), "received_qty": float(rqty or 0),
            }

    out = []
    totals = {"ordered": 0.0, "received": 0.0, "open": 0.0, "overdue": 0.0, "count": 0}
    for po, supplier_name in rows:
        st = po.status.value if hasattr(po.status, "value") else po.status
        is_open = st in OPEN_PO_STATUSES
        if not include_all and not is_open:
            continue
        if st in ("draft", "cancelled"):
            continue
        cc = (po.cost_center or "").strip()
        if scope.is_plant or po.plant_id is not None:
            if not _row_scope_ok(po.plant_id, cc, scope, site_ids):
                continue
        elif scope.site and (not cc or _site_of(cc) != scope.site):
            continue
        when = po.expected_date or po.order_date
        if not when or (when.year, when.month) not in window:
            continue

        agg = items_by_po.get(po.id, {})
        ordered = float(po.total_amount or agg.get("items_total") or 0)
        received = float(agg.get("received_value") or 0)
        if st == "received" and not received:
            received = ordered
        open_balance = round(max(ordered - received, 0.0), 2)
        age_days = (today - po.order_date).days if po.order_date else None
        overdue_days = ((today - po.expected_date).days
                        if po.expected_date and po.expected_date < today and is_open else 0)
        partial = bool(agg.get("received_qty")) and agg.get("received_qty", 0) < agg.get("qty", 0)

        out.append({
            "id": str(po.id),
            "order_number": po.order_number,
            "supplier": supplier_name or "—",
            "site": _site_of(cc) if cc else None,
            "plant_id": str(po.plant_id) if po.plant_id else None,
            "cost_center": cc or None,
            "scope": "capex" if po.scope == "capex" else "opex",
            "status": st,
            "order_date": po.order_date.isoformat() if po.order_date else None,
            "expected_date": po.expected_date.isoformat() if po.expected_date else None,
            "received_date": po.received_date.isoformat() if po.received_date else None,
            "ordered_amount": round(ordered, 2),
            "received_amount": round(received, 2),
            "open_balance": open_balance,
            "item_count": agg.get("item_count", 0),
            "ordered_qty": agg.get("qty", 0),
            "received_qty": agg.get("received_qty", 0),
            "age_days": age_days,
            "overdue_days": overdue_days,
            "partially_received": partial,
            "slot": (ctx.slot_of(when.year, when.month) if when else None),
            "currency": po.currency or "CAD",
        })
        totals["ordered"] += ordered
        totals["received"] += received
        totals["open"] += open_balance
        totals["count"] += 1
        if overdue_days > 0:
            totals["overdue"] += open_balance

    out.sort(key=lambda r: (-(r["overdue_days"] or 0), -r["open_balance"]))
    return {
        "currency": "CAD",
        "orders": out,
        "totals": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in totals.items()},
        # What the PO integration does NOT carry — stated, not faked.
        "has_invoice_data": False,
        "has_equipment_link": False,
        "has_work_order_link": False,
        "ageing_buckets": _ageing(out),
    }


def _ageing(orders: list[dict]) -> list[dict]:
    buckets = [(0, 30), (31, 60), (61, 90), (91, 10_000)]
    out = []
    for lo, hi in buckets:
        sel = [o for o in orders if o["age_days"] is not None and lo <= o["age_days"] <= hi]
        out.append({"from": lo, "to": None if hi > 9999 else hi,
                    "count": len(sel), "amount": round(sum(o["open_balance"] for o in sel), 2)})
    return out


# ─── Platform-tracked cost sources, per equipment ────────────────────────────

async def tracked_cost_by_equipment(db: AsyncSession, ctx: CostContext, months: list[int]) -> dict:
    """Platform-tracked spend per equipment for the period, split into parts /
    services / labor and planned / unplanned. Sources are exactly the ones the
    by-machine tab already uses — this adds the maintenance-type split."""
    slots = _slot_index(ctx.mmap)
    years = _map_years(ctx.mmap)
    mapping = await _dept_map(db)
    site_ids = ctx.site_ids
    keep = {ctx.mmap[m - 1] for m in months}
    out: dict = {}

    def bucket(eid, name, code):
        key = str(eid) if eid else "none"
        return out.setdefault(key, {
            "equipment_id": None if key == "none" else key, "name": name or "—", "code": code,
            "total": 0.0, "parts": 0.0, "services": 0.0, "labor": 0.0,
            "planned": 0.0, "unplanned": 0.0, "monthly": [0.0] * 12,
        })

    def add(eid, name, code, cc, y, m, amount, family, wo_type, plant_id):
        if (y, m) not in keep or slots.get((y, m)) is None:
            return
        if not _row_scope_ok(plant_id, cc, ctx.scope, site_ids):
            return
        b = bucket(eid, name, code)
        b["total"] += amount
        b[family] += amount
        wt = wo_type.value if hasattr(wo_type, "value") else (wo_type or "corrective")
        b["unplanned" if wt == "corrective" else "planned"] += amount
        b["monthly"][slots[(y, m)]] += amount

    q = (select(WorkOrder.equipment_id, Equipment.name, Equipment.code,
                WorkOrder.cost_center, Equipment.department, WorkOrder.plant_id, WorkOrder.type,
                WOCost.transaction_type, WOCost.date, WOCost.amount)
         .select_from(WOCost)
         .join(WorkOrder, WOCost.work_order_id == WorkOrder.id)
         .join(Equipment, WorkOrder.equipment_id == Equipment.id, isouter=True))
    for eid, name, code, cc, dept, plant_id, wtype, ttype, d, amount in (await db.execute(q)).all():
        if not d or d.year not in years:
            continue
        tt = ttype.value if hasattr(ttype, "value") else (ttype or "other")
        if tt == "labor":
            continue          # labor comes from labor_records (effective cost)
        fam = "parts" if tt in ("parts", "local_parts", "external_parts") else "services"
        add(eid, name, code, _resolve_cc_explicit(cc, dept, mapping), d.year, d.month,
            float(amount or 0), fam, wtype, plant_id)

    q = (select(WorkOrder.equipment_id, Equipment.name, Equipment.code,
                WorkOrder.cost_center, Equipment.department, WorkOrder.plant_id, WorkOrder.type,
                LaborRecord.date, LaborRecord.labor_cost)
         .select_from(LaborRecord)
         .join(WorkOrder, LaborRecord.work_order_id == WorkOrder.id)
         .join(Equipment, WorkOrder.equipment_id == Equipment.id, isouter=True)
         .where(LaborRecord.labor_cost.isnot(None)))
    for eid, name, code, cc, dept, plant_id, wtype, d, amount in (await db.execute(q)).all():
        if not d or d.year not in years:
            continue
        add(eid, name, code, _resolve_cc_explicit(cc, dept, mapping), d.year, d.month,
            float(amount or 0), "labor", wtype, plant_id)

    q = (select(WorkOrder.equipment_id, Equipment.name, Equipment.code,
                WorkOrder.cost_center, Equipment.department, WorkOrder.plant_id, WorkOrder.type,
                WOPart.created_at, WOPart.total_cost)
         .select_from(WOPart)
         .join(WorkOrder, WOPart.work_order_id == WorkOrder.id)
         .join(Equipment, WorkOrder.equipment_id == Equipment.id, isouter=True)
         .where(WOPart.total_cost.isnot(None)))
    for eid, name, code, cc, dept, plant_id, wtype, dt, amount in (await db.execute(q)).all():
        if not dt or dt.year not in years:
            continue
        add(eid, name, code, _resolve_cc_explicit(cc, dept, mapping), dt.year, dt.month,
            float(amount or 0), "parts", wtype, plant_id)

    q = (select(MachineIntervention.equipment_id, Equipment.name, Equipment.code,
                MachineIntervention.cost_center, Equipment.department, MachineIntervention.plant_id,
                InterventionPart.added_at, InterventionPart.total_cost)
         .select_from(InterventionPart)
         .join(MachineIntervention, InterventionPart.intervention_id == MachineIntervention.id)
         .join(Equipment, MachineIntervention.equipment_id == Equipment.id, isouter=True)
         .where(InterventionPart.approval_status == "approved",
                InterventionPart.total_cost.isnot(None)))
    for eid, name, code, cc, dept, plant_id, dt, amount in (await db.execute(q)).all():
        if not dt or dt.year not in years:
            continue
        add(eid, name, code, _resolve_cc_explicit(cc, dept, mapping), dt.year, dt.month,
            float(amount or 0), "parts", "corrective", plant_id)

    return out
