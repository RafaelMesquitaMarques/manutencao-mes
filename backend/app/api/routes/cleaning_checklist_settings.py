from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import CleaningChecklist, CleaningChecklistItem, User

router = APIRouter(prefix="/api/settings/cleaning-checklists", tags=["Cleaning Checklist Settings"])


def _checklist_out(checklist: CleaningChecklist) -> dict:
    return {
        "id": str(checklist.id),
        "equipment_id": str(checklist.equipment_id) if checklist.equipment_id else None,
        "stop_category_id": str(checklist.stop_category_id) if checklist.stop_category_id else None,
        "name": checklist.name,
        "is_active": checklist.is_active,
    }


async def _get_or_none(equipment_id: UUID, db: AsyncSession) -> Optional[CleaningChecklist]:
    r = await db.execute(
        select(CleaningChecklist).where(CleaningChecklist.equipment_id == equipment_id).limit(1)
    )
    return r.scalar_one_or_none()


@router.get("/{equipment_id}")
async def get_checklist_for_equipment(
    equipment_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    checklist = await _get_or_none(equipment_id, db)
    if not checklist:
        return {"checklist": None, "items": []}

    items_r = await db.execute(
        select(CleaningChecklistItem)
        .where(CleaningChecklistItem.checklist_id == checklist.id)
        .order_by(CleaningChecklistItem.sort_order)
    )
    items = items_r.scalars().all()
    return {
        "checklist": _checklist_out(checklist),
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


class ChecklistPatch(BaseModel):
    name: Optional[str] = None
    stop_category_id: Optional[str] = None   # "" clears the link
    is_active: Optional[bool] = None
    plant_id: Optional[str] = None


@router.patch("/{equipment_id}")
async def upsert_checklist(
    equipment_id: UUID,
    body: ChecklistPatch,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update checklist metadata (creates the checklist row if missing, so the
    category link can be set before any item exists)."""
    checklist = await _get_or_none(equipment_id, db)
    if not checklist:
        checklist = CleaningChecklist(equipment_id=equipment_id, name="Cleaning checklist", is_active=True)
        db.add(checklist)
        await db.flush()

    if body.name is not None:
        checklist.name = body.name
    if body.is_active is not None:
        checklist.is_active = body.is_active
    if body.stop_category_id is not None:
        if body.stop_category_id == "":
            checklist.stop_category_id = None
        else:
            try:
                checklist.stop_category_id = UUID(body.stop_category_id)
            except ValueError:
                raise HTTPException(400, "Invalid stop_category_id")
    if body.plant_id:
        try:
            checklist.plant_id = UUID(body.plant_id)
        except ValueError:
            pass
    await db.commit()
    await db.refresh(checklist)
    return _checklist_out(checklist)


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
    checklist = await _get_or_none(equipment_id, db)
    if not checklist:
        checklist = CleaningChecklist(equipment_id=equipment_id, name="Cleaning checklist", is_active=True)
        db.add(checklist)
        await db.flush()

    item = CleaningChecklistItem(
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
    item = await db.get(CleaningChecklistItem, item_id)
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
    item = await db.get(CleaningChecklistItem, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    await db.delete(item)
    await db.commit()
