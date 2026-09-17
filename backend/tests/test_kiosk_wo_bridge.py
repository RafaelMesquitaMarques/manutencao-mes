"""
Kiosk → work order bridge: labor, repair time and cost.
=======================================================
A corrective repair declared at the kiosk used to leave its work order empty:
no labor record, ``repair_hours``/MTTR NULL and cost 0, because the kiosk router
never touched work orders and ``_close_linked_wo`` only knew how to measure from
``wo.started_at`` (which a kiosk-born WO never had). These tests pin the bridge
that fixes it, plus the part-price fallback and the machine/intervention guard.

Same isolation contract as test_labor_integration.py: one shared event loop, one
transaction per test, ALWAYS rolled back — the database is never mutated.

Run (inside the backend container):
    pip install pytest
    pytest tests/test_kiosk_wo_bridge.py -v
"""
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.models.models import (                                          # noqa: E402
    Equipment, InterventionPart, InterventionTechnician, LaborRecord, Machine,
    MachineIntervention, MaintenanceTicket, Plant, StockItem, Technician,
    TicketStatus, User, UserPlant, UserRole, WOPart, WorkOrder, WorkOrderStatus,
    WorkOrderTechnician, WorkOrderType,
)
from app.services import kiosk_wo_bridge, part_pricing, wo_totals        # noqa: E402
from db_harness import with_session    # noqa: E402


# ── fixtures ──────────────────────────────────────────────────────────────────

BASE = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)   # a Monday afternoon


async def _plant(s):
    p = (await s.execute(select(Plant).limit(1))).scalars().first()
    assert p is not None, "at least one plant must exist"
    return p


async def _mk_tech(s, *, rate=None, shift="day", plant=None):
    """A throwaway technician, member of a plant like every real one (all 14 live
    technicians hold a UserPlant row; the assignment guards depend on it)."""
    u = User(id=uuid.uuid4(), name=f"kb-{uuid.uuid4().hex[:6]}",
             email=f"kb-{uuid.uuid4().hex[:10]}@test.local", password_hash="x", active=True)
    s.add(u)
    await s.flush()
    tech = Technician(id=uuid.uuid4(), user_id=u.id, shift=shift, hourly_rate=rate, active=True)
    s.add(tech)
    s.add(UserPlant(id=uuid.uuid4(), user_id=u.id,
                    plant_id=(plant or await _plant(s)).id, role=UserRole.technician))
    await s.flush()
    return tech


async def _mk_repair(s, *, started=BASE, completed=None, duration_minutes=None):
    """A kiosk repair in flight: equipment + machine + ticket + WO + intervention,
    wired exactly like the live flow (WO born `open`, no started_at)."""
    plant = await _plant(s)
    eq = Equipment(id=uuid.uuid4(), plant_id=plant.id, code=f"KB-{uuid.uuid4().hex[:6]}",
                   name=f"KB rig {uuid.uuid4().hex[:4]}")
    s.add(eq)
    await s.flush()
    machine = Machine(id=uuid.uuid4(), name=eq.name, code=eq.code, equipment_id=eq.id,
                      plant_id=plant.id, is_active=True)
    s.add(machine)
    await s.flush()

    ticket = MaintenanceTicket(id=uuid.uuid4(), ticket_number=f"KB-TKT-{uuid.uuid4().hex[:8]}",
                               machine_id=machine.id, plant_id=plant.id,
                               status=TicketStatus.in_progress, opened_at=started - timedelta(minutes=2))
    s.add(ticket)
    await s.flush()

    wo = WorkOrder(id=uuid.uuid4(), wo_number=f"KB-{uuid.uuid4().hex[:10]}",
                   equipment_id=eq.id, plant_id=plant.id, machine_id=machine.id,
                   type=WorkOrderType.corrective, status=WorkOrderStatus.open,
                   title="kiosk bridge test", ticket_id=ticket.id,
                   opened_at=started - timedelta(minutes=2))
    s.add(wo)
    await s.flush()
    ticket.work_order_id = wo.id

    mi = MachineIntervention(
        id=uuid.uuid4(), plant_id=plant.id, machine_id=machine.id, equipment_id=eq.id,
        ticket_id=ticket.id, status="completed" if completed else "in_progress",
        called_at=started - timedelta(minutes=2), started_at=started, completed_at=completed,
        intervention_duration_minutes=duration_minutes,
    )
    s.add(mi)
    await s.flush()
    return machine, ticket, wo, mi


