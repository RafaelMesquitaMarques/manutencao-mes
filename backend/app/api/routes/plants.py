from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime

from app.db.session import get_db
from app.models.models import Plant, User, UserPlant, UserRole
from app.core.security import get_current_user
from app.core.permissions import require_admin
from app.core.plant_context import PlantContext, get_plant_context

router = APIRouter()


class PlantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    code: str
    name: str
    address: Optional[str] = None
    timezone: Optional[str] = None
    active: bool
    created_at: datetime


class PlantCreate(BaseModel):
    code: str
    name: str
    address: Optional[str] = None
    timezone: str = "America/Toronto"


class PlantUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    timezone: Optional[str] = None
    active: Optional[bool] = None


@router.get("/", response_model=List[PlantOut])
async def list_plants(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Plants visible to the caller: corporate admin sees all active plants,
    everyone else only the plants they hold a membership for (never reveal
    other plants' existence to single-plant users)."""
    q = select(Plant).where(Plant.active == True).order_by(Plant.name)  # noqa: E712
    if current_user.role != UserRole.admin:
        q = q.join(UserPlant, UserPlant.plant_id == Plant.id).where(
            UserPlant.user_id == current_user.id
        )
    r = await db.execute(q)
    return r.scalars().all()


@router.get("/active")
async def active_plant(ctx: PlantContext = Depends(get_plant_context), db: AsyncSession = Depends(get_db)):
    """The resolved plant context for this request (X-Plant-Id header or the
    user's default plant) — role held there and switchable plants included."""
    plant = await db.get(Plant, ctx.plant_id)
    return {
        "plant_id": str(ctx.plant_id),
        "code": plant.code if plant else None,
        "name": plant.name if plant else None,
        "role": ctx.role.value,
        "is_corporate": ctx.is_corporate,
        "allowed_plant_ids": [str(p) for p in sorted(ctx.allowed_plant_ids, key=str)],
    }


@router.post("/", response_model=PlantOut, status_code=201)
async def create_plant(
    data: PlantCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    plant = Plant(**data.model_dump())
    db.add(plant)
    await db.commit()
    await db.refresh(plant)
    return plant


@router.get("/{plant_id}", response_model=PlantOut)
async def get_plant(
    plant_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    plant = await db.get(Plant, plant_id)
    # Wrong-plant probes get the same 404 as a missing row — no existence leak.
    if not plant or not ctx.can_access(plant.id):
        raise HTTPException(404, "Plant not found")
    return plant


@router.patch("/{plant_id}", response_model=PlantOut)
async def update_plant(
    plant_id: UUID,
    data: PlantUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    plant = await db.get(Plant, plant_id)
    if not plant:
        raise HTTPException(404, "Plant not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(plant, k, v)
    await db.commit()
    await db.refresh(plant)
    return plant


@router.delete("/{plant_id}", status_code=204)
async def delete_plant(
    plant_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    plant = await db.get(Plant, plant_id)
    if not plant:
        raise HTTPException(404, "Plant not found")
    plant.active = False
    await db.commit()
