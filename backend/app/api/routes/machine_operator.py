from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, and_, or_, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.models import (
    Equipment, Machine, MachineStatus, MachineIntervention, MaintenanceTicket,
    TicketStatus, AlertPriority, MaintenanceAlert, AlertStatus, AlertProblemType,
    InterventionType, SafetyChecklist, SafetyChecklistItem,
    InterventionChecklistResponse, InterventionPart, InterventionTechnician,
    StockItem, Technician, User,
)
from app.services.note_organizer import organize_note
from app.services.ticket_service import _next_ticket_number, _next_alert_number, sync_alert_from_ticket

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
        machine = Machine(id=equipment.id, name=equipment.name, code=equipment.code,
                          plant_id=equipment.plant_id, is_active=True)
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


async def _checkins(db: AsyncSession, intervention_id) -> list[dict]:
    """Open check-ins (techs currently on the intervention), oldest first."""
    rows = (await db.execute(
        select(InterventionTechnician)
        .where(
            InterventionTechnician.intervention_id == intervention_id,
            InterventionTechnician.checked_out_at.is_(None),
        )
        .order_by(InterventionTechnician.checked_in_at.asc())
    )).scalars().all()
    return [{
        "id":            str(r.id),
        "technician_id": str(r.technician_id) if r.technician_id else None,
        "name":          r.name,
        "checked_in_at": r.checked_in_at.isoformat() if r.checked_in_at else None,
    } for r in rows]


def _intervention_dict(i: Optional[MachineIntervention], technicians: Optional[list] = None) -> Optional[dict]:
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
        "started_by_name": i.started_by_name,
        "technicians":    technicians or [],
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
            "location":   equipment.location or "",
            "hour_meter": equipment.hour_meter or 0,
        } if equipment else None,
        "active_intervention":  _intervention_dict(active, await _checkins(db, active.id) if active else None),
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

    # An office-created ticket may already be open for this machine without an
    # intervention yet (e.g. a planned-maintenance ticket). Adopt it instead of
    # creating a duplicate ticket — the machine page then shows "waiting for
    # mechanic" against that same ticket.
    prior_r = await db.execute(
        select(MaintenanceTicket)
        .where(
            MaintenanceTicket.machine_id == machine.id,
            MaintenanceTicket.status.notin_([TicketStatus.completed, TicketStatus.cancelled]),
        )
        .order_by(MaintenanceTicket.opened_at.desc())
        .limit(1)
    )
    prior = prior_r.scalar_one_or_none()
    if prior:
        intervention = MachineIntervention(
            machine_id=machine.id,
            plant_id=machine.plant_id,
            equipment_id=equipment.id if equipment else None,
            ticket_id=prior.id,
            status=_STATUS_WAITING,
            operator_note=body.operator_note,
        )
        db.add(intervention)
        machine.current_status = MachineStatus.maintenance   # kiosk/twin reflect "in maintenance"
        await db.commit()
        await db.refresh(intervention)
        return {
            "status": "adopted",
            "intervention": _intervention_dict(intervention),
            "ticket_number": prior.ticket_number,
        }

    alert = MaintenanceAlert(
        alert_number=await _next_alert_number(db, machine.plant_id),
        machine_id=machine.id,
        plant_id=machine.plant_id,
        department=machine.department,
        problem_type=AlertProblemType.mechanical,
        priority=AlertPriority.medium,
        description=body.operator_note or "Appel opérateur",
        created_by="operator",
        status=AlertStatus.new_alert,
    )
    db.add(alert)
    await db.flush()

    ticket_number = await _next_ticket_number(db, machine.plant_id)
    ticket = MaintenanceTicket(
        ticket_number=ticket_number,
        machine_id=machine.id,
        plant_id=machine.plant_id,
        alert_id=alert.id,
        priority=AlertPriority.medium,
        status=TicketStatus.open,
        description=body.operator_note or "Appel opérateur",
        machine_page_source=True,
    )
    db.add(ticket)
    await db.flush()

    alert.ticket_id = ticket.id

    intervention = MachineIntervention(
        machine_id=machine.id,
        plant_id=machine.plant_id,
        equipment_id=equipment.id if equipment else None,
        ticket_id=ticket.id,
        status=_STATUS_WAITING,
        operator_note=body.operator_note,
    )
    db.add(intervention)
    machine.current_status = MachineStatus.maintenance   # kiosk/twin reflect "in maintenance"

    from app.services.notification_service import NotificationService
    await NotificationService(db).notify_ticket_opened(ticket, machine.name)

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

    # A tech may have checked in while the call was still waiting — credit the
    # first one as the starter so the map pictogram/history carry a name.
    if not intervention.started_by_name:
        first = (await db.execute(
            select(InterventionTechnician)
            .where(
                InterventionTechnician.intervention_id == intervention.id,
                InterventionTechnician.checked_out_at.is_(None),
            )
            .order_by(InterventionTechnician.checked_in_at.asc())
        )).scalars().first()
        if first:
            intervention.started_by_name = first.name

    if intervention.called_at and intervention.started_at:
        delta = intervention.started_at - intervention.called_at
        intervention.response_time_minutes = round(delta.total_seconds() / 60, 2)

    # Technician is now working on the machine → status/color goes purple
    # (was yellow/maintenance during the wait). Frame, 3D mats and 2D nodes follow.
    machine.current_status = MachineStatus.intervention

    if intervention.ticket_id:
        ticket = await db.get(MaintenanceTicket, intervention.ticket_id)
        if ticket:
            ticket.status = TicketStatus.in_progress
            if not ticket.started_at:
                ticket.started_at = intervention.started_at
            await sync_alert_from_ticket(ticket, db)

    await db.commit()
    await db.refresh(intervention)
    return {"status": "started", "intervention": _intervention_dict(intervention, await _checkins(db, intervention.id))}


