from datetime import datetime, timezone
from typing import Optional
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_

from app.models.models import (
    MaintenanceTicket, TicketComment, TicketStatus, Machine,
    WorkOrder, WorkOrderType, WorkOrderStatus, WorkOrderPriority, WorkOrderSource,
    Equipment, Technician, User, LaborRecord, MachineIntervention,
    MaintenanceAlert, AlertStatus, AlertProblemType, AlertPriority,
)
from app.schemas.maintenance import TicketCreate, TicketClose, CommentCreate

_TICKET_TO_ALERT_STATUS: dict = {
    TicketStatus.open:           AlertStatus.assigned,
    TicketStatus.in_progress:    AlertStatus.in_progress,
    TicketStatus.on_hold_parts:  AlertStatus.in_progress,
    TicketStatus.on_hold_ext:    AlertStatus.in_progress,
    TicketStatus.completed:      AlertStatus.resolved,
    TicketStatus.cancelled:      AlertStatus.cancelled,
}

_BACKFILL_STATUS_MAP: dict = {
    TicketStatus.open:           AlertStatus.new_alert,
    TicketStatus.in_progress:    AlertStatus.in_progress,
    TicketStatus.on_hold_parts:  AlertStatus.in_progress,
    TicketStatus.on_hold_ext:    AlertStatus.in_progress,
    TicketStatus.completed:      AlertStatus.resolved,
    TicketStatus.cancelled:      AlertStatus.cancelled,
}


_OPEN_TICKET_STATUSES = (TicketStatus.completed, TicketStatus.cancelled)
_ACTIVE_INTERVENTION_STATUSES = ("waiting", "in_progress")


def _estimated_hours_from_downtime(ticket: MaintenanceTicket) -> Optional[float]:
    """Default labor estimate for a ticket-born WO: the ticket's estimated
    machine downtime converted to hours. Downtime ≠ labor, so this is only a
    fallback for when the assigner didn't type an estimate."""
    mins = ticket.estimated_downtime_minutes
    return round(mins / 60, 2) if mins else None


class DuplicateTicketError(Exception):
    """An open ticket already exists for the machine and the caller did not
    explicitly confirm creating a second one (``force``). Carries the existing
    ticket details so the API can return them for the confirmation prompt."""

    def __init__(self, existing: dict):
        self.existing = existing
        super().__init__("An open ticket already exists for this machine")


async def _open_ticket_for_machine(db: AsyncSession, machine_id) -> Optional[MaintenanceTicket]:
    """Most recent ticket for the machine that is neither completed nor cancelled."""
    r = await db.execute(
        select(MaintenanceTicket)
        .where(
            MaintenanceTicket.machine_id == machine_id,
            MaintenanceTicket.status.notin_(_OPEN_TICKET_STATUSES),
        )
        .order_by(MaintenanceTicket.opened_at.desc())
        .limit(1)
    )
    return r.scalar_one_or_none()


async def _has_active_intervention(db: AsyncSession, machine_id) -> bool:
    r = await db.execute(
        select(MachineIntervention.id)
        .where(
            MachineIntervention.machine_id == machine_id,
            MachineIntervention.status.in_(_ACTIVE_INTERVENTION_STATUSES),
        )
        .limit(1)
    )
    return r.scalar_one_or_none() is not None


async def _next_alert_number(db: AsyncSession, plant_id=None) -> str:
    from app.services.numbering import next_number, series_prefix
    year = datetime.now(timezone.utc).year
    sp = await series_prefix(db, plant_id)
    return await next_number(db, MaintenanceAlert.alert_number, f"{sp}ALT-{year}")


