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
    PitStopCategory, PitStopDirection, PitStopHoldKind, PitStopSource,
)
from app.services.pit_stop_service import (                            # noqa: E402
    compute_state, get_or_create_state, ingest_movement, of_family,
    parse_position, pit_stop_config,
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


async def _of(s, plant, *, scheduled=None, qty=None, eu=None):
    jo = JobOrder(
        job_number=f"OF-{uuid.uuid4().hex[:10]}",
        plant_id=plant.id,
        status=JobOrderStatus.in_progress,
        scheduled_date=scheduled,
        target_quantity=qty,
        eu_per_unit=eu,
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


@with_session
async def test_sg_lanes_config_default_and_clamp(s):
    plant = await _plant(s)
    eq = await _pit_stop(s, plant)                     # no sg_lanes override
    assert pit_stop_config(eq)["sg_lanes"] == 7        # default (soft-goods area)
    # never larger than lanes-1 (always ≥1 case-goods lane)
    tight = await _pit_stop(s, plant, lanes=10, sg_lanes=99)
    assert pit_stop_config(tight)["sg_lanes"] == 9


# ─── CG/SG furniture family ───────────────────────────────────────────────────

def test_of_family_by_product_name():
    # soft goods = rembourrage/coussins/sofas/fauteuils; everything else = case goods
    assert of_family("Sofa 2 places tissu gris", []) == "sg"
    assert of_family("Fauteuil lounge beige", []) == "sg"
    assert of_family("Tête de lit rembourrée Queen", []) == "sg"
    assert of_family("Commode 6 tiroirs noyer", []) == "cg"
    assert of_family('Bureau étudiant 42"', []) == "cg"


def test_of_family_by_bom_majority_when_no_name():
    soft = [{"category": "Coussins"}, {"category": "Rembourrage"}, {"category": "Panneaux"}]
    hard = [{"category": "Panneaux"}, {"category": "Quincaillerie"}, {"category": "Tiroirs"}]
    assert of_family(None, soft) == "sg"
    assert of_family(None, hard) == "cg"


@with_session
async def test_categories_expose_family(s):
    plant = await _plant(s)
    await _pit_stop(s, plant)
    s.add(PitStopCategory(plant_id=plant.id, name="Panneaux", color="#b98a4e", family="both", sort_order=0))
    s.add(PitStopCategory(plant_id=plant.id, name="Tiroirs", color="#5aa9a0", family="cg", sort_order=2))
    await s.flush()
    cats = {c["name"]: c["family"] for c in (await compute_state(s, plant.id))["categories"]}
    assert cats == {"Panneaux": "both", "Tiroirs": "cg"}


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
async def test_completeness_weakest_category_and_full(s):
    """Completeness = MIN across category availabilities (client's DispoPit%),
    not the quantity-weighted global ratio."""
    plant = await _plant(s)
    await _pit_stop(s, plant)
    jo = await _of(s, plant)
    await _bom(s, jo, [("PAN-01", 10, "Panneaux"), ("QUI-01", 10, "Quincaillerie")])
    await _in(s, plant, jo, "PAN-01", 10)
    await _in(s, plant, jo, "QUI-01", 8)

    o = _find(await compute_state(s, plant.id), jo)
    assert o["completeness_pct"] == 80.0     # min(PAN 100 %, QUI 80 %) — weakest link
    assert o["in_full"] is False
    assert o["state"] == "awaiting"

    await _in(s, plant, jo, "QUI-01", 2)
    o = _find(await compute_state(s, plant.id), jo)
    assert o["completeness_pct"] == 100.0
    assert o["in_full"] is True
    assert o["state"] == "complete"


@with_session
async def test_carton_category_never_gates_availability(s):
    """The client's OAV report excludes BOX/carton from DispoPit%: a missing
    carton keeps the OF 100 % available, but in_full stays False (physical)."""
    plant = await _plant(s)
    await _pit_stop(s, plant)
    jo = await _of(s, plant)
    await _bom(s, jo, [("PAN-01", 10, "Panneaux"), ("BOX-01", 4, "Carton")])
    await _in(s, plant, jo, "PAN-01", 10)    # carton never received

    o = _find(await compute_state(s, plant.id), jo)
    assert o["completeness_pct"] == 100.0    # carton excluded from the min
    assert o["in_full"] is False             # every line, carton included

    only_box = await _of(s, plant)           # degenerate: BOM is carton only
    await _bom(s, only_box, [("BOX-02", 4, "Carton")])
    await _in(s, plant, only_box, "BOX-02", 2)
    o = _find(await compute_state(s, plant.id), only_box)
    assert o["completeness_pct"] == 50.0     # falls back to the carton itself


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
    await _bom(s, almost, [("B", 100, None)])
    await _in(s, plant, almost, "B", 92)      # 92 % — strictly over 90
    exactly90 = await _of(s, plant)
    await _bom(s, exactly90, [("C", 10, None)])
    await _in(s, plant, exactly90, "C", 9)    # exactly 90 % — NOT in the band (>90 strict)

    k = (await compute_state(s, plant.id))["kpis"]
    assert k["total"] == 3
    assert k["in_full"] == 1
    assert k["almost"] == 1                   # only the 92 % one
    assert k["awaiting"] == 2


@with_session
async def test_otif_bands_eu_weighted_over_open_ofs(s):
    """OTIF = band CG EU ÷ total open CG EU (availability-weighted UEdispo,
    no date filter) — mirrors the client's N7/N2."""
    plant = await _plant(s)
    await _pit_stop(s, plant)
    full = await _of(s, plant, qty=10, eu=1.0)          # 10 EU, 100 % → dispo 10
    await _bom(s, full, [("A", 10, "Panneaux")])
    await _in(s, plant, full, "A", 10)
    half = await _of(s, plant, qty=10, eu=1.0)          # 10 EU, 50 % → dispo 5
    await _bom(s, half, [("B", 10, "Panneaux")])
    await _in(s, plant, half, "B", 5)

    otif = (await compute_state(s, plant.id))["kpis"]["otif"]
    assert otif["full"]["cg_eu"] == 10
    assert otif["full"]["cg_ofs"] == 1
    assert otif["full"]["otif_pct"] == 67                # 10 / (10 + 5)
    assert otif["ge90"]["cg_eu"] == 10                   # cumulative, 50 % OF outside
    assert otif["ge90"]["otif_pct"] == 67


@with_session
async def test_board_pit_line_hardware_repair_split(s):
    """The TV board mirrors the client's Feuil1 table: pit vs on-line split,
    assigned-not-available, hardware-only blockage, repair-aged exclusion."""
    plant = await _plant(s)
    await _pit_stop(s, plant, repair_after_days=2)
    pit = await _of(s, plant, qty=10, eu=1.0)            # waiting in pit, 100 %
    await _bom(s, pit, [("A", 10, "Panneaux")])
    await _in(s, plant, pit, "A", 10)
    released = await _of(s, plant, qty=10, eu=1.0)       # on line, 50 % available
    await _bom(s, released, [("B", 10, "Panneaux")])
    await _in(s, plant, released, "B", 5)
    st = await get_or_create_state(s, released.id, plant.id)
    st.released_at = _now()
    await s.flush()
    stale = await _of(s, plant, qty=4, eu=1.0)           # aged past 2 days → repair row
    await _bom(s, stale, [("C", 4, "Panneaux")])
    await _in(s, plant, stale, "C", 4, when=_now() - timedelta(days=3))
    hw = await _of(s, plant, qty=6, eu=1.0)              # blocked ONLY by hardware
    await _bom(s, hw, [("D", 6, "Panneaux"), ("E", 6, "Quincaillerie")])
    await _in(s, plant, hw, "D", 6)
    await _in(s, plant, hw, "E", 3)

    k = (await compute_state(s, plant.id))["kpis"]
    b = k["board"]
    assert b["eu_pit"]["cg"] == 13                       # 10 full + 3 (hw OF at 50 %)
    assert b["on_line"]["cg"] == 5                       # released, availability-weighted
    assert b["eu_total"]["cg"] == 18                     # repair EU netted out
    assert b["assigned_unavailable"]["cg"] == 5          # released OF's missing half
    assert b["awaiting_hardware"]["cg"] == 6             # full EU unlocked by hardware
    assert b["awaiting_repair"]["cg"] == 4
    # the aged OF left the bands AND the OTIF denominator (client's N7/N2)
    assert k["otif"]["full"]["cg_eu"] == 10
    assert k["otif"]["full"]["otif_pct"] == 56           # 10 / 18


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