@router.get("/{machine_id}/technicians")
async def list_kiosk_technicians(machine_id: str, db: AsyncSession = Depends(get_db)):
    """Active technicians for the kiosk check-in picker (id + display name)."""
    await _resolve(machine_id, db)
    rows = (await db.execute(
        select(Technician.id, User.name, Technician.specialty)
        .join(User, Technician.user_id == User.id)
        .where(Technician.active == True)  # noqa: E712
        .order_by(User.name.asc())
    )).all()
    return {"items": [
        {"id": str(tid), "name": name, "specialty": spec.value if spec else None}
        for tid, name, spec in rows
    ]}


class CheckInBody(BaseModel):
    technician_id: str


@router.post("/{machine_id}/checkin")
async def check_in_technician(machine_id: str, body: CheckInBody, db: AsyncSession = Depends(get_db)):
    """A technician joins the active intervention (waiting or in progress).
    Several techs can be checked in at once; idempotent per technician. The
    first check-in backfills started_by so the map pictogram has a name."""
    machine, _ = await _resolve(machine_id, db)
    intervention = await _active_intervention(machine.id, db)
    if not intervention:
        raise HTTPException(404, "No active intervention to check in to")

    try:
        tech_uid = UUID(body.technician_id)
    except ValueError:
        raise HTTPException(400, "Invalid technician_id")
    row = (await db.execute(
        select(Technician, User.name)
        .join(User, Technician.user_id == User.id)
        .where(Technician.id == tech_uid)
    )).first()
    if not row:
        raise HTTPException(404, "Technician not found")
    tech, tech_name = row

    already = (await db.execute(
        select(InterventionTechnician).where(
            InterventionTechnician.intervention_id == intervention.id,
            InterventionTechnician.technician_id == tech_uid,
            InterventionTechnician.checked_out_at.is_(None),
        )
    )).scalars().first()
    if not already:
        db.add(InterventionTechnician(
            intervention_id=intervention.id,
            technician_id=tech_uid,
            name=tech_name,
        ))
        if not intervention.started_by_name:
            intervention.started_by_name = tech_name
            intervention.started_by_id = tech.user_id
        await db.commit()

    return {"status": "checked_in", "intervention": _intervention_dict(intervention, await _checkins(db, intervention.id))}


