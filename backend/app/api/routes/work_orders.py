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
    MaintenanceTicket, TicketStatus, MachineIntervention, InterventionPart,
)
from app.schemas.work_order import WorkOrderCreate, WorkOrderUpdate, WorkOrderOut, WorkOrderListResponse, WOAssign, WOSchedule
from app.schemas.wo_subresources import (
    LaborCreate, LaborOut, LaborListResponse,
    WOPartCreate, WOPartOut, WOPartListResponse,
    WOCostCreate, WOCostOut, WOCostListResponse,
    WOActionCreate, WOActionOut, WOActionListResponse,
    WOCostSummary,
)
from app.core.security import get_current_user
from app.services.inventory_service import InventoryService
from app.services.machine_history_service import MachineHistoryService
from app.services.ticket_service import sync_alert_from_ticket

router = APIRouter()


async def _sync_ticket_from_wo(wo: WorkOrder, db: AsyncSession) -> None:
    if not wo.ticket_id:
        return
    ticket = await db.get(MaintenanceTicket, wo.ticket_id)
    if not ticket:
        return
    status = wo.status.value if hasattr(wo.status, "value") else str(wo.status)
    if status == WorkOrderStatus.in_progress:
        ticket.status = TicketStatus.in_progress
    elif status == WorkOrderStatus.completed:
        ticket.status = TicketStatus.completed
    # open/assigned → keep ticket as assigned
    await sync_alert_from_ticket(ticket, db)


async def _resolve_tech_for_labor(wo: WorkOrder, current_user: User, db: AsyncSession) -> Optional[Technician]:
    """Return the best technician to attribute a labor record to.
    Priority: current user's own profile → wo.executor_id technician."""
    r = await db.execute(select(Technician).where(Technician.user_id == current_user.id))
    tech = r.scalar_one_or_none()
    if tech:
        return tech
    if wo.executor_id:
        return await db.get(Technician, wo.executor_id)
    return None


async def _close_open_labor_records(work_order_id: UUID, db: AsyncSession) -> None:
    """Stamp stopped_at on any in-flight labor records and compute hours_worked."""
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(LaborRecord).where(
            LaborRecord.work_order_id == work_order_id,
            LaborRecord.stopped_at.is_(None),
        )
    )
    for rec in result.scalars().all():
        rec.stopped_at = now
        if rec.started_at:
            elapsed = (now - rec.started_at).total_seconds() / 3600
            rec.hours_worked = round(elapsed, 4)
            tech = await db.get(Technician, rec.technician_id)
            rate = rec.hourly_rate or (tech.hourly_rate if tech else None)
            if rate:
                rec.hourly_rate = rate
                rec.labor_cost = round(rate * rec.hours_worked, 2)


async def _enrich_wo(wo: WorkOrder, db: AsyncSession) -> WorkOrderOut:
    out = WorkOrderOut.model_validate(wo)
    equip = await db.get(Equipment, wo.equipment_id)
    if equip:
        out.equipment_name = equip.name
        out.equipment_location = equip.location
    if wo.ticket_id:
        ticket = await db.get(MaintenanceTicket, wo.ticket_id)
        if ticket:
            out.ticket_number = ticket.ticket_number
    if wo.assigned_to_id:
        user = await db.get(User, wo.assigned_to_id)
        if user:
            out.assigned_to_name = user.name
    if wo.executor_id:
        tech = await db.get(Technician, wo.executor_id)
        if tech:
            user = await db.get(User, tech.user_id)
            if user:
                out.executor_name = user.name
    # Fetch parts from linked intervention (kiosk-added parts)
    if wo.ticket_id:
        intervention_r = await db.execute(
            select(MachineIntervention).where(MachineIntervention.ticket_id == wo.ticket_id)
        )
        intervention = intervention_r.scalar_one_or_none()
        if intervention:
            parts_r = await db.execute(
                select(InterventionPart)
                .where(InterventionPart.intervention_id == intervention.id)
                .order_by(InterventionPart.added_at)
            )
            out.intervention_parts = [
                {
                    "id": str(p.id),
                    "item_code": p.item_code or "",
                    "item_description": p.item_description or "",
                    "quantity_used": p.quantity_used,
                    "unit": p.unit or "",
                    "approval_status": p.approval_status,
                    "approved_at": p.approved_at.isoformat() if p.approved_at else None,
                }
                for p in parts_r.scalars().all()
            ]
    return out


async def _generate_work_order_number(db: AsyncSession) -> str:
    year = datetime.now(timezone.utc).year
    result = await db.execute(
        select(func.count(WorkOrder.id)).where(
            func.extract("year", WorkOrder.opened_at) == year
        )
    )
    count = result.scalar() + 1
    return f"WO-{year}-{count:05d}"


