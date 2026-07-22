"""OF watch ("spot") endpoints — follow a specific OF on the factory map.

  GET    /{plant_id}            watches of the plant + live location/inactivity (map poll)
  GET    /{plant_id}/locate?q=  whole-map OF search (pit stop, machines, parked)
  POST   /{plant_id}            place/update a spot on an OF (upsert by OF)
  PATCH  /{watch_id}            change the inactivity threshold
  DELETE /{watch_id}            remove the spot

Placing/removing a spot is a map-user action, not a managerial one: any plant
member with factory_map:view can do it (the watch is shared by the whole team).
"""
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.permissions import require_permission
from app.core.plant_context import PlantContext, get_plant_context
from app.models.models import (
    JobOrder, JobOrderSource, JobOrderStatus, JobOrderWatch, Machine, User,
)
from app.services import of_watch_service

router = APIRouter()

ALLOWED_THRESHOLDS = {5, 10, 15, 30, 60, 120}


def _clean_threshold(minutes: Optional[int]) -> int:
    if minutes is None:
        return 30
    if minutes not in ALLOWED_THRESHOLDS:
        raise HTTPException(status_code=422, detail="invalid_threshold")
    return minutes


@router.get("/{plant_id}")
async def list_watches(
    plant_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    if not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    return {"watches": await of_watch_service.watch_status(db, plant_id)}


@router.get("/{plant_id}/locate")
async def locate(
    plant_id: UUID,
    q: str,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    if not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    found = await of_watch_service.locate_of(db, plant_id, q)
    if found is None:
        raise HTTPException(status_code=404, detail="of_not_found")
    return found


class WatchCreate(BaseModel):
    """Either an existing OF id, or a raw number as displayed on the map (kiosk
    chips can show OFs that have no job_orders row yet — externally-fed data).
    With `job_number`, the OF row is looked up (or created, like a scan would);
    `machine_id` anchors a created OF to the machine the user saw it on."""
    job_order_id: Optional[UUID] = None
    job_number: Optional[str] = None
    machine_id: Optional[UUID] = None
    threshold_minutes: Optional[int] = None


@router.post("/{plant_id}", status_code=201)
async def create_watch(
    plant_id: UUID,
    payload: WatchCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(require_permission("factory_map", "view")),
):
    if not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    jo = None
    if payload.job_order_id is not None:
        jo = await db.get(JobOrder, payload.job_order_id)
    elif payload.job_number and payload.job_number.strip():
        number = payload.job_number.strip()
        jo = (await db.execute(
            select(JobOrder).where(
                JobOrder.plant_id == plant_id,
                func.lower(JobOrder.job_number) == number.lower(),
            )
        )).scalars().first()
        if jo is None:
            machine = await db.get(Machine, payload.machine_id) if payload.machine_id else None
            if machine is not None and machine.plant_id != plant_id:
                machine = None
            # An OF the kiosk shows as LOADED is being worked, not queued —
            # in_progress, so it never lands in a cutting saw's planned "File".
            loaded = bool(machine and (machine.current_job_number or "").strip().lower() == number.lower())
            jo = JobOrder(
                job_number=number, plant_id=plant_id,
                status=JobOrderStatus.in_progress if loaded else JobOrderStatus.pending,
                started_at=datetime.now(timezone.utc) if loaded else None,
                source=JobOrderSource.manual,
                machine_id=machine.id if machine else None,
                department=machine.department if machine else None,
            )
            db.add(jo)
            await db.flush()
    else:
        raise HTTPException(status_code=422, detail="job_order_id_or_number_required")
    if not jo or jo.plant_id != plant_id:
        raise HTTPException(status_code=404, detail="Job order not found")
    threshold = _clean_threshold(payload.threshold_minutes)
    watch = (await db.execute(
        select(JobOrderWatch).where(JobOrderWatch.job_order_id == jo.id)
    )).scalar_one_or_none()
    if watch is None:
        watch = JobOrderWatch(
            plant_id=plant_id, job_order_id=jo.id,
            threshold_minutes=threshold, created_by_id=user.id,
        )
        db.add(watch)
    else:
        watch.threshold_minutes = threshold
    await db.commit()
    return {"id": str(watch.id), "job_order_id": str(jo.id), "threshold_minutes": watch.threshold_minutes}


class WatchPatch(BaseModel):
    threshold_minutes: int


async def _get_watch_checked(db: AsyncSession, ctx: PlantContext, watch_id: UUID) -> JobOrderWatch:
    watch = await db.get(JobOrderWatch, watch_id)
    if not watch or not ctx.can_access(watch.plant_id):
        raise HTTPException(status_code=404, detail="Watch not found")
    return watch


@router.patch("/{watch_id}")
async def patch_watch(
    watch_id: UUID,
    payload: WatchPatch,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _user: User = Depends(require_permission("factory_map", "view")),
):
    watch = await _get_watch_checked(db, ctx, watch_id)
    watch.threshold_minutes = _clean_threshold(payload.threshold_minutes)
    # A new threshold starts a fresh episode (a tighter limit may re-alert).
    watch.alerted_movement_at = None
    await db.commit()
    return {"id": str(watch.id), "threshold_minutes": watch.threshold_minutes}


@router.delete("/{watch_id}", status_code=204)
async def delete_watch(
    watch_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _user: User = Depends(require_permission("factory_map", "view")),
):
    watch = await _get_watch_checked(db, ctx, watch_id)
    await db.delete(watch)
    await db.commit()
