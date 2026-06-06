import re
from datetime import datetime, timezone, date
from uuid import UUID
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.db.session import get_db
from app.models.models import (
    Machine, MaintenanceTicket, TicketStatus, WorkOrder,
    User, MachineStatus, AlertPriority,
    MachineStop, MachineOperator, StopCategory, StopSubcategory,
    AlertShift,
)
from app.schemas.maintenance import (
    MachineOut, MachineListResponse, MachinePageData, TicketForMachine,
    MachineStatusUpdate, MaintenanceRequestCreate, MESData,
    MachineJobUpdate, MachineOperatorUpdate, MachineConfigUpdate,
    MachineRejectUpdate, MachineStopCreate, MachineStopClose,
    MachineStopOut, StopCategoryMini, StopSubcategoryMini,
    MachineOperatorOut, MachineOperatorCreate, MachineOperatorUpdate as OperatorPatch,
    MESDataExtended,
)
from app.core.security import get_current_user
from app.services.ticket_service import TicketService, _next_ticket_number
from app.services.mes_service import MesService

router = APIRouter()

_UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


async def _get_machine(ref: str, db: AsyncSession) -> Machine:
    if _UUID_RE.match(ref):
        m = await db.get(Machine, ref)
    else:
        r = await db.execute(select(Machine).where(Machine.page_slug == ref))
        m = r.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Machine not found")
    return m


def _machine_to_page_data(machine: Machine, open_tickets: list) -> MachinePageData:
    cstatus = machine.current_status.value if hasattr(machine.current_status, "value") else str(machine.current_status or MachineStatus.running)
    cshift  = machine.current_shift.value if machine.current_shift and hasattr(machine.current_shift, "value") else (str(machine.current_shift) if machine.current_shift else None)
    clang   = machine.page_language.value if machine.page_language and hasattr(machine.page_language, "value") else (str(machine.page_language) if machine.page_language else "fr")
    return MachinePageData(
        id=machine.id, name=machine.name, code=machine.code,
        department=machine.department, location=machine.location,
        is_active=machine.is_active,
        current_status=cstatus,
        current_operator=machine.current_operator,
        current_shift=cshift,
        current_job_number=machine.current_job_number,
        last_maintenance_at=machine.last_maintenance_at,
        last_stop_at=machine.last_stop_at,
        last_start_at=machine.last_start_at,
        page_slug=machine.page_slug,
        page_language=clang,
        target_availability_pct=machine.target_availability_pct or 70.0,
        target_count=machine.target_count,
        show_production_panel=machine.show_production_panel if machine.show_production_panel is not None else True,
        show_reject_panel=machine.show_reject_panel if machine.show_reject_panel is not None else True,
        show_availability_gauge=machine.show_availability_gauge if machine.show_availability_gauge is not None else True,
        show_job_number=machine.show_job_number if machine.show_job_number is not None else True,
        custom_color=machine.custom_color,
        display_name=machine.display_name,
        open_tickets=open_tickets,
    )


# ── List machines (auth required) ─────────────────────────────────────────────

