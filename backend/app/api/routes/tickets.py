from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, inspect as sa_inspect
from typing import Optional
from uuid import UUID
from datetime import datetime, timezone

from pydantic import BaseModel

from app.db.session import get_db
from app.models.models import MaintenanceTicket, TicketComment, Machine, User, TicketStatus, WorkOrder, Equipment
from app.schemas.maintenance import (
    TicketCreate, TicketUpdate, TicketClose, CommentCreate,
    TicketOut, TicketListResponse, CommentOut,
)
from app.schemas.work_order import WorkOrderOut
from app.services.ticket_service import TicketService, sync_alert_from_ticket, backfill_missing_alerts
from app.core.security import get_current_user


class TicketAssign(BaseModel):
    technician_id: UUID

router = APIRouter()


def _ticket_to_dict(ticket: MaintenanceTicket) -> dict:
    cols = {attr.key: getattr(ticket, attr.key)
            for attr in sa_inspect(type(ticket)).mapper.column_attrs}
    cols.update(machine_name=None, assigned_to_name=None, comments=None,
                work_order_number=None, work_order_status=None,
                problem_type=cols.get("problem_type"),
                description=cols.get("description"),
                machine_page_source=cols.get("machine_page_source", False),
                opened_by_technician_at=cols.get("opened_by_technician_at"),
                closed_by_technician_at=cols.get("closed_by_technician_at"))
    return cols


async def _enrich(ticket: MaintenanceTicket, db: AsyncSession, with_comments: bool = False) -> TicketOut:
    data = TicketOut.model_validate(_ticket_to_dict(ticket))
    machine = await db.get(Machine, ticket.machine_id)
    if machine:
        data.machine_name = machine.name
    else:
        equip = await db.get(Equipment, ticket.machine_id)
        if equip:
            data.machine_name = equip.name
    if ticket.assigned_to_id:
        user = await db.get(User, ticket.assigned_to_id)
        if user:
            data.assigned_to_name = user.name
    if ticket.work_order_id:
        wo = await db.get(WorkOrder, ticket.work_order_id)
        if wo:
            data.work_order_number = wo.wo_number
            data.work_order_status = wo.status.value if hasattr(wo.status, "value") else str(wo.status)
    if with_comments:
        r = await db.execute(
            select(TicketComment)
            .where(TicketComment.ticket_id == ticket.id)
            .order_by(TicketComment.created_at)
        )
        data.comments = [CommentOut.model_validate(c) for c in r.scalars().all()]
    return data


