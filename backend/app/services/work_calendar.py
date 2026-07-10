"""Factory working calendar — which dates count for machine KPIs.

The factory normally runs Monday to Friday. A date counts as a working day when:
  - production was actually recorded on it (overtime weekends and worked
    holidays are auto-detected, so real work always shows in the numbers), or
  - it is a weekday that is not a registered holiday, or
  - it is a weekend and the count_weekends setting is on (and not a holiday).

Idle weekends and holidays are skipped so they don't drag availability/OEE down.

Multi-plant: a plant that OWNS a FactoryCalendarSettings row uses its own
calendar exclusively (its settings + only its holiday rows). Plants without
one — QS and QM today — share the legacy calendar (plant_id NULL rows), which
is what the shared Quebec team already maintains. Las Vegas gets its own row
(plus Nevada holidays) at onboarding, so it never inherits Quebec dates.
"""
from datetime import date, timedelta
from typing import Iterable, Optional, Set

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import FactoryCalendarSettings, FactoryHoliday, Machine, MachineProductionLog


async def get_calendar_settings(db: AsyncSession, plant_id=None) -> FactoryCalendarSettings:
    """The plant's own settings row when it has one, else the legacy shared row
    (created on first use). The own-row presence is what flips a plant onto a
    fully independent calendar (see module docstring)."""
    if plant_id is not None:
        s = (await db.execute(
            select(FactoryCalendarSettings)
            .where(FactoryCalendarSettings.plant_id == plant_id).limit(1)
        )).scalars().first()
        if s:
            return s
    s = (await db.execute(
        select(FactoryCalendarSettings)
        .where(FactoryCalendarSettings.plant_id.is_(None)).limit(1)
    )).scalars().first()
    if not s:
        s = FactoryCalendarSettings(count_weekends=False)
        db.add(s)
        await db.commit()
    return s


async def _resolve_plant(db: AsyncSession, plant_id, machine_ids) -> Optional[object]:
    """Explicit plant wins; else infer it when every given machine shares one."""
    if plant_id is not None:
        return plant_id
    if machine_ids:
        ids = [m for m in machine_ids if m is not None]
        if ids:
            plants = set((await db.execute(
                select(Machine.plant_id).where(Machine.id.in_(ids))
            )).scalars().all())
            plants.discard(None)
            if len(plants) == 1:
                return plants.pop()
    return None


async def working_dates(
    db: AsyncSession,
    start_date: date,
    end_date: date,
    machine_ids: Optional[Iterable] = None,
    plant_id=None,
) -> Set[date]:
    """Dates in [start_date, end_date] that count for KPIs, per the rules above.
    `machine_ids` scopes the worked-day auto-detection (None = any machine) and,
    when `plant_id` is not given, infers which plant's calendar applies."""
    if end_date < start_date:
        return set()
    machine_ids = list(machine_ids) if machine_ids is not None else None
    plant_id = await _resolve_plant(db, plant_id, machine_ids)
    settings = await get_calendar_settings(db, plant_id)

    # Own calendar (settings row has a plant) → only that plant's holidays;
    # legacy shared calendar → the legacy NULL holiday rows.
    hol_plant_cond = (
        FactoryHoliday.plant_id == settings.plant_id
        if settings.plant_id is not None
        else FactoryHoliday.plant_id.is_(None)
    )
    holidays = set((await db.execute(
        select(FactoryHoliday.date)
        .where(FactoryHoliday.date >= start_date, FactoryHoliday.date <= end_date,
               hol_plant_cond)
    )).scalars().all())

    worked_cond = [
        MachineProductionLog.date >= start_date,
        MachineProductionLog.date <= end_date,
        MachineProductionLog.actual_count > 0,
    ]
    if machine_ids is not None:
        worked_cond.append(MachineProductionLog.machine_id.in_(machine_ids))
    elif plant_id is not None:
        worked_cond.append(MachineProductionLog.plant_id == plant_id)
    worked = set((await db.execute(
        select(MachineProductionLog.date).where(and_(*worked_cond))
        .group_by(MachineProductionLog.date)
    )).scalars().all())

    out: Set[date] = set()
    d = start_date
    while d <= end_date:
        if d in worked:
            out.add(d)                                   # real work always counts
        elif d in holidays:
            pass                                         # idle holiday: skipped
        elif d.weekday() < 5 or settings.count_weekends:
            out.add(d)
        d += timedelta(days=1)
    return out