@router.get("/", response_model=MachineListResponse)
async def list_machines(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    r = await db.execute(select(Machine).order_by(Machine.name))
    items = r.scalars().all()
    return MachineListResponse(total=len(items), items=items)


# ── Machine page (no auth — kiosk mode) ───────────────────────────────────────

@router.get("/{ref}/page", response_model=MachinePageData)
async def machine_page(ref: str, db: AsyncSession = Depends(get_db)):
    machine = await _get_machine(ref, db)
    closed = [TicketStatus.completed, TicketStatus.cancelled]
    r = await db.execute(
        select(MaintenanceTicket)
        .where(
            MaintenanceTicket.machine_id == machine.id,
            MaintenanceTicket.status.not_in(closed),
        )
        .order_by(MaintenanceTicket.opened_at.desc())
    )
    raw_tickets = r.scalars().all()

    open_tickets = []
    for t in raw_tickets:
        assigned_name = None
        if t.assigned_to_id:
            u = await db.get(User, t.assigned_to_id)
            if u:
                assigned_name = u.name
        wo_number = None
        if t.work_order_id:
            wo = await db.get(WorkOrder, t.work_order_id)
            if wo:
                wo_number = wo.wo_number
        ptype = t.problem_type.value if t.problem_type and hasattr(t.problem_type, "value") else (str(t.problem_type) if t.problem_type else None)
        open_tickets.append(TicketForMachine(
            id=t.id, ticket_number=t.ticket_number,
            status=t.status.value if hasattr(t.status, "value") else str(t.status),
            priority=t.priority.value if hasattr(t.priority, "value") else str(t.priority),
            problem_type=ptype, description=t.description,
            assigned_to_name=assigned_name, opened_at=t.opened_at,
            opened_by_technician_at=t.opened_by_technician_at,
            work_order_id=t.work_order_id, work_order_number=wo_number,
        ))

    return _machine_to_page_data(machine, open_tickets)


# ── Status update ─────────────────────────────────────────────────────────────

@router.patch("/{ref}/status")
async def update_machine_status(
    ref: str,
    data: MachineStatusUpdate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    now = datetime.now(timezone.utc)
    old_status = machine.current_status.value if hasattr(machine.current_status, "value") else str(machine.current_status or "running")

    machine.current_status = data.status
    if data.current_operator is not None:
        machine.current_operator = data.current_operator
    if data.current_shift is not None:
        machine.current_shift = data.current_shift

    new_status = data.status.value if hasattr(data.status, "value") else str(data.status)
    if new_status == MachineStatus.running.value and old_status != MachineStatus.running.value:
        machine.last_start_at = now
    elif new_status != MachineStatus.running.value and old_status == MachineStatus.running.value:
        machine.last_stop_at = now

    await db.commit()
    return {"status": "ok"}


# ── Job number ────────────────────────────────────────────────────────────────

@router.patch("/{ref}/job")
async def update_job_number(
    ref: str,
    data: MachineJobUpdate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    machine.current_job_number = data.job_number
    await db.commit()
    return {"status": "ok", "job_number": machine.current_job_number}


# ── Operator selection ────────────────────────────────────────────────────────

@router.patch("/{ref}/operator")
async def update_operator(
    ref: str,
    data: MachineOperatorUpdate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    if data.operator_name is not None:
        machine.current_operator = data.operator_name
    if data.operator_id is not None:
        op = await db.get(MachineOperator, data.operator_id)
        if op:
            machine.current_operator = op.name
    await db.commit()
    return {"status": "ok", "current_operator": machine.current_operator}


# ── Reject counter ────────────────────────────────────────────────────────────

@router.post("/{ref}/rejects")
async def add_rejects(
    ref: str,
    data: MachineRejectUpdate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    shift_str = machine.current_shift.value if machine.current_shift and hasattr(machine.current_shift, "value") else "morning"
    svc = MesService(db)
    new_total = await svc.increment_rejects(machine.id, data.delta, shift_str)
    return {"status": "ok", "reject_count": new_total}


# ── Machine stops ─────────────────────────────────────────────────────────────

@router.post("/{ref}/stops", status_code=201)
async def create_stop(
    ref: str,
    data: MachineStopCreate,
    db: AsyncSession = Depends(get_db),
):
    """Create a stop record. If subcategory triggersMaintenance, also creates a ticket."""
    machine = await _get_machine(ref, db)
    now = datetime.now(timezone.utc)

    # Determine if this stop triggers maintenance
    triggers = False
    if data.stop_subcategory_id:
        sub = await db.get(StopSubcategory, data.stop_subcategory_id)
        if sub and sub.triggers_maintenance:
            triggers = True
    elif data.stop_category_id:
        cat = await db.get(StopCategory, data.stop_category_id)
        if cat and cat.type.value == "maintenance":
            triggers = True

    stop = MachineStop(
        machine_id=machine.id,
        started_at=now,
        stop_category_id=data.stop_category_id,
        stop_subcategory_id=data.stop_subcategory_id,
        comments=data.comments,
        justified_by=data.justified_by,
    )

    ticket_number = None
    if triggers:
        ticket = MaintenanceTicket(
            ticket_number=await _next_ticket_number(db),
            machine_id=machine.id,
            priority=AlertPriority.high,
            problem_type=None,
            description=data.comments,
            machine_page_source=True,
        )
        db.add(ticket)
        await db.flush()
        stop.ticket_id = ticket.id
        ticket_number = ticket.ticket_number
        machine.current_status = MachineStatus.maintenance
        machine.last_maintenance_at = now
    else:
        machine.current_status = MachineStatus.stopped

    machine.last_stop_at = now
    db.add(stop)
    await db.commit()
    await db.refresh(stop)

    return {
        "id": str(stop.id),
        "started_at": stop.started_at.isoformat(),
        "ticket_number": ticket_number,
        "triggers_maintenance": triggers,
    }


@router.patch("/{ref}/stops/{stop_id}/close")
async def close_stop(
    ref: str,
    stop_id: UUID,
    data: MachineStopClose,
    db: AsyncSession = Depends(get_db),
):
    """Close a stop record and set machine back to running."""
    machine = await _get_machine(ref, db)
    stop = await db.get(MachineStop, stop_id)
    if not stop or stop.machine_id != machine.id:
        raise HTTPException(404, "Stop not found")

    now = datetime.now(timezone.utc)
    stop.ended_at = now
    started = stop.started_at
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    stop.duration_minutes = int((now - started).total_seconds() / 60)

    if data.stop_category_id:
        stop.stop_category_id = data.stop_category_id
    if data.stop_subcategory_id:
        stop.stop_subcategory_id = data.stop_subcategory_id
    if data.comments:
        stop.comments = data.comments
    if data.justified_by:
        stop.justified_by = data.justified_by

    machine.current_status = MachineStatus.running
    machine.last_start_at = now

    await db.commit()
    return {"status": "ok", "duration_minutes": stop.duration_minutes}


@router.get("/{ref}/stops/today", response_model=List[MachineStopOut])
async def today_stops(ref: str, db: AsyncSession = Depends(get_db)):
    machine = await _get_machine(ref, db)
    today = date.today()
    r = await db.execute(
        select(MachineStop)
        .where(
            MachineStop.machine_id == machine.id,
            func.date(MachineStop.started_at) == today,
        )
        .order_by(MachineStop.started_at)
    )
    stops = r.scalars().all()
    result = []
    for s in stops:
        cat_mini = None
        if s.stop_category_id:
            cat = await db.get(StopCategory, s.stop_category_id)
            if cat:
                cat_mini = StopCategoryMini(
                    id=cat.id, name=cat.name, icon=cat.icon, color=cat.color,
                    type=cat.type.value if hasattr(cat.type, "value") else str(cat.type),
                )
        sub_mini = None
        if s.stop_subcategory_id:
            sub = await db.get(StopSubcategory, s.stop_subcategory_id)
            if sub:
                sub_mini = StopSubcategoryMini(
                    id=sub.id, name=sub.name, icon=sub.icon, color=sub.color,
                    triggers_maintenance=sub.triggers_maintenance,
                )
        result.append(MachineStopOut(
            id=s.id, machine_id=s.machine_id,
            started_at=s.started_at, ended_at=s.ended_at,
            duration_minutes=s.duration_minutes,
            comments=s.comments, justified_by=s.justified_by,
            ticket_id=s.ticket_id,
            category=cat_mini, subcategory=sub_mini,
        ))
    return result


# ── MES data (extended) ───────────────────────────────────────────────────────

@router.get("/{ref}/mes-data", response_model=MESDataExtended)
async def mes_data(ref: str, db: AsyncSession = Depends(get_db)):
    machine = await _get_machine(ref, db)
    svc = MesService(db)
    availability = await svc.get_availability(machine.id, date.today())
    downtime_min = await svc.get_today_downtime_minutes(machine.id)
    rejects = await svc.get_today_rejects(machine.id)
    return MESDataExtended(
        production_count=svc.get_mock_production_count(),
        target=svc.get_mock_target(),
        oee_pct=svc.get_mock_oee(),
        availability_pct=availability,
        reject_count=rejects,
        downtime_today_minutes=downtime_min,
        is_placeholder=True,
    )


# ── Machine config ────────────────────────────────────────────────────────────

@router.patch("/{ref}/config")
async def update_config(
    ref: str,
    data: MachineConfigUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    machine = await _get_machine(ref, db)
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(machine, k, v)
    await db.commit()
    return {"status": "ok"}


# ── Operators ─────────────────────────────────────────────────────────────────

@router.get("/{ref}/operators", response_model=List[MachineOperatorOut])
async def list_operators(
    ref: str,
    shift: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    q = select(MachineOperator).where(
        MachineOperator.machine_id == machine.id,
        MachineOperator.is_active == True,
    )
    if shift:
        from app.models.models import OperatorShift
        q = q.where(
            (MachineOperator.shift == OperatorShift(shift)) |
            (MachineOperator.shift == OperatorShift.all)
        )
    r = await db.execute(q.order_by(MachineOperator.name))
    return r.scalars().all()


@router.post("/{ref}/operators", response_model=MachineOperatorOut, status_code=201)
async def add_operator(
    ref: str,
    data: MachineOperatorCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    machine = await _get_machine(ref, db)
    op = MachineOperator(machine_id=machine.id, **data.model_dump())
    db.add(op)
    await db.commit()
    await db.refresh(op)
    return op


@router.patch("/operators/{op_id}", response_model=MachineOperatorOut)
async def update_operator_record(
    op_id: UUID,
    data: OperatorPatch,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    op = await db.get(MachineOperator, op_id)
    if not op:
        raise HTTPException(404, "Operator not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(op, k, v)
    await db.commit()
    await db.refresh(op)
    return op


# ── Request maintenance (legacy endpoint, kept for backwards compat) ──────────

@router.post("/{ref}/request-maintenance", status_code=201)
async def request_maintenance(
    ref: str,
    data: MaintenanceRequestCreate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    ticket = MaintenanceTicket(
        ticket_number=await _next_ticket_number(db),
        machine_id=machine.id,
        priority=data.priority,
        problem_type=data.problem_type,
        description=data.description,
        machine_page_source=True,
    )
    db.add(ticket)
    machine.current_status = MachineStatus.maintenance
    if data.operator_name:
        machine.current_operator = data.operator_name
    if data.shift:
        machine.current_shift = data.shift
    await db.commit()
    await db.refresh(ticket)
    return {
        "ticket_id": str(ticket.id),
        "ticket_number": ticket.ticket_number,
        "machine_name": machine.name,
    }
