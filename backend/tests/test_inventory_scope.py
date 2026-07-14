"""Inventory plant/group-segregation regression.
===============================================
Inventory is GROUP-scoped (QS+QM share the QC stock pool; NL is separate). The
list endpoints were scoped, but the stock-item / supplier detail + mutation
routes (get/update/adjust_quantity/delete) fetched by bare id with no group
check — a cross-group IDOR that let a caller read or even adjust another group's
stock quantities. Detail routes now guard with ensure_same_plant(grouped=True):

  · a QC caller cannot reach an NL stock item (different group) → 404
  · a QC caller CAN reach a sibling-plant item (QS<->QM share the pool)

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
from app.models.models import Plant, StockItem, User, UserPlant, UserRole  # noqa: E402
from app.api.routes.inventory import get_stock_item               # noqa: E402

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
    u = User(id=uuid.uuid4(), name=f"iv-{uuid.uuid4().hex[:6]}",
             email=f"iv-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.maintenance_director, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.maintenance_director, is_default=True))
    await db.flush()
    return u, await resolve_plant_context(db, u, None)


async def _item(db, plant):
    it = StockItem(id=uuid.uuid4(), plant_id=plant.id, code=f"P-{uuid.uuid4().hex[:6]}",
                   name="widget", quantity=5)
    db.add(it)
    await db.flush()
    return it


@with_session
async def test_get_item_blocks_other_group(db):
    p = await _plants(db)
    nl_item = await _item(db, p["NL"])
    u, ctx_qm = await _ctx(db, p["QM"])
    with pytest.raises(HTTPException) as e:
        await get_stock_item(nl_item.id, db=db, ctx=ctx_qm, current_user=u)
    assert e.value.status_code == 404


@with_session
async def test_get_item_allows_same_group(db):
    p = await _plants(db)
    qs_item = await _item(db, p["QS"])            # QS item…
    u, ctx_qm = await _ctx(db, p["QM"])           # …seen by a QM caller (shared QC pool)
    out = await get_stock_item(qs_item.id, db=db, ctx=ctx_qm, current_user=u)
    assert out["id"] == str(qs_item.id)
