"""TPM preventive maintenance — recurrence calculation, occurrence/WO/ticket
generation, and overdue/reminder alerting."""
import calendar
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    MaintenancePlan, PlanOccurrence, PmTemplate, PmTemplateTask,
    WorkOrder, WorkOrderType, WorkOrderStatus, WorkOrderPriority, WorkOrderSource,
    WOAction, Equipment, Technician, User,
    OccurrenceStatus, OccurrenceCompliance, RecurrenceEndType, PmFrequency,
    AlertPriority, AlertProblemType,
)
from app.schemas.maintenance import TicketCreate
from app.services.ticket_service import TicketService
from app.services.notification_service import NotificationService


def _safe_enum(enum_cls, value, default):
    try:
        return enum_cls(value)
    except ValueError:
        return default


# ─── Recurrence calculation ──────────────────────────────────────────────────────

def _add_months(d: date, months: int) -> date:
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def calculate_next_date(plan: MaintenancePlan, from_date: date) -> date:
    """Compute the next scheduled date for a plan's recurrence, strictly after from_date."""
    value = plan.frequency_value or 1

    if plan.frequency_days:
        return from_date + timedelta(days=plan.frequency_days * value)

    freq = plan.frequency_type

    if freq == PmFrequency.daily:
        return from_date + timedelta(days=value)

    if freq == PmFrequency.weekly:
        if plan.weekdays:
            allowed = sorted(int(d) for d in plan.weekdays.split(",") if d.strip() != "")
            if allowed:
                for offset in range(1, 8 * value + 1):
                    candidate = from_date + timedelta(days=offset)
                    if candidate.weekday() in allowed:
                        return candidate
        return from_date + timedelta(weeks=value)

    if freq == PmFrequency.monthly:
        return _add_months(from_date, value)

    if freq == PmFrequency.quarterly:
        return _add_months(from_date, 3 * value)

    if freq == PmFrequency.semiannual:
        return _add_months(from_date, 6 * value)

    if freq == PmFrequency.annual:
        return _add_months(from_date, 12 * value)

    return from_date + timedelta(days=30)


def is_recurrence_ended(plan: MaintenancePlan) -> bool:
    """Check whether a plan's recurrence has reached its configured end."""
    if plan.recurrence_end_type == RecurrenceEndType.after_occurrences:
        return (
            plan.recurrence_end_value is not None
            and (plan.total_occurrences or 0) >= plan.recurrence_end_value
        )
    if plan.recurrence_end_type == RecurrenceEndType.on_date:
        next_date = plan.next_due_date or plan.start_date
        return (
            plan.recurrence_end_date is not None
            and next_date is not None
            and next_date > plan.recurrence_end_date
        )
    return False


# ─── Occurrence creation ──────────────────────────────────────────────────────────

async def create_next_occurrence(db: AsyncSession, plan: MaintenancePlan) -> Optional[PlanOccurrence]:
    """Create the next PlanOccurrence for a plan and advance its next_due_date."""
    if not plan.is_active:
        return None
    if is_recurrence_ended(plan):
        return None

    scheduled_date = plan.next_due_date or plan.start_date or date.today()

    occurrence = PlanOccurrence(
        plan_id=plan.id,
        plant_id=plan.plant_id,
        equipment_id=plan.equipment_id,
        scheduled_date=scheduled_date,
        status=OccurrenceStatus.scheduled,
    )
    db.add(occurrence)

    plan.total_occurrences = (plan.total_occurrences or 0) + 1
    plan.next_due_date = calculate_next_date(plan, scheduled_date)
    if plan.frequency_hours:
        plan.next_due_hours = (plan.next_due_hours or 0.0) + plan.frequency_hours

    await db.flush()
    await db.refresh(occurrence)
    return occurrence


# ─── Work order + ticket generation ──────────────────────────────────────────────

async def _next_wo_number(db: AsyncSession) -> str:
    from app.services.numbering import next_number
    year = datetime.now(timezone.utc).year
    return await next_number(db, WorkOrder.wo_number, f"WO-{year}")


