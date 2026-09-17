"""Kiosk intervention → work order bridge (labor side).

The floor kiosk is where a corrective repair is actually measured: technicians
check in and out of the intervention, and the intervention stamps its own
duration. The office work order created from that ticket, however, was born
``open`` with no ``started_at`` and no labor record, and the kiosk router never
touched work orders at all — so for every kiosk-driven repair the WO's Labor tab
was empty, ``repair_hours`` (→ MTTR) was NULL and labor cost was 0. The only
number the UI could show was plain wall-clock elapsed time, which matched
nothing that was recorded.

This module mirrors the kiosk's check-in ledger onto the linked WO:

* ``on_intervention_started``  → WO goes in_progress, ``started_at`` stamped,
  the labor clock opens for everyone checked in.
* ``on_checkins_changed``      → a tech joining/leaving mid-repair opens/closes
  their own labor record.
* ``on_intervention_completed`` → every open mirror is closed at the
  intervention's completion instant and the WO totals are rolled up.

Mirrors are keyed by ``LaborRecord.intervention_technician_id`` (one record per
check-in window), so every hook is idempotent and a tech who checks in twice
gets two honest windows instead of one that swallows the gap.

ONE RECORD PER TECHNICIAN PER STRETCH OF CLOCK, whichever door it came through:
the office Start button also opens a labor record (and creates an intervention
the kiosk can then complete), so if a supervisor started the WO and the mechanic
finished it at the kiosk, a naive mirror would book that half hour twice — the
Labor tab would list the same person twice and their cost would double. When an
existing record already covers the window, the bridge ADOPTS it (stamps the
provenance on it) instead of inserting another. Records that do not overlap —
a separate session, another day — stay untouched.

``hours_worked`` stays RAW (it feeds repair_hours/MTTR); effective hours and
cost come from ``labor_time_service``, exactly as the office flow does.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    InterventionTechnician, LaborRecord, MachineIntervention, MaintenanceTicket,
    Technician, User, UserPlant, UserRole, WorkOrder, WorkOrderStatus,
    WorkOrderTechnician,
)
from app.services import labor_time_service, wo_totals

ACTIVITY = "Kiosk intervention"

_CLOSED_WO = (WorkOrderStatus.completed, WorkOrderStatus.cancelled)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def wo_for_intervention(
    db: AsyncSession, intervention: MachineIntervention
) -> Optional[WorkOrder]:
    """The work order this intervention represents, via their shared ticket."""
    if not intervention.ticket_id:
        return None
    ticket = await db.get(MaintenanceTicket, intervention.ticket_id)
    if ticket and ticket.work_order_id:
        wo = await db.get(WorkOrder, ticket.work_order_id)
        if wo:
            return wo
    r = await db.execute(
        select(WorkOrder)
        .where(WorkOrder.ticket_id == intervention.ticket_id)
        .order_by(WorkOrder.opened_at.desc())
        .limit(1)
    )
    return r.scalar_one_or_none()


async def _technician_belongs_to_plant(db: AsyncSession, technician_id, plant_id) -> bool:
    """Same rule every office assignment path enforces via
    ``plant_scope.require_technician_in_plant``: the technician's user must hold a
    membership in the WO's plant. The kiosk is unauthenticated and its technician
    picker is not plant-filtered, so without this a check-in on a Saint-Jérôme
    machine could put a Mirabel-only mechanic on a Saint-Jérôme work order —
    a state the office UI refuses to create, and one where the assignee cannot
    even open the WO he was assigned."""
    if plant_id is None:
        return True                     # plant-less WO (legacy row) — nothing to enforce
    tech = await db.get(Technician, technician_id)
    if not tech:
        return False
    user = await db.get(User, tech.user_id) if tech.user_id else None
    if user is not None and user.role == UserRole.admin:
        return True                     # corporate admins pass, as in the office guard
    member = (await db.execute(
        select(UserPlant.id).where(
            UserPlant.user_id == tech.user_id, UserPlant.plant_id == plant_id
        )
    )).first()
    return member is not None


async def _ensure_wo_technician(db: AsyncSession, wo: WorkOrder, technician_id) -> None:
    """Credit a checked-in technician on the WO. The first one also becomes the
    primary/executor when the WO has nobody yet (a ticket can be closed by
    someone other than whoever it was assigned to)."""
    if not await _technician_belongs_to_plant(db, technician_id, wo.plant_id):
        return
    existing = (await db.execute(
        select(WorkOrderTechnician).where(
            WorkOrderTechnician.work_order_id == wo.id,
            WorkOrderTechnician.technician_id == technician_id,
        )
    )).scalars().first()
    if existing:
        return
    is_primary = wo.executor_id is None
    db.add(WorkOrderTechnician(
        work_order_id=wo.id, technician_id=technician_id, is_primary=is_primary,
    ))
    if is_primary:
        wo.executor_id = technician_id
        tech = await db.get(Technician, technician_id)
        if tech and not wo.assigned_to_id:
            wo.assigned_to_id = tech.user_id


async def _mirror_for_checkin(db: AsyncSession, itech_id) -> Optional[LaborRecord]:
    return (await db.execute(
        select(LaborRecord)
        .where(LaborRecord.intervention_technician_id == itech_id)
        .limit(1)
    )).scalars().first()


async def _fallback_mirror(
    db: AsyncSession, intervention_id, technician_id
) -> Optional[LaborRecord]:
    """Mirror for an intervention nobody checked into (credited to the starter)."""
    return (await db.execute(
        select(LaborRecord)
        .where(
            LaborRecord.intervention_id == intervention_id,
            LaborRecord.technician_id == technician_id,
            LaborRecord.intervention_technician_id.is_(None),
        )
        .limit(1)
    )).scalars().first()


async def _adoptable_record(
    db: AsyncSession, wo: WorkOrder, technician_id, window_start: datetime,
    window_end: Optional[datetime],
) -> Optional[LaborRecord]:
    """An existing labor record for this technician that already covers this
    window and is not another intervention's mirror.

    Adopted instead of duplicated (see the module docstring): the office Start
    button opens exactly such a record, and the backfill replays interventions
    whose WO already carries one. Still-open records count as covering — that is
    a clock this repair is what closes."""
    rows = (await db.execute(
        select(LaborRecord).where(
            LaborRecord.work_order_id == wo.id,
            LaborRecord.technician_id == technician_id,
            LaborRecord.intervention_id.is_(None),
        )
        .order_by(LaborRecord.started_at.asc())
    )).scalars().all()
    end = window_end or window_start
    for rec in rows:
        start, stop = _aware(rec.started_at), _aware(rec.stopped_at)
        if start is None:
            continue                      # manual "N hours" entry, not placed in time
        if stop is None:
            return rec                    # an open clock for this tech on this WO
        if start <= end and window_start <= stop:
            return rec                    # overlaps the same stretch of clock
    return None


async def _drop_superseded_fallback(
    db: AsyncSession, intervention_id, technician_ids: set
) -> None:
    """Remove a whole-intervention mirror left over once check-in windows exist.

    ``on_intervention_started`` runs before anyone has checked in, so it opens a
    fallback mirror for the starter covering the entire intervention. Normally the
    first check-in ABSORBS that row (see ``_upsert_mirror``, which keeps its
    earlier start). This clears anything still left — a technician who checked in
    twice, or a mirror written before this rule existed — because sync_labor only
    ever looks at check-in rows afterwards, so a leftover would stay open and be
    credited the full repair a second time at completion."""
    if not technician_ids:
        return
    for rec in (await db.execute(
        select(LaborRecord).where(
            LaborRecord.intervention_id == intervention_id,
            LaborRecord.intervention_technician_id.is_(None),
        )
    )).scalars().all():
        if rec.technician_id in technician_ids:
            await db.delete(rec)


async def _starter_technician(
    db: AsyncSession, intervention: MachineIntervention, wo: WorkOrder
) -> Optional[Technician]:
    """Who to credit when there is no check-in row: the user who started the
    intervention at the kiosk, else the WO's own executor."""
    if intervention.started_by_id:
        tech = (await db.execute(
            select(Technician).where(Technician.user_id == intervention.started_by_id)
        )).scalars().first()
        if tech:
            return tech
    if wo.executor_id:
        return await db.get(Technician, wo.executor_id)
    return None


