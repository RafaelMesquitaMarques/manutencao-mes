"""ADAM device management (Advantech ADAM-6050/6051 production-signal modules).

CRUD for the fleet of I/O devices the central gateway polls. Each device is
wired to a machine and pushes production pulses / status to that machine's
ingest endpoints; the gateway (app.workers.adam_gateway) treats these rows as
its single source of truth. Writes are gated by the `settings_devices` resource
guard at router registration (main.py).
"""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import (
    AdamDevice, AdamModel, AdamSignalSource, AdamActiveLevel, Machine, User,
)

router = APIRouter()


def _device_out(d: AdamDevice) -> dict:
    m = d.machine
    return {
        "id": str(d.id),
        "name": d.name,
        "model": d.model.value if d.model else None,
        "ip_address": d.ip_address,
        "port": d.port,
        "machine_id": str(d.machine_id) if d.machine_id else None,
        "machine_name": (m.display_name or m.name) if m else None,
        "machine_code": m.code if m else None,
        # UI prompts to provision a token when the linked machine has none —
        # without it the gateway's POSTs would be rejected (401).
        "machine_has_token": bool(m and m.signal_ingest_token),
        "enabled": bool(d.enabled),
        "signal_source": d.signal_source.value if d.signal_source else None,
        "channel": d.channel,
        "active_level": d.active_level.value if d.active_level else None,
        "counter_reg": d.counter_reg,
        "idle_timeout_s": d.idle_timeout_s,
        "poll_interval_ms": d.poll_interval_ms,
        "status": d.status.value if d.status else None,
        "last_seen_at": d.last_seen_at.isoformat() if d.last_seen_at else None,
        "last_error": d.last_error,
    }


async def _load(device_id: UUID, db: AsyncSession) -> AdamDevice:
    d = await db.get(AdamDevice, device_id)
    if not d:
        raise HTTPException(status_code=404, detail="device_not_found")
    return d


class DeviceIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    model: AdamModel = AdamModel.adam_6051
    ip_address: str = Field(min_length=1, max_length=64)
    port: int = Field(default=502, ge=1, le=65535)
    machine_id: Optional[UUID] = None
    enabled: bool = True
    signal_source: AdamSignalSource = AdamSignalSource.di
    channel: int = Field(default=0, ge=0, le=63)
    active_level: AdamActiveLevel = AdamActiveLevel.low
    counter_reg: int = Field(default=0, ge=0)
    idle_timeout_s: int = Field(default=15, ge=1, le=3600)
    poll_interval_ms: int = Field(default=100, ge=20, le=60000)


async def _validate_machine(machine_id: Optional[UUID], db: AsyncSession) -> None:
    if machine_id is not None and not await db.get(Machine, machine_id):
        raise HTTPException(status_code=400, detail="machine_not_found")


@router.get("")
async def list_devices(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(AdamDevice)
        .options(selectinload(AdamDevice.machine))
        .order_by(AdamDevice.name)
    )).scalars().all()
    return [_device_out(d) for d in rows]


@router.post("")
async def create_device(
    data: DeviceIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _validate_machine(data.machine_id, db)
    d = AdamDevice(**data.model_dump())
    db.add(d)
    await db.commit()
    await db.refresh(d, ["machine"])
    return _device_out(d)


@router.put("/{device_id}")
async def update_device(
    device_id: UUID,
    data: DeviceIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _validate_machine(data.machine_id, db)
    d = await _load(device_id, db)
    for k, v in data.model_dump().items():
        setattr(d, k, v)
    await db.commit()
    await db.refresh(d, ["machine"])
    return _device_out(d)


@router.delete("/{device_id}")
async def delete_device(
    device_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    d = await _load(device_id, db)
    await db.delete(d)
    await db.commit()
    return {"ok": True}
