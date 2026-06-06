from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import Optional
from uuid import UUID
from datetime import datetime, timezone

from app.db.session import get_db
from app.models.models import (
    User, WorkOrder, Equipment, WorkOrderStatus, WorkOrderType, WorkOrderPriority,
    LaborRecord, WOPart, WOCost, WOAction, Technician,
)
from app.schemas.work_order import WorkOrderCreate, WorkOrderUpdate, WorkOrderOut, WorkOrderListResponse
from app.schemas.wo_subresources import (
    LaborCreate, LaborOut, LaborListResponse,
    WOPartCreate, WOPartOut, WOPartListResponse,
    WOCostCreate, WOCostOut, WOCostListResponse,
    WOActionCreate, WOActionOut, WOActionListResponse,
    WOCostSummary,
)
from app.core.security import get_current_user

router = APIRouter()


async def _generate_work_order_number(db: AsyncSession) -> str:
    year = datetime.now(timezone.utc).year
    result = await db.execute(
        select(func.count(WorkOrder.id)).where(
            func.extract("year", WorkOrder.opened_at) == year
        )
    )
    count = result.scalar() + 1
    return f"WO-{year}-{count:05d}"


@router.get("/", response_model=WorkOrderListResponse)
async def list_work_orders(
    plant_id: Optional[UUID] = None,
    equipment_id: Optional[UUID] = None,
    status: Optional[WorkOrderStatus] = None,
    type: Optional[WorkOrderType] = None,
    priority: Optional[WorkOrderPriority] = None,
    assigned_to_id: Optional[UUID] = None,
    from_iot: Optional[bool] = None,
    search: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = select(WorkOrder)

    if equipment_id:
        query = query.where(WorkOrder.equipment_id == equipment_id)
    if status:
        query = query.where(WorkOrder.status == status)
    if type:
        query = query.where(WorkOrder.type == type)
    if priority:
        query = query.where(WorkOrder.priority == priority)
    if assigned_to_id:
        query = query.where(WorkOrder.assigned_to_id == assigned_to_id)
    if from_iot is not None:
        query = query.where(WorkOrder.from_iot == from_iot)
    if search:
        query = query.where(
            WorkOrder.title.ilike(f"%{search}%") |
            WorkOrder.wo_number.ilike(f"%{search}%")
        )
    if plant_id:
        query = query.join(Equipment).where(Equipment.plant_id == plant_id)

    total_result = await db.execute(select(func.count()).select_from(query.subquery()))
    total = total_result.scalar()

    query = query.offset(skip).limit(limit).order_by(WorkOrder.opened_at.desc())
    result = await db.execute(query)
    items = result.scalars().all()

    wo_list = []
    for wo in items:
        wo_data = WorkOrderOut.model_validate(wo)
        equip = await db.get(Equipment, wo.equipment_id)
        if equip:
            wo_data.equipment_name = equip.name
            wo_data.equipment_location = equip.location
        wo_list.append(wo_data)

    return WorkOrderListResponse(total=total, items=wo_list)


@router.get("/dashboard", summary="Counts by status for dashboard")
async def wo_dashboard(
    plant_id: Optional[UUID] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    counts: dict = {}
    for st in WorkOrderStatus:
        q = select(func.count(WorkOrder.id)).where(WorkOrder.status == st)
        if plant_id:
            q = q.join(Equipment).where(Equipment.plant_id == plant_id)
        r = await db.execute(q)
        counts[st.value] = r.scalar()

    q = select(func.count(WorkOrder.id)).where(
        WorkOrder.priority == WorkOrderPriority.critical,
        WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.in_progress])
    )
    critical_count = (await db.execute(q)).scalar()

    today = datetime.now(timezone.utc).date()
    q = select(func.count(WorkOrder.id)).where(
        WorkOrder.status == WorkOrderStatus.completed,
        func.date(WorkOrder.completed_at) == today,
    )
    completed_today = (await db.execute(q)).scalar()

    by_type = []
    for tp in WorkOrderType:
        q = select(func.count(WorkOrder.id)).where(WorkOrder.type == tp)
        cnt = (await db.execute(q)).scalar()
        if cnt:
            by_type.append({"type": tp.value, "count": cnt})

    by_status = [{"status": k, "count": v} for k, v in counts.items() if v]

    return {
        "total_open": counts.get(WorkOrderStatus.open.value, 0),
        "in_progress": counts.get(WorkOrderStatus.in_progress.value, 0),
        "on_hold": counts.get(WorkOrderStatus.on_hold.value, 0),
        "critical": critical_count,
        "completed_today": completed_today,
        "by_type": by_type,
        "by_status": by_status,
    }


