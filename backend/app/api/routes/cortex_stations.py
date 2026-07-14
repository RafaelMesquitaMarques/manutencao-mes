"""Cortex station management (end-of-line barcode readers on the assembly lines).

CRUD for the stations the Cortex poller pulls scans from. Each station is mapped
to a machine (the assembly line); the poller (app.workers.cortex_poller) treats
these rows as its single source of truth and pushes every scan to that machine's
/of-unit-scan endpoint. Writes are gated by the `settings_devices` resource guard
at router registration (main.py) — same page family as the ADAM devices.
"""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_scoped
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import CortexStation, Machine, User

router = APIRouter()


def _station_out(st: CortexStation) -> dict:
    m = st.machine
    return {
        "id": str(st.id),
        "name": st.name,
        "station_key": st.station_key,
        "machine_id": str(st.machine_id) if st.machine_id else None,
        "machine_name": (m.display_name or m.name) if m else None,
        "machine_code": m.code if m else None,
        # UI prompts to provision a token when the linked machine has none —
        # without it the poller's /of-unit-scan POSTs would be rejected (401).
        "machine_has_token": bool(m and m.signal_ingest_token),
        "enabled": bool(st.enabled),
        "poll_interval_s": st.poll_interval_s,
        "status": st.status.value if st.status else None,
        "last_seen_at": st.last_seen_at.isoformat() if st.last_seen_at else None,
        "last_error": st.last_error,
    }


async def _load(station_id: UUID, db: AsyncSession, ctx: PlantContext) -> CortexStation:
    # 404 (never 403) for a station outside the caller's plant — no existence hint.
    return ensure_same_plant(await db.get(CortexStation, station_id), ctx, detail="station_not_found")


class StationIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    station_key: str = Field(min_length=1, max_length=200)
    machine_id: Optional[UUID] = None
    enabled: bool = True
    poll_interval_s: int = Field(default=5, ge=1, le=3600)


async def _resolve_plant(machine_id: Optional[UUID], db: AsyncSession, ctx: PlantContext):
    """A station belongs to its machine's plant; an unassigned station belongs to the
    caller's active plant. A station may never point at another plant's machine."""
    if machine_id is not None:
        machine = await db.get(Machine, machine_id)
        if machine is None:
            raise HTTPException(status_code=400, detail="machine_not_found")
        if machine.plant_id is not None and not ctx.can_access(machine.plant_id):
            raise HTTPException(status_code=400, detail="machine_not_found")  # no foreign existence hint
        return machine.plant_id or ctx.plant_id
    return ctx.plant_id


@router.get("")
async def list_stations(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        plant_scoped(
            select(CortexStation).options(selectinload(CortexStation.machine)).order_by(CortexStation.name),
            CortexStation, ctx,
        )
    )).scalars().all()
    return [_station_out(st) for st in rows]


@router.post("")
async def create_station(
    data: StationIn,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    plant_id = await _resolve_plant(data.machine_id, db, ctx)
    st = CortexStation(**data.model_dump(), plant_id=plant_id)
    db.add(st)
    await db.commit()
    await db.refresh(st, ["machine"])
    return _station_out(st)


@router.put("/{station_id}")
async def update_station(
    station_id: UUID,
    data: StationIn,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    st = await _load(station_id, db, ctx)
    plant_id = await _resolve_plant(data.machine_id, db, ctx)
    for k, v in data.model_dump().items():
        setattr(st, k, v)
    st.plant_id = plant_id
    await db.commit()
    await db.refresh(st, ["machine"])
    return _station_out(st)


@router.delete("/{station_id}")
async def delete_station(
    station_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    st = await _load(station_id, db, ctx)
    await db.delete(st)
    await db.commit()
    return {"ok": True}
