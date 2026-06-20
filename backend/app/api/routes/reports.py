"""Per-machine maintenance reports.

Consolidates the maintenance KPIs (availability, OEE, MTTR, MTBF, downtime,
costs, PM compliance, backlog, response time) for a single machine, plus a
comparison endpoint across all machines.

A machine's work-order universe is WorkOrder.machine_id == machine.id plus
WorkOrder.equipment_id in the machine's linked equipment (Machine.equipment_id,
or the shared UUID for machines auto-provisioned from equipment).
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_

from app.db.session import get_db
from app.models.models import (
    Machine, Equipment, WorkOrder, WorkOrderStatus, WorkOrderType, WOCost,
    MachineStop, StopCategory, StopCategoryType, MachineProductionLog,
    MaintenanceTicket, MachineIntervention, User, WOPart, InterventionPart,
)
from app.core.security import get_current_user
from app.services.mes_service import shift_windows, overlap_seconds

router = APIRouter()

OPEN_WO_STATUSES = [WorkOrderStatus.open, WorkOrderStatus.in_progress]


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


async def _equipment_ids_for(db: AsyncSession, machine: Machine) -> list[UUID]:
    ids = set()
    if machine.equipment_id:
        ids.add(machine.equipment_id)
    eq = await db.get(Equipment, machine.id)
    if eq:
        ids.add(eq.id)
    return list(ids)


async def _resolve_entity_machine(db: AsyncSession, entity_id: UUID) -> Optional[Machine]:
    """The reports are driven by the Equipment catalog, but the floor data lives
    on Machine rows. Resolve an id (Equipment id from the dropdown, or a Machine
    id) to the Machine that actually carries the data:
      1) a Machine with that id (auto-provisioned machines share the equipment id),
      2) a Machine explicitly linked via equipment_id,
      3) a Machine with the same name (covers unlinked floor rows),
      4) a transient Machine built from the equipment (WO/cost still resolve by
         equipment id; floor metrics are simply empty).
    """
    m = await db.get(Machine, entity_id)
    if m:
        return m
    m = (await db.execute(
        select(Machine).where(Machine.equipment_id == entity_id)
    )).scalars().first()
    if m:
        return m
    eq = await db.get(Equipment, entity_id)
    if not eq:
        return None
    m = (await db.execute(
        select(Machine).where(
            func.lower(Machine.name) == (eq.name or "").lower(),
            Machine.is_active == True,
        )
    )).scalars().first()
    if m:
        return m
    return Machine(
        id=eq.id, name=eq.name, code=eq.code, equipment_id=eq.id,
        target_availability_pct=70.0, shifts_config=None, is_active=True,
    )


def _wo_filter(machine_id: UUID, eq_ids: list[UUID]):
    conds = [WorkOrder.machine_id == machine_id]
    if eq_ids:
        conds.append(WorkOrder.equipment_id.in_(eq_ids))
    return or_(*conds)


async def _fetch_stops(db: AsyncSession, since: datetime, machine_id: Optional[UUID] = None):
    """Stops since `since` with category info, normalized to UTC and clipped at now."""
    now = datetime.now(timezone.utc)
    q = (
        select(MachineStop, StopCategory.type, StopCategory.name, StopCategory.color)
        .outerjoin(StopCategory, MachineStop.stop_category_id == StopCategory.id)
        .where(MachineStop.started_at >= since)
    )
    if machine_id is not None:
        q = q.where(MachineStop.machine_id == machine_id)
    rows = (await db.execute(q)).all()
    stops = []
    for stop, cat_type, cat_name, cat_color in rows:
        start = _as_utc(stop.started_at)
        end = min(_as_utc(stop.ended_at), now) if stop.ended_at else now
        if end <= start:
            continue
        stops.append({
            "machine_id": stop.machine_id,
            "start": start,
            "end": end,
            "type": cat_type,
            "category": cat_name or "Uncategorized",
            "color": cat_color or "#6b7280",
        })
    return stops


def _availability_over_period(machine: Machine, stops: list, start_date: date, end_date: date):
    """Daily availability trend + period totals from unplanned stop time vs
    planned time (shifts_config, full day when unset)."""
    now = datetime.now(timezone.utc)
    unplanned = [s for s in stops if s["type"] != StopCategoryType.planned]
    trend = []
    total_planned = 0.0
    total_stopped = 0.0
    d = start_date
    while d <= end_date:
        windows = shift_windows(machine.shifts_config, d)
        planned = sum(overlap_seconds(ws, we, ws, min(we, now)) for ws, we in windows)
        if planned > 0:
            stopped = sum(
                overlap_seconds(s["start"], s["end"], ws, min(we, now))
                for s in unplanned
                for ws, we in windows
            )
            stopped = min(stopped, planned)
            total_planned += planned
            total_stopped += stopped
            trend.append({
                "date": d.isoformat(),
                "pct": round((planned - stopped) / planned * 100, 1),
            })
        d += timedelta(days=1)

    avg_pct = round((total_planned - total_stopped) / total_planned * 100, 1) if total_planned > 0 else None
    return trend, avg_pct, total_planned / 3600.0


def _downtime_summary(stops: list):
    unplanned_min = 0
    planned_min = 0
    pareto: dict = {}
    for s in stops:
        minutes = int((s["end"] - s["start"]).total_seconds() / 60)
        if s["type"] == StopCategoryType.planned:
            planned_min += minutes
        else:
            unplanned_min += minutes
        key = s["category"]
        if key not in pareto:
            pareto[key] = {
                "category": key,
                "color": s["color"],
                "type": s["type"].value if hasattr(s["type"], "value") else (str(s["type"]) if s["type"] else "unplanned"),
                "count": 0,
                "minutes": 0,
            }
        pareto[key]["count"] += 1
        pareto[key]["minutes"] += minutes
    return {
        "unplanned_minutes": unplanned_min,
        "planned_minutes": planned_min,
        "stops_count": len(stops),
        "pareto": sorted(pareto.values(), key=lambda x: x["minutes"], reverse=True),
    }


@router.get("/machine/{machine_id}")
async def machine_report(
    machine_id: UUID,
    period_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    machine = await _resolve_entity_machine(db, machine_id)
    if not machine:
        raise HTTPException(404, "Equipment / machine not found")

    now = datetime.now(timezone.utc)
    since = now - timedelta(days=period_days)
    since_date = since.date()
    eq_ids = await _equipment_ids_for(db, machine)
    if machine_id not in eq_ids:        # the selected catalog id always counts for WO/cost
        eq_ids.append(machine_id)
    wo_cond = _wo_filter(machine.id, eq_ids)

    # ── Stops: availability trend, downtime, Pareto ──────────────────────────
    stops = await _fetch_stops(db, since, machine.id)
    trend, avg_availability, planned_hours = _availability_over_period(
        machine, stops, since_date, now.date()
    )
    downtime = _downtime_summary(stops)

    # ── OEE from production logs ─────────────────────────────────────────────
    oee_rows = (await db.execute(
        select(
            MachineProductionLog.date,
            func.avg(MachineProductionLog.oee_pct).label("oee"),
            func.avg(MachineProductionLog.performance_pct).label("perf"),
            func.avg(MachineProductionLog.quality_pct).label("qual"),
        )
        .where(
            MachineProductionLog.machine_id == machine.id,
            MachineProductionLog.date >= since_date,
            MachineProductionLog.oee_pct > 0,
        )
        .group_by(MachineProductionLog.date)
        .order_by(MachineProductionLog.date)
    )).all()
    oee_trend = [{"date": r.date.isoformat(), "pct": round(float(r.oee), 1)} for r in oee_rows]
    avg_oee = round(sum(float(r.oee) for r in oee_rows) / len(oee_rows), 1) if oee_rows else None
    avg_perf = round(sum(float(r.perf) for r in oee_rows) / len(oee_rows), 1) if oee_rows else None
    avg_qual = round(sum(float(r.qual) for r in oee_rows) / len(oee_rows), 1) if oee_rows else None

    # ── MTTR (corrective completed WOs) ──────────────────────────────────────
    mttr_r = (await db.execute(
        select(func.avg(WorkOrder.repair_hours), func.count(WorkOrder.id)).where(
            and_(
                wo_cond,
                WorkOrder.type == WorkOrderType.corrective,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.completed_at >= since,
                WorkOrder.repair_hours.isnot(None),
            )
        )
    )).one()
    mttr_hours = round(float(mttr_r[0]), 2) if mttr_r[0] is not None else None
    repairs = int(mttr_r[1] or 0)

    # ── Failures and MTBF ────────────────────────────────────────────────────
    failures = (await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(wo_cond, WorkOrder.type == WorkOrderType.corrective, WorkOrder.opened_at >= since)
        )
    )).scalar() or 0
    if failures == 0:
        failures = (await db.execute(
            select(func.count(MaintenanceTicket.id)).where(
                MaintenanceTicket.machine_id == machine.id,
                MaintenanceTicket.opened_at >= since,
            )
        )).scalar() or 0
    uptime_hours = max(0.0, planned_hours - downtime["unplanned_minutes"] / 60)
    mtbf_hours = round(uptime_hours / failures, 1) if failures > 0 else None

    # ── PM compliance ────────────────────────────────────────────────────────
    pm_total = (await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(wo_cond, WorkOrder.type == WorkOrderType.preventive, WorkOrder.opened_at >= since)
        )
    )).scalar() or 0
    pm_on_time = (await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(
                wo_cond,
                WorkOrder.type == WorkOrderType.preventive,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.opened_at >= since,
                WorkOrder.completed_at.isnot(None),
                WorkOrder.due_date.isnot(None),
                WorkOrder.completed_at <= WorkOrder.due_date,
            )
        )
    )).scalar() or 0

    # ── Backlog ──────────────────────────────────────────────────────────────
    backlog_rows = (await db.execute(
        select(WorkOrder.opened_at).where(and_(wo_cond, WorkOrder.status.in_(OPEN_WO_STATUSES)))
    )).all()
    buckets = {"0_7": 0, "7_30": 0, "30_plus": 0}
    for row in backlog_rows:
        age = (now - _as_utc(row.opened_at)).days
        if age <= 7:
            buckets["0_7"] += 1
        elif age <= 30:
            buckets["7_30"] += 1
        else:
            buckets["30_plus"] += 1

    # ── Costs ────────────────────────────────────────────────────────────────
    cost_rows = (await db.execute(
        select(WOCost.transaction_type, func.sum(WOCost.amount).label("total"))
        .join(WorkOrder, WOCost.work_order_id == WorkOrder.id)
        .where(and_(wo_cond, WOCost.date >= since_date))
        .group_by(WOCost.transaction_type)
    )).all()
    costs_by_type = [{"type": r.transaction_type, "total": round(float(r.total), 2)} for r in cost_rows]

    # Parts used: WO parts + approved intervention parts (priced from stock)
    wo_parts_sum = (await db.execute(
        select(func.sum(WOPart.total_cost))
        .join(WorkOrder, WOPart.work_order_id == WorkOrder.id)
        .where(and_(wo_cond, WOPart.created_at >= since, WOPart.total_cost.isnot(None)))
    )).scalar() or 0.0
    ip_cond = [MachineIntervention.machine_id == machine.id]
    if eq_ids:
        ip_cond.append(MachineIntervention.equipment_id.in_(eq_ids))
    int_parts_sum = (await db.execute(
        select(func.sum(InterventionPart.total_cost))
        .join(MachineIntervention, InterventionPart.intervention_id == MachineIntervention.id)
        .where(
            or_(*ip_cond),
            InterventionPart.approval_status == "approved",
            InterventionPart.added_at >= since,
            InterventionPart.total_cost.isnot(None),
        )
    )).scalar() or 0.0
    parts_cost = round(float(wo_parts_sum) + float(int_parts_sum), 2)
    if parts_cost:
        costs_by_type.append({"type": "parts_used", "total": parts_cost})
    total_cost = round(sum(c["total"] for c in costs_by_type), 2)

    # ── Interventions (call flow) ────────────────────────────────────────────
    int_cond = [MachineIntervention.machine_id == machine.id]
    if eq_ids:
        int_cond.append(MachineIntervention.equipment_id.in_(eq_ids))
    int_r = (await db.execute(
        select(
            func.count(MachineIntervention.id),
            func.avg(MachineIntervention.response_time_minutes),
            func.avg(MachineIntervention.intervention_duration_minutes),
            func.avg(MachineIntervention.total_downtime_minutes),
        ).where(
            or_(*int_cond),
            MachineIntervention.status == "completed",
            MachineIntervention.called_at >= since,
        )
    )).one()

    # Fall back to intervention data when the WO universe has no repair records
    int_count = int(int_r[0] or 0)
    if repairs == 0 and int_count > 0 and int_r[2] is not None:
        mttr_hours = round(float(int_r[2]) / 60, 2)
        repairs = int_count
    if failures == 0 and int_count > 0:
        failures = int_count
        mtbf_hours = round(uptime_hours / failures, 1)

    # ── Tickets ──────────────────────────────────────────────────────────────
    tickets_opened = (await db.execute(
        select(func.count(MaintenanceTicket.id)).where(
            MaintenanceTicket.machine_id == machine.id,
            MaintenanceTicket.opened_at >= since,
        )
    )).scalar() or 0
    resolution_r = (await db.execute(
        select(func.avg(
            func.extract("epoch", MaintenanceTicket.completed_at) -
            func.extract("epoch", MaintenanceTicket.opened_at)
        )).where(
            MaintenanceTicket.machine_id == machine.id,
            MaintenanceTicket.opened_at >= since,
            MaintenanceTicket.completed_at.isnot(None),
        )
    )).scalar()
    avg_resolution_hours = round(float(resolution_r) / 3600, 1) if resolution_r else None
    avg_resolution_seconds = round(float(resolution_r), 1) if resolution_r else None

    return {
        "machine": {
            "id": str(machine.id),
            "name": machine.display_name or machine.name,
            "code": machine.code,
            "department": machine.department,
            "equipment_id": str(machine.equipment_id) if machine.equipment_id else None,
            "target_availability_pct": machine.target_availability_pct or 70.0,
        },
        "period_days": period_days,
        "availability": {"avg_pct": avg_availability, "trend": trend},
        "oee": {
            "avg_oee_pct": avg_oee,
            "avg_performance_pct": avg_perf,
            "avg_quality_pct": avg_qual,
            "trend": oee_trend,
        },
        "downtime": downtime,
        "mttr": {"hours": mttr_hours, "repairs": repairs},
        "mtbf": {"hours": mtbf_hours, "failures": int(failures)},
        "pm_compliance": {
            "pct": round(pm_on_time / pm_total * 100, 1) if pm_total > 0 else None,
            "total": int(pm_total),
            "on_time": int(pm_on_time),
        },
        "backlog": {
            "total": len(backlog_rows),
            "buckets": [
                {"label": "0–7", "count": buckets["0_7"]},
                {"label": "7–30", "count": buckets["7_30"]},
                {"label": "30+", "count": buckets["30_plus"]},
            ],
        },
        "costs": {"total": total_cost, "by_type": costs_by_type},
        "interventions": {
            "count": int(int_r[0] or 0),
            "avg_response_minutes": round(float(int_r[1]), 1) if int_r[1] is not None else None,
            "avg_duration_minutes": round(float(int_r[2]), 1) if int_r[2] is not None else None,
            "avg_downtime_minutes": round(float(int_r[3]), 1) if int_r[3] is not None else None,
        },
        "tickets": {"opened": int(tickets_opened), "avg_resolution_hours": avg_resolution_hours, "avg_resolution_seconds": avg_resolution_seconds},
    }


@router.get("/machines/compare")
async def compare_machines(
    period_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=period_days)
    since_date = since.date()

    # Canonical entity list = the Equipment catalog (matches the Equipment page);
    # resolve each to the Machine that actually carries the floor data.
    # Auxiliary (utility) assets have no MES/OEE layer — exclude them from the
    # per-machine comparison (coalesce so legacy NULL rows count as production).
    equipment = (await db.execute(
        select(Equipment)
        .where(
            Equipment.active == True,
            func.coalesce(Equipment.asset_type, "production") != "auxiliary",
        )
        .order_by(Equipment.name)
    )).scalars().all()
    if not equipment:
        return {"period_days": period_days, "items": []}

    entities = [(eq, await _resolve_entity_machine(db, eq.id)) for eq in equipment]
    entities = [(eq, m) for eq, m in entities if m is not None]

    machine_ids = {m.id for _, m in entities}
    eq_to_machine: dict = {}
    for eq, m in entities:
        eq_to_machine[eq.id] = m.id
        if m.equipment_id:
            eq_to_machine[m.equipment_id] = m.id

    def wo_machine(wo_machine_id, wo_equipment_id):
        if wo_machine_id in machine_ids:
            return wo_machine_id
        return eq_to_machine.get(wo_equipment_id)

    # ── Batch queries ────────────────────────────────────────────────────────
    all_stops = await _fetch_stops(db, since)
    stops_by_machine: dict = {}
    for s in all_stops:
        stops_by_machine.setdefault(s["machine_id"], []).append(s)

    oee_rows = (await db.execute(
        select(MachineProductionLog.machine_id, func.avg(MachineProductionLog.oee_pct))
        .where(MachineProductionLog.date >= since_date, MachineProductionLog.oee_pct > 0)
        .group_by(MachineProductionLog.machine_id)
    )).all()
    oee_by_machine = {r[0]: round(float(r[1]), 1) for r in oee_rows}

    wo_rows = (await db.execute(
        select(
            WorkOrder.machine_id, WorkOrder.equipment_id, WorkOrder.type,
            WorkOrder.status, WorkOrder.repair_hours, WorkOrder.opened_at,
            WorkOrder.completed_at,
        ).where(WorkOrder.opened_at >= since)
    )).all()

    open_rows = (await db.execute(
        select(WorkOrder.machine_id, WorkOrder.equipment_id)
        .where(WorkOrder.status.in_(OPEN_WO_STATUSES))
    )).all()

    cost_rows = (await db.execute(
        select(WorkOrder.machine_id, WorkOrder.equipment_id, func.sum(WOCost.amount))
        .join(WorkOrder, WOCost.work_order_id == WorkOrder.id)
        .where(WOCost.date >= since_date)
        .group_by(WorkOrder.machine_id, WorkOrder.equipment_id)
    )).all()

    wo_parts_rows = (await db.execute(
        select(WorkOrder.machine_id, WorkOrder.equipment_id, func.sum(WOPart.total_cost))
        .join(WorkOrder, WOPart.work_order_id == WorkOrder.id)
        .where(WOPart.created_at >= since, WOPart.total_cost.isnot(None))
        .group_by(WorkOrder.machine_id, WorkOrder.equipment_id)
    )).all()

    int_parts_rows = (await db.execute(
        select(
            MachineIntervention.machine_id, MachineIntervention.equipment_id,
            func.sum(InterventionPart.total_cost),
        )
        .join(MachineIntervention, InterventionPart.intervention_id == MachineIntervention.id)
        .where(
            InterventionPart.approval_status == "approved",
            InterventionPart.added_at >= since,
            InterventionPart.total_cost.isnot(None),
        )
        .group_by(MachineIntervention.machine_id, MachineIntervention.equipment_id)
    )).all()

    int_rows = (await db.execute(
        select(
            MachineIntervention.machine_id, MachineIntervention.equipment_id,
            MachineIntervention.response_time_minutes,
            MachineIntervention.intervention_duration_minutes,
        ).where(
            MachineIntervention.status == "completed",
            MachineIntervention.called_at >= since,
        )
    )).all()

    ticket_rows = (await db.execute(
        select(MaintenanceTicket.machine_id, func.count(MaintenanceTicket.id))
        .where(MaintenanceTicket.opened_at >= since)
        .group_by(MaintenanceTicket.machine_id)
    )).all()
    tickets_by_machine = {r[0]: int(r[1]) for r in ticket_rows}

    # ── Aggregate per machine ────────────────────────────────────────────────
    agg = {
        m.id: {"repair_sum": 0.0, "repairs": 0, "failures": 0, "cost": 0.0,
               "backlog": 0, "responses": [], "durations": [], "int_count": 0}
        for _, m in entities
    }
    for r in wo_rows:
        mid = wo_machine(r.machine_id, r.equipment_id)
        if mid is None:
            continue
        if r.type == WorkOrderType.corrective:
            agg[mid]["failures"] += 1
            if r.status == WorkOrderStatus.completed and r.repair_hours is not None:
                agg[mid]["repair_sum"] += float(r.repair_hours)
                agg[mid]["repairs"] += 1
    for r in open_rows:
        mid = wo_machine(r.machine_id, r.equipment_id)
        if mid is not None:
            agg[mid]["backlog"] += 1
    for r in cost_rows:
        mid = wo_machine(r[0], r[1])
        if mid is not None and r[2] is not None:
            agg[mid]["cost"] += float(r[2])
    for r in wo_parts_rows:
        mid = wo_machine(r[0], r[1])
        if mid is not None and r[2] is not None:
            agg[mid]["cost"] += float(r[2])
    for r in int_parts_rows:
        mid = r[0] if r[0] in machine_ids else eq_to_machine.get(r[1])
        if mid is not None and r[2] is not None:
            agg[mid]["cost"] += float(r[2])
    for r in int_rows:
        mid = r.machine_id if r.machine_id in machine_ids else eq_to_machine.get(r.equipment_id)
        if mid is None:
            continue
        agg[mid]["int_count"] += 1
        if r.response_time_minutes is not None:
            agg[mid]["responses"].append(float(r.response_time_minutes))
        if r.intervention_duration_minutes is not None:
            agg[mid]["durations"].append(float(r.intervention_duration_minutes))

    items = []
    for eq, m in entities:
        m_stops = stops_by_machine.get(m.id, [])
        _, avg_availability, planned_hours = _availability_over_period(
            m, m_stops, since_date, now.date()
        )
        downtime = _downtime_summary(m_stops)
        a = agg[m.id]
        uptime_hours = max(0.0, planned_hours - downtime["unplanned_minutes"] / 60)

        # Fall back to intervention/ticket data when WOs carry no repair records
        if a["repairs"] > 0:
            mttr_hours = round(a["repair_sum"] / a["repairs"], 2)
            repairs = a["repairs"]
        elif a["durations"]:
            mttr_hours = round(sum(a["durations"]) / len(a["durations"]) / 60, 2)
            repairs = len(a["durations"])
        else:
            mttr_hours, repairs = None, 0
        failures = a["failures"] or tickets_by_machine.get(m.id, 0) or a["int_count"]

        items.append({
            "machine_id": str(eq.id),
            "name": eq.name,
            "code": eq.code,
            "department": eq.location,
            "target_availability_pct": m.target_availability_pct or 70.0,
            "availability_pct": avg_availability,
            "oee_pct": oee_by_machine.get(m.id),
            "downtime_minutes": downtime["unplanned_minutes"],
            "stops_count": downtime["stops_count"],
            "mttr_hours": mttr_hours,
            "repairs": repairs,
            "failures": failures,
            "mtbf_hours": round(uptime_hours / failures, 1) if failures > 0 else None,
            "total_cost": round(a["cost"], 2),
            "backlog_count": a["backlog"],
            "avg_response_minutes": round(sum(a["responses"]) / len(a["responses"]), 1) if a["responses"] else None,
        })

    return {"period_days": period_days, "items": items}
