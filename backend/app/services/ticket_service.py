from datetime import datetime, timezone
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.models.models import (
    MaintenanceTicket, TicketComment, TicketStatus, Machine,
    WorkOrder, WorkOrderType, WorkOrderStatus, WorkOrderPriority, WorkOrderSource,
    Equipment, Technician, User,
    MaintenanceAlert, AlertStatus, AlertProblemType,
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


async def _next_alert_number(db: AsyncSession) -> str:
    year = datetime.now(timezone.utc).year
    r = await db.execute(
        select(func.count(MaintenanceAlert.id)).where(
            func.extract("year", MaintenanceAlert.created_at) == year
        )
    )
    return f"ALT-{year}-{(r.scalar() + 1):05d}"


async def sync_alert_from_ticket(ticket: MaintenanceTicket, db: AsyncSession) -> None:
    """Sync linked alert status whenever ticket status changes."""
    if not ticket.alert_id:
        return
    alert = await db.get(MaintenanceAlert, ticket.alert_id)
    if not alert:
        return
    new_status = _TICKET_TO_ALERT_STATUS.get(ticket.status)
    if new_status and alert.status != new_status:
        alert.status = new_status


async def _next_ticket_number(db: AsyncSession) -> str:
    year = datetime.now(timezone.utc).year
    r = await db.execute(
        select(func.count(MaintenanceTicket.id)).where(
            func.extract("year", MaintenanceTicket.opened_at) == year
        )
    )
    return f"TKT-{year}-{(r.scalar() + 1):05d}"


class TicketService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_ticket(self, data: TicketCreate, created_by: str = "") -> MaintenanceTicket:
        machine = await self.db.get(Machine, data.machine_id)
        if not machine:
            raise ValueError("Machine not found")

        alert_id = data.alert_id
        new_alert = None
        if not alert_id:
            new_alert = MaintenanceAlert(
                alert_number=await _next_alert_number(self.db),
                machine_id=data.machine_id,
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
            ticket_number=await _next_ticket_number(self.db),
            alert_id=alert_id,
            machine_id=data.machine_id,
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

        year = datetime.now(timezone.utc).year
        r = await self.db.execute(
            select(func.count(WorkOrder.id)).where(
                func.extract("year", WorkOrder.opened_at) == year
            )
        )
        wo_number = f"WO-{year}-{(r.scalar() + 1):05d}"

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
            created_by_id=created_by_id,
            type=WorkOrderType.corrective,
            priority=priority_map.get(pval, WorkOrderPriority.medium),
            status=WorkOrderStatus.open,
            title=f"[{ticket.ticket_number}] {machine_name} – {tval.replace('_', ' ').title()}",
            description=ticket.diagnosis,
            ticket_id=ticket.id,
            source=WorkOrderSource.ticket,
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
    ) -> tuple[MaintenanceTicket, WorkOrder]:
        """Assign a technician to a ticket and auto-create a linked work order."""
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

        year = datetime.now(timezone.utc).year
        r = await self.db.execute(
            select(func.count(WorkOrder.id)).where(
                func.extract("year", WorkOrder.opened_at) == year
            )
        )
        wo_number = f"WO-{year}-{(r.scalar() + 1):05d}"

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
        )
        self.db.add(wo)
        await self.db.flush()

        ticket.work_order_id = wo.id
        ticket.assigned_to_id = tech.user_id
        ticket.status = TicketStatus.in_progress
        if not ticket.started_at:
            ticket.started_at = datetime.now(timezone.utc)

        await sync_alert_from_ticket(ticket, self.db)
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
            alert_number=await _next_alert_number(db),
            machine_id=ticket.machine_id,
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
