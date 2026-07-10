"""
DB-facing integration tests for the plant context (multi-plant phase 0).
========================================================================
Exercise `resolve_plant_context` — membership resolution, default plant,
X-Plant-Id validation, corporate admin expansion — against real rows.

Same harness as test_labor_integration.py: they run INSIDE the backend
container, each test drives its async body on one shared event loop, and every
write happens in a transaction that is ALWAYS rolled back — the database is
never mutated.

Run (inside the backend container):
    pip install pytest
    pytest tests/test_plant_context.py -v
"""
import asyncio
import os
import sys
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                              # noqa: E402
from app.core.plant_context import (                              # noqa: E402
    ERR_NO_PLANT_ACCESS, ERR_PLANT_NOT_AUTHORIZED, resolve_plant_context,
)
from app.models.models import Plant, User, UserPlant, UserRole    # noqa: E402

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    """Run the async test body in a transaction that is always rolled back.

    NOTE: deliberately NOT functools.wraps — it sets ``__wrapped__``, which
    pytest follows back to the original async function (same convention as
    test_labor_integration.py). Name/doc are copied by hand."""
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


async def _mk_plant(db, code, name):
    p = Plant(id=uuid.uuid4(), code=code, name=name, active=True)
    db.add(p)
    await db.flush()
    return p


async def _mk_user(db, role):
    u = User(
        id=uuid.uuid4(), name=f"t-{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:12]}@test.local",
        password_hash="x", role=role, active=True,
    )
    db.add(u)
    await db.flush()
    return u


async def _link(db, user, plant, role, is_default=False):
    l = UserPlant(user_id=user.id, plant_id=plant.id, role=role, is_default=is_default)
    db.add(l)
    await db.flush()
    return l


@with_session
async def test_single_membership_resolves_default(db):
    plant = await _mk_plant(db, f"T{uuid.uuid4().hex[:6]}", "Test Plant A")
    user = await _mk_user(db, UserRole.technician)
    await _link(db, user, plant, UserRole.supervisor, is_default=True)

    ctx = await resolve_plant_context(db, user, None)
    assert ctx.plant_id == plant.id
    assert ctx.role == UserRole.supervisor          # per-plant role, not the global one
    assert ctx.allowed_plant_ids == frozenset({plant.id})
    assert not ctx.is_corporate
    assert ctx.can_access(plant.id)


@with_session
async def test_multi_membership_default_and_switch(db):
    p1 = await _mk_plant(db, f"T{uuid.uuid4().hex[:6]}", "Plant One")
    p2 = await _mk_plant(db, f"T{uuid.uuid4().hex[:6]}", "Plant Two")
    user = await _mk_user(db, UserRole.supervisor)
    await _link(db, user, p1, UserRole.supervisor, is_default=False)
    await _link(db, user, p2, UserRole.technician, is_default=True)

    # No header → the default membership wins even if it isn't the oldest.
    ctx = await resolve_plant_context(db, user, None)
    assert ctx.plant_id == p2.id
    assert ctx.role == UserRole.technician

    # Explicit header switches to the other authorized plant — role follows.
    ctx = await resolve_plant_context(db, user, str(p1.id))
    assert ctx.plant_id == p1.id
    assert ctx.role == UserRole.supervisor
    assert ctx.allowed_plant_ids == frozenset({p1.id, p2.id})


@with_session
async def test_unauthorized_plant_rejected(db):
    p1 = await _mk_plant(db, f"T{uuid.uuid4().hex[:6]}", "Mine")
    p2 = await _mk_plant(db, f"T{uuid.uuid4().hex[:6]}", "Not Mine")
    user = await _mk_user(db, UserRole.technician)
    await _link(db, user, p1, UserRole.technician, is_default=True)

    with pytest.raises(HTTPException) as exc:
        await resolve_plant_context(db, user, str(p2.id))
    assert exc.value.status_code == 403
    assert exc.value.detail == ERR_PLANT_NOT_AUTHORIZED
    ctx = await resolve_plant_context(db, user, None)
    assert not ctx.can_access(p2.id)                # detail routes → 404 path


@with_session
async def test_garbage_header_rejected(db):
    p1 = await _mk_plant(db, f"T{uuid.uuid4().hex[:6]}", "Mine")
    user = await _mk_user(db, UserRole.technician)
    await _link(db, user, p1, UserRole.technician, is_default=True)

    with pytest.raises(HTTPException) as exc:
        await resolve_plant_context(db, user, "not-a-uuid")
    assert exc.value.status_code == 403
    assert exc.value.detail == ERR_PLANT_NOT_AUTHORIZED


@with_session
async def test_no_membership_denied(db):
    user = await _mk_user(db, UserRole.technician)
    with pytest.raises(HTTPException) as exc:
        await resolve_plant_context(db, user, None)
    assert exc.value.status_code == 403
    assert exc.value.detail == ERR_NO_PLANT_ACCESS


@with_session
async def test_inactive_plant_membership_gives_no_access(db):
    dead = await _mk_plant(db, f"T{uuid.uuid4().hex[:6]}", "Closed Plant")
    dead.active = False
    await db.flush()
    user = await _mk_user(db, UserRole.technician)
    await _link(db, user, dead, UserRole.technician, is_default=True)

    with pytest.raises(HTTPException) as exc:
        await resolve_plant_context(db, user, None)
    assert exc.value.status_code == 403
    assert exc.value.detail == ERR_NO_PLANT_ACCESS


@with_session
async def test_corporate_admin_spans_all_plants(db):
    p1 = await _mk_plant(db, f"T{uuid.uuid4().hex[:6]}", "Extra Plant")
    admin = await _mk_user(db, UserRole.admin)      # no membership rows at all

    ctx = await resolve_plant_context(db, admin, None)
    assert ctx.is_corporate
    assert ctx.role == UserRole.admin
    assert p1.id in ctx.allowed_plant_ids           # includes plants created after onboarding
    assert ctx.can_access(p1.id)

    ctx = await resolve_plant_context(db, admin, str(p1.id))
    assert ctx.plant_id == p1.id
