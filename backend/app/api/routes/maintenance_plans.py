from datetime import date, timedelta
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.security import get_current_user
from app.models.models import (
    User, Equipment, Technician, PmTemplate,
    MaintenancePlan, PlanOccurrence, PlanRecommendedPart, WorkOrder,
    OccurrenceStatus, OccurrenceCompliance, PmFrequency,
)
from app.schemas.pm import (
    MaintenancePlanCreate, MaintenancePlanUpdate, MaintenancePlanOut, MaintenancePlanListResponse,
    PlanRecommendedPartOut,
    PlanOccurrenceOut, PlanOccurrenceListResponse, OccurrenceOverride, OccurrenceCancel,
    PlanCalendarItem, PmDashboard,
)
from app.services import pm_service

router = APIRouter()


# ─── Serialization helpers ────────────────────────────────────────────────────────

async def _plan_out(db: AsyncSession, plan: MaintenancePlan) -> MaintenancePlanOut:
    equipment = await db.get(Equipment, plan.equipment_id)
    pm_template = await db.get(PmTemplate, plan.pm_template_id) if plan.pm_template_id else None

    technician_name = None
    if plan.assigned_technician_id:
        tech = await db.get(Technician, plan.assigned_technician_id)
        if tech:
            tech_user = await db.get(User, tech.user_id)
            technician_name = tech_user.name if tech_user else None

    parts_result = await db.execute(
        select(PlanRecommendedPart).where(PlanRecommendedPart.plan_id == plan.id)
    )
    parts = parts_result.scalars().all()

    return MaintenancePlanOut(
        id=plan.id,
        equipment_id=plan.equipment_id,
        equipment_name=equipment.name if equipment else None,
        plant_id=plan.plant_id,
        name=plan.name,
        description=plan.description,
        pm_template_id=plan.pm_template_id,
        pm_template_name=pm_template.name if pm_template else None,
        plan_type=plan.plan_type,
        frequency_type=plan.frequency_type,
        frequency_value=plan.frequency_value,
        frequency_days=plan.frequency_days,
        frequency_hours=plan.frequency_hours,
        weekdays=plan.weekdays,
        start_date=plan.start_date,
        recurrence_end_type=plan.recurrence_end_type,
        recurrence_end_value=plan.recurrence_end_value,
        recurrence_end_date=plan.recurrence_end_date,
        lead_time_days=plan.lead_time_days,
        assigned_technician_id=plan.assigned_technician_id,
        assigned_technician_name=technician_name,
        priority=plan.priority,
        estimated_hours=plan.estimated_hours,
        is_active=plan.is_active,
        next_due_date=plan.next_due_date,
        next_due_hours=plan.next_due_hours,
        total_occurrences=plan.total_occurrences,
        created_by_id=plan.created_by_id,
        created_at=plan.created_at,
        recommended_parts=[PlanRecommendedPartOut.model_validate(p) for p in parts],
    )


async def _occurrence_out(
    db: AsyncSession,
    occ: PlanOccurrence,
    plan: Optional[MaintenancePlan] = None,
    equipment: Optional[Equipment] = None,
    work_order: Optional[WorkOrder] = None,
) -> PlanOccurrenceOut:
    if plan is None:
        plan = await db.get(MaintenancePlan, occ.plan_id)
    if equipment is None and occ.equipment_id:
        equipment = await db.get(Equipment, occ.equipment_id)
    if work_order is None and occ.work_order_id:
        work_order = await db.get(WorkOrder, occ.work_order_id)

    return PlanOccurrenceOut(
        id=occ.id,
        plan_id=occ.plan_id,
        plan_name=plan.name if plan else None,
        plant_id=occ.plant_id,
        equipment_id=occ.equipment_id,
        equipment_name=equipment.name if equipment else None,
        work_order_id=occ.work_order_id,
        work_order_number=work_order.wo_number if work_order else None,
        scheduled_date=occ.scheduled_date,
        actual_date=occ.actual_date,
        is_overridden=occ.is_overridden,
        override_date=occ.override_date,
        override_note=occ.override_note,
        is_cancelled=occ.is_cancelled,
        cancel_reason=occ.cancel_reason,
        status=occ.status,
        compliance=occ.compliance,
        days_late=occ.days_late,
        reminder_sent=occ.reminder_sent,
        overdue_alert_sent=occ.overdue_alert_sent,
        created_at=occ.created_at,
    )


