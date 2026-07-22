"""Unified failure read-model + pre-failure fingerprints.

`sync_failure_events` consolidates corrective work orders, maintenance tickets
and maintenance-triggering stops into `failure_events` (idempotent upsert keyed
by (source, source_id); source rows are never modified). `capture_fingerprints`
then extracts the sensor feature vectors of the configurable windows BEFORE
each failure — the raw material of the pattern-similarity factor and of any
future supervised model.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    Equipment,
    FailureEvent,
    FailurePattern,
    FailureSource,
    Machine,
    MachineStop,
    MaintenanceTicket,
    Sensor,
    StopCategory,
    WorkOrder,
)

from .config import EffectiveConfig
from .features import fetch_bucket_series, window_features

log = logging.getLogger("predictive")


async def _existing_keys(db: AsyncSession, source: FailureSource, ids: list) -> set:
    if not ids:
        return set()
    rows = (await db.execute(
        select(FailureEvent.source_id).where(
            FailureEvent.source == source, FailureEvent.source_id.in_(ids)
        )
    )).scalars().all()
    return set(rows)


async def _machine_equipment_map(db: AsyncSession, plant_id=None) -> dict:
    stmt = select(Machine.id, Machine.equipment_id, Machine.plant_id).where(Machine.equipment_id.isnot(None))
    if plant_id is not None:
        stmt = stmt.where(Machine.plant_id == plant_id)
    return {r.id: (r.equipment_id, r.plant_id) for r in (await db.execute(stmt)).all()}


async def sync_failure_events(
    db: AsyncSession, plant_id=None, since: Optional[datetime] = None,
) -> int:
    """Upsert failure events from the three sources. `since=None` = full
    3-year horizon (first run / backfill); the cron passes a trailing window."""
    since = since or (datetime.now(timezone.utc) - timedelta(days=3 * 365))
    created = 0
    m2e = await _machine_equipment_map(db, plant_id)

    # 1. Corrective work orders (equipment-linked).
    stmt = select(WorkOrder).where(
        WorkOrder.type == "corrective",
        WorkOrder.equipment_id.isnot(None),
        WorkOrder.opened_at >= since,
    )
    if plant_id is not None:
        stmt = stmt.join(Equipment, Equipment.id == WorkOrder.equipment_id).where(Equipment.plant_id == plant_id)
    wos = (await db.execute(stmt)).scalars().all()
    eq_plant = {
        r.id: r.plant_id for r in (await db.execute(
            select(Equipment.id, Equipment.plant_id).where(
                Equipment.id.in_({w.equipment_id for w in wos} or {None})
            )
        )).all()
    } if wos else {}
    have = await _existing_keys(db, FailureSource.work_order, [w.id for w in wos])
    for w in wos:
        if w.id in have or w.opened_at is None:
            continue
        status = w.status.value if hasattr(w.status, "value") else str(w.status)
        if status == "cancelled":
            continue
        db.add(FailureEvent(
            equipment_id=w.equipment_id,
            plant_id=eq_plant.get(w.equipment_id) or plant_id,
            source=FailureSource.work_order, source_id=w.id,
            started_at=w.opened_at, ended_at=w.completed_at,
            failure_type=w.failure_code or w.classification,
            component=w.component,
            severity=w.priority.value if hasattr(w.priority, "value") else None,
            confirmed=status == "completed",
        ))
        created += 1

    # 2. Maintenance tickets (machine → equipment).
    stmt = select(MaintenanceTicket).where(MaintenanceTicket.opened_at >= since)
    tickets = (await db.execute(stmt)).scalars().all()
    have = await _existing_keys(db, FailureSource.ticket, [t.id for t in tickets])
    for t in tickets:
        eq = m2e.get(t.machine_id)
        if t.id in have or eq is None or t.opened_at is None:
            continue
        status = t.status.value if hasattr(t.status, "value") else str(t.status)
        if status == "cancelled":
            continue
        db.add(FailureEvent(
            equipment_id=eq[0], machine_id=t.machine_id, plant_id=eq[1],
            source=FailureSource.ticket, source_id=t.id,
            started_at=t.opened_at, ended_at=t.completed_at,
            failure_type=t.problem_type,
            severity=t.priority.value if hasattr(t.priority, "value") else None,
            confirmed=status == "completed",
        ))
        created += 1

    # 3. Maintenance-triggering stops not already carried by a ticket.
    cat_ids = (await db.execute(
        select(StopCategory.id).where(StopCategory.triggers_maintenance.is_(True))
    )).scalars().all()
    if cat_ids:
        stops = (await db.execute(
            select(MachineStop).where(
                MachineStop.stop_category_id.in_(cat_ids),
                MachineStop.ticket_id.is_(None),
                MachineStop.started_at >= since,
            )
        )).scalars().all()
        have = await _existing_keys(db, FailureSource.stop, [st.id for st in stops])
        for st in stops:
            eq = m2e.get(st.machine_id)
            if st.id in have or eq is None:
                continue
            db.add(FailureEvent(
                equipment_id=eq[0], machine_id=st.machine_id, plant_id=eq[1],
                source=FailureSource.stop, source_id=st.id,
                started_at=st.started_at, ended_at=st.ended_at,
                failure_type="unplanned_stop",
                confirmed=False,
            ))
            created += 1

    await db.flush()
    return created


async def capture_fingerprints(
    db: AsyncSession, cfg: EffectiveConfig, plant_id=None, limit: int = 25,
) -> int:
    """Extract pre-failure feature vectors for events that don't have them yet.
    Bounded work per call (cron-friendly). Events on equipment without sensors
    short-circuit on one cheap query; events whose pre-windows hold no readings
    yield nothing and may be revisited — acceptable at `limit` per cycle."""
    stmt = (
        select(FailureEvent)
        .outerjoin(FailurePattern, FailurePattern.failure_event_id == FailureEvent.id)
        .where(FailurePattern.id.is_(None), FailureEvent.confirmed.is_(True))
        .order_by(FailureEvent.started_at.desc())
        .limit(limit)
    )
    if plant_id is not None:
        stmt = stmt.where(FailureEvent.plant_id == plant_id)
    events = (await db.execute(stmt)).scalars().all()
    made = 0
    for ev in events:
        sensors = (await db.execute(
            select(Sensor).where(Sensor.equipment_id == ev.equipment_id, Sensor.active.is_(True))
        )).scalars().all()
        if not sensors:
            continue
        for w in cfg.fingerprint_windows_h:
            since = ev.started_at - timedelta(hours=float(w))
            feats: dict[str, dict] = {}
            for sensor in sensors:
                buckets = await fetch_bucket_series(db, sensor.id, since, ev.started_at)
                f = window_features(buckets, since, ev.started_at)
                if f and f["n"] >= 4:
                    feats[sensor.code] = {
                        "avg": f["avg"], "max": f["max"], "std": f["std"],
                        "slope_per_hour": f["slope_per_hour"], "n": f["n"],
                    }
            if feats:
                db.add(FailurePattern(
                    failure_event_id=ev.id, equipment_id=ev.equipment_id,
                    plant_id=ev.plant_id, window_hours=float(w), features=feats,
                ))
                made += 1
    await db.flush()
    return made
