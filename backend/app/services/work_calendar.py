"""Factory working calendar — which dates count for machine KPIs.

The factory normally runs Monday to Friday. A date counts as a working day when:
  - production was actually recorded on it (overtime weekends and worked
    holidays are auto-detected, so real work always shows in the numbers), or
  - it is a weekday that is not a registered holiday, or
  - it is a weekend and the count_weekends setting is on (and not a holiday).

Idle weekends and holidays are skipped so they don't drag availability/OEE down.
"""
from datetime import date, timedelta
from typing import Iterable, Optional, Set

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import FactoryCalendarSettings, FactoryHoliday, MachineProductionLog


async def get_calendar_settings(db: AsyncSession) -> FactoryCalendarSettings:
    """The singleton settings row, created on first use."""
    s = (await db.execute(select(FactoryCalendarSettings).limit(1))).scalars().first()
    if not s:
        s = FactoryCalendarSettings(count_weekends=False)
        db.add(s)
        await db.commit()
    return s


async def working_dates(
    db: AsyncSession,
    start_date: date,
    end_date: date,
    machine_ids: Optional[Iterable] = None,
) -> Set[date]:
    """Dates in [start_date, end_date] that count for KPIs, per the rules above.
    `machine_ids` scopes the worked-day auto-detection (None = any machine)."""
    if end_date < start_date:
        return set()
    settings = await get_calendar_settings(db)

    holidays = set((await db.execute(
        select(FactoryHoliday.date)
        .where(FactoryHoliday.date >= start_date, FactoryHoliday.date <= end_date)
    )).scalars().all())

    worked_cond = [
        MachineProductionLog.date >= start_date,
        MachineProductionLog.date <= end_date,
        MachineProductionLog.actual_count > 0,
    ]
    if machine_ids is not None:
        worked_cond.append(MachineProductionLog.machine_id.in_(list(machine_ids)))
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
