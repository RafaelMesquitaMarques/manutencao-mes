"""Stop-category cloning (POST /api/machines/clone-categories).
=================================================================
Cloning REPLACES the target's machine-specific categories — but stop history
(machine_stops) and cleaning checklists hold FK references to categories and
subcategories, so referenced rows can't be hard-deleted. The endpoint must
deactivate those (mirroring the single-category DELETE) instead of 500ing,
which is exactly the bug this file pins down.

Harness identical to test_operator_clone.py — INSIDE the backend container,
one shared loop, every write ALWAYS rolled back (the endpoint's commit is
downgraded to flush so the outer transaction stays open).
"""
import asyncio
import os
import sys
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                              # noqa: E402
from app.core.plant_context import resolve_plant_context          # noqa: E402
from app.models.models import (                                   # noqa: E402
    CleaningChecklist, Machine, MachineStop, Plant, StopCategory,
    StopCategoryType, StopSubcategory, User, UserPlant, UserRole,
)
from app.api.routes.machines import clone_categories              # noqa: E402
from app.schemas.maintenance import CloneCategoriesRequest        # noqa: E402

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
            s.commit = s.flush  # endpoint commits; keep it inside the rolled-back txn
            try:
                await fn(s)
            finally:
                await s.rollback()
                await s.close()
        _LOOP.run_until_complete(runner())
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


async def _plant(db):
    p = (await db.execute(select(Plant).where(Plant.code == "QS"))).scalar_one_or_none()
    assert p, "live plant QS must exist"
    return p


async def _ctx(db, plant):
    u = User(id=uuid.uuid4(), name=f"cc-{uuid.uuid4().hex[:6]}",
             email=f"cc-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.maintenance_director, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.maintenance_director, is_default=True))
    await db.flush()
    return await resolve_plant_context(db, u, None)


async def _machine(db, plant):
    m = Machine(name=f"TEST-CC-{uuid.uuid4().hex[:8]}", plant_id=plant.id)
    db.add(m)
    await db.flush()
    return m


async def _category(db, machine, name, *, subs=()):
    cat = StopCategory(machine_id=machine.id, name=name,
                       type=StopCategoryType.planned, icon="wrench", color="#123456")
    db.add(cat)
    await db.flush()
    for sname in subs:
        db.add(StopSubcategory(category_id=cat.id, name=sname, icon="wrench"))
    await db.flush()
    return cat


async def _target_cats(db, machine):
    return (await db.execute(
        select(StopCategory).where(StopCategory.machine_id == machine.id)
    )).scalars().all()


@with_session
async def test_clone_replaces_unreferenced_categories(db):
    """No history on the target → its old set is hard-deleted and the source's
    categories (with subcategories) land in its place."""
    p = await _plant(db)
    ctx = await _ctx(db, p)
    src, tgt = await _machine(db, p), await _machine(db, p)
    await _category(db, src, "Planned Stop", subs=("Nettoyage", "Setup"))
    await _category(db, src, "Unplanned Stop")
    old = await _category(db, tgt, "Old Reason", subs=("Old Sub",))

    res = await clone_categories(
        CloneCategoriesRequest(source_machine_id=src.id, target_machine_ids=[tgt.id],
                               category_type="stop"),
        db=db, ctx=ctx,
    )
    assert res["cloned_to"] == 1

    rows = await _target_cats(db, tgt)
    assert sorted(c.name for c in rows) == ["Planned Stop", "Unplanned Stop"]
    assert all(c.is_active for c in rows)
    assert old.id not in {c.id for c in rows}, "unreferenced old category must be gone"
    planned = next(c for c in rows if c.name == "Planned Stop")
    subs = (await db.execute(
        select(StopSubcategory).where(StopSubcategory.category_id == planned.id)
    )).scalars().all()
    assert sorted(s.name for s in subs) == ["Nettoyage", "Setup"]


@with_session
async def test_clone_deactivates_referenced_categories(db):
    """The user's bug: target categories referenced by stop history or a cleaning
    checklist made the whole clone 500 on the FK. They must be deactivated (kept
    for history) while the cloned set arrives active."""
    p = await _plant(db)
    ctx = await _ctx(db, p)
    src, tgt = await _machine(db, p), await _machine(db, p)
    await _category(db, src, "Planned Stop", subs=("Nettoyage",))

    with_stop = await _category(db, tgt, "Nettoyage")            # referenced by a stop
    with_checklist = await _category(db, tgt, "Entretien", subs=("Graissage",))
    sub = (await db.execute(
        select(StopSubcategory).where(StopSubcategory.category_id == with_checklist.id)
    )).scalar_one()
    free = await _category(db, tgt, "Libre")                     # unreferenced

    db.add(MachineStop(machine_id=tgt.id, plant_id=p.id, stop_category_id=with_stop.id))
    db.add(CleaningChecklist(plant_id=p.id, stop_subcategory_id=sub.id, name="CC test"))
    await db.flush()

    res = await clone_categories(
        CloneCategoriesRequest(source_machine_id=src.id, target_machine_ids=[tgt.id],
                               category_type="stop"),
        db=db, ctx=ctx,
    )
    assert res["cloned_to"] == 1

    rows = await _target_cats(db, tgt)
    by_id = {c.id: c for c in rows}
    assert with_stop.id in by_id and by_id[with_stop.id].is_active is False
    assert with_checklist.id in by_id and by_id[with_checklist.id].is_active is False
    assert free.id not in by_id, "unreferenced old category must be hard-deleted"
    active = [c for c in rows if c.is_active]
    assert [c.name for c in active] == ["Planned Stop"], "cloned set is the active one"
