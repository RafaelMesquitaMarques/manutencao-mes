"""OF watch ("spot") — follow a specific OF on the factory map and alert when it
stops moving.

"Movement" for an OF is any of:
  • a run event — the OF scanned at a machine (run opened) or leaving one (run
    closed), plus pieces attributed to its open run (`last_piece_at`), so a line
    producing the same OF for an hour never looks stalled;
  • a Pit Stop ledger movement (component in/out of the buffer).

Location resolution (whole-map search + the watch tag position):
  1. open run (ended_at IS NULL)   → ON a machine right now
  2. Pit Stop on-hand > 0          → in the buffer (lane/slot of the latest
                                     parseable inbound position)
  3. JobOrder.machine_id           → PARKED at its last machine (worked there,
                                     not yet scanned at the next step)
  4. otherwise                     → unknown

Inactivity episodes: one alert per stall. `alerted_movement_at` stores the
movement basis the alert fired on; any new movement changes the basis, which
re-arms the watch. The clock is floored at the watch's creation so spotting an
already-idle OF doesn't fire instantly.

No commit here except in `check_inactivity` (its own session/loop); API callers
commit themselves.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    JobOrder, JobOrderRun, JobOrderStatus, JobOrderWatch, Machine,
    PitStopDirection, PitStopMovement, User,
)
from app.services.pit_stop_service import parse_position

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(ts: Optional[datetime]) -> Optional[datetime]:
    if ts is None:
        return None
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=timezone.utc)


async def last_movement_map(db: AsyncSession, job_order_ids: list[UUID]) -> dict[UUID, Optional[datetime]]:
    """{job_order_id: latest movement timestamp (or None)} for the given OFs."""
    out: dict[UUID, Optional[datetime]] = {jid: None for jid in job_order_ids}
    if not job_order_ids:
        return out
    # Run events: started_at / ended_at / last_piece_at, whichever is latest.
    runs = (await db.execute(
        select(
            JobOrderRun.job_order_id,
            func.max(func.greatest(
                JobOrderRun.started_at,
                func.coalesce(JobOrderRun.ended_at, JobOrderRun.started_at),
                func.coalesce(JobOrderRun.last_piece_at, JobOrderRun.started_at),
            )),
        )
        .where(JobOrderRun.job_order_id.in_(job_order_ids))
        .group_by(JobOrderRun.job_order_id)
    )).all()
    for jid, ts in runs:
        out[jid] = _aware(ts)
    # Pit Stop ledger movements.
    moves = (await db.execute(
        select(PitStopMovement.job_order_id, func.max(PitStopMovement.occurred_at))
        .where(PitStopMovement.job_order_id.in_(job_order_ids))
        .group_by(PitStopMovement.job_order_id)
    )).all()
    for jid, ts in moves:
        ts = _aware(ts)
        if ts and (out.get(jid) is None or ts > out[jid]):  # type: ignore[operator]
            out[jid] = ts
    return out


async def locate_map(db: AsyncSession, job_order_ids: list[UUID]) -> dict[UUID, dict]:
    """{job_order_id: location dict} — see module docstring for the resolution
    order. Location dict: {kind: 'machine'|'pit_stop'|'unknown', machine_id,
    machine_name, parked, lane, slot, position_code}."""
    out: dict[UUID, dict] = {
        jid: {"kind": "unknown", "machine_id": None, "machine_name": None,
              "parked": False, "planned": False, "lane": None, "slot": None, "position_code": None}
        for jid in job_order_ids
    }
    if not job_order_ids:
        return out

    # 1. Open runs — the OF is ON a machine right now.
    open_runs = (await db.execute(
        select(JobOrderRun.job_order_id, Machine.id, Machine.name)
        .join(Machine, Machine.id == JobOrderRun.machine_id)
        .where(JobOrderRun.job_order_id.in_(job_order_ids), JobOrderRun.ended_at.is_(None))
    )).all()
    for jid, mid, mname in open_runs:
        out[jid].update(kind="machine", machine_id=str(mid), machine_name=mname, parked=False)

    remaining = [jid for jid in job_order_ids if out[jid]["kind"] == "unknown"]
    if remaining:
        # 1b. Loaded by NUMBER: a kiosk shows the OF as its current job even when
        # no run exists yet (e.g. externally-fed demo/SAP data stamps the machine
        # field only) — the map chip is the ground truth the user is following.
        rows = (await db.execute(
            select(JobOrder.id, Machine.id, Machine.name)
            .select_from(JobOrder)
            .join(Machine, and_(
                Machine.current_job_number == JobOrder.job_number,
                Machine.plant_id == JobOrder.plant_id,
            ))
            .where(JobOrder.id.in_(remaining))
        )).all()
        for jid, mid, mname in rows:
            out[jid].update(kind="machine", machine_id=str(mid), machine_name=mname, parked=False)

    remaining = [jid for jid in job_order_ids if out[jid]["kind"] == "unknown"]
    if remaining:
        # 2. Pit Stop presence: on-hand = Σ in − Σ out.
        on_hand = (await db.execute(
            select(
                PitStopMovement.job_order_id,
                func.sum(case(
                    (PitStopMovement.direction == PitStopDirection.inbound, PitStopMovement.quantity),
                    else_=-PitStopMovement.quantity,
                )),
            )
            .where(PitStopMovement.job_order_id.in_(remaining))
            .group_by(PitStopMovement.job_order_id)
        )).all()
        in_buffer = [jid for jid, qty in on_hand if (qty or 0) > 0]
        if in_buffer:
            # Latest inbound positions (most recent first) — first parseable wins.
            rows = (await db.execute(
                select(PitStopMovement.job_order_id, PitStopMovement.position_code)
                .where(
                    PitStopMovement.job_order_id.in_(in_buffer),
                    PitStopMovement.direction == PitStopDirection.inbound,
                    PitStopMovement.position_code.isnot(None),
                )
                .order_by(PitStopMovement.occurred_at.desc())
            )).all()
            for jid in in_buffer:
                out[jid].update(kind="pit_stop")
            for jid, code in rows:
                loc = out[jid]
                if loc["position_code"] is None:
                    lane, slot = parse_position(code)
                    if lane is not None:
                        loc.update(lane=lane, slot=slot, position_code=code)

    remaining = [jid for jid in job_order_ids if out[jid]["kind"] == "unknown"]
    if remaining:
        # 3. At its last/assigned machine: a pending OF is PLANNED there (queued
        # behind the machine by production planning); a started one is PARKED at
        # its output (worked there, not yet scanned at the next step).
        rows = (await db.execute(
            select(JobOrder.id, JobOrder.status, Machine.id, Machine.name)
            .join(Machine, Machine.id == JobOrder.machine_id)
            .where(JobOrder.id.in_(remaining))
        )).all()
        for jid, jstatus, mid, mname in rows:
            planned = jstatus == JobOrderStatus.pending
            out[jid].update(kind="machine", machine_id=str(mid), machine_name=mname,
                            parked=not planned, planned=planned)

    return out


def _inactivity_basis(watch: JobOrderWatch, last_move: Optional[datetime]) -> datetime:
    """The timestamp stillness is measured from: last movement, floored at the
    watch's creation (spotting an already-idle OF starts a fresh clock)."""
    created = _aware(watch.created_at) or _now()
    if last_move is None or last_move < created:
        return created
    return last_move


