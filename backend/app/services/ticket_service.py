from datetime import datetime, timezone
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.models.models import (
    MaintenanceTicket, TicketComment, TicketStatus, Machine,
    WorkOrder, WorkOrderType, WorkOrderStatus, WorkOrderPriority, WorkOrderSource,
    Equipment,
)
from app.schemas.maintenance import TicketCreate, TicketClose, CommentCreate


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

    async def create_ticket(self, data: TicketCreate) -> MaintenanceTicket:
        machine = await self.db.get(Machine, data.machine_id)
        if not machine:
            raise ValueError("Machine not found")

        ticket = MaintenanceTicket(
            ticket_number=await _next_ticket_number(self.db),
            alert_id=data.alert_id,
            machine_id=data.machine_id,
            priority=data.priority,
            assigned_to_id=data.assigned_to_id,
            estimated_downtime_minutes=data.estimated_downtime_minutes,
        )
        self.db.add(ticket)
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
        tval = ticket.problem_type.value if hasattr(ticket.problem_type, "value") else str(ticket.problem_type)

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
        ticket.status = TicketStatus.assigned

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
