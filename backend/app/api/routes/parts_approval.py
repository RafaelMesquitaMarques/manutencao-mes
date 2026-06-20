from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import InterventionPart, MachineIntervention, StockItem, User
from app.services.inventory_service import InventoryService

router = APIRouter(prefix="/api/parts-approval", tags=["Parts Approval"])


def _part_out(p: InterventionPart) -> dict:
    return {
        "id": str(p.id),
        "intervention_id": str(p.intervention_id) if p.intervention_id else None,
        "stock_item_id": str(p.stock_item_id) if p.stock_item_id else None,
        "item_code": p.item_code,
        "item_description": p.item_description,
        "quantity_used": p.quantity_used,
        "unit": p.unit,
        "unit_cost": p.unit_cost,
        "total_cost": p.total_cost,
        "approval_status": p.approval_status,
        "approved_by_id": str(p.approved_by_id) if p.approved_by_id else None,
        "approved_at": p.approved_at.isoformat() if p.approved_at else None,
        "rejection_reason": p.rejection_reason,
        "added_at": p.added_at.isoformat() if p.added_at else None,
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


@router.get("/pending")
async def list_pending_parts(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    r = await db.execute(
        select(InterventionPart)
        .where(InterventionPart.approval_status == "pending")
        .order_by(InterventionPart.added_at.desc())
    )
    parts = r.scalars().all()

    # Group by intervention
    groups: dict = {}
    for p in parts:
        inv_id = str(p.intervention_id) if p.intervention_id else "unknown"
        if inv_id not in groups:
            intervention = await db.get(MachineIntervention, p.intervention_id) if p.intervention_id else None
            groups[inv_id] = {
                "intervention_id": inv_id,
                "called_at": intervention.called_at.isoformat() if intervention and intervention.called_at else None,
                "machine_id": str(intervention.machine_id) if intervention and intervention.machine_id else None,
                "parts": [],
            }
        groups[inv_id]["parts"].append(_part_out(p))

    return {"groups": list(groups.values()), "total_pending": len(parts)}


class ApproveBody(BaseModel):
    pass


@router.post("/{part_id}/approve")
async def approve_part(
    part_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    part = await db.get(InterventionPart, part_id)
    if not part:
        raise HTTPException(404, "Part not found")

    now = datetime.now(timezone.utc)
    part.approval_status = "approved"
    part.approved_by_id = current_user.id
    part.approved_at = now

    await _consume_stock(db, part, current_user.id)

    await db.commit()
    await db.refresh(part)
    return _part_out(part)


class RejectBody(BaseModel):
    reason: Optional[str] = None


@router.post("/{part_id}/reject")
async def reject_part(
    part_id: UUID,
    body: RejectBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    part = await db.get(InterventionPart, part_id)
    if not part:
        raise HTTPException(404, "Part not found")

    part.approval_status = "rejected"
    part.approved_by_id = current_user.id
    part.approved_at = datetime.now(timezone.utc)
    part.rejection_reason = body.reason

    await db.commit()
    await db.refresh(part)
    return _part_out(part)


class BatchApproveBody(BaseModel):
    part_ids: list[str]


@router.post("/approve-batch")
async def approve_batch(
    body: BatchApproveBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    approved = []
    for pid_str in body.part_ids:
        try:
            pid = UUID(pid_str)
        except ValueError:
            continue
        part = await db.get(InterventionPart, pid)
        if not part or part.approval_status != "pending":
            continue
        part.approval_status = "approved"
        part.approved_by_id = current_user.id
        part.approved_at = now

        await _consume_stock(db, part, current_user.id)

        approved.append(str(part.id))

    await db.commit()
    return {"approved": approved, "count": len(approved)}