async def _checkin(s, mi, tech, *, at, out=None):
    row = InterventionTechnician(id=uuid.uuid4(), intervention_id=mi.id,
                                 technician_id=tech.id, name="kb tech",
                                 checked_in_at=at, checked_out_at=out)
    s.add(row)
    await s.flush()
    return row


async def _labor(s, wo):
    return (await s.execute(
        select(LaborRecord).where(LaborRecord.work_order_id == wo.id)
        .order_by(LaborRecord.started_at.asc())
    )).scalars().all()


# ── start: the WO is really in progress and the clock runs ───────────────────

@with_session
async def test_start_moves_wo_in_progress_and_opens_labor(s):
    _, _, wo, mi = await _mk_repair(s)
    tech = await _mk_tech(s)
    await _checkin(s, mi, tech, at=BASE - timedelta(minutes=1))   # joined during the wait

    await kiosk_wo_bridge.on_intervention_started(s, mi)
    await s.flush()

    assert wo.status == WorkOrderStatus.in_progress
    assert wo.started_at == mi.started_at

    recs = await _labor(s, wo)
    assert len(recs) == 1
    rec = recs[0]
    assert rec.intervention_id == mi.id
    assert rec.stopped_at is None                  # still running
    assert rec.hours_worked == 0.0                 # nothing settled yet
    # A tech who checked in while the call was still WAITING is not repairing yet:
    # the labor window opens with the intervention, not with the check-in.
    assert rec.started_at == mi.started_at

    link = (await s.execute(select(WorkOrderTechnician).where(
        WorkOrderTechnician.work_order_id == wo.id))).scalars().all()
    assert [l.technician_id for l in link] == [tech.id]


# ── completion: one honest window per technician ─────────────────────────────

@with_session
async def test_completion_mirrors_every_checkin_window(s):
    """Two techs, one leaving early → two records with their own raw spans, and
    the WO's repair time is stamped from them (it used to stay NULL)."""
    end = BASE + timedelta(minutes=30)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=30)
    a, b = await _mk_tech(s, rate=60.0), await _mk_tech(s)
    await _checkin(s, mi, a, at=BASE)
    await _checkin(s, mi, b, at=BASE + timedelta(minutes=10),
                   out=BASE + timedelta(minutes=20))

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    recs = await _labor(s, wo)
    assert len(recs) == 2
    by_tech = {r.technician_id: r for r in recs}
    assert round(by_tech[a.id].hours_worked * 60) == 30     # start → completion
    assert round(by_tech[b.id].hours_worked * 60) == 10     # own check-out honored
    assert all(r.stopped_at is not None for r in recs)
    assert by_tech[b.id].stopped_at == BASE + timedelta(minutes=20)

    # 40 raw MAN-minutes across two techs, but the repair itself took 30 minutes
    # of clock: repair_hours feeds MTTR, so it must be the duration, not the effort.
    assert wo.repair_hours == pytest.approx(30 / 60, abs=1e-4)
    assert wo.total_minutes == 30


@with_session
async def test_sync_is_idempotent(s):
    """Replaying the hooks (retry, backfill, double completion) must not
    duplicate or inflate anything."""
    end = BASE + timedelta(minutes=12)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=12)
    tech = await _mk_tech(s)
    await _checkin(s, mi, tech, at=BASE)

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()
    first = [(r.id, r.hours_worked) for r in await _labor(s, wo)]

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()
    again = [(r.id, r.hours_worked) for r in await _labor(s, wo)]

    assert first == again
    assert len(await _labor(s, wo)) == 1


@with_session
async def test_zero_length_window_is_not_logged(s):
    """Checked out at the very instant of check-in (mis-tap) → no labor line."""
    _, _, wo, mi = await _mk_repair(s, completed=BASE + timedelta(minutes=5),
                                    duration_minutes=5)
    tech = await _mk_tech(s)
    at = BASE + timedelta(minutes=1)
    await _checkin(s, mi, tech, at=at, out=at)

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()
    assert await _labor(s, wo) == []


@with_session
async def test_no_checkin_credits_the_starter(s):
    """A mechanic who started the repair without checking in is still credited
    (falls back to started_by_id → their technician profile)."""
    end = BASE + timedelta(minutes=8)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=8)
    tech = await _mk_tech(s)
    mi.started_by_id = tech.user_id
    await s.flush()

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    recs = await _labor(s, wo)
    assert len(recs) == 1
    assert recs[0].technician_id == tech.id
    assert round(recs[0].hours_worked * 60) == 8


