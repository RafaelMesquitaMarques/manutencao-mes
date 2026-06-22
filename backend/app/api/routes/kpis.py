from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_, true
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from app.db.session import get_db
from app.models.models import (
    WorkOrder, WorkOrderStatus, WorkOrderType,
    Equipment, LaborRecord, WOCost, User, Machine, MachineIntervention,
    WOPart, InterventionPart, MachineStop, MachineProductionLog,
)
from app.core.security import get_current_user

router = APIRouter()


async def _machine_eq_ids(db: AsyncSession, machine_id: Optional[UUID]) -> Optional[set]:
    """Equipment ids linked to a machine: explicit Machine.equipment_id plus
    the shared UUID for machines auto-provisioned from equipment."""
    if machine_id is None:
        return None
    eq_ids = {machine_id}
    machine = await db.get(Machine, machine_id)
    if machine and machine.equipment_id:
        eq_ids.add(machine.equipment_id)
    return eq_ids


async def _machine_cond(db: AsyncSession, machine_id: Optional[UUID]):
    """WorkOrder filter for a machine. No-op when machine_id is None."""
    if machine_id is None:
        return true()
    eq_ids = await _machine_eq_ids(db, machine_id)
    return or_(
        WorkOrder.machine_id == machine_id,
        WorkOrder.equipment_id.in_(list(eq_ids)),
    )


async def _machine_int_cond(db: AsyncSession, machine_id: Optional[UUID]):
    """MachineIntervention filter for a machine. No-op when machine_id is None."""
    if machine_id is None:
        return true()
    eq_ids = await _machine_eq_ids(db, machine_id)
    return or_(
        MachineIntervention.machine_id == machine_id,
        MachineIntervention.equipment_id.in_(list(eq_ids)),
    )


async def _parts_cost(db: AsyncSession, since, m_cond, i_cond) -> float:
    """Cost of parts used in the period: WO parts plus approved intervention parts."""
    wo_parts = (await db.execute(
        select(func.sum(WOPart.total_cost))
        .join(WorkOrder, WOPart.work_order_id == WorkOrder.id)
        .where(and_(m_cond, WOPart.created_at >= since, WOPart.total_cost.isnot(None)))
    )).scalar() or 0.0
    int_parts = (await db.execute(
        select(func.sum(InterventionPart.total_cost))
        .join(MachineIntervention, InterventionPart.intervention_id == MachineIntervention.id)
        .where(
            and_(
                i_cond,
                InterventionPart.approval_status == "approved",
                InterventionPart.added_at >= since,
                InterventionPart.total_cost.isnot(None),
            )
        )
    )).scalar() or 0.0
    return float(wo_parts) + float(int_parts)


