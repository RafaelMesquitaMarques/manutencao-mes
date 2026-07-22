"""Machine-operator cloning (POST /api/machines/clone-operators).
================================================================
The endpoint MERGES operators into targets (never deletes — stop history
references operator rows) and skips duplicates by active name/employee code,
case-insensitively. `operator_ids` narrows the copy to a subset (the
"also add this new operator to other machines" flow). Plant-guarded on both
ends: a source or target outside the caller's plant 404s.

Harness identical to test_plant_segregation.py — INSIDE the backend container,
one shared loop, every write ALWAYS rolled back (the endpoint's commit is
downgraded to flush so the outer transaction stays open).
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
    Machine, MachineOperator, OperatorShift, Plant, User, UserPlant, UserRole,
)
from app.api.routes.machines import clone_operators               # noqa: E402
from app.schemas.maintenance import CloneOperatorsRequest         # noqa: E402

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


async def _plants(db):
    rows = (await db.execute(select(Plant).where(Plant.code.in_(["QS", "QM"])))).scalars().all()
    by_code = {p.code: p for p in rows}
    assert set(by_code) == {"QS", "QM"}, "live plants QS/QM must exist"
    return by_code


async def _ctx(db, plant):
    u = User(id=uuid.uuid4(), name=f"oc-{uuid.uuid4().hex[:6]}",
             email=f"oc-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.maintenance_director, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.maintenance_director, is_default=True))
    await db.flush()
    return await resolve_plant_context(db, u, None)


async def _machine(db, plant):
    m = Machine(name=f"TEST-OC-{uuid.uuid4().hex[:8]}", plant_id=plant.id)
    db.add(m)
    await db.flush()
    return m


async def _operator(db, machine, name, *, code=None, active=True, shift=OperatorShift.all):
    op = MachineOperator(machine_id=machine.id, plant_id=machine.plant_id,
                         name=name, employee_code=code, shift=shift, is_active=active)
    db.add(op)
    await db.flush()
    return op


async def _target_ops(db, machine):
    return (await db.execute(
        select(MachineOperator).where(MachineOperator.machine_id == machine.id)
    )).scalars().all()


@with_session
async def test_clone_merges_and_skips_duplicates(db):
    """Active source operators land on the target; the target's own operators
    survive; same-name (case-insensitive) and inactive ones are not copied."""
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    src, tgt = await _machine(db, p["QS"]), await _machine(db, p["QS"])

    await _operator(db, src, "Alice Martin", code="E100", shift=OperatorShift.morning)
    await _operator(db, src, "Bob Tremblay", code="E200")
    await _operator(db, src, "Gone Guy", active=False)
    kept = await _operator(db, tgt, "ALICE MARTIN", code="E999")   # same name, different case
    own  = await _operator(db, tgt, "Target Own", code="E300")

    res = await clone_operators(
        CloneOperatorsRequest(source_machine_id=src.id, target_machine_ids=[tgt.id]),
        db=db, ctx=ctx,
    )
    assert res["created"] == 1 and res["skipped"] == 1 and res["cloned_to"] == 1

    rows = await _target_ops(db, tgt)
    names = sorted(o.name for o in rows)
    assert names == ["ALICE MARTIN", "Bob Tremblay", "Target Own"]
    assert {kept.id, own.id} <= {o.id for o in rows}, "existing target operators must survive"
    bob = next(o for o in rows if o.name == "Bob Tremblay")
    assert bob.employee_code == "E200" and bob.shift == OperatorShift.all
    assert bob.plant_id == tgt.plant_id


@with_session
async def test_clone_dedupes_by_employee_code(db):
    """Different name but same employee code on the target → skipped."""
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    src, tgt = await _machine(db, p["QS"]), await _machine(db, p["QS"])
    await _operator(db, src, "Carla Nova", code="E777")
    await _operator(db, tgt, "Carla N. (married name)", code="e777")

    res = await clone_operators(
        CloneOperatorsRequest(source_machine_id=src.id, target_machine_ids=[tgt.id]),
        db=db, ctx=ctx,
    )
    assert res["created"] == 0 and res["skipped"] == 1
    assert len(await _target_ops(db, tgt)) == 1


@with_session
async def test_clone_subset_and_self_target(db):
    """operator_ids narrows the copy; the source itself in the targets is a no-op."""
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    src, t1, t2 = (await _machine(db, p["QS"]), await _machine(db, p["QS"]),
                   await _machine(db, p["QS"]))
    await _operator(db, src, "Not This One")
    pick = await _operator(db, src, "Only Me", code="E42", shift=OperatorShift.night)

    res = await clone_operators(
        CloneOperatorsRequest(source_machine_id=src.id,
                              target_machine_ids=[t1.id, t2.id, src.id],
                              operator_ids=[pick.id]),
        db=db, ctx=ctx,
    )
    assert res["created"] == 2 and res["cloned_to"] == 2

    for tgt in (t1, t2):
        rows = await _target_ops(db, tgt)
        assert [o.name for o in rows] == ["Only Me"]
        assert rows[0].shift == OperatorShift.night
    assert len(await _target_ops(db, src)) == 2, "source machine must be untouched"


@with_session
async def test_clone_cross_plant_404(db):
    """Neither source nor target may sit outside the caller's plant."""
    p = await _plants(db)
    ctx_qs = await _ctx(db, p["QS"])
    qs_m, qm_m = await _machine(db, p["QS"]), await _machine(db, p["QM"])
    await _operator(db, qs_m, "Leak Probe")

    with pytest.raises(HTTPException) as e:
        await clone_operators(
            CloneOperatorsRequest(source_machine_id=qs_m.id, target_machine_ids=[qm_m.id]),
            db=db, ctx=ctx_qs,
        )
    assert e.value.status_code == 404

    with pytest.raises(HTTPException) as e:
        await clone_operators(
            CloneOperatorsRequest(source_machine_id=qm_m.id, target_machine_ids=[qs_m.id]),
            db=db, ctx=ctx_qs,
        )
    assert e.value.status_code == 404
    assert await _target_ops(db, qm_m) == []
