from datetime import datetime, timezone
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.models import StockItem, InventoryMovement


def _fmt(quantity: float) -> str:
    """Quantity for a human-readable ledger note: 3 not 3.0, 2.5 kept as 2.5."""
    value = float(quantity)
    return str(int(value)) if value == int(value) else str(round(value, 3))


class InventoryService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def deduct_stock(
        self,
        stock_item_id: UUID,
        quantity: float,
        work_order_id: UUID | None = None,
        user_id: UUID | None = None,
        notes: str | None = None,
    ) -> InventoryMovement:
        """Take ``quantity`` out of a stock item and record the movement.

        The ledger records what was APPLIED, not what was asked for, so
        ``quantity_before - quantity == quantity_after`` always holds. A line
        bigger than the count on hand is a counting error, not free stock: a
        deduction never drives the count below zero (nor drags an
        already-negative one up), and the shortfall is written into the note
        instead of vanishing. Callers read
        ``movement.quantity`` to learn what actually left — putting back more
        than that would invent stock.
        """
        item = await self.db.get(StockItem, stock_item_id)
        if not item:
            raise ValueError("Stock item not found")
        before = item.quantity or 0.0
        # max(before, 0) so deducting from an already-negative count cannot pull
        # it UP to zero (it used to: max(0, -3 - 2) = 0, three units from nowhere).
        applied = min(float(quantity), max(before, 0.0))
        item.quantity = before - applied
        short = float(quantity) - applied
        if short > 0:
            notes = " ".join(filter(None, [
                notes, f"[{_fmt(quantity)} requested, only {_fmt(applied)} on hand]",
            ]))
        movement = InventoryMovement(
            stock_item_id=stock_item_id,
            work_order_id=work_order_id,
            movement_type="deduction",
            quantity=applied,
            quantity_before=before,
            quantity_after=item.quantity,
            unit_cost=item.unit_cost,
            notes=notes,
            created_by_id=user_id,
        )
        self.db.add(movement)
        return movement

    async def return_stock(
        self,
        stock_item_id: UUID,
        quantity: float,
        user_id: UUID | None = None,
        notes: str | None = None,
    ) -> InventoryMovement:
        """Put back units a consumption line took out (rejected, removed, lowered).

        Physically an entry, but NEVER a purchase: these units were already
        bought once and are only coming back from a line that did not keep
        them. Booking them as a purchase would feed ``item.unit_cost`` into the
        weighted-average purchase cost as if it had been paid again — which is
        why this is a ``return`` with ``source='reversal'`` and not an
        ``addition``. See ``add_stock`` for a real entry.
        """
        return await self._entry(
            stock_item_id, quantity, movement_type="return", source="reversal",
            user_id=user_id, notes=notes,
        )

    async def add_stock(
        self,
        stock_item_id: UUID,
        quantity: float,
        user_id: UUID | None = None,
        notes: str | None = None,
        source: str | None = None,
    ) -> InventoryMovement:
        """Raise the count by units arriving from outside a consumption line.

        Pass ``source='purchase'`` when these units were actually bought at
        ``item.unit_cost`` — that is the ONLY marking the weighted-average
        purchase cost counts. Leaving it unset keeps the movement out of the
        average, which is the safe default: an entry of unknown provenance
        must not re-price future consumption.
        """
        return await self._entry(
            stock_item_id, quantity, movement_type="addition", source=source,
            user_id=user_id, notes=notes,
        )

    async def _entry(
        self,
        stock_item_id: UUID,
        quantity: float,
        *,
        movement_type: str,
        source: str | None,
        user_id: UUID | None,
        notes: str | None,
    ) -> InventoryMovement:
        """Shared body of every movement that RAISES the count."""
        item = await self.db.get(StockItem, stock_item_id)
        if not item:
            raise ValueError("Stock item not found")
        before = item.quantity or 0.0
        item.quantity = before + quantity
        movement = InventoryMovement(
            stock_item_id=stock_item_id,
            movement_type=movement_type,
            source=source,
            quantity=quantity,
            quantity_before=before,
            quantity_after=item.quantity,
            unit_cost=item.unit_cost,
            notes=notes,
            created_by_id=user_id,
        )
        self.db.add(movement)
        return movement

    async def adjust_stock(
        self,
        stock_item_id: UUID,
        new_quantity: float,
        user_id: UUID | None = None,
        notes: str | None = None,
    ) -> InventoryMovement:
        item = await self.db.get(StockItem, stock_item_id)
        if not item:
            raise ValueError("Stock item not found")
        before = item.quantity or 0.0
        delta = new_quantity - before
        item.quantity = new_quantity
        movement = InventoryMovement(
            stock_item_id=stock_item_id,
            movement_type="adjustment",
            quantity=delta,
            quantity_before=before,
            quantity_after=new_quantity,
            unit_cost=item.unit_cost,
            notes=notes,
            created_by_id=user_id,
        )
        self.db.add(movement)
        return movement
