from datetime import datetime, timezone, timedelta, date as _date
from typing import Optional
import uuid as _uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_

from app.db.session import get_db
from app.models.models import (
    MaintenanceAlert, MaintenanceTicket, AlertStatus, TicketStatus,
    AlertPriority, Machine, User, WorkOrder, WorkOrderStatus, Technician,
    WorkOrderSource, MachineIntervention, Equipment,
)
from app.schemas.maintenance import SupervisorOverview, TicketSummary, WOSummary
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import plant_condition

router = APIRouter()

_OPEN_ALERT_STATUSES  = [AlertStatus.new_alert, AlertStatus.assigned, AlertStatus.in_progress]
_OPEN_TICKET_STATUSES = [TicketStatus.open, TicketStatus.in_progress, TicketStatus.on_hold_parts, TicketStatus.on_hold_ext]


def _parse_machine_ids(machine_ids: Optional[str]) -> list:
    """Comma-separated UUID string -> list of UUIDs (invalid entries dropped)."""
    if not machine_ids:
        return []
    out = []
    for part in machine_ids.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(_uuid.UUID(part))
        except ValueError:
            pass
    return out


def _resolve_window(period_days: int, start_date: Optional[str], end_date: Optional[str]):
    """Return (start, end) UTC datetimes. Custom dates win; end is inclusive
    of the chosen day. Falls back to the rolling period_days window."""
    now = datetime.now(timezone.utc)
    if start_date and end_date:
        try:
            start = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
            end = datetime.fromisoformat(end_date).replace(tzinfo=timezone.utc) + timedelta(days=1)
            if start < end:
                return start, end
        except ValueError:
            pass
    return now - timedelta(days=period_days), now