def episode_due(watch: JobOrderWatch, basis: datetime, now: Optional[datetime] = None) -> bool:
    """Should this watch alert NOW? True once per stall episode: stillness past
    the threshold AND not already alerted on this same movement basis (any new
    movement changes the basis, which re-arms the watch)."""
    now = now or _now()
    inactive_min = (now - basis).total_seconds() / 60
    if inactive_min < (watch.threshold_minutes or 30):
        return False
    if watch.alerted_movement_at is not None and _aware(watch.alerted_movement_at) == basis:
        return False
    return True


def _watch_payload(
    watch: JobOrderWatch, jo: JobOrder,
    last_move: Optional[datetime], location: dict,
    creator_name: Optional[str],
) -> dict:
    basis = _inactivity_basis(watch, last_move)
    inactive_min = max(0, int((_now() - basis).total_seconds() // 60))
    done = jo.status in (JobOrderStatus.completed, JobOrderStatus.cancelled)
    return {
        "id": str(watch.id),
        "job_order_id": str(jo.id),
        "job_number": jo.job_number,
        "product_name": jo.product_name,
        "of_status": jo.status.value if jo.status else None,
        "threshold_minutes": watch.threshold_minutes,
        "created_by_name": creator_name,
        "created_at": watch.created_at.isoformat() if watch.created_at else None,
        "last_movement_at": last_move.isoformat() if last_move else None,
        "inactive_minutes": None if done else inactive_min,
        "alerting": (not done) and inactive_min >= (watch.threshold_minutes or 30),
        "location": location,
    }


async def watch_status(db: AsyncSession, plant_id: UUID) -> list[dict]:
    """All watches of a plant with live location + inactivity — the map poll."""
    rows = (await db.execute(
        select(JobOrderWatch, JobOrder, User.name)
        .join(JobOrder, JobOrder.id == JobOrderWatch.job_order_id)
        .outerjoin(User, User.id == JobOrderWatch.created_by_id)
        .where(JobOrderWatch.plant_id == plant_id)
        .order_by(JobOrderWatch.created_at)
    )).all()
    ids = [jo.id for _, jo, _ in rows]
    moves = await last_movement_map(db, ids)
    locs = await locate_map(db, ids)
    return [
        _watch_payload(w, jo, moves.get(jo.id), locs[jo.id], name)
        for w, jo, name in rows
    ]


async def locate_of(db: AsyncSession, plant_id: UUID, query: str) -> Optional[dict]:
    """Whole-map OF search: find the OF by number within the plant (exact match
    first, then contains) and resolve where it physically is right now."""
    q = (query or "").strip()
    if not q:
        return None
    jo = (await db.execute(
        select(JobOrder).where(
            JobOrder.plant_id == plant_id,
            func.lower(JobOrder.job_number) == q.lower(),
        )
    )).scalars().first()
    if jo is None:
        jo = (await db.execute(
            select(JobOrder)
            .where(JobOrder.plant_id == plant_id, JobOrder.job_number.ilike(f"%{q}%"))
            .order_by(JobOrder.created_at.desc())
            .limit(1)
        )).scalars().first()
    if jo is None:
        return None
    locs = await locate_map(db, [jo.id])
    moves = await last_movement_map(db, [jo.id])
    watch = (await db.execute(
        select(JobOrderWatch).where(JobOrderWatch.job_order_id == jo.id)
    )).scalar_one_or_none()
    last = moves.get(jo.id)
    return {
        "job_order_id": str(jo.id),
        "job_number": jo.job_number,
        "product_name": jo.product_name,
        "of_status": jo.status.value if jo.status else None,
        "scheduled_date": jo.scheduled_date.isoformat() if jo.scheduled_date else None,
        "location": locs[jo.id],
        "last_movement_at": last.isoformat() if last else None,
        "watched": watch is not None,
        "watch_id": str(watch.id) if watch else None,
    }


async def check_inactivity(db: AsyncSession) -> int:
    """One pass of the background loop: fire ONE alert per stalled episode for
    every active watch, all plants. Commits. Returns how many alerts went out."""
    rows = (await db.execute(
        select(JobOrderWatch, JobOrder)
        .join(JobOrder, JobOrder.id == JobOrderWatch.job_order_id)
        .where(JobOrder.status.in_([JobOrderStatus.pending, JobOrderStatus.in_progress]))
    )).all()
    if not rows:
        return 0
    ids = [jo.id for _, jo in rows]
    moves = await last_movement_map(db, ids)
    sent = 0
    need_locations: list[UUID] = []
    due: list[tuple[JobOrderWatch, JobOrder, datetime]] = []
    for watch, jo in rows:
        basis = _inactivity_basis(watch, moves.get(jo.id))
        if not episode_due(watch, basis):
            continue
        due.append((watch, jo, basis))
        need_locations.append(jo.id)
    if not due:
        return 0
    locs = await locate_map(db, need_locations)
    from app.services.notification_service import NotificationService
    svc = NotificationService(db)
    for watch, jo, basis in due:
        creator = await db.get(User, watch.created_by_id) if watch.created_by_id else None
        minutes = max(0, int((_now() - basis).total_seconds() // 60))
        try:
            await svc.notify_of_watch_inactive(
                job_order=jo, watch=watch, minutes=minutes,
                location=locs[jo.id], creator=creator,
            )
            watch.alerted_at = _now()
            watch.alerted_movement_at = basis
            sent += 1
        except Exception:  # noqa: BLE001 — one bad send never blocks the rest
            logger.exception("[OFWatch] notify failed for %s", jo.job_number)
    await db.commit()
    return sent
