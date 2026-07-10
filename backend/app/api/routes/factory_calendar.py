"""Factory working-calendar settings (weekend counting + holidays).

Drives which dates count for machine KPIs (see app.services.work_calendar).
Writes are gated by the `calendar` resource guard at router registration.

Multi-plant: the page edits the ACTIVE plant's calendar. Plants without their
own FactoryCalendarSettings row (QS and QM today) share the legacy calendar —
one edit serves both, exactly as before. A plant with its own row (Las Vegas,
created at onboarding) edits its private calendar and holidays.
"""
from datetime import date as date_type
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.plant_context import PlantContext, get_plant_context
from app.db.session import get_db
from app.models.models import FactoryHoliday
from app.services.work_calendar import get_calendar_settings

router = APIRouter()


def _holiday_out(h: FactoryHoliday) -> dict:
    return {"id": str(h.id), "date": h.date.isoformat(), "name": h.name or ""}


def _hol_scope(settings):
    """Holiday rows belonging to the resolved calendar (own plant vs legacy)."""
    return (FactoryHoliday.plant_id == settings.plant_id
            if settings.plant_id is not None
            else FactoryHoliday.plant_id.is_(None))


async def _payload(db: AsyncSession, ctx: PlantContext) -> dict:
    settings = await get_calendar_settings(db, ctx.plant_id)
    holidays = (await db.execute(
        select(FactoryHoliday).where(_hol_scope(settings)).order_by(FactoryHoliday.date)
    )).scalars().all()
    return {
        "count_weekends": bool(settings.count_weekends),
        "holidays": [_holiday_out(h) for h in holidays],
    }


@router.get("/settings")
async def get_settings(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    return await _payload(db, ctx)


class CalendarSettingsUpdate(BaseModel):
    count_weekends: bool


@router.put("/settings")
async def update_settings(
    data: CalendarSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    settings = await get_calendar_settings(db, ctx.plant_id)
    settings.count_weekends = data.count_weekends
    await db.commit()
    return await _payload(db, ctx)


class HolidayCreate(BaseModel):
    date: date_type
    name: str = Field(default="", max_length=200)


@router.post("/holidays")
async def add_holiday(
    data: HolidayCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    settings = await get_calendar_settings(db, ctx.plant_id)
    dup = (await db.execute(
        select(FactoryHoliday).where(FactoryHoliday.date == data.date, _hol_scope(settings))
    )).scalars().first()
    if dup:
        raise HTTPException(status_code=400, detail="holiday_exists")
    h = FactoryHoliday(date=data.date, name=data.name.strip(), plant_id=settings.plant_id)
    db.add(h)
    await db.commit()
    return _holiday_out(h)


class HolidayUpdate(BaseModel):
    date: date_type
    name: str = Field(default="", max_length=200)


@router.patch("/holidays/{holiday_id}")
async def update_holiday(
    holiday_id: UUID,
    data: HolidayUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    settings = await get_calendar_settings(db, ctx.plant_id)
    h = await db.get(FactoryHoliday, holiday_id)
    if not h or h.plant_id != settings.plant_id:
        raise HTTPException(status_code=404, detail="holiday_not_found")
    dup = (await db.execute(
        select(FactoryHoliday).where(
            FactoryHoliday.date == data.date,
            FactoryHoliday.id != holiday_id,
            _hol_scope(settings),
        )
    )).scalars().first()
    if dup:
        raise HTTPException(status_code=400, detail="holiday_exists")
    h.date = data.date
    h.name = data.name.strip()
    await db.commit()
    return _holiday_out(h)


@router.delete("/holidays/{holiday_id}")
async def delete_holiday(
    holiday_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    settings = await get_calendar_settings(db, ctx.plant_id)
    h = await db.get(FactoryHoliday, holiday_id)
    if not h or h.plant_id != settings.plant_id:
        raise HTTPException(status_code=404, detail="holiday_not_found")
    await db.delete(h)
    await db.commit()
    return {"ok": True}
