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
    StockItem, WorkOrderTechnician, PmTaskMedia,
)
from app.schemas.work_order import WorkOrderCreate, WorkOrderUpdate, WorkOrderOut, WorkOrderListResponse, WOAssign, WOSchedule
from app.schemas.wo_subresources import (
    LaborCreate, LaborOut, LaborListResponse,
    WOPartCreate, WOPartOut, WOPartListResponse,
    WOCostCreate, WOCostOut, WOCostListResponse,
    WOActionCreate, WOActionOut, WOActionListResponse, WOActionToggle,
    WOCostSummary,
)
from app.core.security import get_current_user
from app.services.inventory_service import InventoryService
from app.services.machine_history_service import MachineHistoryService
from app.services.ticket_service import sync_alert_from_ticket
from app.services import pm_service
from app.services import intervention_sync

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


async def _current_tech_ids(wo: WorkOrder, db: AsyncSession) -> list:
    """Assigned technician ids (primary first). Falls back to executor_id for
    WOs that predate the join table."""
    r = await db.execute(
        select(WorkOrderTechnician)
        .where(WorkOrderTechnician.work_order_id == wo.id)
        .order_by(WorkOrderTechnician.is_primary.desc(), WorkOrderTechnician.assigned_at)
    )
    ids = [link.technician_id for link in r.scalars().all()]
    if not ids and wo.executor_id:
        ids = [wo.executor_id]
    return ids


async def _open_labor_record(wo: WorkOrder, technician_id, db: AsyncSession, activity: str = "Repair") -> None:
    """Start the clock for a technician on an in-progress WO (skip if already running)."""
    r = await db.execute(
        select(LaborRecord).where(
            LaborRecord.work_order_id == wo.id,
            LaborRecord.technician_id == technician_id,
            LaborRecord.stopped_at.is_(None),
        )
    )
    if r.scalars().first():
        return
    tech = await db.get(Technician, technician_id)
    now = datetime.now(timezone.utc)
    db.add(LaborRecord(
        work_order_id=wo.id,
        technician_id=technician_id,
        date=now.date(),
        hours_worked=0.0,
        hourly_rate=tech.hourly_rate if tech else None,
        started_at=now,
        activity=activity,
    ))


async def _close_labor_record(wo: WorkOrder, technician_id, db: AsyncSession) -> None:
    """Stop the clock for a technician leaving an in-progress WO."""
    now = datetime.now(timezone.utc)
    r = await db.execute(
        select(LaborRecord).where(
            LaborRecord.work_order_id == wo.id,
            LaborRecord.technician_id == technician_id,
            LaborRecord.stopped_at.is_(None),
        )
    )
    for rec in r.scalars().all():
        rec.stopped_at = now
        if rec.started_at:
            started = rec.started_at if rec.started_at.tzinfo else rec.started_at.replace(tzinfo=timezone.utc)
            rec.hours_worked = round((now - started).total_seconds() / 3600, 4)
            if rec.hourly_rate:
                rec.labor_cost = round(rec.hourly_rate * rec.hours_worked, 2)


