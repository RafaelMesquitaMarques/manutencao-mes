"""Escalation management plant-segregation regression.
=====================================================
The send path was already plant-aware, but the MANAGEMENT router leaked: any
authed user saw/edited every plant's escalation contacts (names/phones/emails)
and notification history. The router now mirrors the sender's rule
(notification_service._level_recipients):

  · a contact is relevant to a plant if it is an explicit per-plant contact OR a
    shared (plant_id NULL) contact whose user is a member of that plant
  · _all_contacts returns only those; _load_visible_contact 404s the rest

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
from app.models.models import (                                   # noqa: E402
    EscalationContact, Plant, User, UserPlant, UserRole,
)
from app.api.routes.escalation import _all_contacts, _load_visible_contact  # noqa: E402
from db_harness import with_session    # noqa: E402


async def _plants(db):
    rows = (await db.execute(select(Plant).where(Plant.code.in_(["QS", "QM", "NL"])))).scalars().all()
    by_code = {p.code: p for p in rows}
    assert set(by_code) == {"QS", "QM", "NL"}, "live plants QS/QM/NL must exist"
    return by_code


async def _user_in(db, plant):
    u = User(id=uuid.uuid4(), name=f"es-{uuid.uuid4().hex[:6]}",
             email=f"es-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=UserRole.supervisor, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=UserRole.supervisor, is_default=True))
    await db.flush()
    return u


async def _ctx(db, user):
    return await resolve_plant_context(db, user, None)


@with_session
async def test_shared_contact_scoped_by_membership(db):
    p = await _plants(db)
    qm_user = await _user_in(db, p["QM"])
    # A legacy shared contact (plant_id NULL) whose user is a QM member.
    c = EscalationContact(id=uuid.uuid4(), level=1, user_id=qm_user.id, plant_id=None, is_active=True)
    db.add(c)
    await db.flush()

    qm_ctx = await _ctx(db, qm_user)
    qs_user = await _user_in(db, p["QS"])
    qs_ctx = await _ctx(db, qs_user)

    qm_ids = {x["id"] for x in await _all_contacts(db, qm_ctx)}
    qs_ids = {x["id"] for x in await _all_contacts(db, qs_ctx)}
    assert str(c.id) in qm_ids
    assert str(c.id) not in qs_ids, "QM contact leaked into the QS escalation list"


@with_session
async def test_plant_specific_contact_scoped(db):
    p = await _plants(db)
    qm_user = await _user_in(db, p["QM"])
    c = EscalationContact(id=uuid.uuid4(), level=2, user_id=qm_user.id, plant_id=p["QM"].id, is_active=True)
    db.add(c)
    await db.flush()

    qs_user = await _user_in(db, p["QS"])
    qs_ctx = await _ctx(db, qs_user)
    with pytest.raises(HTTPException) as e:
        await _load_visible_contact(c.id, db, qs_ctx)
    assert e.value.status_code == 404

    qm_ctx = await _ctx(db, qm_user)
    assert (await _load_visible_contact(c.id, db, qm_ctx)).id == c.id