@router.get("/my", response_model=WorkOrderListResponse)
async def my_work_orders(
    status: Optional[WorkOrderStatus] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Returns WOs where current user is the assigned executor."""
    # Find technician profile for this user
    from sqlalchemy import select as _sel
    r = await db.execute(
        _sel(Technician).where(Technician.user_id == current_user.id)
    )
    tech = r.scalar_one_or_none()

    query = _sel(WorkOrder).where(WorkOrder.assigned_to_id == current_user.id)
    if tech:
        query = _sel(WorkOrder).where(
            (WorkOrder.assigned_to_id == current_user.id) |
            (WorkOrder.executor_id == tech.id)
        )
    if status:
        query = query.where(WorkOrder.status == status)
    query = query.order_by(WorkOrder.opened_at.desc())

    result = await db.execute(query)
    items = result.scalars().all()

    wo_list = []
    for wo in items:
        wo_list.append(await _enrich_wo(wo, db))

    return WorkOrderListResponse(total=len(wo_list), items=wo_list)


@router.get("/", response_model=WorkOrderListResponse)
async def list_work_orders(
    plant_id: Optional[UUID] = None,
    equipment_id: Optional[UUID] = None,
    machine_id: Optional[UUID] = None,
    status: Optional[WorkOrderStatus] = None,
    status_not: Optional[str] = None,
    type: Optional[WorkOrderType] = None,
    priority: Optional[WorkOrderPriority] = None,
    assigned_to_id: Optional[UUID] = None,
    executor_id: Optional[UUID] = None,
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
    if machine_id:
        query = query.where(WorkOrder.machine_id == machine_id)
    if status:
        query = query.where(WorkOrder.status == status)
    if status_not:
        excluded = [s.strip() for s in status_not.split(",") if s.strip()]
        if excluded:
            query = query.where(WorkOrder.status.not_in(excluded))
    if type:
        query = query.where(WorkOrder.type == type)
    if priority:
        query = query.where(WorkOrder.priority == priority)
    if assigned_to_id:
        query = query.where(WorkOrder.assigned_to_id == assigned_to_id)
    if executor_id:
        query = query.where(WorkOrder.executor_id == executor_id)
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
    return await _enrich_wo(wo, db)


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
        new_status = update_data["status"]
        if new_status == WorkOrderStatus.in_progress and not wo.started_at:
            update_data["started_at"] = datetime.now(timezone.utc)
        elif new_status == WorkOrderStatus.completed and not wo.completed_at:
            update_data["completed_at"] = datetime.now(timezone.utc)
        elif new_status == WorkOrderStatus.on_hold:
            await _close_open_labor_records(work_order_id, db)

    for field, value in update_data.items():
        setattr(wo, field, value)

    await db.commit()
    await db.refresh(wo)

    if "status" in update_data:
        await _sync_ticket_from_wo(wo, db)
        await db.commit()

    return await _enrich_wo(wo, db)


@router.patch("/{work_order_id}/assign", response_model=WorkOrderOut)
async def assign_work_order(
    work_order_id: UUID,
    data: WOAssign,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    wo.executor_id = data.executor_id
    if wo.ticket_id:
        ticket = await db.get(MaintenanceTicket, wo.ticket_id)
        if ticket:
            ticket.status = TicketStatus.assigned
    await db.commit()
    await db.refresh(wo)
    return await _enrich_wo(wo, db)


@router.post("/{work_order_id}/schedule", response_model=WorkOrderOut)
async def schedule_work_order(
    work_order_id: UUID,
    data: WOSchedule,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    wo.executor_id          = data.executor_id
    wo.scheduled_date       = data.scheduled_date
    wo.scheduled_start_time = data.scheduled_start_time
    wo.scheduled_end_time   = data.scheduled_end_time
    await db.commit()
    await db.refresh(wo)
    return await _enrich_wo(wo, db)


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

    now = datetime.now(timezone.utc)
    wo.status = WorkOrderStatus.in_progress
    wo.started_at = now
    wo.assigned_to_id = current_user.id

    tech = await _resolve_tech_for_labor(wo, current_user, db)
    if tech:
        db.add(LaborRecord(
            work_order_id=work_order_id,
            technician_id=tech.id,
            date=now.date(),
            hours_worked=0.0,
            hourly_rate=tech.hourly_rate,
            started_at=now,
            activity="Repair",
        ))

    await db.commit()
    await db.refresh(wo)
    return await _enrich_wo(wo, db)


@router.post("/{work_order_id}/resume", response_model=WorkOrderOut)
async def resume_work_order(
    work_order_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(WorkOrder).where(WorkOrder.id == work_order_id))
    wo = result.scalar_one_or_none()
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    if wo.status != WorkOrderStatus.on_hold:
        raise HTTPException(status_code=400, detail="Work order is not on hold")

    now = datetime.now(timezone.utc)
    wo.status = WorkOrderStatus.in_progress
    wo.assigned_to_id = current_user.id

    tech = await _resolve_tech_for_labor(wo, current_user, db)
    if tech:
        db.add(LaborRecord(
            work_order_id=work_order_id,
            technician_id=tech.id,
            date=now.date(),
            hours_worked=0.0,
            hourly_rate=tech.hourly_rate,
            started_at=now,
            activity="Resumed repair",
        ))

    await db.commit()
    await db.refresh(wo)
    await _sync_ticket_from_wo(wo, db)
    await db.commit()
    return await _enrich_wo(wo, db)


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

    now = datetime.now(timezone.utc)
    wo.status = WorkOrderStatus.completed
    wo.completed_at = now
    if root_cause:
        wo.root_cause = root_cause
    if solution_applied:
        wo.solution_applied = solution_applied
    if downtime_hours:
        wo.downtime_hours = downtime_hours
        wo.actual_downtime_minutes = int(downtime_hours * 60)

    # Close any in-flight labor records
    await _close_open_labor_records(work_order_id, db)

    # Sum all labor records (open ones were just closed above)
    labor_result = await db.execute(
        select(LaborRecord).where(LaborRecord.work_order_id == work_order_id)
    )
    labor_records = labor_result.scalars().all()

    if repair_hours:
        wo.repair_hours = repair_hours
        wo.total_minutes = int(repair_hours * 60)
    else:
        computed_minutes = int(sum(r.hours_worked for r in labor_records) * 60)
        if computed_minutes > 0:
            wo.total_minutes = computed_minutes
            wo.repair_hours = round(computed_minutes / 60.0, 4)
        elif wo.started_at:
            elapsed_minutes = int((now - wo.started_at).total_seconds() / 60)
            if elapsed_minutes > 0:
                wo.total_minutes = elapsed_minutes
                wo.repair_hours = round(elapsed_minutes / 60.0, 4)

    # Roll up total_cost = labor + parts
    labor_cost_total = sum(r.labor_cost or 0.0 for r in labor_records)
    parts_result = await db.execute(
        select(WOPart).where(WOPart.work_order_id == work_order_id)
    )
    parts_cost_total = sum(p.total_cost or 0.0 for p in parts_result.scalars().all())
    wo.total_cost = round(labor_cost_total + parts_cost_total, 2) or None

    await db.commit()
    await db.refresh(wo)

    # Record machine history
    try:
        svc = MachineHistoryService(db)
        await svc.record_from_wo(wo)
        await db.commit()
    except Exception:
        pass  # Don't fail the WO completion if history fails

    # Sync ticket
    await _sync_ticket_from_wo(wo, db)
    await db.commit()

    return await _enrich_wo(wo, db)


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
    records = result.scalars().all()
    items = []
    for rec in records:
        out = LaborOut.model_validate(rec)
        tech = await db.get(Technician, rec.technician_id)
        if tech:
            user = await db.get(User, tech.user_id)
            if user:
                out.technician_name = user.name
        items.append(out)
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

    # If linked to a stock item, fetch unit cost and deduct inventory
    unit_cost = data.unit_cost
    if data.stock_item_id:
        try:
            inv_svc = InventoryService(db)
            await inv_svc.deduct_stock(
                data.stock_item_id, data.quantity,
                work_order_id=work_order_id,
                user_id=current_user.id,
                notes=f"Used in WO {wo.wo_number}",
            )
            from app.models.models import StockItem
            item = await db.get(StockItem, data.stock_item_id)
            if item and not unit_cost:
                unit_cost = item.unit_cost
        except Exception:
            pass  # Don't fail part creation if deduction fails

    total_cost = (unit_cost * data.quantity) if unit_cost else None
    part = WOPart(
        work_order_id=work_order_id,
        stock_item_id=data.stock_item_id,
        part_number=data.part_number,
        description=data.description,
        quantity=data.quantity,
        unit=data.unit,
        unit_cost=unit_cost,
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


@router.delete("/{work_order_id}", status_code=204)
async def delete_work_order(
    work_order_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    # Null out the ticket's work_order_id so the ticket is not orphaned
    if wo.ticket_id:
        ticket = await db.get(MaintenanceTicket, wo.ticket_id)
        if ticket:
            ticket.work_order_id = None
    await db.delete(wo)
    await db.commit()