async def _close_linked_wo(ticket: MaintenanceTicket, db: AsyncSession) -> None:
    """Ticket finished → finish its linked WO too, so the Labor Scheduler and
    My Work never show stale in-progress work. No-op when the WO is already
    closed (which is the case when the completion came from the WO itself)."""
    if not ticket.work_order_id:
        return
    wo = await db.get(WorkOrder, ticket.work_order_id)
    if not wo or wo.status in (WorkOrderStatus.completed, WorkOrderStatus.cancelled):
        return

    now = datetime.now(timezone.utc)
    if ticket.status == TicketStatus.cancelled:
        wo.status = WorkOrderStatus.cancelled
    else:
        wo.status = WorkOrderStatus.completed
        if not wo.completed_at:
            wo.completed_at = ticket.completed_at or now

    # Stamp any in-flight labor records: hours_worked stays raw (feeds
    # repair_hours/MTTR); labor_cost is recomputed from effective working time.
    from app.services import labor_time_service
    r = await db.execute(
        select(LaborRecord).where(
            LaborRecord.work_order_id == wo.id,
            LaborRecord.stopped_at.is_(None),
        )
    )
    for rec in r.scalars().all():
        rec.stopped_at = now
        if rec.started_at:
            started = rec.started_at if rec.started_at.tzinfo else rec.started_at.replace(tzinfo=timezone.utc)
            rec.hours_worked = round((now - started).total_seconds() / 3600, 4)
        await labor_time_service.apply_to_record(db, rec, work_order=wo)

    # Repair time fallback from the WO's own start
    if wo.status == WorkOrderStatus.completed and not wo.repair_hours and wo.started_at:
        started = wo.started_at if wo.started_at.tzinfo else wo.started_at.replace(tzinfo=timezone.utc)
        end = wo.completed_at if wo.completed_at.tzinfo else wo.completed_at.replace(tzinfo=timezone.utc)
        minutes = int((end - started).total_seconds() / 60)
        if minutes > 0:
            wo.total_minutes = minutes
            wo.repair_hours = round(minutes / 60.0, 4)

    # Close the machine's active intervention as well
    from app.services.intervention_sync import on_wo_finished
    await on_wo_finished(db, wo)


async def sync_alert_from_ticket(ticket: MaintenanceTicket, db: AsyncSession) -> None:
    """Sync linked alert status whenever ticket status changes."""
    # Lifecycle notification — every completion path goes through here.
    # notify_ticket_completed dedupes via the notification log, so repeated
    # sync calls never double-send.
    if ticket.status == TicketStatus.completed:
        from app.services.notification_service import NotificationService
        machine = await db.get(Machine, ticket.machine_id)
        await NotificationService(db).notify_ticket_completed(
            ticket, machine.name if machine else None
        )

    # Ticket → WO sync (the WO → ticket direction lives in work_orders.py)
    if ticket.status in (TicketStatus.completed, TicketStatus.cancelled):
        await _close_linked_wo(ticket, db)

    if not ticket.alert_id:
        return
    alert = await db.get(MaintenanceAlert, ticket.alert_id)
    if not alert:
        return
    new_status = _TICKET_TO_ALERT_STATUS.get(ticket.status)
    if new_status and alert.status != new_status:
        alert.status = new_status


async def _next_ticket_number(db: AsyncSession, plant_id=None) -> str:
    from app.services.numbering import next_number, series_prefix
    year = datetime.now(timezone.utc).year
    sp = await series_prefix(db, plant_id)
    return await next_number(db, MaintenanceTicket.ticket_number, f"{sp}TKT-{year}")


