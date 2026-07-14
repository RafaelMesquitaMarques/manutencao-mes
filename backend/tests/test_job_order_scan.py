"""
OF (Ordre de fabrication) scan-flow tests — job_order_service.
==============================================================
Same container harness as test_plant_segregation.py: each async body runs on one
shared event loop and every write is ALWAYS rolled back. Exercises the "passagem"
(JobOrderRun) lifecycle that underpins time/cost-per-OF and WIP:

  scan opens a run · re-scanning the same OF is a no-op · a new OF closes the
  machine's previous run (with a duration) and opens a fresh one · production is
  attributed to the open run · clearing the field closes the run · an OF that
  moves to another machine closes its run on the first one (one open run per OF).

Run (inside the backend container):
    pip install pytest
    pytest tests/test_job_order_scan.py -v
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
    Machine, Plant, JobOrderRun, JobOrderStatus, JobOrderSource,
)
from app.services.job_order_service import (                          # noqa: E402
    scan_job_order_at_machine, attribute_production, get_open_run,
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


async def _machine(s, department="Cutting", plant_id=None):
    m = Machine(name=f"TEST-{uuid.uuid4().hex[:8]}", department=department, plant_id=plant_id)
    s.add(m)
    await s.flush()
    return m


async def _plant(s):
    p = Plant(code=f"T{uuid.uuid4().hex[:6]}", name="Test plant")
    s.add(p)
    await s.flush()
    return p


def _jn():
    return f"OF-{uuid.uuid4().hex[:10]}"


async def _runs_of(s, job_order_id):
    r = await s.execute(select(JobOrderRun).where(JobOrderRun.job_order_id == job_order_id))
    return r.scalars().all()


@with_session
async def test_scan_opens_run(s):
    m = await _machine(s)
    jn = _jn()
    jo, run = await scan_job_order_at_machine(s, m, jn, source=JobOrderSource.cortex)
    assert jo is not None and jo.job_number == jn
    assert jo.status == JobOrderStatus.in_progress
    assert jo.started_at is not None
    assert jo.machine_id == m.id
    assert jo.department == "Cutting"
    assert run is not None and run.ended_at is None
    assert run.department == "Cutting"
    assert run.source == JobOrderSource.cortex
    assert m.current_job_number == jn
    open_run = await get_open_run(s, m.id)
    assert open_run is not None and open_run.id == run.id


@with_session
async def test_rescan_same_of_is_noop(s):
    m = await _machine(s)
    jn = _jn()
    jo1, run1 = await scan_job_order_at_machine(s, m, jn)
    jo2, run2 = await scan_job_order_at_machine(s, m, jn)
    assert jo1.id == jo2.id
    assert run1.id == run2.id
    assert len(await _runs_of(s, jo1.id)) == 1


@with_session
async def test_new_of_closes_previous_run(s):
    m = await _machine(s)
    a, run_a = await scan_job_order_at_machine(s, m, _jn())
    b, run_b = await scan_job_order_at_machine(s, m, _jn())
    assert a.id != b.id
    await s.refresh(run_a)
    assert run_a.ended_at is not None
    assert run_a.duration_minutes is not None and run_a.duration_minutes >= 0
    assert run_b.ended_at is None
    open_run = await get_open_run(s, m.id)
    assert open_run.id == run_b.id
    assert m.current_job_number == b.job_number


@with_session
async def test_production_attributed_to_open_run(s):
    m = await _machine(s)
    jn = _jn()
    jo, run = await scan_job_order_at_machine(s, m, jn)
    got = await attribute_production(s, m.id, 5, 1)
    assert got == jn
    await s.flush()   # push the increment to the DB (the endpoint commits; here we flush)
    assert run.pieces == 5 and run.rejects == 1
    await attribute_production(s, m.id, 3, 0)
    await s.flush()
    assert run.pieces == 8 and run.rejects == 1


@with_session
async def test_production_without_of_is_noop(s):
    m = await _machine(s)
    assert await attribute_production(s, m.id, 5, 0) is None


@with_session
async def test_clear_closes_run(s):
    m = await _machine(s)
    jo, run = await scan_job_order_at_machine(s, m, _jn())
    res_jo, res_run = await scan_job_order_at_machine(s, m, "")
    assert res_jo is None and res_run is None
    await s.refresh(run)
    assert run.ended_at is not None
    assert m.current_job_number is None
    assert await get_open_run(s, m.id) is None


@with_session
async def test_of_moving_machines_keeps_one_open_run(s):
    m1 = await _machine(s, "Cutting")
    m2 = await _machine(s, "Welding")
    jn = _jn()
    jo1, r1 = await scan_job_order_at_machine(s, m1, jn)
    jo2, r2 = await scan_job_order_at_machine(s, m2, jn)
    assert jo1.id == jo2.id                       # same OF reused, not duplicated
    assert r1.id != r2.id
    await s.refresh(r1)
    assert r1.ended_at is not None                # m1's run closed (OF moved away)
    assert r2.ended_at is None                    # m2's run is the live one
    assert jo2.department == "Welding"            # current location updated
    runs = await _runs_of(s, jo1.id)
    assert len(runs) == 2
    open_runs = [r for r in runs if r.ended_at is None]
    assert len(open_runs) == 1 and open_runs[0].id == r2.id


@with_session
async def test_scan_enriches_of_details(s):
    # Smart-label / Cortex payloads carry product + target; a scan sets them on create
    # and backfills only when still empty (never overwrites known details).
    m = await _machine(s)
    jn = _jn()
    jo, _ = await scan_job_order_at_machine(
        s, m, jn, source=JobOrderSource.smart_label,
        product_name="Table oak", target_quantity=50)
    assert jo.product_name == "Table oak"
    assert jo.target_quantity == 50
    assert jo.source == JobOrderSource.smart_label
    jo2, _ = await scan_job_order_at_machine(
        s, m, jn, source=JobOrderSource.cortex,
        product_name="WRONG", target_quantity=999)
    assert jo2.id == jo.id
    assert jo2.product_name == "Table oak"        # not overwritten
    assert jo2.target_quantity == 50
    assert jo2.source == JobOrderSource.smart_label  # source stays as born


@with_session
async def test_same_number_is_distinct_of_per_plant(s):
    # Mirabel supplies St-Jérôme & Las Vegas: the SAME OF number in two plants is
    # two distinct OFs. Scanning it on a machine in each plant must NOT collide.
    p1 = await _plant(s)
    p2 = await _plant(s)
    m1 = await _machine(s, "Cutting", plant_id=p1.id)
    m2 = await _machine(s, "Cutting", plant_id=p2.id)
    jn = _jn()
    jo1, _ = await scan_job_order_at_machine(s, m1, jn)
    jo2, _ = await scan_job_order_at_machine(s, m2, jn)
    assert jo1.id != jo2.id                       # distinct OFs, same number
    assert jo1.job_number == jo2.job_number == jn
    assert jo1.plant_id == p1.id and jo2.plant_id == p2.id
