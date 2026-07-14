"""Shift templates & break rules — the clock windows and non-working intervals
used to compute effective LABOR time and technician availability.

A technician is matched to a template by ``Technician.shift`` == ``template.key``
(plant-scoped templates win over global). Editing these NEVER changes machine
downtime, MTTR, or stop duration — only labor cost and availability.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from uuid import UUID
from typing import List

from app.db.session import get_db
from app.models.models import ShiftTemplate, ShiftBreak, User
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import plant_condition
from app.schemas.shift import (
    ShiftTemplateCreate, ShiftTemplateUpdate, ShiftTemplateOut,
)

router = APIRouter()


def _visible(ctx: PlantContext):
    """A template is visible if it is global (plant_id NULL, shared by every
    plant) or owned by a plant the caller can access."""
    return or_(plant_condition(ShiftTemplate, ctx), ShiftTemplate.plant_id.is_(None))


async def _load(db: AsyncSession, template_id: UUID, ctx: PlantContext) -> ShiftTemplate:
    tpl = (await db.execute(
        select(ShiftTemplate)
        .options(selectinload(ShiftTemplate.breaks))
        .where(ShiftTemplate.id == template_id)
    )).scalar_one_or_none()
    if tpl is None or not (tpl.plant_id is None or ctx.can_access(tpl.plant_id)):
        raise HTTPException(status_code=404, detail="Shift template not found")
    return tpl


@router.get("/", response_model=List[ShiftTemplateOut])
async def list_shift_templates(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(ShiftTemplate)
        .options(selectinload(ShiftTemplate.breaks))
        .where(_visible(ctx))
        .order_by(ShiftTemplate.start_time)
    )).scalars().all()
    return [ShiftTemplateOut.model_validate(t) for t in rows]


@router.get("/{template_id}", response_model=ShiftTemplateOut)
async def get_shift_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    return ShiftTemplateOut.model_validate(await _load(db, template_id, ctx))


@router.post("/", response_model=ShiftTemplateOut, status_code=201)
async def create_shift_template(
    data: ShiftTemplateCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    # A template targets a plant the caller can access, or is global (plant_id None).
    if data.plant_id is not None and not ctx.can_access(data.plant_id):
        raise HTTPException(status_code=400, detail="plant_not_authorized")
    tpl = ShiftTemplate(
        plant_id=data.plant_id, key=data.key, name=data.name,
        start_time=data.start_time, end_time=data.end_time, active=data.active,
    )
    db.add(tpl)
    await db.flush()
    for b in data.breaks:
        db.add(ShiftBreak(
            shift_template_id=tpl.id, kind=b.kind, name=b.name,
            start_time=b.start_time, end_time=b.end_time, paid=b.paid,
        ))
    await db.commit()
    return ShiftTemplateOut.model_validate(await _load(db, tpl.id))


@router.patch("/{template_id}", response_model=ShiftTemplateOut)
async def update_shift_template(
    template_id: UUID,
    data: ShiftTemplateUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    tpl = await _load(db, template_id, ctx)
    fields = data.model_dump(exclude_unset=True)
    breaks = fields.pop("breaks", None)
    for k, v in fields.items():
        setattr(tpl, k, v)
    # When breaks are provided, replace the whole set.
    if breaks is not None:
        for b in list(tpl.breaks):
            await db.delete(b)
        await db.flush()
        for b in data.breaks:
            db.add(ShiftBreak(
                shift_template_id=tpl.id, kind=b.kind, name=b.name,
                start_time=b.start_time, end_time=b.end_time, paid=b.paid,
            ))
    await db.commit()
    return ShiftTemplateOut.model_validate(await _load(db, template_id, ctx))


@router.delete("/{template_id}", status_code=204)
async def delete_shift_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    tpl = await _load(db, template_id, ctx)
    await db.delete(tpl)
    await db.commit()
