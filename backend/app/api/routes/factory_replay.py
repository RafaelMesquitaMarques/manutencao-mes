"""Replay do turno — endpoints de LEITURA sobre o histórico que já existe.

  GET /{plant_id}/windows?date=YYYY-MM-DD   turnos selecionáveis do dia + dia inteiro
  GET /{plant_id}/timeline?start=&end=      material do replay para uma janela

Nada aqui escreve: o replay é reconstruído de `machine_stops`,
`machine_interventions`, `maintenance_tickets`, `job_order_runs`,
`machine_production_hourly`, `pit_stop_movements`, `maintenance_alerts` e
`reject_logs`. Ver `app/services/factory_replay.py` para a precedência de
estados e as limitações conhecidas.

Acesso: mesmo nível do mapa (`factory_map:view` + pertencer à planta) — quem vê
a fábrica ao vivo pode revê-la.
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
    """Turnos que a planta realmente opera nesse dia local (a partir dos
    `shifts_config` das máquinas), agregados: um turno partilhado por 12
    máquinas é UMA opção com `machine_count: 12`."""
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
    # O futuro não tem histórico: cortar em "agora" mantém o cursor honesto em
    # vez de pintar verde de base num tempo que ainda não aconteceu.
    now = datetime.now(timezone.utc)
    if w_start >= now:
        raise HTTPException(status_code=422, detail="window_in_future")
    return await replay_service.build_timeline(db, plant_id, w_start, min(w_end, now))
