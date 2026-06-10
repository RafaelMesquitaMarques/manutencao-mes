from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.security import get_current_user
from app.models.models import Equipment, PmTemplate, PmTemplateTask, User
from app.schemas.pm import (
    PmTemplateCreate, PmTemplateUpdate, PmTemplateOut, PmTemplateListResponse,
    PmTemplateTaskCreate, PmTemplateTaskUpdate, PmTemplateTaskOut,
)

router = APIRouter(prefix="/api/settings/pm-templates", tags=["PM Template Settings"])


async def _template_out(db: AsyncSession, template: PmTemplate) -> PmTemplateOut:
    equipment = await db.get(Equipment, template.equipment_id)
    tasks = (await db.execute(
        select(PmTemplateTask)
        .where(PmTemplateTask.template_id == template.id)
        .order_by(PmTemplateTask.sort_order)
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
        tasks=[PmTemplateTaskOut.model_validate(t) for t in tasks],
    )


@router.get("/", response_model=PmTemplateListResponse)
async def list_pm_templates(
    equipment_id: Optional[UUID] = None,
    plant_id: Optional[UUID] = None,
    is_active: Optional[bool] = True,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = select(PmTemplate)
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
):
    equipment = await db.get(Equipment, data.equipment_id)
    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")

    template = PmTemplate(
        plant_id=equipment.plant_id,
        equipment_id=data.equipment_id,
        frequency_type=data.frequency_type,
        name=data.name,
        description=data.description,
        estimated_hours=data.estimated_hours,
        is_active=True,
        sort_order=data.sort_order,
    )
    db.add(template)
    await db.flush()

    for task in data.tasks:
        db.add(PmTemplateTask(
            template_id=template.id,
            description=task.description,
            sort_order=task.sort_order,
            is_required=task.is_required,
        ))

    await db.commit()
    await db.refresh(template)
    return await _template_out(db, template)


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
        sort_order=data.sort_order,
        is_required=data.is_required,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return PmTemplateTaskOut.model_validate(task)


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
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(task, field, value)
    await db.commit()
    await db.refresh(task)
    return PmTemplateTaskOut.model_validate(task)


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
