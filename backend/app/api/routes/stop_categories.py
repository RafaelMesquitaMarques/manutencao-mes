from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from uuid import UUID
from typing import List

from app.db.session import get_db
from app.models.models import StopCategory, StopSubcategory
from app.schemas.maintenance import (
    StopCategoryOut, StopCategoryCreate, StopCategoryUpdate,
    StopSubcategoryOut, StopSubcategoryCreate, StopSubcategoryUpdate,
    SortOrderItem,
)
from app.core.security import get_current_user
from app.models.models import User

router = APIRouter()


@router.get("/", response_model=List[StopCategoryOut])
async def list_categories(db: AsyncSession = Depends(get_db)):
    """List active stop categories with their subcategories (no auth — needed on kiosk)."""
    r = await db.execute(
        select(StopCategory).where(StopCategory.is_active == True).order_by(StopCategory.sort_order)
    )
    cats = r.scalars().all()
    result = []
    for cat in cats:
        r2 = await db.execute(
            select(StopSubcategory)
            .where(StopSubcategory.category_id == cat.id, StopSubcategory.is_active == True)
            .order_by(StopSubcategory.sort_order)
        )
        subs = r2.scalars().all()
        result.append(StopCategoryOut(
            id=cat.id,
            name=cat.name,
            type=cat.type,
            icon=cat.icon,
            color=cat.color,
            is_active=cat.is_active,
            sort_order=cat.sort_order,
            subcategories=[StopSubcategoryOut(
                id=s.id, category_id=s.category_id, name=s.name, icon=s.icon,
                color=s.color, triggers_maintenance=s.triggers_maintenance,
                is_active=s.is_active, sort_order=s.sort_order,
            ) for s in subs],
        ))
    return result


@router.post("/", response_model=StopCategoryOut, status_code=201)
async def create_category(
    data: StopCategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cat = StopCategory(**data.model_dump())
    db.add(cat)
    await db.commit()
    await db.refresh(cat)
    return StopCategoryOut(
        id=cat.id, name=cat.name, type=cat.type, icon=cat.icon,
        color=cat.color, is_active=cat.is_active, sort_order=cat.sort_order,
        subcategories=[],
    )


@router.patch("/{cat_id}", response_model=StopCategoryOut)
async def update_category(
    cat_id: UUID,
    data: StopCategoryUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cat = await db.get(StopCategory, cat_id)
    if not cat:
        raise HTTPException(404, "Category not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(cat, k, v)
    await db.commit()
    await db.refresh(cat)
    return StopCategoryOut(
        id=cat.id, name=cat.name, type=cat.type, icon=cat.icon,
        color=cat.color, is_active=cat.is_active, sort_order=cat.sort_order,
        subcategories=[],
    )


@router.patch("/reorder", response_model=List[StopCategoryOut])
async def reorder_categories(
    items: List[SortOrderItem],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    for item in items:
        cat = await db.get(StopCategory, item.id)
        if cat:
            cat.sort_order = item.sort_order
    await db.commit()
    return await list_categories(db)


@router.get("/{cat_id}/subcategories", response_model=List[StopSubcategoryOut])
async def list_subcategories(cat_id: UUID, db: AsyncSession = Depends(get_db)):
    r = await db.execute(
        select(StopSubcategory)
        .where(StopSubcategory.category_id == cat_id)
        .order_by(StopSubcategory.sort_order)
    )
    subs = r.scalars().all()
    return [StopSubcategoryOut(
        id=s.id, category_id=s.category_id, name=s.name, icon=s.icon,
        color=s.color, triggers_maintenance=s.triggers_maintenance,
        is_active=s.is_active, sort_order=s.sort_order,
    ) for s in subs]


@router.post("/{cat_id}/subcategories", response_model=StopSubcategoryOut, status_code=201)
async def create_subcategory(
    cat_id: UUID,
    data: StopSubcategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not await db.get(StopCategory, cat_id):
        raise HTTPException(404, "Category not found")
    sub = StopSubcategory(category_id=cat_id, **data.model_dump())
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return StopSubcategoryOut(
        id=sub.id, category_id=sub.category_id, name=sub.name, icon=sub.icon,
        color=sub.color, triggers_maintenance=sub.triggers_maintenance,
        is_active=sub.is_active, sort_order=sub.sort_order,
    )


@router.patch("/subcategories/{sub_id}", response_model=StopSubcategoryOut)
async def update_subcategory(
    sub_id: UUID,
    data: StopSubcategoryUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sub = await db.get(StopSubcategory, sub_id)
    if not sub:
        raise HTTPException(404, "Subcategory not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(sub, k, v)
    await db.commit()
    await db.refresh(sub)
    return StopSubcategoryOut(
        id=sub.id, category_id=sub.category_id, name=sub.name, icon=sub.icon,
        color=sub.color, triggers_maintenance=sub.triggers_maintenance,
        is_active=sub.is_active, sort_order=sub.sort_order,
    )


@router.patch("/subcategories/reorder", response_model=List[StopSubcategoryOut])
async def reorder_subcategories(
    items: List[SortOrderItem],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cat_id = None
    for item in items:
        sub = await db.get(StopSubcategory, item.id)
        if sub:
            sub.sort_order = item.sort_order
            cat_id = sub.category_id
    await db.commit()
    if cat_id:
        return await list_subcategories(cat_id, db)
    return []
