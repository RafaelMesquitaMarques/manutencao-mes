"""
Plant-segregation test matrix (multi-plant phases 0–6).
========================================================
The durable, automated version of the security matrix: every persona from the
rollout plan exercised against the real schema — context resolution, per-plant
roles, scoped queries, relational guards, notifications, numbering, calendar,
kiosk guard and the RLS fence behind Ask Ninja's raw SQL.

Personas: QS-only mechanic · QS+QM manager (different role per plant) ·
QM-only operator · NL-only mechanic · NL supervisor · corporate admin ·
user with no plant · (disabled users are rejected by get_current_user before
any plant logic runs — covered by scripts/plant_security_check.py at HTTP level).

Same harness as test_labor_integration.py: runs INSIDE the backend container,
each test drives its async body on one shared event loop, and every write
happens in a transaction that is ALWAYS rolled back. Assertions are structural
(ownership of returned rows), never fixed counts — they hold as data grows.

Run (inside the backend container):
    pip install pytest
    pytest tests/test_plant_segregation.py -v
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
from app.core.plant_scope import (                                # noqa: E402
    ensure_same_plant, plant_scoped, require_technician_in_plant,
)
from app.models.models import (                                   # noqa: E402
    EscalationContact, Machine, MaintenanceTicket, Plant, Technician,
    User, UserPlant, UserRole, WorkOrder,
)
from app.services.notification_service import NotificationService  # noqa: E402
from app.services.numbering import series_prefix                   # noqa: E402
from app.services.work_calendar import get_calendar_settings       # noqa: E402

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    """Async test body on the shared loop, always rolled back.
    NOTE: deliberately NOT functools.wraps (pytest follows __wrapped__)."""
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


async def _mk_user(db, role=UserRole.technician, *, active=True, phone=None):
    u = User(id=uuid.uuid4(), name=f"mx-{uuid.uuid4().hex[:6]}",
             email=f"mx-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=role, active=active, phone=phone)
    db.add(u)
    await db.flush()
    return u


async def _member(db, user, plant, role, default=False):
    db.add(UserPlant(user_id=user.id, plant_id=plant.id, role=role, is_default=default))
    await db.flush()


# ── Persona: context resolution ───────────────────────────────────────────────

@with_session
async def test_qs_only_mechanic(db):
    p = await _plants(db)
    u = await _mk_user(db)
    await _member(db, u, p["QS"], UserRole.technician, default=True)
    ctx = await resolve_plant_context(db, u, None)
    assert ctx.plant_id == p["QS"].id and ctx.role == UserRole.technician
    assert not ctx.can_access(p["QM"].id) and not ctx.can_access(p["NL"].id)


@with_session
async def test_qs_qm_manager_role_per_plant(db):
    p = await _plants(db)
    u = await _mk_user(db, UserRole.supervisor)
    await _member(db, u, p["QS"], UserRole.maintenance_director, default=True)
    await _member(db, u, p["QM"], UserRole.supervisor)
    ctx_qs = await resolve_plant_context(db, u, str(p["QS"].id))
    ctx_qm = await resolve_plant_context(db, u, str(p["QM"].id))
    assert ctx_qs.role == UserRole.maintenance_director
    assert ctx_qm.role == UserRole.supervisor
    assert not ctx_qs.can_access(p["NL"].id)
    with pytest.raises(HTTPException):
        await resolve_plant_context(db, u, str(p["NL"].id))


@with_session
async def test_nl_only_mechanic_cannot_reach_quebec(db):
    p = await _plants(db)
    u = await _mk_user(db)
    await _member(db, u, p["NL"], UserRole.technician, default=True)
    ctx = await resolve_plant_context(db, u, None)
    assert ctx.plant_id == p["NL"].id
    for code in ("QS", "QM"):
        assert not ctx.can_access(p[code].id)
        with pytest.raises(HTTPException) as e:
            await resolve_plant_context(db, u, str(p[code].id))
        assert e.value.status_code == 403
    # NL is ungrouped: its group is only itself → the QC stock pool is invisible.
    assert ctx.group_plant_ids == frozenset({p["NL"].id})
    assert p["QS"].id not in ctx.allowed_group_plant_ids


@with_session
async def test_corporate_admin_spans_three_plants(db):
    p = await _plants(db)
    admin = await _mk_user(db, UserRole.admin)
    ctx = await resolve_plant_context(db, admin, None)
    assert ctx.is_corporate
    assert {p["QS"].id, p["QM"].id, p["NL"].id} <= set(ctx.allowed_plant_ids)


@with_session
async def test_user_without_plants_denied(db):
    u = await _mk_user(db)
    with pytest.raises(HTTPException) as e:
        await resolve_plant_context(db, u, None)
    assert e.value.status_code == 403


# ── Scoped queries + record guards ────────────────────────────────────────────

@with_session
async def test_scoped_lists_only_return_own_plant(db):
    p = await _plants(db)
    u = await _mk_user(db)
    await _member(db, u, p["QM"], UserRole.technician, default=True)
    ctx = await resolve_plant_context(db, u, None)
    for model in (Machine, MaintenanceTicket, WorkOrder):
        rows = (await db.execute(plant_scoped(select(model), model, ctx))).scalars().all()
        assert all(r.plant_id == p["QM"].id for r in rows), f"{model.__name__} leaked a foreign plant"


@with_session
async def test_foreign_record_probes_404(db):
    p = await _plants(db)
    u = await _mk_user(db)
    await _member(db, u, p["QM"], UserRole.technician, default=True)
    ctx = await resolve_plant_context(db, u, None)
    qs_ticket = (await db.execute(
        select(MaintenanceTicket).where(MaintenanceTicket.plant_id == p["QS"].id).limit(1)
    )).scalars().first()
    assert qs_ticket is not None, "live QS ticket expected"
    with pytest.raises(HTTPException) as e:
        ensure_same_plant(qs_ticket, ctx)
    assert e.value.status_code == 404          # never 403: no existence confirmation


@with_session
async def test_cross_plant_technician_assignment_blocked(db):
    p = await _plants(db)
    nl_user = await _mk_user(db)
    await _member(db, nl_user, p["NL"], UserRole.technician, default=True)
    tech = Technician(id=uuid.uuid4(), user_id=nl_user.id, active=True)
    db.add(tech)
    await db.flush()
    # An NL mechanic can never be scheduled on Quebec work…
    with pytest.raises(HTTPException) as e:
        await require_technician_in_plant(db, tech.id, p["QS"].id)
    assert e.value.status_code == 400 and e.value.detail == "errors.technicianNotInPlant"
    # …but is valid for NL work.
    assert (await require_technician_in_plant(db, tech.id, p["NL"].id)).id == tech.id


# ── Notifications, numbering, calendar ────────────────────────────────────────

@with_session
async def test_notifications_follow_memberships(db):
    p = await _plants(db)
    qc_mgr = await _mk_user(db, UserRole.supervisor, phone="+15550009999")
    await _member(db, qc_mgr, p["QS"], UserRole.supervisor, default=True)
    await _member(db, qc_mgr, p["QM"], UserRole.supervisor)
    db.add(EscalationContact(level=1, user_id=qc_mgr.id, via_sms=True, via_email=False, is_active=True))
    await db.flush()
    notif = NotificationService(db)
    for code, expected in (("QS", True), ("QM", True), ("NL", False)):
        rcpts = await notif._level_recipients(1, plant_id=p[code].id)
        got = any(r["user"].id == qc_mgr.id for r in rcpts)
        assert got is expected, f"legacy contact vs {code}: expected {expected}"


@with_session
async def test_numbering_series_per_plant(db):
    p = await _plants(db)
    assert await series_prefix(db, p["QS"].id) == ""
    assert await series_prefix(db, p["QM"].id) == ""
    assert await series_prefix(db, p["NL"].id) == "NL-"


@with_session
async def test_calendar_ownership(db):
    p = await _plants(db)
    qc_cal = await get_calendar_settings(db, p["QM"].id)
    nl_cal = await get_calendar_settings(db, p["NL"].id)
    assert qc_cal.plant_id is None, "QC shares the legacy calendar"
    assert nl_cal.plant_id == p["NL"].id, "NL owns an independent calendar"


# ── Ask Ninja raw SQL: RLS fence (read-only against committed data) ──────────

@with_session
async def test_rls_fences_raw_sql(db):
    p = await _plants(db)
    from app.services.intelligence_chat import _query_database
    qm = str(p["QM"].id)
    qc = f"{p['QS'].id},{p['QM'].id}"
    fenced = await _query_database("SELECT count(*) AS n FROM work_orders", qm, qm)
    open_ = await _query_database("SELECT count(*) AS n FROM work_orders", None)
    assert fenced["rows"][0]["n"] < open_["rows"][0]["n"], "GUC must shrink the visible set"
    qm_only = await _query_database(
        "SELECT count(*) AS n FROM work_orders WHERE plant_id::text != :x".replace(":x", f"'{qm}'"), qm, qm)
    assert qm_only["rows"][0]["n"] == 0, "no foreign-plant WO visible under the QM fence"
    # Group GUC: the QC stock pool follows group semantics, not the plant list.
    stock = await _query_database("SELECT count(*) AS n FROM stock_items", qm, qc)
    assert stock["rows"][0]["n"] > 0, "QM member sees the QC stock pool via the group GUC"
    blocked = await _query_database("SELECT count(*) AS n FROM user_invitations", qm, qm)
    assert "error" in blocked, "credential tables are not readable by the ninja role"


# ── Kiosk guard branches (enforcement toggled in-process) ────────────────────

@with_session
async def test_kiosk_guard_enforcement(db):
    from app.core import kiosk_guard as kg

    class _Req:
        def __init__(self, params, headers):
            self.path_params = params
            self.headers = headers

    machine = (await db.execute(
        select(Machine).where(Machine.kiosk_token.isnot(None)).limit(1)
    )).scalars().first()
    if machine is None:                       # provision one inside the rollback
        machine = (await db.execute(select(Machine).limit(1))).scalars().first()
        machine.kiosk_token = "test-" + uuid.uuid4().hex
        await db.flush()

    guard = kg.kiosk_ref_guard("ref")
    original = settings.KIOSK_ENFORCE_TOKEN
    try:
        settings.KIOSK_ENFORCE_TOKEN = False
        await guard(_Req({"ref": str(machine.id)}, {}), db)          # open mode: passes

        settings.KIOSK_ENFORCE_TOKEN = True
        with pytest.raises(HTTPException):
            await guard(_Req({"ref": str(machine.id)}, {}), db)      # enforced: blocked
        await guard(_Req({"ref": str(machine.id)},
                         {"x-kiosk-token": machine.kiosk_token}), db)  # token: passes
        with pytest.raises(HTTPException):
            await guard(_Req({"ref": str(machine.id)},
                             {"x-kiosk-token": "wrong"}), db)
    finally:
        settings.KIOSK_ENFORCE_TOKEN = original
