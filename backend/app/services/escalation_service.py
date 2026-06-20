"""
Escalation service — checks open alerts against SLA thresholds and escalates.
Called every 60 seconds by the background task in main.py.
SLA minutes, max level and channels come from escalation_settings
(Settings → Escalation in the UI).
"""
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.models import MaintenanceAlert, AlertStatus, AlertPriority
from app.services.notification_service import NotificationService, get_escalation_settings

OPEN_STATUSES = [AlertStatus.new_alert, AlertStatus.assigned, AlertStatus.in_progress]


class EscalationService:
    def __init__(self, db: AsyncSession):
        self.db    = db
        self.notif = NotificationService(db)

    @staticmethod
    def _sla_map(esc) -> dict:
        return {
            AlertPriority.critical: esc.sla_critical_minutes or 10,
            AlertPriority.high:     esc.sla_high_minutes or 30,
            AlertPriority.medium:   esc.sla_medium_minutes or 120,
            AlertPriority.low:      esc.sla_low_minutes or 480,
        }

    async def check_overdue_alerts(self) -> None:
        now = datetime.now(timezone.utc)
        esc = await get_escalation_settings(self.db)
        sla_map = self._sla_map(esc)
        max_level = esc.max_escalation_level or 3

        result = await self.db.execute(
            select(MaintenanceAlert).where(MaintenanceAlert.status.in_(OPEN_STATUSES))
        )
        alerts = result.scalars().all()

        for alert in alerts:
            sla = sla_map.get(alert.priority, 120)
            created = alert.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)

            elapsed_minutes = (now - created).total_seconds() / 60.0
            if elapsed_minutes < sla:
                continue

            alert.is_overdue = True

            next_level = alert.escalation_level + 1
            if next_level > max_level:
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