@router.post("/{machine_id}/checkout")
async def check_out_technician(machine_id: str, body: CheckInBody, db: AsyncSession = Depends(get_db)):
    """A technician leaves the active intervention (the work itself continues)."""
    machine, _ = await _resolve(machine_id, db)
    intervention = await _active_intervention(machine.id, db)
    if not intervention:
        raise HTTPException(404, "No active intervention")
    try:
        tech_uid = UUID(body.technician_id)
    except ValueError:
        raise HTTPException(400, "Invalid technician_id")
    open_row = (await db.execute(
        select(InterventionTechnician).where(
            InterventionTechnician.intervention_id == intervention.id,
            InterventionTechnician.technician_id == tech_uid,
            InterventionTechnician.checked_out_at.is_(None),
        )
    )).scalars().first()
    if open_row:
        open_row.checked_out_at = datetime.now(timezone.utc)
        await db.commit()
    return {"status": "checked_out", "intervention": _intervention_dict(intervention, await _checkins(db, intervention.id))}


@router.get("/{machine_id}/intervention-types")
async def get_intervention_types(machine_id: str, db: AsyncSession = Depends(get_db)):
    machine, equipment = await _resolve(machine_id, db)
    eq_id = equipment.id if equipment else None

    q = select(InterventionType).where(
        and_(
            InterventionType.equipment_id == eq_id,
            InterventionType.is_active == True,
        )
    ).order_by(InterventionType.sort_order)

    types = (await db.execute(q)).scalars().all()
    return {
        "items": [
            {
                "id":         str(t.id),
                "name":       t.name,
                "icon":       t.icon or "🔧",
                "color":      t.color or "#388bfd",
                "sort_order": t.sort_order,
            }
            for t in types
        ]
    }


class KioskNoteOrganizeBody(BaseModel):
    # Hard cap: this router is auth-free (kiosk tablets), and the organizer can
    # hit a paid API — never relay arbitrarily large payloads to it.
    text: str = Field(max_length=8000)
    language: str = "fr"


@router.post("/{machine_id}/notes/organize")
async def organize_closing_note(machine_id: str, body: KioskNoteOrganizeBody, db: AsyncSession = Depends(get_db)):
    """Tidy up the dictated closing note (same organizer as WO notes: Anthropic →
    Ollama → local cleanup). Scoped under a real machine so the kiosk can only
    call it from a valid machine screen."""
    await _resolve(machine_id, db)
    text, ai_used = await organize_note(body.text, body.language)
    return {"text": text, "ai_used": ai_used}


class CompleteBody(BaseModel):
    mechanic_note: Optional[str] = None
    intervention_type_id: Optional[str] = None


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

    # ── Timing metrics ───────────────────────────────────────────────────────
    if intervention.called_at and intervention.started_at:
        delta_response = intervention.started_at - intervention.called_at
        intervention.response_time_minutes = round(delta_response.total_seconds() / 60, 2)

    if intervention.started_at:
        delta_duration = now - intervention.started_at
        intervention.intervention_duration_minutes = round(delta_duration.total_seconds() / 60, 2)

    if intervention.called_at:
        delta_total = now - intervention.called_at
        intervention.total_downtime_minutes = round(delta_total.total_seconds() / 60, 2)

    # ── Note and type ────────────────────────────────────────────────────────
    if body.mechanic_note:
        intervention.mechanic_note = body.mechanic_note
    if body.intervention_type_id:
        try:
            type_uid = UUID(body.intervention_type_id)
            intervention.intervention_type_id = type_uid
            itype = await db.get(InterventionType, type_uid)
            if itype:
                intervention.intervention_type_name = itype.name
        except ValueError:
            pass

    if intervention.ticket_id:
        ticket = await db.get(MaintenanceTicket, intervention.ticket_id)
        if ticket:
            ticket.status                  = TicketStatus.completed
            ticket.closed_by_technician_at = now
            await sync_alert_from_ticket(ticket, db)

    # The work is done — close whatever check-ins are still open so the techs'
    # time on the intervention ends with it.
    for open_ci in (await db.execute(
        select(InterventionTechnician).where(
            InterventionTechnician.intervention_id == intervention.id,
            InterventionTechnician.checked_out_at.is_(None),
        )
    )).scalars().all():
        open_ci.checked_out_at = now

    machine.last_maintenance_at = now
    # Do NOT assume production resumed. Close the maintenance downtime and repaint:
    # a positive production signal → green; otherwise → pink (waiting for production).
    # A signal-driven machine only goes green once the ADAM signal confirms it.
    from app.services.intervention_sync import repaint_after_maintenance
    await repaint_after_maintenance(db, machine, ticket_id=intervention.ticket_id, from_intervention=True)
    await db.commit()
    await db.refresh(intervention)
    return {
        "status": "completed",
        "intervention": _intervention_dict(intervention),
        "response_time_minutes": intervention.response_time_minutes,
        "intervention_duration_minutes": intervention.intervention_duration_minutes,
        "total_downtime_minutes": intervention.total_downtime_minutes,
    }


