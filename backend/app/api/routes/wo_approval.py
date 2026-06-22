from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import (
    Equipment,
    InterventionPart,
    Machine,
    MachineIntervention,
    MaintenanceTicket,
    StockItem,
    Technician,
    User,
    WOPart,
    WorkOrder,
    WorkOrderStatus,
)
from app.services.inventory_service import InventoryService

# A supervisor / maintenance director approves every completed work order, no matter
# where it was created: the floor kiosk (MachineIntervention) OR the office WorkOrders
# module (work_orders). Both flow through this one queue.
router = APIRouter(prefix="/api/wo-approval", tags=["WO Approval"])


# ── shared helpers ────────────────────────────────────────────────────────────

def _hours_to_minutes(h) -> Optional[float]:
    return round(float(h) * 60, 2) if h else None


def _intervention_part_out(p: InterventionPart) -> dict:
    return {
        "id": str(p.id),
        "item_code": p.item_code,
        "item_description": p.item_description,
        "quantity_used": p.quantity_used,
        "unit": p.unit,
        "unit_cost": p.unit_cost,
        "total_cost": p.total_cost,
        "approval_status": p.approval_status,
        "rejection_reason": p.rejection_reason,
    }


def _wo_part_out(p: WOPart) -> dict:
    # WO parts deduct stock when added (not at approval), so they are shown as
    # already-settled lines — no per-line reject affordance.
    return {
        "id": str(p.id),
        "item_code": p.part_number,
        "item_description": p.description,
        "quantity_used": p.quantity,
        "unit": p.unit,
        "unit_cost": p.unit_cost,
        "total_cost": p.total_cost,
        "approval_status": "approved",
        "rejection_reason": None,
    }


async def _consume_stock(db: AsyncSession, part: InterventionPart, user_id) -> None:
    """Snapshot price if still missing and deduct stock with a tracked movement."""
    if not part.stock_item_id or not part.quantity_used:
        return
    stock = await db.get(StockItem, part.stock_item_id)
    if not stock:
        return
    if part.unit_cost is None and stock.unit_cost is not None:
        part.unit_cost = stock.unit_cost
    if part.unit_cost is not None and part.total_cost is None:
        part.total_cost = round(float(part.unit_cost) * float(part.quantity_used), 2)
    await InventoryService(db).deduct_stock(
        part.stock_item_id,
        float(part.quantity_used),
        user_id=user_id,
        notes=f"Intervention part approved ({part.item_code or part.id})",
    )


# ── view builders ─────────────────────────────────────────────────────────────

async def _intervention_parts(db: AsyncSession, intervention_id) -> list[InterventionPart]:
    r = await db.execute(
        select(InterventionPart)
        .where(InterventionPart.intervention_id == intervention_id)
        .order_by(InterventionPart.added_at.asc())
    )
    return list(r.scalars().all())


async def _view_from_intervention(db: AsyncSession, mi: MachineIntervention) -> dict:
    machine = await db.get(Machine, mi.machine_id) if mi.machine_id else None
    equipment = await db.get(Equipment, mi.equipment_id) if mi.equipment_id else None
    ticket = await db.get(MaintenanceTicket, mi.ticket_id) if mi.ticket_id else None
    parts = await _intervention_parts(db, mi.id)
    parts_total = round(
        sum(float(p.total_cost) for p in parts if p.total_cost and p.approval_status != "rejected"),
        2,
    )
    return {
        "source": "intervention",
        "id": str(mi.id),
        "approval_status": mi.approval_status,
        "wo_number": ticket.ticket_number if ticket else None,
        "machine_name": (machine.name if machine else None) or (equipment.name if equipment else None),
        "machine_code": (machine.code if machine else None) or (equipment.code if equipment else None),
        "intervention_type_name": mi.intervention_type_name,
        "mechanic_note": mi.mechanic_note,
        "operator_note": mi.operator_note,
        "diagnosis": ticket.diagnosis if ticket else None,
        "corrective_action": ticket.corrective_action if ticket else None,
        "technician_name": mi.completed_by_name or mi.started_by_name,
        "called_at": mi.called_at.isoformat() if mi.called_at else None,
        "completed_at": mi.completed_at.isoformat() if mi.completed_at else None,
        "response_time_minutes": mi.response_time_minutes,
        "intervention_duration_minutes": mi.intervention_duration_minutes,
        "total_downtime_minutes": mi.total_downtime_minutes,
        "parts": [_intervention_part_out(p) for p in parts],
        "parts_total": parts_total,
        "supports_part_reject": True,
    }