@router.get("/summary")
async def get_kpi_summary(
    period_days: int = Query(30, ge=1, le=365),
    machine_id: Optional[UUID] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    since = datetime.now(timezone.utc) - timedelta(days=period_days)
    m_cond = await _machine_cond(db, machine_id)

    # MTTR: corrective WO repair hours plus machine intervention durations,
    # skipping interventions whose ticket already produced a counted WO
    wo_repair_rows = (await db.execute(
        select(WorkOrder.repair_hours, WorkOrder.ticket_id).where(
            and_(
                m_cond,
                WorkOrder.type == WorkOrderType.corrective,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.completed_at >= since,
                WorkOrder.repair_hours.isnot(None),
            )
        )
    )).all()
    repair_samples = [float(r.repair_hours) for r in wo_repair_rows]
    counted_tickets = {r.ticket_id for r in wo_repair_rows if r.ticket_id}

    i_cond = await _machine_int_cond(db, machine_id)
    int_rows = (await db.execute(
        select(
            MachineIntervention.intervention_duration_minutes,
            MachineIntervention.ticket_id,
        ).where(
            and_(
                i_cond,
                MachineIntervention.status == "completed",
                MachineIntervention.called_at >= since,
                MachineIntervention.intervention_duration_minutes.isnot(None),
            )
        )
    )).all()
    for r in int_rows:
        if r.ticket_id and r.ticket_id in counted_tickets:
            continue
        repair_samples.append(float(r.intervention_duration_minutes) / 60.0)
    mttr = sum(repair_samples) / len(repair_samples) if repair_samples else 0.0

    # MTTA — mean time to attend: how long maintenance waits between the call and
    # the technician starting the intervention (response/wait time).
    resp_rows = (await db.execute(
        select(MachineIntervention.response_time_minutes).where(
            and_(
                i_cond,
                MachineIntervention.response_time_minutes.isnot(None),
                MachineIntervention.called_at >= since,
            )
        )
    )).all()
    resp_samples = [float(r.response_time_minutes) for r in resp_rows]
    mtta_minutes = sum(resp_samples) / len(resp_samples) if resp_samples else 0.0

    backlog_r = await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(
                m_cond,
                WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.in_progress]),
            )
        )
    )
    backlog = backlog_r.scalar() or 0

    total_pm_r = await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(m_cond, WorkOrder.type == WorkOrderType.preventive, WorkOrder.opened_at >= since)
        )
    )
    total_pm = total_pm_r.scalar() or 0

    on_time_r = await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(
                m_cond,
                WorkOrder.type == WorkOrderType.preventive,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.opened_at >= since,
                WorkOrder.completed_at.isnot(None),
                WorkOrder.due_date.isnot(None),
                WorkOrder.completed_at <= WorkOrder.due_date,
            )
        )
    )
    on_time = on_time_r.scalar() or 0
    pm_compliance = round((on_time / total_pm * 100) if total_pm > 0 else 0.0, 1)

    cost_r = await db.execute(
        select(func.sum(WOCost.amount))
        .join(WorkOrder, WOCost.work_order_id == WorkOrder.id)
        .where(and_(m_cond, WOCost.date >= since.date()))
    )
    total_cost = float(cost_r.scalar() or 0.0)
    total_cost += await _parts_cost(db, since, m_cond, i_cond)

    # ── Availability & MTBF ──────────────────────────────────────────────────
    # Downtime = corrective-WO downtime + operator-logged machine stops in the period.
    wo_downtime = (await db.execute(
        select(func.sum(WorkOrder.downtime_hours)).where(
            and_(m_cond, WorkOrder.downtime_hours.isnot(None), WorkOrder.opened_at >= since)
        )
    )).scalar() or 0.0
    stop_cond = (MachineStop.machine_id == machine_id) if machine_id else true()
    stop_minutes = (await db.execute(
        select(func.sum(MachineStop.duration_minutes)).where(
            and_(stop_cond, MachineStop.started_at >= since, MachineStop.duration_minutes.isnot(None))
        )
    )).scalar() or 0
    downtime_hours = float(wo_downtime) + float(stop_minutes) / 60.0

    # Failures = corrective work orders opened in the period (drives MTBF).
    failures = (await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(m_cond, WorkOrder.type == WorkOrderType.corrective, WorkOrder.opened_at >= since)
        )
    )).scalar() or 0

    # Capacity = (1 machine | all machines) × calendar hours of the period.
    if machine_id:
        scope_machines = 1
    else:
        scope_machines = (await db.execute(select(func.count(Machine.id)))).scalar() or 1
    capacity_hours = max(scope_machines, 1) * period_days * 24.0
    operating_hours = max(capacity_hours - downtime_hours, 0.0)
    availability = round(operating_hours / capacity_hours * 100, 1) if capacity_hours > 0 else 0.0
    mtbf_hours = round(operating_hours / failures, 1) if failures > 0 else round(operating_hours, 1)

    # ── Production KPIs + live status (machine-scoped) ───────────────────────
    # Parts/hour, quality and OEE come from machine_production_logs (fed by the
    # shop floor). They read 0 until the plant sends production data, then the
    # card lights up automatically. Status/operator are the machine's live state.
    parts_per_hour = 0.0
    quality_pct = 0.0
    oee_pct = 0.0
    current_status = None
    operator = None
    if machine_id:
        machine = await db.get(Machine, machine_id)
        if machine:
            current_status = (
                machine.current_status.value
                if hasattr(machine.current_status, "value")
                else str(machine.current_status or "")
            )
            operator = machine.current_operator
        prod = (await db.execute(
            select(
                func.coalesce(func.sum(MachineProductionLog.actual_count), 0),
                func.coalesce(func.sum(MachineProductionLog.reject_count), 0),
                func.coalesce(func.sum(MachineProductionLog.target_count), 0),
            ).where(and_(
                MachineProductionLog.machine_id == machine_id,
                MachineProductionLog.date >= since.date(),
            ))
        )).first()
        total_actual = float(prod[0] or 0)
        total_reject = float(prod[1] or 0)
        total_target = float(prod[2] or 0)
        if operating_hours > 0:
            parts_per_hour = round(total_actual / operating_hours, 1)
        if total_actual > 0:
            quality_pct = round((total_actual - total_reject) / total_actual * 100, 1)
        # OEE = Availability × Performance × Quality (performance capped at 100%)
        performance = min(total_actual / total_target, 1.0) if total_target > 0 else 0.0
        oee_pct = round((availability / 100.0) * performance * (quality_pct / 100.0) * 100, 1)

    return {
        "mttr_hours": round(float(mttr), 2),
        "mtta_minutes": round(float(mtta_minutes), 1),
        "mtbf_hours": mtbf_hours,
        "availability_pct": availability,
        "downtime_hours": round(downtime_hours, 2),
        "failures": int(failures),
        "backlog_count": int(backlog),
        "pm_compliance_pct": pm_compliance,
        "total_cost_cad": round(float(total_cost), 2),
        "parts_per_hour": parts_per_hour,
        "quality_pct": quality_pct,
        "oee_pct": oee_pct,
        "current_status": current_status,
        "operator": operator,
        "period_days": period_days,
    }