@router.get("/dashboard")
async def maintenance_dashboard(
    period_days: int = Query(30, ge=1, le=730),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    machine_ids: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    start, end = _resolve_window(period_days, start_date, end_date)
    mids = _parse_machine_ids(machine_ids)

    def t_conds(extra=None):
        c = [MaintenanceTicket.opened_at >= start, MaintenanceTicket.opened_at < end,
             plant_condition(MaintenanceTicket, ctx)]
        if mids:
            c.append(MaintenanceTicket.machine_id.in_(mids))
        if extra:
            c.extend(extra)
        return c

    def a_conds(extra=None):
        c = [MaintenanceAlert.created_at >= start, MaintenanceAlert.created_at < end,
             plant_condition(MaintenanceAlert, ctx)]
        if mids:
            c.append(MaintenanceAlert.machine_id.in_(mids))
        if extra:
            c.extend(extra)
        return c
    # ── KPI counts (within window + machine filter) ───────────────────────────
    r = await db.execute(
        select(func.count(MaintenanceAlert.id)).where(
            *a_conds([MaintenanceAlert.status.in_(_OPEN_ALERT_STATUSES)])
        )
    )
    open_alerts = r.scalar() or 0

    r = await db.execute(
        select(func.count(MaintenanceTicket.id)).where(
            *t_conds([MaintenanceTicket.status.in_(_OPEN_TICKET_STATUSES)])
        )
    )
    open_tickets = r.scalar() or 0

    r = await db.execute(
        select(func.count(MaintenanceTicket.id)).where(
            *t_conds([
                MaintenanceTicket.priority == AlertPriority.critical,
                MaintenanceTicket.status.in_(_OPEN_TICKET_STATUSES),
            ])
        )
    )
    critical_tickets = r.scalar() or 0

    r = await db.execute(
        select(func.count(MaintenanceAlert.id)).where(
            *a_conds([
                MaintenanceAlert.is_overdue == True,
                MaintenanceAlert.status.in_(_OPEN_ALERT_STATUSES),
            ])
        )
    )
    overdue_alerts = r.scalar() or 0

    # ── Avg resolution time: real open → completed elapsed, to the second ─────
    resolution_r = await db.execute(
        select(func.avg(
            func.extract("epoch", MaintenanceTicket.completed_at) -
            func.extract("epoch", MaintenanceTicket.opened_at)
        )).where(
            *t_conds([
                MaintenanceTicket.status == TicketStatus.completed,
                MaintenanceTicket.completed_at.isnot(None),
            ])
        )
    )
    avg_secs = resolution_r.scalar()
    # None (no completed tickets) stays None so the UI shows "—", not a fake "0 min".
    if avg_secs is not None:
        avg_resolution_seconds = round(float(avg_secs), 1)
        avg_resolution_minutes = round(avg_resolution_seconds / 60, 4)
        avg_resolution_hours = round(avg_resolution_seconds / 3600, 4)
    else:
        avg_resolution_seconds = None
        avg_resolution_minutes = None
        avg_resolution_hours = None

    # ── Charts data ───────────────────────────────────────────────────────────

    # Tickets by machine
    r = await db.execute(
        select(MaintenanceTicket.machine_id, func.count(MaintenanceTicket.id))
        .where(*t_conds())
        .group_by(MaintenanceTicket.machine_id)
        .order_by(func.count(MaintenanceTicket.id).desc())
        .limit(10)
    )
    by_machine = []
    for machine_id, count in r.all():
        m = await db.get(Machine, machine_id)
        by_machine.append({"machine": (m.display_name or m.name) if m else str(machine_id), "count": count})

    # Alerts by problem type
    r = await db.execute(
        select(MaintenanceAlert.problem_type, func.count(MaintenanceAlert.id))
        .where(*a_conds())
        .group_by(MaintenanceAlert.problem_type)
    )
    by_problem_type = [
        {"type": pt, "count": c} for pt, c in r.all() if pt
    ]

    # Tickets by technician
    r = await db.execute(
        select(MaintenanceTicket.assigned_to_id, func.count(MaintenanceTicket.id))
        .where(*t_conds([MaintenanceTicket.assigned_to_id.isnot(None)]))
        .group_by(MaintenanceTicket.assigned_to_id)
        .order_by(func.count(MaintenanceTicket.id).desc())
        .limit(10)
    )
    by_technician = []
    for user_id, count in r.all():
        u = await db.get(User, user_id)
        by_technician.append({"technician": u.name if u else str(user_id), "count": count})

    # Escalation by level (alerts that were escalated)
    r = await db.execute(
        select(MaintenanceAlert.escalation_level, func.count(MaintenanceAlert.id))
        .where(*a_conds([MaintenanceAlert.escalation_level > 0]))
        .group_by(MaintenanceAlert.escalation_level)
        .order_by(MaintenanceAlert.escalation_level)
    )
    by_escalation = [{"level": f"L{lv}", "count": c} for lv, c in r.all()]

    # Tickets by status
    r = await db.execute(
        select(MaintenanceTicket.status, func.count(MaintenanceTicket.id))
        .where(*t_conds())
        .group_by(MaintenanceTicket.status)
    )
    by_ticket_status = [{"status": s, "count": c} for s, c in r.all() if s]

    # ── Trend over time (tickets opened & interventions called per bucket) ─────
    span_days = (end.date() - start.date()).days
    daily = span_days <= 92
    bucket_unit = "day" if daily else "week"

    buckets = []
    cur = start.date()
    end_d = end.date()
    while cur < end_d:
        b_end = (cur + timedelta(days=1)) if daily else min(cur + timedelta(days=7), end_d)
        buckets.append({"start": cur, "end": b_end, "date": cur.isoformat(),
                        "label": cur.isoformat()[5:], "tickets": 0, "interventions": 0})
        cur = b_end

    def _bucket_for(d: _date):
        for b in buckets:
            if b["start"] <= d < b["end"]:
                return b
        return None

    t_rows = (await db.execute(
        select(func.date(MaintenanceTicket.opened_at), func.count(MaintenanceTicket.id))
        .where(*t_conds())
        .group_by(func.date(MaintenanceTicket.opened_at))
    )).all()
    for d, c in t_rows:
        dd = d if isinstance(d, _date) else _date.fromisoformat(str(d))
        b = _bucket_for(dd)
        if b:
            b["tickets"] += c

    int_conds = [MachineIntervention.called_at >= start, MachineIntervention.called_at < end,
                 plant_condition(MachineIntervention, ctx)]
    if mids:
        int_conds.append(MachineIntervention.machine_id.in_(mids))
    i_rows = (await db.execute(
        select(func.date(MachineIntervention.called_at), func.count(MachineIntervention.id))
        .where(*int_conds)
        .group_by(func.date(MachineIntervention.called_at))
    )).all()
    for d, c in i_rows:
        dd = d if isinstance(d, _date) else _date.fromisoformat(str(d))
        b = _bucket_for(dd)
        if b:
            b["interventions"] += c

    trend = [{"date": b["date"], "label": b["label"],
              "tickets": b["tickets"], "interventions": b["interventions"]} for b in buckets]

    return {
        "open_alerts":          open_alerts,
        "open_tickets":         open_tickets,
        "critical_tickets":     critical_tickets,
        "overdue_alerts":       overdue_alerts,
        "avg_resolution_hours": avg_resolution_hours,
        "avg_resolution_minutes": avg_resolution_minutes,
        "avg_resolution_seconds": avg_resolution_seconds,
        "by_machine":           by_machine,
        "by_problem_type":      by_problem_type,
        "by_technician":        by_technician,
        "by_escalation":        by_escalation,
        "by_ticket_status":     by_ticket_status,
        "trend":                trend,
        "bucket_unit":          bucket_unit,
        "period": {
            "start": start.date().isoformat(),
            "end":   (end - timedelta(days=1)).date().isoformat(),
        },
    }


@router.get("/supervisor", response_model=SupervisorOverview)
async def supervisor_overview(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    # Panel 1: tickets without linked WO, not closed
    closed_statuses = [TicketStatus.completed, TicketStatus.cancelled]
    r = await db.execute(
        select(MaintenanceTicket)
        .where(
            MaintenanceTicket.status.not_in(closed_statuses),
            MaintenanceTicket.work_order_id.is_(None),
            plant_condition(MaintenanceTicket, ctx),
        )
        .order_by(MaintenanceTicket.opened_at.asc())
        .limit(50)
    )
    raw_tickets = r.scalars().all()

    pending_tickets = []
    for t in raw_tickets:
        m = await db.get(Machine, t.machine_id)
        ptype = t.problem_type.value if t.problem_type else ""
        pending_tickets.append(TicketSummary(
            id=t.id,
            ticket_number=t.ticket_number,
            machine_name=m.name if m else None,
            priority=t.priority.value if hasattr(t.priority, "value") else str(t.priority),
            problem_type=ptype,
            status=t.status.value if hasattr(t.status, "value") else str(t.status),
            opened_at=t.opened_at,
            is_overdue=False,
            current_escalation_level=t.current_escalation_level,
            work_order_id=t.work_order_id,
        ))

    # Panel 2: WOs from tickets, not yet assigned (executor_id IS NULL)
    r = await db.execute(
        select(WorkOrder)
        .where(
            WorkOrder.source == WorkOrderSource.ticket,
            WorkOrder.executor_id.is_(None),
            WorkOrder.status.in_([WorkOrderStatus.open]),
            plant_condition(WorkOrder, ctx),
        )
        .order_by(WorkOrder.opened_at.asc())
        .limit(50)
    )
    raw_unassigned = r.scalars().all()

    async def _wo_summary(wo: WorkOrder) -> WOSummary:
        from app.models.models import Equipment as Equip
        equip = await db.get(Equip, wo.equipment_id) if wo.equipment_id else None
        ticket_num = None
        if wo.ticket_id:
            t = await db.get(MaintenanceTicket, wo.ticket_id)
            ticket_num = t.ticket_number if t else None
        exec_name = None
        if wo.executor_id:
            tech = await db.get(Technician, wo.executor_id)
            if tech:
                u = await db.get(User, tech.user_id)
                exec_name = u.name if u else None
        sdate = str(wo.scheduled_date) if wo.scheduled_date else None
        return WOSummary(
            id=wo.id,
            wo_number=wo.wo_number,
            ticket_id=wo.ticket_id,
            ticket_number=ticket_num,
            machine_name=equip.name if equip else None,
            priority=wo.priority.value if hasattr(wo.priority, "value") else str(wo.priority),
            status=wo.status.value if hasattr(wo.status, "value") else str(wo.status),
            opened_at=wo.opened_at,
            executor_id=wo.executor_id,
            executor_name=exec_name,
            scheduled_date=sdate,
            scheduled_start_time=wo.scheduled_start_time,
            scheduled_end_time=wo.scheduled_end_time,
        )

    unassigned_wos = [await _wo_summary(wo) for wo in raw_unassigned]

    # Panel 3: WOs from tickets, assigned (executor_id IS NOT NULL), not scheduled
    r = await db.execute(
        select(WorkOrder)
        .where(
            WorkOrder.source == WorkOrderSource.ticket,
            WorkOrder.executor_id.isnot(None),
            WorkOrder.scheduled_date.is_(None),
            WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.in_progress]),
            plant_condition(WorkOrder, ctx),
        )
        .order_by(WorkOrder.opened_at.asc())
        .limit(50)
    )
    raw_unscheduled = r.scalars().all()
    unscheduled_wos = [await _wo_summary(wo) for wo in raw_unscheduled]

    return SupervisorOverview(
        pending_tickets=pending_tickets,
        unassigned_wos=unassigned_wos,
        unscheduled_wos=unscheduled_wos,
    )


