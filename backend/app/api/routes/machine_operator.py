from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.models import (
    Equipment, Machine, MachineIntervention, MaintenanceTicket,
    TicketStatus, AlertPriority,
)
from app.services.ticket_service import _next_ticket_number

router = APIRouter(prefix="/api/machine-operator", tags=["Machine Operator"])

_STATUS_WAITING     = "waiting"
_STATUS_IN_PROGRESS = "in_progress"
_STATUS_COMPLETED   = "completed"


async def _resolve(machine_id: str, db: AsyncSession) -> tuple:
    """Return (machine, equipment). Auto-provisions a Machine if only Equipment exists."""
    try:
        uid = UUID(machine_id)
    except ValueError:
        raise HTTPException(404, "Invalid machine id")

    machine   = await db.get(Machine, uid)
    equipment = await db.get(Equipment, uid)

    if machine:
        if not equipment and machine.code:
            r = await db.execute(
                select(Equipment).where(Equipment.code == machine.code)
            )
            equipment = r.scalar_one_or_none()
        return machine, equipment

    if equipment:
        if equipment.code:
            r = await db.execute(select(Machine).where(Machine.code == equipment.code))
            existing = r.scalar_one_or_none()
            if existing:
                return existing, equipment
        machine = Machine(id=equipment.id, name=equipment.name, code=equipment.code, is_active=True)
        db.add(machine)
        await db.commit()
        await db.refresh(machine)
        return machine, equipment

    raise HTTPException(404, "Machine not found")


async def _active_intervention(machine_id, db: AsyncSession) -> Optional[MachineIntervention]:
    r = await db.execute(
        select(MachineIntervention)
        .where(
            MachineIntervention.machine_id == machine_id,
            MachineIntervention.status.in_([_STATUS_WAITING, _STATUS_IN_PROGRESS]),
        )
        .order_by(MachineIntervention.called_at.desc())
        .limit(1)
    )
    return r.scalar_one_or_none()


async def _last_intervention(machine_id, db: AsyncSession) -> Optional[MachineIntervention]:
    r = await db.execute(
        select(MachineIntervention)
        .where(
            MachineIntervention.machine_id == machine_id,
            MachineIntervention.status == _STATUS_COMPLETED,
        )
        .order_by(MachineIntervention.completed_at.desc())
        .limit(1)
    )
    return r.scalar_one_or_none()


def _intervention_dict(i: Optional[MachineIntervention]) -> Optional[dict]:
    if not i:
        return None
    return {
        "id":             str(i.id),
        "machine_id":     str(i.machine_id) if i.machine_id else None,
        "equipment_id":   str(i.equipment_id) if i.equipment_id else None,
        "ticket_id":      str(i.ticket_id) if i.ticket_id else None,
        "status":         i.status,
        "called_at":      i.called_at.isoformat() if i.called_at else None,
        "started_at":     i.started_at.isoformat() if i.started_at else None,
        "completed_at":   i.completed_at.isoformat() if i.completed_at else None,
        "called_by_id":   str(i.called_by_id) if i.called_by_id else None,
        "started_by_id":  str(i.started_by_id) if i.started_by_id else None,
        "operator_note":  i.operator_note,
        "mechanic_note":  i.mechanic_note,
    }