class TicketService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_ticket(self, data: TicketCreate, created_by: str = "", notify: bool = True) -> MaintenanceTicket:
        """`notify=False` skips the creation notifications (critical + ticket-opened
        + claimable pings) — for callers that page people through their own channel,
        e.g. the Sushi condition-alert SMS, so one event never double-pages."""
        machine = await self.db.get(Machine, data.machine_id)
        if not machine:
            # The ticket form sends an *equipment* id. A Machine usually already
            # exists for it (auto-synced with its own PK + equipment_id link), so
            # look it up by equipment_id or code before creating — otherwise the
            # insert collides on the unique machines.code constraint.
            equipment = await self.db.get(Equipment, data.machine_id)
            if not equipment:
                raise ValueError("Machine not found")
            machine = (
                await self.db.execute(
                    select(Machine).where(
                        or_(
                            Machine.equipment_id == equipment.id,
                            Machine.code == equipment.code,
                        )
                    )
                )
            ).scalars().first()
            if machine:
                # Point the ticket at the real machine row
                data.machine_id = machine.id
            else:
                machine = Machine(
                    id=equipment.id,
                    name=equipment.name,
                    code=equipment.code,
                    equipment_id=equipment.id,
                    # Without the plant the ticket/alert would be born with
                    # plant_id NULL — hidden by the fail-closed plant scoping.
                    plant_id=equipment.plant_id,
                    is_active=True,
                )
                self.db.add(machine)
                await self.db.flush()

        # ── Duplicate guard ─────────────────────────────────────────────────────
        # If an open ticket already exists for this machine, warn instead of
        # silently creating a second one. The caller resends with force=True to
        # confirm. Prevents the "two tickets for the same machine" regression.
        if not getattr(data, "force", False):
            existing = await _open_ticket_for_machine(self.db, data.machine_id)
            if existing:
                opened = existing.opened_at
                if opened and opened.tzinfo is None:
                    opened = opened.replace(tzinfo=timezone.utc)
                minutes_ago = (
                    int((datetime.now(timezone.utc) - opened).total_seconds() / 60)
                    if opened else None
                )
                raise DuplicateTicketError({
                    "code":          "duplicate_open_ticket",
                    "ticket_id":     str(existing.id),
                    "ticket_number": existing.ticket_number,
                    "status":        existing.status.value if hasattr(existing.status, "value") else str(existing.status),
                    "minutes_ago":   minutes_ago,
                })

        alert_id = data.alert_id
        new_alert = None
        if not alert_id:
            new_alert = MaintenanceAlert(
                alert_number=await _next_alert_number(self.db, machine.plant_id),
                machine_id=data.machine_id,
                plant_id=machine.plant_id,
                department=machine.department,
                problem_type=data.problem_type or AlertProblemType.other,
                priority=data.priority,
                description=data.description,
                created_by=created_by,
                status=AlertStatus.new_alert,
            )
            self.db.add(new_alert)
            await self.db.flush()
            alert_id = new_alert.id

        ticket = MaintenanceTicket(
            ticket_number=await _next_ticket_number(self.db, machine.plant_id),
            alert_id=alert_id,
            machine_id=data.machine_id,
            plant_id=machine.plant_id,   # ticket belongs to its machine's plant
            priority=data.priority,
            assigned_to_id=data.assigned_to_id,
            estimated_downtime_minutes=data.estimated_downtime_minutes,
            problem_type=getattr(data, "problem_type", None),
            description=getattr(data, "description", None),
            machine_page_source=getattr(data, "machine_page_source", False),
        )
        self.db.add(ticket)
        await self.db.flush()

        if new_alert is not None:
            new_alert.ticket_id = ticket.id

        # ── Machine stopped → reflect on the machine/kiosk page ──────────────────
        # Create a "waiting" intervention so the machine page switches to
        # "En attente de mécanicien". Skipped for planned maintenance
        # (machine_stopped=False) and when an active intervention already exists.
        if getattr(data, "machine_stopped", True):
            if not await _has_active_intervention(self.db, data.machine_id):
                self.db.add(MachineIntervention(
                    machine_id=data.machine_id,
                    plant_id=machine.plant_id,
                    equipment_id=machine.equipment_id,
                    ticket_id=ticket.id,
                    status="waiting",
                    operator_note=getattr(data, "description", None),
                ))
                await self.db.flush()

        if notify:
            from app.services.notification_service import NotificationService
            notif = NotificationService(self.db)
            if data.priority == AlertPriority.critical:
                await notif.notify_new_critical(
                    ref_number=ticket.ticket_number,
                    description=getattr(data, "description", None),
                    machine_name=machine.name,
                    alert_id=alert_id,
                    ticket_id=ticket.id,
                    machine=machine,
                )
            await notif.notify_ticket_opened(ticket, machine.name)

        await self.db.commit()
        await self.db.refresh(ticket)
        return ticket

    async def close_ticket(self, ticket_id: UUID, data: TicketClose) -> MaintenanceTicket:
        ticket = await self.db.get(MaintenanceTicket, ticket_id)
        if not ticket:
            raise ValueError("Ticket not found")
        ticket.status                     = TicketStatus.completed
        ticket.diagnosis                  = data.diagnosis
        ticket.corrective_action          = data.corrective_action
        ticket.total_intervention_minutes = data.total_intervention_minutes
        ticket.completed_at               = datetime.now(timezone.utc)
        if data.parts_used is not None:
            ticket.parts_used = data.parts_used
        if data.estimated_downtime_minutes is not None:
            ticket.estimated_downtime_minutes = data.estimated_downtime_minutes
        await sync_alert_from_ticket(ticket, self.db)

        from app.services.intervention_sync import on_ticket_closed
        await on_ticket_closed(self.db, ticket)

        await self.db.commit()
        await self.db.refresh(ticket)
        return ticket

    async def add_comment(self, ticket_id: UUID, data: CommentCreate) -> TicketComment:
        if not await self.db.get(MaintenanceTicket, ticket_id):
            raise ValueError("Ticket not found")
        comment = TicketComment(
            ticket_id=ticket_id,
            author=data.author,
            comment=data.comment,
        )
        self.db.add(comment)
        await self.db.commit()
        await self.db.refresh(comment)
        return comment

    async def generate_work_order(
        self, ticket_id: UUID, created_by_id: UUID
    ) -> tuple[MaintenanceTicket, WorkOrder]:
        ticket = await self.db.get(MaintenanceTicket, ticket_id)
        if not ticket:
            raise ValueError("Ticket not found")
        if ticket.work_order_id:
            raise ValueError("Ticket already has a linked work order")

        machine = await self.db.get(Machine, ticket.machine_id)
        machine_name = machine.name if machine else "Unknown Machine"

        # Find equipment: match by name, then location, then any active
        equip = None
        if machine:
            r = await self.db.execute(
                select(Equipment)
                .where(Equipment.name.ilike(f"%{machine.name}%"), Equipment.active == True)
                .limit(1)
            )
            equip = r.scalar_one_or_none()
        if not equip and machine and machine.location:
            r = await self.db.execute(
                select(Equipment)
                .where(Equipment.location.ilike(f"%{machine.location}%"), Equipment.active == True)
                .limit(1)
            )
            equip = r.scalar_one_or_none()
        if not equip:
            r = await self.db.execute(
                select(Equipment).where(Equipment.active == True).limit(1)
            )
            equip = r.scalar_one_or_none()
        if not equip:
            raise ValueError("No active equipment found to link work order")

        from app.services.numbering import next_number
        year = datetime.now(timezone.utc).year
        wo_number = await next_number(self.db, WorkOrder.wo_number, f"WO-{year}")

        priority_map = {
            "critical": WorkOrderPriority.critical,
            "high":     WorkOrderPriority.high,
            "medium":   WorkOrderPriority.medium,
            "low":      WorkOrderPriority.low,
        }
        pval = ticket.priority.value if hasattr(ticket.priority, "value") else str(ticket.priority)
        tval = ticket.problem_type.value if ticket.problem_type else "Maintenance"

        wo = WorkOrder(
            wo_number=wo_number,
            equipment_id=equip.id,
            plant_id=ticket.plant_id if ticket.plant_id else equip.plant_id,
            machine_id=ticket.machine_id,
            created_by_id=created_by_id,
            type=WorkOrderType.corrective,
            priority=priority_map.get(pval, WorkOrderPriority.medium),
            status=WorkOrderStatus.open,
            title=f"[{ticket.ticket_number}] {machine_name} – {tval.replace('_', ' ').title()}",
            description=ticket.diagnosis,
            ticket_id=ticket.id,
            source=WorkOrderSource.ticket,
            estimated_hours=_estimated_hours_from_downtime(ticket),
        )
        self.db.add(wo)
        await self.db.flush()

        ticket.work_order_id = wo.id
        ticket.status = TicketStatus.in_progress

        await sync_alert_from_ticket(ticket, self.db)
        await self.db.commit()
        await self.db.refresh(ticket)
        await self.db.refresh(wo)
        return ticket, wo

    async def assign_ticket(
        self,
        ticket_id: UUID,
        technician_id: UUID,
        assigned_by_id: UUID,
        estimated_hours: Optional[float] = None,
    ) -> tuple[MaintenanceTicket, WorkOrder]:
        """Assign a technician to a ticket and auto-create a linked work order.
        ``estimated_hours`` overrides the WO labor estimate; when omitted it
        defaults to the ticket's estimated downtime converted to hours."""
        ticket = await self.db.get(MaintenanceTicket, ticket_id)
        if not ticket:
            raise ValueError("Ticket not found")

        tech = await self.db.get(Technician, technician_id)
        if not tech:
            raise ValueError("Technician not found")
        user = await self.db.get(User, tech.user_id)
        if not user:
            raise ValueError("Technician user not found")

        machine = await self.db.get(Machine, ticket.machine_id)
        machine_name = machine.name if machine else "Unknown Machine"

        # Find equipment to satisfy non-null FK on work_orders
        equip = None
        if machine:
            r = await self.db.execute(
                select(Equipment)
                .where(Equipment.name.ilike(f"%{machine.name}%"), Equipment.active == True)
                .limit(1)
            )
            equip = r.scalar_one_or_none()
        if not equip and machine and machine.location:
            r = await self.db.execute(
                select(Equipment)
                .where(Equipment.location.ilike(f"%{machine.location}%"), Equipment.active == True)
                .limit(1)
            )
            equip = r.scalar_one_or_none()
        if not equip:
            r = await self.db.execute(
                select(Equipment).where(Equipment.active == True).limit(1)
            )
            equip = r.scalar_one_or_none()
        if not equip:
            raise ValueError("No active equipment found to link work order")

        from app.services.numbering import next_number
        year = datetime.now(timezone.utc).year
        wo_number = await next_number(self.db, WorkOrder.wo_number, f"WO-{year}")

        priority_map = {
            "critical": WorkOrderPriority.critical,
            "high":     WorkOrderPriority.high,
            "medium":   WorkOrderPriority.medium,
            "low":      WorkOrderPriority.low,
        }
        pval = ticket.priority.value if hasattr(ticket.priority, "value") else str(ticket.priority)
        tval = ticket.problem_type.value if ticket.problem_type else "Maintenance"

        wo = WorkOrder(
            wo_number=wo_number,
            equipment_id=equip.id,
            plant_id=ticket.plant_id if ticket.plant_id else equip.plant_id,
            machine_id=ticket.machine_id,
            created_by_id=assigned_by_id,
            assigned_to_id=tech.user_id,
            executor_id=tech.id,
            type=WorkOrderType.corrective,
            priority=priority_map.get(pval, WorkOrderPriority.medium),
            status=WorkOrderStatus.open,
            title=f"[{ticket.ticket_number}] {machine_name} – {tval.replace('_', ' ').title()}",
            description=ticket.description or ticket.diagnosis,
            ticket_id=ticket.id,
            source=WorkOrderSource.ticket,
            estimated_downtime_minutes=ticket.estimated_downtime_minutes,
            estimated_hours=(
                estimated_hours if estimated_hours is not None
                else _estimated_hours_from_downtime(ticket)
            ),
        )
        self.db.add(wo)
        await self.db.flush()

        ticket.work_order_id = wo.id
        ticket.assigned_to_id = tech.user_id
        ticket.status = TicketStatus.in_progress
        if not ticket.started_at:
            ticket.started_at = datetime.now(timezone.utc)

        await sync_alert_from_ticket(ticket, self.db)

        from app.services.notification_service import NotificationService
        await NotificationService(self.db).notify_ticket_assigned(ticket, user, machine_name)

        await self.db.commit()
        await self.db.refresh(ticket)
        await self.db.refresh(wo)
        return ticket, wo

    def open_minutes(self, ticket: MaintenanceTicket) -> int:
        now    = datetime.now(timezone.utc)
        opened = ticket.opened_at
        if opened.tzinfo is None:
            opened = opened.replace(tzinfo=timezone.utc)
        return int((now - opened).total_seconds() / 60)

    def intervention_minutes(self, ticket: MaintenanceTicket) -> int:
        if not ticket.started_at:
            return 0
        end     = ticket.completed_at or datetime.now(timezone.utc)
        started = ticket.started_at
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        return int((end - started).total_seconds() / 60)


async def backfill_missing_alerts(db: AsyncSession) -> int:
    """Create a MaintenanceAlert for every ticket that has no linked alert. Returns count created."""
    r = await db.execute(
        select(MaintenanceTicket).where(MaintenanceTicket.alert_id == None)
    )
    tickets = r.scalars().all()
    created = 0
    for ticket in tickets:
        machine = await db.get(Machine, ticket.machine_id)
        alert_status = _BACKFILL_STATUS_MAP.get(ticket.status, AlertStatus.new_alert)
        alert = MaintenanceAlert(
            alert_number=await _next_alert_number(db, ticket.plant_id),
            machine_id=ticket.machine_id,
            plant_id=ticket.plant_id if ticket.plant_id else (machine.plant_id if machine else None),
            ticket_id=ticket.id,
            department=machine.department if machine else None,
            problem_type=ticket.problem_type or AlertProblemType.other,
            priority=ticket.priority,
            description=ticket.description,
            created_by="",
            status=alert_status,
        )
        db.add(alert)
        await db.flush()
        ticket.alert_id = alert.id
        created += 1
    if created:
        await db.commit()
    return created
