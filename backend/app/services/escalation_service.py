"""
Escalation service — checks open alerts against SLA thresholds and escalates.
Called every 60 seconds by the background task in main.py.
SLA minutes, max level, reminders, ack and channels come from
escalation_settings (Settings → Escalation in the UI).

Lifecycle per alert:
  - past SLA → escalate one level every SLA interval, up to max level;
  - between escalations (or at max level), re-notify the current level every
    reminder_minutes (0 = off);
  - alerts on a machine with an open *planned* stop are left alone.
"""
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.models import (
    AlertPriority, AlertStatus, MachineStop, MaintenanceAlert,
    StopCategory, StopCategoryType,
)
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

    async def _machines_in_planned_stop(self) -> set:
        rows = (await self.db.execute(
            select(MachineStop.machine_id)
            .join(StopCategory, MachineStop.stop_category_id == StopCategory.id)
            .where(
                MachineStop.ended_at.is_(None),
                StopCategory.type == StopCategoryType.planned,
            )
        )).scalars().all()
        return set(rows)

    async def check_overdue_alerts(self) -> None:
        now = datetime.now(timezone.utc)
        # SLA thresholds/toggles resolve per PLANT (own row, else the shared
        # legacy row) — cached per plant within one sweep of the loop.
        esc_cache: dict = {}

        async def _esc_for(plant_id):
            if plant_id not in esc_cache:
                esc_cache[plant_id] = await get_escalation_settings(self.db, plant_id)
            return esc_cache[plant_id]

        paused_machines = await self._machines_in_planned_stop()

        result = await self.db.execute(
            select(MaintenanceAlert).where(MaintenanceAlert.status.in_(OPEN_STATUSES))
        )
        alerts = result.scalars().all()

        def _minutes_since(dt) -> float:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return (now - dt).total_seconds() / 60.0

        for alert in alerts:
            esc = await _esc_for(alert.plant_id)
            sla_map = self._sla_map(esc)
            max_level = esc.max_escalation_level or 3
            reminder_min = esc.reminder_minutes or 0
            pause_planned = esc.pause_during_planned_stop is None or esc.pause_during_planned_stop
            sla = sla_map.get(alert.priority, 120)
            if _minutes_since(alert.created_at) < sla:
                continue

            alert.is_overdue = True

            if pause_planned and alert.machine_id in paused_machines:
                continue                      # planned downtime — don't wake anyone

            # Escalate one level after each SLA interval, up to the max level
            next_level = alert.escalation_level + 1
            due_for_next = (
                alert.escalated_at is None or _minutes_since(alert.escalated_at) >= sla
            )
            if next_level <= max_level and due_for_next:
                alert.escalation_level = next_level
                alert.escalated_at     = now
                alert.last_notified_at = now
                await self.notif.send_escalation(next_level, alert)
                continue

            # Between escalations / at max level: re-notify the current level
            if reminder_min > 0 and alert.escalation_level >= 1:
                last = alert.last_notified_at or alert.escalated_at
                if last is None or _minutes_since(last) >= reminder_min:
                    alert.last_notified_at = now
                    await self.notif.send_escalation(
                        alert.escalation_level, alert, reminder=True,
                    )

        await self.db.commit()
