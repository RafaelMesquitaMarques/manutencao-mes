from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime

from app.db.session import get_db
from app.models.models import Plant, User
from app.core.security import get_current_user

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
    r = await db.execute(select(Plant).where(Plant.active == True).order_by(Plant.name))
    return r.scalars().all()


@router.post("/", response_model=PlantOut, status_code=201)
async def create_plant(
    data: PlantCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
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
    current_user: User = Depends(get_current_user),
):
    plant = await db.get(Plant, plant_id)
    if not plant:
        raise HTTPException(404, "Plant not found")
    return plant


@router.patch("/{plant_id}", response_model=PlantOut)
async def update_plant(
    plant_id: UUID,
    data: PlantUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
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
    current_user: User = Depends(get_current_user),
):
    plant = await db.get(Plant, plant_id)
    if not plant:
        raise HTTPException(404, "Plant not found")
    plant.active = False
    await db.commit()
