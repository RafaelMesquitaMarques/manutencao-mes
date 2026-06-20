"""
MES Service — mock data layer.
Each method is shaped exactly as real MES API integration would return.
Replace mock implementations with real MES API calls per method.
"""
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.models.models import (
    Machine, MachineStop, MachineProductionLog, AlertShift,
    StopCategory, StopCategoryType,
)


def shift_windows(shifts_config: Optional[dict], for_date: date) -> list[tuple[datetime, datetime]]:
    """Planned production windows (UTC) for a date, from Machine.shifts_config
    ({shift: {start: "HH:MM", end: "HH:MM"}}). Overnight shifts roll past
    midnight and belong to the date they start. Falls back to the full 24h day
    when no valid window is configured."""
    midnight = datetime.combine(for_date, time.min).replace(tzinfo=timezone.utc)
    windows: list[tuple[datetime, datetime]] = []
    for cfg in (shifts_config or {}).values():
        if not isinstance(cfg, dict):
            continue
        try:
            sh, sm = [int(x) for x in str(cfg.get("start", "")).split(":")[:2]]
            eh, em = [int(x) for x in str(cfg.get("end", "")).split(":")[:2]]
        except (ValueError, TypeError):
            continue
        start = midnight + timedelta(hours=sh, minutes=sm)
        end = midnight + timedelta(hours=eh, minutes=em)
        if end <= start:
            end += timedelta(days=1)
        windows.append((start, end))
    if not windows:
        return [(midnight, midnight + timedelta(days=1))]
    windows.sort()
    merged = [windows[0]]
    for start, end in windows[1:]:
        if start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def overlap_seconds(start_a: datetime, end_a: datetime, start_b: datetime, end_b: datetime) -> float:
    start = max(start_a, start_b)
    end = min(end_a, end_b)
    return max(0.0, (end - start).total_seconds())


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


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
        """Availability % for a date: planned production time (from the
        machine's shifts_config, full day when unset) minus unplanned stop
        time, over planned time. Stops in 'planned' categories don't count."""
        now = datetime.now(timezone.utc)
        machine = await self.db.get(Machine, machine_id)
        windows = shift_windows(machine.shifts_config if machine else None, for_date)

        # For today, only count planned time elapsed so far
        planned_seconds = sum(
            overlap_seconds(ws, we, ws, min(we, now)) for ws, we in windows
        )
        if planned_seconds <= 0:
            return 100.0

        r = await self.db.execute(
            select(MachineStop, StopCategory.type)
            .outerjoin(StopCategory, MachineStop.stop_category_id == StopCategory.id)
            .where(
                MachineStop.machine_id == machine_id,
                func.date(MachineStop.started_at) == for_date,
            )
        )
        stopped_seconds = 0.0
        for stop, cat_type in r.all():
            if cat_type == StopCategoryType.planned:
                continue
            s = _as_utc(stop.started_at)
            e = _as_utc(stop.ended_at) if stop.ended_at else now
            for ws, we in windows:
                stopped_seconds += overlap_seconds(s, e, ws, min(we, now))

        availability = max(0.0, min(100.0, (planned_seconds - stopped_seconds) / planned_seconds * 100))
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
