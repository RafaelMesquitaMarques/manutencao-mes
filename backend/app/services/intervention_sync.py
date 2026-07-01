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

from app.models.models import (
    Machine, MachineIntervention, MachineStatus, MachineStop, StopCategory,
    StopCategoryType, WorkOrder, WorkOrderType, MaintenanceTicket,
)

ACTIVE_STATUSES = ("waiting", "in_progress")


async def _open_stop(db: AsyncSession, machine_id) -> Optional[MachineStop]:
    """The machine's currently-open stop (not yet ended), if any."""
    r = await db.execute(
        select(MachineStop)
        .where(MachineStop.machine_id == machine_id, MachineStop.ended_at.is_(None))
        .order_by(MachineStop.started_at.desc())
    )
    return r.scalars().first()


async def _maintenance_category_id(db: AsyncSession):
    """A maintenance-type stop category to tag auto-created downtime (global first)."""
    for conds in (
        (StopCategory.type == StopCategoryType.maintenance, StopCategory.is_global == True),  # noqa: E712
        (StopCategory.type == StopCategoryType.maintenance,),
    ):
        cid = (await db.execute(select(StopCategory.id).where(*conds).limit(1))).scalar()
        if cid:
            return cid
    return None


async def _production_running(db: AsyncSession, machine) -> Optional[bool]:
    """Is the machine currently producing, per the production I/O signal
    (Advantech ADAM-6050)? True = producing, False = idle, None = unknown.

    The ADAM-6050 isn't wired yet (pilot pending), so this returns None today and
    the caller falls back to 'unjustified' — the machine waits instead of being
    assumed back in production. When the ADAM feed lands, read it here and return
    True/False; the finish logic then resumes 'running' or holds it pink with no
    other change needed."""
    return None


