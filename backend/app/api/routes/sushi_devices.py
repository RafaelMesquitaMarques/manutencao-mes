"""Sushi Sensor device registry (Yokogawa XS-series LoRaWAN condition sensors).

CRUD for the fleet, edited in /settings/devices next to the ADAM modules.
Writes are gated by the `settings_devices` resource guard at router
registration (main.py). A device is matched to incoming uplinks by its
LoRaWAN DevEUI; readings only flow once it is linked to an equipment.
The ingest path itself lives in routes/sushi.py.
"""
import re
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_scoped
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import Equipment, SushiDevice, SushiSensorModel, User
from app.services.sushi_service import device_health, namur_state

router = APIRouter()


def _device_out(d: SushiDevice) -> dict:
    eq = d.equipment
    return {
        "id": str(d.id),
        "name": d.name,
        "dev_eui": d.dev_eui,
        "model": d.model.value if d.model else None,
        "equipment_id": str(d.equipment_id) if d.equipment_id else None,
        "equipment_name": eq.name if eq else None,
        "equipment_code": eq.code if eq else None,
        "enabled": bool(d.enabled),
        "update_period_min": d.update_period_min,
        "vel_warn_mms": d.vel_warn_mms,
        "vel_crit_mms": d.vel_crit_mms,
        "acc_warn_ms2": d.acc_warn_ms2,
        "acc_crit_ms2": d.acc_crit_ms2,
        "temp_warn_c": d.temp_warn_c,
        "temp_crit_c": d.temp_crit_c,
        "press_min_mpa": d.press_min_mpa,
        "press_max_mpa": d.press_max_mpa,
        "health": device_health(d),
        "namur": namur_state(d.diag_status),
        "last_uplink_at": d.last_uplink_at.isoformat() if d.last_uplink_at else None,
        "last_data_type": d.last_data_type,
        "battery_pct": d.battery_pct,
        "rssi_dbm": d.rssi_dbm,
        "snr_db": d.snr_db,
        "per_pct": d.per_pct,
        "tag_name": d.tag_name,
        "last_error": d.last_error,
        # The UI shows the ingest URL to paste into the network server; the
        # token value itself is never echoed back, only whether it is set.
        "ingest_configured": bool(settings.SUSHI_INGEST_TOKEN),
    }


async def _load(device_id: UUID, db: AsyncSession, ctx: PlantContext) -> SushiDevice:
    return ensure_same_plant(await db.get(SushiDevice, device_id), ctx, detail="device_not_found")


class DeviceIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dev_eui: str = Field(min_length=16, max_length=23)  # allows separators, normalized below
    model: SushiSensorModel = SushiSensorModel.xs770a
    equipment_id: Optional[UUID] = None
    enabled: bool = True
    update_period_min: int = Field(default=60, ge=1, le=4320)
    vel_warn_mms: Optional[float] = Field(default=4.5, ge=0)
    vel_crit_mms: Optional[float] = Field(default=7.1, ge=0)
    acc_warn_ms2: Optional[float] = Field(default=None, ge=0)
    acc_crit_ms2: Optional[float] = Field(default=None, ge=0)
    temp_warn_c: Optional[float] = None
    temp_crit_c: Optional[float] = None
    press_min_mpa: Optional[float] = None
    press_max_mpa: Optional[float] = None

    @field_validator("dev_eui")
    @classmethod
    def _normalize_eui(cls, v: str) -> str:
        cleaned = re.sub(r"[^0-9A-Fa-f]", "", v)
        if len(cleaned) != 16:
            raise ValueError("invalid_dev_eui")
        return cleaned.upper()


async def _resolve_plant(equipment_id: Optional[UUID], db: AsyncSession, ctx: PlantContext):
    """A device belongs to its equipment's plant; an unlinked device belongs to
    the caller's active plant. Never another plant's equipment."""
    if equipment_id is not None:
        eq = await db.get(Equipment, equipment_id)
        if eq is None:
            raise HTTPException(status_code=400, detail="equipment_not_found")
        if eq.plant_id is not None and not ctx.can_access(eq.plant_id):
            raise HTTPException(status_code=400, detail="equipment_not_found")
        return eq.plant_id or ctx.plant_id
    return ctx.plant_id


async def _reject_duplicate_eui(db: AsyncSession, dev_eui: str, exclude_id: Optional[UUID] = None):
    stmt = select(SushiDevice.id).where(SushiDevice.dev_eui == dev_eui)
    if exclude_id is not None:
        stmt = stmt.where(SushiDevice.id != exclude_id)
    if (await db.execute(stmt)).first() is not None:
        raise HTTPException(status_code=400, detail="dev_eui_already_registered")


@router.get("")
async def list_devices(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        plant_scoped(
            select(SushiDevice).options(selectinload(SushiDevice.equipment)).order_by(SushiDevice.name),
            SushiDevice, ctx,
        )
    )).scalars().all()
    return [_device_out(d) for d in rows]


@router.post("")
async def create_device(
    data: DeviceIn,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    await _reject_duplicate_eui(db, data.dev_eui)
    plant_id = await _resolve_plant(data.equipment_id, db, ctx)
    d = SushiDevice(**data.model_dump(), plant_id=plant_id)
    db.add(d)
    await db.commit()
    await db.refresh(d, ["equipment"])
    return _device_out(d)


@router.put("/{device_id}")
async def update_device(
    device_id: UUID,
    data: DeviceIn,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    d = await _load(device_id, db, ctx)
    await _reject_duplicate_eui(db, data.dev_eui, exclude_id=d.id)
    plant_id = await _resolve_plant(data.equipment_id, db, ctx)
    for k, v in data.model_dump().items():
        setattr(d, k, v)
    d.plant_id = plant_id
    await db.commit()
    await db.refresh(d, ["equipment"])
    return _device_out(d)


@router.delete("/{device_id}")
async def delete_device(
    device_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    d = await _load(device_id, db, ctx)
    await db.delete(d)
    await db.commit()
    return {"ok": True}
