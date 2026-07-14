"""WO-Approval queue plant-segregation regression.
=================================================
The approval queue (`/api/wo-approval`) unifies floor interventions and office
work orders into one sign-off list. Before the fix it was mounted with NO plant
dependency and its `/pending` query was unscoped, so any authenticated user saw —
and could approve/reject/edit the parts of — another plant's completed work
(mutating that plant's inventory). This locks the boundary:

  · list_pending returns ONLY the active plant's pending work
  · no foreign-plant pending record leaks into the queue
  · path_plant_guard 404s a member route addressed at a foreign record
    (both the intervention and the work-order id params)

Same harness as test_plant_segregation.py: runs INSIDE the backend container,
one shared event loop, every write ALWAYS rolled back. Assertions are structural
(ownership of returned rows), never fixed counts — they hold as data grows.

Run (inside the backend container):
    pytest tests/test_wo_approval_scope.py -v
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
from app.core.permissions import role_write_guard                 # noqa: E402
from app.api.routes.wo_approval import list_pending               # noqa: E402
from app.models.models import (                                   # noqa: E402
    MachineIntervention, Plant, User, UserPlant, UserRole, WorkOrder,
    WorkOrderStatus,
)

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


async def _mk_user(db, role=UserRole.supervisor):
    u = User(id=uuid.uuid4(), name=f"wa-{uuid.uuid4().hex[:6]}",
             email=f"wa-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=role, active=True)
    db.add(u)
    await db.flush()
    return u


async def _member(db, user, plant, role, default=False):
    db.add(UserPlant(user_id=user.id, plant_id=plant.id, role=role, is_default=default))
    await db.flush()


class _Req:
    def __init__(self, params=None, method="POST"):
        self.path_params = params or {}
        self.method = method


# ── the queue is scoped to the active plant ───────────────────────────────────

@with_session
async def test_pending_queue_scoped_to_active_plant(db):
    p = await _plants(db)
    u = await _mk_user(db)
    await _member(db, u, p["QM"], UserRole.supervisor, default=True)
    ctx = await resolve_plant_context(db, u, None)

    result = await list_pending(db=db, ctx=ctx, current_user=u)
    returned_ids = {i["id"] for i in result["items"]}

    # every returned row belongs to QM
    for item in result["items"]:
        model = MachineIntervention if item["source"] == "intervention" else WorkOrder
        rec = await db.get(model, uuid.UUID(item["id"]))
        assert rec is not None and rec.plant_id == p["QM"].id, "queue leaked a foreign plant"

    # no QS-owned pending record may appear in a QM queue (holds even at 0 QM rows)
    qs_intv = (await db.execute(
        select(MachineIntervention.id).where(
            MachineIntervention.plant_id == p["QS"].id,
            MachineIntervention.status == "completed",
            MachineIntervention.approval_status == "pending",
        )
    )).scalars().all()
    qs_wo = (await db.execute(
        select(WorkOrder.id).where(
            WorkOrder.plant_id == p["QS"].id,
            WorkOrder.status == WorkOrderStatus.completed,
            WorkOrder.approval_status == "pending",
        )
    )).scalars().all()
    foreign = {str(i) for i in qs_intv} | {str(i) for i in qs_wo}
    assert returned_ids.isdisjoint(foreign), "QS pending work leaked into the QM queue"


# ── member routes 404 a foreign record ────────────────────────────────────────

@with_session
async def test_guard_404s_foreign_intervention(db):
    p = await _plants(db)
    u = await _mk_user(db)
    await _member(db, u, p["QM"], UserRole.supervisor, default=True)
    ctx = await resolve_plant_context(db, u, None)

    qs = (await db.execute(
        select(MachineIntervention).where(MachineIntervention.plant_id == p["QS"].id).limit(1)
    )).scalars().first()
    if qs is None:
        pytest.skip("no QS intervention in the live DB to probe")

    guard = path_plant_guard(MachineIntervention, "intervention_id", detail="Work order not found")
    with pytest.raises(HTTPException) as e:
        await guard(_Req({"intervention_id": str(qs.id)}), ctx, db)
    assert e.value.status_code == 404          # never 403: no existence confirmation


@with_session
async def test_guard_404s_foreign_work_order(db):
    p = await _plants(db)
    u = await _mk_user(db)
    await _member(db, u, p["QM"], UserRole.supervisor, default=True)
    ctx = await resolve_plant_context(db, u, None)

    qs = (await db.execute(
        select(WorkOrder).where(WorkOrder.plant_id == p["QS"].id).limit(1)
    )).scalars().first()
    if qs is None:
        pytest.skip("no QS work order in the live DB to probe")

    guard = path_plant_guard(WorkOrder, "work_order_id", detail="Work order not found")
    with pytest.raises(HTTPException) as e:
        await guard(_Req({"work_order_id": str(qs.id)}), ctx, db)
    assert e.value.status_code == 404


# ── only a supervisor+ may approve (no operator/technician self-approval) ──────

_APPROVER_ROLES = (UserRole.supervisor, UserRole.maintenance_director,
                    UserRole.plant_manager, UserRole.director)


@with_session
async def test_operator_and_technician_cannot_approve(db):
    guard = role_write_guard(*_APPROVER_ROLES)
    for role in (UserRole.operator, UserRole.technician):
        u = await _mk_user(db, role)
        with pytest.raises(HTTPException) as e:
            await guard(_Req(method="POST"), u)
        assert e.value.status_code == 403


@with_session
async def test_supervisor_and_admin_may_approve(db):
    guard = role_write_guard(*_APPROVER_ROLES)
    for role in (UserRole.supervisor, UserRole.maintenance_director, UserRole.admin):
        u = await _mk_user(db, role)
        assert await guard(_Req(method="POST"), u) is None      # no raise = allowed


@with_session
async def test_reads_pass_for_any_role(db):
    guard = role_write_guard(*_APPROVER_ROLES)
    u = await _mk_user(db, UserRole.operator)
    assert await guard(_Req(method="GET"), u) is None
