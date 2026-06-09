from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.models import InterventionType, User
from app.core.security import get_current_user

router = APIRouter(prefix="/api/settings/intervention-types", tags=["Intervention Type Settings"])


class TypeCreate(BaseModel):
    equipment_id: UUID
    name: str
    icon: Optional[str] = "🔧"
    color: Optional[str] = "#388bfd"
    sort_order: Optional[int] = 0


class TypeUpdate(BaseModel):
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


def _to_dict(t: InterventionType) -> dict:
    return {
        "id":           str(t.id),
        "equipment_id": str(t.equipment_id) if t.equipment_id else None,
        "plant_id":     str(t.plant_id) if t.plant_id else None,
        "name":         t.name,
        "icon":         t.icon or "🔧",
        "color":        t.color or "#388bfd",
        "sort_order":   t.sort_order,
        "is_active":    t.is_active,
    }


@router.get("/")
async def list_types(
    equipment_id: Optional[UUID] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(InterventionType)
    if equipment_id:
        q = q.where(InterventionType.equipment_id == equipment_id)
    q = q.order_by(InterventionType.sort_order)
    items = (await db.execute(q)).scalars().all()
    return {"items": [_to_dict(t) for t in items]}


@router.post("/", status_code=201)
async def create_type(
    data: TypeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.models.models import Equipment
    equip = await db.get(Equipment, data.equipment_id)
    if not equip:
        raise HTTPException(404, "Equipment not found")

    itype = InterventionType(
        equipment_id=data.equipment_id,
        plant_id=equip.plant_id,
        name=data.name,
        icon=data.icon,
        color=data.color,
        sort_order=data.sort_order,
        is_active=True,
    )
    db.add(itype)
    await db.commit()
    await db.refresh(itype)
    return _to_dict(itype)


@router.patch("/{type_id}")
async def update_type(
    type_id: UUID,
    data: TypeUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    itype = await db.get(InterventionType, type_id)
    if not itype:
        raise HTTPException(404, "Intervention type not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(itype, field, value)
    await db.commit()
    await db.refresh(itype)
    return _to_dict(itype)


@router.delete("/{type_id}", status_code=200)
async def delete_type(
    type_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    itype = await db.get(InterventionType, type_id)
    if not itype:
        raise HTTPException(404, "Intervention type not found")
    itype.is_active = False
    await db.commit()
    return {"status": "deleted"}
