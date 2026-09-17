"""What is allowed to move the weighted-average PURCHASE cost of a part?
======================================================================
``stock_items.average_cost`` answers one question: what have we actually paid,
on average, for a unit of this part. It is price source #2 in
``part_pricing.unit_cost_of`` (unit_cost -> average_cost -> last_purchase_cost),
so whatever lands in it re-prices every future part consumption.

Receiving a purchase order recomputes it. The recompute used to read every
movement of type 'addition' -- but an entry is not automatically a purchase.
Units also come BACK from a part line that did not keep them (rejected after
approval, removed from the work order, quantity lowered), and those carry
``item.unit_cost`` -- a catalog price, not money paid for these units. They
entered the average as if bought.

So the ledger now says WHY the count moved, and the recompute counts
``source='purchase'`` and nothing else. These tests pin that:

  * a receipt is marked as a purchase, a reversal is marked as a reversal and
    is not even an 'addition' any more;
  * the average is the weighted price actually paid;
  * a reversal cannot move it, whatever the catalog says the part is worth;
  * an entry of unknown provenance stays OUT -- a whitelist, so the failure
    direction is "not counted" rather than "silently poisoned".

The one-time classification of pre-existing rows lives in main.py
(_run_migrations) and is verified against the real database, not here.

Same isolation contract as test_wo_approval_stock.py: one shared event loop, one
transaction per test, ALWAYS rolled back -- the database is never mutated. The
endpoints call db.commit(), so commit is redirected to flush for the duration.

Run (inside the backend container):
    pytest tests/test_purchase_average_cost.py -v
"""
import os
import sys
import uuid
from datetime import date

import pytest
from sqlalchemy import select

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.plant_context import resolve_plant_context                # noqa: E402
from app.api.routes import suppliers                                    # noqa: E402
from app.services.inventory_service import InventoryService             # noqa: E402
from app.models.models import (                                         # noqa: E402
    InventoryMovement, Plant, PurchaseOrder, PurchaseOrderItem,
    PurchaseOrderStatus, StockItem, Supplier, User, UserPlant, UserRole,
)
from db_harness import with_session_commit_as_flush as with_session    # noqa: E402


# -- fixtures -----------------------------------------------------------------

async def _plant(s):
    p = (await s.execute(select(Plant).limit(1))).scalars().first()
    assert p is not None, "at least one plant must exist"
    return p


async def _ctx(s, plant):
    """A plant manager on `plant`, plus the PlantContext the routes expect."""
    u = User(id=uuid.uuid4(), name="pa-" + uuid.uuid4().hex[:6],
             email="pa-" + uuid.uuid4().hex[:10] + "@test.local",
             password_hash="x", role=UserRole.plant_manager, active=True)
    s.add(u)
    await s.flush()
    s.add(UserPlant(user_id=u.id, plant_id=plant.id,
                    role=UserRole.plant_manager, is_default=True))
    await s.flush()
    return u, await resolve_plant_context(s, u, None)


async def _mk_stock(s, plant, *, quantity=0.0, unit_cost=None):
    """A catalog item. `unit_cost` is the CATALOG price -- the number a reversal
    would carry into the average if reversals counted as purchases."""
    item = StockItem(id=uuid.uuid4(), plant_id=plant.id, code="PA-" + uuid.uuid4().hex[:8],
                     name="avg probe", description="avg probe", unit="un",
                     quantity=quantity, unit_cost=unit_cost)
    s.add(item)
    await s.flush()
    return item


async def _receive(s, ctx, user, plant, lines):
    """Create a purchase order for `lines` [(stock_item, qty, unit_cost)] and
    receive it in full through the real endpoint."""
    sup = Supplier(id=uuid.uuid4(), plant_id=plant.id, name="avg probe supplier")
    s.add(sup)
    await s.flush()
    po = PurchaseOrder(id=uuid.uuid4(), order_number="PA-" + uuid.uuid4().hex[:10],
                       supplier_id=sup.id, plant_id=plant.id,
                       status=PurchaseOrderStatus.confirmed, order_date=date.today())
    s.add(po)
    await s.flush()
    items = []
    for item, qty, cost in lines:
        poi = PurchaseOrderItem(id=uuid.uuid4(), order_id=po.id, stock_item_id=item.id,
                                description=item.name, quantity=qty, unit_cost=cost,
                                total_cost=qty * cost, received_quantity=0)
        s.add(poi)
        items.append(poi)
    await s.flush()
    await suppliers.receive_purchase_order(
        po.id,
        {"items": [{"id": str(p.id), "received_quantity": p.quantity} for p in items]},
        db=s, ctx=ctx, current_user=user,
    )
    return po


async def _movements(s, item):
    return (await s.execute(
        select(InventoryMovement)
        .where(InventoryMovement.stock_item_id == item.id)
        .order_by(InventoryMovement.created_at, InventoryMovement.id)
    )).scalars().all()


# -- the ledger says WHY the count moved --------------------------------------

