from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, inspect as sa_inspect, text
from typing import Optional
from uuid import UUID
from datetime import datetime, timezone

from pydantic import BaseModel, Field

from app.db.session import get_db
from app.models.models import MaintenanceTicket, TicketComment, Machine, User, TicketStatus, WorkOrder, WorkOrderStatus, Equipment, MachineIntervention, InterventionPart, StockItem, WorkOrderTechnician, Technician
from app.schemas.maintenance import (
    TicketCreate, TicketUpdate, TicketClose, CommentCreate,
    TicketOut, TicketListResponse, CommentOut,
)
from app.schemas.work_order import WorkOrderOut
from app.services.ticket_service import TicketService, sync_alert_from_ticket, backfill_missing_alerts, DuplicateTicketError
from app.core.security import get_current_user
from app.core.permissions import require_permission
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_scoped, require_technician_in_plant as _require_technician_in_plant


class TicketAssign(BaseModel):
    technician_id: UUID
    # Labor estimate for the auto-created WO; omitted → derived from the
    # ticket's estimated downtime.
    estimated_hours: Optional[float] = Field(default=None, ge=0)

router = APIRouter()


async def _get_ticket_scoped(ticket_id: UUID, db: AsyncSession, ctx: PlantContext) -> MaintenanceTicket:
    """Fetch + plant visibility: wrong-plant ticket ids 404 like missing ones."""
    return ensure_same_plant(await db.get(MaintenanceTicket, ticket_id), ctx, detail="Ticket not found")


async def _require_wo_closed(ticket: MaintenanceTicket, db: AsyncSession) -> None:
    """Office rule: a ticket only closes after its linked work order is
    completed or cancelled. (The kiosk completion flow closes both at once.)"""
    if not ticket.work_order_id:
        return
    wo = await db.get(WorkOrder, ticket.work_order_id)
    if wo and wo.status not in (WorkOrderStatus.completed, WorkOrderStatus.cancelled):
        raise HTTPException(
            status_code=409,
            detail=f"Work order {wo.wo_number} is still {wo.status.value if hasattr(wo.status, 'value') else wo.status}"
                   " — complete the work order first, the ticket will close automatically.",
        )


async def _stock_descriptions(db: AsyncSession, parts) -> dict:
    """Map stock_item_id -> description for parts whose item_description is empty.

    Imported stock items keep the human-readable text in `description` (the
    `name` column is blank), so we backfill the display value from there.
    """
    missing_ids = {p.stock_item_id for p in parts if not p.item_description and p.stock_item_id}
    if not missing_ids:
        return {}
    r = await db.execute(select(StockItem).where(StockItem.id.in_(missing_ids)))
    return {s.id: (s.description or s.name or "") for s in r.scalars().all()}


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
    wo = None
    if ticket.work_order_id:
        wo = await db.get(WorkOrder, ticket.work_order_id)
    if not wo:
        r = await db.execute(select(WorkOrder).where(WorkOrder.ticket_id == ticket.id))
        wo = r.scalars().first()
    if wo:
        data.work_order_number = wo.wo_number
        data.work_order_status = wo.status.value if hasattr(wo.status, "value") else str(wo.status)
        # Assigned technicians come from the WO join table so the ticket always
        # reflects the current assignment (e.g. after Labor Scheduler changes)
        links_r = await db.execute(
            select(WorkOrderTechnician.technician_id, WorkOrderTechnician.is_primary, User.name)
            .join(Technician, WorkOrderTechnician.technician_id == Technician.id)
            .join(User, Technician.user_id == User.id, isouter=True)
            .where(WorkOrderTechnician.work_order_id == wo.id)
            .order_by(WorkOrderTechnician.is_primary.desc(), WorkOrderTechnician.assigned_at)
        )
        data.assigned_technicians = [
            {"technician_id": str(tid), "name": name, "is_primary": bool(is_primary)}
            for tid, is_primary, name in links_r.all()
        ]
        if not data.assigned_technicians and wo.executor_id:
            tech = await db.get(Technician, wo.executor_id)
            if tech:
                user = await db.get(User, tech.user_id)
                data.assigned_technicians = [{
                    "technician_id": str(tech.id),
                    "name": user.name if user else None,
                    "is_primary": True,
                }]
        if data.assigned_technicians:
            names = [t["name"] for t in data.assigned_technicians if t["name"]]
            if names:
                data.assigned_to_name = ", ".join(names)
    if with_comments:
        r = await db.execute(
            select(TicketComment)
            .where(TicketComment.ticket_id == ticket.id)
            .order_by(TicketComment.created_at)
        )
        data.comments = [CommentOut.model_validate(c) for c in r.scalars().all()]
    # Fetch parts from linked intervention
    intervention_r = await db.execute(
        select(MachineIntervention).where(MachineIntervention.ticket_id == ticket.id)
    )
    intervention = intervention_r.scalar_one_or_none()
    if intervention:
        parts_r = await db.execute(
            select(InterventionPart)
            .where(InterventionPart.intervention_id == intervention.id)
            .order_by(InterventionPart.added_at)
        )
        parts = parts_r.scalars().all()
        stock_desc = await _stock_descriptions(db, parts)
        data.intervention_parts = [
            {
                "id": str(p.id),
                "item_code": p.item_code or "",
                "item_description": p.item_description or stock_desc.get(p.stock_item_id, ""),
                "quantity_used": p.quantity_used,
                "unit": p.unit or "",
                "unit_cost": p.unit_cost,
                "total_cost": p.total_cost,
                "approval_status": p.approval_status,
                "approved_at": p.approved_at.isoformat() if p.approved_at else None,
            }
            for p in parts
        ]
    return data


