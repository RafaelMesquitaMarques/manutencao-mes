from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import Optional
from uuid import UUID
import qrcode
import io, base64

from app.db.session import get_db
from app.models.models import User, Equipment, EquipmentStatus
from app.schemas.equipment import EquipmentCreate, EquipmentUpdate, EquipmentOut, EquipmentListResponse
from app.core.security import get_current_user

router = APIRouter()


@router.get("/", response_model=EquipmentListResponse)
async def list_equipment(
    plant_id: Optional[UUID] = None,
    status: Optional[EquipmentStatus] = None,
    criticality: Optional[str] = None,
    search: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = select(Equipment).where(Equipment.active == True)

    if plant_id:
        query = query.where(Equipment.plant_id == plant_id)
    if status:
        query = query.where(Equipment.status == status)
    if criticality:
        query = query.where(Equipment.criticality == criticality)
    if search:
        query = query.where(
            Equipment.name.ilike(f"%{search}%") |
            Equipment.code.ilike(f"%{search}%") |
            Equipment.location.ilike(f"%{search}%")
        )

    total_result = await db.execute(select(func.count()).select_from(query.subquery()))
    total = total_result.scalar()

    query = query.offset(skip).limit(limit).order_by(Equipment.name)
    result = await db.execute(query)
    items = result.scalars().all()

    return EquipmentListResponse(total=total, items=items)


@router.get("/{equipment_id}", response_model=EquipmentOut)
async def get_equipment(
    equipment_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Equipment).where(Equipment.id == equipment_id))
    equip = result.scalar_one_or_none()
    if not equip:
        raise HTTPException(status_code=404, detail="Equipment not found")
    return equip


@router.post("/", response_model=EquipmentOut, status_code=201)
async def create_equipment(
    data: EquipmentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    equip = Equipment(**data.model_dump())

    # Auto-generate QR Code
    qr = qrcode.make(f"equip:{equip.id}")
    buf = io.BytesIO()
    qr.save(buf, format="PNG")
    equip.qr_code = base64.b64encode(buf.getvalue()).decode()

    db.add(equip)
    await db.commit()
    await db.refresh(equip)
    return equip


@router.patch("/{equipment_id}", response_model=EquipmentOut)
async def update_equipment(
    equipment_id: UUID,
    data: EquipmentUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Equipment).where(Equipment.id == equipment_id))
    equip = result.scalar_one_or_none()
    if not equip:
        raise HTTPException(status_code=404, detail="Equipment not found")

    for field, value in data.model_dump(exclude_none=True).items():
        setattr(equip, field, value)

    await db.commit()
    await db.refresh(equip)
    return equip


@router.delete("/{equipment_id}", status_code=204)
async def delete_equipment(
    equipment_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Equipment).where(Equipment.id == equipment_id))
    equip = result.scalar_one_or_none()
    if not equip:
        raise HTTPException(status_code=404, detail="Equipment not found")
    equip.active = False  # soft delete
    await db.commit()


@router.patch("/{equipment_id}/hour-meter")
async def update_hour_meter(
    equipment_id: UUID,
    hours: float,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update equipment hour meter (accumulated hours)."""
    result = await db.execute(select(Equipment).where(Equipment.id == equipment_id))
    equip = result.scalar_one_or_none()
    if not equip:
        raise HTTPException(status_code=404, detail="Equipment not found")
    equip.hour_meter = hours
    await db.commit()
    return {"hour_meter": equip.hour_meter}
