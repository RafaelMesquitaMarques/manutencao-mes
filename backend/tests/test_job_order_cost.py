"""
OF (Ordre de fabrication) cost tests — job_order_cost_service (Phase 2).
=======================================================================
Same container harness as the other suites (async body on a shared loop, always
rolled back). Verifies the costing rule: OF cost = PRODUCTIVE machine time × the
machine's hourly rate, where productive = run presence MINUS overlapping stop time
(stops are NEVER attributed to the OF). Rates are chosen so $/min is trivial.

Run (inside the backend container):
    pip install pytest
    pytest tests/test_job_order_cost.py -v
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                                  # noqa: E402
from app.models.models import (                                       # noqa: E402
    Machine, Plant, JobOrder, JobOrderRun, MachineStop, JobOrderStatus,
)
from app.services.job_order_cost_service import (                     # noqa: E402
    compute_job_order_cost, compute_cost_report,
)

_LOOP = asyncio.new_event_loop()
_ENGINE = {}
T0 = datetime(2026, 5, 1, 8, 0, tzinfo=timezone.utc)


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


async def _setup(s, rate=60.0):
    """A plant + a machine ($rate/h → rate/60 per minute)."""
    p = Plant(code=f"T{uuid.uuid4().hex[:6]}", name="Test plant")
    s.add(p)
    await s.flush()
    m = Machine(name=f"TEST-{uuid.uuid4().hex[:8]}", department="Cutting",
                plant_id=p.id, hourly_rate=rate)
    s.add(m)
    await s.flush()
    return p, m


async def _of(s, plant_id, machine_id, number=None):
    jo = JobOrder(job_number=number or f"OF-{uuid.uuid4().hex[:8]}",
                  plant_id=plant_id, machine_id=machine_id,
                  status=JobOrderStatus.in_progress)
    s.add(jo)
    await s.flush()
    return jo


async def _run(s, jo, m, start, minutes, pieces=0):
    run = JobOrderRun(
        job_order_id=jo.id, machine_id=m.id, plant_id=m.plant_id,
        department=m.department, started_at=start,
        ended_at=start + timedelta(minutes=minutes),
        duration_minutes=minutes, pieces=pieces,
    )
    s.add(run)
    await s.flush()
    return run


async def _stop(s, m, start, minutes):
    st = MachineStop(machine_id=m.id, plant_id=m.plant_id, started_at=start,
                     ended_at=start + timedelta(minutes=minutes))
    s.add(st)
    await s.flush()
    return st


@with_session
async def test_cost_no_stops_is_full_time(s):
    p, m = await _setup(s, rate=60.0)         # $1/min
    jo = await _of(s, p.id, m.id)
    await _run(s, jo, m, T0, 90, pieces=12)   # 90 min presence, no stops
    c = await compute_job_order_cost(s, jo)
    assert c["total_gross_minutes"] == 90.0
    assert c["total_stop_minutes"] == 0.0
    assert c["total_productive_minutes"] == 90.0
    assert c["total_cost"] == 90.0            # 90 min × $1/min
    assert c["total_pieces"] == 12
    assert c["currency"] == "CAD"


@with_session
async def test_stop_excluded_from_of_cost(s):
    p, m = await _setup(s, rate=60.0)         # $1/min
    jo = await _of(s, p.id, m.id)
    await _run(s, jo, m, T0, 60, pieces=10)   # 60 min presence
    await _stop(s, m, T0 + timedelta(minutes=10), 15)  # 15 min stop inside the run
    c = await compute_job_order_cost(s, jo)
    assert c["total_gross_minutes"] == 60.0
    assert c["total_stop_minutes"] == 15.0
    assert c["total_productive_minutes"] == 45.0        # 60 − 15
    assert c["total_cost"] == 45.0                       # only productive time is charged


@with_session
async def test_stop_partial_overlap_is_clipped(s):
    p, m = await _setup(s, rate=120.0)        # $2/min
    jo = await _of(s, p.id, m.id)
    await _run(s, jo, m, T0, 30)              # window [T0, T0+30]
    # stop from T0+20 to T0+50 → only 10 min overlaps the run
    await _stop(s, m, T0 + timedelta(minutes=20), 30)
    c = await compute_job_order_cost(s, jo)
    assert c["total_stop_minutes"] == 10.0
    assert c["total_productive_minutes"] == 20.0
    assert c["total_cost"] == 40.0                       # 20 min × $2/min


@with_session
async def test_by_machine_and_department_buckets(s):
    p, m1 = await _setup(s, rate=60.0)
    m2 = Machine(name=f"TEST-{uuid.uuid4().hex[:8]}", department="Welding",
                 plant_id=p.id, hourly_rate=60.0)
    s.add(m2)
    await s.flush()
    jo = await _of(s, p.id, m1.id)
    await _run(s, jo, m1, T0, 30)                        # Cutting: 30 min
    await _run(s, jo, m2, T0 + timedelta(hours=1), 20)   # Welding: 20 min
    c = await compute_job_order_cost(s, jo)
    assert c["total_productive_minutes"] == 50.0
    assert c["total_cost"] == 50.0
    depts = {b["key"]: b for b in c["by_department"]}
    assert depts["Cutting"]["productive_minutes"] == 30.0
    assert depts["Welding"]["productive_minutes"] == 20.0
    assert len(c["by_machine"]) == 2


@with_session
async def test_cost_report_factory_total(s):
    p, m = await _setup(s, rate=60.0)
    jo1 = await _of(s, p.id, m.id)
    jo2 = await _of(s, p.id, m.id)
    await _run(s, jo1, m, T0, 40, pieces=4)
    await _run(s, jo2, m, T0 + timedelta(hours=2), 20, pieces=2)
    q = select(JobOrder).where(JobOrder.plant_id == p.id)
    rep = await compute_cost_report(s, q)
    assert rep["of_count"] == 2
    assert rep["factory_total_cost"] == 60.0             # 40 + 20 min × $1/min
    assert rep["total_productive_minutes"] == 60.0
    assert rep["total_pieces"] == 6
    # sorted by cost desc → the 40-min OF first
    assert rep["items"][0]["job_order_id"] == jo1.id
