"""Does approving a consumed part actually take it out of inventory?
=================================================================
The two part ledgers settle stock at DIFFERENT moments, and nothing pinned it:

  * kiosk (intervention_parts): declaring the part on the floor touches NOTHING;
    stock leaves only when a supervisor approves the work order (_consume_stock).
  * office (wo_parts): the part leaves stock the moment the line is added, so
    approval is a pure sign-off and must NOT deduct a second time.

These tests exercise the real endpoints and assert against stock_items.quantity
and the inventory_movements ledger.

They also pin the settlement rule that phantom stock came from: a line can only
take out what the count actually holds, the ledger records that APPLIED amount
(so quantity_before - quantity == quantity_after), and a reversal gives back
exactly what the line took -- never the line quantity.

Same isolation contract as test_kiosk_wo_bridge.py: one shared event loop, one
transaction per test, ALWAYS rolled back -- the database is never mutated. The
endpoints call db.commit(), so commit is redirected to flush for the duration.

Run (inside the backend container):
    pytest tests/test_wo_approval_stock.py -v
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from fastapi import HTTPException                                       # noqa: E402

from app.core.config import settings                                    # noqa: E402
from app.api.routes import machine_operator, wo_approval, work_orders   # noqa: E402
from app.schemas.wo_subresources import WOPartCreate                    # noqa: E402
from app.models.models import (                                         # noqa: E402
    Equipment, InterventionPart, InventoryMovement, Machine,
    MachineIntervention, MaintenanceTicket, Plant, StockItem, TicketStatus,
    User, UserRole, WOPart, WorkOrder, WorkOrderStatus, WorkOrderType,
)

_LOOP = asyncio.new_event_loop()
_ENGINE = {}
BASE = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    """``async def test(s)`` -> sync pytest test on the shared loop, rolled back.
    The endpoints under test commit; commit is flush here so the outer
    transaction still owns (and discards) every row."""
    def wrapper():
        async def runner():
            s = _maker()()
            real_commit = s.commit

            async def flush_only():
                await s.flush()

            s.commit = flush_only
            try:
                await fn(s)
            finally:
                s.commit = real_commit
                await s.rollback()
                await s.close()
        _LOOP.run_until_complete(runner())
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


# -- fixtures -----------------------------------------------------------------

async def _plant(s):
    p = (await s.execute(select(Plant).limit(1))).scalars().first()
    assert p is not None, "at least one plant must exist"
    return p


async def _mk_user(s):
    u = User(id=uuid.uuid4(), name="st-" + uuid.uuid4().hex[:6],
             email="st-" + uuid.uuid4().hex[:10] + "@test.local",
             password_hash="x", role=UserRole.supervisor, active=True)
    s.add(u)
    await s.flush()
    return u


async def _mk_stock(s, *, quantity=10.0, unit_cost=4.25):
    plant = await _plant(s)
    item = StockItem(id=uuid.uuid4(), plant_id=plant.id, code="ST-" + uuid.uuid4().hex[:8],
                     name="stock probe", description="stock probe", unit="un",
                     quantity=quantity, unit_cost=unit_cost)
    s.add(item)
    await s.flush()
    return item


async def _mk_repair(s, *, completed=BASE + timedelta(minutes=20)):
    """Equipment + machine + ticket + WO + completed intervention, as live."""
    plant = await _plant(s)
    eq = Equipment(id=uuid.uuid4(), plant_id=plant.id, code="ST-" + uuid.uuid4().hex[:6],
                   name="ST rig " + uuid.uuid4().hex[:4])
    s.add(eq)
    await s.flush()
    machine = Machine(id=uuid.uuid4(), name=eq.name, code=eq.code, equipment_id=eq.id,
                      plant_id=plant.id, is_active=True)
    s.add(machine)
    await s.flush()
    ticket = MaintenanceTicket(id=uuid.uuid4(), ticket_number="ST-TKT-" + uuid.uuid4().hex[:8],
                               machine_id=machine.id, plant_id=plant.id,
                               status=TicketStatus.in_progress, opened_at=BASE)
    s.add(ticket)
    await s.flush()
    wo = WorkOrder(id=uuid.uuid4(), wo_number="ST-" + uuid.uuid4().hex[:10],
                   equipment_id=eq.id, plant_id=plant.id, machine_id=machine.id,
                   type=WorkOrderType.corrective, status=WorkOrderStatus.completed,
                   title="stock probe", ticket_id=ticket.id, opened_at=BASE,
                   completed_at=completed)
    s.add(wo)
    await s.flush()
    ticket.work_order_id = wo.id
    mi = MachineIntervention(
        id=uuid.uuid4(), plant_id=plant.id, machine_id=machine.id, equipment_id=eq.id,
        ticket_id=ticket.id, status="completed", approval_status="pending",
        called_at=BASE, started_at=BASE, completed_at=completed,
        intervention_duration_minutes=20,
    )
    s.add(mi)
    await s.flush()
    return machine, wo, mi


async def _movements(s, item):
    return (await s.execute(
        select(InventoryMovement)
        .where(InventoryMovement.stock_item_id == item.id)
        .order_by(InventoryMovement.created_at, InventoryMovement.id)
    )).scalars().all()


async def _add_kiosk_part(s, machine, mi, item, qty):
    return await machine_operator.add_intervention_part(
        str(machine.id),
        machine_operator.AddPartBody(
            intervention_id=str(mi.id),
            stock_item_id=str(item.id) if item is not None else None,
            quantity_used=qty,
        ),
        db=s,
    )


# -- kiosk ledger: declaring is free, approval is what costs stock ------------

@with_session
async def test_declaring_a_part_at_the_kiosk_does_not_touch_stock(s):
    """The technician declaring a part is not a stock movement yet -- otherwise a
    line the supervisor later rejects would already be gone from inventory."""
    machine, _, mi = await _mk_repair(s)
    item = await _mk_stock(s, quantity=10.0)

    await _add_kiosk_part(s, machine, mi, item, 3)

    assert item.quantity == 10.0                     # untouched
    assert await _movements(s, item) == []            # and nothing in the ledger


@with_session
async def test_approval_deducts_the_part_from_inventory(s):
    """THE question: approving a consumed part takes it out of stock, with a
    tracked movement that says where it went."""
    machine, _, mi = await _mk_repair(s)
    item = await _mk_stock(s, quantity=10.0, unit_cost=4.25)
    await _add_kiosk_part(s, machine, mi, item, 3)
    user = await _mk_user(s)

    await wo_approval.approve_intervention(
        mi.id, wo_approval.ApproveBody(cost_center="Maintenance"),
        db=s, current_user=user,
    )

    assert item.quantity == 7.0                       # 10 - 3
    movs = await _movements(s, item)
    assert len(movs) == 1
    mov = movs[0]
    assert mov.movement_type == "deduction"
    assert (mov.quantity, mov.quantity_before, mov.quantity_after) == (3.0, 10.0, 7.0)
    assert mov.created_by_id == user.id               # who signed it off
    assert "approved" in (mov.notes or "")

    part = (await s.execute(
        select(InterventionPart).where(InterventionPart.intervention_id == mi.id)
    )).scalars().one()
    assert part.approval_status == "approved"
    assert part.unit_cost == 4.25 and part.total_cost == 12.75   # price snapshot


@with_session
async def test_approving_twice_does_not_deduct_twice(s):
    """Only PENDING lines consume: a second sign-off (double click, retry) must
    not walk the stock down again."""
    machine, _, mi = await _mk_repair(s)
    item = await _mk_stock(s, quantity=10.0)
    await _add_kiosk_part(s, machine, mi, item, 3)
    user = await _mk_user(s)
    body = wo_approval.ApproveBody(cost_center="Maintenance")

    await wo_approval.approve_intervention(mi.id, body, db=s, current_user=user)
    await wo_approval.approve_intervention(mi.id, body, db=s, current_user=user)

    assert item.quantity == 7.0
    assert len(await _movements(s, item)) == 1


@with_session
async def test_rejected_work_order_never_leaves_inventory(s):
    """Refusing the work refuses its parts -- stock stays where it is."""
    machine, _, mi = await _mk_repair(s)
    item = await _mk_stock(s, quantity=10.0)
    await _add_kiosk_part(s, machine, mi, item, 3)
    user = await _mk_user(s)

    await wo_approval.reject_intervention(
        mi.id, wo_approval.RejectBody(reason="not this part"), db=s, current_user=user)

    assert item.quantity == 10.0
    assert await _movements(s, item) == []


@with_session
async def test_rejecting_a_part_after_approval_puts_the_stock_back(s):
    """Undo has to reach inventory too, or the part stays deducted with nothing
    to show for it."""
    machine, _, mi = await _mk_repair(s)
    item = await _mk_stock(s, quantity=10.0)
    await _add_kiosk_part(s, machine, mi, item, 3)
    user = await _mk_user(s)
    await wo_approval.approve_intervention(
        mi.id, wo_approval.ApproveBody(cost_center="Maintenance"), db=s, current_user=user)
    part = (await s.execute(
        select(InterventionPart).where(InterventionPart.intervention_id == mi.id)
    )).scalars().one()

    await wo_approval.reject_intervention_part(
        mi.id, part.id, wo_approval.RejectBody(reason="wrong part"), db=s, current_user=user)

    assert item.quantity == 10.0
    # Both movements are stamped by the same transaction clock, so compare the
    # ledger as a set of facts rather than as an order.
    movs = await _movements(s, item)
    assert sorted(m.movement_type for m in movs) == ["addition", "deduction"]
    assert {m.quantity for m in movs} == {3.0}
    restock = next(m for m in movs if m.movement_type == "addition")
    assert "rejected after approval" in (restock.notes or "")


@with_session
async def test_free_text_part_has_nothing_to_deduct(s):
    """A part typed by hand (not in the catalog) is money and history, but it is
    linked to no stock item -- approval must not invent a movement."""
    machine, _, mi = await _mk_repair(s)
    await machine_operator.add_intervention_part(
        str(machine.id),
        machine_operator.AddPartBody(intervention_id=str(mi.id), item_code="OFF-CAT",
                                     item_description="bought at the hardware store",
                                     quantity_used=2),
        db=s,
    )
    user = await _mk_user(s)

    view = await wo_approval.approve_intervention(
        mi.id, wo_approval.ApproveBody(cost_center="Maintenance"), db=s, current_user=user)

    assert view["approval_status"] == "approved"
    assert view["parts"][0]["approval_status"] == "approved"


# -- office ledger: stock leaves on add, approval must not deduct again -------

@with_session
async def test_office_part_deducts_on_add_and_approval_does_not_repeat_it(s):
    """wo_parts settle immediately, so the sign-off is a pure sign-off: one
    deduction total, not two."""
    _, wo, mi = await _mk_repair(s)
    await s.delete(mi)                       # office-only WO (no kiosk twin)
    await s.flush()
    item = await _mk_stock(s, quantity=10.0)
    user = await _mk_user(s)

    await wo_approval.add_wo_part(
        wo.id, wo_approval.PartAddBody(stock_item_id=item.id, quantity=4),
        db=s, current_user=user)
    assert item.quantity == 6.0                      # deducted on add

    await wo_approval.approve_work_order(
        wo.id, wo_approval.ApproveBody(cost_center="Maintenance"),
        db=s, current_user=user)

    assert item.quantity == 6.0                      # approval added nothing
    assert len(await _movements(s, item)) == 1
    part = (await s.execute(select(WOPart).where(WOPart.work_order_id == wo.id))).scalars().one()
    assert part.quantity == 4


@with_session
async def test_office_part_edits_move_stock_both_ways(s):
    """Raising the quantity takes more out, removing the line puts it all back."""
    _, wo, mi = await _mk_repair(s)
    await s.delete(mi)
    await s.flush()
    item = await _mk_stock(s, quantity=10.0)
    user = await _mk_user(s)
    await wo_approval.add_wo_part(
        wo.id, wo_approval.PartAddBody(stock_item_id=item.id, quantity=4),
        db=s, current_user=user)
    part = (await s.execute(select(WOPart).where(WOPart.work_order_id == wo.id))).scalars().one()

    await wo_approval.update_wo_part(
        wo.id, part.id, wo_approval.PartUpdateBody(quantity=6), db=s, current_user=user)
    assert item.quantity == 4.0                      # 6 - 2 more

    await wo_approval.delete_wo_part(wo.id, part.id, db=s, current_user=user)
    assert item.quantity == 10.0                     # fully restocked


# -- settlement: a line can only take out what the count holds ---------------

@with_session
async def test_approving_more_than_the_count_holds_cannot_go_below_zero(s):
    """A line bigger than the count is a counting error, not free stock: the
    count floors at zero and the LEDGER says what really left, so
    quantity_before - quantity == quantity_after still holds."""
    machine, _, mi = await _mk_repair(s)
    item = await _mk_stock(s, quantity=2.0, unit_cost=1.0)
    await _add_kiosk_part(s, machine, mi, item, 5)
    user = await _mk_user(s)

    await wo_approval.approve_intervention(
        mi.id, wo_approval.ApproveBody(cost_center="Maintenance"), db=s, current_user=user)

    assert item.quantity == 0.0
    mov = (await _movements(s, item))[0]
    assert (mov.quantity, mov.quantity_before, mov.quantity_after) == (2.0, 2.0, 0.0)
    assert "5 requested, only 2 on hand" in (mov.notes or "")   # shortfall is on record
    part = (await s.execute(
        select(InterventionPart).where(InterventionPart.intervention_id == mi.id)
    )).scalars().one()
    assert part.stock_deducted == 2.0          # what inventory actually gave
    assert part.total_cost == 5.0              # the money is still the 5 used


@with_session
async def test_rejecting_that_line_gives_back_two_not_five(s):
    """The phantom-stock case: 2 in stock, a line of 5 approved then rejected.
    Crediting the line quantity would leave 5 units where there were 2."""
    machine, _, mi = await _mk_repair(s)
    item = await _mk_stock(s, quantity=2.0)
    await _add_kiosk_part(s, machine, mi, item, 5)
    user = await _mk_user(s)
    await wo_approval.approve_intervention(
        mi.id, wo_approval.ApproveBody(cost_center="Maintenance"), db=s, current_user=user)
    part = (await s.execute(
        select(InterventionPart).where(InterventionPart.intervention_id == mi.id)
    )).scalars().one()

    await wo_approval.reject_intervention_part(
        mi.id, part.id, wo_approval.RejectBody(reason="wrong part"), db=s, current_user=user)

    assert item.quantity == 2.0                # exactly where it started
    assert part.stock_deducted == 0.0          # nothing left to give back
    restock = next(m for m in await _movements(s, item) if m.movement_type == "addition")
    assert restock.quantity == 2.0


@with_session
async def test_deducting_from_a_negative_count_does_not_pull_it_up(s):
    """max(0, before - qty) used to RAISE a negative count to zero -- units from
    nowhere. Nothing is available, so nothing moves."""
    machine, _, mi = await _mk_repair(s)
    item = await _mk_stock(s, quantity=-3.0)
    await _add_kiosk_part(s, machine, mi, item, 2)
    user = await _mk_user(s)

    await wo_approval.approve_intervention(
        mi.id, wo_approval.ApproveBody(cost_center="Maintenance"), db=s, current_user=user)

    assert item.quantity == -3.0
    mov = (await _movements(s, item))[0]
    assert (mov.quantity, mov.quantity_before, mov.quantity_after) == (0.0, -3.0, -3.0)


@with_session
async def test_office_line_never_gives_back_more_than_it_took(s):
    """Same rule on the office ledger, through both reversals: lowering the
    quantity and removing the line."""
    _, wo, mi = await _mk_repair(s)
    await s.delete(mi)
    await s.flush()
    item = await _mk_stock(s, quantity=3.0)
    user = await _mk_user(s)
    await wo_approval.add_wo_part(
        wo.id, wo_approval.PartAddBody(stock_item_id=item.id, quantity=10),
        db=s, current_user=user)
    part = (await s.execute(select(WOPart).where(WOPart.work_order_id == wo.id))).scalars().one()
    assert item.quantity == 0.0 and part.stock_deducted == 3.0

    await wo_approval.update_wo_part(
        wo.id, part.id, wo_approval.PartUpdateBody(quantity=8), db=s, current_user=user)
    assert item.quantity == 2.0                # gave back 2 of the 3 it took
    assert part.stock_deducted == 1.0

    await wo_approval.delete_wo_part(wo.id, part.id, db=s, current_user=user)
    assert item.quantity == 3.0                # never more than the 3 it started with


@with_session
async def test_a_line_that_settled_nothing_gives_nothing_back(s):
    """An approved line carrying no settlement (a row from before stock_deducted
    existed and outside the backfill) must not invent a credit."""
    machine, _, mi = await _mk_repair(s)
    item = await _mk_stock(s, quantity=10.0)
    await _add_kiosk_part(s, machine, mi, item, 3)
    user = await _mk_user(s)
    await wo_approval.approve_intervention(
        mi.id, wo_approval.ApproveBody(cost_center="Maintenance"), db=s, current_user=user)
    part = (await s.execute(
        select(InterventionPart).where(InterventionPart.intervention_id == mi.id)
    )).scalars().one()
    part.stock_deducted = None                 # legacy row
    await s.flush()

    await wo_approval.reject_intervention_part(
        mi.id, part.id, wo_approval.RejectBody(reason="legacy"), db=s, current_user=user)

    assert item.quantity == 7.0                # untouched by the reversal
    assert [m.movement_type for m in await _movements(s, item)] == ["deduction"]


# -- the work-order route no longer swallows a failed deduction --------------

@with_session
async def test_wo_route_refuses_a_part_pointing_at_no_stock_item(s):
    """It used to create the part anyway (except Exception: pass) -- a line on the
    work order with the stock never deducted and nothing in the log."""
    _, wo, _ = await _mk_repair(s)
    user = await _mk_user(s)
    ghost = uuid.uuid4()

    with pytest.raises(HTTPException) as err:
        await work_orders.add_part(
            wo.id, WOPartCreate(stock_item_id=ghost, description="ghost", quantity=1),
            db=s, current_user=user)

    assert err.value.status_code == 404
    assert err.value.detail == "stock_item_not_found"      # stable code for the UI
    assert (await s.execute(
        select(WOPart).where(WOPart.work_order_id == wo.id)
    )).scalars().all() == []


@with_session
async def test_wo_route_deducts_and_records_what_it_took(s):
    """The happy path still settles stock, now with the amount on the line."""
    _, wo, _ = await _mk_repair(s)
    item = await _mk_stock(s, quantity=10.0, unit_cost=2.0)
    user = await _mk_user(s)

    part = await work_orders.add_part(
        wo.id, WOPartCreate(stock_item_id=item.id, description="belt", quantity=4),
        db=s, current_user=user)

    assert item.quantity == 6.0
    assert part.stock_deducted == 4.0
    assert len(await _movements(s, item)) == 1


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