async def generate_wo_and_ticket(db: AsyncSession, plan: MaintenancePlan, occurrence: PlanOccurrence) -> WorkOrder:
    """Create the work order (and linked ticket) for a PM occurrence."""
    equipment = await db.get(Equipment, plan.equipment_id)
    priority = _safe_enum(WorkOrderPriority, plan.priority, WorkOrderPriority.medium)

    # A PM is always assigned (the generation is gated on a technician), so the
    # WO/ticket are never claimable in My Work.
    tech_user_id = None
    if plan.assigned_technician_id:
        tech = await db.get(Technician, plan.assigned_technician_id)
        tech_user_id = tech.user_id if tech else None

    title = f"[PM] {plan.name}"
    if equipment:
        title = f"{title} – {equipment.name}"

    wo = WorkOrder(
        wo_number=await _next_wo_number(db),
        equipment_id=plan.equipment_id,
        plan_id=plan.id,
        occurrence_id=occurrence.id,
        executor_id=plan.assigned_technician_id,
        assigned_to_id=tech_user_id,
        type=WorkOrderType.preventive,
        priority=priority,
        status=WorkOrderStatus.open,
        title=title,
        description=plan.description,
        source=WorkOrderSource.pm,
        scheduled_date=occurrence.scheduled_date,
        estimated_hours=plan.estimated_hours,
    )
    db.add(wo)
    await db.flush()

    # Build the PM checklist on the WO from the linked template's tasks
    if plan.pm_template_id:
        tpl = await db.get(PmTemplate, plan.pm_template_id)
        if tpl and tpl.enforcement:
            wo.checklist_enforcement = tpl.enforcement
        tasks_result = await db.execute(
            select(PmTemplateTask)
            .where(PmTemplateTask.template_id == plan.pm_template_id)
            .order_by(PmTemplateTask.sort_order)
        )
        for task in tasks_result.scalars().all():
            db.add(WOAction(
                work_order_id=wo.id,
                action_type="checklist",
                description=task.description,
                expected_result=task.expected_result,
                template_task_id=task.id,
                is_required=task.is_required,
                sort_order=task.sort_order,
            ))

    occurrence.work_order_id = wo.id
    await db.flush()

    # Create a linked maintenance ticket via the tested ticket-creation path.
    # assigned_to_id → not claimable; machine_stopped=False → planned PM doesn't
    # flip the machine page to "waiting for mechanic"; force → skip the
    # duplicate-open-ticket guard.
    try:
        ticket = await TicketService(db).create_ticket(TicketCreate(
            machine_id=plan.equipment_id,
            priority=_safe_enum(AlertPriority, plan.priority, AlertPriority.medium),
            problem_type=AlertProblemType.preventive_request,
            description=f"Preventive maintenance — {plan.name} ({occurrence.scheduled_date.isoformat()})",
            assigned_to_id=tech_user_id,
            machine_stopped=False,
            force=True,
        ), created_by="PM")
        ticket.work_order_id = wo.id
        wo.ticket_id = ticket.id
        await db.commit()
    except Exception:
        # Ticket is best-effort — keep the (already-flushed) work order regardless.
        await db.commit()

    await db.refresh(wo)
    return wo


# ─── WO completion hook ──────────────────────────────────────────────────────────

async def on_work_order_completed(db: AsyncSession, wo: WorkOrder) -> Optional[WorkOrder]:
    """When a PM-generated work order is completed, close its occurrence,
    record compliance, and auto-generate the next occurrence + WO/ticket."""
    if not wo.occurrence_id:
        return None

    occurrence = await db.get(PlanOccurrence, wo.occurrence_id)
    if not occurrence:
        return None

    plan = await db.get(MaintenancePlan, occurrence.plan_id)
    if not plan:
        return None

    today = date.today()
    occurrence.actual_date = today
    occurrence.status = OccurrenceStatus.completed

    target_date = occurrence.override_date or occurrence.scheduled_date
    occurrence.days_late = max((today - target_date).days, 0)
    if today > target_date:
        occurrence.compliance = OccurrenceCompliance.late
    elif today < target_date:
        occurrence.compliance = OccurrenceCompliance.early
    else:
        occurrence.compliance = OccurrenceCompliance.on_time

    plan.last_executed_at = datetime.now(timezone.utc)

    next_occurrence = await create_next_occurrence(db, plan)
    new_wo = None
    # Only auto-generate the next WO if the plan still has an assigned technician.
    if next_occurrence and plan.assigned_technician_id:
        new_wo = await generate_wo_and_ticket(db, plan, next_occurrence)

    await db.commit()
    return new_wo


