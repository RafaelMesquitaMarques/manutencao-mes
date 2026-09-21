"""
Shift replay — reconstruction against the real database (factory_replay).
=========================================================================
Same harness as test_of_watch.py / test_pit_stop.py: a single shared event
loop and ALL writes rolled back at the end. This validates what the pure tests
(test_factory_replay.py) cannot — the real SQL: the DISTINCT ON of the
parked queue, the stop category enums, the joins to the operator and to the
technicians, and the translation from machine_id to equipment_id.

The seeded scenario is a known morning shift:

  06:00  OF-1001 enters the saw
  07:00  unplanned stop (broken blade) + ticket opened
  07:30  technician starts the intervention; 08:00 a second technician joins
  08:30  intervention ends (the open stop takes over again)
  09:00  stop and ticket close
  11:00  20-min stop WITHOUT a category (pink)
  11:00  OF-1002 enters the saw (stays open until the end of the shift)
  12:00  30-min planned break
  + an OF whose last run closed 10 h BEFORE the shift (parked queue)

Run (inside the backend container):
    pytest tests/test_factory_replay_db.py -v
"""
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone


sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.models.models import (                                       # noqa: E402
    AlertPriority, Equipment, EquipmentStatus, InterventionTechnician, JobOrder,
    JobOrderRun, JobOrderStatus, Machine, MachineIntervention, MachineOperator,
    MachineProductionHourly, MachineStatus, MachineStop, MaintenanceTicket,
    PitStopDirection, PitStopMovement, PitStopSource, Plant, StopCategory,
    StopCategoryType, TicketStatus,
)
from app.services import factory_replay as fr                         # noqa: E402
from db_harness import with_session    # noqa: E402


UTC = timezone.utc
# 06:00 → 14:00 Saint-Jérôme time (EDT, UTC-4) on a fixed date in the past.
WS = datetime(2026, 6, 16, 10, 0, tzinfo=UTC)
WE = WS + timedelta(hours=8)
H = timedelta(hours=1)
MIN = timedelta(minutes=1)


