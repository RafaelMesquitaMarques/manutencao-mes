"""Custom-dashboard plant-segregation regression.
================================================
`/api/dashboards` listed and let any authenticated user open/edit/delete EVERY
plant's shared dashboards (no plant scope, no write guard). Dashboard carries
`plant_id`; create never set it and reads never filtered it. This locks it:

  · list_dashboards returns only the active plant's boards (NULL plant hidden)
  · _get 404s a board owned by another plant (never 403), visible within the plant

(The write guard — supervisor+ only — is wired in main.py and covered structurally
by test_wo_approval_scope's role_write_guard cases.)

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
from app.models.models import Dashboard, Plant, User, UserPlant, UserRole  # noqa: E402
from app.api.routes.dashboards import list_dashboards, _get       # noqa: E402

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


async def _ctx(db, plant):
    u = User(id=uuid.uuid4(), name=f"db-{uuid.uuid4().hex[:6]}",
             email=f"db-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.supervisor, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.supervisor, is_default=True))
    await db.flush()
    return u, await resolve_plant_context(db, u, None)


async def _dash(db, plant):
    d = Dashboard(id=uuid.uuid4(), slug=f"d-{uuid.uuid4().hex[:10]}",
                  name="board", is_shared=True, plant_id=plant.id, tiles=[])
    db.add(d)
    await db.flush()
    return d


@with_session
async def test_list_scoped_to_active_plant(db):
    p = await _plants(db)
    qm_d = await _dash(db, p["QM"])
    qs_d = await _dash(db, p["QS"])
    u, ctx_qm = await _ctx(db, p["QM"])

    ids = {str(d.id) for d in await list_dashboards(db=db, ctx=ctx_qm, user=u)}
    assert str(qm_d.id) in ids
    assert str(qs_d.id) not in ids, "QS dashboard leaked into the QM list"


@with_session
async def test_get_404s_foreign_dashboard(db):
    p = await _plants(db)
    qs_d = await _dash(db, p["QS"])
    u, ctx_qm = await _ctx(db, p["QM"])

    with pytest.raises(HTTPException) as e:
        await _get(qs_d.slug, db, ctx_qm)
    assert e.value.status_code == 404


@with_session
async def test_get_visible_within_plant(db):
    p = await _plants(db)
    qm_d = await _dash(db, p["QM"])
    u, ctx_qm = await _ctx(db, p["QM"])
    assert (await _get(qm_d.slug, db, ctx_qm)).id == qm_d.id
    assert (await _get(str(qm_d.id), db, ctx_qm)).id == qm_d.id      # by uuid too