async def _sync_wo_technicians(wo: WorkOrder, technician_ids: list, db: AsyncSession) -> None:
    """Replace the WO's technician set. First id becomes primary and is
    mirrored to executor_id/assigned_to_id for backward compatibility.
    On an in-progress WO, the labor clock starts for technicians joining
    and stops for technicians leaving. Does not commit."""
    seen = []
    for tid in technician_ids:
        if tid not in seen:
            seen.append(tid)

    r = await db.execute(
        select(WorkOrderTechnician).where(WorkOrderTechnician.work_order_id == wo.id)
    )
    existing = {link.technician_id: link for link in r.scalars().all()}

    in_progress = wo.status == WorkOrderStatus.in_progress

    for tid, link in existing.items():
        if tid not in seen:
            await db.delete(link)
            if in_progress:
                await _close_labor_record(wo, tid, db)
    for i, tid in enumerate(seen):
        link = existing.get(tid)
        if link:
            link.is_primary = i == 0
        else:
            db.add(WorkOrderTechnician(work_order_id=wo.id, technician_id=tid, is_primary=i == 0))
            if in_progress:
                await _open_labor_record(wo, tid, db)

    wo.executor_id = seen[0] if seen else None
    if seen:
        primary = await db.get(Technician, seen[0])
        if primary:
            wo.assigned_to_id = primary.user_id
    else:
        wo.assigned_to_id = None

    # Keep the linked ticket's assignment mirrored to the WO
    ticket = None
    if wo.ticket_id:
        ticket = await db.get(MaintenanceTicket, wo.ticket_id)
    if not ticket:
        r = await db.execute(
            select(MaintenanceTicket).where(MaintenanceTicket.work_order_id == wo.id)
        )
        ticket = r.scalars().first()
    if ticket:
        ticket.assigned_to_id = wo.assigned_to_id


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
    # All assigned technicians (multi-technician support)
    out.technicians = []
    for tid in await _current_tech_ids(wo, db):
        tech = await db.get(Technician, tid)
        if not tech:
            continue
        user = await db.get(User, tech.user_id)
        out.technicians.append({
            "technician_id": str(tid),
            "user_id": str(tech.user_id),
            "name": user.name if user else None,
            "specialty": tech.specialty.value if tech.specialty else None,
            "is_primary": tid == wo.executor_id,
        })
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
            parts = parts_r.scalars().all()
            # Backfill description from stock items (imported items keep the
            # human-readable text in `description`, not `name`).
            missing_ids = {p.stock_item_id for p in parts if not p.item_description and p.stock_item_id}
            stock_desc = {}
            if missing_ids:
                sr = await db.execute(select(StockItem).where(StockItem.id.in_(missing_ids)))
                stock_desc = {s.id: (s.description or s.name or "") for s in sr.scalars().all()}
            out.intervention_parts = [
                {
                    "id": str(p.id),
                    "item_code": p.item_code or "",
                    "item_description": p.item_description or stock_desc.get(p.stock_item_id, ""),
                    "quantity_used": p.quantity_used,
                    "unit": p.unit or "",
                    "approval_status": p.approval_status,
                    "approved_at": p.approved_at.isoformat() if p.approved_at else None,
                }
                for p in parts
            ]
    return out


async def _generate_work_order_number(db: AsyncSession) -> str:
    from app.services.numbering import next_number
    year = datetime.now(timezone.utc).year
    return await next_number(db, WorkOrder.wo_number, f"WO-{year}")


