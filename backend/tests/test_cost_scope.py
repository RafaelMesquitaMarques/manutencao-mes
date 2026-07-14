"""Costs plant-segregation regression (summary + budgets).
========================================================
The detailed cost reports were already site-scoped via _resolve_site, but
/summary and /budgets aggregated globally — an NL cost-viewer could read the
Québec cost universe, and the budget was a single global series. Now:

  · _resolve_site refuses a plant outside the QS/QM cost universe (e.g. NL) and
    locks a single-site user to their own site
  · _budgets_for is keyed by plant (shared NULL row = the combined QS+QM view),
    falling back to the shared row when a site has no budget of its own

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
from app.models.models import (                                   # noqa: E402
    MaintenanceBudget, Plant, User, UserPlant, UserRole,
)
from app.api.routes.costs import _resolve_site, _budgets_for, _site_ids  # noqa: E402

_LOOP = asyncio.new_event_loop()
_ENGINE = {}
_YEAR = 2099


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
    u = User(id=uuid.uuid4(), name=f"co-{uuid.uuid4().hex[:6]}",
             email=f"co-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.plant_manager, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.plant_manager, is_default=True))
    await db.flush()
    return await resolve_plant_context(db, u, None)


@with_session
async def test_resolve_site_refuses_non_quebec_plant(db):
    p = await _plants(db)
    ctx_nl = await _ctx(db, p["NL"])
    with pytest.raises(HTTPException) as e:
        await _resolve_site(db, ctx_nl, None)
    assert e.value.status_code == 403


@with_session
async def test_resolve_site_locks_single_site(db):
    p = await _plants(db)
    ctx_qs = await _ctx(db, p["QS"])
    assert await _resolve_site(db, ctx_qs, None) == "QS"       # defaults to own site
    with pytest.raises(HTTPException) as e:
        await _resolve_site(db, ctx_qs, "QM")                  # can't peek at the other site
    assert e.value.status_code == 403


@with_session
async def test_budgets_keyed_by_plant(db):
    p = await _plants(db)
    site_ids = await _site_ids(db)
    db.add(MaintenanceBudget(id=uuid.uuid4(), year=_YEAR, month=1, amount=100.0, plant_id=None))
    db.add(MaintenanceBudget(id=uuid.uuid4(), year=_YEAR, month=1, amount=200.0, plant_id=site_ids["QM"]))
    await db.flush()

    assert (await _budgets_for(db, _YEAR, None)).get(1) == 100.0            # shared / combined
    assert (await _budgets_for(db, _YEAR, site_ids["QM"])).get(1) == 200.0  # QM-specific


@with_session
async def test_budgets_fall_back_to_shared(db):
    p = await _plants(db)
    site_ids = await _site_ids(db)
    db.add(MaintenanceBudget(id=uuid.uuid4(), year=_YEAR, month=2, amount=150.0, plant_id=None))
    await db.flush()
    # QS has no budget of its own → falls back to the shared row.
    assert (await _budgets_for(db, _YEAR, site_ids["QS"])).get(2) == 150.0
