"""
backend/app/api/routes/inventory.py
Full inventory module — stock items + suppliers
"""
from __future__ import annotations

import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_, and_

from app.db.session import get_db
from app.core.security import get_current_user
from app.models.models import StockItem, Supplier, User

router = APIRouter()


# ─── SUPPLIERS ────────────────────────────────────────────────────────────────

@router.get("/suppliers")
async def list_suppliers(
    search: Optional[str] = None,
    active_only: bool = True,
    skip: int = 0,
    limit: int = 200,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(Supplier)
    if active_only:
        q = q.where(Supplier.is_active == True)
    if search:
        q = q.where(
            or_(
                Supplier.name.ilike(f"%{search}%"),
                Supplier.code.ilike(f"%{search}%"),
            )
        )
    total_q = select(func.count()).select_from(q.subquery())
    total = (await db.execute(total_q)).scalar_one()
    items = (await db.execute(q.offset(skip).limit(limit).order_by(Supplier.name))).scalars().all()
    return {"total": total, "items": [_supplier_out(s) for s in items]}


@router.get("/suppliers/{supplier_id}")
async def get_supplier(
    supplier_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    s = await db.get(Supplier, supplier_id)
    if not s:
        raise HTTPException(404, "Supplier not found")
    return _supplier_out(s)


@router.post("/suppliers", status_code=201)
async def create_supplier(
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    s = Supplier(
        id=uuid.uuid4(),
        code=body.get("code", ""),
        name=body["name"],
        phone=body.get("phone"),
        email=body.get("email"),
        fax=body.get("fax"),
        website=body.get("website"),
        currency=body.get("currency", "CAD"),
        notes=body.get("notes"),
        is_active=body.get("is_active", True),
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return _supplier_out(s)


@router.patch("/suppliers/{supplier_id}")
async def update_supplier(
    supplier_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    s = await db.get(Supplier, supplier_id)
    if not s:
        raise HTTPException(404, "Supplier not found")
    for field in ["name", "code", "phone", "email", "fax", "website", "currency", "notes", "is_active"]:
        if field in body:
            setattr(s, field, body[field])
    await db.commit()
    await db.refresh(s)
    return _supplier_out(s)


def _supplier_out(s: Supplier) -> dict:
    return {
        "id": str(s.id),
        "code": s.code,
        "name": s.name,
        "phone": s.phone,
        "email": s.email,
        "fax": s.fax,
        "website": s.website,
        "currency": s.currency,
        "notes": s.notes,
        "is_active": s.is_active,
    }


# ─── STOCK ITEMS ──────────────────────────────────────────────────────────────

@router.get("/items")
async def list_stock_items(
    search: Optional[str] = None,
    category: Optional[str] = None,
    part_class: Optional[str] = None,
    warehouse: Optional[str] = None,
    low_stock_only: bool = False,
    skip: int = 0,
    limit: int = Query(default=50, le=6000),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(StockItem)

    filters = []
    if search:
        filters.append(
            or_(
                StockItem.code.ilike(f"%{search}%"),
                StockItem.description.ilike(f"%{search}%"),
                StockItem.name.ilike(f"%{search}%"),
            )
        )
    if category:
        filters.append(StockItem.category.ilike(f"%{category}%"))
    if part_class:
        filters.append(StockItem.part_class.ilike(f"%{part_class}%"))
    if warehouse:
        filters.append(StockItem.warehouse.ilike(f"%{warehouse}%"))
    if low_stock_only:
        filters.append(
            or_(
                StockItem.quantity <= 0,
                and_(
                    StockItem.min_quantity.isnot(None),
                    StockItem.quantity <= StockItem.min_quantity,
                ),
            )
        )
    if filters:
        q = q.where(and_(*filters))

    total_q = select(func.count()).select_from(q.subquery())
    total = (await db.execute(total_q)).scalar_one()

    # Low stock count: quantity <= 0 OR (min set AND quantity <= min)
    low_q = select(func.count()).select_from(
        select(StockItem).where(
            or_(
                StockItem.quantity <= 0,
                and_(
                    StockItem.min_quantity.isnot(None),
                    StockItem.quantity <= StockItem.min_quantity,
                ),
            )
        ).subquery()
    )
    low_count = (await db.execute(low_q)).scalar_one()

    items = (
        await db.execute(
            q.offset(skip).limit(limit).order_by(StockItem.code)
        )
    ).scalars().all()

    return {
        "total": total,
        "low_stock_count": low_count,
        "items": [_item_out(i) for i in items],
    }


@router.get("/items/categories")
async def list_categories(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return distinct categories and part classes for filter dropdowns."""
    cats_q = select(StockItem.category).where(StockItem.category.isnot(None)).distinct()
    cls_q = select(StockItem.part_class).where(StockItem.part_class.isnot(None)).distinct()
    wh_q = select(StockItem.warehouse).where(StockItem.warehouse.isnot(None)).distinct()

    cats = [r[0] for r in (await db.execute(cats_q)).all() if r[0]]
    classes = [r[0] for r in (await db.execute(cls_q)).all() if r[0]]
    warehouses = [r[0] for r in (await db.execute(wh_q)).all() if r[0]]

    return {
        "categories": sorted(set(cats)),
        "part_classes": sorted(set(classes)),
        "warehouses": sorted(set(warehouses)),
    }


@router.get("/items/{item_id}")
async def get_stock_item(
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = await db.get(StockItem, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    return _item_out(item)


@router.post("/items", status_code=201)
async def create_stock_item(
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = StockItem(
        id=uuid.uuid4(),
        plant_id=body.get("plant_id"),
        code=body["code"],
        name=body.get("name", ""),
        description=body.get("description", ""),
        category=body.get("category"),
        part_class=body.get("part_class"),
        unit=body.get("unit", "Unitaire"),
        quantity=float(body.get("quantity", 0)),
        min_quantity=float(body["min_quantity"]) if body.get("min_quantity") is not None else None,
        unit_cost=float(body["unit_cost"]) if body.get("unit_cost") is not None else None,
        warehouse=body.get("warehouse"),
        location=body.get("location"),
        supplier_id=uuid.UUID(body["supplier_id"]) if body.get("supplier_id") else None,
        interal_product_id=body.get("interal_product_id"),
        notes=body.get("notes"),
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return _item_out(item)


@router.patch("/items/{item_id}")
async def update_stock_item(
    item_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = await db.get(StockItem, item_id)
    if not item:
        raise HTTPException(404, "Item not found")

    updatable = [
        "name", "description", "category", "part_class", "unit",
        "quantity", "min_quantity", "unit_cost", "warehouse", "location",
        "notes", "interal_product_id",
    ]
    for field in updatable:
        if field in body:
            setattr(item, field, body[field])

    if "supplier_id" in body:
        item.supplier_id = uuid.UUID(body["supplier_id"]) if body["supplier_id"] else None

    await db.commit()
    await db.refresh(item)
    return _item_out(item)


@router.patch("/items/{item_id}/quantity")
async def adjust_quantity(
    item_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Quick quantity adjustment: body = { delta: float } or { quantity: float }"""
    item = await db.get(StockItem, item_id)
    if not item:
        raise HTTPException(404, "Item not found")

    if "quantity" in body:
        item.quantity = float(body["quantity"])
    elif "delta" in body:
        item.quantity = (item.quantity or 0) + float(body["delta"])
    else:
        raise HTTPException(400, "Provide 'quantity' or 'delta'")

    await db.commit()
    await db.refresh(item)
    return _item_out(item)


@router.delete("/items/{item_id}", status_code=204)
async def delete_stock_item(
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = await db.get(StockItem, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    await db.delete(item)
    await db.commit()


@router.get("/dashboard")
async def inventory_dashboard(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    total_items = (await db.execute(select(func.count()).select_from(StockItem))).scalar_one()

    low_stock = (await db.execute(
        select(func.count()).select_from(
            select(StockItem).where(
                or_(
                    StockItem.quantity <= 0,
                    and_(StockItem.min_quantity.isnot(None), StockItem.quantity <= StockItem.min_quantity),
                )
            ).subquery()
        )
    )).scalar_one()

    zero_stock = (await db.execute(
        select(func.count()).select_from(
            select(StockItem).where(StockItem.quantity <= 0).subquery()
        )
    )).scalar_one()

    # Category breakdown
    cat_q = (
        select(StockItem.category, func.count().label("cnt"))
        .where(StockItem.category.isnot(None))
        .group_by(StockItem.category)
        .order_by(func.count().desc())
        .limit(10)
    )
    by_category = [{"category": r[0], "count": r[1]} for r in (await db.execute(cat_q)).all()]

    return {
        "total_items": total_items,
        "low_stock_count": low_stock,
        "zero_stock_count": zero_stock,
        "by_category": by_category,
    }


def _item_out(i: StockItem) -> dict:
    qty = float(i.quantity) if i.quantity is not None else 0.0
    is_low = qty <= 0 or (
        i.min_quantity is not None and qty <= float(i.min_quantity)
    )
    return {
        "id": str(i.id),
        "plant_id": str(i.plant_id) if i.plant_id else None,
        "code": i.code,
        "name": i.name or "",
        "description": i.description or "",
        "category": i.category or "",
        "part_class": i.part_class or "",
        "unit": i.unit or "Unitaire",
        "quantity": qty,
        "min_quantity": float(i.min_quantity) if i.min_quantity is not None else None,
        "unit_cost": float(i.unit_cost) if i.unit_cost is not None else None,
        "warehouse": i.warehouse or "",
        "location": i.location or "",
        "supplier_id": str(i.supplier_id) if i.supplier_id else None,
        "interal_product_id": i.interal_product_id,
        "notes": i.notes or "",
        "is_low_stock": is_low,
    }
