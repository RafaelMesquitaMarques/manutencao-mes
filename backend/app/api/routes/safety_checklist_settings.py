from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import SafetyChecklist, SafetyChecklistItem, User

router = APIRouter(prefix="/api/settings/safety-checklists", tags=["Safety Checklist Settings"])


@router.get("/{equipment_id}")
async def get_checklist_for_equipment(
    equipment_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    r = await db.execute(
        select(SafetyChecklist).where(SafetyChecklist.equipment_id == equipment_id).limit(1)
    )
    checklist = r.scalar_one_or_none()
    if not checklist:
        return {"checklist": None, "items": []}

    items_r = await db.execute(
        select(SafetyChecklistItem)
        .where(SafetyChecklistItem.checklist_id == checklist.id)
        .order_by(SafetyChecklistItem.sort_order)
    )
    items = items_r.scalars().all()
    return {
        "checklist": {
            "id": str(checklist.id),
            "equipment_id": str(checklist.equipment_id) if checklist.equipment_id else None,
            "name": checklist.name,
            "is_active": checklist.is_active,
        },
        "items": [
            {
                "id": str(i.id),
                "text": i.text,
                "sort_order": i.sort_order,
                "is_required": i.is_required,
            }
            for i in items
        ],
    }


class ChecklistCreate(BaseModel):
    name: str = "Safety checklist"
    plant_id: Optional[str] = None


@router.post("/{equipment_id}", status_code=201)
async def create_checklist(
    equipment_id: UUID,
    body: ChecklistCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    checklist = SafetyChecklist(
        equipment_id=equipment_id,
        name=body.name,
        is_active=True,
    )
    if body.plant_id:
        try:
            checklist.plant_id = UUID(body.plant_id)
        except ValueError:
            pass
    db.add(checklist)
    await db.commit()
    await db.refresh(checklist)
    return {"id": str(checklist.id), "name": checklist.name, "is_active": checklist.is_active}


class ItemBody(BaseModel):
    text: str
    sort_order: int = 0
    is_required: bool = True


@router.post("/{equipment_id}/items", status_code=201)
async def add_checklist_item(
    equipment_id: UUID,
    body: ItemBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    r = await db.execute(
        select(SafetyChecklist).where(SafetyChecklist.equipment_id == equipment_id).limit(1)
    )
    checklist = r.scalar_one_or_none()
    if not checklist:
        checklist = SafetyChecklist(equipment_id=equipment_id, name="Safety checklist", is_active=True)
        db.add(checklist)
        await db.flush()

    item = SafetyChecklistItem(
        checklist_id=checklist.id,
        text=body.text,
        sort_order=body.sort_order,
        is_required=body.is_required,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return {"id": str(item.id), "text": item.text, "sort_order": item.sort_order, "is_required": item.is_required}


class ItemUpdate(BaseModel):
    text: Optional[str] = None
    sort_order: Optional[int] = None
    is_required: Optional[bool] = None


@router.patch("/{equipment_id}/items/{item_id}")
async def update_checklist_item(
    equipment_id: UUID,
    item_id: UUID,
    body: ItemUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = await db.get(SafetyChecklistItem, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    if body.text is not None:
        item.text = body.text
    if body.sort_order is not None:
        item.sort_order = body.sort_order
    if body.is_required is not None:
        item.is_required = body.is_required
    await db.commit()
    await db.refresh(item)
    return {"id": str(item.id), "text": item.text, "sort_order": item.sort_order, "is_required": item.is_required}


@router.delete("/{equipment_id}/items/{item_id}", status_code=204)
async def delete_checklist_item(
    equipment_id: UUID,
    item_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = await db.get(SafetyChecklistItem, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    await db.delete(item)
    await db.commit()
