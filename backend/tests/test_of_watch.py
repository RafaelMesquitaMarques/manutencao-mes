"""
OF watch ("spot") tests — of_watch_service.
===========================================
Same container harness as test_pit_stop.py: each async body runs on one shared
event loop and every write is ALWAYS rolled back. Exercises the pieces behind
the map spot + inactivity alerts:

  last_movement_map picks the latest of run start/end/last-piece and Pit Stop
  ledger moves · locate_map resolves open run → machine, buffer on-hand →
  lane/slot, last machine → parked, else unknown · watch_status computes the
  inactivity clock (floored at watch creation) and the alerting flag ·
  episode_due fires once per stall and re-arms on new movement.

The module ensures the (additive, idempotent) schema bits exist first — the
same DDL the app applies at boot: the job_order_watches table and
job_order_runs.last_piece_at.

Run (inside the backend container):
    pytest tests/test_of_watch.py -v
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from unittest import mock

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                                  # noqa: E402
from app.models.models import (                                       # noqa: E402
    EscalationContact, EscalationSettings, JobOrder, JobOrderRun,
    JobOrderStatus, JobOrderWatch, Machine, NotificationLog,
    PitStopDirection, PitStopMovement, PitStopSource, Plant, User, UserPlant,
)
from app.services import notification_service                         # noqa: E402
from app.services.notification_service import NotificationService     # noqa: E402
from app.services.of_watch_service import (                            # noqa: E402
    episode_due, last_movement_map, locate_map, watch_status,
)

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def _ensure_schema():
    """Additive DDL identical to the app's boot path (create_all + migration) —
    lets this suite run against a DB whose backend hasn't rebooted on this code."""
    async def run():
        eng = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
        async with eng.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE job_order_runs ADD COLUMN IF NOT EXISTS last_piece_at TIMESTAMPTZ"))
            await conn.run_sync(JobOrderWatch.__table__.create, checkfirst=True)
            await conn.execute(text(
                "ALTER TABLE escalation_contacts ADD COLUMN IF NOT EXISTS category VARCHAR(20)"))
            await conn.execute(text(
                "ALTER TABLE escalation_settings ADD COLUMN IF NOT EXISTS of_teams_webhook_url TEXT"))
        await eng.dispose()
    _LOOP.run_until_complete(run())


_ensure_schema()


def with_session(fn):
    """Async body on the shared loop, always rolled back."""
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


def _now():
    return datetime.now(timezone.utc)


async def _plant(s):
    p = Plant(code=f"T{uuid.uuid4().hex[:6]}", name="Test plant")
    s.add(p)
    await s.flush()
    return p


async def _machine(s, plant, name=None):
    m = Machine(name=name or f"TEST-{uuid.uuid4().hex[:8]}", department="Cutting", plant_id=plant.id)
    s.add(m)
    await s.flush()
    return m


async def _of(s, plant, machine=None):
    jo = JobOrder(
        job_number=f"OF-{uuid.uuid4().hex[:10]}",
        plant_id=plant.id,
        status=JobOrderStatus.in_progress,
        machine_id=machine.id if machine else None,
    )
    s.add(jo)
    await s.flush()
    return jo


async def _run(s, jo, machine, started, ended=None, last_piece=None):
    r = JobOrderRun(
        job_order_id=jo.id, machine_id=machine.id, plant_id=jo.plant_id,
        started_at=started, ended_at=ended, last_piece_at=last_piece,
    )
    s.add(r)
    await s.flush()
    return r


async def _pit_move(s, jo, direction, qty, pos=None, when=None):
    mv = PitStopMovement(
        plant_id=jo.plant_id, job_order_id=jo.id, component_code="PANEL",
        direction=direction, quantity=qty, position_code=pos,
        occurred_at=when or _now(), source=PitStopSource.simulated,
    )
    s.add(mv)
    await s.flush()
    return mv


async def _watch(s, jo, threshold=30, created=None, alerted_movement=None):
    w = JobOrderWatch(
        plant_id=jo.plant_id, job_order_id=jo.id, threshold_minutes=threshold,
        alerted_movement_at=alerted_movement,
    )
    s.add(w)
    await s.flush()
    if created is not None:
        # server_default stamps now(); backdate for clock tests
        await s.execute(
            text("UPDATE job_order_watches SET created_at = :c WHERE id = :i"),
            {"c": created, "i": str(w.id)},
        )
        await s.refresh(w)
    return w


# ── last_movement_map ─────────────────────────────────────────────────────────

@with_session
async def test_last_movement_prefers_latest_signal(s):
    """Run start < run end < last piece < pit move → the pit move wins."""
    p = await _plant(s)
    m = await _machine(s, p)
    jo = await _of(s, p)
    t0 = _now() - timedelta(hours=3)
    await _run(s, jo, m, started=t0, ended=t0 + timedelta(hours=1),
               last_piece=t0 + timedelta(hours=2))
    mv_at = t0 + timedelta(hours=2, minutes=30)
    await _pit_move(s, jo, PitStopDirection.inbound, 2, when=mv_at)
    moves = await last_movement_map(s, [jo.id])
    assert moves[jo.id] == mv_at