@router.post("/", response_model=TicketOut, status_code=201)
async def create_ticket(
    data: TicketCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    svc = TicketService(db)
    try:
        ticket = await svc.create_ticket(data, created_by=current_user.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return await _enrich(ticket, db)


@router.get("/", response_model=TicketListResponse)
async def list_tickets(
    status:         Optional[TicketStatus] = None,
    machine_id:     Optional[UUID]         = None,
    assigned_to_id: Optional[UUID]         = None,
    skip:           int                    = Query(0, ge=0),
    limit:          int                    = Query(100, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    q = select(MaintenanceTicket)
    if status:
        q = q.where(MaintenanceTicket.status == status)
    if machine_id:
        q = q.where(MaintenanceTicket.machine_id == machine_id)
    if assigned_to_id:
        q = q.where(MaintenanceTicket.assigned_to_id == assigned_to_id)

    total_r = await db.execute(select(func.count()).select_from(q.subquery()))
    total   = total_r.scalar()

    q       = q.offset(skip).limit(limit).order_by(MaintenanceTicket.opened_at.desc())
    result  = await db.execute(q)
    tickets = result.scalars().all()

    items = [await _enrich(t, db) for t in tickets]
    return TicketListResponse(total=total, items=items)


@router.post("/backfill-alerts", status_code=200)
async def run_backfill_alerts(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create missing MaintenanceAlert records for tickets that have none."""
    count = await backfill_missing_alerts(db)
    return {"created": count}


@router.get("/{ticket_id}", response_model=TicketOut)
async def get_ticket(
    ticket_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ticket = await db.get(MaintenanceTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return await _enrich(ticket, db, with_comments=True)


@router.patch("/{ticket_id}/status", response_model=TicketOut)
async def update_ticket(
    ticket_id: UUID,
    data: TicketUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ticket = await db.get(MaintenanceTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    updates = data.model_dump(exclude_none=True)
    for field, value in updates.items():
        setattr(ticket, field, value)

    if updates.get("status") == TicketStatus.in_progress and not ticket.started_at:
        ticket.started_at = datetime.now(timezone.utc)

    if "status" in updates:
        await sync_alert_from_ticket(ticket, db)

    await db.commit()
    await db.refresh(ticket)
    return await _enrich(ticket, db)


@router.patch("/{ticket_id}/close", response_model=TicketOut)
async def close_ticket(
    ticket_id: UUID,
    data: TicketClose,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    svc = TicketService(db)
    try:
        ticket = await svc.close_ticket(ticket_id, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return await _enrich(ticket, db)


@router.post("/{ticket_id}/comments", response_model=CommentOut, status_code=201)
async def add_comment(
    ticket_id: UUID,
    data: CommentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    svc = TicketService(db)
    try:
        comment = await svc.add_comment(ticket_id, data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return comment


@router.patch("/{ticket_id}/assign", status_code=200)
async def assign_ticket(
    ticket_id: UUID,
    data: TicketAssign,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Assign a technician to a ticket and auto-create a linked work order."""
    svc = TicketService(db)
    try:
        ticket, wo = await svc.assign_ticket(ticket_id, data.technician_id, current_user.id)
        ticket_out = await _enrich(ticket, db, with_comments=False)
        wo_out = await _enrich_wo_simple(wo, db)
        return {"ticket": ticket_out, "work_order": wo_out}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


async def _enrich_wo_simple(wo: WorkOrder, db: AsyncSession) -> WorkOrderOut:
    out = WorkOrderOut.model_validate(wo)
    equip = await db.get(Equipment, wo.equipment_id)
    if equip:
        out.equipment_name = equip.name
    return out


@router.patch("/{ticket_id}/open-field", response_model=TicketOut)
async def open_ticket_field(
    ticket_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Technician opens ticket on field — no auth required (kiosk mode)."""
    ticket = await db.get(MaintenanceTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if not ticket.opened_by_technician_at:
        ticket.opened_by_technician_at = datetime.now(timezone.utc)
    if ticket.status == TicketStatus.open or ticket.status == TicketStatus.on_hold_parts or ticket.status == TicketStatus.on_hold_ext:
        ticket.status = TicketStatus.in_progress
        if not ticket.started_at:
            ticket.started_at = datetime.now(timezone.utc)
    await sync_alert_from_ticket(ticket, db)
    await db.commit()
    await db.refresh(ticket)
    return await _enrich(ticket, db)


@router.post("/{ticket_id}/generate-wo", status_code=201)
async def generate_work_order(
    ticket_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    svc = TicketService(db)
    try:
        ticket, wo = await svc.generate_work_order(ticket_id, current_user.id)
        ticket_out = await _enrich(ticket, db)
        wo_out = WorkOrderOut.model_validate(wo)
        equip = await db.get(Equipment, wo.equipment_id)
        if equip:
            wo_out.equipment_name = equip.name
        return {"ticket": ticket_out, "work_order": wo_out}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{ticket_id}/work-order", response_model=WorkOrderOut)
async def get_ticket_work_order(
    ticket_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ticket = await db.get(MaintenanceTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if not ticket.work_order_id:
        raise HTTPException(status_code=404, detail="No work order linked to this ticket")
    wo = await db.get(WorkOrder, ticket.work_order_id)
    if not wo:
        raise HTTPException(status_code=404, detail="Work order not found")
    wo_out = WorkOrderOut.model_validate(wo)
    equip = await db.get(Equipment, wo.equipment_id)
    if equip:
        wo_out.equipment_name = equip.name
    return wo_out


@router.delete("/{ticket_id}", status_code=204)
async def delete_ticket(
    ticket_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ticket = await db.get(MaintenanceTicket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    await db.delete(ticket)
    await db.commit()