@router.get("/{machine_id}/history")
async def get_intervention_history(
    machine_id: str,
    skip: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    machine, _ = await _resolve(machine_id, db)
    m_id = machine.id

    q = (
        select(MachineIntervention)
        .where(
            MachineIntervention.machine_id == m_id,
            MachineIntervention.status == _STATUS_COMPLETED,
        )
        .order_by(MachineIntervention.called_at.desc())
        .offset(skip)
        .limit(limit)
    )

    total_q = select(func.count(MachineIntervention.id)).where(
        MachineIntervention.machine_id == m_id,
        MachineIntervention.status == _STATUS_COMPLETED,
    )

    items = (await db.execute(q)).scalars().all()
    total = (await db.execute(total_q)).scalar_one()

    def _fmt(i: MachineIntervention) -> dict:
        return {
            "id":                           str(i.id),
            "called_at":                    i.called_at.isoformat() if i.called_at else None,
            "started_at":                   i.started_at.isoformat() if i.started_at else None,
            "completed_at":                 i.completed_at.isoformat() if i.completed_at else None,
            "called_by_name":               i.called_by_name or "—",
            "started_by_name":              i.started_by_name or "—",
            "completed_by_name":            i.completed_by_name or "—",
            "intervention_type_name":       i.intervention_type_name or "—",
            "operator_note":                i.operator_note or "",
            "mechanic_note":                i.mechanic_note or "",
            "response_time_minutes":        i.response_time_minutes,
            "intervention_duration_minutes": i.intervention_duration_minutes,
            "total_downtime_minutes":       i.total_downtime_minutes,
            "ticket_id":                    str(i.ticket_id) if i.ticket_id else None,
        }

    return {"total": total, "items": [_fmt(i) for i in items]}


# ── Safety Checklist ────────────────────────────────────────────────────────

@router.get("/{machine_id}/checklist")
async def get_checklist(machine_id: str, db: AsyncSession = Depends(get_db)):
    _, equipment = await _resolve(machine_id, db)
    eq_id = equipment.id if equipment else None

    # Prefer equipment-specific checklist, then plant-level, then any active
    r = await db.execute(
        select(SafetyChecklist).where(
            and_(SafetyChecklist.is_active == True),
            or_(
                SafetyChecklist.equipment_id == eq_id,
                SafetyChecklist.equipment_id == None,
            ),
        ).order_by(
            (SafetyChecklist.equipment_id == eq_id).desc(),
            SafetyChecklist.name,
        ).limit(1)
    )
    checklist = r.scalar_one_or_none()
    if not checklist:
        return {"checklist_id": None, "name": None, "items": []}

    items_r = await db.execute(
        select(SafetyChecklistItem)
        .where(SafetyChecklistItem.checklist_id == checklist.id)
        .order_by(SafetyChecklistItem.sort_order)
    )
    items = items_r.scalars().all()
    return {
        "checklist_id": str(checklist.id),
        "name": checklist.name,
        "items": [
            {
                "id": str(item.id),
                "text": item.text,
                "sort_order": item.sort_order,
                "is_required": item.is_required,
            }
            for item in items
        ],
    }


class ChecklistSubmitBody(BaseModel):
    intervention_id: str
    responses: list[dict]


@router.post("/{machine_id}/checklist/submit")
async def submit_checklist(machine_id: str, body: ChecklistSubmitBody, db: AsyncSession = Depends(get_db)):
    try:
        inv_id = UUID(body.intervention_id)
    except ValueError:
        raise HTTPException(400, "Invalid intervention_id")

    intervention = await db.get(MachineIntervention, inv_id)
    if not intervention:
        raise HTTPException(404, "Intervention not found")

    now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
    for resp in body.responses:
        try:
            item_id = UUID(resp["item_id"])
        except (KeyError, ValueError):
            continue
        row = InterventionChecklistResponse(
            intervention_id=inv_id,
            checklist_item_id=item_id,
            item_text=resp.get("item_text", ""),
            checked=bool(resp.get("checked", False)),
            checked_at=now if resp.get("checked") else None,
        )
        db.add(row)

    await db.commit()
    return {"status": "ok", "saved": len(body.responses)}


# ── Parts during intervention ────────────────────────────────────────────────

@router.get("/{machine_id}/parts")
async def get_intervention_parts(
    machine_id: str,
    intervention_id: str,
    db: AsyncSession = Depends(get_db),
):
    await _resolve(machine_id, db)
    try:
        inv_id = UUID(intervention_id)
    except ValueError:
        raise HTTPException(400, "Invalid intervention_id")

    r = await db.execute(
        select(InterventionPart)
        .where(InterventionPart.intervention_id == inv_id)
        .order_by(InterventionPart.added_at)
    )
    parts = r.scalars().all()
    return {
        "items": [
            {
                "id": str(p.id),
                "intervention_id": str(p.intervention_id),
                "stock_item_id": str(p.stock_item_id) if p.stock_item_id else None,
                "item_code": p.item_code,
                "item_description": p.item_description,
                "quantity_used": p.quantity_used,
                "unit": p.unit,
                "approval_status": p.approval_status,
                "added_at": p.added_at.isoformat() if p.added_at else None,
            }
            for p in parts
        ]
    }


class AddPartBody(BaseModel):
    intervention_id: str
    stock_item_id: Optional[str] = None
    item_code: Optional[str] = None
    item_description: Optional[str] = None
    quantity_used: float = 1.0
    unit: Optional[str] = None


@router.post("/{machine_id}/parts")
async def add_intervention_part(machine_id: str, body: AddPartBody, db: AsyncSession = Depends(get_db)):
    await _resolve(machine_id, db)
    try:
        inv_id = UUID(body.intervention_id)
    except ValueError:
        raise HTTPException(400, "Invalid intervention_id")

    intervention = await db.get(MachineIntervention, inv_id)
    if not intervention:
        raise HTTPException(404, "Intervention not found")

    stock_id = None
    if body.stock_item_id:
        try:
            stock_id = UUID(body.stock_item_id)
        except ValueError:
            pass

    # If stock_item given, copy its description/code and snapshot the price
    item_code = body.item_code
    item_description = body.item_description
    unit = body.unit
    unit_cost = None
    if stock_id:
        stock = await db.get(StockItem, stock_id)
        if stock:
            item_code = item_code or stock.code
            item_description = item_description or stock.description or stock.name
            unit = unit or stock.unit
            unit_cost = stock.unit_cost

    part = InterventionPart(
        intervention_id=inv_id,
        stock_item_id=stock_id,
        item_code=item_code,
        item_description=item_description,
        quantity_used=body.quantity_used,
        unit=unit,
        unit_cost=unit_cost,
        total_cost=round(unit_cost * body.quantity_used, 2) if unit_cost is not None else None,
        approval_status="pending",
    )
    db.add(part)
    await db.commit()
    await db.refresh(part)
    return {
        "id": str(part.id),
        "intervention_id": str(part.intervention_id),
        "stock_item_id": str(part.stock_item_id) if part.stock_item_id else None,
        "item_code": part.item_code,
        "item_description": part.item_description,
        "quantity_used": part.quantity_used,
        "unit": part.unit,
        "unit_cost": part.unit_cost,
        "total_cost": part.total_cost,
        "approval_status": part.approval_status,
        "added_at": part.added_at.isoformat() if part.added_at else None,
    }


@router.delete("/{machine_id}/parts/{part_id}", status_code=204)
async def remove_intervention_part(machine_id: str, part_id: str, db: AsyncSession = Depends(get_db)):
    await _resolve(machine_id, db)
    try:
        pid = UUID(part_id)
    except ValueError:
        raise HTTPException(400, "Invalid part_id")

    part = await db.get(InterventionPart, pid)
    if not part:
        raise HTTPException(404, "Part not found")
    await db.delete(part)
    await db.commit()
