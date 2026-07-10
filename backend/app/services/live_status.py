"""Effective (live) operational status for assets — the single source of truth.

The static `equipment.status` column only tracks the catalog lifecycle
(running / in_maintenance / stopped / scrapped). The *live* status comes from
the linked kiosk `machine` row, open maintenance tickets, robot-cell telemetry
and the parent-machine relationship. The factory map has always computed this;
the equipment catalog now shares the same primitives so the two never drift.
"""
from dataclasses import dataclass
from typing import Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    Equipment, InterventionTechnician, LaborRecord, Machine, MachineIntervention,
    MaintenanceTicket, Technician, TicketStatus, User, WorkOrder, RobotCell,
    RobotCellState,
)

# Intervention statuses that mean a technician is actively on the machine.
ACTIVE_INTERVENTION_STATUSES = ("in_progress", "waiting")

# Static equipment.status → map/live status vocabulary
EQ_STATUS_MAP = {
    "running": "running",
    "in_maintenance": "maintenance",
    "stopped": "stopped",
    "scrapped": "idle",
}

# Live robot-cell run_state → status (cobots are auxiliary, no Machine layer).
CELL_RUN_MAP = {"running": "running", "stopped": "stopped", "fault": "maintenance", "idle": "idle"}

OPEN_TICKET_STATUSES = [
    TicketStatus.open, TicketStatus.in_progress,
    TicketStatus.on_hold_parts, TicketStatus.on_hold_ext,
]

# Statuses that mean "the machine is down" for dependent assets
DOWN_STATUSES = ("stopped", "maintenance", "planned_stop", "intervention", "unjustified")


def effective_status(base: str, open_ticket: bool) -> str:
    """Map colour priority: a physically stopped machine is red; a technician
    actively working (intervention) shows purple even while its ticket is still
    open; otherwise an open maintenance call turns it amber; else the live status."""
    if base == "stopped":
        return "stopped"
    if base == "intervention":
        return "intervention"
    if base == "maintenance" or open_ticket:
        return "maintenance"
    return base


@dataclass
class LiveAsset:
    """Everything the live views need about one asset, computed once.

    `status` is the effective (colour-priority) status; `machine` is the linked
    ACTIVE kiosk row (or None); `operator` is who is signed in; `open_ticket` is
    ``{"id", "number"}`` for the open maintenance call, or None.
    """
    status: str
    operator: Optional[str]
    machine: Optional[Machine]
    open_ticket: Optional[dict]
    # Technicians actively working the machine (only when the effective status is
    # "intervention" / purple) — one entry per tech on the clock, each
    # ``{"name": str, "since": str|None}`` (ISO start). Drives the map pictograms
    # (one figure per technician). Empty/None when not purple or nobody clocked in.
    technicians: Optional[list] = None


