from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from uuid import UUID
from typing import Optional, List
from datetime import date
from pydantic import BaseModel

from app.db.session import get_db
from app.models.models import (
    Technician, User, UserPlant, TechnicianSpecialty, TechnicianShift, TechnicianUnavailability,
)
from app.schemas.technician import TechnicianCreate, TechnicianOut, TechnicianListResponse
from app.schemas.shift import UnavailabilityCreate, UnavailabilityOut, AvailabilityOut, BreakOut
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.services import technician_availability_service as avail_svc
from app.services import technician_break_service as break_svc


async def _availability_out(db: AsyncSession, tech: Technician) -> AvailabilityOut:
    a = await avail_svc.availability_at(db, tech)
    return AvailabilityOut(
        status=a.status, available=a.available, should_warn=a.should_warn,
        detail=a.detail, has_schedule=a.has_schedule,
        announced=a.announced, since=a.since,
    )


async def _my_technician(db: AsyncSession, current_user: User) -> Technician:
    """The active technician profile for the signed-in user, or 404."""
    result = await db.execute(
        select(Technician).where(Technician.user_id == current_user.id, Technician.active == True)  # noqa: E712
    )
    tech = result.scalar_one_or_none()
    if not tech:
        raise HTTPException(status_code=404, detail="no_technician_profile")
    return tech


async def _scoped_technician(technician_id: UUID, db: AsyncSession, ctx: PlantContext) -> Technician:
    """Load a technician visible to the caller: the tech's USER must hold a
    membership in a plant the caller can access (SJ+Mirabel share the team).
    404 — never 403 — otherwise, so a plant can't confirm a foreign technician id
    (protects the profile incl. hourly_rate and the unavailability sub-resource)."""
    t = await db.get(Technician, technician_id)
    if t is not None:
        member = (await db.execute(
            select(UserPlant.plant_id).where(UserPlant.user_id == t.user_id)
        )).scalars().all()
        if any(ctx.can_access(pid) for pid in member):
            return t
    raise HTTPException(status_code=404, detail="Technician not found")


class TechnicianUpdate(BaseModel):
    employee_number: Optional[str] = None
    specialty: Optional[TechnicianSpecialty] = None
    shift: Optional[TechnicianShift] = None
    hourly_rate: Optional[float] = None
    certifications: Optional[List[str]] = None

router = APIRouter()


@router.get("/", response_model=TechnicianListResponse)
async def list_technicians(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    # A technician "belongs" to the plants their USER holds membership in
    # (SJ+Mirabel share the maintenance team) — the roster shows only
    # technicians with access to the active plant.
    result = await db.execute(
        select(Technician)
        .join(UserPlant, UserPlant.user_id == Technician.user_id)
        .where(Technician.active == True, UserPlant.plant_id == ctx.plant_id)  # noqa: E712
    )
    technicians = result.scalars().all()

    items = []
    for t in technicians:
        out = TechnicianOut.model_validate(t)
        user = await db.get(User, t.user_id)
        if user:
            out.full_name = user.name
            out.email = user.email
        out.availability = await _availability_out(db, t)
        items.append(out)

    return TechnicianListResponse(total=len(items), items=items)


@router.get("/me", response_model=TechnicianOut)
async def get_my_technician_profile(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Technician).where(Technician.user_id == current_user.id, Technician.active == True)
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="No technician profile for current user")
    out = TechnicianOut.model_validate(t)
    out.full_name = current_user.name
    out.email = current_user.email
    out.availability = await _availability_out(db, t)
    return out


# ── Announced (live) break — technician self-service ─────────────────────────
# The signed-in technician taps "I'm on break" / "I'm back" from My Work. This is
# presence only: it drives the live availability status the roster/scheduler
# reads, and never affects labor cost, downtime, or MTTR.

