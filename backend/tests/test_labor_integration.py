"""
DB-facing integration tests for effective labor time & availability.
====================================================================
These exercise the async helpers that build shift/break/unavailability windows
from real rows and stamp labor records — the layer where the enum/serialisation
bug hid and pure unit tests can't reach.

They run INSIDE the backend container (needs DB access) and are fully isolated:
each test runs in its OWN event loop (``asyncio.run``) with its OWN engine, and
every write happens in one transaction that is ALWAYS rolled back — the database
is never mutated. Shift templates are editable in Settings, so tests never rely
on live rows: any test that needs a schedule creates its own throwaway template
via ``_mk_shift`` (which deactivates same-key rows first, inside the rolled-back
transaction) and asserts against the values it created.

Each test is a plain sync function (see ``with_session``) that drives its async
body on one shared event loop, so no async pytest plugin is required.

Run (inside the backend container):
    pip install pytest
    pytest tests/test_labor_integration.py -v
"""
import asyncio
import functools
import os
import sys
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                            # noqa: E402
from app.models.models import (                                  # noqa: E402
    LaborRecord, ShiftBreak, ShiftBreakKind, ShiftTemplate, Technician,
    TechnicianUnavailability, UnavailabilityType, User,
)
from app.services import labor_time_service as lts               # noqa: E402
from app.services import technician_availability_service as avail  # noqa: E402

TZ = ZoneInfo(lts.DEFAULT_TZ)


def _utc(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=TZ).astimezone(timezone.utc)


# SQLAlchemy's async engine binds its asyncpg connection to the event loop of the
# first operation and caches it, so it must live on ONE persistent loop for the
# whole run (a fresh asyncio.run() per test → "attached to a different loop").
# We keep a single module loop and create the engine lazily on it, reused by every
# test. NullPool → each session gets its own connection on that loop; every test is
# rolled back, so the database is never mutated.
_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    """Turn an ``async def test(s)`` into a SYNC pytest test run on the shared loop.

    NOTE: we deliberately do NOT use functools.wraps — it sets ``__wrapped__``,
    which pytest follows back to the original async function and then refuses to
    run ("async def not natively supported"). We copy name/doc by hand instead."""
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


async def _mk_tech(s, *, shift="day", rate=60.0, active=True):
    """Create a throwaway User + Technician in the current (rolled-back) transaction."""
    u = User(id=uuid.uuid4(), name="T Test", email=f"lt-{uuid.uuid4().hex[:8]}@test.local",
             password_hash="x", active=active)
    s.add(u)
    await s.flush()
    tech = Technician(id=uuid.uuid4(), user_id=u.id, shift=shift, hourly_rate=rate, active=active)
    s.add(tech)
    await s.flush()
    return tech


async def _mk_shift(s, *, key="day", start="08:00", end="16:30",
                    breaks=(("lunch", "12:00", "12:30"),)):
    """Create a throwaway ShiftTemplate (+breaks) as the ONLY active template
    for ``key``. Technician.shift is an enum, so tests can't use a custom key;
    instead the live same-key rows are deactivated — inside the rolled-back
    transaction, so Settings edits made by users are never really touched."""
    await s.execute(update(ShiftTemplate).where(ShiftTemplate.key == key).values(active=False))
    tpl = ShiftTemplate(id=uuid.uuid4(), key=key, name=f"LT test {key}",
                        start_time=start, end_time=end, active=True)
    s.add(tpl)
    await s.flush()
    for kind, b_start, b_end in breaks:
        s.add(ShiftBreak(id=uuid.uuid4(), shift_template_id=tpl.id,
                         kind=ShiftBreakKind(kind), name=f"LT {kind}",
                         start_time=b_start, end_time=b_end))
    await s.flush()
    return tpl


@with_session
async def test_shift_template_lookup_uses_own_template(s):
    """_shift_template_for resolves the technician's shift key to the template
    this test created (the only active one for the key)."""
    made = await _mk_shift(s, start="08:00", end="16:30", breaks=(("lunch", "12:00", "12:30"),))
    tpl = await lts._shift_template_for(s, await _mk_tech(s, shift="day"))
    assert tpl is not None
    assert tpl.id == made.id
    assert tpl.start_time == "08:00" and tpl.end_time == "16:30"
    assert any(b.kind.value == "lunch" for b in tpl.breaks)


