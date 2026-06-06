from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, inspect as sa_inspect
from typing import Optional
from uuid import UUID
from datetime import datetime, timezone

from app.db.session import get_db
from app.models.models import MaintenanceTicket, TicketComment, Machine, User, TicketStatus
from app.schemas.maintenance import (
    TicketCreate, TicketUpdate, TicketClose, CommentCreate,
    TicketOut, TicketListResponse, CommentOut,
)
from app.services.ticket_service import TicketService
from app.core.security import get_current_user

router = APIRouter()


def _ticket_to_dict(ticket: MaintenanceTicket) -> dict:
    cols = {attr.key: getattr(ticket, attr.key)
            for attr in sa_inspect(type(ticket)).mapper.column_attrs}
    cols.update(machine_name=None, assigned_to_name=None, comments=None)
    return cols


async def _enrich(ticket: MaintenanceTicket, db: AsyncSession, with_comments: bool = False) -> TicketOut:
    data = TicketOut.model_validate(_ticket_to_dict(ticket))
    machine = await db.get(Machine, ticket.machine_id)
    if machine:
        data.machine_name = machine.name
    if ticket.assigned_to_id:
        user = await db.get(User, ticket.assigned_to_id)
        if user:
            data.assigned_to_name = user.name
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
        ticket = await svc.create_ticket(data)
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
