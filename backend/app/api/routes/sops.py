"""
backend/app/api/routes/sops.py

SOP library (Standard Operating Procedures) + step-by-step executions.

Three routers, registered separately in main.py:
- router            /api/sops            — library CRUD (resource_guard("sops"):
                                           writes need sops:create/update/delete)
- execution_router  /api/sop-executions  — authenticated runs (any logged-in user
                                           may follow a SOP; no write permission)
- kiosk_router      /api/machines/{ref}/… — kiosk runs (same no-JWT trust level as
                                           the machine page; kiosk_ref_guard)
"""
from datetime import datetime, timedelta, timezone
from typing import Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, or_, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.session import get_db
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_condition
from app.models.models import (
    Equipment, Machine, Sop, SopCategory, SopEquipmentLink, SopExecution,
    SopExecutionStep, SopStatus, SopStep, SopStepMedia, User,
)
from app.schemas.sop import (
    SopCreate, SopUpdate, SopOut, SopListResponse, SopEquipmentOut,
    SopStepCreate, SopStepUpdate, SopStepOut, SopStepsReorder,
    SopStepMediaCreate, SopStepMediaOut,
    SopExecutionStart, KioskExecutionStart, SopExecutionStepSet,
    SopExecutionComplete, SopExecutionOut, SopExecutionStepOut,
    SopExecutionListResponse,
)
from app.services.numbering import next_number, series_prefix
from app.api.routes.machines import _get_machine

router = APIRouter(prefix="/api/sops", tags=["SOPs"])
execution_router = APIRouter(prefix="/api/sop-executions", tags=["SOP Executions"])
kiosk_router = APIRouter(prefix="/api/machines", tags=["SOPs (kiosk)"])


# ─── Serialization helpers ──────────────────────────────────────────────────────

async def _load_steps(db: AsyncSession, sop_id: UUID) -> List[SopStep]:
    return (await db.execute(
        select(SopStep)
        .where(SopStep.sop_id == sop_id)
        .order_by(SopStep.sort_order)
        .options(selectinload(SopStep.media))
    )).scalars().all()


async def _sop_out(db: AsyncSession, sop: Sop, *, include_steps: bool = True) -> SopOut:
    links = (await db.execute(
        select(SopEquipmentLink.equipment_id, Equipment.name, Equipment.code)
        .join(Equipment, Equipment.id == SopEquipmentLink.equipment_id)
        .where(SopEquipmentLink.sop_id == sop.id)
        .order_by(Equipment.name)
    )).all()
    equipment = [
        SopEquipmentOut(equipment_id=eq_id, equipment_name=name, equipment_code=code)
        for eq_id, name, code in links
    ]

    if include_steps:
        steps = await _load_steps(db, sop.id)
        step_out = [SopStepOut.model_validate(s) for s in steps]
        step_count = len(steps)
    else:
        step_out = []
        step_count = (await db.execute(
            select(func.count(SopStep.id)).where(SopStep.sop_id == sop.id)
        )).scalar() or 0

    created_by_name = None
    if sop.created_by_id:
        author = await db.get(User, sop.created_by_id)
        created_by_name = author.name if author else None

    return SopOut(
        id=sop.id,
        plant_id=sop.plant_id,
        sop_number=sop.sop_number,
        title=sop.title,
        category=sop.category,
        description=sop.description,
        status=sop.status,
        version=sop.version,
        estimated_minutes=sop.estimated_minutes,
        created_by_name=created_by_name,
        published_at=sop.published_at,
        created_at=sop.created_at,
        updated_at=sop.updated_at,
        step_count=step_count,
        equipment=equipment,
        steps=step_out,
    )


async def _get_sop_visible(sop_id: UUID, db: AsyncSession, ctx: PlantContext) -> Sop:
    return ensure_same_plant(await db.get(Sop, sop_id), ctx, detail="SOP not found")


async def _replace_equipment_links(db: AsyncSession, sop: Sop, equipment_ids: List[UUID], ctx: PlantContext) -> None:
    """Full replacement of the SOP↔equipment links (validated against the plant)."""
    existing = (await db.execute(
        select(SopEquipmentLink).where(SopEquipmentLink.sop_id == sop.id)
    )).scalars().all()
    wanted = set(equipment_ids)
    for link in existing:
        if link.equipment_id not in wanted:
            await db.delete(link)
    current = {l.equipment_id for l in existing}
    for eq_id in wanted - current:
        ensure_same_plant(await db.get(Equipment, eq_id), ctx, detail="Equipment not found")
        db.add(SopEquipmentLink(sop_id=sop.id, equipment_id=eq_id))


