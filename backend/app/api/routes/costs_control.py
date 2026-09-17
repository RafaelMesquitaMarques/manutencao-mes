"""Cost-control endpoints — mounted alongside costs.py on /api/costs.

Split into its own module so the existing Costs router stays untouched. Every
route resolves its scope with the SAME `_resolve_scope` the rest of the page
uses, so plant/site segregation and the `costs` resource guard apply unchanged
(the guard is attached at router registration in main.py).
"""
import io
from datetime import date
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.plant_context import PlantContext, get_plant_context
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import (
    CostAction, CostAlertRule, CostForecastAdjustment, Equipment, PurchaseOrder,
    SapCostLine, SapCostLink, User, WorkOrder,
)
from app.api.routes.costs import Scope, _resolve_scope, _row_scope_ok, _site_ids
from app.services import cost_insights as ins
from app.services.cost_control import (
    build_context, commitments_detail, compute_as_of, compute_forecast,
    line_key, links_for, reconciliation, sap_lines_for,
)

router = APIRouter()


def _months(month_from: int, month_to: int) -> List[int]:
    lo = max(1, min(month_from, 12))
    hi = max(lo, min(month_to, 12))
    return list(range(lo, hi + 1))


async def _ctx(db: AsyncSession, ctx: PlantContext, site: Optional[str], year: Optional[int]):
    scope = await _resolve_scope(db, ctx, site)
    return await build_context(db, scope, year or date.today().year)


def _storage_scope(scope: Scope):
    """Where a control row (adjustment, rule, action) is stored: a non-Quebec
    plant keeps its own rows; a single Quebec site stores its site code with the
    shared NULL plant; the combined view stores neither."""
    if scope.is_plant:
        return scope.plant_id, None
    return None, scope.site


# ─── Cut-off + forecast ──────────────────────────────────────────────────────

