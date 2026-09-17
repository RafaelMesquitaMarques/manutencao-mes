"""Shift-template plant-segregation regression.
=============================================
Shift templates are either global (plant_id NULL, shared by every plant) or
plant-specific. The router listed and let any caller open/edit/delete EVERY
plant's templates. Now list = global + own plant, and _load 404s another
plant's template (global stays visible to all).

Harness identical to test_plant_segregation.py — INSIDE the backend container,
one shared loop, every write ALWAYS rolled back (flush only, never commit).
"""
import os
import sys
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.plant_context import resolve_plant_context          # noqa: E402
from app.models.models import Plant, ShiftTemplate, User, UserPlant, UserRole  # noqa: E402
from app.api.routes.shift_templates import list_shift_templates, _load  # noqa: E402
from db_harness import with_session    # noqa: E402


async def _plants(db):
    rows = (await db.execute(select(Plant).where(Plant.code.in_(["QS", "QM", "NL"])))).scalars().all()
    by_code = {p.code: p for p in rows}
    assert set(by_code) == {"QS", "QM", "NL"}, "live plants QS/QM/NL must exist"
    return by_code


async def _ctx(db, plant):
    u = User(id=uuid.uuid4(), name=f"sh-{uuid.uuid4().hex[:6]}",
             email=f"sh-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.plant_manager, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.plant_manager, is_default=True))
    await db.flush()
    return u, await resolve_plant_context(db, u, None)


async def _tpl(db, plant_id):
    t = ShiftTemplate(id=uuid.uuid4(), plant_id=plant_id, key=f"k-{uuid.uuid4().hex[:6]}",
                      name="shift", start_time="08:00", end_time="16:00", active=True)
    db.add(t)
    await db.flush()
    return t


@with_session
async def test_list_global_and_own_only(db):
    p = await _plants(db)
    g = await _tpl(db, None)              # global (shared)
    qm = await _tpl(db, p["QM"].id)
    qs = await _tpl(db, p["QS"].id)
    u, ctx_qm = await _ctx(db, p["QM"])

    ids = {str(t.id) for t in await list_shift_templates(db=db, ctx=ctx_qm, current_user=u)}
    assert str(g.id) in ids and str(qm.id) in ids
    assert str(qs.id) not in ids, "QS shift template leaked into the QM list"


@with_session
async def test_load_scopes(db):
    p = await _plants(db)
    g = await _tpl(db, None)
    qs = await _tpl(db, p["QS"].id)
    u, ctx_qm = await _ctx(db, p["QM"])

    assert (await _load(db, g.id, ctx_qm)).id == g.id       # global visible
    with pytest.raises(HTTPException) as e:
        await _load(db, qs.id, ctx_qm)                      # foreign plant 404
    assert e.value.status_code == 404