@router.get("/{work_order_id}", response_model=WorkOrderOut)
async def get_work_order(
    work_order_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(WorkOrder).where(WorkOrder.id == work_order_id))
    wo = result.scalar_one_or_none()
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    wo_data = WorkOrderOut.model_validate(wo)
    equip = await db.get(Equipment, wo.equipment_id)
    if equip:
        wo_data.equipment_name = equip.name
        wo_data.equipment_location = equip.location
    return wo_data


@router.post("/", response_model=WorkOrderOut, status_code=201)
async def create_work_order(
    data: WorkOrderCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    equip = await db.get(Equipment, data.equipment_id)
    if not equip:
        raise HTTPException(status_code=404, detail="Equipment not found")

    wo_number = await _generate_work_order_number(db)
    wo = WorkOrder(
        wo_number=wo_number,
        created_by_id=current_user.id,
        equipment_id=data.equipment_id,
        type=data.type,
        priority=data.priority,
        title=data.title,
        short_description=data.short_description,
        description=data.description,
        due_date=data.due_date,
        assigned_to_id=data.assigned_to_id,
        executor_id=data.executor_id,
        execution_mode=data.execution_mode,
        classification=data.classification,
        failure_code=data.failure_code,
        tag=data.tag,
        component=data.component,
        project_number=data.project_number,
        cost_center=data.cost_center,
    )
    db.add(wo)
    await db.commit()
    await db.refresh(wo)

    wo_data = WorkOrderOut.model_validate(wo)
    wo_data.equipment_name = equip.name
    wo_data.equipment_location = equip.location
    return wo_data


@router.patch("/{work_order_id}", response_model=WorkOrderOut)
async def update_work_order(
    work_order_id: UUID,
    data: WorkOrderUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(WorkOrder).where(WorkOrder.id == work_order_id))
    wo = result.scalar_one_or_none()
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")

    update_data = data.model_dump(exclude_none=True)

    if "status" in update_data:
        if update_data["status"] == WorkOrderStatus.in_progress and not wo.started_at:
            update_data["started_at"] = datetime.now(timezone.utc)
        elif update_data["status"] == WorkOrderStatus.completed and not wo.completed_at:
            update_data["completed_at"] = datetime.now(timezone.utc)

    for field, value in update_data.items():
        setattr(wo, field, value)

    await db.commit()
    await db.refresh(wo)
    return wo


@router.post("/{work_order_id}/start", response_model=WorkOrderOut)
async def start_work_order(
    work_order_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(WorkOrder).where(WorkOrder.id == work_order_id))
    wo = result.scalar_one_or_none()
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    if wo.status != WorkOrderStatus.open:
        raise HTTPException(status_code=400, detail="Work order is not open")

    wo.status = WorkOrderStatus.in_progress
    wo.started_at = datetime.now(timezone.utc)
    wo.assigned_to_id = current_user.id
    await db.commit()
    await db.refresh(wo)
    return wo


@router.post("/{work_order_id}/complete", response_model=WorkOrderOut)
async def complete_work_order(
    work_order_id: UUID,
    root_cause: Optional[str] = None,
    solution_applied: Optional[str] = None,
    repair_hours: Optional[float] = None,
    downtime_hours: Optional[float] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(WorkOrder).where(WorkOrder.id == work_order_id))
    wo = result.scalar_one_or_none()
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")

    wo.status = WorkOrderStatus.completed
    wo.completed_at = datetime.now(timezone.utc)
    if root_cause:
        wo.root_cause = root_cause
    if solution_applied:
        wo.solution_applied = solution_applied
    if repair_hours:
        wo.repair_hours = repair_hours
    if downtime_hours:
        wo.downtime_hours = downtime_hours

    await db.commit()
    await db.refresh(wo)
    return wo


# ─── Labor sub-resource ───────────────────────────────────────────────────────

@router.post("/{work_order_id}/labor", response_model=LaborOut, status_code=201)
async def add_labor(
    work_order_id: UUID,
    data: LaborCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")

    technician = await db.get(Technician, data.technician_id)
    rate = data.hourly_rate or (technician.hourly_rate if technician else None)
    labor_cost = (rate * data.hours_worked) if rate else None

    record = LaborRecord(
        work_order_id=work_order_id,
        technician_id=data.technician_id,
        date=data.date,
        hours_worked=data.hours_worked,
        hourly_rate=rate,
        labor_cost=labor_cost,
        activity=data.activity,
        notes=data.notes,
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return record


@router.get("/{work_order_id}/labor", response_model=LaborListResponse)
async def list_labor(
    work_order_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(LaborRecord).where(LaborRecord.work_order_id == work_order_id)
    )
    items = result.scalars().all()
    return LaborListResponse(total=len(items), items=items)


# ─── Parts sub-resource ───────────────────────────────────────────────────────

@router.post("/{work_order_id}/parts", response_model=WOPartOut, status_code=201)
async def add_part(
    work_order_id: UUID,
    data: WOPartCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")

    total_cost = (data.unit_cost * data.quantity) if data.unit_cost else None
    part = WOPart(
        work_order_id=work_order_id,
        stock_item_id=data.stock_item_id,
        part_number=data.part_number,
        description=data.description,
        quantity=data.quantity,
        unit=data.unit,
        unit_cost=data.unit_cost,
        total_cost=total_cost,
        supplier=data.supplier,
        notes=data.notes,
    )
    db.add(part)
    await db.commit()
    await db.refresh(part)
    return part


@router.get("/{work_order_id}/parts", response_model=WOPartListResponse)
async def list_parts(
    work_order_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WOPart).where(WOPart.work_order_id == work_order_id)
    )
    items = result.scalars().all()
    return WOPartListResponse(total=len(items), items=items)


# ─── Costs sub-resource ───────────────────────────────────────────────────────

@router.post("/{work_order_id}/costs", response_model=WOCostOut, status_code=201)
async def add_cost(
    work_order_id: UUID,
    data: WOCostCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")

    cost = WOCost(
        work_order_id=work_order_id,
        transaction_type=data.transaction_type,
        description=data.description,
        amount=data.amount,
        currency=data.currency,
        reference=data.reference,
        date=data.date,
        notes=data.notes,
    )
    db.add(cost)
    await db.commit()
    await db.refresh(cost)
    return cost


@router.get("/{work_order_id}/costs", response_model=WOCostListResponse)
async def list_costs(
    work_order_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WOCost).where(WOCost.work_order_id == work_order_id)
    )
    items = result.scalars().all()
    return WOCostListResponse(total=len(items), items=items)


@router.get("/{work_order_id}/costs/summary", response_model=WOCostSummary)
async def cost_summary(
    work_order_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    costs_result = await db.execute(select(WOCost).where(WOCost.work_order_id == work_order_id))
    costs = costs_result.scalars().all()

    labor_result = await db.execute(select(LaborRecord).where(LaborRecord.work_order_id == work_order_id))
    labor = labor_result.scalars().all()

    parts_result = await db.execute(select(WOPart).where(WOPart.work_order_id == work_order_id))
    parts = parts_result.scalars().all()

    labor_total = sum(r.labor_cost or 0 for r in labor)
    parts_total = sum(p.total_cost or 0 for p in parts)
    other_total = sum(c.amount for c in costs)
    return WOCostSummary(
        labor_total=labor_total,
        parts_total=parts_total,
        other_total=other_total,
        grand_total=labor_total + parts_total + other_total,
    )


# ─── Actions sub-resource ─────────────────────────────────────────────────────

@router.post("/{work_order_id}/actions", response_model=WOActionOut, status_code=201)
async def add_action(
    work_order_id: UUID,
    data: WOActionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")

    action = WOAction(
        work_order_id=work_order_id,
        author_id=current_user.id,
        action_type=data.action_type,
        content=data.content,
        old_value=data.old_value,
        new_value=data.new_value,
    )
    db.add(action)
    await db.commit()
    await db.refresh(action)
    return action


@router.get("/{work_order_id}/actions", response_model=WOActionListResponse)
async def list_actions(
    work_order_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(WOAction).where(WOAction.work_order_id == work_order_id).order_by(WOAction.created_at.asc())
    )
    items = result.scalars().all()
    return WOActionListResponse(total=len(items), items=items)
