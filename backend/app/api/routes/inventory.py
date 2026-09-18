"""
backend/app/api/routes/inventory.py
Full inventory module — stock items + suppliers
"""
from __future__ import annotations

import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_, and_, case

from app.db.session import get_db
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_condition, plant_scoped
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
    ctx: PlantContext = Depends(get_plant_context),
):
    q = plant_scoped(select(Supplier), Supplier, ctx)   # group-scoped: QC pool
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
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    s = ensure_same_plant(await db.get(Supplier, supplier_id), ctx, grouped=True, detail="Supplier not found")
    return _supplier_out(s)


@router.post("/suppliers", status_code=201)
async def create_supplier(
    body: dict,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    s = Supplier(
        id=uuid.uuid4(),
        plant_id=ctx.plant_id,   # owned by the creator's plant (visible across its group)
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
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    s = ensure_same_plant(await db.get(Supplier, supplier_id), ctx, grouped=True, detail="Supplier not found")
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

# ─── Stock-level predicates ───────────────────────────────────────────────────
#
# "Out of stock" and "below minimum" are two different questions, and with no
# minimum set anywhere they used to be answered by the same number — both KPI
# cards read 1 416 because the low-stock rule is the UNION of the two. Kept as
# three separate predicates so each card counts what its label says.

OUT_OF_STOCK = StockItem.quantity <= 0
BELOW_MIN = and_(
    StockItem.min_quantity.isnot(None),
    StockItem.quantity > 0,
    StockItem.quantity <= StockItem.min_quantity,
)
# What flags a row for reordering, and what `low_stock_only` has always meant.
NEEDS_REORDER = or_(OUT_OF_STOCK, BELOW_MIN)


async def _count(db, ctx, *conditions) -> int:
    """Count stock items in the caller's plant group matching `conditions`."""
    return (await db.execute(
        select(func.count()).select_from(
            select(StockItem).where(plant_condition(StockItem, ctx), *conditions).subquery()
        )
    )).scalar_one()


@router.get("/items")
async def list_stock_items(
    search: Optional[str] = None,
    category: Optional[str] = None,
    part_class: Optional[str] = None,
    warehouse: Optional[str] = None,
    supplier_id: Optional[uuid.UUID] = None,
    low_stock_only: bool = False,
    out_of_stock_only: bool = False,
    below_min_only: bool = False,
    stockable: Optional[bool] = None,
    # Products Interal has retired are kept (an old part number still resolves)
    # but stay out of the catalogue unless asked for.
    include_archived: bool = False,
    archived_only: bool = False,
    skip: int = 0,
    limit: int = Query(default=50, le=12000),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    q = plant_scoped(select(StockItem), StockItem, ctx)   # group-scoped: QC pool

    filters = []
    if archived_only:
        filters.append(StockItem.archived.is_(True))
    elif not include_archived:
        filters.append(StockItem.archived.is_(False))
    if search:
        filters.append(
            or_(
                StockItem.code.ilike(f"%{search}%"),
                StockItem.description.ilike(f"%{search}%"),
                StockItem.name.ilike(f"%{search}%"),
                StockItem.inventory_code.ilike(f"%{search}%"),
                StockItem.supplier.ilike(f"%{search}%"),
            )
        )
    if category:
        filters.append(StockItem.category.ilike(f"%{category}%"))
    if part_class:
        filters.append(StockItem.part_class.ilike(f"%{part_class}%"))
    if warehouse:
        filters.append(StockItem.warehouse.ilike(f"%{warehouse}%"))
    if stockable is not None:
        filters.append(StockItem.stockable.is_(stockable))
    if low_stock_only:
        filters.append(NEEDS_REORDER)
    if out_of_stock_only:
        filters.append(OUT_OF_STOCK)
    if below_min_only:
        filters.append(BELOW_MIN)
    if supplier_id:
        filters.append(StockItem.supplier_id == supplier_id)
    if filters:
        q = q.where(and_(*filters))

    total_q = select(func.count()).select_from(q.subquery())
    total = (await db.execute(total_q)).scalar_one()

    # The KPI counts describe the same population the list shows, so they follow
    # the archived toggle — otherwise "out of stock" would count 3 729 retired
    # products the table never displays.
    scope = [] if include_archived or archived_only else [StockItem.archived.is_(False)]
    if archived_only:
        scope = [StockItem.archived.is_(True)]
    low_count = await _count(db, ctx, NEEDS_REORDER, *scope)
    zero_count = await _count(db, ctx, OUT_OF_STOCK, *scope)
    below_min_count = await _count(db, ctx, BELOW_MIN, *scope)

    items = (
        await db.execute(
            q.offset(skip).limit(limit).order_by(StockItem.code)
        )
    ).scalars().all()

    # Batch-load supplier names
    sup_ids = [i.supplier_id for i in items if i.supplier_id]
    sup_map: dict = {}
    if sup_ids:
        sup_rows = (await db.execute(select(Supplier).where(Supplier.id.in_(sup_ids)))).scalars().all()
        sup_map = {str(s.id): s.name for s in sup_rows}

    return {
        "total": total,
        "low_stock_count": low_count,
        "zero_stock_count": zero_count,
        "below_min_count": below_min_count,
        "items": [_item_out(i, sup_map.get(str(i.supplier_id)) if i.supplier_id else None) for i in items],
    }


@router.get("/items/categories")
async def list_categories(
    include_archived: bool = False,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Distinct categories, part classes and warehouses for the filter dropdowns.

    Scoped to the caller's plant group and, like the list, to the live catalogue:
    these feed the Categories KPI and the filter options, so they must describe
    the rows the table can actually show.
    """
    scope = [plant_condition(StockItem, ctx)]
    if not include_archived:
        scope.append(StockItem.archived.is_(False))

    async def distinct(column):
        rows = await db.execute(
            select(column).where(*scope, column.isnot(None)).distinct()
        )
        return sorted({r[0] for r in rows.all() if r[0]})

    return {
        "categories": await distinct(StockItem.category),
        "part_classes": await distinct(StockItem.part_class),
        "warehouses": await distinct(StockItem.warehouse),
    }


@router.get("/items/{item_id}")
async def get_stock_item(
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    item = ensure_same_plant(await db.get(StockItem, item_id), ctx, grouped=True, detail="Item not found")
    supplier_name = None
    if item.supplier_id:
        sup = await db.get(Supplier, item.supplier_id)
        supplier_name = sup.name if sup else None
    return _item_out(item, supplier_name)


@router.post("/items", status_code=201)
async def create_stock_item(
    body: dict,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    item = StockItem(
        id=uuid.uuid4(),
        plant_id=ctx.plant_id,   # stamped from context, never client-controlled
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
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    item = ensure_same_plant(await db.get(StockItem, item_id), ctx, grouped=True, detail="Item not found")

    updatable = [
        "name", "description", "category", "part_class", "unit",
        "quantity", "min_quantity", "unit_cost", "warehouse", "location",
        "notes", "interal_product_id", "supplier_code",
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
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Quick quantity adjustment: body = { delta: float } or { quantity: float }"""
    item = ensure_same_plant(await db.get(StockItem, item_id), ctx, grouped=True, detail="Item not found")

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
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    item = ensure_same_plant(await db.get(StockItem, item_id), ctx, grouped=True, detail="Item not found")
    await db.delete(item)
    await db.commit()


@router.get("/dashboard")
async def inventory_dashboard(
    include_archived: bool = False,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Catalogue-wide counts. Plant-group scoped, live products only by default."""
    scope = [] if include_archived else [StockItem.archived.is_(False)]

    total_items = await _count(db, ctx, *scope)
    low_stock = await _count(db, ctx, NEEDS_REORDER, *scope)
    zero_stock = await _count(db, ctx, OUT_OF_STOCK, *scope)
    below_min = await _count(db, ctx, BELOW_MIN, *scope)
    archived = await _count(db, ctx, StockItem.archived.is_(True))
    incomplete = await _count(db, ctx, StockItem.import_incomplete.is_(True))

    # Category breakdown
    cat_q = (
        select(StockItem.category, func.count().label("cnt"))
        .where(plant_condition(StockItem, ctx), StockItem.category.isnot(None), *scope)
        .group_by(StockItem.category)
        .order_by(func.count().desc())
        .limit(10)
    )
    by_category = [{"category": r[0], "count": r[1]} for r in (await db.execute(cat_q)).all()]

    return {
        "total_items": total_items,
        "low_stock_count": low_stock,
        "zero_stock_count": zero_stock,
        "below_min_count": below_min,
        "archived_count": archived,
        "incomplete_count": incomplete,
        "by_category": by_category,
    }


@router.get("/search")
async def search_stock_items(
    q: str = Query("", min_length=0),
    limit: int = Query(10, le=50),
    db: AsyncSession = Depends(get_db),
):
    """Open endpoint (no auth) — for kiosk parts search during intervention.

    Every whitespace-separated term must match (in any order), each against any
    searchable field — so "bearing skf 205" finds "SKF 6205 bearing, banc de scie".
    """
    terms = q.split()
    filters = []
    for term in terms:
        like = f"%{term}%"
        filters.append(
            or_(
                StockItem.code.ilike(like),
                StockItem.name.ilike(like),
                StockItem.inventory_code.ilike(like),
                StockItem.description.ilike(like),
                StockItem.supplier_code.ilike(like),
                StockItem.supplier.ilike(like),
                StockItem.category.ilike(like),
            )
        )
    # Retired products never reach the floor: a technician picking parts for a
    # repair must not be offered a part number Interal has withdrawn.
    stmt = select(StockItem).where(StockItem.archived.is_(False))
    if filters:
        stmt = stmt.where(and_(*filters))
    if q:
        # Relevance: exact-code prefix, then code substring, then name, then the rest.
        rank = case(
            (StockItem.code.ilike(f"{q}%"), 0),
            (StockItem.code.ilike(f"%{q}%"), 1),
            (StockItem.name.ilike(f"%{q}%"), 2),
            else_=3,
        )
        stmt = stmt.order_by(rank, StockItem.code)
    else:
        stmt = stmt.order_by(StockItem.code)
    stmt = stmt.limit(limit)
    items = (await db.execute(stmt)).scalars().all()
    return {
        "items": [
            {
                "id": str(i.id),
                "code": i.code or "",
                "name": i.name or "",
                "description": i.description or "",
                "unit": i.unit or "",
                "quantity": float(i.quantity) if i.quantity is not None else 0.0,
                "unit_cost": float(i.unit_cost) if i.unit_cost is not None else None,
            }
            for i in items
        ]
    }


def _item_out(i: StockItem, supplier_name: Optional[str] = None) -> dict:
    qty = float(i.quantity) if i.quantity is not None else 0.0
    is_low = qty <= 0 or (
        i.min_quantity is not None and qty <= float(i.min_quantity)
    )
    available = float(i.quantity_available) if i.quantity_available is not None else None
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
        "quantity_available": available,
        "min_quantity": float(i.min_quantity) if i.min_quantity is not None else None,
        "unit_cost": float(i.unit_cost) if i.unit_cost is not None else None,
        "average_cost": float(i.average_cost) if i.average_cost is not None else None,
        "last_purchase_cost": float(i.last_purchase_cost) if i.last_purchase_cost is not None else None,
        "last_purchase_date": str(i.last_purchase_date) if i.last_purchase_date else None,
        "warehouse": i.warehouse or "",
        "location": i.location or "",
        "supplier_id": str(i.supplier_id) if i.supplier_id else None,
        "supplier_name": supplier_name,
        # The name the source carries, which stands in when no supplier record
        # matched its code and the link could not be made.
        "supplier": i.supplier or "",
        "supplier_code": i.supplier_code if hasattr(i, "supplier_code") else None,
        # Kept apart from `supplier`: the two disagree on 489 items.
        "preferred_supplier": i.preferred_supplier or "",
        "preferred_supplier_code": i.preferred_supplier_code or "",
        "interal_product_id": i.interal_product_id,
        "inventory_code": i.inventory_code or "",
        "stockable": i.stockable,
        "sale_markup": float(i.sale_markup) if i.sale_markup is not None else None,
        "drawing_revision": i.drawing_revision or "",
        "source_note": i.source_note or "",
        "archived": bool(i.archived),
        "import_incomplete": bool(i.import_incomplete),
        "source_synced_at": i.source_synced_at.isoformat() if i.source_synced_at else None,
        "notes": i.notes or "",
        "is_low_stock": is_low,
        # Only meaningful once a reservation makes the two diverge; the UI hides
        # it when they agree, which is every row of the current extraction.
        "has_reserved_stock": available is not None and abs(available - qty) > 1e-9,
    }