async def apply_production_signal(db: AsyncSession, machine, is_running: bool) -> None:
    """Reconcile a machine's live status with the production I/O reading (ADAM-6050).

    THIS is the signal-driven path — the machine returns to production by its own
    status reading, never by an operator restart. The ADAM ingest (endpoint/poller,
    pending hardware) calls this per reading, mirroring robot_cell_ingest for cobots.

    Conservative guards:
      • Never disturb an ACTIVE technician intervention — a stray reading must not
        yank the machine out of 'intervention' while a repair is under way.
      • Non-signal machines: never override an operator-justified stop (the floor
        owns those). Signal-driven machines: the I/O reading IS the source of truth,
        so a positive signal resumes production and closes whatever downtime stop
        was open (operator ones included) — a maintenance stop carrying a ticket is
        left for the maintenance flow.
      • Not producing (was running) → open a pink 'unjustified' MES stop (detected stop)."""
    if await _active_for_machine(db, machine.id) is not None:
        return
    signal_driven = bool(getattr(machine, "signal_ingest_token", None))
    if not signal_driven:
        operator_stop = (await db.execute(
            select(MachineStop).where(
                MachineStop.machine_id == machine.id,
                MachineStop.ended_at.is_(None),
                MachineStop.source == "operator",
            )
        )).scalars().first()
        if operator_stop is not None:
            return
    now = datetime.now(timezone.utc)
    if is_running:
        if machine.current_status == MachineStatus.running:
            return
        # Close the open stop(s) this signal may close. Signal-driven: any open
        # downtime stop without a maintenance ticket. Else: only our own auto stops.
        q = select(MachineStop).where(
            MachineStop.machine_id == machine.id,
            MachineStop.ended_at.is_(None),
        )
        if signal_driven:
            q = q.where(MachineStop.ticket_id.is_(None))
        else:
            q = q.where(MachineStop.source.in_(("mes", "work_order")))
        for open_stop in (await db.execute(
            q.order_by(MachineStop.started_at.desc())
        )).scalars().all():
            open_stop.ended_at = now
            st = open_stop.started_at
            if st and st.tzinfo is None:
                st = st.replace(tzinfo=timezone.utc)
            open_stop.duration_minutes = max(int((now - st).total_seconds() / 60), 0) if st else None
        machine.current_status = MachineStatus.running
        machine.last_start_at = now
    else:
        if machine.current_status == MachineStatus.running:
            machine.current_status = MachineStatus.unjustified
            db.add(MachineStop(
                machine_id=machine.id, started_at=now, stop_category_id=None,
                source="mes", comments="Auto — arrêt détecté (aucune production)",
            ))
            machine.last_stop_at = now


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

    # Bridge to the live twin/kiosk: a corrective WO going active means a
    # technician is now working the machine → paint it "intervention" (purple),
    # mirroring the kiosk's own start-intervention. Preventive/scheduled work
    # doesn't take the machine down, so it leaves the live status untouched.
    if wo.type == WorkOrderType.corrective:
        if machine.current_status != MachineStatus.intervention:
            machine.current_status = MachineStatus.intervention
        # Feed Availability/OEE: ensure an OPEN maintenance stop tracks the downtime.
        # Reuse whatever stop is already open (e.g. the operator justified one on the
        # kiosk) so downtime is never double-counted; only open our own when there is
        # none — the pure office/mobile case the kiosk would otherwise miss.
        if not await _open_stop(db, machine.id):
            db.add(MachineStop(
                machine_id=machine.id,
                started_at=started,
                stop_category_id=await _maintenance_category_id(db),
                ticket_id=wo.ticket_id,
                source="work_order",
                justified_by=started_by_name,
                comments="Auto — intervention démarrée depuis l'ordre de travail",
            ))

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
    now = datetime.now(timezone.utc)
    active = await _active_for_machine(db, machine.id)
    if active and not (active.ticket_id and wo.ticket_id and active.ticket_id != wo.ticket_id):
        _complete(active, now)
        machine.last_maintenance_at = now

    # Close the maintenance stop WE opened (source='work_order') so its downtime lands
    # in Availability/OEE. An operator-owned stop is left open for the kiosk to close on
    # restart — we never end the operator's downtime early.
    our_stop = (await db.execute(
        select(MachineStop).where(
            MachineStop.machine_id == machine.id,
            MachineStop.ended_at.is_(None),
            MachineStop.source == "work_order",
        ).order_by(MachineStop.started_at.desc())
    )).scalars().first()
    if our_stop is not None:
        our_stop.ended_at = now
        st = our_stop.started_at
        if st and st.tzinfo is None:
            st = st.replace(tzinfo=timezone.utc)
        our_stop.duration_minutes = max(int((now - st).total_seconds() / 60), 0) if st else None

    # Repaint after the repair. We do NOT assume the line is producing again — with no
    # positive production signal (the ADAM-6050 I/O isn't wired yet) the machine waits:
    #   • another stop still open (operator/MES)  → still down → "maintenance" (amber)
    #   • production confirmed running             → "running" (green)   [future: ADAM feed]
    #   • otherwise                                → "unjustified" (pink) + an open,
    #     reclassifiable MES stop so post-maintenance downtime keeps counting until the
    #     operator restarts production or justifies it.
    if machine.current_status == MachineStatus.intervention:
        other_open = await _open_stop(db, machine.id)
        if other_open is not None:
            machine.current_status = MachineStatus.maintenance
        elif (await _production_running(db, machine)) is True:
            machine.current_status = MachineStatus.running
            machine.last_start_at = now
        else:
            machine.current_status = MachineStatus.unjustified
            db.add(MachineStop(
                machine_id=machine.id, started_at=now, stop_category_id=None,
                source="mes", comments="Auto — en attente de production après maintenance",
            ))
            machine.last_stop_at = now


async def on_wo_held(db: AsyncSession, wo: WorkOrder) -> None:
    """A machine-linked WO paused (on hold): the technician stepped away, so the
    machine is no longer actively worked. Revert OUR 'intervention' paint back to
    'maintenance' (amber = waiting) — guarded so a floor-set state (e.g. a fresh
    stop) is never clobbered. The intervention record stays active: the job isn't
    done, and no machine_stop is touched (that's the kiosk's to own)."""
    machine = await _machine_for_wo(db, wo)
    if not machine:
        return
    if machine.current_status == MachineStatus.intervention:
        machine.current_status = MachineStatus.maintenance


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
