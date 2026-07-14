"""Settings routers plant-segregation regression (intervention types + checklists).
==================================================================================
The per-machine config routers keyed everything on equipment_id / type_id with no
plant check — a caller could read/edit another plant's intervention types and
safety/cleaning checklists. This locks it:

  · list_types is plant_scoped (active plant only)
  · the equipment guard used by the checklist routers 404s a foreign equipment

Harness identical to test_plant_segregation.py — INSIDE the backend container,
one shared loop, every write ALWAYS rolled back (flush only, never commit).
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
from app.core.plant_scope import path_plant_guard                 # noqa: E402
from app.models.models import (                                   # noqa: E402
    Equipment, InterventionType, Plant, User, UserPlant, UserRole,
)
from app.api.routes.intervention_type_settings import list_types  # noqa: E402

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


class _Req:
    def __init__(self, params):
        self.path_params = params


async def _plants(db):
    rows = (await db.execute(select(Plant).where(Plant.code.in_(["QS", "QM", "NL"])))).scalars().all()
    by_code = {p.code: p for p in rows}
    assert set(by_code) == {"QS", "QM", "NL"}, "live plants QS/QM/NL must exist"
    return by_code


async def _ctx(db, plant):
    u = User(id=uuid.uuid4(), name=f"st-{uuid.uuid4().hex[:6]}",
             email=f"st-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.maintenance_director, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.maintenance_director, is_default=True))
    await db.flush()
    return u, await resolve_plant_context(db, u, None)


@with_session
async def test_intervention_types_list_scoped(db):
    p = await _plants(db)
    qm_t = InterventionType(id=uuid.uuid4(), name="qm-type", plant_id=p["QM"].id, is_active=True, sort_order=0)
    qs_t = InterventionType(id=uuid.uuid4(), name="qs-type", plant_id=p["QS"].id, is_active=True, sort_order=0)
    db.add_all([qm_t, qs_t])
    await db.flush()

    u, ctx_qm = await _ctx(db, p["QM"])
    ids = {i["id"] for i in (await list_types(equipment_id=None, db=db, ctx=ctx_qm, current_user=u))["items"]}
    assert str(qm_t.id) in ids
    assert str(qs_t.id) not in ids, "QS intervention type leaked into the QM list"


@with_session
async def test_equipment_guard_404s_foreign(db):
    p = await _plants(db)
    qs_equip = (await db.execute(
        select(Equipment).where(Equipment.plant_id == p["QS"].id).limit(1)
    )).scalars().first()
    if qs_equip is None:
        pytest.skip("no QS equipment to probe")

    u, ctx_qm = await _ctx(db, p["QM"])
    guard = path_plant_guard(Equipment, "equipment_id", detail="Equipment not found")
    with pytest.raises(HTTPException) as e:
        await guard(_Req({"equipment_id": str(qs_equip.id)}), ctx_qm, db)
    assert e.value.status_code == 404
