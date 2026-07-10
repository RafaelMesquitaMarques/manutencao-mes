"""
MES Service — mock data layer.
Each method is shaped exactly as real MES API integration would return.
Replace mock implementations with real MES API calls per method.
"""
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Optional
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_

from app.models.models import (
    Machine, MachineStop, MachineProductionLog, MachineProductionHourly, AlertShift,
    StopCategory, StopCategoryType, Plant,
)


def current_shift_window(
    shifts_config: Optional[dict], tz: ZoneInfo, now_utc: datetime,
) -> Optional[tuple[datetime, datetime]]:
    """The (start_utc, end_utc) of the shift active *now*, from shifts_config whose
    HH:MM are LOCAL wall-clock in `tz`. Overnight shifts (end ≤ start) roll past
    midnight. Checks yesterday+today so an overnight shift started before midnight
    is found. Returns None if no shift contains `now` (or none configured)."""
    now_local = now_utc.astimezone(tz)
    for base in (now_local.date() - timedelta(days=1), now_local.date()):
        for cfg in (shifts_config or {}).values():
            if not isinstance(cfg, dict):
                continue
            try:
                sh, sm = [int(x) for x in str(cfg.get("start", "")).split(":")[:2]]
                eh, em = [int(x) for x in str(cfg.get("end", "")).split(":")[:2]]
            except (ValueError, TypeError):
                continue
            start_local = datetime(base.year, base.month, base.day, sh, sm, tzinfo=tz)
            end_local = datetime(base.year, base.month, base.day, eh, em, tzinfo=tz)
            if end_local <= start_local:
                end_local += timedelta(days=1)
            ws, we = start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)
            if ws <= now_utc < we:
                return ws, we
    return None


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

    async def _plant_of(self, machine_id: UUID):
        """New rows inherit the machine's plant at creation (no boot-heal wait)."""
        return (await self.db.execute(
            select(Machine.plant_id).where(Machine.id == machine_id)
        )).scalar_one_or_none()

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
                plant_id=await self._plant_of(machine_id),
                date=today,
                shift=shift_enum,
                reject_count=0,
            )
            self.db.add(log)
        log.reject_count = max(0, (log.reject_count or 0) + delta)
        # Persist the per-shift OEE snapshot so historical dashboards can chart
        # quality/OEE trends per shift (not just the live aggregate). Quality is the
        # reject-driven factor; it populates as soon as a produced count exists.
        self._recompute_oee(log)
        await self.db.commit()
        await self.db.refresh(log)
        return await self.get_today_rejects(machine_id)

    async def add_production(self, machine_id: UUID, count: int, reject: int,
                             shift_enum: AlertShift, default_target: int,
                             log_date: Optional[date] = None) -> dict:
        """Add produced parts (and optional rejects) to a shift's production log,
        creating the row if needed, and recompute its OEE snapshot. Does NOT
        commit — the caller commits (so status + count land in one transaction).
        Returns the row's running totals."""
        d = log_date or date.today()
        r = await self.db.execute(
            select(MachineProductionLog).where(
                MachineProductionLog.machine_id == machine_id,
                MachineProductionLog.date == d,
                MachineProductionLog.shift == shift_enum,
            )
        )
        log = r.scalar_one_or_none()
        if not log:
            log = MachineProductionLog(
                machine_id=machine_id, plant_id=await self._plant_of(machine_id),
                date=d, shift=shift_enum,
                target_count=int(default_target or 0), actual_count=0, reject_count=0,
            )
            self.db.add(log)
        elif not log.target_count:
            log.target_count = int(default_target or 0)
        log.actual_count = (log.actual_count or 0) + max(0, count)
        log.reject_count = max(0, (log.reject_count or 0) + reject)
        # Fill availability from the live stop/production feed so the stored OEE
        # snapshot matches the dashboards (which recompute it dynamically).
        log.availability_pct = await self.get_availability(machine_id, d)
        self._recompute_oee(log)
        return {
            "actual_count": log.actual_count,
            "reject_count": log.reject_count,
            "target_count": log.target_count,
            "availability_pct": log.availability_pct,
            "performance_pct": log.performance_pct,
            "quality_pct": log.quality_pct,
            "oee_pct": log.oee_pct,
        }

    async def add_hourly_count(self, machine_id: UUID, hour_utc: datetime,
                               count: int, reject: int = 0) -> None:
        """Add parts to the real per-hour bucket (ADAM feed) for the pieces/hour
        chart. `hour_utc` must be truncated to the hour (UTC). Does NOT commit."""
        r = await self.db.execute(
            select(MachineProductionHourly).where(
                MachineProductionHourly.machine_id == machine_id,
                MachineProductionHourly.hour == hour_utc,
            )
        )
        bucket = r.scalar_one_or_none()
        if not bucket:
            bucket = MachineProductionHourly(
                machine_id=machine_id, hour=hour_utc, count=0, reject_count=0)
            self.db.add(bucket)
        bucket.count = (bucket.count or 0) + max(0, count)
        bucket.reject_count = max(0, (bucket.reject_count or 0) + reject)

    @staticmethod
    def _recompute_oee(log: MachineProductionLog) -> None:
        """Recompute performance/quality/OEE on a production-log row from its own
        counts. OEE = Availability × Performance × Quality.
          performance = actual / target (capped at 100%)
          quality     = (actual − rejects) / actual
          availability comes from the row (filled by the stop/production feed)."""
        actual = float(log.actual_count or 0)
        target = float(log.target_count or 0)
        rejects = float(log.reject_count or 0)
        perf = min(actual / target, 1.0) if target > 0 else 0.0
        qual = ((actual - rejects) / actual) if actual > 0 else 0.0
        avail = float(log.availability_pct or 0.0) / 100.0
        log.performance_pct = round(perf * 100, 1)
        log.quality_pct = round(qual * 100, 1)
        log.oee_pct = round(avail * perf * qual * 100, 1)

    async def get_availability(self, machine_id: UUID, for_date: date) -> float:
        """Availability % for the CURRENT shift: elapsed shift time minus
        non-planned stop time, over elapsed shift time. Planned stops count as
        available; every other stop — including unjustified ones with no category
        (pink) — counts as downtime.

        The shift window comes from the machine's shifts_config, whose HH:MM are
        LOCAL wall-clock in the plant's timezone (matches the kiosk timeline). We
        scope to the shift active now (not a merged 24 h day) so the gauge means
        'availability this shift'."""
        now = datetime.now(timezone.utc)
        machine = await self.db.get(Machine, machine_id)

        tz = ZoneInfo("America/Toronto")
        if machine and machine.plant_id:
            plant = await self.db.get(Plant, machine.plant_id)
            if plant and plant.timezone:
                try:
                    tz = ZoneInfo(plant.timezone)
                except Exception:
                    pass

        win = current_shift_window(machine.shifts_config if machine else None, tz, now)
        if win is None:
            # No shift configured / none active now → fall back to the local day so far.
            local_midnight = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
            win = (local_midnight.astimezone(timezone.utc),
                   (local_midnight + timedelta(days=1)).astimezone(timezone.utc))

        ws, we = win
        end_cap = min(we, now)
        planned_seconds = (end_cap - ws).total_seconds()
        if planned_seconds <= 0:
            return 100.0

        # Stops overlapping the shift window so far.
        r = await self.db.execute(
            select(MachineStop, StopCategory.type)
            .outerjoin(StopCategory, MachineStop.stop_category_id == StopCategory.id)
            .where(
                MachineStop.machine_id == machine_id,
                MachineStop.started_at < end_cap,
                or_(MachineStop.ended_at.is_(None), MachineStop.ended_at > ws),
            )
        )
        stopped_seconds = 0.0
        for stop, cat_type in r.all():
            if cat_type == StopCategoryType.planned:
                continue  # planned stops stay "available"
            s = _as_utc(stop.started_at)
            e = _as_utc(stop.ended_at) if stop.ended_at else now
            stopped_seconds += overlap_seconds(s, e, ws, end_cap)

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
