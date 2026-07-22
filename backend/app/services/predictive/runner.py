"""Cron orchestration: which plants/equipment to evaluate and when.

Runs inside the FastAPI lifespan like the other loops (no Celery). Per plant
(mode != off): failure sync hourly, baseline refresh per config, evaluation
per eval_interval_min. Each equipment is evaluated and committed independently
so one bad asset never poisons the batch.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import delete, select

from app.db.session import AsyncSessionLocal
from app.models.models import (
    Equipment,
    Machine,
    PredictiveHealthSnapshot,
    PredictiveMachineSettings,
    PredictiveMode,
    PredictiveSettings,
    Sensor,
)

from .baseline import build_baselines_for_equipment
from .config import effective_config
from .engine import evaluate_equipment, process_alerts
from .failure_sync import capture_fingerprints, sync_failure_events

log = logging.getLogger("predictive")

TICK_SECONDS = 60
SNAPSHOT_RETENTION_DAYS = 90   # ~5k rows/day at 50 assets — pruned daily
_state: dict = {}   # plant_id → {"eval": dt, "baseline": dt, "sync": dt}; "_retention" → dt


async def _eligible_equipments(db, plant_id) -> list[Equipment]:
    """Equipment worth evaluating: has condition sensors OR a linked active
    machine (kiosk stops/production feed the operational + reliability layers —
    predictive value exists before any sensor is installed)."""
    sensor_ids = (await db.execute(
        select(Sensor.equipment_id).where(Sensor.active.is_(True)).distinct()
    )).scalars().all()
    machine_ids = (await db.execute(
        select(Machine.equipment_id).where(
            Machine.plant_id == plant_id,
            Machine.equipment_id.isnot(None),
            Machine.is_active.is_(True),
        ).distinct()
    )).scalars().all()
    ids = set(sensor_ids) | set(machine_ids)
    if not ids:
        return []
    return (await db.execute(
        select(Equipment).where(
            Equipment.id.in_(ids),
            Equipment.plant_id == plant_id,
            Equipment.active.is_(True),
        )
    )).scalars().all()


async def evaluate_plant(db, settings: PredictiveSettings) -> int:
    """One evaluation pass over a plant. Returns evaluated count."""
    ms_rows = (await db.execute(
        select(PredictiveMachineSettings).where(
            PredictiveMachineSettings.plant_id == settings.plant_id
        )
    )).scalars().all()
    ms_by_eq = {m.equipment_id: m for m in ms_rows}
    machines = {
        m.equipment_id: m for m in (await db.execute(
            select(Machine).where(Machine.plant_id == settings.plant_id, Machine.equipment_id.isnot(None))
        )).scalars().all()
    }
    count = 0
    for eq in await _eligible_equipments(db, settings.plant_id):
        cfg = effective_config(settings, ms_by_eq.get(eq.id))
        if cfg.mode == "off":
            continue
        try:
            snap = await evaluate_equipment(db, eq, cfg, machine=machines.get(eq.id))
            await process_alerts(db, eq, machines.get(eq.id), cfg, snap)
            await db.commit()
            count += 1
        except Exception:
            await db.rollback()
            log.exception("predictive evaluation failed for equipment %s", eq.id)
    return count


async def refresh_plant_baselines(db, settings: PredictiveSettings) -> int:
    ms_rows = (await db.execute(
        select(PredictiveMachineSettings).where(
            PredictiveMachineSettings.plant_id == settings.plant_id
        )
    )).scalars().all()
    ms_by_eq = {m.equipment_id: m for m in ms_rows}
    count = 0
    for eq in await _eligible_equipments(db, settings.plant_id):
        cfg = effective_config(settings, ms_by_eq.get(eq.id))
        if cfg.mode == "off":
            continue
        try:
            await build_baselines_for_equipment(db, eq, cfg)
            await db.commit()
            count += 1
        except Exception:
            await db.rollback()
            log.exception("baseline refresh failed for equipment %s", eq.id)
    return count


async def tick(now: Optional[datetime] = None) -> None:
    """One scheduler tick — decides per plant what is due and runs it."""
    now = now or datetime.now(timezone.utc)
    async with AsyncSessionLocal() as db:
        last_prune = _state.get("_retention")
        if last_prune is None or now - last_prune >= timedelta(hours=24):
            try:
                await db.execute(delete(PredictiveHealthSnapshot).where(
                    PredictiveHealthSnapshot.ts < now - timedelta(days=SNAPSHOT_RETENTION_DAYS)
                ))
                await db.commit()
            except Exception:
                await db.rollback()
                log.exception("snapshot retention prune failed")
            _state["_retention"] = now
        plants = (await db.execute(
            select(PredictiveSettings).where(PredictiveSettings.mode != PredictiveMode.off)
        )).scalars().all()
        for st in plants:
            s = _state.setdefault(st.plant_id, {})
            cfg = effective_config(st)
            try:
                if s.get("sync") is None or now - s["sync"] >= timedelta(hours=1):
                    # First run backfills the whole horizon, then trailing 60 days.
                    since = None if s.get("sync") is None else now - timedelta(days=60)
                    await sync_failure_events(db, plant_id=st.plant_id, since=since)
                    await capture_fingerprints(db, cfg, plant_id=st.plant_id)
                    await db.commit()
                    s["sync"] = now
                if s.get("baseline") is None or now - s["baseline"] >= timedelta(hours=cfg.baseline_refresh_hours):
                    await refresh_plant_baselines(db, st)
                    s["baseline"] = now
                if s.get("eval") is None or now - s["eval"] >= timedelta(minutes=cfg.eval_interval_min):
                    await evaluate_plant(db, st)
                    s["eval"] = now
            except Exception:
                await db.rollback()
                log.exception("predictive tick failed for plant %s", st.plant_id)


async def predictive_loop() -> None:
    """Lifespan cron. Never raises; a quiet DB start delay avoids racing the
    startup DDL."""
    await asyncio.sleep(90)
    while True:
        try:
            await tick()
        except Exception:
            log.exception("predictive loop tick crashed (continuing)")
        await asyncio.sleep(TICK_SECONDS)
