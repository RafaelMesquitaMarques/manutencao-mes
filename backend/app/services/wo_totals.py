"""Work-order totals roll-up — one place that answers "how long did this take
and what did it cost?".

Before this module every completion path computed it again, differently:
``work_orders.complete_work_order`` summed labor + parts, while
``ticket_service._close_linked_wo`` (the path a kiosk repair actually takes)
only looked at ``wo.started_at`` and truncated the span to whole minutes — so a
short floor repair finished with ``repair_hours`` NULL and ``total_cost`` NULL,
and the WO detail page fell back to showing plain wall-clock elapsed time.

Precedence for the repair time (first hit wins):
  1. an explicit value the caller was given (a human typed it)
  2. the WALL-CLOCK UNION of the RAW labor windows — see ``_union_minutes``
  3. the linked kiosk intervention's own measured duration
  4. elapsed ``started_at`` → ``completed_at``

``repair_hours`` is a DURATION, not an effort: every consumer reads it as time to
repair (kpis MTTR and /mttr, reports, Equipment "avg repair", the WO card). So two
technicians working the same 2 minutes is a 2-minute repair, not 4 minutes of
MTTR — hence the union rather than a plain sum. Effort per technician stays where
it belongs, on the labor records (and their cost).

Cost is labor + parts + other, from their own ledgers. Parts live in TWO of them:
``wo_parts`` (added in the office) and approved ``intervention_parts`` (declared
at the kiosk). Every platform aggregate already sums both — kpis ``_parts_cost``,
the Costs monthly actuals, the machine cost card, ``/transactions``, reports — and
only the WO page was reading ``wo_parts`` alone, which is why a part consumed on
the floor showed up as money everywhere except on its own work order. So the WO
reads the same union; the two ledgers are never merged, or the money would be
counted twice.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    InterventionPart, LaborRecord, MachineIntervention, WOCost, WOPart, WorkOrder,
    WorkOrderStatus,
)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _union_minutes(labor) -> float:
    """Minutes of wall-clock repair represented by a set of labor records.

    Timestamped windows are merged, so concurrent technicians count once (the
    repair took as long as it took) while separate sessions on different days add
    up. Records with no timestamps are manual entries — a human asserting "I
    spent N hours" — which cannot be placed in time, so they are added as given.
    """
    spans = []
    untimed = 0.0
    for r in labor:
        start, stop = _aware(r.started_at), _aware(r.stopped_at)
        if start and stop and stop > start:
            spans.append((start, stop))
        else:
            untimed += (r.hours_worked or 0.0) * 60

    merged = 0.0
    cursor_start = cursor_end = None
    for start, stop in sorted(spans):
        if cursor_end is None:
            cursor_start, cursor_end = start, stop
        elif start <= cursor_end:                     # overlaps → same stretch of clock
            cursor_end = max(cursor_end, stop)
        else:
            merged += (cursor_end - cursor_start).total_seconds() / 60
            cursor_start, cursor_end = start, stop
    if cursor_end is not None:
        merged += (cursor_end - cursor_start).total_seconds() / 60

    return merged + untimed


async def _intervention_for(db: AsyncSession, wo: WorkOrder) -> Optional[MachineIntervention]:
    """The kiosk intervention this WO represents, if any (shared ticket)."""
    if not wo.ticket_id:
        return None
    r = await db.execute(
        select(MachineIntervention)
        .where(MachineIntervention.ticket_id == wo.ticket_id)
        .order_by(MachineIntervention.called_at.desc())
        .limit(1)
    )
    return r.scalar_one_or_none()


async def kiosk_parts_total(db: AsyncSession, wo: WorkOrder) -> float:
    """Money for the parts declared at the kiosk and APPROVED by a supervisor.
    Pending lines are not a commitment and rejected ones were refused, so neither
    counts — the same rule the Costs dashboards apply."""
    mi = await _intervention_for(db, wo)
    if not mi:
        return 0.0
    rows = (await db.execute(
        select(InterventionPart.total_cost).where(
            InterventionPart.intervention_id == mi.id,
            InterventionPart.approval_status == "approved",
            InterventionPart.total_cost.isnot(None),
        )
    )).all()
    return float(sum(r[0] for r in rows))


async def _intervention_minutes(db: AsyncSession, wo: WorkOrder) -> Optional[float]:
    """Duration measured by the kiosk for the intervention linked to this WO."""
    mi = await _intervention_for(db, wo)
    if not mi:
        return None
    if mi.intervention_duration_minutes:
        return float(mi.intervention_duration_minutes)
    started, ended = _aware(mi.started_at), _aware(mi.completed_at)
    if started and ended and ended > started:
        return (ended - started).total_seconds() / 60
    return None


async def recompute(
    db: AsyncSession,
    wo: WorkOrder,
    *,
    repair_hours: Optional[float] = None,
    keep_existing_time: bool = False,
    now: Optional[datetime] = None,
) -> None:
    """Stamp repair_hours / total_minutes / total_cost on ``wo`` from its
    ledgers. Does not commit. Safe to call repeatedly: every value is derived,
    never accumulated.

    ``keep_existing_time`` leaves an existing repair time alone — a number a human
    typed on the completion dialog or via PATCH outranks anything derived, and a
    side-effect call (a ticket closing, a part being approved) must never
    silently rewrite it. Only the office completion, which owns that field,
    calls this without the guard."""
    now = now or datetime.now(timezone.utc)

    labor = (await db.execute(
        select(LaborRecord).where(LaborRecord.work_order_id == wo.id)
    )).scalars().all()
    parts = (await db.execute(
        select(WOPart).where(WOPart.work_order_id == wo.id)
    )).scalars().all()
    costs = (await db.execute(
        select(WOCost).where(WOCost.work_order_id == wo.id)
    )).scalars().all()

    # ── Repair time ──────────────────────────────────────────────────────────
    minutes: Optional[float] = None
    if repair_hours:
        minutes = float(repair_hours) * 60
    elif keep_existing_time and wo.repair_hours:
        minutes = None                      # a value already stands — leave it
    else:
        union = _union_minutes(labor)
        if union > 0:
            minutes = union
        else:
            minutes = await _intervention_minutes(db, wo)
            if minutes is None:
                started, ended = _aware(wo.started_at), _aware(wo.completed_at or now)
                if started and ended and ended > started:
                    minutes = (ended - started).total_seconds() / 60

    if minutes and minutes > 0:
        wo.repair_hours = round(minutes / 60.0, 4)
        # total_minutes is an INTEGER column: round (never truncate, or a
        # sub-minute repair lands on 0 and the UI shows "no time recorded").
        wo.total_minutes = max(1, int(round(minutes)))

    # ── Cost ─────────────────────────────────────────────────────────────────
    total = (
        sum(r.labor_cost or 0.0 for r in labor)
        + sum(p.total_cost or 0.0 for p in parts)
        + await kiosk_parts_total(db, wo)
        + sum(c.amount or 0.0 for c in costs)
    )
    wo.total_cost = round(total, 2) or None


async def recompute_for_ticket(db: AsyncSession, ticket_id) -> Optional[WorkOrder]:
    """Roll up the WO linked to ``ticket_id`` (kiosk paths hold the ticket, not
    the WO). Returns the WO so callers can keep working with it."""
    if not ticket_id:
        return None
    r = await db.execute(
        select(WorkOrder)
        .where(WorkOrder.ticket_id == ticket_id)
        .order_by(WorkOrder.opened_at.desc())
        .limit(1)
    )
    wo = r.scalar_one_or_none()
    if wo and wo.status != WorkOrderStatus.cancelled:
        await recompute(db, wo, keep_existing_time=True)
    return wo