async def live_details_by_equipment(
    db: AsyncSession, equipment: Sequence[Equipment],
) -> dict[str, LiveAsset]:
    """Full live snapshot per equipment id (str) for a batch of assets.

    Single source of truth for the factory-map rules: machine.current_status >
    cell run_state > static equipment status; conveyors/cobots inherit a down
    parent machine; an open ticket turns the asset amber unless it is already
    stopped/purple. Carries operator + open-ticket details so the map/live
    endpoints compose their payloads without re-deriving status.
    """
    if not equipment:
        return {}

    machines = (await db.execute(select(Machine))).scalars().all()
    # Only ACTIVE machines attach live status to their asset (inactive shells
    # remain when an asset switches production→auxiliary).
    machine_by_eq = {str(m.equipment_id): m for m in machines if m.equipment_id and m.is_active}

    open_rows = (await db.execute(
        select(MaintenanceTicket.machine_id, MaintenanceTicket.id, MaintenanceTicket.ticket_number)
        .where(MaintenanceTicket.status.in_(OPEN_TICKET_STATUSES))
    )).all()
    open_by_machine: dict[str, dict] = {}
    for mid, tid, tnum in open_rows:
        if mid and str(mid) not in open_by_machine:
            open_by_machine[str(mid)] = {"id": str(tid), "number": tnum}

    cell_run = dict((await db.execute(
        select(RobotCell.equipment_id, RobotCellState.run_state)
        .join(RobotCellState, RobotCellState.cell_id == RobotCell.id)
    )).all())

    # Technicians actively working each machine (for the purple/intervention
    # pictograms — one figure per tech). PRIMARY source: OPEN labor records
    # (stopped_at IS NULL) → one per technician on the clock, each with its own
    # started_at, joined to the machine via the work order's equipment.
    labor_by_eq: dict[str, list[dict]] = {}
    for eq_id, name, since in (await db.execute(
        select(WorkOrder.equipment_id, User.name, LaborRecord.started_at)
        .select_from(LaborRecord)
        .join(WorkOrder, LaborRecord.work_order_id == WorkOrder.id)
        .join(Technician, LaborRecord.technician_id == Technician.id)
        .join(User, Technician.user_id == User.id)
        .where(LaborRecord.stopped_at.is_(None), WorkOrder.equipment_id.isnot(None))
        .order_by(LaborRecord.started_at.asc().nullslast())
    )).all():
        if eq_id and name:
            labor_by_eq.setdefault(str(eq_id), []).append(
                {"name": name, "since": since.isoformat() if since else None})

    # Kiosk check-ins: every tech checked in on the machine's active intervention
    # (the kiosk flow has no WO labor records, so this is its multi-tech source).
    checkin_by_machine: dict[str, list[dict]] = {}
    for mid, name, since in (await db.execute(
        select(MachineIntervention.machine_id, InterventionTechnician.name,
               InterventionTechnician.checked_in_at)
        .select_from(InterventionTechnician)
        .join(MachineIntervention,
              InterventionTechnician.intervention_id == MachineIntervention.id)
        .where(InterventionTechnician.checked_out_at.is_(None),
               MachineIntervention.status.in_(ACTIVE_INTERVENTION_STATUSES))
        .order_by(InterventionTechnician.checked_in_at.asc())
    )).all():
        if mid and name:
            checkin_by_machine.setdefault(str(mid), []).append(
                {"name": name, "since": since.isoformat() if since else None})

    # FALLBACK (e.g. kiosk intervention with no WO labor): the single tech who
    # started the newest active intervention, keyed by machine.
    fallback_by_machine: dict[str, dict] = {}
    for mid, name, since in (await db.execute(
        select(MachineIntervention.machine_id, MachineIntervention.started_by_name,
               MachineIntervention.started_at)
        .where(MachineIntervention.status.in_(ACTIVE_INTERVENTION_STATUSES))
        .order_by(MachineIntervention.started_at.desc().nullslast(),
                  MachineIntervention.called_at.desc())
    )).all():
        if mid and name and str(mid) not in fallback_by_machine:
            fallback_by_machine[str(mid)] = {"name": name, "since": since.isoformat() if since else None}

    def _own_status(eid, eq_status: Optional[str], machine: Optional[Machine]) -> str:
        """One asset's operational status: machine status > cell run_state > equipment status."""
        if machine and machine.current_status:
            s = machine.current_status.value
        else:
            s = EQ_STATUS_MAP.get(eq_status or "running", "idle")
        if eid in cell_run and cell_run[eid] in CELL_RUN_MAP:
            s = CELL_RUN_MAP[cell_run[eid]]
        return s

    # Parent machines may not be part of the requested batch → fetch them, and
    # use their EFFECTIVE status so an amber-from-ticket machine still pulls
    # its cobots/conveyors down.
    parent_ids = {e.parent_equipment_id for e in equipment if e.parent_equipment_id}
    parent_status: dict = {}
    if parent_ids:
        for pe in (await db.execute(select(Equipment).where(Equipment.id.in_(parent_ids)))).scalars().all():
            pm = machine_by_eq.get(str(pe.id))
            p_ticket = open_by_machine.get(str(pm.id)) if pm else None
            parent_status[pe.id] = effective_status(
                _own_status(pe.id, pe.status.value if pe.status else None, pm),
                p_ticket is not None,
            )

    out: dict[str, LiveAsset] = {}
    for e in equipment:
        m = machine_by_eq.get(str(e.id))
        operator = m.current_operator if (m and m.current_status) else None
        status = _own_status(e.id, e.status.value if e.status else None, m)
        # Parent-machine relationship:
        #  • conveyors (and cobots without live telemetry) follow the machine entirely;
        #  • a cobot WITH telemetry is independent while the machine runs, but STOPS
        #    when its machine is down.
        is_cobot = "cobot" in (e.subtype or "").lower() or e.block_kind == "cobot"
        if e.parent_equipment_id:
            pstat = parent_status.get(e.parent_equipment_id)
            parent_down = pstat in DOWN_STATUSES
            if is_cobot and e.id in cell_run:
                if parent_down:
                    status = pstat
            elif pstat:
                status = pstat
        ticket = open_by_machine.get(str(m.id)) if m else None
        eff = effective_status(status, ticket is not None)
        # Only surface technicians when the asset is actually purple: the open
        # labor records for this machine's equipment, else the intervention starter.
        techs = None
        if m and eff == "intervention":
            # WO labor records + kiosk check-ins, deduped by name (a tech can
            # have both); else the intervention starter as a last resort.
            merged = list(labor_by_eq.get(str(e.id)) or [])
            for ci in checkin_by_machine.get(str(m.id), []):
                if all(t["name"] != ci["name"] for t in merged):
                    merged.append(ci)
            if not merged:
                fb = fallback_by_machine.get(str(m.id))
                merged = [fb] if fb else []
            techs = merged or None
        out[str(e.id)] = LiveAsset(
            status=eff,
            operator=operator,
            machine=m,
            open_ticket=ticket,
            technicians=techs,
        )
    return out


async def live_status_by_equipment(
    db: AsyncSession, equipment: Sequence[Equipment],
) -> dict[str, str]:
    """Effective live status per equipment id (str) — thin view over
    :func:`live_details_by_equipment` for callers that only need the colour."""
    details = await live_details_by_equipment(db, equipment)
    return {eid: la.status for eid, la in details.items()}