@router.get("/{machine_id}")
async def get_state(machine_id: str, db: AsyncSession = Depends(get_db)):
    machine, equipment = await _resolve(machine_id, db)

    active = await _active_intervention(machine.id, db)
    last   = await _last_intervention(machine.id, db)

    open_r = await db.execute(
        select(MaintenanceTicket).where(
            MaintenanceTicket.machine_id == machine.id,
            MaintenanceTicket.status.notin_([TicketStatus.completed, TicketStatus.cancelled]),
        )
    )
    open_tickets = len(open_r.scalars().all())

    last_maint_days: Optional[int] = None
    if machine.last_maintenance_at:
        delta = datetime.now(timezone.utc) - machine.last_maintenance_at
        last_maint_days = delta.days

    cstatus = machine.current_status.value if hasattr(machine.current_status, "value") else str(machine.current_status or "running")

    return {
        "machine": {
            "id":         str(machine.id),
            "name":       machine.name or "",
            "code":       machine.code or "",
            "department": machine.department or "",
            "location":   machine.location or "",
            "status":     cstatus,
        },
        "equipment": {
            "id":         str(equipment.id),
            "name":       equipment.name or "",
            "code":       equipment.code or "",
            "department": equipment.department or "",
            "hour_meter": equipment.hour_meter or 0,
        } if equipment else None,
        "active_intervention":  _intervention_dict(active),
        "last_intervention":    _intervention_dict(last),
        "open_tickets_count":   open_tickets,
        "last_maintenance_days_ago": last_maint_days,
    }


class CallBody(BaseModel):
    operator_note: Optional[str] = None


@router.post("/{machine_id}/call")
async def call_maintenance(machine_id: str, body: CallBody, db: AsyncSession = Depends(get_db)):
    machine, equipment = await _resolve(machine_id, db)

    existing = await _active_intervention(machine.id, db)
    if existing:
        return {"status": "already_active", "intervention": _intervention_dict(existing)}

    ticket_number = await _next_ticket_number(db)
    ticket = MaintenanceTicket(
        ticket_number=ticket_number,
        machine_id=machine.id,
        priority=AlertPriority.medium,
        status=TicketStatus.open,
        description=body.operator_note or "Appel opérateur",
        machine_page_source=True,
    )
    db.add(ticket)
    await db.flush()

    intervention = MachineIntervention(
        machine_id=machine.id,
        equipment_id=equipment.id if equipment else None,
        ticket_id=ticket.id,
        status=_STATUS_WAITING,
        operator_note=body.operator_note,
    )
    db.add(intervention)
    await db.commit()
    await db.refresh(intervention)
    return {"status": "called", "intervention": _intervention_dict(intervention)}


class StartBody(BaseModel):
    mechanic_note: Optional[str] = None


@router.post("/{machine_id}/start")
async def start_intervention(machine_id: str, body: StartBody, db: AsyncSession = Depends(get_db)):
    machine, _ = await _resolve(machine_id, db)

    intervention = await _active_intervention(machine.id, db)
    if not intervention:
        raise HTTPException(404, "No active intervention to start")
    if intervention.status != _STATUS_WAITING:
        raise HTTPException(400, f"Cannot start: status is '{intervention.status}'")

    intervention.status     = _STATUS_IN_PROGRESS
    intervention.started_at = datetime.now(timezone.utc)
    if body.mechanic_note:
        intervention.mechanic_note = body.mechanic_note
    await db.commit()
    await db.refresh(intervention)
    return {"status": "started", "intervention": _intervention_dict(intervention)}


class CompleteBody(BaseModel):
    mechanic_note: Optional[str] = None


@router.post("/{machine_id}/complete")
async def complete_intervention(machine_id: str, body: CompleteBody, db: AsyncSession = Depends(get_db)):
    machine, _ = await _resolve(machine_id, db)

    intervention = await _active_intervention(machine.id, db)
    if not intervention:
        raise HTTPException(404, "No active intervention to complete")
    if intervention.status != _STATUS_IN_PROGRESS:
        raise HTTPException(400, f"Cannot complete: status is '{intervention.status}'")

    now = datetime.now(timezone.utc)
    intervention.status       = _STATUS_COMPLETED
    intervention.completed_at = now
    if body.mechanic_note:
        intervention.mechanic_note = body.mechanic_note

    if intervention.ticket_id:
        ticket = await db.get(MaintenanceTicket, intervention.ticket_id)
        if ticket:
            ticket.status                  = TicketStatus.completed
            ticket.closed_by_technician_at = now

    machine.last_maintenance_at = now
    await db.commit()
    await db.refresh(intervention)
    return {"status": "completed", "intervention": _intervention_dict(intervention)}