# ─── Plans: list / create ─────────────────────────────────────────────────────────

@router.get("/", response_model=MaintenancePlanListResponse)
async def list_maintenance_plans(
    equipment_id: Optional[UUID] = None,
    plant_id: Optional[UUID] = None,
    plan_type: Optional[str] = None,
    frequency_type: Optional[PmFrequency] = None,
    is_active: Optional[bool] = True,
    search: Optional[str] = None,
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conditions = []
    if equipment_id:
        conditions.append(MaintenancePlan.equipment_id == equipment_id)
    if plant_id:
        conditions.append(MaintenancePlan.plant_id == plant_id)
    if plan_type:
        conditions.append(MaintenancePlan.plan_type == plan_type)
    if frequency_type:
        conditions.append(MaintenancePlan.frequency_type == frequency_type)
    if is_active is not None:
        conditions.append(MaintenancePlan.is_active == is_active)
    if search:
        conditions.append(MaintenancePlan.name.ilike(f"%{search}%"))

    base_query = select(MaintenancePlan)
    if conditions:
        base_query = base_query.where(and_(*conditions))

    total = (await db.execute(select(func.count()).select_from(base_query.subquery()))).scalar() or 0

    result = await db.execute(
        base_query.order_by(MaintenancePlan.next_due_date.nullslast(), MaintenancePlan.name)
        .offset(skip).limit(limit)
    )
    plans = result.scalars().all()
    items = [await _plan_out(db, p) for p in plans]

    plan_ids_query = select(MaintenancePlan.id)
    if conditions:
        plan_ids_query = plan_ids_query.where(and_(*conditions))
    plan_ids = [row[0] for row in (await db.execute(plan_ids_query)).all()]

    overdue_count = 0
    due_this_week = 0
    if plan_ids:
        today = date.today()
        overdue_count = (await db.execute(
            select(func.count(PlanOccurrence.id)).where(
                PlanOccurrence.plan_id.in_(plan_ids),
                PlanOccurrence.is_cancelled == False,
                PlanOccurrence.status.in_([OccurrenceStatus.scheduled, OccurrenceStatus.in_progress]),
                PlanOccurrence.scheduled_date < today,
            )
        )).scalar() or 0

        due_this_week = (await db.execute(
            select(func.count(PlanOccurrence.id)).where(
                PlanOccurrence.plan_id.in_(plan_ids),
                PlanOccurrence.is_cancelled == False,
                PlanOccurrence.status == OccurrenceStatus.scheduled,
                PlanOccurrence.scheduled_date >= today,
                PlanOccurrence.scheduled_date <= today + timedelta(days=7),
            )
        )).scalar() or 0

    return MaintenancePlanListResponse(
        total=total, items=items, overdue_count=overdue_count, due_this_week=due_this_week,
    )


@router.post("/", response_model=MaintenancePlanOut, status_code=201)
async def create_maintenance_plan(
    data: MaintenancePlanCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    equipment = await db.get(Equipment, data.equipment_id)
    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")

    if data.pm_template_id and not await db.get(PmTemplate, data.pm_template_id):
        raise HTTPException(status_code=404, detail="PM template not found")

    if data.assigned_technician_id and not await db.get(Technician, data.assigned_technician_id):
        raise HTTPException(status_code=404, detail="Technician not found")

    plan = MaintenancePlan(
        equipment_id=data.equipment_id,
        plant_id=equipment.plant_id,
        name=data.name,
        description=data.description,
        pm_template_id=data.pm_template_id,
        plan_type=data.plan_type,
        trigger_type="calendar",
        frequency_type=data.frequency_type,
        frequency_value=data.frequency_value,
        frequency_days=data.frequency_days,
        frequency_hours=data.frequency_hours,
        weekdays=data.weekdays,
        start_date=data.start_date,
        recurrence_end_type=data.recurrence_end_type,
        recurrence_end_value=data.recurrence_end_value,
        recurrence_end_date=data.recurrence_end_date,
        lead_time_days=data.lead_time_days,
        assigned_technician_id=data.assigned_technician_id,
        priority=data.priority,
        estimated_hours=data.estimated_hours,
        is_active=True,
        active=True,
        next_due_date=data.start_date,
        created_by_id=current_user.id,
    )
    db.add(plan)
    await db.flush()

    for part in data.recommended_parts:
        db.add(PlanRecommendedPart(
            plan_id=plan.id,
            stock_item_id=part.stock_item_id,
            item_code=part.item_code,
            item_description=part.item_description,
            quantity_recommended=part.quantity_recommended,
            unit=part.unit,
        ))

    occurrence = await pm_service.create_next_occurrence(db, plan)
    await db.commit()
    await db.refresh(plan)

    if occurrence:
        await db.refresh(occurrence)
        today = date.today()
        if occurrence.scheduled_date <= today + timedelta(days=plan.lead_time_days or 0):
            await pm_service.generate_wo_and_ticket(db, plan, occurrence)
            await db.refresh(plan)

    return await _plan_out(db, plan)


# ─── Calendar / Dashboard (must be registered before /{plan_id}) ─────────────────

@router.get("/calendar", response_model=List[PlanCalendarItem])
async def get_pm_calendar(
    start: date,
    end: date,
    plant_id: Optional[UUID] = None,
    equipment_id: Optional[UUID] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = (
        select(PlanOccurrence, MaintenancePlan)
        .join(MaintenancePlan, PlanOccurrence.plan_id == MaintenancePlan.id)
        .where(
            PlanOccurrence.scheduled_date >= start,
            PlanOccurrence.scheduled_date <= end,
        )
    )
    if plant_id:
        query = query.where(MaintenancePlan.plant_id == plant_id)
    if equipment_id:
        query = query.where(MaintenancePlan.equipment_id == equipment_id)

    result = await db.execute(query)
    items = []
    for occ, plan in result.all():
        equipment = await db.get(Equipment, occ.equipment_id) if occ.equipment_id else None
        items.append(PlanCalendarItem(
            id=occ.id,
            plan_id=plan.id,
            plan_name=plan.name,
            equipment_id=occ.equipment_id,
            equipment_name=equipment.name if equipment else None,
            date=occ.override_date or occ.scheduled_date,
            status=occ.status,
            compliance=occ.compliance,
            is_overridden=occ.is_overridden,
            is_cancelled=occ.is_cancelled,
            work_order_id=occ.work_order_id,
            priority=plan.priority,
        ))
    return items


@router.get("/dashboard", response_model=PmDashboard)
async def get_pm_dashboard(
    plant_id: Optional[UUID] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    today = date.today()
    week_end = today + timedelta(days=7)
    month_start = today.replace(day=1)

    plan_query = select(MaintenancePlan)
    if plant_id:
        plan_query = plan_query.where(MaintenancePlan.plant_id == plant_id)

    total_plans = (await db.execute(
        select(func.count()).select_from(plan_query.subquery())
    )).scalar() or 0

    active_plans = (await db.execute(
        select(func.count()).select_from(plan_query.where(MaintenancePlan.is_active == True).subquery())
    )).scalar() or 0

    occ_query = select(PlanOccurrence).join(MaintenancePlan, PlanOccurrence.plan_id == MaintenancePlan.id)
    if plant_id:
        occ_query = occ_query.where(MaintenancePlan.plant_id == plant_id)

    overdue_occs = (await db.execute(
        occ_query.where(
            PlanOccurrence.is_cancelled == False,
            PlanOccurrence.status.in_([OccurrenceStatus.scheduled, OccurrenceStatus.in_progress]),
            PlanOccurrence.scheduled_date < today,
        ).order_by(PlanOccurrence.scheduled_date)
    )).scalars().all()

    upcoming_occs = (await db.execute(
        occ_query.where(
            PlanOccurrence.is_cancelled == False,
            PlanOccurrence.status == OccurrenceStatus.scheduled,
            PlanOccurrence.scheduled_date >= today,
            PlanOccurrence.scheduled_date <= week_end,
        ).order_by(PlanOccurrence.scheduled_date)
    )).scalars().all()

    completed_occs = (await db.execute(
        occ_query.where(
            PlanOccurrence.status == OccurrenceStatus.completed,
            PlanOccurrence.actual_date >= month_start,
            PlanOccurrence.actual_date <= today,
        )
    )).scalars().all()

    on_time_occs = (await db.execute(
        occ_query.where(
            PlanOccurrence.status == OccurrenceStatus.completed,
            PlanOccurrence.actual_date >= month_start,
            PlanOccurrence.actual_date <= today,
            PlanOccurrence.compliance.in_([OccurrenceCompliance.on_time, OccurrenceCompliance.early]),
        )
    )).scalars().all()

    completed_this_month = len(completed_occs)
    compliance_rate = (
        round(len(on_time_occs) / completed_this_month * 100, 1) if completed_this_month else 100.0
    )

    return PmDashboard(
        total_plans=total_plans,
        active_plans=active_plans,
        overdue_occurrences=len(overdue_occs),
        due_this_week=len(upcoming_occs),
        completed_this_month=completed_this_month,
        compliance_rate=compliance_rate,
        upcoming=[await _occurrence_out(db, occ) for occ in upcoming_occs[:10]],
        overdue=[await _occurrence_out(db, occ) for occ in overdue_occs[:10]],
    )


# ─── Occurrences (must be registered before /{plan_id}) ──────────────────────────

@router.get("/occurrences/{occurrence_id}", response_model=PlanOccurrenceOut)
async def get_occurrence(
    occurrence_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    occ = await db.get(PlanOccurrence, occurrence_id)
    if not occ:
        raise HTTPException(status_code=404, detail="Occurrence not found")
    return await _occurrence_out(db, occ)


@router.patch("/occurrences/{occurrence_id}", response_model=PlanOccurrenceOut)
async def override_occurrence(
    occurrence_id: UUID,
    data: OccurrenceOverride,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Edit a single occurrence (date/note) without affecting the recurrence series."""
    occ = await db.get(PlanOccurrence, occurrence_id)
    if not occ:
        raise HTTPException(status_code=404, detail="Occurrence not found")
    if occ.status != OccurrenceStatus.scheduled:
        raise HTTPException(status_code=400, detail="Only scheduled occurrences can be edited")

    if data.override_date is not None:
        occ.override_date = data.override_date
        occ.is_overridden = True
        if occ.work_order_id:
            wo = await db.get(WorkOrder, occ.work_order_id)
            if wo:
                wo.scheduled_date = data.override_date
        occ.overdue_alert_sent = False
        occ.reminder_sent = False

    if data.override_note is not None:
        occ.override_note = data.override_note
        occ.is_overridden = True

    await db.commit()
    await db.refresh(occ)
    return await _occurrence_out(db, occ)


@router.post("/occurrences/{occurrence_id}/cancel", response_model=PlanOccurrenceOut)
async def cancel_occurrence(
    occurrence_id: UUID,
    data: OccurrenceCancel,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Skip/cancel a single occurrence and advance the plan to the next one."""
    occ = await db.get(PlanOccurrence, occurrence_id)
    if not occ:
        raise HTTPException(status_code=404, detail="Occurrence not found")
    if occ.status not in (OccurrenceStatus.scheduled, OccurrenceStatus.in_progress):
        raise HTTPException(status_code=400, detail="Occurrence cannot be cancelled")

    occ.is_cancelled = True
    occ.cancel_reason = data.cancel_reason
    occ.status = OccurrenceStatus.cancelled

    plan = await db.get(MaintenancePlan, occ.plan_id)
    if plan:
        await pm_service.create_next_occurrence(db, plan)

    await db.commit()
    await db.refresh(occ)
    return await _occurrence_out(db, occ)


@router.post("/occurrences/{occurrence_id}/generate-wo", response_model=PlanOccurrenceOut)
async def generate_occurrence_wo(
    occurrence_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Manually generate the work order + ticket for a not-yet-generated occurrence."""
    occ = await db.get(PlanOccurrence, occurrence_id)
    if not occ:
        raise HTTPException(status_code=404, detail="Occurrence not found")
    if occ.is_cancelled:
        raise HTTPException(status_code=400, detail="Occurrence is cancelled")
    if occ.work_order_id:
        raise HTTPException(status_code=400, detail="Work order already generated for this occurrence")

    plan = await db.get(MaintenancePlan, occ.plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    await pm_service.generate_wo_and_ticket(db, plan, occ)
    await db.refresh(occ)
    return await _occurrence_out(db, occ)


# ─── Plans: detail / update / delete ──────────────────────────────────────────────

@router.get("/{plan_id}", response_model=MaintenancePlanOut)
async def get_maintenance_plan(
    plan_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    plan = await db.get(MaintenancePlan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    return await _plan_out(db, plan)


@router.get("/{plan_id}/occurrences", response_model=PlanOccurrenceListResponse)
async def list_plan_occurrences(
    plan_id: UUID,
    status: Optional[OccurrenceStatus] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    plan = await db.get(MaintenancePlan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    query = select(PlanOccurrence).where(PlanOccurrence.plan_id == plan_id)
    if status:
        query = query.where(PlanOccurrence.status == status)
    query = query.order_by(PlanOccurrence.scheduled_date)

    occurrences = (await db.execute(query)).scalars().all()
    items = [await _occurrence_out(db, occ, plan=plan) for occ in occurrences]
    return PlanOccurrenceListResponse(total=len(items), items=items)


@router.patch("/{plan_id}", response_model=MaintenancePlanOut)
async def update_maintenance_plan(
    plan_id: UUID,
    data: MaintenancePlanUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    plan = await db.get(MaintenancePlan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    if data.pm_template_id is not None and not await db.get(PmTemplate, data.pm_template_id):
        raise HTTPException(status_code=404, detail="PM template not found")
    if data.assigned_technician_id is not None and not await db.get(Technician, data.assigned_technician_id):
        raise HTTPException(status_code=404, detail="Technician not found")

    update_data = data.model_dump(exclude_none=True)
    for field, value in update_data.items():
        setattr(plan, field, value)
    if "is_active" in update_data:
        plan.active = update_data["is_active"]

    await db.commit()
    await db.refresh(plan)
    return await _plan_out(db, plan)


@router.delete("/{plan_id}", status_code=204)
async def delete_maintenance_plan(
    plan_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    plan = await db.get(MaintenancePlan, plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    plan.is_active = False
    plan.active = False

    pending = (await db.execute(
        select(PlanOccurrence).where(
            PlanOccurrence.plan_id == plan.id,
            PlanOccurrence.status == OccurrenceStatus.scheduled,
            PlanOccurrence.is_cancelled == False,
        )
    )).scalars().all()
    for occ in pending:
        occ.is_cancelled = True
        occ.cancel_reason = "Plan deactivated"
        occ.status = OccurrenceStatus.cancelled

    await db.commit()
