from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.session import get_db
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_condition
from app.models.models import Equipment, PmTemplate, PmTemplateTask, PmTaskMedia, User
from app.schemas.pm import (
    PmTemplateCreate, PmTemplateUpdate, PmTemplateOut, PmTemplateListResponse,
    PmTemplateTaskCreate, PmTemplateTaskUpdate, PmTemplateTaskOut,
    PmTaskMediaCreate, PmTaskMediaOut, PmTemplateCloneRequest,
)

router = APIRouter(prefix="/api/settings/pm-templates", tags=["PM Template Settings"])


async def _task_out(db: AsyncSession, task_id: UUID) -> PmTemplateTaskOut:
    """Reload a task with its media eagerly so model_validate never lazy-loads."""
    t = (await db.execute(
        select(PmTemplateTask)
        .where(PmTemplateTask.id == task_id)
        .options(selectinload(PmTemplateTask.media))
    )).scalar_one()
    return PmTemplateTaskOut.model_validate(t)


async def _template_out(db: AsyncSession, template: PmTemplate) -> PmTemplateOut:
    equipment = await db.get(Equipment, template.equipment_id)
    tasks = (await db.execute(
        select(PmTemplateTask)
        .where(PmTemplateTask.template_id == template.id)
        .order_by(PmTemplateTask.sort_order)
        .options(selectinload(PmTemplateTask.media))
    )).scalars().all()

    return PmTemplateOut(
        id=template.id,
        plant_id=template.plant_id,
        equipment_id=template.equipment_id,
        equipment_name=equipment.name if equipment else None,
        frequency_type=template.frequency_type,
        name=template.name,
        description=template.description,
        estimated_hours=template.estimated_hours,
        is_active=template.is_active,
        sort_order=template.sort_order,
        enforcement=template.enforcement or "advisory",
        tasks=[PmTemplateTaskOut.model_validate(t) for t in tasks],
    )