async def _view_from_work_order(db: AsyncSession, wo: WorkOrder) -> dict:
    equipment = await db.get(Equipment, wo.equipment_id) if wo.equipment_id else None
    machine = await db.get(Machine, wo.machine_id) if wo.machine_id else None

    technician_name = None
    if wo.assigned_to_id:
        u = await db.get(User, wo.assigned_to_id)
        technician_name = u.name if u else None
    if not technician_name and wo.executor_id:
        tech = await db.get(Technician, wo.executor_id)
        if tech and tech.user_id:
            u = await db.get(User, tech.user_id)
            technician_name = u.name if u else None

    r = await db.execute(select(WOPart).where(WOPart.work_order_id == wo.id).order_by(WOPart.created_at.asc()))
    parts = list(r.scalars().all())
    parts_total = round(sum(float(p.total_cost) for p in parts if p.total_cost), 2)

    return {
        "source": "wo",
        "id": str(wo.id),
        "approval_status": wo.approval_status,
        "wo_number": wo.wo_number,
        "machine_name": (machine.name if machine else None) or (equipment.name if equipment else None),
        "machine_code": (machine.code if machine else None) or (equipment.code if equipment else None),
        "intervention_type_name": wo.type.value if wo.type else None,
        "mechanic_note": wo.notes,
        "operator_note": wo.title,
        "diagnosis": wo.diagnostic or wo.root_cause,
        "corrective_action": wo.solution_applied or wo.resolution,
        "technician_name": technician_name,
        "called_at": wo.opened_at.isoformat() if wo.opened_at else None,
        "completed_at": wo.completed_at.isoformat() if wo.completed_at else None,
        "response_time_minutes": None,
        "intervention_duration_minutes": wo.total_minutes or _hours_to_minutes(wo.repair_hours),
        "total_downtime_minutes": wo.actual_downtime_minutes or _hours_to_minutes(wo.downtime_hours),
        "parts": [_wo_part_out(p) for p in parts],
        "parts_total": parts_total,
        "supports_part_reject": False,
    }


# ── queue ─────────────────────────────────────────────────────────────────────