async def _upsert_mirror(
    db: AsyncSession,
    wo: WorkOrder,
    intervention: MachineIntervention,
    *,
    technician_id,
    started_at: datetime,
    stopped_at: Optional[datetime],
    checkin_id=None,
) -> None:
    """Create or refresh the labor record mirroring one work window."""
    if stopped_at and stopped_at <= started_at:
        return  # zero-length window (checked out at the same instant) — nothing to log

    rec = (
        await _mirror_for_checkin(db, checkin_id) if checkin_id
        else await _fallback_mirror(db, intervention.id, technician_id)
    )

    # The technician tapped Start before checking in: re-key that whole-intervention
    # mirror to this check-in rather than leaving it behind (its start is the
    # earlier, and truer, one — work began when the repair did).
    if rec is None and checkin_id:
        rec = await _fallback_mirror(db, intervention.id, technician_id)
        if rec is not None:
            rec.intervention_technician_id = checkin_id

    # Prefer a record that already covers this window over inserting a second one.
    adopted = await _adoptable_record(db, wo, technician_id, started_at, stopped_at)
    if adopted is not None:
        if rec is not None and rec.id != adopted.id:
            await db.delete(rec)          # a duplicate mirror written before this rule existed
        adopted.intervention_id = intervention.id
        adopted.intervention_technician_id = checkin_id
        rec = adopted        # its start is folded in below, whichever is earlier

    existing_start = _aware(rec.started_at) if rec is not None else None
    if existing_start and existing_start < started_at:
        started_at = existing_start

    if rec is None:
        tech = await db.get(Technician, technician_id)
        rec = LaborRecord(
            work_order_id=wo.id,
            technician_id=technician_id,
            date=started_at.date(),
            hours_worked=0.0,
            hourly_rate=tech.hourly_rate if tech else None,
            activity=ACTIVITY,
            intervention_id=intervention.id,
            intervention_technician_id=checkin_id,
        )
        db.add(rec)
    elif rec.stopped_at is not None and stopped_at is None:
        return  # already settled; never reopen a closed window

    rec.started_at = started_at
    rec.stopped_at = stopped_at
    rec.date = started_at.date()
    if stopped_at:
        rec.hours_worked = round((stopped_at - started_at).total_seconds() / 3600, 4)
        await labor_time_service.apply_to_record(db, rec, work_order=wo)

    await _ensure_wo_technician(db, wo, technician_id)


