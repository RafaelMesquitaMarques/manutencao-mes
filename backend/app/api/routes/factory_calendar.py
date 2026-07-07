"""Factory working-calendar settings (weekend counting + holidays).

Drives which dates count for machine KPIs (see app.services.work_calendar).
Writes are gated by the `calendar` resource guard at router registration.
"""
from datetime import date as date_type
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import FactoryHoliday, User
from app.services.work_calendar import get_calendar_settings

router = APIRouter()


def _holiday_out(h: FactoryHoliday) -> dict:
    return {"id": str(h.id), "date": h.date.isoformat(), "name": h.name or ""}


async def _payload(db: AsyncSession) -> dict:
    settings = await get_calendar_settings(db)
    holidays = (await db.execute(
        select(FactoryHoliday).order_by(FactoryHoliday.date)
    )).scalars().all()
    return {
        "count_weekends": bool(settings.count_weekends),
        "holidays": [_holiday_out(h) for h in holidays],
    }


@router.get("/settings")
async def get_settings(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await _payload(db)


class CalendarSettingsUpdate(BaseModel):
    count_weekends: bool


@router.put("/settings")
async def update_settings(
    data: CalendarSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    settings = await get_calendar_settings(db)
    settings.count_weekends = data.count_weekends
    await db.commit()
    return await _payload(db)


class HolidayCreate(BaseModel):
    date: date_type
    name: str = Field(default="", max_length=200)


@router.post("/holidays")
async def add_holiday(
    data: HolidayCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dup = (await db.execute(
        select(FactoryHoliday).where(FactoryHoliday.date == data.date)
    )).scalars().first()
    if dup:
        raise HTTPException(status_code=400, detail="holiday_exists")
    h = FactoryHoliday(date=data.date, name=data.name.strip())
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
    current_user: User = Depends(get_current_user),
):
    h = await db.get(FactoryHoliday, holiday_id)
    if not h:
        raise HTTPException(status_code=404, detail="holiday_not_found")
    dup = (await db.execute(
        select(FactoryHoliday).where(
            FactoryHoliday.date == data.date,
            FactoryHoliday.id != holiday_id,
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
    current_user: User = Depends(get_current_user),
):
    h = await db.get(FactoryHoliday, holiday_id)
    if not h:
        raise HTTPException(status_code=404, detail="holiday_not_found")
    await db.delete(h)
    await db.commit()
    return {"ok": True}
