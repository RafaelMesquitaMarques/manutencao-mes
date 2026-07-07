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
from app.services.equipment_machine_sync import ensure_machine_for_equipment
from app.services.live_status import live_status_by_equipment

router = APIRouter()


@router.get("/", response_model=EquipmentListResponse)
async def list_equipment(
    plant_id: Optional[UUID] = None,
    status: Optional[EquipmentStatus] = None,
    criticality: Optional[str] = None,
    asset_type: Optional[str] = None,
    department: Optional[str] = None,
    family: Optional[str] = None,
    search: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, le=2000),   # selectors (parent machine, PM clone targets) pull the whole catalog
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = select(Equipment).where(Equipment.active == True)

    if plant_id:
        query = query.where(Equipment.plant_id == plant_id)
    if asset_type:
        query = query.where(Equipment.asset_type == asset_type)
    if status:
        query = query.where(Equipment.status == status)
    if criticality:
        query = query.where(Equipment.criticality == criticality)
    if department:
        query = query.where(Equipment.department == department)
    if family:
        query = query.where(Equipment.family == family)
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

    # Effective live status (kiosk machine / open ticket / parent machine) —
    # the static `status` column alone would show everything as "running".
    live = await live_status_by_equipment(db, items)
    for e in items:
        e.live_status = live.get(str(e.id))

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
    db.add(equip)
    await db.flush()  # assign equip.id before generating the QR / kiosk

    # Auto-generate QR Code
    qr = qrcode.make(f"equip:{equip.id}")
    buf = io.BytesIO()
    qr.save(buf, format="PNG")
    equip.qr_code = base64.b64encode(buf.getvalue()).decode()

    # Production equipment automatically gets its kiosk/Machine
    await ensure_machine_for_equipment(db, equip)

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

    # keep the kiosk/Machine in sync with the (possibly changed) classification
    await ensure_machine_for_equipment(db, equip)

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
    await ensure_machine_for_equipment(db, equip)  # deactivate its kiosk too
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