@with_session
async def test_last_movement_none_without_any_event(s):
    p = await _plant(s)
    jo = await _of(s, p)
    moves = await last_movement_map(s, [jo.id])
    assert moves[jo.id] is None


@with_session
async def test_last_piece_beats_open_run_start(s):
    """A line producing the same OF: the open run's last_piece_at is the clock."""
    p = await _plant(s)
    m = await _machine(s, p)
    jo = await _of(s, p)
    t0 = _now() - timedelta(hours=2)
    piece_at = _now() - timedelta(minutes=5)
    await _run(s, jo, m, started=t0, last_piece=piece_at)
    moves = await last_movement_map(s, [jo.id])
    assert moves[jo.id] == piece_at


# ── locate_map ────────────────────────────────────────────────────────────────

@with_session
async def test_locate_open_run_wins(s):
    p = await _plant(s)
    m = await _machine(s, p, name="Ligne 2")
    jo = await _of(s, p, machine=m)
    await _run(s, jo, m, started=_now() - timedelta(minutes=10))
    loc = (await locate_map(s, [jo.id]))[jo.id]
    assert loc["kind"] == "machine"
    assert loc["machine_name"] == "Ligne 2"
    assert loc["parked"] is False


@with_session
async def test_locate_buffer_with_position(s):
    p = await _plant(s)
    jo = await _of(s, p)
    await _pit_move(s, jo, PitStopDirection.inbound, 3, pos="L05-P02")
    loc = (await locate_map(s, [jo.id]))[jo.id]
    assert loc["kind"] == "pit_stop"
    assert (loc["lane"], loc["slot"]) == (5, 2)


@with_session
async def test_locate_buffer_emptied_falls_back_to_parked(s):
    """All goods left the buffer (Σ=0) → parked at its last machine."""
    p = await _plant(s)
    m = await _machine(s, p, name="Coupe 1")
    jo = await _of(s, p, machine=m)
    await _run(s, jo, m, started=_now() - timedelta(hours=2), ended=_now() - timedelta(hours=1))
    await _pit_move(s, jo, PitStopDirection.inbound, 2, pos="L01-P01")
    await _pit_move(s, jo, PitStopDirection.outbound, 2)
    loc = (await locate_map(s, [jo.id]))[jo.id]
    assert loc["kind"] == "machine"
    assert loc["parked"] is True
    assert loc["machine_name"] == "Coupe 1"


@with_session
async def test_locate_loaded_by_number_without_run(s):
    """A kiosk shows the OF as its current job with NO run row (externally-fed
    data stamps machines.current_job_number only) → located ON that machine."""
    p = await _plant(s)
    m = await _machine(s, p, name="SELCO")
    jo = await _of(s, p)
    m.current_job_number = jo.job_number
    await s.flush()
    loc = (await locate_map(s, [jo.id]))[jo.id]
    assert loc["kind"] == "machine"
    assert loc["machine_name"] == "SELCO"
    assert loc["parked"] is False
    assert loc["planned"] is False


@with_session
async def test_locate_pending_of_is_planned_not_parked(s):
    """A pending OF assigned to a machine (production pipeline, e.g. behind a
    cutting saw — not yet in the Pit) locates there as PLANNED."""
    p = await _plant(s)
    m = await _machine(s, p, name="Schelling 4")
    jo = await _of(s, p, machine=m)
    jo.status = JobOrderStatus.pending
    loc = (await locate_map(s, [jo.id]))[jo.id]
    assert loc["kind"] == "machine"
    assert loc["planned"] is True
    assert loc["parked"] is False
    assert loc["machine_name"] == "Schelling 4"


@with_session
async def test_locate_unknown_without_any_trace(s):
    p = await _plant(s)
    jo = await _of(s, p)
    loc = (await locate_map(s, [jo.id]))[jo.id]
    assert loc["kind"] == "unknown"


# ── watch_status ──────────────────────────────────────────────────────────────

@with_session
async def test_watch_clock_floored_at_creation(s):
    """OF idle for hours, watch placed now → clock starts at ~0, not alerting."""
    p = await _plant(s)
    m = await _machine(s, p)
    jo = await _of(s, p, machine=m)
    old = _now() - timedelta(hours=5)
    await _run(s, jo, m, started=old, ended=old + timedelta(minutes=10))
    await _watch(s, jo, threshold=15)
    st = await watch_status(s, p.id)
    assert len(st) == 1
    assert st[0]["inactive_minutes"] <= 1
    assert st[0]["alerting"] is False


@with_session
async def test_watch_alerting_past_threshold(s):
    p = await _plant(s)
    m = await _machine(s, p)
    jo = await _of(s, p, machine=m)
    old = _now() - timedelta(hours=2)
    await _run(s, jo, m, started=old, ended=old + timedelta(minutes=5))
    await _watch(s, jo, threshold=30, created=_now() - timedelta(minutes=45))
    st = await watch_status(s, p.id)
    assert st[0]["alerting"] is True
    assert st[0]["inactive_minutes"] >= 44
    assert st[0]["location"]["parked"] is True