@with_session
async def test_office_labor_records_are_left_alone(s):
    """A record typed by hand in the office has no intervention_id — the bridge
    must not touch it, and it must still count toward the totals."""
    end = BASE + timedelta(minutes=10)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=10)
    manual_tech = await _mk_tech(s)
    manual = LaborRecord(id=uuid.uuid4(), work_order_id=wo.id, technician_id=manual_tech.id,
                         date=BASE.date(), hours_worked=2.0, activity="Typed in the office")
    s.add(manual)
    await s.flush()

    kiosk_tech = await _mk_tech(s)
    await _checkin(s, mi, kiosk_tech, at=BASE)

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    await s.refresh(manual)
    assert manual.hours_worked == 2.0 and manual.intervention_id is None
    assert manual.stopped_at is None            # no timestamps → nothing to close
    assert len(await _labor(s, wo)) == 2
    # A manual "2 hours" cannot be placed on the clock, so it is taken as given and
    # added to the 10 measured minutes.
    assert wo.total_minutes == 130


# ── totals: cost and the intervention-duration fallback ──────────────────────

@with_session
async def test_totals_include_parts_and_labor(s):
    end = BASE + timedelta(minutes=60)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=60)
    tech = await _mk_tech(s, rate=50.0)
    await _checkin(s, mi, tech, at=BASE)
    s.add(WOPart(id=uuid.uuid4(), work_order_id=wo.id, description="belt",
                 quantity=2, unit="un", unit_cost=12.5, total_cost=25.0))
    await s.flush()

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    rec = (await _labor(s, wo))[0]
    assert rec.hourly_rate == 50.0
    assert rec.labor_cost is not None and rec.labor_cost > 0
    assert wo.total_cost == pytest.approx(round(rec.labor_cost + 25.0, 2))


@with_session
async def test_repair_time_falls_back_to_intervention_duration(s):
    """Nobody to credit (no check-in, no starter) → the WO still gets the time
    the kiosk measured instead of staying blank."""
    end = BASE + timedelta(minutes=7)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=7)
    wo.status = WorkOrderStatus.completed
    wo.completed_at = end
    await s.flush()

    await wo_totals.recompute(s, wo)

    assert await _labor(s, wo) == []
    assert wo.total_minutes == 7
    assert wo.repair_hours == pytest.approx(7 / 60, abs=1e-4)


@with_session
async def test_sub_minute_repair_is_never_rounded_to_nothing(s):
    """A 25-second repair used to truncate to 0 minutes and read "no time
    recorded"; it must land on the smallest honest value instead."""
    end = BASE + timedelta(seconds=25)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=0.42)
    wo.status = WorkOrderStatus.completed
    wo.completed_at = end
    await s.flush()

    await wo_totals.recompute(s, wo)
    assert wo.total_minutes == 1
    assert wo.repair_hours and wo.repair_hours > 0


# ── part pricing ─────────────────────────────────────────────────────────────

def test_price_prefers_catalog_then_average_then_last_purchase():
    """The inventory import carries no prices, so purchase history is the only
    real source — but a catalog price, when set, still wins."""
    assert part_pricing.unit_cost_of(
        StockItem(unit_cost=10.0, average_cost=8.0, last_purchase_cost=9.0)) == 10.0
    assert part_pricing.unit_cost_of(
        StockItem(unit_cost=None, average_cost=8.0, last_purchase_cost=9.0)) == 8.0
    assert part_pricing.unit_cost_of(
        StockItem(unit_cost=None, average_cost=None, last_purchase_cost=9.0)) == 9.0


def test_unknown_price_stays_none_not_zero():
    """A part with no known price must read "no price", never $0.00."""
    assert part_pricing.unit_cost_of(StockItem()) is None
    assert part_pricing.unit_cost_of(None) is None
    assert part_pricing.line_total(None, 3) is None
    assert part_pricing.line_total(2.5, 4) == 10.0


@with_session
async def test_concurrent_technicians_do_not_inflate_mttr(s):
    """Three techs on the same 10 minutes is a 10-minute repair. Summing their
    effort would report 30 and push MTTR up by 3x."""
    end = BASE + timedelta(minutes=10)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=10)
    for _ in range(3):
        await _checkin(s, mi, await _mk_tech(s), at=BASE)

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    recs = await _labor(s, wo)
    assert len(recs) == 3
    assert round(sum(r.hours_worked for r in recs) * 60) == 30      # effort: 30 man-minutes
    assert wo.total_minutes == 10                                   # duration: 10 minutes
    assert wo.repair_hours == pytest.approx(10 / 60, abs=1e-4)


