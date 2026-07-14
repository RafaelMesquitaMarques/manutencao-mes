"""Media per-file plant-segregation regression (phase 2).
=======================================================
Phase 1 made /api/media require authentication. Phase 2 scopes each file to its
plant via a MediaAsset ownership row: a file owned by one plant is served only to
that plant's members (admin passes); legacy/un-owned files (no row, or plant_id
NULL) fall through to any authenticated user — fail-open, never public.

Harness identical to test_plant_segregation.py — INSIDE the backend container,
one shared loop, every write ALWAYS rolled back (flush only, never commit). Uses
a real file already on disk in UPLOAD_DIR.
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
from app.core.security import create_access_token                 # noqa: E402
from app.models.models import MediaAsset, Plant, User, UserPlant, UserRole  # noqa: E402
from app.api.routes.uploads import serve_media                    # noqa: E402

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


class _Req:
    """Minimal stand-in for starlette Request (only what _auth_claims reads)."""
    def __init__(self, token):
        self.cookies = {"media_auth": token}
        self.headers = {}


async def _plants(db):
    rows = (await db.execute(select(Plant).where(Plant.code.in_(["QS", "QM", "NL"])))).scalars().all()
    by_code = {p.code: p for p in rows}
    assert set(by_code) == {"QS", "QM", "NL"}, "live plants QS/QM/NL must exist"
    return by_code


async def _member(db, plant, role=UserRole.technician):
    u = User(id=uuid.uuid4(), name=f"mm-{uuid.uuid4().hex[:6]}",
             email=f"mm-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=role, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=role, is_default=True))
    await db.flush()
    return create_access_token({"sub": str(u.id), "role": role.value})


def _a_real_file() -> str:
    files = [f for f in os.listdir(settings.UPLOAD_DIR)
             if os.path.isfile(os.path.join(settings.UPLOAD_DIR, f)) and not f.startswith(".")]
    return files[0] if files else ""


@with_session
async def test_media_scoped_to_owning_plant(db):
    p = await _plants(db)
    fname = _a_real_file()
    if not fname:
        pytest.skip("no media file on disk")
    db.add(MediaAsset(id=uuid.uuid4(), filename=fname, plant_id=p["QM"].id, media_type="image"))
    await db.flush()

    qm_token = await _member(db, p["QM"])
    qs_token = await _member(db, p["QS"])

    # QM member: served
    resp = await serve_media(fname, _Req(qm_token), db)
    assert getattr(resp, "status_code", 200) == 200

    # QS member: 404 across the plant boundary
    with pytest.raises(HTTPException) as e:
        await serve_media(fname, _Req(qs_token), db)
    assert e.value.status_code == 404


@with_session
async def test_admin_and_legacy_pass(db):
    p = await _plants(db)
    fname = _a_real_file()
    if not fname:
        pytest.skip("no media file on disk")
    db.add(MediaAsset(id=uuid.uuid4(), filename=fname, plant_id=p["NL"].id, media_type="image"))
    await db.flush()

    # admin bypasses the plant check
    admin_token = create_access_token({"sub": str(uuid.uuid4()), "role": "admin"})
    resp = await serve_media(fname, _Req(admin_token), db)
    assert getattr(resp, "status_code", 200) == 200


@with_session
async def test_legacy_file_served_to_any_authed(db):
    # a file with NO MediaAsset row is legacy → served to any authenticated user
    fname = _a_real_file()
    if not fname:
        pytest.skip("no media file on disk")
    p = await _plants(db)
    token = await _member(db, p["QS"])
    # ensure no row exists for it in this session
    existing = (await db.execute(select(MediaAsset).where(MediaAsset.filename == fname))).scalar_one_or_none()
    if existing is not None:
        pytest.skip("file already owned in DB")
    resp = await serve_media(fname, _Req(token), db)
    assert getattr(resp, "status_code", 200) == 200
