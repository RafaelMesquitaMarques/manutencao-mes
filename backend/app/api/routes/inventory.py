from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime

from app.db.session import get_db
from app.models.models import StockItem, InventoryMovement, User
from app.core.security import get_current_user
from app.services.inventory_service import InventoryService

router = APIRouter()


class StockItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    plant_id: UUID
    code: Optional[str] = None
    name: str
    description: Optional[str] = None
    unit: Optional[str] = None
    quantity: float
    min_quantity: float
    location: Optional[str] = None
    unit_cost: Optional[float] = None
    supplier: Optional[str] = None
    created_at: datetime


class StockItemCreate(BaseModel):
    plant_id: UUID
    code: Optional[str] = None
    name: str
    description: Optional[str] = None
    unit: Optional[str] = None
    quantity: float = 0
    min_quantity: float = 0
    location: Optional[str] = None
    unit_cost: Optional[float] = None
    supplier: Optional[str] = None


class StockItemUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    unit: Optional[str] = None
    quantity: Optional[float] = None
    min_quantity: Optional[float] = None
    location: Optional[str] = None
    unit_cost: Optional[float] = None
    supplier: Optional[str] = None


class StockItemListResponse(BaseModel):
    total: int
    items: List[StockItemOut]


class StockAdjust(BaseModel):
    quantity: float
    notes: Optional[str] = None


class MovementOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    stock_item_id: UUID
    work_order_id: Optional[UUID] = None
    movement_type: str
    quantity: float
    quantity_before: float
    quantity_after: float
    unit_cost: Optional[float] = None
    notes: Optional[str] = None
    created_at: datetime


class MovementListResponse(BaseModel):
    total: int
    items: List[MovementOut]


@router.get("/", response_model=StockItemListResponse)
async def list_inventory(
    plant_id: Optional[UUID] = None,
    search: Optional[str] = None,
    low_stock: Optional[bool] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = select(StockItem)
    if plant_id:
        query = query.where(StockItem.plant_id == plant_id)
    if search:
        query = query.where(
            StockItem.name.ilike(f"%{search}%") | StockItem.code.ilike(f"%{search}%")
        )
    if low_stock:
        query = query.where(StockItem.quantity <= StockItem.min_quantity)

    total_r = await db.execute(select(func.count()).select_from(query.subquery()))
    total = total_r.scalar()

    query = query.offset(skip).limit(limit).order_by(StockItem.name)
    result = await db.execute(query)
    items = result.scalars().all()
    return StockItemListResponse(total=total, items=items)


@router.post("/", response_model=StockItemOut, status_code=201)
async def create_stock_item(
    data: StockItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = StockItem(**data.model_dump())
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item


@router.get("/{item_id}", response_model=StockItemOut)
async def get_stock_item(
    item_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = await db.get(StockItem, item_id)
    if not item:
        raise HTTPException(404, "Stock item not found")
    return item


@router.patch("/{item_id}", response_model=StockItemOut)
async def update_stock_item(
    item_id: UUID,
    data: StockItemUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = await db.get(StockItem, item_id)
    if not item:
        raise HTTPException(404, "Stock item not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(item, k, v)
    await db.commit()
    await db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=204)
async def delete_stock_item(
    item_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = await db.get(StockItem, item_id)
    if not item:
        raise HTTPException(404, "Stock item not found")
    await db.delete(item)
    await db.commit()


@router.post("/{item_id}/add", response_model=StockItemOut)
async def add_stock(
    item_id: UUID,
    data: StockAdjust,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    svc = InventoryService(db)
    try:
        await svc.add_stock(item_id, data.quantity, user_id=current_user.id, notes=data.notes)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await db.commit()
    item = await db.get(StockItem, item_id)
    return item


@router.post("/{item_id}/adjust", response_model=StockItemOut)
async def adjust_stock(
    item_id: UUID,
    data: StockAdjust,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    svc = InventoryService(db)
    try:
        await svc.adjust_stock(item_id, data.quantity, user_id=current_user.id, notes=data.notes)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await db.commit()
    item = await db.get(StockItem, item_id)
    return item


@router.get("/{item_id}/movements", response_model=MovementListResponse)
async def list_movements(
    item_id: UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = await db.get(StockItem, item_id)
    if not item:
        raise HTTPException(404, "Stock item not found")
    q = select(InventoryMovement).where(
        InventoryMovement.stock_item_id == item_id
    ).order_by(InventoryMovement.created_at.desc()).offset(skip).limit(limit)
    result = await db.execute(q)
    items = result.scalars().all()
    total_r = await db.execute(
        select(func.count(InventoryMovement.id)).where(InventoryMovement.stock_item_id == item_id)
    )
    return MovementListResponse(total=total_r.scalar(), items=items)
