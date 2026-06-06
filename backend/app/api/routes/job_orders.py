from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.db.session import get_db
from app.models.models import JobOrder, User
from app.schemas.maintenance import JobOrderOut, JobOrderCreate, JobOrderUpdate
from app.core.security import get_current_user

router = APIRouter()


@router.get("/", response_model=List[JobOrderOut])
async def list_job_orders(
    machine_id: Optional[UUID] = None,
    job_number: Optional[str] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(JobOrder).order_by(JobOrder.created_at.desc())
    if machine_id:
        q = q.where(JobOrder.machine_id == machine_id)
    if job_number:
        q = q.where(JobOrder.job_number.ilike(f"%{job_number}%"))
    if status:
        q = q.where(JobOrder.status == status)
    r = await db.execute(q)
    return r.scalars().all()


@router.get("/lookup", response_model=Optional[JobOrderOut])
async def lookup_job_order(
    job_number: str,
    db: AsyncSession = Depends(get_db),
):
    """Kiosk: look up a job order by exact job number (no auth)."""
    r = await db.execute(select(JobOrder).where(JobOrder.job_number == job_number))
    return r.scalar_one_or_none()


@router.post("/", response_model=JobOrderOut, status_code=201)
async def create_job_order(
    data: JobOrderCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    existing = await db.execute(select(JobOrder).where(JobOrder.job_number == data.job_number))
    if existing.scalar_one_or_none():
        raise HTTPException(400, f"Job number '{data.job_number}' already exists")
    jo = JobOrder(**data.model_dump())
    db.add(jo)
    await db.commit()
    await db.refresh(jo)
    return jo


@router.post("/kiosk", response_model=JobOrderOut, status_code=201)
async def create_job_order_kiosk(
    data: JobOrderCreate,
    db: AsyncSession = Depends(get_db),
):
    """Kiosk: create or return existing job order (no auth)."""
    r = await db.execute(select(JobOrder).where(JobOrder.job_number == data.job_number))
    existing = r.scalar_one_or_none()
    if existing:
        return existing
    jo = JobOrder(**data.model_dump())
    db.add(jo)
    await db.commit()
    await db.refresh(jo)
    return jo


@router.patch("/{job_id}", response_model=JobOrderOut)
async def update_job_order(
    job_id: UUID,
    data: JobOrderUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    jo = await db.get(JobOrder, job_id)
    if not jo:
        raise HTTPException(404, "Job order not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(jo, k, v)
    await db.commit()
    await db.refresh(jo)
    return jo
