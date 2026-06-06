import re
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import Optional
from uuid import UUID
from datetime import datetime, timezone

from app.db.session import get_db
from app.models.models import (
    Machine, MaintenanceTicket, TicketStatus, WorkOrder,
    User, Technician, MachineStatus, AlertPriority,
)
from app.schemas.maintenance import (
    MachineOut, MachineListResponse, MachinePageData, TicketForMachine,
    MachineStatusUpdate, MaintenanceRequestCreate, MESData,
)
from app.core.security import get_current_user
from app.services.ticket_service import TicketService, _next_ticket_number

router = APIRouter()

_UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


async def _get_machine(ref: str, db: AsyncSession) -> Machine:
    """Lookup machine by UUID or page_slug."""
    if _UUID_RE.match(ref):
        m = await db.get(Machine, ref)
    else:
        r = await db.execute(select(Machine).where(Machine.page_slug == ref))
        m = r.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Machine not found")
    return m


# ── Admin: list all machines ───────────────────────────────────────────────────

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

    # Fetch open tickets
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
        sval  = t.status.value if hasattr(t.status, "value") else str(t.status)
        pval  = t.priority.value if hasattr(t.priority, "value") else str(t.priority)
        open_tickets.append(TicketForMachine(
            id=t.id,
            ticket_number=t.ticket_number,
            status=sval,
            priority=pval,
            problem_type=ptype,
            description=t.description,
            assigned_to_name=assigned_name,
            opened_at=t.opened_at,
            opened_by_technician_at=t.opened_by_technician_at,
            work_order_id=t.work_order_id,
            work_order_number=wo_number,
        ))

    cstatus = machine.current_status.value if machine.current_status and hasattr(machine.current_status, "value") else str(machine.current_status or MachineStatus.running)
    cshift  = machine.current_shift.value if machine.current_shift and hasattr(machine.current_shift, "value") else (str(machine.current_shift) if machine.current_shift else None)

    return MachinePageData(
        id=machine.id,
        name=machine.name,
        code=machine.code,
        department=machine.department,
        location=machine.location,
        is_active=machine.is_active,
        current_status=cstatus,
        current_operator=machine.current_operator,
        current_shift=cshift,
        last_maintenance_at=machine.last_maintenance_at,
        page_slug=machine.page_slug,
        open_tickets=open_tickets,
    )


@router.patch("/{ref}/status")
async def update_machine_status(
    ref: str,
    data: MachineStatusUpdate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    machine.current_status = data.status
    if data.current_operator is not None:
        machine.current_operator = data.current_operator
    if data.current_shift is not None:
        machine.current_shift = data.current_shift
    await db.commit()
    return {"status": "ok"}


@router.get("/{ref}/mes-data", response_model=MESData)
async def mes_data(ref: str, db: AsyncSession = Depends(get_db)):
    """Placeholder MES data endpoint. Returns mock data until MES integration."""
    await _get_machine(ref, db)
    return MESData(
        production_count=0,
        target=0,
        oee_pct=0.0,
        downtime_today_minutes=0,
        is_placeholder=True,
    )


@router.post("/{ref}/request-maintenance", status_code=201)
async def request_maintenance(
    ref: str,
    data: MaintenanceRequestCreate,
    db: AsyncSession = Depends(get_db),
):
    """Operator requests maintenance from the machine page — no auth required."""
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

    # Auto-set machine status to maintenance
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
