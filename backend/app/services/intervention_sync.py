"""Keep MachineIntervention in sync with work-order activity.

The kiosk call flow creates interventions when the operator presses
"Appeler la maintenance". Work orders started from the office have no
intervention record — without one the machine page can't show that work
is in progress. These helpers create or complete an intervention whenever
a machine-linked WO changes state, so the kiosk always reflects reality.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Machine, MachineIntervention, WorkOrder, MaintenanceTicket

ACTIVE_STATUSES = ("waiting", "in_progress")


def _minutes(start: Optional[datetime], end: Optional[datetime]) -> Optional[float]:
    if not start or not end:
        return None
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return round((end - start).total_seconds() / 60, 2)


async def _machine_for_wo(db: AsyncSession, wo: WorkOrder) -> Optional[Machine]:
    if wo.machine_id:
        machine = await db.get(Machine, wo.machine_id)
        if machine:
            return machine
    # WOs generated from tickets may predate machine_id — follow the ticket
    if wo.ticket_id:
        ticket = await db.get(MaintenanceTicket, wo.ticket_id)
        if ticket and ticket.machine_id:
            machine = await db.get(Machine, ticket.machine_id)
            if machine:
                return machine
    if wo.equipment_id:
        # Machines auto-provisioned from equipment share its UUID
        machine = await db.get(Machine, wo.equipment_id)
        if machine:
            return machine
        r = await db.execute(select(Machine).where(Machine.equipment_id == wo.equipment_id))
        return r.scalars().first()
    return None


async def _active_for_machine(db: AsyncSession, machine_id) -> Optional[MachineIntervention]:
    r = await db.execute(
        select(MachineIntervention)
        .where(
            MachineIntervention.machine_id == machine_id,
            MachineIntervention.status.in_(ACTIVE_STATUSES),
        )
        .order_by(MachineIntervention.called_at.desc())
    )
    return r.scalars().first()


def _complete(intervention: MachineIntervention, now: datetime) -> None:
    intervention.status = "completed"
    intervention.completed_at = now
    if intervention.response_time_minutes is None:
        intervention.response_time_minutes = _minutes(intervention.called_at, intervention.started_at)
    if intervention.intervention_duration_minutes is None:
        intervention.intervention_duration_minutes = _minutes(intervention.started_at, now)
    if intervention.total_downtime_minutes is None:
        intervention.total_downtime_minutes = _minutes(intervention.called_at, now)


async def on_wo_started(
    db: AsyncSession,
    wo: WorkOrder,
    started_by_name: Optional[str] = None,
) -> None:
    """A machine-linked WO went in_progress: make sure the machine page
    shows an active intervention. Idempotent — reuses the operator's call
    when one is waiting, no-ops when one is already running."""
    machine = await _machine_for_wo(db, wo)
    if not machine:
        return
    now = datetime.now(timezone.utc)
    started = wo.started_at or now

    active = await _active_for_machine(db, machine.id)
    if active:
        if active.status == "waiting":
            active.status = "in_progress"
            active.started_at = active.started_at or started
            active.response_time_minutes = _minutes(active.called_at, active.started_at)
            if started_by_name and not active.started_by_name:
                active.started_by_name = started_by_name
        return

    db.add(MachineIntervention(
        machine_id=machine.id,
        equipment_id=wo.equipment_id,
        ticket_id=wo.ticket_id,
        status="in_progress",
        called_at=started,
        started_at=started,
        operator_note=wo.title,
        started_by_name=started_by_name,
    ))


async def on_wo_finished(db: AsyncSession, wo: WorkOrder) -> None:
    """A machine-linked WO completed/cancelled: close the machine's active
    intervention (skipping interventions that belong to a different ticket)."""
    machine = await _machine_for_wo(db, wo)
    if not machine:
        return
    active = await _active_for_machine(db, machine.id)
    if not active:
        return
    if active.ticket_id and wo.ticket_id and active.ticket_id != wo.ticket_id:
        return
    now = datetime.now(timezone.utc)
    _complete(active, now)
    machine.last_maintenance_at = now


async def on_ticket_closed(db: AsyncSession, ticket: MaintenanceTicket) -> None:
    """Ticket closed from the office: close its intervention if still active."""
    r = await db.execute(
        select(MachineIntervention).where(
            MachineIntervention.ticket_id == ticket.id,
            MachineIntervention.status.in_(ACTIVE_STATUSES),
        )
    )
    active = r.scalars().first()
    if not active:
        return
    now = datetime.now(timezone.utc)
    _complete(active, now)
    machine = await db.get(Machine, ticket.machine_id)
    if machine:
        machine.last_maintenance_at = now
