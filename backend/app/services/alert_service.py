from datetime import datetime, timezone
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.models.models import MaintenanceAlert, MaintenanceTicket, AlertStatus, Machine
from app.schemas.maintenance import AlertCreate


async def _next_alert_number(db: AsyncSession) -> str:
    year = datetime.now(timezone.utc).year
    r = await db.execute(
        select(func.count(MaintenanceAlert.id)).where(
            func.extract("year", MaintenanceAlert.created_at) == year
        )
    )
    return f"ALT-{year}-{(r.scalar() + 1):05d}"


class AlertService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_alert(self, data: AlertCreate) -> MaintenanceAlert:
        machine = await self.db.get(Machine, data.machine_id)
        if not machine:
            raise ValueError("Machine not found")

        alert = MaintenanceAlert(
            alert_number=await _next_alert_number(self.db),
            machine_id=data.machine_id,
            department=data.department or machine.department,
            problem_type=data.problem_type,
            priority=data.priority,
            description=data.description,
            created_by=data.created_by,
            shift=data.shift,
        )
        self.db.add(alert)
        await self.db.commit()
        await self.db.refresh(alert)
        return alert

    async def get_alerts(
        self,
        machine_id=None,
        priority=None,
        status=None,
        assigned_to_id=None,
        department=None,
        overdue_only=False,
    ):
        q = select(MaintenanceAlert)
        if machine_id:
            q = q.where(MaintenanceAlert.machine_id == machine_id)
        if priority:
            q = q.where(MaintenanceAlert.priority == priority)
        if status:
            q = q.where(MaintenanceAlert.status == status)
        if assigned_to_id:
            q = q.where(MaintenanceAlert.assigned_to_id == assigned_to_id)
        if department:
            q = q.where(MaintenanceAlert.department == department)
        if overdue_only:
            q = q.where(MaintenanceAlert.is_overdue == True)
        q = q.order_by(MaintenanceAlert.created_at.desc())
        result = await self.db.execute(q)
        return result.scalars().all()

    async def assign_alert(self, alert_id: UUID, user_id: UUID) -> MaintenanceAlert:
        alert = await self.db.get(MaintenanceAlert, alert_id)
        if not alert:
            raise ValueError("Alert not found")
        alert.assigned_to_id = user_id
        alert.status         = AlertStatus.assigned
        await self.db.commit()
        await self.db.refresh(alert)
        return alert

    async def convert_to_ticket(self, alert_id: UUID, user_id: UUID) -> MaintenanceTicket:
        from app.services.ticket_service import TicketService
        from app.schemas.maintenance import TicketCreate

        alert = await self.db.get(MaintenanceAlert, alert_id)
        if not alert:
            raise ValueError("Alert not found")

        # Check for existing ticket
        r = await self.db.execute(
            select(MaintenanceTicket).where(MaintenanceTicket.alert_id == alert_id)
        )
        if r.scalar_one_or_none():
            raise ValueError("Alert already converted to a ticket")

        ticket_svc = TicketService(self.db)
        ticket = await ticket_svc.create_ticket(TicketCreate(
            alert_id=alert.id,
            machine_id=alert.machine_id,
            priority=alert.priority,
            assigned_to_id=user_id,
        ))
        alert.status = AlertStatus.in_progress
        await self.db.commit()
        return ticket
