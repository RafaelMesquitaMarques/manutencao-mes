"""Cost analytics that cross the ledger with maintenance, procurement and stock.

Everything here is read-only analysis built on the SAME scoping helpers as the
Costs page (`_row_scope_ok`, the months map, the QS/QM repartition), so a number
shown next to an existing chart is computed on the same population.

Honesty rules kept throughout:
  * a metric that cannot be computed from real data returns null plus the reason,
    never a filler value;
  * "no linked cost" is reported as missing coverage, not as zero cost;
  * purchase, stock entry and consumption are three views of ONE event and are
    reported separately, never added together.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.costs import (
    KINDS, OPEN_PO_STATUSES, Scope, UNASSIGNED,
    _dept_map, _map_years, _resolve_cc_explicit, _row_scope_ok, _sap_data,
    _scope_of, _site_of, _slot_index,
)
from app.models.models import (
    Equipment, InterventionPart, InventoryMovement, Machine, MachineIntervention,
    MachineProductionHourly, MachineStop, PurchaseOrder, PurchaseOrderItem,
    SapCostLine, StockItem, Supplier, WOPart, WorkOrder, WorkOrderStatus,
    WorkOrderType,
)
from app.services.cost_control import CostContext, tracked_cost_by_equipment

# A corrective work order opened within this many days of a previous corrective
# one on the same asset counts as a recurrence.
REPEAT_WINDOW_DAYS = 30
# A purchase order whose expected date is this close to its order date reads as
# an emergency buy. The rule is stated in the payload so it can be challenged.
EMERGENCY_LEAD_DAYS = 3
# Stock with no movement for this long is reported as dormant.
DORMANT_DAYS = 365


def window_bounds(ctx: CostContext, months: list[int]) -> tuple[datetime, datetime, int]:
    """UTC datetime bounds of the selected slots, plus the number of days."""
    first = ctx.mmap[min(months) - 1]
    last = ctx.mmap[max(months) - 1]
    start = date(first[0], first[1], 1)
    end_month = date(last[0], last[1], 1)
    nxt = date(end_month.year + (end_month.month // 12), (end_month.month % 12) + 1, 1)
    end = nxt - timedelta(days=1)
    return (datetime.combine(start, time.min, tzinfo=timezone.utc),
            datetime.combine(end, time.max, tzinfo=timezone.utc),
            (end - start).days + 1)


# ─── Equipment: cost × reliability ───────────────────────────────────────────

async def equipment_analysis(db: AsyncSession, ctx: CostContext, months: list[int]) -> dict:
    """Per equipment: platform-tracked cost split, intervention counts, repeat
    failures, downtime, MTBF/MTTR, criticality, cost per operating hour.

    MTTR/MTBF use the same formulas as the KPI page (corrective repair hours +
    intervention durations; failures over calendar operating time) so the two
    pages never disagree."""
    since, until, window_days = window_bounds(ctx, months)
    costs = await tracked_cost_by_equipment(db, ctx, months)

    eq_rows = (await db.execute(
        select(Equipment.id, Equipment.name, Equipment.code, Equipment.criticality,
               Equipment.department, Equipment.cost_center, Equipment.plant_id,
               Equipment.asset_type)
    )).all()
    equipment = {str(r[0]): r for r in eq_rows}

    # machine → equipment, so stop/production rows can be attributed to an asset.
    m_rows = (await db.execute(select(Machine.id, Machine.equipment_id))).all()
    machine_to_eq = {mid: str(eid) for mid, eid in m_rows if eid}

    stats: dict[str, dict] = {}

    def row(eid: str) -> dict:
        r = stats.get(eid)
        if r is None:
            e = equipment.get(eid)
            r = {
                "equipment_id": eid,
                "name": (e[1] if e else None) or "—",
                "code": e[2] if e else None,
                "criticality": (e[3] if e else None) or "medium",
                "department": e[4] if e else None,
                "cost_center": e[5] if e else None,
                "asset_type": (e[7] if e else None) or "production",
                "cost": 0.0, "parts": 0.0, "services": 0.0, "labor": 0.0,
                "planned_cost": 0.0, "unplanned_cost": 0.0, "monthly": [0.0] * 12,
                "corrective": 0, "preventive": 0, "other_wo": 0, "interventions": 0,
                "repeat_failures": 0, "downtime_hours": 0.0,
                "repair_samples": [], "operating_hours": None,
            }
            stats[eid] = r
        return r

    for key, c in costs.items():
        if key == "none":
            continue
        r = row(key)
        r["cost"] = c["total"]
        r["parts"] = c["parts"]
        r["services"] = c["services"]
        r["labor"] = c["labor"]
        r["planned_cost"] = c["planned"]
        r["unplanned_cost"] = c["unplanned"]
        r["monthly"] = c["monthly"]
        if not r["name"] or r["name"] == "—":
            r["name"] = c["name"]
            r["code"] = c["code"]

    # Work orders in the window (counts, downtime, repair samples, recurrences).
    wo_rows = (await db.execute(
        select(WorkOrder.equipment_id, WorkOrder.type, WorkOrder.status,
               WorkOrder.opened_at, WorkOrder.downtime_hours, WorkOrder.repair_hours,
               WorkOrder.ticket_id, WorkOrder.plant_id, WorkOrder.cost_center,
               Equipment.department)
        .select_from(WorkOrder)
        .join(Equipment, WorkOrder.equipment_id == Equipment.id, isouter=True)
        .where(WorkOrder.opened_at >= since, WorkOrder.opened_at <= until)
    )).all()
    mapping = await _dept_map(db)
    corrective_dates: dict[str, list] = defaultdict(list)
    counted_tickets: set = set()
    for eid, wtype, status, opened, downtime, repair, ticket_id, plant_id, cc, dept in wo_rows:
        if not eid:
            continue
        if not _row_scope_ok(plant_id, _resolve_cc_explicit(cc, dept, mapping), ctx.scope, ctx.site_ids):
            continue
        key = str(eid)
        r = row(key)
        wt = wtype.value if hasattr(wtype, "value") else (wtype or "corrective")
        if wt == "corrective":
            r["corrective"] += 1
            if opened:
                corrective_dates[key].append(opened)
        elif wt == "preventive":
            r["preventive"] += 1
        else:
            r["other_wo"] += 1
        if downtime:
            r["downtime_hours"] += float(downtime)
        done = status == WorkOrderStatus.completed or getattr(status, "value", status) == "completed"
        if wt == "corrective" and done and repair:
            r["repair_samples"].append(float(repair))
            if ticket_id:
                counted_tickets.add(ticket_id)

    for key, dates in corrective_dates.items():
        ds = sorted(d for d in dates if d)
        repeats = sum(1 for a, b in zip(ds, ds[1:])
                      if (b - a).days <= REPEAT_WINDOW_DAYS)
        stats[key]["repeat_failures"] = repeats

    # Kiosk interventions (counts + MTTR samples, de-duplicated against WOs).
    iv_rows = (await db.execute(
        select(MachineIntervention.equipment_id, MachineIntervention.status,
               MachineIntervention.intervention_duration_minutes,
               MachineIntervention.total_downtime_minutes,
               MachineIntervention.ticket_id, MachineIntervention.plant_id,
               MachineIntervention.cost_center, Equipment.department)
        .select_from(MachineIntervention)
        .join(Equipment, MachineIntervention.equipment_id == Equipment.id, isouter=True)
        .where(MachineIntervention.called_at >= since, MachineIntervention.called_at <= until)
    )).all()
    for eid, status, dur, downtime, ticket_id, plant_id, cc, dept in iv_rows:
        if not eid:
            continue
        if not _row_scope_ok(plant_id, _resolve_cc_explicit(cc, dept, mapping), ctx.scope, ctx.site_ids):
            continue
        r = row(str(eid))
        r["interventions"] += 1
        if status == "completed" and dur and ticket_id not in counted_tickets:
            r["repair_samples"].append(float(dur) / 60.0)

    # Logged machine stops → downtime on the asset behind the machine.
    stop_rows = (await db.execute(
        select(MachineStop.machine_id, func.sum(MachineStop.duration_minutes))
        .where(MachineStop.started_at >= since, MachineStop.started_at <= until,
               MachineStop.duration_minutes.isnot(None))
        .group_by(MachineStop.machine_id)
    )).all()
    for mid, minutes in stop_rows:
        eid = machine_to_eq.get(mid)
        if not eid or eid not in stats:
            continue
        stats[eid]["downtime_hours"] += float(minutes or 0) / 60.0

    # Real operating hours from the per-hour production feed (ADAM). Absent →
    # cost/hour stays null with a reason instead of a made-up denominator.
    hour_rows = (await db.execute(
        select(MachineProductionHourly.machine_id,
               func.count(func.distinct(MachineProductionHourly.hour)))
        .where(MachineProductionHourly.hour >= since, MachineProductionHourly.hour <= until,
               MachineProductionHourly.count > 0)
        .group_by(MachineProductionHourly.machine_id)
    )).all()
    for mid, hours in hour_rows:
        eid = machine_to_eq.get(mid)
        if eid and eid in stats:
            stats[eid]["operating_hours"] = float(hours or 0)

    total_cost = sum(r["cost"] for r in stats.values())
    out = []
    for r in stats.values():
        samples = r.pop("repair_samples")
        downtime = r["downtime_hours"]
        failures = r["corrective"]
        calendar_hours = window_days * 24.0
        operating = max(calendar_hours - downtime, 0.0)
        r["mttr_hours"] = round(sum(samples) / len(samples), 2) if samples else None
        r["mtbf_hours"] = round(operating / failures, 1) if failures else None
        r["cost_per_operating_hour"] = (
            round(r["cost"] / r["operating_hours"], 2)
            if r["operating_hours"] else None
        )
        r["cost_per_hour_basis"] = "production_feed" if r["operating_hours"] else None
        r["downtime_hours"] = round(downtime, 1)
        r["share_pct"] = round((r["cost"] / total_cost) * 100, 1) if total_cost else None
        for k in ("cost", "parts", "services", "labor", "planned_cost", "unplanned_cost"):
            r[k] = round(r[k], 2)
        r["monthly"] = [round(x, 2) for x in r["monthly"]]
        out.append(r)

    # Attention ranking: high cost AND recurring failures AND operational impact.
    # Each dimension is normalised 0..1 on the observed population, so the score
    # says "worst on this floor", not an absolute grade.
    def norm(vals):
        mx = max(vals) if vals else 0
        return (lambda v: (v / mx) if mx else 0.0)

    n_cost = norm([r["cost"] for r in out])
    n_rep = norm([r["repeat_failures"] for r in out])
    n_down = norm([r["downtime_hours"] for r in out])
    crit_w = {"critical": 1.0, "high": 0.8, "medium": 0.5, "low": 0.25}
    for r in out:
        r["attention_score"] = round(
            100 * (0.40 * n_cost(r["cost"]) + 0.25 * n_rep(r["repeat_failures"])
                   + 0.25 * n_down(r["downtime_hours"])
                   + 0.10 * crit_w.get((r["criticality"] or "medium").lower(), 0.5)), 1)
    out.sort(key=lambda r: -r["cost"])

    linked = sum(1 for r in out if r["cost"] > 0)
    return {
        "currency": "CAD",
        "window": {"from": since.date().isoformat(), "to": until.date().isoformat(),
                   "days": window_days},
        "equipment": out,
        "total_tracked_cost": round(total_cost, 2),
        # The honesty flag: how much of the official ledger these rows explain.
        "coverage": {
            "official_total": round(sum(ctx.actual["opex"][m - 1] for m in months)
                                    + sum(ctx.actual["capex"][m - 1] for m in months), 2),
            "tracked_total": round(total_cost, 2),
            "equipment_with_cost": linked,
            "equipment_total": len(equipment),
            "source": ctx.source,
        },
    }


async def equipment_repair_replace(db: AsyncSession, ctx: CostContext, months: list[int],
                                   equipment_id: str, analysis: dict) -> dict:
    """Inputs for a repair-vs-replace discussion. Deliberately NOT a verdict:
    it returns the facts and the assumptions that would have to be supplied
    (replacement price, remaining life, production value of downtime) and says
    which of them are missing."""
    row = next((r for r in analysis["equipment"] if r["equipment_id"] == equipment_id), None)
    if not row:
        return {"available": False, "reason": "no_cost_data"}
    eq = await db.get(Equipment, equipment_id)
    specs = (eq.specifications or {}) if eq else {}
    replacement = specs.get("replacement_cost") or specs.get("purchase_cost")
    age_years = None
    if eq and eq.manufacturing_year:
        age_years = date.today().year - int(eq.manufacturing_year)

    missing = []
    if not replacement:
        missing.append("replacement_cost")
    if age_years is None:
        missing.append("asset_age")
    if row["cost_per_operating_hour"] is None:
        missing.append("operating_hours")
    window_days = analysis["window"]["days"]
    annualised = row["cost"] * (365.0 / window_days) if window_days else None

    return {
        "available": not missing,
        "missing_inputs": missing,
        "equipment_id": equipment_id,
        "name": row["name"],
        "period_cost": row["cost"],
        "annualised_cost": round(annualised, 2) if annualised else None,
        "replacement_cost": replacement,
        "age_years": age_years,
        "downtime_hours": row["downtime_hours"],
        "repeat_failures": row["repeat_failures"],
        "criticality": row["criticality"],
        # Only computed when every input exists — otherwise the UI shows what is
        # missing rather than a ratio built on guesses.
        "cost_ratio_pct": (round((annualised / replacement) * 100, 1)
                           if annualised and replacement else None),
        "note": "assumptions_required",
    }


# ─── Suppliers ───────────────────────────────────────────────────────────────

async def supplier_analysis(db: AsyncSession, ctx: CostContext, months: list[int]) -> dict:
    """Monthly evolution per supplier, same-period comparison against the previous
    year, spend concentration, and unit-price drift for items that are genuinely
    comparable (same stock item, or the exact same description)."""
    slots = _slot_index(ctx.mmap)
    prev_map = [(y - 1, m) for y, m in ctx.mmap]
    prev_slots = {ym: i for i, ym in enumerate(prev_map)}
    keep = {ctx.mmap[m - 1] for m in months}
    keep_prev = {prev_map[m - 1] for m in months}
    mapping = await _dept_map(db)

    per: dict[str, dict] = {}

    def row(name: str) -> dict:
        return per.setdefault(name, {
            "supplier": name, "monthly": [0.0] * 12, "prev_monthly": [0.0] * 12,
            "total": 0.0, "prev_total": 0.0, "committed": 0.0, "orders": 0,
            "by_scope": {"opex": 0.0, "capex": 0.0}, "emergency": 0.0, "planned": 0.0,
        })

    po_rows = (await db.execute(
        select(PurchaseOrder, Supplier.name)
        .join(Supplier, PurchaseOrder.supplier_id == Supplier.id, isouter=True)
    )).all()
    for po, sname in po_rows:
        st = po.status.value if hasattr(po.status, "value") else po.status
        if st in ("draft", "cancelled"):
            continue
        cc = (po.cost_center or "").strip()
        if ctx.scope.is_plant or po.plant_id is not None:
            if not _row_scope_ok(po.plant_id, cc, ctx.scope, ctx.site_ids):
                continue
        elif ctx.scope.site and (not cc or _site_of(cc) != ctx.scope.site):
            continue
        when = po.received_date or po.expected_date or po.order_date
        if not when:
            continue
        amt = float(po.total_amount or 0)
        name = (sname or "").strip() or "—"
        r = row(name)
        lead = ((po.expected_date - po.order_date).days
                if po.expected_date and po.order_date else None)
        if (when.year, when.month) in keep:
            r["monthly"][slots[(when.year, when.month)]] += amt
            r["total"] += amt
            r["orders"] += 1
            r["by_scope"]["capex" if po.scope == "capex" else "opex"] += amt
            if st in OPEN_PO_STATUSES:
                r["committed"] += amt
            if lead is not None and lead <= EMERGENCY_LEAD_DAYS:
                r["emergency"] += amt
            else:
                r["planned"] += amt
        elif (when.year, when.month) in keep_prev:
            r["prev_monthly"][prev_slots[(when.year, when.month)]] += amt
            r["prev_total"] += amt

    part_rows = (await db.execute(
        select(WOPart.supplier, WOPart.total_cost, WOPart.created_at, WorkOrder.type,
               WorkOrder.cost_center, WorkOrder.plant_id, Equipment.department)
        .select_from(WOPart)
        .join(WorkOrder, WOPart.work_order_id == WorkOrder.id)
        .join(Equipment, WorkOrder.equipment_id == Equipment.id, isouter=True)
        .where(WOPart.total_cost.isnot(None), WOPart.supplier.isnot(None))
    )).all()
    for sname, total, created, wtype, cc, plant_id, dept in part_rows:
        if not created:
            continue
        resolved = _resolve_cc_explicit(cc, dept, mapping)
        if not _row_scope_ok(plant_id, resolved, ctx.scope, ctx.site_ids):
            continue
        amt = float(total or 0)
        r = row((sname or "").strip() or "—")
        if (created.year, created.month) in keep:
            r["monthly"][slots[(created.year, created.month)]] += amt
            r["total"] += amt
            r["by_scope"][_scope_of(wtype)] += amt
            r["planned"] += amt
        elif (created.year, created.month) in keep_prev:
            r["prev_monthly"][prev_slots[(created.year, created.month)]] += amt
            r["prev_total"] += amt

    rows = [r for r in per.values() if round(r["total"], 2) or round(r["prev_total"], 2)]
    for r in rows:
        r["delta"] = round(r["total"] - r["prev_total"], 2)
        r["delta_pct"] = (round(((r["total"] - r["prev_total"]) / r["prev_total"]) * 100, 1)
                          if r["prev_total"] else None)
        for k in ("total", "prev_total", "committed", "emergency", "planned"):
            r[k] = round(r[k], 2)
        r["monthly"] = [round(x, 2) for x in r["monthly"]]
        r["prev_monthly"] = [round(x, 2) for x in r["prev_monthly"]]
        r["by_scope"] = {k: round(v, 2) for k, v in r["by_scope"].items()}
    rows.sort(key=lambda r: -r["total"])

    total = sum(r["total"] for r in rows)
    shares = [(r["total"] / total) for r in rows if total] if total else []
    hhi = round(sum(s * s for s in shares) * 10000, 0) if shares else None
    top3 = round(sum(r["total"] for r in rows[:3]) / total * 100, 1) if total else None
    top5 = round(sum(r["total"] for r in rows[:5]) / total * 100, 1) if total else None

    return {
        "currency": "CAD",
        "suppliers": rows,
        "total": round(total, 2),
        "prev_total": round(sum(r["prev_total"] for r in rows), 2),
        "concentration": {"hhi": hhi, "top3_pct": top3, "top5_pct": top5,
                          "supplier_count": len(rows)},
        "emergency_rule": {"lead_days": EMERGENCY_LEAD_DAYS},
        "price_drift": await _price_drift(db, ctx, months),
    }


async def _price_drift(db: AsyncSession, ctx: CostContext, months: list[int]) -> list[dict]:
    """Unit-price movement for items that are actually comparable: the SAME
    stock item (or, failing that, an identical description) purchased more than
    once. Different items are never compared."""
    since, until, _ = window_bounds(ctx, months)
    prev_since = since.replace(year=since.year - 1)
    rows = (await db.execute(
        select(PurchaseOrderItem.stock_item_id, PurchaseOrderItem.description,
               PurchaseOrderItem.unit_cost, PurchaseOrderItem.quantity,
               PurchaseOrder.order_date, PurchaseOrder.status, PurchaseOrder.cost_center,
               PurchaseOrder.plant_id, Supplier.name, StockItem.code, StockItem.name)
        .select_from(PurchaseOrderItem)
        .join(PurchaseOrder, PurchaseOrderItem.order_id == PurchaseOrder.id)
        .join(Supplier, PurchaseOrder.supplier_id == Supplier.id, isouter=True)
        .join(StockItem, PurchaseOrderItem.stock_item_id == StockItem.id, isouter=True)
        .where(PurchaseOrder.order_date >= prev_since.date(),
               PurchaseOrder.order_date <= until.date())
    )).all()

    groups: dict[tuple, list] = defaultdict(list)
    for sid, desc, unit_cost, qty, odate, status, cc, plant_id, supplier, scode, sname in rows:
        st = status.value if hasattr(status, "value") else status
        if st in ("draft", "cancelled") or not unit_cost or not odate:
            continue
        if ctx.scope.is_plant or plant_id is not None:
            if not _row_scope_ok(plant_id, (cc or "").strip(), ctx.scope, ctx.site_ids):
                continue
        elif ctx.scope.site and (not cc or _site_of(cc) != ctx.scope.site):
            continue
        key = ("stock", str(sid)) if sid else ("desc", (desc or "").strip().lower())
        if key[1] in ("", "none"):
            continue
        groups[key].append({
            "date": odate, "unit_cost": float(unit_cost), "qty": float(qty or 0),
            "supplier": supplier or "—", "label": sname or desc, "code": scode,
        })

    out = []
    for key, items in groups.items():
        if len(items) < 2:
            continue
        items.sort(key=lambda i: i["date"])
        first, last = items[0], items[-1]
        if first["unit_cost"] <= 0:
            continue
        change = (last["unit_cost"] - first["unit_cost"]) / first["unit_cost"] * 100
        if abs(change) < 1:
            continue
        out.append({
            "basis": key[0],
            "item": last["label"], "code": last["code"],
            "first_date": first["date"].isoformat(), "first_price": round(first["unit_cost"], 2),
            "last_date": last["date"].isoformat(), "last_price": round(last["unit_cost"], 2),
            "change_pct": round(change, 1),
            "purchases": len(items),
            "suppliers": sorted({i["supplier"] for i in items}),
            "exposure": round(last["unit_cost"] * sum(i["qty"] for i in items), 2),
        })
    out.sort(key=lambda r: -abs(r["change_pct"]))
    return out[:40]


# ─── Cost centers ────────────────────────────────────────────────────────────

async def cost_center_analysis(db: AsyncSession, ctx: CostContext, months: list,
                               kind: str, cutoff_slot: int = 0) -> dict:
    """Per cost center: the period actual, the same period a year earlier, the
    budget on a COHERENT time basis (full period and to the cut-off), and the
    individual GL accounts driving the biggest year-on-year moves."""
    from app.api.routes.costs import _cc_budgets_map

    # ── Budgets per cost center (SAP owns OPEX on an imported year) ──
    budgets: dict = {}
    if ctx.source == "sap" and kind == "opex":
        sap = await _sap_data(db, ctx.year, ctx.scope)
        for cc, d in (sap or {}).get("cost_centers", {}).items():
            budgets[cc] = list(d["budget"])
    else:
        for cc, arrs in (await _cc_budgets_map(db, ctx.mmap, ctx.scope)).items():
            budgets[cc] = list(arrs[kind])

    # ── Actuals: the SAP ledger on a fiscal year, platform-tracked otherwise ──
    per: dict = {}

    def bucket(name: str, code=None) -> dict:
        b = per.setdefault(name, {"cost_center": name, "code": code,
                                  "cur": 0.0, "prev": 0.0, "accounts": {}})
        if code and not b["code"]:
            b["code"] = code
        return b

    if ctx.source == "sap" and kind == "opex":
        lines = (await db.execute(
            select(SapCostLine).where(SapCostLine.fiscal_year.in_([ctx.year, ctx.year - 1]))
        )).scalars().all()
        for ln in lines:
            if not (1 <= ln.pos <= 12) or ln.pos not in months:
                continue
            if not _row_scope_ok(ln.plant_id, ln.cost_center, ctx.scope, ctx.site_ids):
                continue
            target = "cur" if ln.fiscal_year == ctx.year else "prev"
            cc = bucket(ln.cost_center, ln.cost_center_code)
            cc[target] += float(ln.actual or 0)
            acct = (f"{ln.account_code} {ln.account_name}"
                    if ln.account_code and ln.account_code != ln.account_name else ln.account_name)
            a = cc["accounts"].setdefault(acct, {"account": acct, "cur": 0.0, "prev": 0.0})
            a[target] += float(ln.actual or 0)
    else:
        from app.api.routes.costs import _cc_actuals, _months_map
        cur = await _cc_actuals(db, ctx.mmap, ctx.scope)
        prev = await _cc_actuals(db, _months_map(ctx.year - 1, ctx.fiscal), ctx.scope)
        for cc_name, arrs in cur.items():
            cc = bucket(cc_name)
            cc["cur"] += sum(arrs[kind]["monthly"][m - 1] for m in months)
            for ty, arr in arrs[kind]["by_type"].items():
                a = cc["accounts"].setdefault(ty, {"account": ty, "cur": 0.0, "prev": 0.0})
                a["cur"] += sum(arr[m - 1] for m in months)
        for cc_name, arrs in prev.items():
            cc = bucket(cc_name)
            cc["prev"] += sum(arrs[kind]["monthly"][m - 1] for m in months)
            for ty, arr in arrs[kind]["by_type"].items():
                a = cc["accounts"].setdefault(ty, {"account": ty, "cur": 0.0, "prev": 0.0})
                a["prev"] += sum(arr[m - 1] for m in months)

    # Cost centers that only carry a budget still belong in the statement.
    for cc_name in budgets:
        bucket(cc_name)

    to_date_months = [m for m in months if cutoff_slot and m <= cutoff_slot]
    rows = []
    for cc in per.values():
        arr = budgets.get(cc["cost_center"], [0.0] * 12)
        budget_period = sum(arr[m - 1] for m in months)
        budget_to_date = sum(arr[m - 1] for m in to_date_months)
        drivers = sorted(cc["accounts"].values(), key=lambda a: -(a["cur"] - a["prev"]))
        rows.append({
            "cost_center": cc["cost_center"], "code": cc["code"],
            "actual": round(cc["cur"], 2), "prev_actual": round(cc["prev"], 2),
            "budget": round(budget_period, 2),
            "budget_to_date": round(budget_to_date, 2),
            "variance_to_date": round(budget_to_date - cc["cur"], 2) if to_date_months else None,
            "delta": round(cc["cur"] - cc["prev"], 2),
            "delta_pct": (round(((cc["cur"] - cc["prev"]) / cc["prev"]) * 100, 1)
                          if cc["prev"] else None),
            "drivers": [{"account": d["account"], "actual": round(d["cur"], 2),
                         "prev_actual": round(d["prev"], 2),
                         "delta": round(d["cur"] - d["prev"], 2)}
                        for d in drivers[:6] if round(d["cur"] - d["prev"], 2)],
        })
    rows.sort(key=lambda r: -r["actual"])
    return {
        "currency": "CAD",
        "prev_year": ctx.year - 1,
        "kind": kind,
        "cutoff_slot": cutoff_slot or None,
        # False = the previous year was never imported. A year-on-year delta is
        # then meaningless and the UI must not present one.
        "has_prev": any(r["prev_actual"] for r in rows),
        "cost_centers": [r for r in rows if r["actual"] or r["prev_actual"] or r["budget"]],
    }


# ─── Inventory / spare parts ─────────────────────────────────────────────────

async def inventory_analysis(db: AsyncSession, ctx: CostContext, months: list[int]) -> dict:
    """The stock side of maintenance cost, kept strictly separate from the ledger.

    purchase  → the expense the SAP ledger books (already in `actual`)
    receipt   → a stock movement, NOT a second expense
    consumption → an internal reclass of an already-booked purchase

    So this view reports consumption VALUE (what the floor burned), stock VALUE
    (what is on the shelf) and purchases separately; it never adds them."""
    since, until, _ = window_bounds(ctx, months)

    items = (await db.execute(select(StockItem))).scalars().all()
    if ctx.scope.is_plant:
        items = [i for i in items if i.plant_id == ctx.scope.plant_id]
    elif ctx.scope.site:
        site_pid = ctx.site_ids.get(ctx.scope.site)
        items = [i for i in items if i.plant_id in (None, site_pid)]
    by_id = {str(i.id): i for i in items}

    def valuation(i: StockItem) -> tuple[Optional[float], str]:
        if i.average_cost:
            return float(i.average_cost), "average_cost"
        if i.unit_cost:
            return float(i.unit_cost), "standard_cost"
        if i.last_purchase_cost:
            return float(i.last_purchase_cost), "last_purchase"
        return None, "none"

    stock_value = 0.0
    valued, unvalued = 0, 0
    basis_counts: dict[str, int] = defaultdict(int)
    critical, stockouts = [], []
    for i in items:
        v, basis = valuation(i)
        basis_counts[basis] += 1
        qty = float(i.quantity or 0)
        if v is None:
            unvalued += 1
        else:
            valued += 1
            stock_value += qty * v
        if i.min_quantity is not None:
            if qty <= 0:
                stockouts.append(i)
            elif qty <= float(i.min_quantity):
                critical.append(i)

    # ── Consumption in the window, by value and by equipment ──
    consumption: dict[str, dict] = {}
    by_equipment: dict[str, dict] = {}
    mapping = await _dept_map(db)

    def consume(label, code, item_id, amount, qty, eq_key, eq_name):
        c = consumption.setdefault(label, {
            "item": label, "code": code, "stock_item_id": item_id,
            "value": 0.0, "qty": 0.0, "uses": 0,
        })
        c["value"] += amount
        c["qty"] += qty
        c["uses"] += 1
        if eq_key:
            e = by_equipment.setdefault(eq_key, {"equipment_id": eq_key, "name": eq_name,
                                                 "value": 0.0, "items": 0})
            e["value"] += amount
            e["items"] += 1

    part_rows = (await db.execute(
        select(WOPart.stock_item_id, WOPart.description, WOPart.part_number,
               WOPart.quantity, WOPart.total_cost, WOPart.created_at,
               WorkOrder.equipment_id, Equipment.name, WorkOrder.cost_center,
               WorkOrder.plant_id, Equipment.department)
        .select_from(WOPart)
        .join(WorkOrder, WOPart.work_order_id == WorkOrder.id)
        .join(Equipment, WorkOrder.equipment_id == Equipment.id, isouter=True)
        .where(WOPart.created_at >= since, WOPart.created_at <= until,
               WOPart.total_cost.isnot(None))
    )).all()
    for sid, desc, pnum, qty, total, _created, eid, ename, cc, plant_id, dept in part_rows:
        if not _row_scope_ok(plant_id, _resolve_cc_explicit(cc, dept, mapping), ctx.scope, ctx.site_ids):
            continue
        consume(desc or pnum or "—", pnum, str(sid) if sid else None,
                float(total or 0), float(qty or 0), str(eid) if eid else None, ename)

    iv_rows = (await db.execute(
        select(InterventionPart.item_description, InterventionPart.item_code,
               InterventionPart.quantity_used, InterventionPart.total_cost,
               MachineIntervention.equipment_id, Equipment.name,
               MachineIntervention.cost_center, MachineIntervention.plant_id,
               Equipment.department)
        .select_from(InterventionPart)
        .join(MachineIntervention, InterventionPart.intervention_id == MachineIntervention.id)
        .join(Equipment, MachineIntervention.equipment_id == Equipment.id, isouter=True)
        .where(InterventionPart.added_at >= since, InterventionPart.added_at <= until,
               InterventionPart.approval_status == "approved",
               InterventionPart.total_cost.isnot(None))
    )).all()
    for desc, code, qty, total, eid, ename, cc, plant_id, dept in iv_rows:
        if not _row_scope_ok(plant_id, _resolve_cc_explicit(cc, dept, mapping), ctx.scope, ctx.site_ids):
            continue
        consume(desc or code or "—", code, None, float(total or 0), float(qty or 0),
                str(eid) if eid else None, ename)

    # Stock movements give a second, independent read on consumption value.
    mv_rows = (await db.execute(
        select(InventoryMovement.stock_item_id, InventoryMovement.movement_type,
               InventoryMovement.quantity, InventoryMovement.unit_cost,
               InventoryMovement.created_at)
        .where(InventoryMovement.created_at >= since, InventoryMovement.created_at <= until)
    )).all()
    movement_value = 0.0
    moved_ids: set = set()
    for sid, mtype, qty, unit_cost, _created in mv_rows:
        key = str(sid)
        moved_ids.add(key)
        if key not in by_id:
            continue
        if mtype == "deduction":
            uc = float(unit_cost or 0) or (valuation(by_id[key])[0] or 0)
            movement_value += abs(float(qty or 0)) * uc

    # ── Dormant stock (no movement at all in the dormancy window) ──
    horizon = datetime.now(timezone.utc) - timedelta(days=DORMANT_DAYS)
    recent = {str(sid) for (sid,) in (await db.execute(
        select(func.distinct(InventoryMovement.stock_item_id))
        .where(InventoryMovement.created_at >= horizon)
    )).all()}
    dormant = []
    for i in items:
        if str(i.id) in recent:
            continue
        v, basis = valuation(i)
        qty = float(i.quantity or 0)
        if qty <= 0:
            continue
        # An item with no unit cost is still dormant stock — it is listed with a
        # zero value and its basis, so the COUNT stays honest even when the
        # catalogue carries no valuation.
        dormant.append({"id": str(i.id), "code": i.code, "name": i.name,
                        "quantity": qty, "value": round(qty * v, 2) if v is not None else 0.0,
                        "basis": basis,
                        "last_purchase_date": i.last_purchase_date.isoformat() if i.last_purchase_date else None})
    dormant.sort(key=lambda r: (-r["value"], -r["quantity"]))

    # ── Emergency purchases (rule stated, never inferred as fact) ──
    emergency = []
    po_rows = (await db.execute(
        select(PurchaseOrder.order_number, PurchaseOrder.order_date, PurchaseOrder.expected_date,
               PurchaseOrder.total_amount, PurchaseOrder.cost_center, PurchaseOrder.plant_id,
               PurchaseOrder.status, Supplier.name)
        .select_from(PurchaseOrder)
        .join(Supplier, PurchaseOrder.supplier_id == Supplier.id, isouter=True)
        .where(PurchaseOrder.order_date >= since.date(), PurchaseOrder.order_date <= until.date())
    )).all()
    for onum, odate, edate, amount, cc, plant_id, status, supplier in po_rows:
        st = status.value if hasattr(status, "value") else status
        if st in ("draft", "cancelled"):
            continue
        if ctx.scope.is_plant or plant_id is not None:
            if not _row_scope_ok(plant_id, (cc or "").strip(), ctx.scope, ctx.site_ids):
                continue
        elif ctx.scope.site and (not cc or _site_of(cc) != ctx.scope.site):
            continue
        lead = (edate - odate).days if edate and odate else None
        if lead is not None and lead <= EMERGENCY_LEAD_DAYS:
            emergency.append({"order_number": onum, "supplier": supplier or "—",
                              "order_date": odate.isoformat(), "lead_days": lead,
                              "amount": round(float(amount or 0), 2),
                              "cost_center": cc})
    emergency.sort(key=lambda r: -r["amount"])

    top = sorted(consumption.values(), key=lambda c: -c["value"])[:30]
    for c in top:
        c["value"] = round(c["value"], 2)
    eq_rows = sorted(by_equipment.values(), key=lambda e: -e["value"])[:30]
    for e in eq_rows:
        e["value"] = round(e["value"], 2)

    return {
        "currency": "CAD",
        "window": {"from": since.date().isoformat(), "to": until.date().isoformat()},
        "stock_value": round(stock_value, 2),
        "valuation": {"valued_items": valued, "unvalued_items": unvalued,
                      "basis_counts": dict(basis_counts)},
        "items_total": len(items),
        "consumption_value": round(sum(c["value"] for c in consumption.values()), 2),
        "movement_consumption_value": round(movement_value, 2),
        "top_consumption": top,
        "by_equipment": eq_rows,
        "critical_count": len(critical),
        "stockout_count": len(stockouts),
        # No item carries a minimum → "nothing critical" would be a false
        # reassurance. The client says the rule cannot be applied instead.
        "has_min_levels": any(i.min_quantity is not None for i in items),
        "critical_items": [{"id": str(i.id), "code": i.code, "name": i.name,
                            "quantity": float(i.quantity or 0),
                            "min_quantity": float(i.min_quantity or 0)}
                           for i in sorted(critical, key=lambda i: float(i.quantity or 0))[:30]],
        "stockout_items": [{"id": str(i.id), "code": i.code, "name": i.name,
                            "min_quantity": float(i.min_quantity or 0)}
                           for i in stockouts[:30]],
        "dormant": dormant[:30],
        "dormant_count": len(dormant),
        "dormant_value": round(sum(d["value"] for d in dormant), 2),
        "dormant_unvalued": sum(1 for d in dormant if d["basis"] == "none"),
        "dormant_days": DORMANT_DAYS,
        "emergency_purchases": emergency[:30],
        "emergency_total": round(sum(e["amount"] for e in emergency), 2),
        "emergency_rule": {"lead_days": EMERGENCY_LEAD_DAYS},
        "movement_rows": len(mv_rows),
        # Stated so nobody reads three numbers as three expenses.
        "accounting_note": "purchase_is_the_expense",
    }


# ─── Alerts ──────────────────────────────────────────────────────────────────

# kind → default threshold. A rule row overrides the threshold and can disable
# the kind entirely; nothing is precomputed, every alert is evaluated live.
ALERT_DEFAULTS: dict = {
    "forecast_over_budget": 2.0,     # % over the period budget
    "cost_increase": 25.0,           # % jump vs the 3 previous closed months
    "recurring_corrective": 3.0,     # corrective work orders on one asset
    "stale_commitments": 60.0,       # days an open PO has been outstanding
    "cc_variance": 10.0,             # % over a cost center's to-date budget
    "low_link_coverage": 50.0,       # % of the ledger explained by KAIZO records
    "stale_import": 45.0,            # days since the last SAP import
}


def _sev(ratio: float) -> str:
    """Severity from how far past the threshold the measure sits."""
    if ratio >= 2:
        return "critical"
    if ratio >= 1.4:
        return "high"
    return "medium"


def evaluate_alerts(ctx, forecast: dict, recon: dict, commitments: dict,
                    equipment: dict, cc_analysis: dict, as_of: dict,
                    rules: dict, kind: str) -> list:
    """Turn the analyses into actionable alerts. Every alert carries the numbers
    that produced it plus where to drill — no alert without its evidence."""
    out: list = []

    def enabled(k: str):
        r = rules.get(k)
        if r is not None and not r.enabled:
            return None
        return float(r.threshold) if r is not None else ALERT_DEFAULTS[k]

    # 1 — the projection lands over the envelope
    thr = enabled("forecast_over_budget")
    if thr is not None and forecast["period_budget"] > 0:
        over = -forecast["projected_variance"]
        pct = (over / forecast["period_budget"]) * 100
        if pct > thr:
            out.append({
                "kind": "forecast_over_budget", "severity": _sev(pct / max(thr, 0.1)),
                "value": round(pct, 1), "threshold": thr,
                "amount": round(over, 2),
                "evidence": [
                    {"key": "periodBudget", "value": forecast["period_budget"]},
                    {"key": "projectedLanding", "value": forecast["forecast"]},
                    {"key": "scenarioRange",
                     "value": [forecast["forecast_scenarios"]["favorable"],
                               forecast["forecast_scenarios"]["unfavorable"]]},
                    {"key": "cutoff", "value": as_of["cutoff_period"]},
                ],
                "drill": {"tab": "pnl"},
            })

    # 2 — a material jump in the last closed month
    thr = enabled("cost_increase")
    if thr is not None:
        closed = [s for s in range(1, 13) if as_of["slot_status"][s - 1] == "closed"]
        if len(closed) >= 4:
            last = closed[-1]
            base = [ctx.actual[kind][s - 1] for s in closed[-4:-1]]
            avg = sum(base) / len(base) if base else 0
            cur = ctx.actual[kind][last - 1]
            if avg > 0:
                pct = ((cur - avg) / avg) * 100
                if pct > thr:
                    out.append({
                        "kind": "cost_increase", "severity": _sev(pct / max(thr, 0.1)),
                        "value": round(pct, 1), "threshold": thr,
                        "amount": round(cur - avg, 2),
                        "evidence": [
                            {"key": "month", "value": {"year": ctx.mmap[last - 1][0],
                                                       "month": ctx.mmap[last - 1][1]}},
                            {"key": "monthActual", "value": round(cur, 2)},
                            {"key": "priorAverage", "value": round(avg, 2)},
                        ],
                        "drill": {"tab": "pnl", "slot": last},
                    })

    # 3 — assets that keep failing
    thr = enabled("recurring_corrective")
    if thr is not None:
        repeat = [e for e in equipment.get("equipment", [])
                  if e["corrective"] >= thr and e["repeat_failures"] > 0]
        repeat.sort(key=lambda e: (-e["repeat_failures"], -e["cost"]))
        for e in repeat[:5]:
            out.append({
                "kind": "recurring_corrective",
                "severity": _sev(e["corrective"] / max(thr, 0.1)),
                "value": e["corrective"], "threshold": thr,
                "amount": e["cost"],
                "subject": e["name"], "subject_id": e["equipment_id"],
                "evidence": [
                    {"key": "correctiveCount", "value": e["corrective"]},
                    {"key": "repeatFailures", "value": e["repeat_failures"]},
                    {"key": "downtimeHours", "value": e["downtime_hours"]},
                    {"key": "criticality", "value": e["criticality"]},
                    {"key": "trackedCost", "value": e["cost"]},
                ],
                "drill": {"tab": "machine", "equipment_id": e["equipment_id"]},
            })

    # 4 — commitments that have been open too long
    thr = enabled("stale_commitments")
    if thr is not None:
        stale = [o for o in commitments.get("orders", [])
                 if (o["age_days"] or 0) >= thr and o["open_balance"] > 0]
        if stale:
            amount = sum(o["open_balance"] for o in stale)
            oldest = max(o["age_days"] or 0 for o in stale)
            out.append({
                "kind": "stale_commitments", "severity": _sev(oldest / max(thr, 0.1)),
                "value": len(stale), "threshold": thr, "amount": round(amount, 2),
                "evidence": [
                    {"key": "openOrders", "value": len(stale)},
                    {"key": "openBalance", "value": round(amount, 2)},
                    {"key": "oldestDays", "value": oldest},
                    {"key": "orders", "value": [o["order_number"] for o in stale[:5]]},
                ],
                "drill": {"tab": "commitments"},
            })

    # 5 — cost centers past their to-date envelope (the 5 biggest overruns only,
    # so a handful of tiny cost centers never drowns the real ones)
    thr = enabled("cc_variance")
    if thr is not None:
        cut = as_of["cutoff_slot"] or 0
        cc_hits = []
        for cc in cc_analysis.get("cost_centers", []):
            budget_to_date = cc.get("budget_to_date")
            if not budget_to_date or cut == 0:
                continue
            over = cc["actual"] - budget_to_date
            pct = (over / budget_to_date) * 100
            if pct > thr:
                cc_hits.append({
                    "kind": "cc_variance", "severity": _sev(pct / max(thr, 0.1)),
                    "value": round(pct, 1), "threshold": thr, "amount": round(over, 2),
                    "subject": cc["cost_center"],
                    "evidence": [
                        {"key": "budgetToDate", "value": round(budget_to_date, 2)},
                        {"key": "actualToDate", "value": cc["actual"]},
                        {"key": "yoyDelta", "value": cc["delta"]},
                        {"key": "topDriver",
                         "value": (cc["drivers"][0]["account"] if cc.get("drivers") else None)},
                    ],
                    "drill": {"tab": "pnl", "cost_center": cc["cost_center"]},
                })
        cc_hits.sort(key=lambda a: -a["amount"])
        out.extend(cc_hits[:5])

    # 6 — the ledger is barely explained by platform records
    thr = enabled("low_link_coverage")
    if thr is not None and recon.get("sap_total"):
        pct = recon.get("linked_pct") or 0
        if pct < thr:
            out.append({
                "kind": "low_link_coverage", "severity": _sev((thr - pct) / max(thr, 0.1) + 1),
                "value": round(pct, 1), "threshold": thr,
                "amount": recon["unlinked_total"],
                "evidence": [
                    {"key": "sapTotal", "value": recon["sap_total"]},
                    {"key": "linkedTotal", "value": recon["linked_total"]},
                    {"key": "unlinkedTotal", "value": recon["unlinked_total"]},
                    {"key": "lines", "value": recon["lines"]},
                ],
                "drill": {"tab": "reconciliation"},
            })

    # 7 — the import is behind the calendar
    thr = enabled("stale_import")
    if thr is not None and as_of.get("import_age_days") is not None:
        age = as_of["import_age_days"]
        missing = as_of["unposted_elapsed_months"]
        if age > thr or missing > 0:
            out.append({
                "kind": "stale_import",
                "severity": "critical" if missing >= 2 else _sev(age / max(thr, 0.1)),
                "value": age, "threshold": thr, "amount": None,
                "evidence": [
                    {"key": "lastImport", "value": as_of["last_import_at"]},
                    {"key": "cutoff", "value": as_of["cutoff_period"]},
                    {"key": "unpostedMonths", "value": missing},
                ],
                "drill": {"tab": "reconciliation"},
            })

    order = {"critical": 0, "high": 1, "medium": 2}
    out.sort(key=lambda a: (order.get(a["severity"], 3), -(a.get("amount") or 0)))
    return out


# ─── Executive summary ───────────────────────────────────────────────────────

def executive_summary(ctx, forecast: dict, recon: dict, equipment: dict,
                      cc_analysis: dict, supplier: dict, as_of: dict,
                      alerts: list, kind: str) -> dict:
    """A period read-out assembled ENTIRELY from the numbers above. Every claim
    ships the figures behind it; nothing states a cause the data cannot show."""
    budget_state = "on_track"
    v = forecast["projected_variance"]
    if forecast["period_budget"] > 0:
        pct = (v / forecast["period_budget"]) * 100
        budget_state = "over" if pct < -2 else ("at_risk" if pct < 2 else "under")

    # What moved. Year-on-year when the previous year exists in the ledger;
    # otherwise the overrun against the to-date budget — never a "variation"
    # computed against a year that was simply never imported.
    ccs = cc_analysis.get("cost_centers", [])
    has_prev = any(c["prev_actual"] for c in ccs)
    if has_prev:
        driver_basis = "yoy"
        drivers = sorted([c for c in ccs if c["delta"]], key=lambda c: -abs(c["delta"]))[:4]
    else:
        driver_basis = "budget"
        drivers = sorted(
            [c for c in ccs if c.get("budget_to_date") and c["actual"] > c["budget_to_date"]],
            key=lambda c: -(c["actual"] - c["budget_to_date"]))[:4]
    attention = sorted(equipment.get("equipment", []),
                       key=lambda e: -e["attention_score"])[:4]

    quality = []
    if as_of["unposted_elapsed_months"]:
        quality.append({"key": "unpostedMonths", "value": as_of["unposted_elapsed_months"],
                        "detail": as_of["cutoff_period"]})
    if recon.get("linked_pct") is not None and recon["sap_total"]:
        quality.append({"key": "linkCoverage", "value": recon["linked_pct"],
                        "detail": recon["unlinked_total"]})
    unclass = recon.get("unclassified", {})
    unclass_amount = sum(x["amount"] for x in unclass.values())
    if unclass_amount:
        quality.append({"key": "unclassified", "value": round(unclass_amount, 2),
                        "detail": sum(x["count"] for x in unclass.values())})
    if recon.get("duplicates"):
        quality.append({"key": "possibleDuplicates", "value": len(recon["duplicates"]),
                        "detail": round(sum(d["amount"] for d in recon["duplicates"]), 2)})
    if recon.get("orphan_links"):
        quality.append({"key": "orphanLinks", "value": len(recon["orphan_links"]),
                        "detail": None})
    cov = equipment.get("coverage", {})
    if cov.get("official_total") and not cov.get("tracked_total"):
        quality.append({"key": "noOperationalCoverage",
                        "value": cov.get("equipment_with_cost", 0), "detail": None})

    return {
        "kind": kind,
        "cutoff": as_of["cutoff_period"],
        "method": as_of["method"],
        "budget": {
            "state": budget_state,
            "period_budget": forecast["period_budget"],
            "budget_to_date": forecast["budget_to_date"],
            "actual_to_date": forecast["actual_to_date"],
            "variance_to_date": forecast["variance_to_date"],
            "variance_to_date_pct": forecast["variance_to_date_pct"],
            "remaining_budget": forecast["remaining_budget"],
            "committed_open": forecast["committed_open"],
        },
        "landing": {
            "forecast": forecast["forecast"],
            "scenarios": forecast["forecast_scenarios"],
            "projected_variance": forecast["projected_variance"],
            "projected_variance_pct": forecast["projected_variance_pct"],
            "run_rate": forecast["run_rate"],
        },
        "driver_basis": driver_basis,
        "drivers": [{"cost_center": d["cost_center"], "actual": d["actual"],
                     "prev_actual": d["prev_actual"], "delta": d["delta"],
                     "delta_pct": d["delta_pct"],
                     "budget_to_date": d.get("budget_to_date"),
                     "variance_to_date": d.get("variance_to_date"),
                     "top_account": (d["drivers"][0]["account"] if d.get("drivers") else None)}
                    for d in drivers],
        "attention_equipment": [{"equipment_id": e["equipment_id"], "name": e["name"],
                                 "code": e["code"], "cost": e["cost"],
                                 "corrective": e["corrective"],
                                 "repeat_failures": e["repeat_failures"],
                                 "downtime_hours": e["downtime_hours"],
                                 "criticality": e["criticality"],
                                 "score": e["attention_score"]}
                                for e in attention if e["attention_score"] > 0],
        "supplier_concentration": supplier.get("concentration"),
        "data_quality": quality,
        "priority_alerts": alerts[:5],
    }
