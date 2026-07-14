from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.models import Department
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_scoped
from app.core.permissions import resource_guard

# Reads pass with auth (the machine/OF pickers need the list); writes require
# settings_departments create/update/delete.
router = APIRouter(dependencies=[Depends(resource_guard("settings_departments"))])


class DepartmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    is_active: bool
    sort_order: int


class DepartmentCreate(BaseModel):
    name: str
    sort_order: int = 0


class DepartmentUpdate(BaseModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None


@router.get("/", response_model=List[DepartmentOut])
async def list_departments(
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    q = plant_scoped(select(Department), Department, ctx).order_by(
        Department.sort_order, Department.name)
    if not include_inactive:
        q = q.where(Department.is_active.is_(True))
    r = await db.execute(q)
    return r.scalars().all()


@router.post("/", response_model=DepartmentOut, status_code=201)
async def create_department(
    data: DepartmentCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(400, "Department name required")
    existing = await db.execute(
        select(Department).where(Department.plant_id == ctx.plant_id, Department.name == name)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, f"Department '{name}' already exists")
    d = Department(plant_id=ctx.plant_id, name=name, sort_order=data.sort_order)
    db.add(d)
    await db.commit()
    await db.refresh(d)
    return d


@router.patch("/{dep_id}", response_model=DepartmentOut)
async def update_department(
    dep_id: UUID,
    data: DepartmentUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    d = await db.get(Department, dep_id)
    if not d:
        raise HTTPException(404, "Department not found")
    ensure_same_plant(d, ctx, detail="Department not found")
    payload = data.model_dump(exclude_none=True)
    if "name" in payload:
        payload["name"] = payload["name"].strip()
        if not payload["name"]:
            raise HTTPException(400, "Department name required")
        dup = await db.execute(select(Department).where(
            Department.plant_id == d.plant_id, Department.name == payload["name"],
            Department.id != d.id))
        if dup.scalar_one_or_none():
            raise HTTPException(400, f"Department '{payload['name']}' already exists")
    for k, v in payload.items():
        setattr(d, k, v)
    await db.commit()
    await db.refresh(d)
    return d


@router.delete("/{dep_id}", status_code=204)
async def delete_department(
    dep_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    d = await db.get(Department, dep_id)
    if not d:
        raise HTTPException(404, "Department not found")
    ensure_same_plant(d, ctx, detail="Department not found")
    await db.delete(d)
    await db.commit()