@with_session
async def test_golden_case_over_lunch(s):
    """11:45–12:45 with a 12:00–12:30 lunch → raw 60, effective 30."""
    await _mk_shift(s, breaks=(("lunch", "12:00", "12:30"),))
    tech = await _mk_tech(s, shift="day", rate=60.0)
    bd = await lts.breakdown_for_span(
        s, tech, _utc(2026, 6, 1, 11, 45), _utc(2026, 6, 1, 12, 45), work_order=None,
    )
    assert bd.has_schedule is True
    assert round(bd.raw_minutes) == 60
    assert round(bd.effective_minutes) == 30
    assert round(bd.break_minutes) == 30


@with_session
async def test_apply_to_record_stamps_effective_and_cost(s):
    """apply_to_record keeps hours_worked raw, sets effective_hours, and prices
    labor from EFFECTIVE time (30 min × $60 = $30)."""
    await _mk_shift(s, breaks=(("lunch", "12:00", "12:30"),))
    tech = await _mk_tech(s, shift="day", rate=60.0)
    rec = LaborRecord(
        id=uuid.uuid4(), technician_id=tech.id, date=datetime(2026, 6, 1).date(),
        hours_worked=1.0, started_at=_utc(2026, 6, 1, 11, 45), stopped_at=_utc(2026, 6, 1, 12, 45),
    )
    bd = await lts.apply_to_record(s, rec, work_order=None)
    assert rec.hours_worked == 1.0                 # RAW preserved (feeds MTTR)
    assert round(rec.effective_hours, 2) == 0.5
    assert round(rec.deducted_minutes) == 30
    assert round(rec.labor_cost, 2) == 30.0
    assert round(bd.effective_minutes) == 30


@with_session
async def test_vacation_excludes_labor_and_flags_unavailable(s):
    # no breaks → the whole 9:00–10:00 span counts as unavailable, not break
    await _mk_shift(s, breaks=())
    tech = await _mk_tech(s, shift="day", rate=60.0)
    s.add(TechnicianUnavailability(
        id=uuid.uuid4(), technician_id=tech.id, type=UnavailabilityType.vacation,
        start_date=datetime(2026, 6, 1).date(), end_date=datetime(2026, 6, 3).date(),
    ))
    await s.flush()
    bd = await lts.breakdown_for_span(
        s, tech, _utc(2026, 6, 1, 9), _utc(2026, 6, 1, 10), work_order=None,
    )
    assert round(bd.raw_minutes) == 60
    assert round(bd.effective_minutes) == 0
    assert round(bd.unavailable_minutes) == 60
    a = await avail.availability_at(s, tech, at=_utc(2026, 6, 2, 10))
    assert a.status == avail.ON_VACATION
    assert a.should_warn is True and a.available is False


@with_session
async def test_inactive_technician_is_unavailable(s):
    tech = await _mk_tech(s, shift="day", active=False)
    a = await avail.availability_at(s, tech)
    assert a.status == avail.INACTIVE
    assert a.available is False


@with_session
async def test_no_timestamps_falls_back_to_raw_equals_effective(s):
    """Manual entry (no start/stop) → effective == raw, no deduction, cost on raw."""
    tech = await _mk_tech(s, shift="day", rate=50.0)
    rec = LaborRecord(
        id=uuid.uuid4(), technician_id=tech.id, date=datetime(2026, 6, 1).date(),
        hours_worked=2.0, started_at=None, stopped_at=None,
    )
    await lts.apply_to_record(s, rec, work_order=None)
    assert round(rec.effective_hours, 2) == 2.0
    assert (rec.deducted_minutes or 0) == 0
    assert round(rec.labor_cost, 2) == 100.0


@with_session
async def test_missing_shift_key_falls_back_to_raw(s):
    """A technician with no shift assigned → no template → effective == raw."""
    tech = await _mk_tech(s, shift=None, rate=60.0)
    bd = await lts.breakdown_for_span(
        s, tech, _utc(2026, 6, 1, 11, 45), _utc(2026, 6, 1, 12, 45), work_order=None,
    )
    assert bd.has_schedule is False
    assert round(bd.raw_minutes) == round(bd.effective_minutes) == 60