@router.get("/my", response_model=WorkOrderListResponse)
async def my_work_orders(
    status: Optional[WorkOrderStatus] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """WOs the current user is actually working on: ones where they are an
    assigned technician (or executor). WOs staffed by other technicians never
    show here — even for the supervisor/admin who created or started them.
    Unstaffed WOs assigned directly to the user are still included."""
    from sqlalchemy import select as _sel, exists

    r = await db.execute(
        _sel(Technician).where(Technician.user_id == current_user.id)
    )
    tech = r.scalar_one_or_none()

    staffed = exists(
        _sel(WorkOrderTechnician.work_order_id).where(
            WorkOrderTechnician.work_order_id == WorkOrder.id
        )
    )
    unstaffed_mine = (
        (WorkOrder.assigned_to_id == current_user.id)
        & ~staffed
        & WorkOrder.executor_id.is_(None)
    )

    if tech:
        wot_sub = _sel(WorkOrderTechnician.work_order_id).where(
            WorkOrderTechnician.technician_id == tech.id
        )
        cond = (
            (WorkOrder.executor_id == tech.id)
            | (WorkOrder.id.in_(wot_sub))
            | unstaffed_mine
        )
    else:
        cond = unstaffed_mine

    query = _sel(WorkOrder).where(cond)
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

    # Batch-load assigned technicians for the whole page (avoids N+1)
    tech_map: dict = {}
    wo_ids = [wo.id for wo in items]
    fallback_exec_ids = {wo.executor_id for wo in items if wo.executor_id}
    if wo_ids:
        links_r = await db.execute(
            select(WorkOrderTechnician, Technician, User)
            .join(Technician, WorkOrderTechnician.technician_id == Technician.id)
            .join(User, Technician.user_id == User.id, isouter=True)
            .where(WorkOrderTechnician.work_order_id.in_(wo_ids))
            .order_by(WorkOrderTechnician.is_primary.desc(), WorkOrderTechnician.assigned_at)
        )
        for link, tech, user in links_r.all():
            tech_map.setdefault(link.work_order_id, []).append({
                "technician_id": str(link.technician_id),
                "user_id": str(tech.user_id),
                "name": user.name if user else None,
                "specialty": tech.specialty.value if tech.specialty else None,
                "is_primary": bool(link.is_primary),
            })
    # Fallback for WOs predating the join table: synthesize from executor_id
    exec_map: dict = {}
    if fallback_exec_ids:
        execs_r = await db.execute(
            select(Technician, User)
            .join(User, Technician.user_id == User.id, isouter=True)
            .where(Technician.id.in_(fallback_exec_ids))
        )
        for tech, user in execs_r.all():
            exec_map[tech.id] = {
                "technician_id": str(tech.id),
                "user_id": str(tech.user_id),
                "name": user.name if user else None,
                "specialty": tech.specialty.value if tech.specialty else None,
                "is_primary": True,
            }

    # Batch-load equipment name/location for the whole page (avoids N+1)
    equip_map: dict = {}
    equip_ids = {wo.equipment_id for wo in items if wo.equipment_id}
    if equip_ids:
        eq_r = await db.execute(
            select(Equipment.id, Equipment.name, Equipment.location)
            .where(Equipment.id.in_(equip_ids))
        )
        for eq_id, eq_name, eq_loc in eq_r.all():
            equip_map[eq_id] = (eq_name, eq_loc)

    wo_list = []
    for wo in items:
        wo_data = WorkOrderOut.model_validate(wo)
        equip = equip_map.get(wo.equipment_id)
        if equip:
            wo_data.equipment_name, wo_data.equipment_location = equip
        wo_data.technicians = tech_map.get(wo.id, [])
        if not wo_data.technicians and wo.executor_id in exec_map:
            wo_data.technicians = [exec_map[wo.executor_id]]
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

    if wo.executor_id:
        await _sync_wo_technicians(wo, [wo.executor_id], db)
        if data.assigned_to_id:
            wo.assigned_to_id = data.assigned_to_id
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
            await _enforce_checklist_for_completion(wo, db)
            update_data["completed_at"] = datetime.now(timezone.utc)
        elif new_status == WorkOrderStatus.on_hold:
            await _close_open_labor_records(work_order_id, db)

    for field, value in update_data.items():
        setattr(wo, field, value)

    if "executor_id" in update_data:
        await _sync_wo_technicians(wo, [update_data["executor_id"]], db)
        if "assigned_to_id" in update_data:
            wo.assigned_to_id = update_data["assigned_to_id"]

    # Keep the machine page's intervention state in sync with WO status
    if "status" in update_data:
        if wo.status == WorkOrderStatus.in_progress:
            await intervention_sync.on_wo_started(db, wo, current_user.name)
        elif wo.status in (WorkOrderStatus.completed, WorkOrderStatus.cancelled):
            await intervention_sync.on_wo_finished(db, wo)

    await db.commit()
    await db.refresh(wo)

    if "status" in update_data:
        await _sync_ticket_from_wo(wo, db)
        await db.commit()

        if wo.status == WorkOrderStatus.completed:
            await pm_service.on_work_order_completed(db, wo)

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
    if data.technician_ids is not None:
        ids = data.technician_ids
    elif data.executor_id:
        ids = [data.executor_id]
    else:
        ids = []
    await _sync_wo_technicians(wo, ids, db)
    await _sync_ticket_from_wo(wo, db)
    await db.commit()
    await db.refresh(wo)
    return await _enrich_wo(wo, db)


@router.post("/{work_order_id}/technicians/{technician_id}", response_model=WorkOrderOut)
async def add_wo_technician(
    work_order_id: UUID,
    technician_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    tech = await db.get(Technician, technician_id)
    if not tech:
        raise HTTPException(status_code=404, detail="Technician not found")
    ids = await _current_tech_ids(wo, db)
    if technician_id not in ids:
        ids.append(technician_id)
        await _sync_wo_technicians(wo, ids, db)
        await db.commit()
        await db.refresh(wo)
    return await _enrich_wo(wo, db)


@router.delete("/{work_order_id}/technicians/{technician_id}", response_model=WorkOrderOut)
async def remove_wo_technician(
    work_order_id: UUID,
    technician_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    ids = await _current_tech_ids(wo, db)
    if technician_id in ids:
        ids.remove(technician_id)
        await _sync_wo_technicians(wo, ids, db)
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
    # Scheduling for one technician keeps the others assigned; the scheduled
    # tech becomes primary.
    ids = await _current_tech_ids(wo, db)
    ids = [data.executor_id] + [t for t in ids if t != data.executor_id]
    await _sync_wo_technicians(wo, ids, db)
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
        ids = await _current_tech_ids(wo, db)
        if tech.id not in ids:
            await _sync_wo_technicians(wo, ids + [tech.id], db)
            wo.assigned_to_id = current_user.id

    # Start the labor clock for every assigned technician, not just the presser
    for tid in await _current_tech_ids(wo, db):
        await _open_labor_record(wo, tid, db)

    await intervention_sync.on_wo_started(db, wo, current_user.name)

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
        ids = await _current_tech_ids(wo, db)
        if tech.id not in ids:
            await _sync_wo_technicians(wo, ids + [tech.id], db)
            wo.assigned_to_id = current_user.id

    # Restart the labor clock for every assigned technician
    for tid in await _current_tech_ids(wo, db):
        await _open_labor_record(wo, tid, db, activity="Resumed repair")

    await intervention_sync.on_wo_started(db, wo, current_user.name)

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

    await _enforce_checklist_for_completion(wo, db)

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

    # Close the machine's active intervention so the kiosk goes back to normal
    await intervention_sync.on_wo_finished(db, wo)

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

    await pm_service.on_work_order_completed(db, wo)

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


async def _enforce_checklist_for_completion(wo: WorkOrder, db: AsyncSession) -> None:
    """Block completion per the WO's checklist rigor: advisory → no check;
    required → all required steps checked; strict → also each with a proof photo."""
    level = wo.checklist_enforcement or "advisory"
    if level == "advisory":
        return
    r = await db.execute(
        select(WOAction).where(
            WOAction.work_order_id == wo.id,
            WOAction.action_type == "checklist",
            WOAction.is_required == True,
        )
    )
    required = r.scalars().all()
    incomplete = [a for a in required if not a.is_completed]
    if incomplete:
        raise HTTPException(
            status_code=409,
            detail=f"{len(incomplete)} étape(s) obligatoire(s) non complétée(s) — terminez la procédure avant de clôturer.",
        )
    if level == "strict":
        no_proof = [a for a in required if not a.proof_photo_url]
        if no_proof:
            raise HTTPException(
                status_code=409,
                detail=f"{len(no_proof)} étape(s) obligatoire(s) sans photo de preuve — ajoutez la photo avant de clôturer.",
            )


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

    # Live SOP media — pull photos/videos/links from each linked template step
    task_ids = [a.template_task_id for a in items if a.template_task_id]
    media_map: dict = {}
    if task_ids:
        mr = await db.execute(
            select(PmTaskMedia).where(PmTaskMedia.task_id.in_(task_ids)).order_by(PmTaskMedia.sort_order)
        )
        for m in mr.scalars().all():
            media_map.setdefault(m.task_id, []).append({
                "id": str(m.id), "media_type": m.media_type, "url": m.url,
                "caption": m.caption, "sort_order": m.sort_order,
            })

    out = []
    for a in items:
        d = WOActionOut.model_validate(a)
        if a.template_task_id:
            d.media = media_map.get(a.template_task_id, [])
        out.append(d)
    return WOActionListResponse(total=len(out), items=out)


@router.patch("/{work_order_id}/actions/{action_id}/toggle", response_model=WOActionOut)
async def toggle_checklist_item(
    work_order_id: UUID,
    action_id: UUID,
    data: WOActionToggle,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    action = await db.get(WOAction, action_id)
    if not action or action.work_order_id != work_order_id:
        raise HTTPException(status_code=404, detail="Action not found")

    action.is_completed = data.is_completed
    action.completed_at = datetime.now(timezone.utc) if data.is_completed else None
    action.completed_by_id = current_user.id if data.is_completed else None

    # Recompute the work order's checklist completion ratio
    checklist_result = await db.execute(
        select(WOAction).where(
            WOAction.work_order_id == work_order_id,
            WOAction.action_type == "checklist",
        )
    )
    checklist_items = checklist_result.scalars().all()
    if checklist_items:
        wo = await db.get(WorkOrder, work_order_id)
        if wo:
            completed = sum(1 for a in checklist_items if a.is_completed)
            wo.completion_ratio = round(completed / len(checklist_items), 4)

    await db.commit()
    await db.refresh(action)
    return action


@router.patch("/{work_order_id}/actions/{action_id}/proof", response_model=WOActionOut)
async def set_action_proof(
    work_order_id: UUID,
    action_id: UUID,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Attach (or clear) the technician's proof photo for a checklist step."""
    action = await db.get(WOAction, action_id)
    if not action or action.work_order_id != work_order_id:
        raise HTTPException(status_code=404, detail="Action not found")
    action.proof_photo_url = body.get("url") or None
    await db.commit()
    await db.refresh(action)
    return action


@router.patch("/board/reorder", status_code=200)
async def reorder_board(
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Persist the manual priority order of (not-started) work orders in a
    technician's scheduler column. board_order ascending = top of the column."""
    ids = body.get("wo_ids", []) or []
    n = 0
    for i, wid in enumerate(ids):
        try:
            uid = UUID(str(wid))
        except (ValueError, TypeError):
            continue
        wo = await db.get(WorkOrder, uid)
        if wo:
            wo.board_order = i
            n += 1
    await db.commit()
    return {"status": "ok", "count": n}


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