@router.get("/me/break", response_model=Optional[BreakOut])
async def get_my_active_break(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tech = await _my_technician(db, current_user)
    ab = await break_svc.active_break(db, tech.id)
    return BreakOut.model_validate(ab) if ab else None


@router.post("/me/break", response_model=BreakOut, status_code=201)
async def start_my_break(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tech = await _my_technician(db, current_user)
    rec = await break_svc.start_break(db, tech.id)
    await db.commit()
    await db.refresh(rec)
    return BreakOut.model_validate(rec)


@router.post("/me/break/end", response_model=BreakOut)
async def end_my_break(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tech = await _my_technician(db, current_user)
    rec = await break_svc.end_break(db, tech.id)
    if rec is None:
        raise HTTPException(status_code=404, detail="not_on_break")
    await db.commit()
    await db.refresh(rec)
    return BreakOut.model_validate(rec)


# ── Technician unavailability (vacation / absence / …) ───────────────────────
# NOTE: the static "/unavailability" calendar route MUST be declared before the
# dynamic "/{technician_id}" route, else FastAPI captures "unavailability" as a
# technician id and 422s on UUID parsing.

@router.get("/unavailability", response_model=List[UnavailabilityOut])
async def list_all_unavailability(
    technician_id: Optional[UUID] = Query(default=None),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    """Calendar feed across technicians. Optional filters: technician + a date
    range (overlap). Enriched with technician_name for the calendar UI.
    Scoped to technicians on the active plant — never another plant's roster."""
    # Only unavailability of technicians whose user is a member of the active plant.
    visible_techs = (
        select(Technician.id)
        .join(UserPlant, UserPlant.user_id == Technician.user_id)
        .where(UserPlant.plant_id == ctx.plant_id)
    )
    conds = [TechnicianUnavailability.technician_id.in_(visible_techs)]
    if technician_id is not None:
        conds.append(TechnicianUnavailability.technician_id == technician_id)
    if date_to is not None:
        conds.append(TechnicianUnavailability.start_date <= date_to)
    if date_from is not None:
        conds.append(TechnicianUnavailability.end_date >= date_from)
    rows = (await db.execute(
        select(TechnicianUnavailability).where(*conds)
        .order_by(TechnicianUnavailability.start_date.desc())
    )).scalars().all()
    # Resolve technician display names in one pass.
    names: dict = {}
    out: List[UnavailabilityOut] = []
    for r in rows:
        item = UnavailabilityOut.model_validate(r)
        if r.technician_id not in names:
            tech = await db.get(Technician, r.technician_id)
            user = await db.get(User, tech.user_id) if tech else None
            names[r.technician_id] = user.name if user else None
        item.technician_name = names[r.technician_id]
        out.append(item)
    return out


@router.get("/{technician_id}/unavailability", response_model=List[UnavailabilityOut])
async def list_technician_unavailability(
    technician_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    await _scoped_technician(technician_id, db, ctx)      # 404 across the plant boundary
    rows = (await db.execute(
        select(TechnicianUnavailability)
        .where(TechnicianUnavailability.technician_id == technician_id)
        .order_by(TechnicianUnavailability.start_date.desc())
    )).scalars().all()
    return [UnavailabilityOut.model_validate(r) for r in rows]


@router.post("/{technician_id}/unavailability", response_model=UnavailabilityOut, status_code=201)
async def add_technician_unavailability(
    technician_id: UUID,
    data: UnavailabilityCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    await _scoped_technician(technician_id, db, ctx)      # 404 across the plant boundary
    if data.end_date < data.start_date:
        raise HTTPException(status_code=400, detail="end_date_before_start_date")
    rec = TechnicianUnavailability(
        technician_id=technician_id, type=data.type,
        start_date=data.start_date, end_date=data.end_date,
        notes=data.notes, created_by_id=current_user.id,
    )
    db.add(rec)
    await db.commit()
    await db.refresh(rec)
    return UnavailabilityOut.model_validate(rec)


@router.delete("/{technician_id}/unavailability/{unavailability_id}", status_code=204)
async def delete_technician_unavailability(
    technician_id: UUID,
    unavailability_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    await _scoped_technician(technician_id, db, ctx)      # 404 across the plant boundary
    rec = await db.get(TechnicianUnavailability, unavailability_id)
    if not rec or rec.technician_id != technician_id:
        raise HTTPException(status_code=404, detail="Unavailability not found")
    await db.delete(rec)
    await db.commit()


@router.get("/{technician_id}", response_model=TechnicianOut)
async def get_technician(
    technician_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    t = await _scoped_technician(technician_id, db, ctx)
    out = TechnicianOut.model_validate(t)
    user = await db.get(User, t.user_id)
    if user:
        out.full_name = user.name
        out.email = user.email
    out.availability = await _availability_out(db, t)
    return out


@router.post("/", response_model=TechnicianOut, status_code=201)
async def create_technician(
    data: TechnicianCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    user = await db.get(User, data.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # Never promote a user who belongs only to other plants into this plant's roster.
    member = (await db.execute(
        select(UserPlant.plant_id).where(UserPlant.user_id == data.user_id)
    )).scalars().all()
    if member and not any(ctx.can_access(pid) for pid in member):
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


@router.patch("/{technician_id}", response_model=TechnicianOut)
async def update_technician(
    technician_id: UUID,
    data: TechnicianUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    t = await _scoped_technician(technician_id, db, ctx)
    if not t.active:
        raise HTTPException(status_code=404, detail="Technician not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(t, field, value)
    await db.commit()
    await db.refresh(t)
    out = TechnicianOut.model_validate(t)
    user = await db.get(User, t.user_id)
    if user:
        out.full_name = user.name
        out.email = user.email
    return out


@router.delete("/{technician_id}", status_code=204)
async def delete_technician(
    technician_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    t = await _scoped_technician(technician_id, db, ctx)
    t.active = False
    await db.commit()
