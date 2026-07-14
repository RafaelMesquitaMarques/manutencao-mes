"""Technician plant-segregation regression.
=========================================
list_technicians was already plant-scoped, but the technician DETAIL/mutation
routes and the whole unavailability sub-resource fetched by bare id with no
plant check — leaking (and letting a foreign plant edit/delete) a technician's
profile incl. hourly_rate, plus their vacation/absence calendar. A technician
"belongs" to the plants their USER holds membership in. This locks it:

  · _scoped_technician 404s a technician on another plant (never 403)
  · list_all_unavailability returns only technicians on the active plant

Harness identical to test_plant_segregation.py — INSIDE the backend container,
one shared loop, every write ALWAYS rolled back (flush only, never commit).
"""
import asyncio
import os
import sys
import uuid
from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                              # noqa: E402
from app.core.plant_context import resolve_plant_context          # noqa: E402
from app.models.models import (                                   # noqa: E402
    Plant, Technician, TechnicianUnavailability, User, UserPlant, UserRole,
)
from app.api.routes.technicians import _scoped_technician, list_all_unavailability  # noqa: E402

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


async def _tech(db, plant):
    u = User(id=uuid.uuid4(), name=f"tn-{uuid.uuid4().hex[:6]}",
             email=f"tn-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.technician, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.technician, is_default=True))
    t = Technician(id=uuid.uuid4(), user_id=u.id, active=True)
    db.add(t)
    await db.flush()
    return u, t


async def _ctx_for(db, user):
    return await resolve_plant_context(db, user, None)


@with_session
async def test_scoped_technician_404s_foreign(db):
    p = await _plants(db)
    qs_u, qs_t = await _tech(db, p["QS"])
    qm_u, qm_t = await _tech(db, p["QM"])

    # QS user sees the QS technician…
    assert (await _scoped_technician(qs_t.id, db, await _ctx_for(db, qs_u))).id == qs_t.id
    # …but never the QM technician (profile carries hourly_rate).
    with pytest.raises(HTTPException) as e:
        await _scoped_technician(qm_t.id, db, await _ctx_for(db, qs_u))
    assert e.value.status_code == 404


@with_session
async def test_all_unavailability_scoped_to_active_plant(db):
    p = await _plants(db)
    qs_u, qs_t = await _tech(db, p["QS"])
    qm_u, qm_t = await _tech(db, p["QM"])
    qs_ua = TechnicianUnavailability(id=uuid.uuid4(), technician_id=qs_t.id,
                                     start_date=date(2026, 7, 1), end_date=date(2026, 7, 5))
    qm_ua = TechnicianUnavailability(id=uuid.uuid4(), technician_id=qm_t.id,
                                     start_date=date(2026, 7, 1), end_date=date(2026, 7, 5))
    db.add_all([qs_ua, qm_ua])
    await db.flush()

    ctx_qm = await _ctx_for(db, qm_u)
    rows = await list_all_unavailability(
        technician_id=None, date_from=None, date_to=None,
        db=db, ctx=ctx_qm, current_user=qm_u,
    )
    ids = {str(r.id) for r in rows}
    assert str(qm_ua.id) in ids
    assert str(qs_ua.id) not in ids, "QS technician's unavailability leaked into the QM calendar"