async def sync_labor(
    db: AsyncSession, intervention: MachineIntervention
) -> Optional[WorkOrder]:
    """Mirror the intervention's check-in ledger onto its WO's labor records.
    Idempotent; does not commit. Returns the WO it worked on (if any)."""
    if not intervention.started_at:
        return None  # still waiting for a technician — nothing measured yet
    wo = await wo_for_intervention(db, intervention)
    if not wo or wo.status == WorkOrderStatus.cancelled:
        return None

    started = _aware(intervention.started_at)
    completed = _aware(intervention.completed_at)

    checkins = (await db.execute(
        select(InterventionTechnician)
        .where(
            InterventionTechnician.intervention_id == intervention.id,
            InterventionTechnician.technician_id.isnot(None),
        )
        .order_by(InterventionTechnician.checked_in_at.asc())
    )).scalars().all()

    if checkins:
        for ci in checkins:
            # Work starts when the tech is on the machine AND the repair is
            # running: a tech who checked in during the wait is not repairing yet.
            window_start = max(_aware(ci.checked_in_at) or started, started)
            window_end = _aware(ci.checked_out_at) or completed
            await _upsert_mirror(
                db, wo, intervention,
                technician_id=ci.technician_id,
                started_at=window_start,
                stopped_at=window_end,
                checkin_id=ci.id,
            )
        # Anything the check-ins did not absorb (a second check-in, an older
        # mirror) would otherwise be credited the repair twice.
        await _drop_superseded_fallback(
            db, intervention.id, {ci.technician_id for ci in checkins}
        )
    else:
        tech = await _starter_technician(db, intervention, wo)
        if tech:
            await _upsert_mirror(
                db, wo, intervention,
                technician_id=tech.id,
                started_at=started,
                stopped_at=completed,
            )
    return wo


async def on_intervention_started(
    db: AsyncSession, intervention: MachineIntervention
) -> Optional[WorkOrder]:
    """Kiosk start → the WO is really in progress. Does not commit."""
    wo = await wo_for_intervention(db, intervention)
    if not wo or wo.status in _CLOSED_WO:
        return await sync_labor(db, intervention)

    if wo.status in (WorkOrderStatus.open, WorkOrderStatus.on_hold):
        wo.status = WorkOrderStatus.in_progress
    if not wo.started_at:
        wo.started_at = intervention.started_at
    return await sync_labor(db, intervention)


async def on_checkins_changed(
    db: AsyncSession, intervention: MachineIntervention
) -> Optional[WorkOrder]:
    """A technician joined or left the intervention. Does not commit."""
    return await sync_labor(db, intervention)


async def on_intervention_completed(
    db: AsyncSession, intervention: MachineIntervention
) -> Optional[WorkOrder]:
    """Kiosk completion → close every mirror at the completion instant and roll
    the WO's time and cost up from its ledgers. Does not commit."""
    wo = await sync_labor(db, intervention)
    if not wo:
        return None

    # A WO closed straight from the kiosk (or replayed by the backfill) never went
    # through the office Start button, so stamp when the work actually began —
    # otherwise the detail page shows labor from 11:38 next to an empty "started".
    if not wo.started_at:
        wo.started_at = intervention.started_at

    # Close this intervention's own still-open records at the completion instant.
    # Scoped to intervention_id on purpose: sweeping every open record on the WO
    # would credit an unrelated office clock the whole repair on top of the window
    # already mirrored for it (ticket_service._close_linked_wo stamps those).
    end = _aware(intervention.completed_at) or datetime.now(timezone.utc)
    for rec in (await db.execute(
        select(LaborRecord).where(
            LaborRecord.work_order_id == wo.id,
            LaborRecord.intervention_id == intervention.id,
            LaborRecord.stopped_at.is_(None),
        )
    )).scalars().all():
        started = _aware(rec.started_at)
        if not started or end <= started:
            continue
        rec.stopped_at = end
        rec.hours_worked = round((end - started).total_seconds() / 3600, 4)
        await labor_time_service.apply_to_record(db, rec, work_order=wo)

    await wo_totals.recompute(db, wo, keep_existing_time=True)
    return wo
