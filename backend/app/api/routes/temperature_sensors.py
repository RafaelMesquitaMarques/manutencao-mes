"""Temperature-sensor management (factory-map temperature probes).

CRUD for the temperature sensors placed on the factory map. Each sensor belongs to
a plant and has a free position (pos_x/pos_y) in the same pixel space as equipment
and props; the 3D twin renders a little thermometer at that point and the map's
temperature badge shows the reading of the sensor nearest the camera.

Readings are written by the in-process reading loop (app.main._temperature_loop) —
today every sensor uses the `simulated` source; the real Modbus/HTTP paths slot in
later behind the same rows. Writes are gated by the `settings_devices` resource
guard at router registration (main.py), the same page family as the ADAM devices.
"""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant
from app.models.models import TemperatureSensor, TemperatureSource

router = APIRouter()


def _sensor_out(s: TemperatureSensor) -> dict:
    return {
        "id": str(s.id),
        "name": s.name,
        "department": s.department,
        "enabled": bool(s.enabled),
        "source": s.source.value if s.source else None,
        "sim_baseline_c": s.sim_baseline_c,
        "sim_amplitude_c": s.sim_amplitude_c,
        "pos_x": s.pos_x,
        "pos_y": s.pos_y,
        "height_3d": s.height_3d,
        "last_value_c": s.last_value_c,
        "last_reading_at": s.last_reading_at.isoformat() if s.last_reading_at else None,
        "status": s.status.value if s.status else None,
        "last_error": s.last_error,
    }


class SensorIn(BaseModel):
    # Config only — position is set by dragging on the factory map (see the
    # /factory-map/sensor/{id} PATCH), never here, so an edit can't wipe it.
    name: str = Field(min_length=1, max_length=200)
    department: Optional[str] = Field(default=None, max_length=200)
    enabled: bool = True
    source: TemperatureSource = TemperatureSource.simulated
    sim_baseline_c: float = Field(default=21.0, ge=-60, le=120)
    sim_amplitude_c: float = Field(default=2.0, ge=0, le=40)


@router.get("")
async def list_sensors(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    rows = (await db.execute(
        select(TemperatureSensor)
        .where(TemperatureSensor.plant_id == ctx.plant_id)
        .order_by(TemperatureSensor.name)
    )).scalars().all()
    return [_sensor_out(s) for s in rows]


@router.post("")
async def create_sensor(
    data: SensorIn,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    s = TemperatureSensor(plant_id=ctx.plant_id, **data.model_dump())
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return _sensor_out(s)


@router.put("/{sensor_id}")
async def update_sensor(
    sensor_id: UUID,
    data: SensorIn,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    s = ensure_same_plant(await db.get(TemperatureSensor, sensor_id), ctx, detail="sensor_not_found")
    for k, v in data.model_dump().items():   # full body → department can be cleared to null
        setattr(s, k, v)
    await db.commit()
    await db.refresh(s)
    return _sensor_out(s)


@router.delete("/{sensor_id}")
async def delete_sensor(
    sensor_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    s = ensure_same_plant(await db.get(TemperatureSensor, sensor_id), ctx, detail="sensor_not_found")
    await db.delete(s)
    await db.commit()
    return {"ok": True}
