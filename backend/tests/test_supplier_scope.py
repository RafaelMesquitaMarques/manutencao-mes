"""Suppliers & purchase-orders plant-segregation regression.
==========================================================
The /api/suppliers + /api/supplier-orders routers scoped their lists but the
detail/mutation routes fetched by bare id: suppliers (group-scoped, QC pool) and
purchase orders (plant-scoped — each Quebec plant keeps its own orders) were a
cross-boundary IDOR, incl. `receive` which mutates stock. Now:

  · _scoped_supplier 404s a supplier outside the caller's group; a sibling-plant
    supplier stays visible (QS<->QM share the pool)
  · _scoped_po 404s a purchase order owned by another plant (even a sibling)

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
    Plant, PurchaseOrder, Supplier, User, UserPlant, UserRole,
)
from app.api.routes.suppliers import _scoped_supplier, _scoped_po  # noqa: E402

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
    u = User(id=uuid.uuid4(), name=f"sp-{uuid.uuid4().hex[:6]}",
             email=f"sp-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.maintenance_director, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.maintenance_director, is_default=True))
    await db.flush()
    return await resolve_plant_context(db, u, None)


async def _supplier(db, plant):
    s = Supplier(id=uuid.uuid4(), plant_id=plant.id, name="ACME", code=f"S-{uuid.uuid4().hex[:6]}")
    db.add(s)
    await db.flush()
    return s


async def _po(db, plant, supplier):
    po = PurchaseOrder(id=uuid.uuid4(), order_number=f"PO-{uuid.uuid4().hex[:8]}",
                       supplier_id=supplier.id, plant_id=plant.id, order_date=date.today())
    db.add(po)
    await db.flush()
    return po


@with_session
async def test_supplier_blocks_other_group(db):
    p = await _plants(db)
    nl_sup = await _supplier(db, p["NL"])
    ctx_qm = await _ctx(db, p["QM"])
    with pytest.raises(HTTPException) as e:
        await _scoped_supplier(nl_sup.id, db, ctx_qm)
    assert e.value.status_code == 404


@with_session
async def test_supplier_allows_same_group(db):
    p = await _plants(db)
    qs_sup = await _supplier(db, p["QS"])
    ctx_qm = await _ctx(db, p["QM"])
    assert (await _scoped_supplier(qs_sup.id, db, ctx_qm)).id == qs_sup.id


@with_session
async def test_po_blocks_other_plant(db):
    p = await _plants(db)
    qs_sup = await _supplier(db, p["QS"])
    qs_po = await _po(db, p["QS"], qs_sup)
    ctx_qm = await _ctx(db, p["QM"])          # sibling QC plant, but POs are plant-scoped
    with pytest.raises(HTTPException) as e:
        await _scoped_po(qs_po.id, db, ctx_qm)
    assert e.value.status_code == 404


@with_session
async def test_po_visible_own_plant(db):
    p = await _plants(db)
    qm_sup = await _supplier(db, p["QM"])
    qm_po = await _po(db, p["QM"], qm_sup)
    ctx_qm = await _ctx(db, p["QM"])
    assert (await _scoped_po(qm_po.id, db, ctx_qm)).id == qm_po.id
