from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.db.session import get_db
from app.models.models import JobOrder, JobOrderRun, Machine, User
from app.schemas.maintenance import (
    JobOrderOut, JobOrderCreate, JobOrderUpdate, JobOrderRunOut,
    JobOrderCostOut, JobOrderCostReportOut,
)
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_scoped
from app.services.job_order_cost_service import (
    compute_job_order_cost, compute_cost_report, day_bounds,
)

router = APIRouter()


async def _machine_plant(db: AsyncSession, machine_id):
    if not machine_id:
        return None
    m = await db.get(Machine, machine_id)
    return m.plant_id if m else None


@router.get("/", response_model=List[JobOrderOut])
async def list_job_orders(
    machine_id: Optional[UUID] = None,
    job_number: Optional[str] = None,
    status: Optional[str] = None,
    department: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    q = plant_scoped(select(JobOrder), JobOrder, ctx).order_by(JobOrder.created_at.desc())
    if machine_id:
        q = q.where(JobOrder.machine_id == machine_id)
    if job_number:
        q = q.where(JobOrder.job_number.ilike(f"%{job_number}%"))
    if status:
        q = q.where(JobOrder.status == status)
    if department:
        q = q.where(JobOrder.department == department)
    r = await db.execute(q)
    return r.scalars().all()


@router.get("/lookup", response_model=Optional[JobOrderOut])
async def lookup_job_order(
    job_number: str,
    machine_id: Optional[UUID] = None,
    db: AsyncSession = Depends(get_db),
):
    """Kiosk: look up a job order by exact job number (no auth). OF numbers are
    unique per plant, so pass `machine_id` to disambiguate to that machine's plant;
    without it the first match is returned (best-effort)."""
    q = select(JobOrder).where(JobOrder.job_number == job_number)
    if machine_id is not None:
        q = q.where(JobOrder.plant_id == await _machine_plant(db, machine_id))
    r = await db.execute(q.order_by(JobOrder.created_at.desc()))
    return r.scalars().first()


@router.get("/cost-report", response_model=JobOrderCostReportOut)
async def job_order_cost_report(
    status: Optional[str] = None,
    department: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Cost per OF (productive time × hourly rate; stop/downtime excluded) plus the
    factory total, for the active plant. An optional date range restricts which runs
    are summed (OFs with no runs in the window are dropped). Declared before
    `/{job_id}` so the static path isn't captured as an id."""
    q = plant_scoped(select(JobOrder), JobOrder, ctx)
    if status:
        q = q.where(JobOrder.status == status)
    if department:
        q = q.where(JobOrder.department == department)
    df, dt_ = day_bounds(date_from, date_to)
    return await compute_cost_report(db, q, df, dt_)


@router.post("/", response_model=JobOrderOut, status_code=201)
async def create_job_order(
    data: JobOrderCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    # OF numbers are unique per plant — check for a collision only within the plant
    # the OF will be born into (machine's plant, else the active plant).
    target_plant = await _machine_plant(db, data.machine_id) or ctx.plant_id
    existing = await db.execute(
        select(JobOrder).where(
            JobOrder.job_number == data.job_number,
            JobOrder.plant_id == target_plant,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, f"Job number '{data.job_number}' already exists")
    jo = JobOrder(**data.model_dump())
    jo.plant_id = target_plant
    db.add(jo)
    await db.commit()
    await db.refresh(jo)
    return jo


@router.post("/kiosk", response_model=JobOrderOut, status_code=201)
async def create_job_order_kiosk(
    data: JobOrderCreate,
    db: AsyncSession = Depends(get_db),
):
    """Kiosk: create or return existing job order (no auth), scoped to the machine's plant."""
    target_plant = await _machine_plant(db, data.machine_id)
    r = await db.execute(
        select(JobOrder).where(
            JobOrder.job_number == data.job_number,
            JobOrder.plant_id == target_plant,
        )
    )
    existing = r.scalar_one_or_none()
    if existing:
        return existing
    jo = JobOrder(**data.model_dump())
    jo.plant_id = target_plant
    db.add(jo)
    await db.commit()
    await db.refresh(jo)
    return jo


@router.get("/{job_id}", response_model=JobOrderOut)
async def get_job_order(
    job_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    jo = await db.get(JobOrder, job_id)
    if not jo:
        raise HTTPException(404, "Job order not found")
    if jo.plant_id is not None:
        ensure_same_plant(jo, ctx, detail="Job order not found")
    return jo


@router.get("/{job_id}/runs", response_model=List[JobOrderRunOut])
async def list_job_order_runs(
    job_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """The OF's passages through machines (its timeline): time + attributed pieces
    per machine. Basis for time/cost per OF and for WIP location."""
    jo = await db.get(JobOrder, job_id)
    if not jo:
        raise HTTPException(404, "Job order not found")
    if jo.plant_id is not None:
        ensure_same_plant(jo, ctx, detail="Job order not found")
    r = await db.execute(
        select(JobOrderRun).where(JobOrderRun.job_order_id == job_id)
        .order_by(JobOrderRun.started_at)
    )
    return r.scalars().all()


@router.get("/{job_id}/cost", response_model=JobOrderCostOut)
async def job_order_cost(
    job_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Detailed cost breakdown for one OF: per-run productive time × rate (stops
    excluded), aggregated by machine and by department, with totals."""
    jo = await db.get(JobOrder, job_id)
    if not jo:
        raise HTTPException(404, "Job order not found")
    if jo.plant_id is not None:
        ensure_same_plant(jo, ctx, detail="Job order not found")
    return await compute_job_order_cost(db, jo)


@router.patch("/{job_id}", response_model=JobOrderOut)
async def update_job_order(
    job_id: UUID,
    data: JobOrderUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    jo = await db.get(JobOrder, job_id)
    if not jo:
        raise HTTPException(404, "Job order not found")
    if jo.plant_id is not None:
        ensure_same_plant(jo, ctx, detail="Job order not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(jo, k, v)
    await db.commit()
    await db.refresh(jo)
    return jo