@with_session
async def test_a_receipt_is_marked_as_a_purchase(s):
    """Receiving is the one place units are actually bought, and the only writer
    allowed to claim it."""
    plant = await _plant(s)
    user, ctx = await _ctx(s, plant)
    item = await _mk_stock(s, plant, quantity=0.0)

    await _receive(s, ctx, user, plant, [(item, 10, 4.0)])

    mov = (await _movements(s, item))[0]
    assert mov.movement_type == "addition"
    assert mov.source == "purchase"
    assert (mov.quantity, mov.unit_cost) == (10.0, 4.0)


@with_session
async def test_a_reversal_is_not_an_addition(s):
    """Units coming back from a part line are a 'return', so no consumer can
    mistake them for stock that arrived from outside."""
    plant = await _plant(s)
    item = await _mk_stock(s, plant, quantity=1.0, unit_cost=99.0)

    await InventoryService(s).return_stock(item.id, 3.0, notes="rejected after approval")
    await s.flush()

    mov = (await _movements(s, item))[0]
    assert mov.movement_type == "return"
    assert mov.source == "reversal"
    assert item.quantity == 4.0          # it still raises the count


# -- what the average is, and what may move it --------------------------------

@with_session
async def test_the_average_is_the_weighted_price_actually_paid(s):
    """Two receipts at different prices: 10 @ 4.00 then 30 @ 6.00 is 5.50, not
    the midpoint 5.00 -- the bigger lot pulls harder."""
    plant = await _plant(s)
    user, ctx = await _ctx(s, plant)
    item = await _mk_stock(s, plant, quantity=0.0)

    await _receive(s, ctx, user, plant, [(item, 10, 4.0)])
    assert item.average_cost == 4.0

    await _receive(s, ctx, user, plant, [(item, 30, 6.0)])

    assert item.average_cost == 5.5      # (10*4 + 30*6) / 40
    assert item.last_purchase_cost == 6.0


@with_session
async def test_a_reversal_does_not_move_the_purchase_average(s):
    """THE defect. A part with a catalog price of 99.00 is consumed and given
    back; the reversal carries that 99.00. Counting it as a purchase would drag
    the average far above the 4.00 actually paid -- and average_cost is what
    prices the NEXT consumption."""
    plant = await _plant(s)
    user, ctx = await _ctx(s, plant)
    item = await _mk_stock(s, plant, quantity=0.0, unit_cost=99.0)

    await InventoryService(s).return_stock(item.id, 20.0, notes="rejected after approval")
    await s.flush()

    await _receive(s, ctx, user, plant, [(item, 10, 4.0)])

    assert item.average_cost == 4.0      # was 67.33 with the reversal counted
    types = sorted(m.movement_type for m in await _movements(s, item))
    assert types == ["addition", "return"]   # the reversal IS on the ledger


@with_session
async def test_a_reversal_between_two_receipts_changes_nothing(s):
    """The average of the two receipts is identical whether or not a reversal
    happened in between: giving units back is not buying them."""
    plant = await _plant(s)
    user, ctx = await _ctx(s, plant)
    item = await _mk_stock(s, plant, quantity=0.0, unit_cost=99.0)

    await _receive(s, ctx, user, plant, [(item, 10, 4.0)])
    await InventoryService(s).return_stock(item.id, 500.0, notes="removed from WO")
    await s.flush()
    await _receive(s, ctx, user, plant, [(item, 30, 6.0)])

    assert item.average_cost == 5.5      # exactly as with no reversal at all


@with_session
async def test_an_entry_of_unknown_provenance_stays_out_of_the_average(s):
    """The whitelist, and the regression guard for the filter itself.

    An 'addition' carrying no source is EXACTLY the shape every reversal had
    before this change, so this is the defect in its original form: flip the
    recompute back to movement_type == 'addition' and the average here goes from
    4.00 to 83.17. It also covers a future writer that forgets to declare
    itself -- left out rather than silently re-pricing the part."""
    plant = await _plant(s)
    user, ctx = await _ctx(s, plant)
    item = await _mk_stock(s, plant, quantity=0.0)
    s.add(InventoryMovement(
        stock_item_id=item.id, movement_type="addition", source=None,
        quantity=50.0, quantity_before=0.0, quantity_after=50.0, unit_cost=99.0,
        notes="legacy row, provenance unknown",
    ))
    await s.flush()

    await _receive(s, ctx, user, plant, [(item, 10, 4.0)])

    assert item.average_cost == 4.0


@with_session
async def test_a_free_receipt_is_a_real_price_not_a_missing_one(s):
    """Boundary worth pinning: 0.00 on a receipt (warranty, sample) is money
    paid -- nothing -- so it weighs on the average like any other price. Only a
    NULL cost means "unknown" and is skipped."""
    plant = await _plant(s)
    user, ctx = await _ctx(s, plant)
    item = await _mk_stock(s, plant, quantity=0.0)

    await _receive(s, ctx, user, plant, [(item, 10, 4.0)])
    assert item.average_cost == 4.0

    await _receive(s, ctx, user, plant, [(item, 10, 0.0)])

    assert item.average_cost == 2.0      # 0.00 is a real price: 40/20, not None


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
