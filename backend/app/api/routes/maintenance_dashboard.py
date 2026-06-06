from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.db.session import get_db
from app.models.models import (
    MaintenanceAlert, MaintenanceTicket, AlertStatus, TicketStatus,
    AlertPriority, Machine, User, WorkOrder, WorkOrderStatus, Technician,
    WorkOrderSource,
)
from app.schemas.maintenance import SupervisorOverview, TicketSummary, WOSummary
from app.core.security import get_current_user

router = APIRouter()

_OPEN_ALERT_STATUSES  = [AlertStatus.new_alert, AlertStatus.assigned, AlertStatus.in_progress]
_OPEN_TICKET_STATUSES = [TicketStatus.open, TicketStatus.in_progress, TicketStatus.on_hold_parts, TicketStatus.on_hold_ext]


@router.get("/dashboard")
async def maintenance_dashboard(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # ── KPI counts ────────────────────────────────────────────────────────────
    r = await db.execute(
        select(func.count(MaintenanceAlert.id)).where(
            MaintenanceAlert.status.in_(_OPEN_ALERT_STATUSES)
        )
    )
    open_alerts = r.scalar() or 0

    r = await db.execute(
        select(func.count(MaintenanceTicket.id)).where(
            MaintenanceTicket.status.in_(_OPEN_TICKET_STATUSES)
        )
    )
    open_tickets = r.scalar() or 0

    r = await db.execute(
        select(func.count(MaintenanceTicket.id)).where(
            MaintenanceTicket.priority == AlertPriority.critical,
            MaintenanceTicket.status.in_(_OPEN_TICKET_STATUSES),
        )
    )
    critical_tickets = r.scalar() or 0

    r = await db.execute(
        select(func.count(MaintenanceAlert.id)).where(
            MaintenanceAlert.is_overdue == True,
            MaintenanceAlert.status.in_(_OPEN_ALERT_STATUSES),
        )
    )
    overdue_alerts = r.scalar() or 0

    # ── Avg resolution time ───────────────────────────────────────────────────
    r = await db.execute(
        select(MaintenanceTicket).where(
            MaintenanceTicket.status == TicketStatus.completed,
            MaintenanceTicket.total_intervention_minutes.isnot(None),
        )
    )
    completed = r.scalars().all()
    avg_resolution_hours = 0.0
    if completed:
        total_mins = sum(t.total_intervention_minutes or 0 for t in completed)
        avg_resolution_hours = round(total_mins / len(completed) / 60, 1)

    # ── Charts data ───────────────────────────────────────────────────────────

    # Tickets by machine
    r = await db.execute(
        select(MaintenanceTicket.machine_id, func.count(MaintenanceTicket.id))
        .group_by(MaintenanceTicket.machine_id)
        .order_by(func.count(MaintenanceTicket.id).desc())
        .limit(10)
    )
    by_machine = []
    for machine_id, count in r.all():
        m = await db.get(Machine, machine_id)
        by_machine.append({"machine": m.name if m else str(machine_id), "count": count})

    # Alerts by problem type
    r = await db.execute(
        select(MaintenanceAlert.problem_type, func.count(MaintenanceAlert.id))
        .group_by(MaintenanceAlert.problem_type)
    )
    by_problem_type = [
        {"type": pt, "count": c} for pt, c in r.all() if pt
    ]

    # Tickets by technician
    r = await db.execute(
        select(MaintenanceTicket.assigned_to_id, func.count(MaintenanceTicket.id))
        .where(MaintenanceTicket.assigned_to_id.isnot(None))
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
        .where(MaintenanceAlert.escalation_level > 0)
        .group_by(MaintenanceAlert.escalation_level)
        .order_by(MaintenanceAlert.escalation_level)
    )
    by_escalation = [{"level": f"L{lv}", "count": c} for lv, c in r.all()]

    # Open tickets by status
    r = await db.execute(
        select(MaintenanceTicket.status, func.count(MaintenanceTicket.id))
        .group_by(MaintenanceTicket.status)
    )
    by_ticket_status = [{"status": s, "count": c} for s, c in r.all() if s]

    return {
        "open_alerts":          open_alerts,
        "open_tickets":         open_tickets,
        "critical_tickets":     critical_tickets,
        "overdue_alerts":       overdue_alerts,
        "avg_resolution_hours": avg_resolution_hours,
        "by_machine":           by_machine,
        "by_problem_type":      by_problem_type,
        "by_technician":        by_technician,
        "by_escalation":        by_escalation,
        "by_ticket_status":     by_ticket_status,
    }


@router.get("/supervisor", response_model=SupervisorOverview)
async def supervisor_overview(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Panel 1: tickets without linked WO, not closed
    closed_statuses = [TicketStatus.completed, TicketStatus.cancelled]
    r = await db.execute(
        select(MaintenanceTicket)
        .where(
            MaintenanceTicket.status.not_in(closed_statuses),
            MaintenanceTicket.work_order_id.is_(None),
        )
        .order_by(MaintenanceTicket.opened_at.asc())
        .limit(50)
    )
    raw_tickets = r.scalars().all()

    pending_tickets = []
    for t in raw_tickets:
        m = await db.get(Machine, t.machine_id)
        ptype = t.problem_type.value if hasattr(t.problem_type, "value") else str(t.problem_type)
        pending_tickets.append(TicketSummary(
            id=t.id,
            ticket_number=t.ticket_number,
            machine_name=m.name if m else None,
            priority=t.priority.value if hasattr(t.priority, "value") else str(t.priority),
            problem_type=ptype,
            status=t.status.value if hasattr(t.status, "value") else str(t.status),
            opened_at=t.opened_at,
            is_overdue=t.is_overdue,
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
