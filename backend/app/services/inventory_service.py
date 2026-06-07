from datetime import datetime, timezone
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.models import StockItem, InventoryMovement


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
        item = await self.db.get(StockItem, stock_item_id)
        if not item:
            raise ValueError("Stock item not found")
        before = item.quantity or 0.0
        item.quantity = max(0.0, before - quantity)
        movement = InventoryMovement(
            stock_item_id=stock_item_id,
            work_order_id=work_order_id,
            movement_type="deduction",
            quantity=quantity,
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