@with_session
async def test_watch_completed_of_has_no_clock(s):
    p = await _plant(s)
    jo = await _of(s, p)
    jo.status = JobOrderStatus.completed
    await _watch(s, jo, threshold=15, created=_now() - timedelta(hours=1))
    st = await watch_status(s, p.id)
    assert st[0]["inactive_minutes"] is None
    assert st[0]["alerting"] is False


# ── episode_due (one alert per stall) ─────────────────────────────────────────

@with_session
async def test_episode_fires_once_and_rearms_on_movement(s):
    p = await _plant(s)
    jo = await _of(s, p)
    basis = _now() - timedelta(minutes=40)
    w = await _watch(s, jo, threshold=30)
    assert episode_due(w, basis) is True                    # first crossing → fire
    w.alerted_movement_at = basis
    assert episode_due(w, basis) is False                   # same stall → silent
    new_basis = _now() - timedelta(minutes=35)              # moved, then stalled again
    assert episode_due(w, new_basis) is True                # new episode → fire again
    assert episode_due(w, _now() - timedelta(minutes=10)) is False   # under threshold


# ── OF alert recipients — separate audience from machine alerts ───────────────

async def _user(s, plant, phone=None):
    u = User(
        name=f"U {uuid.uuid4().hex[:6]}",
        email=f"{uuid.uuid4().hex[:12]}@test.local",
        password_hash="x",
        phone=phone or f"+1555{uuid.uuid4().int % 10**7:07d}",
    )
    s.add(u)
    await s.flush()
    s.add(UserPlant(user_id=u.id, plant_id=plant.id))
    await s.flush()
    return u


def _no_twilio():
    """Force simulation mode so tests never hit the real Twilio API."""
    return mock.patch.object(notification_service, "twilio_configured", lambda: False)


async def _plant_esc(s, plant, **over):
    """Plant-scoped settings row so tests never read/alter the shared global
    one (which may hold a real Teams webhook)."""
    base = dict(plant_id=plant.id, sms_enabled=True, email_enabled=False,
                teams_enabled=False)
    base.update(over)
    esc = EscalationSettings(**base)
    s.add(esc)
    await s.flush()
    return esc


@with_session
async def test_of_group_is_a_separate_audience(s):
    """category='of' contacts form the OF group; they never leak into the
    level-0 ticket group and vice versa."""
    p = await _plant(s)
    of_user = await _user(s, p)
    l0_user = await _user(s, p)
    s.add(EscalationContact(user_id=of_user.id, level=0, category="of", plant_id=p.id))
    s.add(EscalationContact(user_id=l0_user.id, level=0, plant_id=p.id))
    await s.flush()
    svc = NotificationService(s)
    of_recips = await svc._of_recipients(p.id)
    assert {r["user"].id for r in of_recips} == {of_user.id}
    l0 = await svc._level_recipients(0, plant_id=p.id)
    assert {r["user"].id for r in l0} == {l0_user.id}


@with_session
async def test_of_watch_alert_reaches_group_and_creator(s):
    p = await _plant(s)
    await _plant_esc(s, p)
    member = await _user(s, p)
    creator = await _user(s, p)
    s.add(EscalationContact(user_id=member.id, level=0, category="of", plant_id=p.id))
    await s.flush()
    jo = await _of(s, p)
    w = await _watch(s, jo, threshold=30)
    w.created_by_id = creator.id
    with _no_twilio():
        await NotificationService(s).notify_of_watch_inactive(
            job_order=jo, watch=w, minutes=45,
            location={"kind": "unknown"}, creator=creator,
        )
    logs = (await s.execute(
        select(NotificationLog).where(
            NotificationLog.recipient_contact.in_([member.phone, creator.phone]))
    )).scalars().all()
    assert {log.recipient_contact for log in logs} == {member.phone, creator.phone}
    assert all(log.notification_type == "sms" and log.recipient_role == "of_watch"
               for log in logs)


@with_session
async def test_of_watch_alert_dedups_creator_in_group(s):
    """A creator who is also in the OF group gets ONE SMS, not two."""
    p = await _plant(s)
    await _plant_esc(s, p)
    creator = await _user(s, p)
    s.add(EscalationContact(user_id=creator.id, level=0, category="of", plant_id=p.id))
    await s.flush()
    jo = await _of(s, p)
    w = await _watch(s, jo, threshold=30)
    w.created_by_id = creator.id
    with _no_twilio():
        await NotificationService(s).notify_of_watch_inactive(
            job_order=jo, watch=w, minutes=45,
            location={"kind": "unknown"}, creator=creator,
        )
    logs = (await s.execute(
        select(NotificationLog).where(NotificationLog.recipient_contact == creator.phone)
    )).scalars().all()
    assert len(logs) == 1