@router.get("/", response_model=PmTemplateListResponse)
async def list_pm_templates(
    equipment_id: Optional[UUID] = None,
    plant_id: Optional[UUID] = None,
    is_active: Optional[bool] = True,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    query = select(PmTemplate).where(plant_condition(PmTemplate, ctx))
    if equipment_id:
        query = query.where(PmTemplate.equipment_id == equipment_id)
    if plant_id:
        query = query.where(PmTemplate.plant_id == plant_id)
    if is_active is not None:
        query = query.where(PmTemplate.is_active == is_active)
    query = query.order_by(PmTemplate.sort_order, PmTemplate.name)

    templates = (await db.execute(query)).scalars().all()
    items = [await _template_out(db, t) for t in templates]
    return PmTemplateListResponse(total=len(items), items=items)


@router.post("/", response_model=PmTemplateOut, status_code=201)
async def create_pm_template(
    data: PmTemplateCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
):
    equipment = ensure_same_plant(await db.get(Equipment, data.equipment_id), ctx, detail="Equipment not found")

    template = PmTemplate(
        plant_id=equipment.plant_id,
        equipment_id=data.equipment_id,
        frequency_type=data.frequency_type,
        name=data.name,
        description=data.description,
        estimated_hours=data.estimated_hours,
        is_active=True,
        sort_order=data.sort_order,
        enforcement=data.enforcement or "advisory",
    )
    db.add(template)
    await db.flush()

    for task in data.tasks:
        db.add(PmTemplateTask(
            template_id=template.id,
            description=task.description,
            expected_result=task.expected_result,
            sort_order=task.sort_order,
            is_required=task.is_required,
        ))

    await db.commit()
    await db.refresh(template)
    return await _template_out(db, template)


@router.post("/{template_id}/clone")
async def clone_pm_template(
    template_id: UUID,
    data: PmTemplateCloneRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Copy a PM template — steps (description, expected result, required) and
    their media (photos/videos/links) — to one or more target equipments."""
    src = await db.get(PmTemplate, template_id)
    if not src:
        raise HTTPException(status_code=404, detail="PM template not found")

    tasks = (await db.execute(
        select(PmTemplateTask)
        .where(PmTemplateTask.template_id == src.id)
        .order_by(PmTemplateTask.sort_order)
        .options(selectinload(PmTemplateTask.media))
    )).scalars().all()

    cloned = 0
    for target_id in data.target_equipment_ids:
        if target_id == src.equipment_id:
            continue
        equip = await db.get(Equipment, target_id)
        if not equip:
            continue
        new_tpl = PmTemplate(
            plant_id=equip.plant_id,
            equipment_id=target_id,
            frequency_type=src.frequency_type,
            name=src.name,
            description=src.description,
            estimated_hours=src.estimated_hours,
            is_active=True,
            sort_order=src.sort_order,
            enforcement=src.enforcement,
        )
        db.add(new_tpl)
        await db.flush()
        for task in tasks:
            nt = PmTemplateTask(
                template_id=new_tpl.id,
                description=task.description,
                expected_result=task.expected_result,
                is_required=task.is_required,
                sort_order=task.sort_order,
            )
            db.add(nt)
            await db.flush()
            for m in task.media:
                db.add(PmTaskMedia(
                    task_id=nt.id,
                    media_type=m.media_type,
                    url=m.url,            # same served file / external link — no re-upload
                    caption=m.caption,
                    sort_order=m.sort_order,
                ))
        cloned += 1

    await db.commit()
    return {"status": "ok", "cloned_to": cloned}


@router.get("/{template_id}", response_model=PmTemplateOut)
async def get_pm_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    template = await db.get(PmTemplate, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="PM template not found")
    return await _template_out(db, template)


@router.patch("/{template_id}", response_model=PmTemplateOut)
async def update_pm_template(
    template_id: UUID,
    data: PmTemplateUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    template = await db.get(PmTemplate, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="PM template not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(template, field, value)
    await db.commit()
    await db.refresh(template)
    return await _template_out(db, template)


@router.delete("/{template_id}", status_code=200)
async def delete_pm_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    template = await db.get(PmTemplate, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="PM template not found")
    template.is_active = False
    await db.commit()
    return {"status": "deleted"}


# ─── Template tasks ───────────────────────────────────────────────────────────────

@router.post("/{template_id}/tasks", response_model=PmTemplateTaskOut, status_code=201)
async def add_template_task(
    template_id: UUID,
    data: PmTemplateTaskCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    template = await db.get(PmTemplate, template_id)
    if not template:
        raise HTTPException(status_code=404, detail="PM template not found")

    task = PmTemplateTask(
        template_id=template_id,
        description=data.description,
        expected_result=data.expected_result,
        sort_order=data.sort_order,
        is_required=data.is_required,
    )
    db.add(task)
    await db.commit()
    return await _task_out(db, task.id)


@router.patch("/{template_id}/tasks/{task_id}", response_model=PmTemplateTaskOut)
async def update_template_task(
    template_id: UUID,
    task_id: UUID,
    data: PmTemplateTaskUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    task = await db.get(PmTemplateTask, task_id)
    if not task or task.template_id != template_id:
        raise HTTPException(status_code=404, detail="Template task not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(task, field, value)
    await db.commit()
    return await _task_out(db, task.id)


@router.delete("/{template_id}/tasks/{task_id}", status_code=200)
async def delete_template_task(
    template_id: UUID,
    task_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    task = await db.get(PmTemplateTask, task_id)
    if not task or task.template_id != template_id:
        raise HTTPException(status_code=404, detail="Template task not found")
    await db.delete(task)
    await db.commit()
    return {"status": "deleted"}


# ─── Template task media (SOP photos / videos / links) ──────────────────────────

@router.post("/{template_id}/tasks/{task_id}/media", response_model=PmTaskMediaOut, status_code=201)
async def add_task_media(
    template_id: UUID,
    task_id: UUID,
    data: PmTaskMediaCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    task = await db.get(PmTemplateTask, task_id)
    if not task or task.template_id != template_id:
        raise HTTPException(status_code=404, detail="Template task not found")
    if data.media_type not in ("image", "video", "link"):
        raise HTTPException(status_code=400, detail="media_type must be image, video or link")
    media = PmTaskMedia(
        task_id=task_id,
        media_type=data.media_type,
        url=data.url,
        caption=data.caption,
        sort_order=data.sort_order,
    )
    db.add(media)
    await db.commit()
    await db.refresh(media)
    return PmTaskMediaOut.model_validate(media)


@router.delete("/{template_id}/tasks/{task_id}/media/{media_id}", status_code=200)
async def delete_task_media(
    template_id: UUID,
    task_id: UUID,
    media_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    media = await db.get(PmTaskMedia, media_id)
    if not media or media.task_id != task_id:
        raise HTTPException(status_code=404, detail="Media not found")
    await db.delete(media)
    await db.commit()
    return {"status": "deleted"}