@with_session
async def test_separate_sessions_add_up(s):
    """Two non-overlapping visits on the same WO are 15 + 10 = 25 minutes of
    repair — the union must not collapse them into one span."""
    _, _, wo, mi = await _mk_repair(s, completed=BASE + timedelta(hours=5),
                                    duration_minutes=300)
    tech = await _mk_tech(s)
    await _checkin(s, mi, tech, at=BASE, out=BASE + timedelta(minutes=15))
    await _checkin(s, mi, tech, at=BASE + timedelta(hours=4),
                   out=BASE + timedelta(hours=4, minutes=10))

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    assert len(await _labor(s, wo)) == 2
    assert wo.total_minutes == 25
    # NOT the 5-hour span the intervention was open for.
    assert wo.repair_hours == pytest.approx(25 / 60, abs=1e-4)


# ── parts: the kiosk ledger is money on the WO, counted exactly once ─────────

async def _mk_stock(s, *, unit_cost=None, average_cost=None):
    plant = await _plant(s)
    item = StockItem(id=uuid.uuid4(), plant_id=plant.id, code=f"KB-{uuid.uuid4().hex[:8]}",
                     name="kb part", description="kb part", unit="un",
                     unit_cost=unit_cost, average_cost=average_cost)
    s.add(item)
    await s.flush()
    return item


async def _mk_kiosk_part(s, mi, *, status, total_cost):
    part = InterventionPart(
        id=uuid.uuid4(), intervention_id=mi.id, stock_item_id=(await _mk_stock(s)).id,
        item_code="KB-CODE", item_description="belt", quantity_used=2, unit="un",
        unit_cost=(total_cost / 2 if total_cost is not None else None),
        total_cost=total_cost, approval_status=status,
    )
    s.add(part)
    await s.flush()
    return part


async def _wo_parts(s, wo):
    return (await s.execute(
        select(WOPart).where(WOPart.work_order_id == wo.id)
    )).scalars().all()


@with_session
async def test_approved_kiosk_part_is_money_on_the_work_order(s):
    """A part consumed on the floor used to be money in the Costs dashboards but
    not on its own WO. It counts now — and it stays in ONE ledger: copying it into
    wo_parts would double it, because every platform aggregate sums both."""
    end = BASE + timedelta(minutes=20)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=20)
    await _mk_kiosk_part(s, mi, status="approved", total_cost=14.50)

    assert await wo_totals.kiosk_parts_total(s, wo) == 14.50

    await wo_totals.recompute(s, wo)
    assert wo.total_cost == 14.50
    assert await _wo_parts(s, wo) == []          # nothing mirrored -> nothing doubled

    # Idempotent: rolling up again must not accumulate.
    await wo_totals.recompute(s, wo)
    assert wo.total_cost == 14.50


@with_session
async def test_pending_and_refused_kiosk_parts_are_not_money(s):
    """A line the supervisor has not approved is not a commitment; a refused one
    was turned down. Neither may reach the cost."""
    end = BASE + timedelta(minutes=20)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=20)
    await _mk_kiosk_part(s, mi, status="pending", total_cost=100.0)
    await _mk_kiosk_part(s, mi, status="rejected", total_cost=250.0)

    assert await wo_totals.kiosk_parts_total(s, wo) == 0.0
    await wo_totals.recompute(s, wo)
    assert wo.total_cost is None


# ── one record per technician per stretch of clock ───────────────────────

@with_session
async def test_office_started_repair_finished_at_the_kiosk_is_not_booked_twice(s):
    """The office Start button already opened a labor record for this technician.
    Completing at the kiosk must ADOPT it, not add a second one — otherwise the
    Labor tab lists the same person twice and the cost doubles."""
    end = BASE + timedelta(minutes=30)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=30)
    tech = await _mk_tech(s, rate=60.0)
    office = LaborRecord(id=uuid.uuid4(), work_order_id=wo.id, technician_id=tech.id,
                         date=BASE.date(), hours_worked=0.0, hourly_rate=60.0,
                         activity="Repair", started_at=BASE)   # still running
    s.add(office)
    await _checkin(s, mi, tech, at=BASE + timedelta(minutes=2))
    await s.flush()

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    recs = await _labor(s, wo)
    assert len(recs) == 1, "the office record must be adopted, not duplicated"
    rec = recs[0]
    assert rec.id == office.id
    assert rec.intervention_id == mi.id          # provenance stamped on it
    assert rec.activity == "Repair"              # the original entry is preserved
    assert round(rec.hours_worked * 60) == 30    # 30 minutes, booked once
    assert wo.total_minutes == 30