@router.get("/pending")
async def list_pending(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Completed work awaiting sign-off, from both sources, newest first."""
    # Floor interventions
    r = await db.execute(
        select(MachineIntervention).where(
            MachineIntervention.status == "completed",
            MachineIntervention.approval_status == "pending",
        )
    )
    interventions = list(r.scalars().all())

    # Tickets already represented by an intervention — used to drop the office WO twin
    # (a machine-linked WO spawns an intervention via intervention_sync) so the same
    # physical work is never listed twice.
    r = await db.execute(
        select(MachineIntervention.ticket_id).where(MachineIntervention.ticket_id.isnot(None))
    )
    intervention_ticket_ids = {tid for (tid,) in r.all()}

    # Office work orders
    r = await db.execute(
        select(WorkOrder).where(
            WorkOrder.status == WorkOrderStatus.completed,
            WorkOrder.approval_status == "pending",
        )
    )
    work_orders = [wo for wo in r.scalars().all() if wo.ticket_id not in intervention_ticket_ids]

    items = [await _view_from_intervention(db, mi) for mi in interventions]
    items += [await _view_from_work_order(db, wo) for wo in work_orders]
    items.sort(key=lambda i: i["completed_at"] or "", reverse=True)

    return {"items": items, "total_pending": len(items)}


# ── intervention actions ──────────────────────────────────────────────────────

class ApproveBody(BaseModel):
    note: Optional[str] = None


class RejectBody(BaseModel):
    reason: Optional[str] = None


@router.post("/intervention/{intervention_id}/approve")
async def approve_intervention(
    intervention_id: UUID,
    body: ApproveBody = ApproveBody(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    mi = await db.get(MachineIntervention, intervention_id)
    if not mi:
        raise HTTPException(404, "Work order not found")
    if mi.status != "completed":
        raise HTTPException(400, "Only completed work orders can be approved")

    now = datetime.now(timezone.utc)
    for part in await _intervention_parts(db, mi.id):
        if part.approval_status == "pending":
            part.approval_status = "approved"
            part.approved_by_id = current_user.id
            part.approved_at = now
            await _consume_stock(db, part, current_user.id)

    mi.approval_status = "approved"
    mi.approved_by_id = current_user.id
    mi.approved_at = now
    mi.approval_note = body.note

    await db.commit()
    await db.refresh(mi)
    return await _view_from_intervention(db, mi)


@router.post("/intervention/{intervention_id}/reject")
async def reject_intervention(
    intervention_id: UUID,
    body: RejectBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    mi = await db.get(MachineIntervention, intervention_id)
    if not mi:
        raise HTTPException(404, "Work order not found")

    now = datetime.now(timezone.utc)
    for part in await _intervention_parts(db, mi.id):
        if part.approval_status == "pending":
            part.approval_status = "rejected"
            part.approved_by_id = current_user.id
            part.approved_at = now
            part.rejection_reason = body.reason

    mi.approval_status = "rejected"
    mi.approved_by_id = current_user.id
    mi.approved_at = now
    mi.rejection_reason = body.reason

    await db.commit()
    await db.refresh(mi)
    return await _view_from_intervention(db, mi)


@router.post("/intervention/{intervention_id}/parts/{part_id}/reject")
async def reject_intervention_part(
    intervention_id: UUID,
    part_id: UUID,
    body: RejectBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    part = await db.get(InterventionPart, part_id)
    if not part or part.intervention_id != intervention_id:
        raise HTTPException(404, "Part not found on this work order")

    part.approval_status = "rejected"
    part.approved_by_id = current_user.id
    part.approved_at = datetime.now(timezone.utc)
    part.rejection_reason = body.reason

    await db.commit()
    mi = await db.get(MachineIntervention, intervention_id)
    return await _view_from_intervention(db, mi)


# ── office work-order actions ─────────────────────────────────────────────────

@router.post("/wo/{work_order_id}/approve")
async def approve_work_order(
    work_order_id: UUID,
    body: ApproveBody = ApproveBody(),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(404, "Work order not found")
    if wo.status != WorkOrderStatus.completed:
        raise HTTPException(400, "Only completed work orders can be approved")

    # Parts already deducted stock when added — approval is a pure sign-off here.
    wo.approval_status = "approved"
    wo.approved_by_id = current_user.id
    wo.approved_at = datetime.now(timezone.utc)
    wo.approval_note = body.note

    await db.commit()
    await db.refresh(wo)
    return await _view_from_work_order(db, wo)


@router.post("/wo/{work_order_id}/reject")
async def reject_work_order(
    work_order_id: UUID,
    body: RejectBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    wo = await db.get(WorkOrder, work_order_id)
    if not wo:
        raise HTTPException(404, "Work order not found")

    wo.approval_status = "rejected"
    wo.approved_by_id = current_user.id
    wo.approved_at = datetime.now(timezone.utc)
    wo.rejection_reason = body.reason

    await db.commit()
    await db.refresh(wo)
    return await _view_from_work_order(db, wo)
