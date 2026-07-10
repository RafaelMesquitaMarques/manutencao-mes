"""
backend/app/api/routes/suppliers.py
Supplier management + Purchase Orders
"""
from __future__ import annotations

import math
import uuid
from datetime import date, timedelta
from typing import Optional, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_, and_
from sqlalchemy.orm import selectinload

from app.db.session import get_db
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_condition, plant_scoped
from app.models.models import (
    Supplier, StockItem, PurchaseOrder, PurchaseOrderItem,
    InventoryMovement, User, PurchaseOrderStatus, CostCenter,
)

supplier_router = APIRouter()
po_router       = APIRouter()


@po_router.get("/cost-centers")
async def po_cost_centers(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SAP cost centers a purchase order books to — active, coded, code first."""
    rows = (await db.execute(
        select(CostCenter.name, CostCenter.code)
        .where(CostCenter.active == True, CostCenter.code.isnot(None))  # noqa: E712
        .order_by(CostCenter.code, CostCenter.name)
    )).all()
    return [{"name": name, "code": code} for name, code in rows]


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _supplier_out(s: Supplier, item_count: int = 0, order_count: int = 0, open_order_count: int = 0) -> dict:
    return {
        "id":              str(s.id),
        "code":            s.code or "",
        "name":            s.name,
        "contact_name":    s.contact_name,
        "email":           s.email,
        "phone":           s.phone,
        "fax":             s.fax,
        "website":         s.website,
        "address":         s.address,
        "city":            s.city,
        "country":         s.country,
        "category":        s.category,
        "payment_terms":   s.payment_terms,
        "currency":        s.currency or "CAD",
        "lead_time_days":  s.lead_time_days,
        "rating":          s.rating,
        "notes":           s.notes,
        "is_active":       s.is_active,
        "created_at":      s.created_at.isoformat() if s.created_at else None,
        "updated_at":      s.updated_at.isoformat() if s.updated_at else None,
        "item_count":      item_count,
        "order_count":     order_count,
        "open_order_count": open_order_count,
    }


def _poi_out(i: PurchaseOrderItem) -> dict:
    return {
        "id":                str(i.id),
        "order_id":          str(i.order_id),
        "stock_item_id":     str(i.stock_item_id) if i.stock_item_id else None,
        "description":       i.description,
        "quantity":          i.quantity,
        "unit_cost":         i.unit_cost,
        "total_cost":        i.total_cost,
        "received_quantity": i.received_quantity,
        "notes":             i.notes,
    }


def _po_out(po: PurchaseOrder, include_items: bool = False) -> dict:
    d: dict[str, Any] = {
        "id":            str(po.id),
        "order_number":  po.order_number,
        "supplier_id":   str(po.supplier_id),
        "supplier_name": po.supplier.name if po.supplier else None,
        "supplier_code": po.supplier.code if po.supplier else None,
        "status":        po.status,
        "order_date":    str(po.order_date) if po.order_date else None,
        "expected_date": str(po.expected_date) if po.expected_date else None,
        "received_date": str(po.received_date) if po.received_date else None,
        "total_amount":  po.total_amount,
        "currency":      po.currency or "CAD",
        "cost_center":   po.cost_center,
        "scope":         po.scope or "opex",
        "notes":         po.notes,
        "created_by_id": str(po.created_by_id) if po.created_by_id else None,
        "created_at":    po.created_at.isoformat() if po.created_at else None,
        "updated_at":    po.updated_at.isoformat() if po.updated_at else None,
        "item_count":    len(po.items) if po.items is not None else 0,
    }
    if include_items:
        d["items"] = [_poi_out(i) for i in (po.items or [])]
    return d


async def _next_po_number(db: AsyncSession, plant_id=None) -> str:
    from app.services.numbering import series_prefix
    sp = await series_prefix(db, plant_id)
    year = date.today().year
    result = await db.execute(
        select(func.max(PurchaseOrder.order_number)).where(
            PurchaseOrder.order_number.like(f"{sp}PO-{year}-%")
        )
    )
    last = result.scalar_one_or_none()
    seq = int(last.split("-")[-1]) + 1 if last else 1
    return f"{sp}PO-{year}-{seq:04d}"


# ─── SUPPLIERS ────────────────────────────────────────────────────────────────

@supplier_router.get("")
async def list_suppliers(
    search: Optional[str] = None,
    category: Optional[str] = None,
    active_only: bool = False,
    skip: int = 0,
    limit: int = Query(default=100, le=500),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    q = plant_scoped(select(Supplier), Supplier, ctx)   # group-scoped: QC pool
    if active_only:
        q = q.where(Supplier.is_active == True)
    if category:
        q = q.where(Supplier.category == category)
    if search:
        q = q.where(or_(
            Supplier.name.ilike(f"%{search}%"),
            Supplier.code.ilike(f"%{search}%"),
            Supplier.contact_name.ilike(f"%{search}%"),
        ))

    total_q = select(func.count()).select_from(q.subquery())
    total   = (await db.execute(total_q)).scalar_one()
    rows    = (await db.execute(q.order_by(Supplier.name).offset(skip).limit(limit))).scalars().all()

    # Batch counts
    supplier_ids = [s.id for s in rows]
    item_counts: dict[str, int] = {}
    order_counts: dict[str, int] = {}
    open_order_counts: dict[str, int] = {}
    if supplier_ids:
        ic = await db.execute(
            select(StockItem.supplier_id, func.count())
            .where(StockItem.supplier_id.in_(supplier_ids))
            .group_by(StockItem.supplier_id)
        )
        item_counts = {str(r[0]): r[1] for r in ic.all()}

        oc = await db.execute(
            select(PurchaseOrder.supplier_id, func.count())
            .where(PurchaseOrder.supplier_id.in_(supplier_ids))
            .group_by(PurchaseOrder.supplier_id)
        )
        order_counts = {str(r[0]): r[1] for r in oc.all()}

        ooc = await db.execute(
            select(PurchaseOrder.supplier_id, func.count())
            .where(and_(
                PurchaseOrder.supplier_id.in_(supplier_ids),
                PurchaseOrder.status.in_([PurchaseOrderStatus.draft, PurchaseOrderStatus.sent, PurchaseOrderStatus.confirmed]),
            ))
            .group_by(PurchaseOrder.supplier_id)
        )
        open_order_counts = {str(r[0]): r[1] for r in ooc.all()}

    items = [
        _supplier_out(
            s,
            item_count=item_counts.get(str(s.id), 0),
            order_count=order_counts.get(str(s.id), 0),
            open_order_count=open_order_counts.get(str(s.id), 0),
        )
        for s in rows
    ]
    return {"total": total, "items": items}


@supplier_router.get("/dashboard")
async def supplier_dashboard(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    total   = (await db.execute(select(func.count()).select_from(Supplier))).scalar_one()
    active  = (await db.execute(select(func.count()).select_from(Supplier).where(Supplier.is_active == True))).scalar_one()
    open_pos = (await db.execute(
        select(func.count()).select_from(PurchaseOrder).where(
            PurchaseOrder.status.in_([PurchaseOrderStatus.draft, PurchaseOrderStatus.sent, PurchaseOrderStatus.confirmed])
        )
    )).scalar_one()
    low_stock_with_supplier = (await db.execute(
        select(func.count()).select_from(
            select(StockItem).where(
                and_(StockItem.supplier_id.isnot(None), or_(StockItem.quantity <= 0, and_(StockItem.min_quantity.isnot(None), StockItem.quantity <= StockItem.min_quantity)))
            ).subquery()
        )
    )).scalar_one()
    cats = (await db.execute(
        select(Supplier.category, func.count()).where(Supplier.category.isnot(None)).group_by(Supplier.category).order_by(func.count().desc())
    )).all()
    return {
        "total_suppliers": total,
        "active_suppliers": active,
        "open_purchase_orders": open_pos,
        "low_stock_with_supplier": low_stock_with_supplier,
        "by_category": [{"category": r[0], "count": r[1]} for r in cats],
    }


@supplier_router.get("/{supplier_id}")
async def get_supplier(
    supplier_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    s = await db.get(Supplier, supplier_id)
    if not s:
        raise HTTPException(404, "Supplier not found")
    ic = (await db.execute(select(func.count()).select_from(StockItem).where(StockItem.supplier_id == supplier_id))).scalar_one()
    oc = (await db.execute(select(func.count()).select_from(PurchaseOrder).where(PurchaseOrder.supplier_id == supplier_id))).scalar_one()
    ooc = (await db.execute(
        select(func.count()).select_from(PurchaseOrder).where(and_(
            PurchaseOrder.supplier_id == supplier_id,
            PurchaseOrder.status.in_([PurchaseOrderStatus.draft, PurchaseOrderStatus.sent, PurchaseOrderStatus.confirmed]),
        ))
    )).scalar_one()
    return _supplier_out(s, item_count=ic, order_count=oc, open_order_count=ooc)


@supplier_router.post("", status_code=201)
async def create_supplier(
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not body.get("name"):
        raise HTTPException(422, "name is required")
    s = Supplier(
        code=body.get("code") or None,
        name=body["name"],
        contact_name=body.get("contact_name"),
        email=body.get("email"),
        phone=body.get("phone"),
        fax=body.get("fax"),
        website=body.get("website"),
        address=body.get("address"),
        city=body.get("city"),
        country=body.get("country"),
        category=body.get("category"),
        payment_terms=body.get("payment_terms"),
        currency=body.get("currency", "CAD"),
        lead_time_days=body.get("lead_time_days"),
        rating=body.get("rating"),
        notes=body.get("notes"),
        is_active=body.get("is_active", True),
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return _supplier_out(s)


@supplier_router.patch("/{supplier_id}")
async def update_supplier(
    supplier_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    s = await db.get(Supplier, supplier_id)
    if not s:
        raise HTTPException(404, "Supplier not found")
    updatable = [
        "code", "name", "contact_name", "email", "phone", "fax", "website",
        "address", "city", "country", "category", "payment_terms", "currency",
        "lead_time_days", "rating", "notes", "is_active",
    ]
    for field in updatable:
        if field in body:
            setattr(s, field, body[field])
    await db.commit()
    await db.refresh(s)
    return _supplier_out(s)


@supplier_router.delete("/{supplier_id}", status_code=204)
async def deactivate_supplier(
    supplier_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    s = await db.get(Supplier, supplier_id)
    if not s:
        raise HTTPException(404, "Supplier not found")
    s.is_active = False
    await db.commit()


@supplier_router.get("/{supplier_id}/items")
async def supplier_items(
    supplier_id: uuid.UUID,
    skip: int = 0,
    limit: int = Query(default=100, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(StockItem).where(StockItem.supplier_id == supplier_id)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    rows  = (await db.execute(q.order_by(StockItem.code).offset(skip).limit(limit))).scalars().all()
    return {"total": total, "items": [
        {
            "id": str(i.id), "code": i.code, "name": i.name or "",
            "description": i.description or "", "category": i.category or "",
            "quantity": float(i.quantity or 0), "min_quantity": i.min_quantity,
            "unit": i.unit or "Unitaire", "unit_cost": i.unit_cost,
            "warehouse": i.warehouse or "", "location": i.location or "",
            "supplier_code": i.supplier_code,
            "is_low_stock": (float(i.quantity or 0) <= 0) or bool(i.min_quantity and float(i.quantity or 0) <= float(i.min_quantity)),
        }
        for i in rows
    ]}


@supplier_router.get("/{supplier_id}/orders")
async def supplier_orders(
    supplier_id: uuid.UUID,
    skip: int = 0,
    limit: int = Query(default=50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = (
        select(PurchaseOrder)
        .where(PurchaseOrder.supplier_id == supplier_id)
        .options(selectinload(PurchaseOrder.supplier), selectinload(PurchaseOrder.items))
    )
    total = (await db.execute(select(func.count()).select_from(
        select(PurchaseOrder).where(PurchaseOrder.supplier_id == supplier_id).subquery()
    ))).scalar_one()
    rows = (await db.execute(q.order_by(PurchaseOrder.order_date.desc()).offset(skip).limit(limit))).scalars().all()
    return {"total": total, "items": [_po_out(po) for po in rows]}


# ─── PURCHASE ORDERS ─────────────────────────────────────────────────────────

@po_router.get("")
async def list_purchase_orders(
    status: Optional[str] = None,
    supplier_id: Optional[uuid.UUID] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    skip: int = 0,
    limit: int = Query(default=50, le=200),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    # POs are PLANT-scoped (the buying plant), unlike suppliers (group pool).
    q = plant_scoped(
        select(PurchaseOrder).options(selectinload(PurchaseOrder.supplier), selectinload(PurchaseOrder.items)),
        PurchaseOrder, ctx,
    )
    if status:
        q = q.where(PurchaseOrder.status == status)
    if supplier_id:
        q = q.where(PurchaseOrder.supplier_id == supplier_id)
    if date_from:
        q = q.where(PurchaseOrder.order_date >= date_from)
    if date_to:
        q = q.where(PurchaseOrder.order_date <= date_to)

    count_q = select(func.count()).select_from(
        select(PurchaseOrder).where(*[c for c in q.whereclause.clauses] if hasattr(q, 'whereclause') and q.whereclause is not None else []).subquery()
    ) if False else select(func.count()).select_from(q.subquery())

    total = (await db.execute(count_q)).scalar_one()
    rows  = (await db.execute(q.order_by(PurchaseOrder.order_date.desc()).offset(skip).limit(limit))).scalars().all()
    return {"total": total, "items": [_po_out(po) for po in rows]}


@po_router.post("", status_code=201)
async def create_purchase_order(
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
):
    if not body.get("supplier_id"):
        raise HTTPException(422, "supplier_id is required")
    # Supplier must be visible in the active plant's group (QC pool / LV own list).
    supplier = ensure_same_plant(
        await db.get(Supplier, uuid.UUID(body["supplier_id"])), ctx,
        grouped=True, detail="Supplier not found",
    )

    order_number = await _next_po_number(db, ctx.plant_id)
    po = PurchaseOrder(
        order_number=order_number,
        supplier_id=uuid.UUID(body["supplier_id"]),
        plant_id=ctx.plant_id,   # the buying plant is the active context

        status=PurchaseOrderStatus(body.get("status", "draft")),
        order_date=date.fromisoformat(body.get("order_date") or str(date.today())),
        expected_date=date.fromisoformat(body["expected_date"]) if body.get("expected_date") else None,
        currency=body.get("currency", supplier.currency or "CAD"),
        cost_center=(body.get("cost_center") or None),
        scope=("capex" if body.get("scope") == "capex" else "opex"),
        notes=body.get("notes"),
        created_by_id=current_user.id,
    )
    db.add(po)
    await db.flush()

    total = 0.0
    for item in body.get("items", []):
        qty   = float(item.get("quantity", 1))
        cost  = float(item.get("unit_cost", 0))
        total_cost = round(qty * cost, 4)
        total += total_cost
        poi = PurchaseOrderItem(
            order_id=po.id,
            stock_item_id=uuid.UUID(item["stock_item_id"]) if item.get("stock_item_id") else None,
            description=item.get("description", ""),
            quantity=qty,
            unit_cost=cost,
            total_cost=total_cost,
            notes=item.get("notes"),
        )
        db.add(poi)

    po.total_amount = round(total, 2)
    await db.commit()

    result = await db.scalar(
        select(PurchaseOrder)
        .where(PurchaseOrder.id == po.id)
        .options(selectinload(PurchaseOrder.supplier), selectinload(PurchaseOrder.items))
    )
    return _po_out(result, include_items=True)


@po_router.get("/{order_id}")
async def get_purchase_order(
    order_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    po = await db.scalar(
        select(PurchaseOrder)
        .where(PurchaseOrder.id == order_id)
        .options(selectinload(PurchaseOrder.supplier), selectinload(PurchaseOrder.items))
    )
    if not po:
        raise HTTPException(404, "Purchase order not found")
    return _po_out(po, include_items=True)


@po_router.patch("/{order_id}")
async def update_purchase_order(
    order_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    po = await db.scalar(
        select(PurchaseOrder)
        .where(PurchaseOrder.id == order_id)
        .options(selectinload(PurchaseOrder.supplier), selectinload(PurchaseOrder.items))
    )
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if po.status == PurchaseOrderStatus.received:
        raise HTTPException(400, "Cannot edit a received order")
    if "status" in body:
        po.status = PurchaseOrderStatus(body["status"])
    if "expected_date" in body:
        po.expected_date = date.fromisoformat(body["expected_date"]) if body["expected_date"] else None
    if "cost_center" in body:
        po.cost_center = body["cost_center"] or None
    if "scope" in body:
        po.scope = "capex" if body["scope"] == "capex" else "opex"
    if "notes" in body:
        po.notes = body["notes"]
    if "currency" in body:
        po.currency = body["currency"]
    await db.commit()
    await db.refresh(po)
    result = await db.scalar(
        select(PurchaseOrder)
        .where(PurchaseOrder.id == order_id)
        .options(selectinload(PurchaseOrder.supplier), selectinload(PurchaseOrder.items))
    )
    return _po_out(result, include_items=True)


@po_router.post("/{order_id}/items", status_code=201)
async def add_po_item(
    order_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    po = await db.get(PurchaseOrder, order_id)
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if po.status == PurchaseOrderStatus.received:
        raise HTTPException(400, "Cannot add items to a received order")
    qty  = float(body.get("quantity", 1))
    cost = float(body.get("unit_cost", 0))
    poi  = PurchaseOrderItem(
        order_id=order_id,
        stock_item_id=uuid.UUID(body["stock_item_id"]) if body.get("stock_item_id") else None,
        description=body.get("description", ""),
        quantity=qty,
        unit_cost=cost,
        total_cost=round(qty * cost, 4),
        notes=body.get("notes"),
    )
    db.add(poi)
    # Recompute order total
    await db.flush()
    items_q = await db.execute(select(PurchaseOrderItem).where(PurchaseOrderItem.order_id == order_id))
    all_items = items_q.scalars().all()
    po.total_amount = round(sum(i.total_cost for i in all_items), 2)
    await db.commit()
    await db.refresh(poi)
    return _poi_out(poi)


@po_router.patch("/{order_id}/receive")
async def receive_purchase_order(
    order_id: uuid.UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    po = await db.scalar(
        select(PurchaseOrder)
        .where(PurchaseOrder.id == order_id)
        .options(selectinload(PurchaseOrder.supplier), selectinload(PurchaseOrder.items))
    )
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if po.status == PurchaseOrderStatus.cancelled:
        raise HTTPException(400, "Cannot receive a cancelled order")
    if po.status == PurchaseOrderStatus.received:
        raise HTTPException(400, "Order already received")

    receive_map = {item["id"]: float(item["received_quantity"]) for item in body.get("items", [])}

    affected_stock_ids = set()
    for poi in po.items:
        received_qty = receive_map.get(str(poi.id), poi.received_quantity or 0)
        if received_qty < 0:
            continue
        delta = received_qty - (poi.received_quantity or 0)
        poi.received_quantity = received_qty

        if poi.stock_item_id and delta > 0:
            stock = await db.get(StockItem, poi.stock_item_id)
            if stock:
                qty_before = float(stock.quantity or 0)
                stock.quantity = qty_before + delta
                # This receipt is, by definition, the most recent purchase
                stock.last_purchase_cost = poi.unit_cost
                stock.last_purchase_date = date.today()
                movement = InventoryMovement(
                    stock_item_id=poi.stock_item_id,
                    movement_type="addition",
                    quantity=delta,
                    quantity_before=qty_before,
                    quantity_after=stock.quantity,
                    unit_cost=poi.unit_cost,
                    notes=f"Purchase Order {po.order_number}",
                    created_by_id=current_user.id,
                )
                db.add(movement)
                affected_stock_ids.add(poi.stock_item_id)

    po.status        = PurchaseOrderStatus.received
    po.received_date = date.today()
    po.total_amount  = round(sum(i.received_quantity * i.unit_cost for i in po.items), 2)

    # Recompute the weighted-average cost from every received movement (incl. the
    # new ones) — same formula as the startup backfill, so the two never drift.
    if affected_stock_ids:
        await db.flush()
        for sid in affected_stock_ids:
            rows = (await db.execute(
                select(InventoryMovement.unit_cost, InventoryMovement.quantity).where(
                    InventoryMovement.stock_item_id == sid,
                    InventoryMovement.movement_type == "addition",
                )
            )).all()
            pairs = [(uc, q) for uc, q in rows if uc is not None and (q or 0) > 0]
            total_qty = sum(q for _, q in pairs)
            if total_qty > 0:
                stock = await db.get(StockItem, sid)
                if stock:
                    stock.average_cost = round(sum(uc * q for uc, q in pairs) / total_qty, 4)

    await db.commit()
    result = await db.scalar(
        select(PurchaseOrder)
        .where(PurchaseOrder.id == order_id)
        .options(selectinload(PurchaseOrder.supplier), selectinload(PurchaseOrder.items))
    )
    return _po_out(result, include_items=True)


# ─── AUTO-REPLENISHMENT ──────────────────────────────────────────────────────

OPEN_PO_STATUSES = [PurchaseOrderStatus.draft, PurchaseOrderStatus.sent, PurchaseOrderStatus.confirmed]


def _low_stock_cond():
    return or_(
        StockItem.quantity <= 0,
        and_(StockItem.min_quantity.isnot(None), StockItem.quantity <= StockItem.min_quantity),
    )


def _suggested_qty(item: StockItem) -> float:
    """Refill to twice the minimum (min/max heuristic); at least 1."""
    qty = float(item.quantity or 0)
    if item.min_quantity:
        return float(math.ceil(max(float(item.min_quantity) * 2 - qty, 1.0)))
    return float(math.ceil(max(1.0 - qty, 1.0)))


async def _covered_stock_ids(db: AsyncSession) -> set:
    """Stock items already on an open (draft/sent/confirmed) purchase order."""
    r = await db.execute(
        select(PurchaseOrderItem.stock_item_id)
        .join(PurchaseOrder, PurchaseOrderItem.order_id == PurchaseOrder.id)
        .where(
            PurchaseOrder.status.in_(OPEN_PO_STATUSES),
            PurchaseOrderItem.stock_item_id.isnot(None),
        )
    )
    return {row[0] for row in r.all()}


@po_router.get("/replenishment/preview")
async def replenishment_preview(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Low-stock items grouped by supplier, ready to turn into draft POs.
    Items already on an open PO are excluded; items without a supplier are
    reported separately (they can't be ordered automatically)."""
    covered = await _covered_stock_ids(db)
    items = (await db.execute(
        select(StockItem).where(_low_stock_cond()).order_by(StockItem.code)
    )).scalars().all()

    sup_ids = {i.supplier_id for i in items if i.supplier_id}
    sup_map: dict = {}
    if sup_ids:
        sups = (await db.execute(select(Supplier).where(Supplier.id.in_(sup_ids)))).scalars().all()
        sup_map = {s.id: s for s in sups}

    groups: dict = {}
    already_ordered = 0
    without_supplier = 0
    without_supplier_sample: list = []

    for i in items:
        if i.id in covered:
            already_ordered += 1
            continue
        sup = sup_map.get(i.supplier_id) if i.supplier_id else None
        if not sup:
            without_supplier += 1
            if len(without_supplier_sample) < 50:
                without_supplier_sample.append({
                    "stock_item_id": str(i.id),
                    "code": i.code or "",
                    "description": i.description or i.name or "",
                    "quantity_in_stock": float(i.quantity or 0),
                })
            continue
        key = str(sup.id)
        if key not in groups:
            groups[key] = {
                "supplier_id": key,
                "supplier_name": sup.name,
                "supplier_code": sup.code,
                "currency": sup.currency or "CAD",
                "lead_time_days": sup.lead_time_days,
                "items": [],
            }
        qty = _suggested_qty(i)
        groups[key]["items"].append({
            "stock_item_id": str(i.id),
            "code": i.code or "",
            "description": i.description or i.name or "",
            "quantity_in_stock": float(i.quantity or 0),
            "min_quantity": i.min_quantity,
            "unit": i.unit or "Unitaire",
            "unit_cost": i.unit_cost,
            "suggested_quantity": qty,
            "estimated_cost": round(qty * float(i.unit_cost), 2) if i.unit_cost else None,
        })

    group_list = sorted(groups.values(), key=lambda g: g["supplier_name"])
    for g in group_list:
        g["estimated_total"] = round(sum(it["estimated_cost"] or 0 for it in g["items"]), 2)

    return {
        "groups": group_list,
        "low_stock_total": len(items),
        "orderable": sum(len(g["items"]) for g in group_list),
        "already_ordered": already_ordered,
        "without_supplier": without_supplier,
        "without_supplier_sample": without_supplier_sample,
    }


@po_router.post("/replenishment/generate", status_code=201)
async def replenishment_generate(
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Create one draft PO per supplier from the selected items.
    Body: { items: [{stock_item_id, quantity}], notes?: str }"""
    requested = body.get("items") or []
    if not requested:
        raise HTTPException(422, "items is required")

    qty_by_id: dict = {}
    for entry in requested:
        try:
            sid = uuid.UUID(entry["stock_item_id"])
        except (KeyError, ValueError, TypeError):
            continue
        qty = float(entry.get("quantity") or 0)
        if qty > 0:
            qty_by_id[sid] = qty
    if not qty_by_id:
        raise HTTPException(422, "No valid items")

    stock_items = (await db.execute(
        select(StockItem).where(StockItem.id.in_(list(qty_by_id.keys())))
    )).scalars().all()

    covered = await _covered_stock_ids(db)
    by_supplier: dict = {}
    skipped_no_supplier = 0
    skipped_covered = 0
    for i in stock_items:
        if i.id in covered:
            skipped_covered += 1
            continue
        if not i.supplier_id:
            skipped_no_supplier += 1
            continue
        by_supplier.setdefault(i.supplier_id, []).append(i)

    if not by_supplier:
        raise HTTPException(422, "No orderable items (missing supplier or already on an open PO)")

    # Sequential numbers computed once to avoid duplicates within the batch
    base_number = await _next_po_number(db, ctx.plant_id)
    year_prefix, seq = base_number.rsplit("-", 1)
    seq = int(seq)

    today = date.today()
    notes = body.get("notes") or "Auto-replenishment (low stock)"
    created_pos: list = []

    for supplier_id, sup_items in by_supplier.items():
        supplier = await db.get(Supplier, supplier_id)
        if not supplier:
            continue
        po = PurchaseOrder(
            order_number=f"{year_prefix}-{seq:04d}",
            supplier_id=supplier_id,
            plant_id=ctx.plant_id,
            status=PurchaseOrderStatus.draft,
            order_date=today,
            expected_date=today + timedelta(days=supplier.lead_time_days) if supplier.lead_time_days else None,
            currency=supplier.currency or "CAD",
            notes=notes,
            created_by_id=current_user.id,
        )
        seq += 1
        db.add(po)
        await db.flush()

        total = 0.0
        for i in sup_items:
            qty = qty_by_id[i.id]
            cost = float(i.unit_cost) if i.unit_cost is not None else 0.0
            line_total = round(qty * cost, 4)
            total += line_total
            db.add(PurchaseOrderItem(
                order_id=po.id,
                stock_item_id=i.id,
                description=i.description or i.name or i.code or "",
                quantity=qty,
                unit_cost=cost,
                total_cost=line_total,
            ))
        po.total_amount = round(total, 2)
        created_pos.append(po.id)

    await db.commit()

    result = (await db.execute(
        select(PurchaseOrder)
        .where(PurchaseOrder.id.in_(created_pos))
        .options(selectinload(PurchaseOrder.supplier), selectinload(PurchaseOrder.items))
        .order_by(PurchaseOrder.order_number)
    )).scalars().all()

    return {
        "created": [_po_out(po, include_items=True) for po in result],
        "skipped_no_supplier": skipped_no_supplier,
        "skipped_already_ordered": skipped_covered,
    }