# ─── Library CRUD ───────────────────────────────────────────────────────────────

@router.get("/", response_model=SopListResponse)
async def list_sops(
    category: Optional[SopCategory] = None,
    status: Optional[SopStatus] = None,
    equipment_id: Optional[UUID] = None,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    query = select(Sop).where(plant_condition(Sop, ctx))
    if category:
        query = query.where(Sop.category == category)
    if status:
        query = query.where(Sop.status == status)
    else:
        query = query.where(Sop.status != SopStatus.archived)
    if equipment_id:
        query = query.join(SopEquipmentLink, SopEquipmentLink.sop_id == Sop.id).where(
            SopEquipmentLink.equipment_id == equipment_id
        )
    if search:
        like = f"%{search.strip()}%"
        query = query.where(or_(
            Sop.title.ilike(like), Sop.sop_number.ilike(like), Sop.description.ilike(like),
        ))
    query = query.order_by(Sop.updated_at.desc())

    sops = (await db.execute(query)).scalars().unique().all()
    items = [await _sop_out(db, s, include_steps=False) for s in sops]
    return SopListResponse(total=len(items), items=items)


@router.post("/", response_model=SopOut, status_code=201)
async def create_sop(
    data: SopCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
):
    prefix = f"{await series_prefix(db, ctx.plant_id)}SOP-{datetime.now().year}"
    sop = Sop(
        plant_id=ctx.plant_id,
        sop_number=await next_number(db, Sop.sop_number, prefix),
        title=data.title.strip(),
        category=data.category,
        description=data.description,
        estimated_minutes=data.estimated_minutes,
        created_by_id=current_user.id,
    )
    db.add(sop)
    await db.flush()

    for i, step in enumerate(data.steps):
        db.add(SopStep(
            sop_id=sop.id,
            title=step.title,
            instruction=step.instruction,
            expected_result=step.expected_result,
            warning=step.warning,
            sort_order=step.sort_order or i,
            is_required=step.is_required,
        ))
    await _replace_equipment_links(db, sop, data.equipment_ids, ctx)

    await db.commit()
    await db.refresh(sop)
    return await _sop_out(db, sop)


@router.get("/{sop_id}", response_model=SopOut)
async def get_sop(
    sop_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    sop = await _get_sop_visible(sop_id, db, ctx)
    return await _sop_out(db, sop)


@router.patch("/{sop_id}", response_model=SopOut)
async def update_sop(
    sop_id: UUID,
    data: SopUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    sop = await _get_sop_visible(sop_id, db, ctx)
    fields = data.model_dump(exclude_unset=True)
    equipment_ids = fields.pop("equipment_ids", None)
    for field, value in fields.items():
        setattr(sop, field, value)
    if equipment_ids is not None:
        await _replace_equipment_links(db, sop, equipment_ids, ctx)
    await db.commit()
    await db.refresh(sop)
    return await _sop_out(db, sop)


@router.post("/{sop_id}/publish", response_model=SopOut)
async def publish_sop(
    sop_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Publish (or re-publish after edits — bumps the version)."""
    sop = await _get_sop_visible(sop_id, db, ctx)
    step_count = (await db.execute(
        select(func.count(SopStep.id)).where(SopStep.sop_id == sop.id)
    )).scalar() or 0
    if step_count == 0:
        raise HTTPException(status_code=400, detail="errors.sopNoSteps")
    if sop.status == SopStatus.published:
        sop.version += 1
    sop.status = SopStatus.published
    sop.published_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(sop)
    return await _sop_out(db, sop)


@router.post("/{sop_id}/archive", response_model=SopOut)
async def archive_sop(
    sop_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    sop = await _get_sop_visible(sop_id, db, ctx)
    sop.status = SopStatus.archived
    await db.commit()
    await db.refresh(sop)
    return await _sop_out(db, sop)


@router.post("/{sop_id}/restore", response_model=SopOut)
async def restore_sop(
    sop_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Archived → back to draft (review before it goes live again)."""
    sop = await _get_sop_visible(sop_id, db, ctx)
    sop.status = SopStatus.draft
    await db.commit()
    await db.refresh(sop)
    return await _sop_out(db, sop)


@router.post("/{sop_id}/duplicate", response_model=SopOut, status_code=201)
async def duplicate_sop(
    sop_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
):
    src = await _get_sop_visible(sop_id, db, ctx)
    steps = await _load_steps(db, src.id)
    links = (await db.execute(
        select(SopEquipmentLink).where(SopEquipmentLink.sop_id == src.id)
    )).scalars().all()

    prefix = f"{await series_prefix(db, ctx.plant_id)}SOP-{datetime.now().year}"
    copy = Sop(
        plant_id=src.plant_id,
        sop_number=await next_number(db, Sop.sop_number, prefix),
        title=f"{src.title} (copy)",
        category=src.category,
        description=src.description,
        estimated_minutes=src.estimated_minutes,
        created_by_id=current_user.id,
        status=SopStatus.draft,
    )
    db.add(copy)
    await db.flush()
    for step in steps:
        ns = SopStep(
            sop_id=copy.id,
            title=step.title,
            instruction=step.instruction,
            expected_result=step.expected_result,
            warning=step.warning,
            sort_order=step.sort_order,
            is_required=step.is_required,
        )
        db.add(ns)
        await db.flush()
        for m in step.media:
            db.add(SopStepMedia(
                step_id=ns.id, media_type=m.media_type, url=m.url,
                caption=m.caption, sort_order=m.sort_order,
            ))
    for link in links:
        db.add(SopEquipmentLink(sop_id=copy.id, equipment_id=link.equipment_id))

    await db.commit()
    await db.refresh(copy)
    return await _sop_out(db, copy)


@router.delete("/{sop_id}", status_code=200)
async def delete_sop(
    sop_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Drafts are hard-deleted; anything ever published is archived (history)."""
    sop = await _get_sop_visible(sop_id, db, ctx)
    if sop.status == SopStatus.draft and sop.published_at is None:
        await db.delete(sop)
    else:
        sop.status = SopStatus.archived
    await db.commit()
    return {"status": "deleted"}


# ─── Steps ──────────────────────────────────────────────────────────────────────

@router.post("/{sop_id}/steps", response_model=SopStepOut, status_code=201)
async def add_step(
    sop_id: UUID,
    data: SopStepCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    sop = await _get_sop_visible(sop_id, db, ctx)
    if data.sort_order == 0:
        last = (await db.execute(
            select(func.max(SopStep.sort_order)).where(SopStep.sop_id == sop.id)
        )).scalar()
        data.sort_order = (last + 1) if last is not None else 0
    step = SopStep(
        sop_id=sop.id,
        title=data.title,
        instruction=data.instruction,
        expected_result=data.expected_result,
        warning=data.warning,
        sort_order=data.sort_order,
        is_required=data.is_required,
    )
    db.add(step)
    await db.commit()
    step = (await db.execute(
        select(SopStep).where(SopStep.id == step.id).options(selectinload(SopStep.media))
    )).scalar_one()
    return SopStepOut.model_validate(step)


@router.patch("/{sop_id}/steps/{step_id}", response_model=SopStepOut)
async def update_step(
    sop_id: UUID,
    step_id: UUID,
    data: SopStepUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_sop_visible(sop_id, db, ctx)
    step = await db.get(SopStep, step_id)
    if not step or step.sop_id != sop_id:
        raise HTTPException(status_code=404, detail="SOP step not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(step, field, value)
    await db.commit()
    step = (await db.execute(
        select(SopStep).where(SopStep.id == step_id).options(selectinload(SopStep.media))
    )).scalar_one()
    return SopStepOut.model_validate(step)


@router.post("/{sop_id}/steps/reorder", status_code=200)
async def reorder_steps(
    sop_id: UUID,
    data: SopStepsReorder,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_sop_visible(sop_id, db, ctx)
    steps = {s.id: s for s in (await db.execute(
        select(SopStep).where(SopStep.sop_id == sop_id)
    )).scalars().all()}
    for i, sid in enumerate(data.step_ids):
        if sid in steps:
            steps[sid].sort_order = i
    await db.commit()
    return {"status": "ok"}


@router.delete("/{sop_id}/steps/{step_id}", status_code=200)
async def delete_step(
    sop_id: UUID,
    step_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_sop_visible(sop_id, db, ctx)
    step = await db.get(SopStep, step_id)
    if not step or step.sop_id != sop_id:
        raise HTTPException(status_code=404, detail="SOP step not found")
    await db.delete(step)
    await db.commit()
    return {"status": "deleted"}


# ─── Step media ─────────────────────────────────────────────────────────────────

@router.post("/{sop_id}/steps/{step_id}/media", response_model=SopStepMediaOut, status_code=201)
async def add_step_media(
    sop_id: UUID,
    step_id: UUID,
    data: SopStepMediaCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_sop_visible(sop_id, db, ctx)
    step = await db.get(SopStep, step_id)
    if not step or step.sop_id != sop_id:
        raise HTTPException(status_code=404, detail="SOP step not found")
    if data.media_type not in ("image", "video", "link"):
        raise HTTPException(status_code=400, detail="media_type must be image, video or link")
    media = SopStepMedia(
        step_id=step_id,
        media_type=data.media_type,
        url=data.url,
        caption=data.caption,
        sort_order=data.sort_order,
    )
    db.add(media)
    await db.commit()
    await db.refresh(media)
    return SopStepMediaOut.model_validate(media)


@router.delete("/{sop_id}/steps/{step_id}/media/{media_id}", status_code=200)
async def delete_step_media(
    sop_id: UUID,
    step_id: UUID,
    media_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_sop_visible(sop_id, db, ctx)
    media = await db.get(SopStepMedia, media_id)
    if not media or media.step_id != step_id:
        raise HTTPException(status_code=404, detail="Media not found")
    await db.delete(media)
    await db.commit()
    return {"status": "deleted"}


# ─── Execution history (library side) ───────────────────────────────────────────

@router.get("/{sop_id}/executions", response_model=SopExecutionListResponse)
async def list_sop_executions(
    sop_id: UUID,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_sop_visible(sop_id, db, ctx)
    rows = (await db.execute(
        select(SopExecution)
        .where(SopExecution.sop_id == sop_id)
        .order_by(SopExecution.started_at.desc())
        .limit(max(1, min(limit, 200)))
        .options(selectinload(SopExecution.steps))
    )).scalars().all()
    items = [await _exec_out(db, e) for e in rows]
    return SopExecutionListResponse(total=len(items), items=items)


# ─── Execution engine (shared by app + kiosk) ───────────────────────────────────

async def _exec_out(db: AsyncSession, execution: SopExecution) -> SopExecutionOut:
    machine_name = None
    if execution.machine_id:
        machine = await db.get(Machine, execution.machine_id)
        machine_name = machine.name if machine else None
    operator = execution.operator_name
    if not operator and execution.user_id:
        user = await db.get(User, execution.user_id)
        operator = user.name if user else None
    return SopExecutionOut(
        id=execution.id,
        sop_id=execution.sop_id,
        equipment_id=execution.equipment_id,
        machine_id=execution.machine_id,
        machine_name=machine_name,
        user_id=execution.user_id,
        operator_name=operator,
        sop_version=execution.sop_version,
        source=execution.source,
        status=execution.status,
        started_at=execution.started_at,
        completed_at=execution.completed_at,
        duration_seconds=execution.duration_seconds,
        notes=execution.notes,
        steps=[SopExecutionStepOut.model_validate(s) for s in execution.steps],
    )


async def _reload_exec(db: AsyncSession, execution_id: UUID) -> SopExecution:
    execution = (await db.execute(
        select(SopExecution)
        .where(SopExecution.id == execution_id)
        .options(selectinload(SopExecution.steps))
        # The execution is usually already in this session's identity map (loaded
        # before the write); without populate_existing the cached `steps`
        # collection is NOT refreshed and the response is one tick stale.
        .execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if not execution:
        raise HTTPException(status_code=404, detail="Execution not found")
    return execution


async def _start_execution(
    db: AsyncSession, sop: Sop, *,
    equipment_id=None, machine=None, user=None, operator_name=None, source="app",
) -> SopExecution:
    execution = SopExecution(
        sop_id=sop.id,
        plant_id=sop.plant_id,
        equipment_id=equipment_id,
        machine_id=machine.id if machine is not None else None,
        user_id=user.id if user is not None else None,
        operator_name=operator_name,
        sop_version=sop.version,
        source=source,
    )
    db.add(execution)
    await db.commit()
    return await _reload_exec(db, execution.id)


async def _set_execution_step(db: AsyncSession, execution: SopExecution, step_id: UUID, checked: bool) -> SopExecution:
    if execution.status != "in_progress":
        raise HTTPException(status_code=400, detail="errors.sopExecutionClosed")
    step = await db.get(SopStep, step_id)
    if not step or step.sop_id != execution.sop_id:
        raise HTTPException(status_code=404, detail="SOP step not found")
    existing = next((s for s in execution.steps if s.step_id == step_id), None)
    if existing:
        existing.checked = checked
        existing.checked_at = datetime.now(timezone.utc) if checked else None
    else:
        db.add(SopExecutionStep(
            execution_id=execution.id, step_id=step_id, checked=checked,
            checked_at=datetime.now(timezone.utc) if checked else None,
        ))
    await db.commit()
    return await _reload_exec(db, execution.id)


async def _complete_execution(db: AsyncSession, execution: SopExecution, notes: Optional[str]) -> SopExecution:
    if execution.status != "in_progress":
        raise HTTPException(status_code=400, detail="errors.sopExecutionClosed")
    required_ids = set((await db.execute(
        select(SopStep.id).where(SopStep.sop_id == execution.sop_id, SopStep.is_required == True)  # noqa: E712
    )).scalars().all())
    checked_ids = {s.step_id for s in execution.steps if s.checked}
    if required_ids - checked_ids:
        raise HTTPException(status_code=400, detail="errors.sopRequiredStepsMissing")
    now = datetime.now(timezone.utc)
    execution.status = "completed"
    execution.completed_at = now
    if execution.started_at:
        started = execution.started_at
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        execution.duration_seconds = max(0.0, (now - started).total_seconds())
    if notes:
        execution.notes = notes
    await db.commit()
    return await _reload_exec(db, execution.id)


async def _abandon_execution(db: AsyncSession, execution: SopExecution) -> SopExecution:
    if execution.status == "in_progress":
        execution.status = "abandoned"
        execution.completed_at = datetime.now(timezone.utc)
        await db.commit()
    return await _reload_exec(db, execution.id)


# ─── Authenticated executions (/api/sop-executions) ─────────────────────────────

@execution_router.post("/", response_model=SopExecutionOut, status_code=201)
async def start_execution(
    data: SopExecutionStart,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
):
    sop = ensure_same_plant(await db.get(Sop, data.sop_id), ctx, detail="SOP not found")
    execution = await _start_execution(
        db, sop,
        equipment_id=data.equipment_id,
        user=current_user,
        operator_name=data.operator_name or current_user.name,
        source="app",
    )
    return await _exec_out(db, execution)


async def _get_execution_for_user(execution_id: UUID, db: AsyncSession, ctx: PlantContext) -> SopExecution:
    execution = await _reload_exec(db, execution_id)
    ensure_same_plant(execution, ctx, detail="Execution not found")
    return execution


@execution_router.patch("/{execution_id}/steps/{step_id}", response_model=SopExecutionOut)
async def set_execution_step(
    execution_id: UUID,
    step_id: UUID,
    data: SopExecutionStepSet,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    execution = await _get_execution_for_user(execution_id, db, ctx)
    execution = await _set_execution_step(db, execution, step_id, data.checked)
    return await _exec_out(db, execution)


@execution_router.post("/{execution_id}/complete", response_model=SopExecutionOut)
async def complete_execution(
    execution_id: UUID,
    data: SopExecutionComplete,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    execution = await _get_execution_for_user(execution_id, db, ctx)
    execution = await _complete_execution(db, execution, data.notes)
    return await _exec_out(db, execution)


@execution_router.post("/{execution_id}/abandon", response_model=SopExecutionOut)
async def abandon_execution(
    execution_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    execution = await _get_execution_for_user(execution_id, db, ctx)
    execution = await _abandon_execution(db, execution)
    return await _exec_out(db, execution)


# ─── Kiosk (no JWT — same trust level as the machine page) ──────────────────────

def _machine_equipment_ids(machine: Machine) -> set:
    """Equipments a kiosk machine maps to. Auto-provisioned machines share the
    equipment's UUID, so the machine id itself is a valid fallback key."""
    ids = {machine.id}
    if machine.equipment_id:
        ids.add(machine.equipment_id)
    return ids


@kiosk_router.get("/{ref}/sops", response_model=SopListResponse)
async def kiosk_list_sops(
    ref: str,
    category: Optional[SopCategory] = None,
    db: AsyncSession = Depends(get_db),
):
    """Published SOPs linked to this machine — full steps + media, ready for the
    kiosk player (operators and technicians on the shop floor, no login)."""
    machine = await _get_machine(ref, db)
    query = (
        select(Sop)
        .join(SopEquipmentLink, SopEquipmentLink.sop_id == Sop.id)
        .where(
            SopEquipmentLink.equipment_id.in_(_machine_equipment_ids(machine)),
            Sop.status == SopStatus.published,
        )
    )
    if machine.plant_id:
        query = query.where(Sop.plant_id == machine.plant_id)
    if category:
        query = query.where(Sop.category == category)
    query = query.order_by(Sop.category, Sop.title)

    sops = (await db.execute(query)).scalars().unique().all()
    items = [await _sop_out(db, s, include_steps=True) for s in sops]
    return SopListResponse(total=len(items), items=items)


async def _kiosk_sop_for_machine(sop_id: UUID, machine: Machine, db: AsyncSession) -> Sop:
    """A kiosk may only execute a published SOP linked to its own machine."""
    sop = await db.get(Sop, sop_id)
    if not sop or sop.status != SopStatus.published:
        raise HTTPException(status_code=404, detail="SOP not found")
    link = (await db.execute(
        select(SopEquipmentLink.id).where(
            SopEquipmentLink.sop_id == sop_id,
            SopEquipmentLink.equipment_id.in_(_machine_equipment_ids(machine)),
        )
    )).first()
    if link is None:
        raise HTTPException(status_code=404, detail="SOP not found")
    return sop


@kiosk_router.post("/{ref}/sops/{sop_id}/executions", response_model=SopExecutionOut, status_code=201)
async def kiosk_start_execution(
    ref: str,
    sop_id: UUID,
    data: KioskExecutionStart,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    sop = await _kiosk_sop_for_machine(sop_id, machine, db)

    # Resume instead of restart: an in-progress run of this SOP on this kiosk
    # (recent enough to still be the same job) is returned as-is. An interrupted
    # operator picks up where they left off, and a double-fired start (React
    # StrictMode dev double-mount) cannot create twin executions.
    recent = datetime.now(timezone.utc) - timedelta(hours=4)
    existing = (await db.execute(
        select(SopExecution)
        .where(
            SopExecution.sop_id == sop.id,
            SopExecution.machine_id == machine.id,
            SopExecution.status == "in_progress",
            SopExecution.started_at >= recent,
        )
        .order_by(SopExecution.started_at.desc())
        .options(selectinload(SopExecution.steps))
        .execution_options(populate_existing=True)
    )).scalars().first()
    if existing:
        return await _exec_out(db, existing)

    execution = await _start_execution(
        db, sop,
        equipment_id=machine.equipment_id or machine.id,
        machine=machine,
        operator_name=(data.operator_name or machine.current_operator),
        source="kiosk",
    )
    return await _exec_out(db, execution)


async def _kiosk_execution(ref: str, execution_id: UUID, db: AsyncSession) -> SopExecution:
    """Kiosk execution routes are keyed on the machine ref — an execution may only
    be driven from the kiosk it was started on."""
    machine = await _get_machine(ref, db)
    execution = await _reload_exec(db, execution_id)
    if execution.machine_id != machine.id:
        raise HTTPException(status_code=404, detail="Execution not found")
    return execution


@kiosk_router.patch("/{ref}/sop-executions/{execution_id}/steps/{step_id}", response_model=SopExecutionOut)
async def kiosk_set_execution_step(
    ref: str,
    execution_id: UUID,
    step_id: UUID,
    data: SopExecutionStepSet,
    db: AsyncSession = Depends(get_db),
):
    execution = await _kiosk_execution(ref, execution_id, db)
    execution = await _set_execution_step(db, execution, step_id, data.checked)
    return await _exec_out(db, execution)


@kiosk_router.post("/{ref}/sop-executions/{execution_id}/complete", response_model=SopExecutionOut)
async def kiosk_complete_execution(
    ref: str,
    execution_id: UUID,
    data: SopExecutionComplete,
    db: AsyncSession = Depends(get_db),
):
    execution = await _kiosk_execution(ref, execution_id, db)
    execution = await _complete_execution(db, execution, data.notes)
    return await _exec_out(db, execution)


@kiosk_router.post("/{ref}/sop-executions/{execution_id}/abandon", response_model=SopExecutionOut)
async def kiosk_abandon_execution(
    ref: str,
    execution_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    execution = await _kiosk_execution(ref, execution_id, db)
    execution = await _abandon_execution(db, execution)
    return await _exec_out(db, execution)
