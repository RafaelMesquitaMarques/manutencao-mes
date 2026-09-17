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

    async def add_stock(
        self,
        stock_item_id: UUID,
        quantity: float,
        user_id: UUID | None = None,
        notes: str | None = None,
    ) -> InventoryMovement:
        item = await self.db.get(StockItem, stock_item_id)
        if not item:
            raise ValueError("Stock item not found")
        before = item.quantity or 0.0
        item.quantity = before + quantity
        movement = InventoryMovement(
            stock_item_id=stock_item_id,
            movement_type="addition",
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