@with_session
async def test_starter_who_then_checks_in_is_counted_once(s):
    """Tapping Start opens a whole-intervention mirror for the starter; tapping
    Check-in afterwards must supersede it, not add a parallel window."""
    _, _, wo, mi = await _mk_repair(s)          # in progress
    tech = await _mk_tech(s)
    mi.started_by_id = tech.user_id
    await s.flush()

    await kiosk_wo_bridge.on_intervention_started(s, mi)   # no check-ins yet -> fallback
    await s.flush()
    assert len(await _labor(s, wo)) == 1

    await _checkin(s, mi, tech, at=BASE + timedelta(minutes=1))
    await kiosk_wo_bridge.on_checkins_changed(s, mi)
    await s.flush()

    mi.status = "completed"
    mi.completed_at = BASE + timedelta(minutes=10)
    mi.intervention_duration_minutes = 10
    await s.flush()
    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    recs = await _labor(s, wo)
    assert len(recs) == 1, "the superseded fallback mirror must be gone"
    assert round(recs[0].hours_worked * 60) == 10
    assert wo.total_minutes == 10


@with_session
async def test_a_separate_office_session_is_left_alone(s):
    """A record for the same technician that does NOT overlap the intervention is
    real separate work: adoption must not swallow it."""
    end = BASE + timedelta(minutes=20)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=20)
    tech = await _mk_tech(s)
    earlier = LaborRecord(
        id=uuid.uuid4(), work_order_id=wo.id, technician_id=tech.id,
        date=(BASE - timedelta(days=1)).date(), hours_worked=1.0, activity="Repair",
        started_at=BASE - timedelta(days=1), stopped_at=BASE - timedelta(days=1) + timedelta(hours=1),
    )
    s.add(earlier)
    await _checkin(s, mi, tech, at=BASE)
    await s.flush()

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    recs = await _labor(s, wo)
    assert len(recs) == 2
    assert wo.total_minutes == 80               # 60 yesterday + 20 today


# ── a human's number outranks a derived one ─────────────────────────

@with_session
async def test_a_typed_repair_time_is_never_silently_rewritten(s):
    """Someone typed 4 h on the completion dialog. A later side effect (a ticket
    closing, a part being approved) must not replace it with a derived value."""
    end = BASE + timedelta(minutes=20)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=20)
    wo.status = WorkOrderStatus.completed
    wo.completed_at = end
    wo.repair_hours = 4.0
    wo.total_minutes = 240
    await s.flush()

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    assert wo.repair_hours == 4.0
    assert wo.total_minutes == 240

    # The office completion itself owns the field and may still replace it.
    await wo_totals.recompute(s, wo, repair_hours=1.5)
    assert wo.repair_hours == 1.5


# ── plant isolation on an unauthenticated kiosk ─────────────────────

@with_session
async def test_kiosk_cannot_put_a_foreign_plant_technician_on_a_work_order(s):
    """The kiosk has no authentication and its technician picker is company-wide,
    so the bridge enforces the same membership rule as every office assignment
    path (require_technician_in_plant): a mechanic with no membership in the WO's
    plant is never credited on it."""
    plants = (await s.execute(select(Plant).limit(2))).scalars().all()
    if len(plants) < 2:
        return                                   # single-plant install: nothing to isolate
    end = BASE + timedelta(minutes=10)
    _, _, wo, mi = await _mk_repair(s, completed=end, duration_minutes=10)

    other = next(p for p in plants if p.id != wo.plant_id)
    foreign = await _mk_tech(s, plant=other)     # member of the OTHER plant only
    await _checkin(s, mi, foreign, at=BASE)

    await kiosk_wo_bridge.on_intervention_completed(s, mi)
    await s.flush()

    links = (await s.execute(select(WorkOrderTechnician).where(
        WorkOrderTechnician.work_order_id == wo.id))).scalars().all()
    assert links == [], "a foreign-plant technician was credited on the WO"
    assert wo.executor_id is None


# ── guard: a part can only be booked on its own machine's repair ─────────────

@with_session
async def test_part_cannot_be_booked_on_another_machines_intervention(s):
    from app.api.routes import machine_operator as mo

    machine_a, _, _, mi_a = await _mk_repair(s)
    machine_b, _, _, _ = await _mk_repair(s)

    same = await mo._intervention_of(machine_a, str(mi_a.id), s)
    assert same.id == mi_a.id

    with pytest.raises(HTTPException) as err:
        await mo._intervention_of(machine_b, str(mi_a.id), s)
    assert err.value.status_code == 400
    assert err.value.detail == "intervention_machine_mismatch"