@router.get("/intervention-kpis")
async def get_intervention_kpis(
    days: int = Query(30, ge=1, le=730),
    equipment_id: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    machine_ids: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    start, end = _resolve_window(days, start_date, end_date)
    # Window span drives the MTBF operating-time denominator
    window_days = max(1, (end - start).days)

    filters = [
        MachineIntervention.status == "completed",
        MachineIntervention.called_at >= start,
        MachineIntervention.called_at < end,
        plant_condition(MachineIntervention, ctx),
    ]
    if equipment_id:
        try:
            filters.append(MachineIntervention.equipment_id == _uuid.UUID(equipment_id))
        except ValueError:
            pass
    mids = _parse_machine_ids(machine_ids)
    if mids:
        filters.append(MachineIntervention.machine_id.in_(mids))

    items = (await db.execute(
        select(MachineIntervention)
        .where(and_(*filters))
        .order_by(MachineIntervention.called_at)
    )).scalars().all()

    if not items:
        return {
            "total_interventions": 0,
            "period_days": window_days,
            "mttr_minutes": None,
            "mtbf_hours": None,
            "avg_response_time_minutes": None,
            "avg_duration_minutes": None,
            "avg_downtime_minutes": None,
            "by_equipment": [],
        }

    durations = [i.intervention_duration_minutes for i in items if i.intervention_duration_minutes is not None]
    responses  = [i.response_time_minutes for i in items if i.response_time_minutes is not None]
    downtimes  = [i.total_downtime_minutes for i in items if i.total_downtime_minutes is not None]

    mttr = round(sum(durations) / len(durations), 1) if durations else None

    # MTBF per machine (operating hours / failures), then averaged across machines.
    # Dividing a single-timeline window by a multi-machine failure count understates
    # it, so aggregate per asset. Need >=2 events for a between-failures interval;
    # if no machine qualifies, MTBF is not computable -> None (UI shows "—").
    per_machine: dict = {}
    for i in items:
        mk = str(i.machine_id or i.equipment_id or "unknown")
        slot = per_machine.setdefault(mk, {"count": 0, "downtime_min": 0.0})
        slot["count"] += 1
        if i.total_downtime_minutes is not None:
            slot["downtime_min"] += i.total_downtime_minutes
    mtbf_vals = []
    for slot in per_machine.values():
        if slot["count"] >= 2:
            op_hours = window_days * 24 - slot["downtime_min"] / 60
            if op_hours > 0:
                mtbf_vals.append(op_hours / slot["count"])
    mtbf = round(sum(mtbf_vals) / len(mtbf_vals), 1) if mtbf_vals else None

    avg_response  = round(sum(responses) / len(responses), 1) if responses else None
    avg_downtime  = round(sum(downtimes) / len(downtimes), 1) if downtimes else None
    avg_duration  = round(sum(durations) / len(durations), 1) if durations else None

    eq_map: dict = {}
    for i in items:
        key = str(i.equipment_id or i.machine_id or "unknown")
        if key not in eq_map:
            eq_map[key] = {"equipment_id": key, "count": 0, "durations": [], "responses": [], "name": None}
        eq_map[key]["count"] += 1
        if i.intervention_duration_minutes is not None:
            eq_map[key]["durations"].append(i.intervention_duration_minutes)
        if i.response_time_minutes is not None:
            eq_map[key]["responses"].append(i.response_time_minutes)

    # Resolve names. The key is an equipment id, or (when intervention.equipment_id
    # is NULL) a machine id — fall back to the linked/own Machine name so the chart
    # never shows a raw UUID fragment.
    for key, data in eq_map.items():
        try:
            uid = _uuid.UUID(key)
        except ValueError:
            continue
        eq = await db.get(Equipment, uid)
        if eq:
            data["name"] = eq.name
            continue
        m = await db.get(Machine, uid)
        if m:
            if m.equipment_id:
                eq2 = await db.get(Equipment, m.equipment_id)
                if eq2:
                    data["name"] = eq2.name
            if not data["name"]:
                data["name"] = m.name

    by_equipment = []
    for key, data in eq_map.items():
        by_equipment.append({
            "equipment_id": data["equipment_id"],
            "name": data["name"] or data["equipment_id"][:8],
            "intervention_count": data["count"],
            "avg_duration_minutes": round(sum(data["durations"]) / len(data["durations"]), 1) if data["durations"] else None,
            "avg_response_minutes": round(sum(data["responses"]) / len(data["responses"]), 1) if data["responses"] else None,
        })

    return {
        "total_interventions": len(items),
        "period_days": window_days,
        "mttr_minutes": mttr,
        "mtbf_hours": mtbf,
        "avg_response_time_minutes": avg_response,
        "avg_duration_minutes": avg_duration,
        "avg_downtime_minutes": avg_downtime,
        "by_equipment": sorted(by_equipment, key=lambda x: x["intervention_count"], reverse=True),
    }
