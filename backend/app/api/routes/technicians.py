from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from uuid import UUID

from app.db.session import get_db
from app.models.models import Technician, User
from app.schemas.technician import TechnicianCreate, TechnicianOut, TechnicianListResponse
from app.core.security import get_current_user

router = APIRouter()


@router.get("/", response_model=TechnicianListResponse)
async def list_technicians(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Technician).where(Technician.active == True))
    technicians = result.scalars().all()

    items = []
    for t in technicians:
        out = TechnicianOut.model_validate(t)
        user = await db.get(User, t.user_id)
        if user:
            out.full_name = user.name
            out.email = user.email
        items.append(out)

    return TechnicianListResponse(total=len(items), items=items)


@router.get("/{technician_id}", response_model=TechnicianOut)
async def get_technician(
    technician_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    t = await db.get(Technician, technician_id)
    if not t:
        raise HTTPException(status_code=404, detail="Technician not found")
    out = TechnicianOut.model_validate(t)
    user = await db.get(User, t.user_id)
    if user:
        out.full_name = user.name
        out.email = user.email
    return out


@router.post("/", response_model=TechnicianOut, status_code=201)
async def create_technician(
    data: TechnicianCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    user = await db.get(User, data.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    existing = await db.execute(select(Technician).where(Technician.user_id == data.user_id))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Technician profile already exists for this user")

    t = Technician(
        user_id=data.user_id,
        employee_number=data.employee_number,
        specialty=data.specialty,
        shift=data.shift,
        hourly_rate=data.hourly_rate,
        certifications=data.certifications or [],
    )
    db.add(t)
    await db.commit()
    await db.refresh(t)

    out = TechnicianOut.model_validate(t)
    out.full_name = user.name
    out.email = user.email
    return out
