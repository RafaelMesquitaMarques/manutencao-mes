"""Shift replay — READ endpoints over the history that already exists.

  GET /{plant_id}/windows?date=YYYY-MM-DD   the day's selectable shifts + whole day
  GET /{plant_id}/timeline?start=&end=      replay material for a window

Nothing here writes: the replay is rebuilt from `machine_stops`,
`machine_interventions`, `maintenance_tickets`, `job_order_runs`,
`machine_production_hourly`, `pit_stop_movements`, `maintenance_alerts` and
`reject_logs`. See `app/services/factory_replay.py` for the state
precedence and the known limitations.

Access: same level as the map (`factory_map:view` + belonging to the plant) —
whoever sees the factory live can review it.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.plant_context import PlantContext, get_plant_context
from app.db.session import get_db
from app.models.models import Plant
from app.services import factory_replay as replay_service

router = APIRouter()


def _parse_dt(raw: str, field: str) -> datetime:
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail=f"invalid_{field}")
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


async def _checked_plant(db: AsyncSession, plant_id: UUID, ctx: PlantContext) -> Plant:
    plant = await db.get(Plant, plant_id)
    if not plant or not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    return plant


@router.get("/{plant_id}/windows")
async def list_windows(
    plant_id: UUID,
    date_str: Optional[str] = Query(None, alias="date"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Shifts the plant actually runs on that local day (from the machines'
    `shifts_config`), aggregated: a shift shared by 12 machines is ONE
    option with `machine_count: 12`."""
    plant = await _checked_plant(db, plant_id, ctx)
    tz = replay_service.tz_of(plant.timezone)
    if date_str:
        try:
            for_date = date.fromisoformat(date_str)
        except ValueError:
            raise HTTPException(status_code=422, detail="invalid_date")
    else:
        for_date = datetime.now(timezone.utc).astimezone(tz).date()
    return await replay_service.shift_windows_for_day(db, plant_id, for_date)


@router.get("/{plant_id}/timeline")
async def get_timeline(
    plant_id: UUID,
    start: str = Query(...),
    end: str = Query(...),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _checked_plant(db, plant_id, ctx)
    w_start, w_end = _parse_dt(start, "start"), _parse_dt(end, "end")
    if w_end <= w_start:
        raise HTTPException(status_code=422, detail="end_before_start")
    if w_end - w_start > timedelta(hours=replay_service.MAX_WINDOW_HOURS):
        raise HTTPException(status_code=422, detail="window_too_long")
    # The future has no history: cutting at "now" keeps the cursor honest instead
    # of painting baseline green over a time that has not happened yet.
    now = datetime.now(timezone.utc)
    if w_start >= now:
        raise HTTPException(status_code=422, detail="window_in_future")
    return await replay_service.build_timeline(db, plant_id, w_start, min(w_end, now))