@router.post("/", response_model=TicketOut, status_code=201)
async def create_ticket(
    data: TicketCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("tickets", "create")),
):
    # Relational guard: the target machine must belong to a plant this user can see.
    ensure_same_plant(await db.get(Machine, data.machine_id), ctx, detail="Machine not found")
    svc = TicketService(db)
    try:
        ticket = await svc.create_ticket(data, created_by=current_user.name)
    except DuplicateTicketError as e:
        # 409 with the existing ticket details so the UI can ask the user to confirm
        raise HTTPException(status_code=409, detail=e.existing)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return await _enrich(ticket, db)


@router.get("/", response_model=TicketListResponse)
async def list_tickets(
    status:         Optional[TicketStatus] = None,
    machine_id:     Optional[UUID]         = None,
    assigned_to_id: Optional[UUID]         = None,
    unassigned:     bool                   = False,
    skip:           int                    = Query(0, ge=0),
    limit:          int                    = Query(100, le=500),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    q = plant_scoped(select(MaintenanceTicket), MaintenanceTicket, ctx)
    if status:
        q = q.where(MaintenanceTicket.status == status)
    if machine_id:
        q = q.where(MaintenanceTicket.machine_id == machine_id)
    if assigned_to_id:
        q = q.where(MaintenanceTicket.assigned_to_id == assigned_to_id)
    if unassigned:
        q = q.where(MaintenanceTicket.assigned_to_id.is_(None))

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
    ctx: PlantContext = Depends(get_plant_context),
):
    ticket = await _get_ticket_scoped(ticket_id, db, ctx)
    return await _enrich(ticket, db, with_comments=True)