async def _seed(s):
    """The shift described in the header. Returns (plant, saw, conveyor, hvac, ofs),
    ofs being the {a, b, old} job orders."""
    plant = Plant(code=f"T{uuid.uuid4().hex[:6]}", name="Test plant", timezone="America/Toronto")
    s.add(plant)
    await s.flush()

    saw = Equipment(plant_id=plant.id, code=f"SAW-{uuid.uuid4().hex[:6]}", name="Scie",
                    status=EquipmentStatus.running, block_kind="beam_saw", active=True)
    conveyor = Equipment(plant_id=plant.id, code=f"CNV-{uuid.uuid4().hex[:6]}", name="Convoyeur",
                         status=EquipmentStatus.running, block_kind="conveyor", active=True)
    hvac = Equipment(plant_id=plant.id, code=f"HV-{uuid.uuid4().hex[:6]}", name="HVAC",
                     status=EquipmentStatus.running, asset_type="auxiliary", active=True)
    s.add_all([saw, conveyor, hvac])
    await s.flush()
    conveyor.parent_equipment_id = saw.id

    m_saw = Machine(name="Scie", equipment_id=saw.id, plant_id=plant.id, is_active=True,
                    current_status=MachineStatus.running,
                    shifts_config={"morning": {"start": "06:00", "end": "14:00"},
                                   "afternoon": {"start": "14:00", "end": "22:00"}})
    m_conv = Machine(name="Convoyeur", equipment_id=conveyor.id, plant_id=plant.id,
                     is_active=True, current_status=MachineStatus.running)
    s.add_all([m_saw, m_conv])
    await s.flush()

    op = MachineOperator(machine_id=m_saw.id, plant_id=plant.id, name="Opérateur A")
    s.add(op)
    await s.flush()

    unplanned = StopCategory(machine_id=m_saw.id, name="Bris mécanique", type=StopCategoryType.unplanned)
    planned = StopCategory(machine_id=m_saw.id, name="Pause", type=StopCategoryType.planned)
    s.add_all([unplanned, planned])
    await s.flush()

    s.add_all([
        MachineStop(machine_id=m_saw.id, plant_id=plant.id, started_at=WS + 1 * H,
                    ended_at=WS + 3 * H, stop_category_id=unplanned.id,
                    comments="Lame cassée", operator_id=op.id),
        MachineStop(machine_id=m_saw.id, plant_id=plant.id, started_at=WS + 5 * H,
                    ended_at=WS + 5 * H + 20 * MIN),                     # no category → pink
        MachineStop(machine_id=m_saw.id, plant_id=plant.id, started_at=WS + 6 * H,
                    ended_at=WS + 6 * H + 30 * MIN, stop_category_id=planned.id),
    ])

    ticket = MaintenanceTicket(ticket_number=f"TK-{uuid.uuid4().hex[:8]}", machine_id=m_saw.id,
                               plant_id=plant.id, status=TicketStatus.completed,
                               priority=AlertPriority.high, opened_at=WS + 1 * H,
                               completed_at=WS + 3 * H, description="Bris de lame")
    s.add(ticket)
    await s.flush()

    iv = MachineIntervention(plant_id=plant.id, machine_id=m_saw.id, equipment_id=saw.id,
                             ticket_id=ticket.id, status="completed", called_at=WS + 1 * H,
                             started_at=WS + 1 * H + 30 * MIN, completed_at=WS + 2 * H + 30 * MIN,
                             started_by_name="Tech 1", intervention_type_name="Mécanique")
    s.add(iv)
    await s.flush()
    s.add_all([
        InterventionTechnician(intervention_id=iv.id, name="Tech 1",
                               checked_in_at=WS + 1 * H + 30 * MIN,
                               checked_out_at=WS + 2 * H + 30 * MIN),
        InterventionTechnician(intervention_id=iv.id, name="Tech 2",
                               checked_in_at=WS + 2 * H, checked_out_at=WS + 2 * H + 30 * MIN),
    ])

    def _of(number, product):
        return JobOrder(plant_id=plant.id, job_number=number, product_name=product,
                        status=JobOrderStatus.in_progress, machine_id=m_saw.id)

    tag = uuid.uuid4().hex[:6]
    of_a, of_b, of_old = (_of(f"OF-A-{tag}", "Panneau A"), _of(f"OF-B-{tag}", "Panneau B"),
                          _of(f"OF-OLD-{tag}", "Panneau vieux"))
    s.add_all([of_a, of_b, of_old])
    await s.flush()
    s.add_all([
        JobOrderRun(job_order_id=of_a.id, machine_id=m_saw.id, plant_id=plant.id,
                    started_at=WS, ended_at=WS + 4 * H, pieces=40, operator_id=op.id),
        JobOrderRun(job_order_id=of_b.id, machine_id=m_saw.id, plant_id=plant.id,
                    started_at=WS + 5 * H, ended_at=None, pieces=12),
        JobOrderRun(job_order_id=of_old.id, machine_id=m_saw.id, plant_id=plant.id,
                    started_at=WS - 12 * H, ended_at=WS - 10 * H, pieces=5),
    ])
    s.add(PitStopMovement(plant_id=plant.id, job_order_id=of_a.id, component_code="PAN-1",
                          direction=PitStopDirection("in"), quantity=4,
                          occurred_at=WS + 5 * H, source=PitStopSource.sap))
    s.add_all([
        MachineProductionHourly(machine_id=m_saw.id, hour=WS, count=10, reject_count=1),
        MachineProductionHourly(machine_id=m_saw.id, hour=WS + 1 * H, count=20, reject_count=0),
    ])
    await s.flush()
    return plant, saw, conveyor, hvac, dict(a=of_a, b=of_b, old=of_old)


def _segment_at(track, minutes):
    t = (WS + timedelta(minutes=minutes)).isoformat()
    for seg in track["segments"]:
        if seg["start"] <= t < seg["end"]:
            return seg
    return None


# ── States ────────────────────────────────────────────────────────────────────

@with_session
async def test_shift_state_sequence(s):
    """Minute by minute: running · red stop (the ticket opens, but a stopped
    machine stays red, as in live_status.effective_status) · purple while the
    technician is there · red again until the stop closes · running
    · pink without a category · blue during the planned break."""
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(saw.id))
    got = [(_segment_at(track, m)["status"], _segment_at(track, m)["source"])
           for m in (30, 70, 100, 149, 160, 220, 310, 365, 420)]
    assert got == [
        ("running", "baseline"), ("stopped", "stop"), ("intervention", "intervention"),
        ("intervention", "intervention"), ("stopped", "stop"), ("running", "baseline"),
        ("unjustified", "stop"), ("planned_stop", "stop"), ("running", "baseline"),
    ]


