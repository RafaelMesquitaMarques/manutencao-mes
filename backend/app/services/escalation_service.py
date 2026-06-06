"""
Escalation service — checks open alerts against SLA thresholds and escalates.
Called every 60 seconds by the background task in main.py.
"""
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.models import MaintenanceAlert, AlertStatus, AlertPriority
from app.services.notification_service import NotificationService

SLA_MINUTES: dict[str, int] = {
    AlertPriority.critical: 10,
    AlertPriority.high:     30,
    AlertPriority.medium:   120,
    AlertPriority.low:      480,
}

MAX_ESCALATION_LEVEL = 3

OPEN_STATUSES = [AlertStatus.new_alert, AlertStatus.assigned, AlertStatus.in_progress]


class EscalationService:
    def __init__(self, db: AsyncSession):
        self.db    = db
        self.notif = NotificationService(db)

    def get_sla_minutes(self, priority: str) -> int:
        return SLA_MINUTES.get(priority, 120)

    async def check_overdue_alerts(self) -> None:
        now = datetime.now(timezone.utc)

        result = await self.db.execute(
            select(MaintenanceAlert).where(MaintenanceAlert.status.in_(OPEN_STATUSES))
        )
        alerts = result.scalars().all()

        for alert in alerts:
            sla = self.get_sla_minutes(alert.priority)
            created = alert.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)

            elapsed_minutes = (now - created).total_seconds() / 60.0
            if elapsed_minutes < sla:
                continue

            alert.is_overdue = True

            next_level = alert.escalation_level + 1
            if next_level > MAX_ESCALATION_LEVEL:
                continue

            # Only escalate again after another SLA interval
            if alert.escalated_at:
                last = alert.escalated_at
                if last.tzinfo is None:
                    last = last.replace(tzinfo=timezone.utc)
                if (now - last).total_seconds() / 60.0 < sla:
                    continue

            alert.escalation_level = next_level
            alert.escalated_at     = now
            await self.notif.send_escalation(next_level, alert)

        await self.db.commit()