@router.get("/backlog")
async def get_backlog(
    machine_id: Optional[UUID] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    m_cond = await _machine_cond(db, machine_id)
    result = await db.execute(
        select(WorkOrder.id, WorkOrder.opened_at).where(
            and_(
                m_cond,
                WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.in_progress]),
            )
        )
    )
    rows = result.all()
    buckets = {"0_7": 0, "7_30": 0, "30_plus": 0}
    for row in rows:
        opened = row.opened_at if row.opened_at.tzinfo else row.opened_at.replace(tzinfo=timezone.utc)
        age = (now - opened).days
        if age <= 7:
            buckets["0_7"] += 1
        elif age <= 30:
            buckets["7_30"] += 1
        else:
            buckets["30_plus"] += 1

    return {
        "total": len(rows),
        "buckets": [
            {"label": "0–7 days", "count": buckets["0_7"]},
            {"label": "7–30 days", "count": buckets["7_30"]},
            {"label": "30+ days", "count": buckets["30_plus"]},
        ],
    }


@router.get("/mttr")
async def get_mttr_by_equipment(
    period_days: int = Query(90, ge=1, le=365),
    machine_id: Optional[UUID] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    since = datetime.now(timezone.utc) - timedelta(days=period_days)
    m_cond = await _machine_cond(db, machine_id)

    # WO-based repairs grouped by equipment
    wo_rows = (await db.execute(
        select(WorkOrder.repair_hours, WorkOrder.ticket_id, Equipment.name, Equipment.code)
        .join(Equipment, WorkOrder.equipment_id == Equipment.id)
        .where(
            and_(
                m_cond,
                WorkOrder.type == WorkOrderType.corrective,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.completed_at >= since,
                WorkOrder.repair_hours.isnot(None),
            )
        )
    )).all()

    groups: dict = {}
    counted_tickets = set()
    for r in wo_rows:
        g = groups.setdefault(r.name, {"code": r.code, "samples": []})
        g["samples"].append(float(r.repair_hours))
        if r.ticket_id:
            counted_tickets.add(r.ticket_id)

    # Machine interventions grouped by machine, merged by display name
    i_cond = await _machine_int_cond(db, machine_id)
    int_rows = (await db.execute(
        select(
            MachineIntervention.machine_id,
            MachineIntervention.equipment_id,
            MachineIntervention.intervention_duration_minutes,
            MachineIntervention.ticket_id,
        ).where(
            and_(
                i_cond,
                MachineIntervention.status == "completed",
                MachineIntervention.called_at >= since,
                MachineIntervention.intervention_duration_minutes.isnot(None),
            )
        )
    )).all()
    if int_rows:
        machines_map = {
            m.id: m for m in (await db.execute(select(Machine))).scalars().all()
        }
        for r in int_rows:
            if r.ticket_id and r.ticket_id in counted_tickets:
                continue
            name, code = None, None
            m = machines_map.get(r.machine_id)
            if m:
                name, code = (m.display_name or m.name), m.code
            elif r.equipment_id:
                eq = await db.get(Equipment, r.equipment_id)
                if eq:
                    name, code = eq.name, eq.code
            if not name:
                continue
            g = groups.setdefault(name, {"code": code, "samples": []})
            g["samples"].append(float(r.intervention_duration_minutes) / 60.0)

    items = [
        {
            "equipment": name,
            "code": g["code"],
            "avg_repair_hours": round(sum(g["samples"]) / len(g["samples"]), 2),
            "repairs": len(g["samples"]),
        }
        for name, g in groups.items()
    ]
    return sorted(items, key=lambda x: x["avg_repair_hours"], reverse=True)


@router.get("/cost")
async def get_cost_by_type(
    period_days: int = Query(30, ge=1, le=365),
    machine_id: Optional[UUID] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    since = datetime.now(timezone.utc) - timedelta(days=period_days)
    m_cond = await _machine_cond(db, machine_id)
    result = await db.execute(
        select(WOCost.transaction_type, func.sum(WOCost.amount).label("total"))
        .join(WorkOrder, WOCost.work_order_id == WorkOrder.id)
        .where(and_(m_cond, WOCost.date >= since.date()))
        .group_by(WOCost.transaction_type)
    )
    rows = result.all()
    out = [{"type": row.transaction_type, "total": round(float(row.total), 2)} for row in rows]

    i_cond = await _machine_int_cond(db, machine_id)
    parts_total = await _parts_cost(db, since, m_cond, i_cond)
    if parts_total:
        out.append({"type": "parts_used", "total": round(parts_total, 2)})
    return out