@router.patch("/{ticket_id}/status", response_model=TicketOut)
async def update_ticket(
    ticket_id: UUID,
    data: TicketUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    ticket = await _get_ticket_scoped(ticket_id, db, ctx)

    updates = data.model_dump(exclude_none=True)

    # A ticket only closes after its work order: while the linked WO is
    # still open, the work isn't done — complete the WO instead.
    if updates.get("status") == TicketStatus.completed:
        await _require_wo_closed(ticket, db)

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
    ctx: PlantContext = Depends(get_plant_context),
):
    ticket = await _get_ticket_scoped(ticket_id, db, ctx)
    await _require_wo_closed(ticket, db)

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
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_ticket_scoped(ticket_id, db, ctx)
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
    ctx: PlantContext = Depends(get_plant_context),
):
    """Assign a technician to a ticket and auto-create a linked work order."""
    ticket = await _get_ticket_scoped(ticket_id, db, ctx)
    await _require_technician_in_plant(db, data.technician_id, ticket.plant_id)
    svc = TicketService(db)
    try:
        ticket, wo = await svc.assign_ticket(
            ticket_id, data.technician_id, current_user.id,
            estimated_hours=data.estimated_hours,
        )
        ticket_out = await _enrich(ticket, db, with_comments=False)
        wo_out = await _enrich_wo_simple(wo, db)
        return {"ticket": ticket_out, "work_order": wo_out}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{ticket_id}/claim", status_code=200)
async def claim_ticket(
    ticket_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Technician self-assigns an unassigned ticket — used on shifts without
    a supervisor to dispatch work. Same effect as a supervisor assignment.
    Subject to the supervisor-controlled technician_self_assign switch."""
    from app.services.notification_service import get_escalation_settings
    ticket = await _get_ticket_scoped(ticket_id, db, ctx)
    esc = await get_escalation_settings(db, ticket.plant_id)
    if not esc.technician_self_assign:
        raise HTTPException(
            status_code=403,
            detail="Self-assignment is currently disabled — your supervisor dispatches the work orders",
        )
    if ticket.assigned_to_id:
        raise HTTPException(status_code=409, detail="Ticket already taken by another technician")
    if ticket.status in (TicketStatus.completed, TicketStatus.cancelled):
        raise HTTPException(status_code=400, detail="Ticket is closed")

    tech = (await db.execute(
        select(Technician).where(
            Technician.user_id == current_user.id,
            Technician.active == True,
        )
    )).scalar_one_or_none()
    if not tech:
        raise HTTPException(status_code=400, detail="Your account has no technician profile")

    if ticket.work_order_id:
        # A WO already exists (e.g. generated earlier) — attach yourself to it
        from app.api.routes.work_orders import _sync_wo_technicians
        wo = await db.get(WorkOrder, ticket.work_order_id)
        ticket.assigned_to_id = current_user.id
        if wo:
            await _sync_wo_technicians(wo, [tech.id], db)
            wo.assigned_to_id = current_user.id
        await sync_alert_from_ticket(ticket, db)
        await db.commit()
        await db.refresh(ticket)
        ticket_out = await _enrich(ticket, db, with_comments=False)
        wo_out = await _enrich_wo_simple(wo, db) if wo else None
        return {"ticket": ticket_out, "work_order": wo_out}

    svc = TicketService(db)
    try:
        ticket, wo = await svc.assign_ticket(ticket_id, tech.id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    ticket_out = await _enrich(ticket, db, with_comments=False)
    wo_out = await _enrich_wo_simple(wo, db)
    return {"ticket": ticket_out, "work_order": wo_out}


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
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_ticket_scoped(ticket_id, db, ctx)
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
    ctx: PlantContext = Depends(get_plant_context),
):
    ticket = await _get_ticket_scoped(ticket_id, db, ctx)
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
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("tickets", "delete")),
):
    ticket = await _get_ticket_scoped(ticket_id, db, ctx)
    # Remove/detach children blocked by NO ACTION FKs so the delete never 500s.
    # (linked alert cascades on delete per chosen behavior; notification_logs and
    #  machine_interventions set their ticket_id to NULL automatically.)
    await db.execute(text("DELETE FROM ticket_comments WHERE ticket_id = :t"), {"t": ticket_id})
    await db.execute(text("UPDATE machine_stops SET ticket_id = NULL WHERE ticket_id = :t"), {"t": ticket_id})
    await db.execute(text("UPDATE work_orders SET ticket_id = NULL WHERE ticket_id = :t"), {"t": ticket_id})
    await db.delete(ticket)
    await db.commit()
