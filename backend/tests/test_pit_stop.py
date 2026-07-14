"""
Pit Stop buffer tests — pit_stop_service.
=========================================
Same container harness as test_job_order_scan.py: each async body runs on one
shared event loop and every write is ALWAYS rolled back. Exercises the movement
ledger + derived read model that back the 3D buffer zone:

  ingest opens presence (first_in_at) · unknown OF / unknown component /
  duplicate / negative balance are FLAGGED never rejected · completeness is
  cumulative-received vs the BOM (per component + overall %) · outbound to zero
  sets left_at and drops the OF from the state · hold/release/cancel drive the
  derived state · lateness via scheduled_date or buffer age · positions parse
  the assumed L##-P## format · everything is plant-scoped.

Run (inside the backend container):
    pytest tests/test_pit_stop.py -v
"""
import asyncio
import os
import sys
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                                  # noqa: E402
from app.models.models import (                                       # noqa: E402
    Equipment, JobOrder, JobOrderComponent, JobOrderStatus, Machine,
    PitStopDirection, PitStopHoldKind, PitStopSource,
)
from app.services.pit_stop_service import (                            # noqa: E402
    compute_state, get_or_create_state, ingest_movement, parse_position,
    pit_stop_config,
)
from app.models.models import Plant                                   # noqa: E402

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


def _now():
    return datetime.now(timezone.utc)


async def _plant(s):
    p = Plant(code=f"T{uuid.uuid4().hex[:6]}", name="Test plant")
    s.add(p)
    await s.flush()
    return p


async def _pit_stop(s, plant, **spec):
    eq = Equipment(
        plant_id=plant.id,
        code=f"PIT-{uuid.uuid4().hex[:6]}",
        name="Pit Stop",
        block_kind="pit_stop",
        specifications={"lanes": 41, "lane_length_ft": 44, "ingest_token": "tok", **spec},
    )
    s.add(eq)
    await s.flush()
    return eq


async def _of(s, plant, *, scheduled=None):
    jo = JobOrder(
        job_number=f"OF-{uuid.uuid4().hex[:10]}",
        plant_id=plant.id,
        status=JobOrderStatus.in_progress,
        scheduled_date=scheduled,
    )
    s.add(jo)
    await s.flush()
    return jo


async def _bom(s, jo, lines):
    """lines = [(code, required, category), …]"""
    for code, required, category in lines:
        s.add(JobOrderComponent(
            job_order_id=jo.id, component_code=code,
            required_qty=required, category=category,
            source=PitStopSource.simulated,
        ))
    await s.flush()


async def _in(s, plant, jo, code, qty, pos=None, when=None):
    return await ingest_movement(
        s, plant.id, job_number=jo.job_number, component_code=code,
        direction=PitStopDirection.inbound, quantity=qty, position_code=pos,
        occurred_at=when, source=PitStopSource.simulated,
    )


async def _out(s, plant, jo, code, qty, dest=None, when=None):
    return await ingest_movement(
        s, plant.id, job_number=jo.job_number, component_code=code,
        direction=PitStopDirection.outbound, quantity=qty, destination=dest,
        occurred_at=when, source=PitStopSource.simulated,
    )


def _find(state, jo):
    return next((o for o in state["ofs"] if o["job_order_id"] == str(jo.id)), None)


# ─── position parsing / config ────────────────────────────────────────────────

def test_parse_position():
    assert parse_position("L03-P05") == (3, 5)
    assert parse_position("l12-p1") == (12, 1)
    assert parse_position("WHSE-A-99") == (None, None)   # unknown SAP format → unassigned strip
    assert parse_position(None) == (None, None)


@with_session
async def test_config_defaults_and_overrides(s):
    plant = await _plant(s)
    eq = await _pit_stop(s, plant, lanes=10, late_after_hours=6)
    cfg = pit_stop_config(eq)
    assert cfg["lanes"] == 10
    assert cfg["late_after_hours"] == 6
    assert cfg["lane_length_ft"] == 44
    assert cfg["slots_per_lane"] == 8   # default kept


# ─── ledger + presence ────────────────────────────────────────────────────────