@router.get("/forecast")
async def cost_forecast(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    kind: str = Query(default="opex", pattern="^(opex|capex)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Budget control + year-end projection on a coherent time basis.

    Returns the cut-off (which months are closed, partially posted, elapsed but
    not yet imported, or future), the to-date budget/actual/variance, the
    remaining envelope, open commitments and three scenarios — each with its
    per-slot arithmetic, so the landing chart and the headline reconcile."""
    c = await _ctx(db, ctx, site, year)
    months = _months(month_from, month_to)
    as_of = compute_as_of(c, kind)
    payload = compute_forecast(c, kind, months, as_of)
    payload["as_of"] = as_of
    payload["year"] = c.year
    payload["fiscal"] = c.fiscal
    payload["source"] = c.source
    payload["currency"] = "CAD"
    payload["month_map"] = [{"year": y, "month": m} for y, m in c.mmap]
    payload["adjustment_rows"] = [{
        "id": str(a.id), "year": a.year, "month": a.month, "scope": a.scope,
        "kind": a.kind, "amount": round(float(a.amount or 0), 2), "reason": a.reason,
        "cost_center": a.cost_center,
        "slot": c.slot_of(a.year, a.month),
    } for a in c.adjustment_rows if a.scope == kind]
    return payload


# ─── SAP ↔ KAIZO reconciliation ──────────────────────────────────────────────

@router.get("/reconciliation")
async def cost_reconciliation(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """How much of the official SAP actual KAIZO can explain, what is
    unclassified, what looks duplicated, and how fresh the import is."""
    c = await _ctx(db, ctx, site, year)
    months = _months(month_from, month_to)
    data = await reconciliation(db, c, months)
    data["as_of"] = compute_as_of(c, "opex")
    data["year"] = c.year
    data["month_map"] = [{"year": y, "month": m} for y, m in c.mmap]
    return data


MAX_SAP_LINES = 500


@router.get("/sap-lines")
async def list_sap_lines(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    cost_center: Optional[str] = Query(default=None),
    account: Optional[str] = Query(default=None),
    link: str = Query(default="all", pattern="^(all|linked|unlinked)$"),
    q: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """The individual GL lines behind any reconciliation total, with their links."""
    c = await _ctx(db, ctx, site, year)
    months = set(_months(month_from, month_to))
    site_ids = await _site_ids(db)
    lines = await sap_lines_for(db, c.year, c.scope, site_ids)
    links = await links_for(db, c.year)

    labels = await _link_labels(db, [l for group in links.values() for l in group])
    out = []
    for ln in lines:
        if ln.pos not in months:
            continue
        if cost_center and ln.cost_center != cost_center:
            continue
        if account and ln.account_code != account:
            continue
        key = line_key(ln)
        ln_links = links.get(key, [])
        if link == "linked" and not ln_links:
            continue
        if link == "unlinked" and ln_links:
            continue
        text = f"{ln.cost_center} {ln.account_name} {ln.comment or ''}".lower()
        if q and q.lower() not in text:
            continue
        linked_amount = sum(float(l.amount or 0) for l in ln_links)
        out.append({
            "fiscal_year": ln.fiscal_year, "pos": ln.pos,
            "year": ln.year, "month": ln.month,
            "cost_center": ln.cost_center, "cost_center_code": ln.cost_center_code,
            "account": (f"{ln.account_code} {ln.account_name}"
                        if ln.account_code and ln.account_code != ln.account_name
                        else ln.account_name),
            "account_code": ln.account_code,
            "budget": round(float(ln.budget or 0), 2),
            "actual": round(float(ln.actual or 0), 2),
            "comment": ln.comment,
            "linked_amount": round(linked_amount, 2),
            "links": [{
                "id": str(l.id), "target_kind": l.target_kind,
                "amount": round(float(l.amount or 0), 2), "note": l.note,
                "origin": l.origin,
                "label": labels.get(str(l.id)),
            } for l in ln_links],
        })
    out.sort(key=lambda r: (-abs(r["actual"]), r["pos"]))
    total = round(sum(r["actual"] for r in out), 2)
    return {"year": c.year, "currency": "CAD", "count": len(out), "total_actual": total,
            "truncated": len(out) > MAX_SAP_LINES, "lines": out[:MAX_SAP_LINES]}


async def _link_labels(db: AsyncSession, links: list) -> dict:
    """Human labels for link targets, resolved in three bulk queries."""
    wo_ids = {l.work_order_id for l in links if l.work_order_id}
    eq_ids = {l.equipment_id for l in links if l.equipment_id}
    po_ids = {l.purchase_order_id for l in links if l.purchase_order_id}
    wo, eq, po = {}, {}, {}
    if wo_ids:
        wo = {r[0]: f"{r[1]} — {r[2]}" for r in (await db.execute(
            select(WorkOrder.id, WorkOrder.wo_number, WorkOrder.title)
            .where(WorkOrder.id.in_(wo_ids)))).all()}
    if eq_ids:
        eq = {r[0]: f"{r[1] or ''} {r[2]}".strip() for r in (await db.execute(
            select(Equipment.id, Equipment.code, Equipment.name)
            .where(Equipment.id.in_(eq_ids)))).all()}
    if po_ids:
        po = {r[0]: r[1] for r in (await db.execute(
            select(PurchaseOrder.id, PurchaseOrder.order_number)
            .where(PurchaseOrder.id.in_(po_ids)))).all()}
    out = {}
    for l in links:
        out[str(l.id)] = (wo.get(l.work_order_id) or eq.get(l.equipment_id)
                          or po.get(l.purchase_order_id))
    return out


@router.get("/sap-links/suggestions")
async def link_suggestions(
    fiscal_year: int = Query(..., ge=2000, le=2100),
    pos: int = Query(..., ge=1, le=12),
    cost_center_code: str = Query(...),
    account_code: str = Query(...),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Candidate records for one GL line, scored on the evidence available
    (same month, same cost center, close amount). `ambiguous` is set whenever
    the top candidates are indistinguishable — the UI must NOT auto-confirm
    those; a human picks."""
    scope = await _resolve_scope(db, ctx, site)
    site_ids = await _site_ids(db)
    line = (await db.execute(select(SapCostLine).where(
        SapCostLine.fiscal_year == fiscal_year, SapCostLine.pos == pos,
        SapCostLine.cost_center_code == cost_center_code,
        SapCostLine.account_code == account_code))).scalars().first()
    if not line:
        raise HTTPException(status_code=404, detail="sap_line_not_found")
    if not _row_scope_ok(line.plant_id, line.cost_center, scope, site_ids):
        raise HTTPException(status_code=403, detail="plant_not_authorized")

    target_amount = abs(float(line.actual or 0))
    y, m = line.year, line.month
    start = date(y, m, 1)
    end = date(y + (m // 12), (m % 12) + 1, 1)

    candidates = []

    po_rows = (await db.execute(
        select(PurchaseOrder.id, PurchaseOrder.order_number, PurchaseOrder.total_amount,
               PurchaseOrder.cost_center, PurchaseOrder.received_date,
               PurchaseOrder.expected_date, PurchaseOrder.order_date, PurchaseOrder.plant_id,
               PurchaseOrder.status)
    )).all()
    for pid, num, amount, cc, rdate, edate, odate, plant_id, status in po_rows:
        when = rdate or edate or odate
        if not when or not (start <= when < end):
            continue
        if not _row_scope_ok(plant_id, (cc or "").strip(), scope, site_ids):
            continue
        score = 40
        if cc and cc.strip().lower() == (line.cost_center or "").strip().lower():
            score += 30
        amt = float(amount or 0)
        if target_amount and amt:
            closeness = 1 - min(abs(amt - target_amount) / max(target_amount, 1), 1)
            score += int(closeness * 30)
        candidates.append({"kind": "purchase_order", "id": str(pid),
                           "label": num, "amount": round(amt, 2),
                           "date": when.isoformat(), "score": score,
                           "detail": cc, "status": (status.value if hasattr(status, "value") else status)})

    wo_rows = (await db.execute(
        select(WorkOrder.id, WorkOrder.wo_number, WorkOrder.title, WorkOrder.total_cost,
               WorkOrder.cost_center, WorkOrder.completed_at, WorkOrder.opened_at,
               WorkOrder.plant_id, Equipment.name, Equipment.department)
        .select_from(WorkOrder)
        .join(Equipment, WorkOrder.equipment_id == Equipment.id, isouter=True)
        .where(WorkOrder.opened_at < end)
        .order_by(WorkOrder.opened_at.desc()).limit(4000)
    )).all()
    for wid, num, title, cost, cc, completed, opened, plant_id, eq_name, dept in wo_rows:
        when = (completed or opened)
        if not when:
            continue
        wd = when.date() if hasattr(when, "date") else when
        if not (start <= wd < end):
            continue
        if not _row_scope_ok(plant_id, (cc or dept or "").strip(), scope, site_ids):
            continue
        score = 35
        if cc and cc.strip().lower() == (line.cost_center or "").strip().lower():
            score += 30
        elif dept and dept.strip().lower() == (line.cost_center or "").strip().lower():
            score += 20
        amt = float(cost or 0)
        if target_amount and amt:
            closeness = 1 - min(abs(amt - target_amount) / max(target_amount, 1), 1)
            score += int(closeness * 25)
        candidates.append({"kind": "work_order", "id": str(wid),
                           "label": f"{num} — {title}", "amount": round(amt, 2),
                           "date": wd.isoformat(), "score": score,
                           "detail": eq_name})

    candidates.sort(key=lambda c: -c["score"])
    top = candidates[:20]
    # Indistinguishable head of the list → never auto-confirm.
    ambiguous = len(top) > 1 and (top[0]["score"] - top[1]["score"]) < 10
    return {
        "line": {"fiscal_year": fiscal_year, "pos": pos,
                 "cost_center": line.cost_center, "account": line.account_name,
                 "actual": round(float(line.actual or 0), 2)},
        "ambiguous": ambiguous,
        "auto_confirmable": bool(top) and not ambiguous and top[0]["score"] >= 85,
        "candidates": top,
    }


class LinkCreate(BaseModel):
    fiscal_year: int = Field(ge=2000, le=2100)
    pos: int = Field(ge=1, le=12)
    cost_center_code: str = Field(min_length=1, max_length=50)
    account_code: str = Field(min_length=1, max_length=50)
    target_kind: str = Field(pattern="^(work_order|equipment|purchase_order)$")
    target_id: UUID
    amount: float
    note: Optional[str] = None
    origin: str = Field(default="manual", pattern="^(manual|suggested)$")


@router.post("/sap-links")
async def create_sap_link(
    data: LinkCreate,
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Attach a KAIZO record to a GL line. The attached amount can never exceed
    the line's own actual — a link explains the ledger, it does not inflate it."""
    scope = await _resolve_scope(db, ctx, site)
    site_ids = await _site_ids(db)
    line = (await db.execute(select(SapCostLine).where(
        SapCostLine.fiscal_year == data.fiscal_year, SapCostLine.pos == data.pos,
        SapCostLine.cost_center_code == data.cost_center_code,
        SapCostLine.account_code == data.account_code))).scalars().first()
    if not line:
        raise HTTPException(status_code=404, detail="sap_line_not_found")
    if not _row_scope_ok(line.plant_id, line.cost_center, scope, site_ids):
        raise HTTPException(status_code=403, detail="plant_not_authorized")

    existing = (await db.execute(select(func.sum(SapCostLink.amount)).where(
        SapCostLink.fiscal_year == data.fiscal_year, SapCostLink.pos == data.pos,
        SapCostLink.cost_center_code == data.cost_center_code,
        SapCostLink.account_code == data.account_code))).scalar() or 0.0
    if abs(float(existing) + data.amount) > abs(float(line.actual or 0)) + 0.01:
        raise HTTPException(status_code=400, detail="sap_link_exceeds_line")

    link = SapCostLink(
        plant_id=line.plant_id, fiscal_year=data.fiscal_year, pos=data.pos,
        cost_center_code=data.cost_center_code, account_code=data.account_code,
        target_kind=data.target_kind, amount=data.amount, note=data.note,
        origin=data.origin, created_by_id=current_user.id,
    )
    setattr(link, f"{data.target_kind}_id", data.target_id)
    db.add(link)
    await db.commit()
    return {"id": str(link.id), "ok": True}


@router.delete("/sap-links/{link_id}")
async def delete_sap_link(
    link_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    link = await db.get(SapCostLink, link_id)
    if not link:
        raise HTTPException(status_code=404, detail="sap_link_not_found")
    if link.plant_id is not None and link.plant_id not in ctx.allowed_plant_ids:
        raise HTTPException(status_code=403, detail="plant_not_authorized")
    await db.delete(link)
    await db.commit()
    return {"ok": True}


# ─── Commitments ─────────────────────────────────────────────────────────────

@router.get("/commitments")
async def cost_commitments(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    include_received: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """The purchase orders behind the Committed (PO) indicator, investigable."""
    c = await _ctx(db, ctx, site, year)
    data = await commitments_detail(db, c, _months(month_from, month_to), include_received)
    data["year"] = c.year
    data["month_map"] = [{"year": y, "month": m} for y, m in c.mmap]
    return data


# ─── Equipment / supplier / cost-center depth ────────────────────────────────

@router.get("/equipment-analysis")
async def equipment_analysis(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Cost crossed with reliability per asset, plus the honest coverage note."""
    c = await _ctx(db, ctx, site, year)
    data = await ins.equipment_analysis(db, c, _months(month_from, month_to))
    data["year"] = c.year
    data["month_map"] = [{"year": y, "month": m} for y, m in c.mmap]
    return data


@router.get("/equipment-analysis/{equipment_id}/repair-replace")
async def repair_replace(
    equipment_id: UUID,
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Inputs for a repair-vs-replace discussion — facts and missing assumptions,
    never a verdict derived from maintenance spend alone."""
    c = await _ctx(db, ctx, site, year)
    months = _months(month_from, month_to)
    analysis = await ins.equipment_analysis(db, c, months)
    return await ins.equipment_repair_replace(db, c, months, str(equipment_id), analysis)


@router.get("/supplier-analysis")
async def supplier_analysis(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    c = await _ctx(db, ctx, site, year)
    data = await ins.supplier_analysis(db, c, _months(month_from, month_to))
    data["year"] = c.year
    data["prev_year"] = c.year - 1
    data["month_map"] = [{"year": y, "month": m} for y, m in c.mmap]
    return data


@router.get("/cost-center-analysis")
async def cost_center_analysis(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    kind: str = Query(default="opex", pattern="^(opex|capex)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    c = await _ctx(db, ctx, site, year)
    months = _months(month_from, month_to)
    as_of = compute_as_of(c, kind)
    data = await ins.cost_center_analysis(db, c, months, kind, as_of["cutoff_slot"] or 0)
    data["year"] = c.year
    data["as_of"] = as_of
    return data


@router.get("/inventory-analysis")
async def inventory_analysis(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Spare-parts view: consumption value, stock value, dormant stock, critical
    items and emergency buys — reported side by side, never added together."""
    c = await _ctx(db, ctx, site, year)
    data = await ins.inventory_analysis(db, c, _months(month_from, month_to))
    data["year"] = c.year
    return data


# ─── Forecast adjustments ────────────────────────────────────────────────────

class AdjustmentSave(BaseModel):
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)
    scope: str = Field(default="opex", pattern="^(opex|capex)$")
    kind: str = Field(default="other", pattern="^(major_intervention|contract|extraordinary|other)$")
    amount: float
    reason: str = Field(min_length=1, max_length=2000)
    cost_center: Optional[str] = Field(default=None, max_length=200)


@router.post("/forecast-adjustments")
async def create_adjustment(
    data: AdjustmentSave,
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Record a justified forecast adjustment. It moves the projection only —
    never the actual, never the budget."""
    scope = await _resolve_scope(db, ctx, site)
    site_ids = await _site_ids(db)
    plant_id, site_code = _storage_scope(scope)
    row = CostForecastAdjustment(
        plant_id=plant_id, site=site_code, year=data.year, month=data.month,
        scope=data.scope, kind=data.kind, amount=data.amount, reason=data.reason,
        cost_center=data.cost_center, created_by_id=current_user.id,
    )
    db.add(row)
    await db.commit()
    return {"id": str(row.id), "ok": True}


@router.delete("/forecast-adjustments/{adj_id}")
async def delete_adjustment(
    adj_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    row = await db.get(CostForecastAdjustment, adj_id)
    if not row:
        raise HTTPException(status_code=404, detail="adjustment_not_found")
    if row.plant_id is not None and row.plant_id not in ctx.allowed_plant_ids:
        raise HTTPException(status_code=403, detail="plant_not_authorized")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


# ─── Alert rules + live evaluation ───────────────────────────────────────────

class AlertRuleItem(BaseModel):
    kind: str = Field(min_length=1, max_length=40)
    enabled: bool = True
    threshold: float = 0.0
    scope: str = Field(default="opex", pattern="^(opex|capex|both)$")


class AlertRulesSave(BaseModel):
    items: List[AlertRuleItem]


async def _rules_for(db: AsyncSession, scope: Scope, site_ids: dict) -> dict:
    plant_id, site_code = _storage_scope(scope)
    cond = (CostAlertRule.plant_id == plant_id) if plant_id else CostAlertRule.plant_id.is_(None)
    rows = (await db.execute(select(CostAlertRule).where(cond))).scalars().all()
    return {r.kind: r for r in rows if r.site in (None, site_code)}


@router.get("/alert-rules")
async def get_alert_rules(
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    scope = await _resolve_scope(db, ctx, site)
    site_ids = await _site_ids(db)
    rules = await _rules_for(db, scope, site_ids)
    return {"rules": [{
        "kind": k,
        "enabled": rules[k].enabled if k in rules else True,
        "threshold": float(rules[k].threshold) if k in rules else default,
        "scope": rules[k].scope if k in rules else "opex",
        "default_threshold": default,
        "configured": k in rules,
    } for k, default in ins.ALERT_DEFAULTS.items()]}


@router.put("/alert-rules")
async def save_alert_rules(
    data: AlertRulesSave,
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    scope = await _resolve_scope(db, ctx, site)
    site_ids = await _site_ids(db)
    plant_id, site_code = _storage_scope(scope)
    existing = await _rules_for(db, scope, site_ids)
    for item in data.items:
        if item.kind not in ins.ALERT_DEFAULTS:
            continue
        row = existing.get(item.kind)
        if row:
            row.enabled, row.threshold, row.scope = item.enabled, item.threshold, item.scope
        else:
            db.add(CostAlertRule(plant_id=plant_id, site=site_code, kind=item.kind,
                                 enabled=item.enabled, threshold=item.threshold,
                                 scope=item.scope, created_by_id=current_user.id))
    await db.commit()
    return {"ok": True}


async def _full_analysis(db: AsyncSession, c, months: List[int], kind: str):
    as_of = compute_as_of(c, kind)
    forecast = compute_forecast(c, kind, months, as_of)
    recon = await reconciliation(db, c, months)
    commitments = await commitments_detail(db, c, months)
    equipment = await ins.equipment_analysis(db, c, months)
    cc = await ins.cost_center_analysis(db, c, months, kind, as_of["cutoff_slot"] or 0)
    return as_of, forecast, recon, commitments, equipment, cc


@router.get("/alerts")
async def cost_alerts(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    kind: str = Query(default="opex", pattern="^(opex|capex)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Live cost alerts. Each one carries the figures that produced it and where
    to drill; nothing is stored or cached."""
    c = await _ctx(db, ctx, site, year)
    months = _months(month_from, month_to)
    site_ids = await _site_ids(db)
    rules = await _rules_for(db, c.scope, site_ids)
    as_of, forecast, recon, commitments, equipment, cc = await _full_analysis(db, c, months, kind)
    alerts = ins.evaluate_alerts(c, forecast, recon, commitments, equipment, cc,
                                 as_of, rules, kind)
    return {"year": c.year, "kind": kind, "currency": "CAD",
            "as_of": as_of, "alerts": alerts,
            "counts": {s: sum(1 for a in alerts if a["severity"] == s)
                       for s in ("critical", "high", "medium")}}


# ─── Management actions ──────────────────────────────────────────────────────

class ActionCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: Optional[str] = None
    alert_kind: Optional[str] = Field(default=None, max_length=40)
    context_kind: str = Field(default="other",
                              pattern="^(cost_center|equipment|supplier|purchase_order|import|other)$")
    context_ref: Optional[str] = Field(default=None, max_length=300)
    owner_id: Optional[UUID] = None
    due_date: Optional[date] = None
    fiscal_year: Optional[int] = Field(default=None, ge=2000, le=2100)
    savings_type: str = Field(default="none", pattern="^(none|potential|implemented|verified)$")
    savings_amount: Optional[float] = None


class ActionUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=300)
    description: Optional[str] = None
    owner_id: Optional[UUID] = None
    due_date: Optional[date] = None
    status: Optional[str] = Field(default=None, pattern="^(open|in_progress|done|cancelled)$")
    savings_type: Optional[str] = Field(default=None, pattern="^(none|potential|implemented|verified)$")
    savings_amount: Optional[float] = None
    result_note: Optional[str] = None


def _action_json(a: CostAction, owner_name: Optional[str] = None) -> dict:
    return {
        "id": str(a.id), "title": a.title, "description": a.description,
        "alert_kind": a.alert_kind, "context_kind": a.context_kind,
        "context_ref": a.context_ref, "owner_id": str(a.owner_id) if a.owner_id else None,
        "owner_name": owner_name,
        "due_date": a.due_date.isoformat() if a.due_date else None,
        "status": a.status, "savings_type": a.savings_type,
        "savings_amount": (round(float(a.savings_amount), 2) if a.savings_amount is not None else None),
        "result_note": a.result_note, "fiscal_year": a.fiscal_year,
        "site": a.site,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "closed_at": a.closed_at.isoformat() if a.closed_at else None,
    }


@router.get("/actions")
async def list_actions(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    status: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """The cost action plan. Savings are reported in three separate states —
    potential, implemented and verified are never merged into one number."""
    scope = await _resolve_scope(db, ctx, site)
    site_ids = await _site_ids(db)
    plant_id, site_code = _storage_scope(scope)
    cond = (CostAction.plant_id == plant_id) if plant_id else CostAction.plant_id.is_(None)
    rows = (await db.execute(select(CostAction).where(cond).order_by(CostAction.created_at.desc()))).scalars().all()
    rows = [r for r in rows if r.site in (None, site_code) or site_code is None]
    if year:
        rows = [r for r in rows if r.fiscal_year in (None, year)]
    if status:
        rows = [r for r in rows if r.status == status]
    names = {}
    ids = {r.owner_id for r in rows if r.owner_id}
    if ids:
        names = {i: n for i, n in (await db.execute(
            select(User.id, User.name).where(User.id.in_(ids)))).all()}
    savings = {k: round(sum(float(r.savings_amount or 0) for r in rows
                            if r.savings_type == k and r.status != "cancelled"), 2)
               for k in ("potential", "implemented", "verified")}
    return {
        "actions": [_action_json(r, names.get(r.owner_id)) for r in rows],
        "savings": savings,
        "counts": {s: sum(1 for r in rows if r.status == s)
                   for s in ("open", "in_progress", "done", "cancelled")},
    }


@router.post("/actions")
async def create_action(
    data: ActionCreate,
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    scope = await _resolve_scope(db, ctx, site)
    site_ids = await _site_ids(db)
    plant_id, site_code = _storage_scope(scope)
    row = CostAction(plant_id=plant_id, site=site_code, created_by_id=current_user.id,
                     **data.model_dump())
    db.add(row)
    await db.commit()
    return _action_json(row)


@router.patch("/actions/{action_id}")
async def update_action(
    action_id: UUID,
    data: ActionUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    row = await db.get(CostAction, action_id)
    if not row:
        raise HTTPException(status_code=404, detail="action_not_found")
    if row.plant_id is not None and row.plant_id not in ctx.allowed_plant_ids:
        raise HTTPException(status_code=403, detail="plant_not_authorized")
    patch = data.model_dump(exclude_unset=True)
    for k, v in patch.items():
        setattr(row, k, v)
    if patch.get("status") in ("done", "cancelled") and not row.closed_at:
        row.closed_at = func.now()
    await db.commit()
    await db.refresh(row)
    return _action_json(row)


@router.delete("/actions/{action_id}")
async def delete_action(
    action_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    row = await db.get(CostAction, action_id)
    if not row:
        raise HTTPException(status_code=404, detail="action_not_found")
    if row.plant_id is not None and row.plant_id not in ctx.allowed_plant_ids:
        raise HTTPException(status_code=403, detail="plant_not_authorized")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


# ─── Executive summary + report export ───────────────────────────────────────

@router.get("/executive-summary")
async def executive_summary(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    kind: str = Query(default="opex", pattern="^(opex|capex)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """The period read-out: budget state, projected landing, what moved, which
    assets and cost centers need attention, what is wrong with the data, and the
    priority actions. Every statement ships the numbers behind it."""
    c = await _ctx(db, ctx, site, year)
    months = _months(month_from, month_to)
    site_ids = await _site_ids(db)
    rules = await _rules_for(db, c.scope, site_ids)
    as_of, forecast, recon, commitments, equipment, cc = await _full_analysis(db, c, months, kind)
    supplier = await ins.supplier_analysis(db, c, months)
    alerts = ins.evaluate_alerts(c, forecast, recon, commitments, equipment, cc, as_of, rules, kind)
    data = ins.executive_summary(c, forecast, recon, equipment, cc, supplier, as_of, alerts, kind)
    data["year"] = c.year
    data["site"] = c.scope.site
    data["source"] = c.source
    data["currency"] = "CAD"
    data["month_map"] = [{"year": y, "month": m} for y, m in c.mmap]
    data["months"] = months
    return data


@router.get("/executive-report")
async def executive_report(
    year: Optional[int] = Query(default=None, ge=2000, le=2100),
    site: Optional[str] = Query(default=None, pattern="^(QS|QM)$"),
    kind: str = Query(default="opex", pattern="^(opex|capex)$"),
    month_from: int = Query(default=1, ge=1, le=12),
    month_to: int = Query(default=12, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """The same executive read-out as a workbook: filters and cut-off, the
    indicators, the monthly series (budget / actual / committed / forecast), the
    cost centers, the assets, the commitments and the data-quality findings."""
    from openpyxl import Workbook
    from openpyxl.chart import BarChart, LineChart, Reference
    from openpyxl.styles import Alignment, Font, PatternFill

    c = await _ctx(db, ctx, site, year)
    months = _months(month_from, month_to)
    site_ids = await _site_ids(db)
    rules = await _rules_for(db, c.scope, site_ids)
    as_of, forecast, recon, commitments, equipment, cc = await _full_analysis(db, c, months, kind)
    supplier = await ins.supplier_analysis(db, c, months)
    alerts = ins.evaluate_alerts(c, forecast, recon, commitments, equipment, cc, as_of, rules, kind)
    summary = ins.executive_summary(c, forecast, recon, equipment, cc, supplier, as_of, alerts, kind)

    wb = Workbook()
    head = Font(bold=True, color="FFFFFF")
    fill = PatternFill("solid", fgColor="1F3A5F")
    title_font = Font(bold=True, size=13)

    def sheet(name, headers, rows):
        ws = wb.create_sheet(name)
        ws.append(headers)
        for i, _h in enumerate(headers, start=1):
            cell = ws.cell(row=1, column=i)
            cell.font = head
            cell.fill = fill
            cell.alignment = Alignment(horizontal="center")
        for r in rows:
            ws.append(r)
        for i, h in enumerate(headers, start=1):
            width = max(len(str(h)) + 2, *(len(str(r[i - 1])) + 2 for r in rows)) if rows else len(str(h)) + 2
            ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = min(width, 46)
        return ws

    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "Maintenance cost — executive report"
    ws["A1"].font = title_font
    cut = as_of["cutoff_period"]
    meta = [
        ("Fiscal year" if c.fiscal else "Year", c.year),
        ("Scope", kind.upper()),
        ("Site", c.scope.site or ("plant" if c.scope.is_plant else "QS + QM")),
        ("Period", f"{c.mmap[months[0] - 1][1]}/{c.mmap[months[0] - 1][0]} → "
                   f"{c.mmap[months[-1] - 1][1]}/{c.mmap[months[-1] - 1][0]}"),
        ("Cut-off", f"{cut['month']}/{cut['year']}" if cut else "—"),
        ("Cut-off method", as_of["method"]),
        ("Official source", c.source),
        ("Last SAP import", as_of["last_import_at"] or "—"),
        ("Elapsed months not yet posted", as_of["unposted_elapsed_months"]),
        ("Generated", date.today().isoformat()),
        ("", ""),
        ("Period budget", forecast["period_budget"]),
        ("Budget to cut-off", forecast["budget_to_date"]),
        ("Actual to cut-off", forecast["actual_to_date"]),
        ("Variance to cut-off", forecast["variance_to_date"]),
        ("Remaining budget", forecast["remaining_budget"]),
        ("Open commitments", forecast["committed_open"]),
        ("Forecast (base)", forecast["forecast"]),
        ("Forecast (favorable)", forecast["forecast_scenarios"]["favorable"]),
        ("Forecast (unfavorable)", forecast["forecast_scenarios"]["unfavorable"]),
        ("Projected variance", forecast["projected_variance"]),
        ("Monthly run rate", forecast["run_rate"]),
    ]
    for i, (k, v) in enumerate(meta, start=3):
        ws.cell(row=i, column=1, value=k).font = Font(bold=True)
        ws.cell(row=i, column=2, value=v)
    ws.column_dimensions["A"].width = 34
    ws.column_dimensions["B"].width = 28

    ws_m = sheet("Monthly", ["Slot", "Year", "Month", "Status", "Budget", "Actual",
                             "Committed", "Adjustment", "Forecast"],
                 [[s["slot"], s["year"], s["month"], s["status"], s["budget"], s["actual"],
                   s["committed"], s["adjustment"], s["forecast"]] for s in forecast["slots"]])
    # Budget / actual / projection per month — the page's monthly chart, native
    # to the workbook so the report reads on its own.
    n = len(forecast["slots"])
    if n:
        chart = LineChart()
        chart.title = "Budget vs actual vs projection"
        chart.height, chart.width = 8, 20
        chart.add_data(Reference(ws_m, min_col=5, max_col=5, min_row=1, max_row=n + 1), titles_from_data=True)
        chart.add_data(Reference(ws_m, min_col=6, max_col=6, min_row=1, max_row=n + 1), titles_from_data=True)
        chart.add_data(Reference(ws_m, min_col=9, max_col=9, min_row=1, max_row=n + 1), titles_from_data=True)
        chart.set_categories(Reference(ws_m, min_col=3, max_col=3, min_row=2, max_row=n + 1))
        ws_m.add_chart(chart, "K2")

    ws_cc = sheet("Cost centers", ["Code", "Cost center", "Budget", "Budget to date",
                                   "Actual", "Variance to date", "Previous year", "Delta", "Top driver"],
                  [[r["code"], r["cost_center"], r["budget"], r["budget_to_date"], r["actual"],
                    r["variance_to_date"], r["prev_actual"], r["delta"],
                    (r["drivers"][0]["account"] if r["drivers"] else "")]
                   for r in cc["cost_centers"]])
    top_cc = min(len(cc["cost_centers"]), 12)
    if top_cc:
        bar = BarChart()
        bar.title = "Actual by cost center (top %d)" % top_cc
        bar.height, bar.width = 9, 20
        bar.add_data(Reference(ws_cc, min_col=5, max_col=5, min_row=1, max_row=top_cc + 1), titles_from_data=True)
        bar.add_data(Reference(ws_cc, min_col=4, max_col=4, min_row=1, max_row=top_cc + 1), titles_from_data=True)
        bar.set_categories(Reference(ws_cc, min_col=2, max_col=2, min_row=2, max_row=top_cc + 1))
        ws_cc.add_chart(bar, "K2")

    sheet("Equipment", ["Code", "Equipment", "Criticality", "Tracked cost", "Parts",
                        "Services", "Labor", "Corrective", "Repeat failures",
                        "Downtime h", "MTBF h", "MTTR h", "Cost/op. hour", "Attention"],
          [[e["code"], e["name"], e["criticality"], e["cost"], e["parts"], e["services"],
            e["labor"], e["corrective"], e["repeat_failures"], e["downtime_hours"],
            e["mtbf_hours"], e["mttr_hours"], e["cost_per_operating_hour"],
            e["attention_score"]] for e in equipment["equipment"][:200]])

    sheet("Commitments", ["PO", "Supplier", "Cost center", "Scope", "Status",
                          "Order date", "Expected", "Ordered", "Received", "Open balance",
                          "Age (days)", "Overdue (days)"],
          [[o["order_number"], o["supplier"], o["cost_center"], o["scope"], o["status"],
            o["order_date"], o["expected_date"], o["ordered_amount"], o["received_amount"],
            o["open_balance"], o["age_days"], o["overdue_days"]]
           for o in commitments["orders"]])

    sheet("Suppliers", ["Supplier", "Period", "Previous year", "Delta", "Delta %",
                        "Committed", "Orders"],
          [[s["supplier"], s["total"], s["prev_total"], s["delta"], s["delta_pct"],
            s["committed"], s["orders"]] for s in supplier["suppliers"][:200]])

    sheet("Data quality", ["Finding", "Value", "Detail"],
          [[q["key"], q["value"], str(q["detail"])] for q in summary["data_quality"]]
          + [["", "", ""]]
          + [["alert:" + a["kind"], a["value"], a["severity"]] for a in alerts])

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    name = f"kaizo-costs-{c.year}-{kind}.xlsx"
    return Response(
        content=buf.read(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
