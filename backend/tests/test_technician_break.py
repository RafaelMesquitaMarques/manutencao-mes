"""
Announced (live) technician break — service + availability precedence.
======================================================================
Same isolation contract as ``test_labor_integration.py``: each test runs on one
shared event loop with its own session, and every write is rolled back so the
database is never mutated. The break service flushes only (the route owns the
commit), which is exactly what lets these run inside the rolled-back transaction.

Run (inside the backend container):
    pytest tests/test_technician_break.py -v
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                              # noqa: E402
from app.models.models import ShiftBreakKind, Technician, TechnicianBreak, User  # noqa: E402
from app.services import technician_availability_service as avail  # noqa: E402
from app.services import technician_break_service as brk           # noqa: E402

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    """Turn an ``async def test(s)`` into a SYNC pytest test on the shared loop.
    (Deliberately not functools.wraps — see test_labor_integration.py.)"""
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


async def _mk_tech(s, *, shift=None, active=True):
    # Default shift=None → no template matches → no schedule, so availability is
    # AVAILABLE unless a break/unavailability applies. This isolates the break
    # tests from whatever live shift templates exist in the dev database.
    u = User(id=uuid.uuid4(), name="Brk Test", email=f"brk-{uuid.uuid4().hex[:8]}@test.local",
             password_hash="x", active=active)
    s.add(u)
    await s.flush()
    tech = Technician(id=uuid.uuid4(), user_id=u.id, shift=shift, active=active)
    s.add(tech)
    await s.flush()
    return tech


@with_session
async def test_start_opens_break_and_is_idempotent(s):
    """Starting opens an active break; a second tap returns the same row."""
    tech = await _mk_tech(s)
    assert await brk.active_break(s, tech.id) is None
    a = await brk.start_break(s, tech.id)
    assert a.ended_at is None
    active = await brk.active_break(s, tech.id)
    assert active is not None and active.id == a.id
    # double tap → same row, not a second break
    again = await brk.start_break(s, tech.id)
    assert again.id == a.id


@with_session
async def test_announced_break_wins_over_schedule(s):
    """An announced break is ground truth: it flips availability to on_break with
    announced=True even for a technician on a real shift schedule (proves the
    override wins over whatever the schedule would otherwise say)."""
    tech = await _mk_tech(s, shift="day")   # matches a live "day" template
    before = await avail.availability_at(s, tech)
    assert before.announced is False        # schedule-derived, not announced

    rec = await brk.start_break(s, tech.id)
    on = await avail.availability_at(s, tech)
    assert on.status == avail.ON_BREAK
    assert on.announced is True
    assert on.available is False
    assert on.since == rec.started_at


@with_session
async def test_lunch_kind_reads_at_lunch(s):
    tech = await _mk_tech(s)
    await brk.start_break(s, tech.id, kind=ShiftBreakKind.lunch)
    on = await avail.availability_at(s, tech)
    assert on.status == avail.AT_LUNCH
    assert on.announced is True


@with_session
async def test_end_clears_break(s):
    tech = await _mk_tech(s)
    await brk.start_break(s, tech.id)
    ended = await brk.end_break(s, tech.id)
    assert ended is not None and ended.ended_at is not None
    assert await brk.active_break(s, tech.id) is None
    back = await avail.availability_at(s, tech)
    assert back.status == avail.AVAILABLE
    # ending again when not on break is a no-op
    assert await brk.end_break(s, tech.id) is None


@with_session
async def test_stale_break_is_ignored(s):
    """An open break older than the abandon window no longer counts as on break
    (the technician forgot to clock back in)."""
    tech = await _mk_tech(s)
    stale_start = datetime.now(timezone.utc) - brk.MAX_ANNOUNCED_BREAK - timedelta(minutes=5)
    s.add(TechnicianBreak(id=uuid.uuid4(), technician_id=tech.id,
                          kind=ShiftBreakKind.short_break, started_at=stale_start))
    await s.flush()
    assert await brk.active_break(s, tech.id) is None
    a = await avail.availability_at(s, tech)
    assert a.status == avail.AVAILABLE
    # starting fresh closes the stale row and opens a new active one
    fresh = await brk.start_break(s, tech.id)
    assert fresh.started_at > stale_start
    assert await brk.active_break(s, tech.id) is not None