# ─── Overdue / reminder alerts ───────────────────────────────────────────────────

async def _plan_recipient(db: AsyncSession, plan: MaintenancePlan) -> Optional[User]:
    if not plan.assigned_technician_id:
        return None
    tech = await db.get(Technician, plan.assigned_technician_id)
    if not tech:
        return None
    return await db.get(User, tech.user_id)


async def check_overdue_occurrences(db: AsyncSession) -> int:
    """Mark past-due occurrences as overdue and notify the assigned technician."""
    today = date.today()
    result = await db.execute(
        select(PlanOccurrence).where(
            PlanOccurrence.scheduled_date < today,
            PlanOccurrence.is_cancelled == False,
            PlanOccurrence.status.in_([OccurrenceStatus.scheduled, OccurrenceStatus.in_progress]),
        )
    )
    occurrences = result.scalars().all()
    notifier = NotificationService(db)
    notified = 0

    from app.services.notification_service import get_escalation_settings
    esc = await get_escalation_settings(db)

    for occ in occurrences:
        target_date = occ.override_date or occ.scheduled_date
        occ.days_late = max((today - target_date).days, 0)
        if occ.overdue_alert_sent or not esc.notify_on_pm_overdue:
            continue

        plan = await db.get(MaintenancePlan, occ.plan_id)
        equipment = await db.get(Equipment, occ.equipment_id) if occ.equipment_id else None
        message = (
            f"PM OVERDUE: {plan.name if plan else 'Plan'} "
            f"({equipment.name if equipment else 'Equipment'}) — "
            f"due {occ.scheduled_date.isoformat()}, {occ.days_late} day(s) late."
        )

        recipient = await _plan_recipient(db, plan) if plan else None
        if recipient:
            if recipient.phone:
                await notifier.send_sms(
                    recipient=recipient.phone,
                    message=message,
                    recipient_role="technician",
                    recipient_name=recipient.name,
                )
            await notifier.send_email(
                recipient=recipient.email,
                subject="PM Overdue",
                body=message,
                recipient_role="technician",
                recipient_name=recipient.name,
            )

        occ.overdue_alert_sent = True
        notified += 1

    await db.commit()
    return notified


async def check_upcoming_reminders(db: AsyncSession) -> int:
    """Send reminders for occurrences within their plan's lead time, not yet reminded."""
    today = date.today()
    result = await db.execute(
        select(PlanOccurrence, MaintenancePlan)
        .join(MaintenancePlan, PlanOccurrence.plan_id == MaintenancePlan.id)
        .where(
            PlanOccurrence.is_cancelled == False,
            PlanOccurrence.status == OccurrenceStatus.scheduled,
            PlanOccurrence.reminder_sent == False,
            PlanOccurrence.scheduled_date >= today,
        )
    )
    notifier = NotificationService(db)
    notified = 0

    for occ, plan in result.all():
        lead_days = plan.lead_time_days or 0
        if (occ.scheduled_date - today).days > lead_days:
            continue

        equipment = await db.get(Equipment, occ.equipment_id) if occ.equipment_id else None
        message = (
            f"PM REMINDER: {plan.name} "
            f"({equipment.name if equipment else 'Equipment'}) — "
            f"scheduled {occ.scheduled_date.isoformat()}."
        )

        recipient = await _plan_recipient(db, plan)
        if recipient:
            if recipient.phone:
                await notifier.send_sms(
                    recipient=recipient.phone,
                    message=message,
                    recipient_role="technician",
                    recipient_name=recipient.name,
                )
            await notifier.send_email(
                recipient=recipient.email,
                subject="PM Reminder",
                body=message,
                recipient_role="technician",
                recipient_name=recipient.name,
            )

        occ.reminder_sent = True
        notified += 1

    await db.commit()
    return notified
