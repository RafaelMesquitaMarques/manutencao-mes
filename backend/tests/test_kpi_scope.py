"""KPI machine/department scope resolution.
=========================================
The KPIs page moved from one machine at a time to any number of machines plus a
department filter, so `_resolve_scope` is now the single place that decides what
a KPI request covers. What matters here:

  · a pick made in the Equipment-driven picker resolves to the MACHINE row too
    (their UUIDs differ for most assets, and stops/production logs are keyed by
    machine — that translation is what makes OEE non-empty for a picked machine)
  · machines and departments AND together (departments narrow, ids narrow more)
  · a scope that resolves to nothing filters everything out — never a silent
    fallback to the whole plant
  · a machine/equipment id from another plant 404s like a bogus id, and a
    department name shared with another plant never pulls that plant's rows in

Harness identical to test_cost_scope.py — INSIDE the backend container, one
shared loop, every write ALWAYS rolled back (flush only, never commit).
"""
import asyncio
import os
import sys
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                              # noqa: E402
from app.core.plant_context import resolve_plant_context          # noqa: E402
from app.models.models import (                                   # noqa: E402
    Equipment, Machine, MachineStop, Plant, User, UserPlant, UserRole, WorkOrder,
)
from app.api.routes.kpis import (                                 # noqa: E402
    _machine_cond, _machine_side_cond, _resolve_scope, _scope_mids,
)

_LOOP = asyncio.new_event_loop()
_ENGINE = {}
_DEPT = "ZZ-KPI-Test-Dept"
_OTHER_DEPT = "ZZ-KPI-Other-Dept"


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
    rows = (await db.execute(select(Plant).where(Plant.code.in_(["QS", "QM"])))).scalars().all()
    by_code = {p.code: p for p in rows}
    assert set(by_code) == {"QS", "QM"}, "live plants QS/QM must exist"
    return by_code


async def _ctx(db, plant):
    u = User(id=uuid.uuid4(), name=f"kpi-{uuid.uuid4().hex[:6]}",
             email=f"kpi-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.plant_manager, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.plant_manager, is_default=True))
    await db.flush()
    return await resolve_plant_context(db, u, None)


async def _asset(db, plant, dept, *, machine_dept=None):
    """An equipment plus its machine row, with DIFFERENT ids — the shape almost
    every real asset has (only auto-provisioned ones share the UUID)."""
    tag = uuid.uuid4().hex[:8]
    eq = Equipment(id=uuid.uuid4(), plant_id=plant.id, code=f"ZZ-{tag}",
                   name=f"zz-asset-{tag}", department=dept, asset_type="production",
                   active=True)
    db.add(eq)
    await db.flush()
    m = Machine(id=uuid.uuid4(), name=eq.name, plant_id=plant.id, equipment_id=eq.id,
                department=machine_dept, is_active=True)
    db.add(m)
    await db.flush()
    return eq, m


@with_session
async def test_no_filter_means_whole_plant(db):
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    assert await _resolve_scope(db, None, None, ctx) is None
    assert await _resolve_scope(db, [], [], ctx) is None
    assert _scope_mids(None) is None


@with_session
async def test_equipment_pick_resolves_its_machine_row(db):
    """The picker hands over an EQUIPMENT id; stops/production logs are keyed by
    machine, so the machine side has to come along or OEE reads empty."""
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    eq, m = await _asset(db, p["QS"], _DEPT)
    assert eq.id != m.id

    scope = await _resolve_scope(db, [eq.id], None, ctx)
    assert m.id in scope.machines and eq.id in scope.equipment

    # A machine id given directly resolves the same pair.
    scope = await _resolve_scope(db, [m.id], None, ctx)
    assert m.id in scope.machines and eq.id in scope.equipment


@with_session
async def test_several_machines_are_all_in_scope(db):
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    eq_a, m_a = await _asset(db, p["QS"], _DEPT)
    eq_b, m_b = await _asset(db, p["QS"], _OTHER_DEPT)

    scope = await _resolve_scope(db, [eq_a.id, eq_b.id], None, ctx)
    assert {m_a.id, m_b.id} <= scope.machines
    assert {eq_a.id, eq_b.id} <= scope.equipment


@with_session
async def test_department_pulls_its_assets_both_sides(db):
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    eq_a, m_a = await _asset(db, p["QS"], _DEPT)                          # dept on equipment
    eq_b, m_b = await _asset(db, p["QS"], None, machine_dept=_DEPT)        # dept on machine only
    eq_c, m_c = await _asset(db, p["QS"], _OTHER_DEPT)                     # elsewhere

    scope = await _resolve_scope(db, None, [_DEPT], ctx)
    assert {m_a.id, m_b.id} <= scope.machines
    assert {eq_a.id, eq_b.id} <= scope.equipment
    assert m_c.id not in scope.machines and eq_c.id not in scope.equipment


@with_session
async def test_machines_and_departments_are_anded(db):
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    eq_a, m_a = await _asset(db, p["QS"], _DEPT)
    eq_b, _m_b = await _asset(db, p["QS"], _OTHER_DEPT)

    # Machine inside the department: kept.
    scope = await _resolve_scope(db, [eq_a.id], [_DEPT], ctx)
    assert scope.machines == {m_a.id}

    # Machine outside it: the intersection is empty, and an empty scope must
    # filter everything out instead of falling back to the plant.
    scope = await _resolve_scope(db, [eq_b.id], [_DEPT], ctx)
    assert not scope.any
    total = (await db.execute(
        select(func.count(WorkOrder.id)).where(WorkOrder.plant_id == p["QS"].id)
    )).scalar()
    scoped = (await db.execute(
        select(func.count(WorkOrder.id)).where(_machine_cond(scope, ctx))
    )).scalar()
    assert total > 0 and scoped == 0


@with_session
async def test_other_plant_id_404s(db):
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    eq_qm, m_qm = await _asset(db, p["QM"], _DEPT)

    for probe in ([eq_qm.id], [m_qm.id], [uuid.uuid4(), eq_qm.id]):
        with pytest.raises(HTTPException) as e:
            await _resolve_scope(db, probe, None, ctx)
        assert e.value.status_code == 404


@with_session
async def test_department_never_crosses_plants(db):
    """Department names are per-plant strings — the same name in two plants must
    not merge their machines."""
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    eq_qs, m_qs = await _asset(db, p["QS"], _DEPT)
    eq_qm, m_qm = await _asset(db, p["QM"], _DEPT)

    scope = await _resolve_scope(db, None, [_DEPT], ctx)
    assert m_qs.id in scope.machines and eq_qs.id in scope.equipment
    assert m_qm.id not in scope.machines and eq_qm.id not in scope.equipment


@with_session
async def test_unknown_id_yields_empty_not_plant_wide(db):
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    scope = await _resolve_scope(db, [uuid.uuid4()], None, ctx)
    assert not scope.any and _scope_mids(scope) == []
    scoped = (await db.execute(
        select(func.count(WorkOrder.id)).where(_machine_cond(scope, ctx))
    )).scalar()
    assert scoped == 0


@with_session
async def test_machine_side_cond_uses_machine_ids(db):
    """Stops/production logs filter on the machine row, not the equipment id."""
    p = await _plants(db)
    ctx = await _ctx(db, p["QS"])
    eq, m = await _asset(db, p["QS"], _DEPT)
    scope = await _resolve_scope(db, [eq.id], None, ctx)
    sql = str(_machine_side_cond(MachineStop, scope, ctx).compile(
        compile_kwargs={"literal_binds": True}))
    assert m.id.hex in sql and eq.id.hex not in sql    # literals render dashless