@with_session
async def test_inbound_opens_presence(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    jo = await _of(s, plant)
    await _bom(s, jo, [("PAN-01", 10, "Panneaux")])
    mv = await _in(s, plant, jo, "PAN-01", 4, pos="L02-P01")
    assert mv.anomaly is None
    st = await get_or_create_state(s, jo.id, plant.id)
    assert st.first_in_at is not None and st.left_at is None

    state = await compute_state(s, plant.id)
    o = _find(state, jo)
    assert o is not None
    assert o["on_hand_total"] == 4
    assert o["positions"] == [{"code": "L02-P01", "lane": 2, "slot": 1}]
    assert o["state"] == "awaiting"


@with_session
async def test_unknown_of_created_and_flagged(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    mv = await ingest_movement(
        s, plant.id, job_number=f"OF-{uuid.uuid4().hex[:8]}", component_code="X-1",
        direction=PitStopDirection.inbound, quantity=2, source=PitStopSource.simulated,
    )
    # OF was created on the fly, movement flagged — never rejected.
    assert mv.anomaly == "unknown_of"
    jo = await s.get(JobOrder, mv.job_order_id)
    assert jo is not None and jo.plant_id == plant.id


@with_session
async def test_unknown_component_flagged(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    jo = await _of(s, plant)
    await _bom(s, jo, [("PAN-01", 10, None)])
    mv = await _in(s, plant, jo, "NOT-IN-BOM", 3)
    assert mv.anomaly == "unknown_component"
    state = await compute_state(s, plant.id)
    o = _find(state, jo)
    extra = next(c for c in o["components"] if c["code"] == "NOT-IN-BOM")
    assert extra["in_bom"] is False and extra["required"] == 0 and extra["received"] == 3


@with_session
async def test_duplicate_flagged(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    jo = await _of(s, plant)
    await _bom(s, jo, [("PAN-01", 10, None)])
    when = _now().replace(microsecond=0)
    first = await _in(s, plant, jo, "PAN-01", 5, pos="L01-P01", when=when)
    again = await _in(s, plant, jo, "PAN-01", 5, pos="L01-P01", when=when)
    assert first.anomaly is None
    assert again.anomaly == "duplicate"


@with_session
async def test_negative_balance_flagged(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    jo = await _of(s, plant)
    await _bom(s, jo, [("PAN-01", 10, None)])
    await _in(s, plant, jo, "PAN-01", 2)
    mv = await _out(s, plant, jo, "PAN-01", 5)
    assert mv.anomaly == "negative_balance"


@with_session
async def test_outbound_to_zero_sets_left_and_drops_of(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    jo = await _of(s, plant)
    await _bom(s, jo, [("PAN-01", 4, None)])
    await _in(s, plant, jo, "PAN-01", 4)
    await _out(s, plant, jo, "PAN-01", 4)
    st = await get_or_create_state(s, jo.id, plant.id)
    assert st.left_at is not None
    state = await compute_state(s, plant.id)
    assert _find(state, jo) is None          # physically gone → not in the read model

    # goods come back → presence reopens
    await _in(s, plant, jo, "PAN-01", 1)
    st = await get_or_create_state(s, jo.id, plant.id)
    assert st.left_at is None
    assert _find(await compute_state(s, plant.id), jo) is not None


# ─── completeness / OTIF ──────────────────────────────────────────────────────

@with_session
async def test_completeness_partial_and_full(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    jo = await _of(s, plant)
    await _bom(s, jo, [("PAN-01", 10, "Panneaux"), ("QUI-01", 10, "Quincaillerie")])
    await _in(s, plant, jo, "PAN-01", 10)
    await _in(s, plant, jo, "QUI-01", 8)

    o = _find(await compute_state(s, plant.id), jo)
    assert o["completeness_pct"] == 90.0     # (10 + 8) / 20
    assert o["in_full"] is False
    assert o["state"] == "awaiting"

    await _in(s, plant, jo, "QUI-01", 2)
    o = _find(await compute_state(s, plant.id), jo)
    assert o["completeness_pct"] == 100.0
    assert o["in_full"] is True
    assert o["state"] == "complete"


@with_session
async def test_over_receive_caps_pct_and_outbound_keeps_completeness(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    jo = await _of(s, plant)
    await _bom(s, jo, [("PAN-01", 5, None), ("QUI-01", 5, None)])
    await _in(s, plant, jo, "PAN-01", 9)     # over-receive → capped per component
    o = _find(await compute_state(s, plant.id), jo)
    assert o["completeness_pct"] == 50.0

    await _in(s, plant, jo, "QUI-01", 5)
    await _out(s, plant, jo, "PAN-01", 6)    # partial exit — completeness is CUMULATIVE received
    o = _find(await compute_state(s, plant.id), jo)
    assert o["in_full"] is True
    pan = next(c for c in o["components"] if c["code"] == "PAN-01")
    assert pan["received"] == 9 and pan["on_hand"] == 3


@with_session
async def test_kpis_in_full_and_almost(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    full = await _of(s, plant)
    await _bom(s, full, [("A", 10, None)])
    await _in(s, plant, full, "A", 10)
    almost = await _of(s, plant)
    await _bom(s, almost, [("B", 10, None)])
    await _in(s, plant, almost, "B", 9)
    far = await _of(s, plant)
    await _bom(s, far, [("C", 10, None)])
    await _in(s, plant, far, "C", 2)

    k = (await compute_state(s, plant.id))["kpis"]
    assert k["total"] == 3
    assert k["in_full"] == 1
    assert k["almost"] == 1                   # 90% but not full
    assert k["awaiting"] == 2


# ─── derived states ───────────────────────────────────────────────────────────

@with_session
async def test_hold_release_cancel_states(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    jo = await _of(s, plant)
    await _bom(s, jo, [("A", 2, None)])
    await _in(s, plant, jo, "A", 2)

    st = await get_or_create_state(s, jo.id, plant.id)
    st.hold_kind = PitStopHoldKind.quality
    await s.flush()
    assert _find(await compute_state(s, plant.id), jo)["state"] == "quality"

    st.hold_kind = None
    st.released_at = _now()
    await s.flush()
    assert _find(await compute_state(s, plant.id), jo)["state"] == "released"

    jo.status = JobOrderStatus.cancelled
    await s.flush()
    assert _find(await compute_state(s, plant.id), jo)["state"] == "cancelled"


@with_session
async def test_late_by_scheduled_date_and_by_age(s):
    plant = await _plant(s)
    await _pit_stop(s, plant, late_after_hours=1)
    past_due = await _of(s, plant, scheduled=date.today() - timedelta(days=2))
    await _bom(s, past_due, [("A", 5, None)])
    await _in(s, plant, past_due, "A", 1)
    aged = await _of(s, plant)                # no scheduled_date → age threshold (1 h)
    await _bom(s, aged, [("B", 5, None)])
    await _in(s, plant, aged, "B", 1, when=_now() - timedelta(hours=3))
    fresh = await _of(s, plant, scheduled=date.today() + timedelta(days=2))
    await _bom(s, fresh, [("C", 5, None)])
    await _in(s, plant, fresh, "C", 1)

    state = await compute_state(s, plant.id)
    assert _find(state, past_due)["late"] is True
    assert _find(state, aged)["late"] is True
    assert _find(state, fresh)["late"] is False
    assert state["kpis"]["late"] == 2


@with_session
async def test_destination_resolved_by_code(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    line = Machine(name="Ligne test", code=f"L-{uuid.uuid4().hex[:6]}", plant_id=plant.id)
    s.add(line)
    await s.flush()
    jo = await _of(s, plant)
    await _bom(s, jo, [("A", 5, None)])
    await _in(s, plant, jo, "A", 5)
    await _out(s, plant, jo, "A", 2, dest=line.code)
    o = _find(await compute_state(s, plant.id), jo)
    assert o["destination_machine_id"] == str(line.id)
    assert o["destination_name"] == "Ligne test"


# ─── plant scoping ────────────────────────────────────────────────────────────

@with_session
async def test_plant_segregation(s):
    plant_a = await _plant(s)
    plant_b = await _plant(s)
    await _pit_stop(s, plant_a)
    await _pit_stop(s, plant_b)
    jo_a = await _of(s, plant_a)
    await _bom(s, jo_a, [("A", 5, None)])
    await _in(s, plant_a, jo_a, "A", 5)

    state_b = await compute_state(s, plant_b.id)
    assert _find(state_b, jo_a) is None
    assert state_b["kpis"]["total"] == 0


@with_session
async def test_no_pit_stop_returns_none(s):
    plant = await _plant(s)
    assert await compute_state(s, plant.id) is None