@with_session
async def test_the_stop_carries_justification_and_operator(s):
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(saw.id))
    seg = _segment_at(track, 70)
    assert seg["reason"] == "Bris mécanique"
    assert seg["detail"]["comments"] == "Lame cassée"
    assert seg["detail"]["operator"] == "Opérateur A"


@with_session
async def test_the_ticket_is_recorded_separately_from_the_color(s):
    """The red stop wins the block, but the amber badge must stay exact."""
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(saw.id))
    assert _segment_at(track, 70)["status"] == "stopped"
    assert len(track["ticket_spans"]) == 1
    span = track["ticket_spans"][0]
    assert span["start"] == (WS + 1 * H).isoformat()
    assert span["end"] == (WS + 3 * H).isoformat()


@with_session
async def test_technicians_with_check_in_and_check_out(s):
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(saw.id))
    techs = _segment_at(track, 100)["detail"]["technicians"]
    assert sorted(t["name"] for t in techs) == ["Tech 1", "Tech 2"]
    assert all(t["since"] and t["until"] for t in techs)


@with_session
async def test_asset_without_mes_layer_is_not_painted_green(s):
    plant, _, _, hvac, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(hvac.id))
    assert track["machine_id"] is None
    assert [seg["status"] for seg in track["segments"]] == ["idle"]
    assert track["segments"][0]["source"] == "no_history"


@with_session
async def test_the_segments_cover_the_window_without_gaps(s):
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(saw.id))
    segs = track["segments"]
    assert segs[0]["start"] == WS.isoformat()
    assert segs[-1]["end"] == WE.isoformat()
    assert all(a["end"] == b["start"] for a, b in zip(segs, segs[1:]))


# ── OFs, buffer and production ────────────────────────────────────────────────

@with_session
async def test_window_runs_and_parked_queue(s):
    """The runs that touch the window, plus the last closed run of each OF in
    the preceding hours — that is the one that rebuilds what was already parked
    at the output when the shift started (the DISTINCT ON)."""
    plant, saw, _, _, ofs = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    runs = {r["job_number"]: r for r in tl["of_runs"]}
    assert runs[ofs["a"].job_number]["carry_in"] is False
    assert runs[ofs["a"].job_number]["ended_at"] == (WS + 4 * H).isoformat()
    assert runs[ofs["a"].job_number]["operator"] == "Opérateur A"
    assert runs[ofs["b"].job_number]["ended_at"] is None          # still open at the end of the shift
    assert runs[ofs["old"].job_number]["carry_in"] is True
    assert all(r["equipment_id"] == str(saw.id) for r in tl["of_runs"])


@with_session
async def test_buffer_ledger_and_hourly_production(s):
    plant, saw, _, _, ofs = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    assert [p["job_number"] for p in tl["pit_events"]] == [ofs["a"].job_number]
    assert tl["pit_events"][0]["quantity"] == 4
    assert sum(p["count"] for p in tl["production"]) == 30
    assert all(p["equipment_id"] == str(saw.id) for p in tl["production"])


@with_session
async def test_ticket_events_land_on_the_timeline(s):
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    kinds = sorted(e["kind"] for e in tl["events"])
    assert kinds == ["ticket_closed", "ticket_opened"]
    assert all(e["equipment_id"] == str(saw.id) for e in tl["events"])


@with_session
async def test_the_returned_window_is_the_requested_one(s):
    plant, _, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    assert tl["start"] == WS.isoformat()
    assert tl["end"] == WE.isoformat()
    assert tl["timezone"] == "America/Toronto"


# ── Shift windows ─────────────────────────────────────────────────────────────

@with_session
async def test_the_days_shifts_come_from_shifts_config(s):
    plant, _, _, _, _ = await _seed(s)
    out = await fr.shift_windows_for_day(s, plant.id, datetime(2026, 6, 16).date())
    assert [w["key"] for w in out["windows"]] == ["morning", "afternoon"]
    assert out["windows"][0]["start"] == WS.isoformat()
    assert out["windows"][0]["end"] == WE.isoformat()
    # A shift shared by N machines is ONE option with the right count.
    assert out["windows"][0]["machine_count"] == 1
    assert out["day"]["start"] < out["day"]["end"]
