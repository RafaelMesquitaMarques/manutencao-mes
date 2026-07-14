"""ADAM device / Cortex station plant-segregation regression.
============================================================
Both device routers (`/api/adam-devices`, `/api/cortex-stations`) listed EVERY
plant's devices — machine bindings, IP addresses, poll config — to any
settings_devices user, and their detail routes fetched by bare id with no plant
check. Devices/stations carry `plant_id` (backfilled from the machine) but create
never set it. This locks the boundary:

  · list_* returns ONLY the active plant's rows
  · _load 404s a device/station owned by another plant (never 403)
  · _resolve_plant derives plant from the machine, rejects a foreign-plant
    machine, and falls back to the caller's active plant when unassigned

Harness identical to test_plant_segregation.py — INSIDE the backend container,
one shared loop, every write ALWAYS rolled back. We only flush() (never commit,
which the endpoints do) so nothing persists. Structural assertions, no fixed
counts.

Run (inside the backend container):
    pytest tests/test_device_scope.py -v
"""
import asyncio
import os
import sys
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                              # noqa: E402
from app.core.plant_context import resolve_plant_context          # noqa: E402
from app.models.models import (                                   # noqa: E402
    AdamDevice, CortexStation, Machine, Plant, User, UserPlant, UserRole,
)
from app.api.routes import adam_devices as adam                   # noqa: E402
from app.api.routes import cortex_stations as cortex              # noqa: E402

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    def wrapper():
        async def runner():
            s = _maker()()
            try:
                await fn(s)
            finally:
                await s.rollback()
                await s.close()
        _LOOP.run_until_complete(runner())
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


async def _plants(db):
    rows = (await db.execute(select(Plant).where(Plant.code.in_(["QS", "QM", "NL"])))).scalars().all()
    by_code = {p.code: p for p in rows}
    assert set(by_code) == {"QS", "QM", "NL"}, "live plants QS/QM/NL must exist"
    return by_code


async def _machine(db, plant):
    return (await db.execute(
        select(Machine).where(Machine.plant_id == plant.id).limit(1)
    )).scalars().first()


async def _ctx(db, plant, role=UserRole.maintenance_director):
    u = User(id=uuid.uuid4(), name=f"dv-{uuid.uuid4().hex[:6]}",
             email=f"dv-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=role, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=role, is_default=True))
    await db.flush()
    return u, await resolve_plant_context(db, u, None)


# ── _resolve_plant: derive / reject / fall back ───────────────────────────────

@with_session
async def test_resolve_plant_from_machine(db):
    p = await _plants(db)
    m = await _machine(db, p["QM"])
    if m is None:
        pytest.skip("no QM machine")
    _, ctx = await _ctx(db, p["QM"])
    assert await adam._resolve_plant(m.id, db, ctx) == p["QM"].id


@with_session
async def test_resolve_plant_rejects_foreign_machine(db):
    p = await _plants(db)
    qs_machine = await _machine(db, p["QS"])
    if qs_machine is None:
        pytest.skip("no QS machine")
    _, ctx_qm = await _ctx(db, p["QM"])
    with pytest.raises(HTTPException) as e:
        await adam._resolve_plant(qs_machine.id, db, ctx_qm)
    assert e.value.status_code == 400


@with_session
async def test_resolve_plant_unassigned_uses_active(db):
    p = await _plants(db)
    _, ctx = await _ctx(db, p["QM"])
    assert await adam._resolve_plant(None, db, ctx) == p["QM"].id


# ── _load: 404 across the boundary, visible within it ─────────────────────────

@with_session
async def test_load_404s_foreign_device(db):
    p = await _plants(db)
    dev = AdamDevice(id=uuid.uuid4(), name="probe", ip_address="10.0.0.9", plant_id=p["QS"].id)
    db.add(dev)
    await db.flush()

    _, ctx_qs = await _ctx(db, p["QS"])
    assert (await adam._load(dev.id, db, ctx_qs)).id == dev.id      # own plant: visible

    _, ctx_qm = await _ctx(db, p["QM"])
    with pytest.raises(HTTPException) as e:
        await adam._load(dev.id, db, ctx_qm)                        # foreign: 404
    assert e.value.status_code == 404


# ── list_*: only the active plant ─────────────────────────────────────────────

@with_session
async def test_adam_list_scoped_to_active_plant(db):
    p = await _plants(db)
    qm_dev = AdamDevice(id=uuid.uuid4(), name="qm-dev", ip_address="10.0.0.1", plant_id=p["QM"].id)
    qs_dev = AdamDevice(id=uuid.uuid4(), name="qs-dev", ip_address="10.0.0.2", plant_id=p["QS"].id)
    db.add_all([qm_dev, qs_dev])
    await db.flush()

    u, ctx_qm = await _ctx(db, p["QM"])
    ids = {d["id"] for d in await adam.list_devices(db=db, ctx=ctx_qm, current_user=u)}
    assert str(qm_dev.id) in ids
    assert str(qs_dev.id) not in ids, "QS device leaked into the QM list"


@with_session
async def test_cortex_list_scoped_to_active_plant(db):
    p = await _plants(db)
    qm_st = CortexStation(id=uuid.uuid4(), name="qm-st", station_key="k1", plant_id=p["QM"].id)
    qs_st = CortexStation(id=uuid.uuid4(), name="qs-st", station_key="k2", plant_id=p["QS"].id)
    db.add_all([qm_st, qs_st])
    await db.flush()

    u, ctx_qm = await _ctx(db, p["QM"])
    ids = {s["id"] for s in await cortex.list_stations(db=db, ctx=ctx_qm, current_user=u)}
    assert str(qm_st.id) in ids
    assert str(qs_st.id) not in ids, "QS station leaked into the QM list"
