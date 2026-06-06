"""
MES Service — mock data layer.
Each method is shaped exactly as real MES API integration would return.
Replace mock implementations with real MES API calls per method.
"""
from datetime import date, datetime, timezone
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.models.models import MachineStop, MachineProductionLog, AlertShift


class MesService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_today_rejects(self, machine_id: UUID) -> int:
        """Return total reject count for today across all shifts."""
        today = date.today()
        r = await self.db.execute(
            select(func.sum(MachineProductionLog.reject_count))
            .where(
                MachineProductionLog.machine_id == machine_id,
                MachineProductionLog.date == today,
            )
        )
        return int(r.scalar() or 0)

    async def increment_rejects(self, machine_id: UUID, delta: int, shift: str = "morning") -> int:
        """Add delta to reject count for today's shift. Returns new total."""
        today = date.today()
        shift_enum = AlertShift(shift) if shift in [s.value for s in AlertShift] else AlertShift.morning
        r = await self.db.execute(
            select(MachineProductionLog)
            .where(
                MachineProductionLog.machine_id == machine_id,
                MachineProductionLog.date == today,
                MachineProductionLog.shift == shift_enum,
            )
        )
        log = r.scalar_one_or_none()
        if not log:
            log = MachineProductionLog(
                machine_id=machine_id,
                date=today,
                shift=shift_enum,
                reject_count=0,
            )
            self.db.add(log)
        log.reject_count = max(0, (log.reject_count or 0) + delta)
        await self.db.commit()
        await self.db.refresh(log)
        return await self.get_today_rejects(machine_id)

    async def get_availability(self, machine_id: UUID, for_date: date) -> float:
        """Calculate availability % from machine stops for a given date."""
        now = datetime.now(timezone.utc)
        if for_date < date.today():
            day_seconds = 86400.0
        else:
            midnight = datetime.combine(for_date, datetime.min.time()).replace(tzinfo=timezone.utc)
            day_seconds = max(1.0, (now - midnight).total_seconds())

        r = await self.db.execute(
            select(MachineStop)
            .where(
                MachineStop.machine_id == machine_id,
                func.date(MachineStop.started_at) == for_date,
            )
        )
        stops = r.scalars().all()
        stopped_seconds = 0.0
        for stop in stops:
            end = stop.ended_at or now
            if stop.started_at.tzinfo is None:
                s = stop.started_at.replace(tzinfo=timezone.utc)
            else:
                s = stop.started_at
            if end.tzinfo is None:
                end = end.replace(tzinfo=timezone.utc)
            stopped_seconds += (end - s).total_seconds()

        availability = max(0.0, min(100.0, (day_seconds - stopped_seconds) / day_seconds * 100))
        return round(availability, 1)

    async def get_today_downtime_minutes(self, machine_id: UUID) -> int:
        """Total downtime in minutes today."""
        today = date.today()
        now = datetime.now(timezone.utc)
        r = await self.db.execute(
            select(MachineStop)
            .where(
                MachineStop.machine_id == machine_id,
                func.date(MachineStop.started_at) == today,
            )
        )
        stops = r.scalars().all()
        total_secs = 0
        for stop in stops:
            end = stop.ended_at or now
            if stop.started_at.tzinfo is None:
                s = stop.started_at.replace(tzinfo=timezone.utc)
            else:
                s = stop.started_at
            if end.tzinfo is None:
                end = end.replace(tzinfo=timezone.utc)
            total_secs += int((end - s).total_seconds())
        return total_secs // 60

    # ── REPLACE BELOW WITH REAL MES API CALLS ────────────────────────────────

    def get_mock_production_count(self) -> int:
        """Mock: replace with MES API call to get production count."""
        return 0

    def get_mock_target(self) -> int:
        """Mock: replace with MES API call to get shift target."""
        return 0

    def get_mock_oee(self) -> float:
        """Mock: replace with MES API call for OEE."""
        return 0.0
