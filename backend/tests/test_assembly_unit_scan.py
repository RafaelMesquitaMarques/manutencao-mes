"""
End-of-line unit-scan tests — complete_unit_at_machine (assembly lines).
========================================================================
Same container harness as test_job_order_scan.py: each async body runs on one
shared event loop and every write is ALWAYS rolled back. Exercises the
end-of-line semantic (each scan = one FINISHED unit of the labelled OF):

  a scan opens the run AND credits the unit · repeated scans accumulate on the
  same run · interleaved OFs on the same belt switch runs and each keeps its own
  count · rejects accumulate · count > 1 is credited in full.

Run (inside the backend container):
    pip install pytest
    pytest tests/test_assembly_unit_scan.py -v
"""
import asyncio
import os
import sys
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                                  # noqa: E402
from app.models.models import (                                       # noqa: E402
    Machine, JobOrderRun, JobOrderSource, JobOrderStatus,
)
from app.services.job_order_service import (                          # noqa: E402
    complete_unit_at_machine, get_open_run,
)

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


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


async def _line(s):
    m = Machine(name=f"TEST-LINE-{uuid.uuid4().hex[:8]}", department="assemblage")
    s.add(m)
    await s.flush()
    return m


def _jn():
    return f"OF-{uuid.uuid4().hex[:10]}"


async def _runs_of(s, job_order_id):
    r = await s.execute(select(JobOrderRun).where(JobOrderRun.job_order_id == job_order_id))
    return r.scalars().all()


@with_session
async def test_unit_scan_opens_run_and_credits_unit(s):
    m = await _line(s)
    jn = _jn()
    jo, run = await complete_unit_at_machine(s, m, jn)
    assert jo is not None and jo.job_number == jn
    assert jo.status == JobOrderStatus.in_progress
    assert run is not None and run.ended_at is None
    assert run.source == JobOrderSource.cortex
    assert run.pieces == 1 and run.rejects == 0
    assert m.current_job_number == jn


@with_session
async def test_repeated_scans_accumulate_on_same_run(s):
    m = await _line(s)
    jn = _jn()
    jo, run1 = await complete_unit_at_machine(s, m, jn)
    _, run2 = await complete_unit_at_machine(s, m, jn)
    _, run3 = await complete_unit_at_machine(s, m, jn)
    assert run1.id == run2.id == run3.id
    assert run3.pieces == 3
    assert len(await _runs_of(s, jo.id)) == 1


@with_session
async def test_interleaved_ofs_each_keep_their_count(s):
    """Units of OF A and OF B interleave on the same belt: A A B A."""
    m = await _line(s)
    jn_a, jn_b = _jn(), _jn()
    jo_a, _ = await complete_unit_at_machine(s, m, jn_a)
    await complete_unit_at_machine(s, m, jn_a)
    jo_b, run_b = await complete_unit_at_machine(s, m, jn_b)
    _, run_a2 = await complete_unit_at_machine(s, m, jn_a)

    # B's arrival closed A's first run (2 units); A's return opened a fresh run.
    runs_a = await _runs_of(s, jo_a.id)
    assert len(runs_a) == 2
    assert sum(r.pieces or 0 for r in runs_a) == 3
    closed = [r for r in runs_a if r.ended_at is not None]
    assert len(closed) == 1 and closed[0].pieces == 2

    runs_b = await _runs_of(s, jo_b.id)
    assert len(runs_b) == 1 and runs_b[0].pieces == 1
    assert runs_b[0].ended_at is not None          # A's return closed B's run

    open_run = await get_open_run(s, m.id)
    assert open_run is not None and open_run.id == run_a2.id
    assert m.current_job_number == jn_a


@with_session
async def test_rejects_and_multi_count(s):
    m = await _line(s)
    jn = _jn()
    _, run = await complete_unit_at_machine(s, m, jn, count=4, rejects=1)
    assert run.pieces == 4 and run.rejects == 1
    _, run = await complete_unit_at_machine(s, m, jn, count=1, rejects=2)
    assert run.pieces == 5 and run.rejects == 3
