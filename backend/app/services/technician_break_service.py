"""Announced (real-time) technician breaks — presence ground truth.

A technician taps "I'm on break" in My Work; we open a :class:`TechnicianBreak`
row, and "I'm back" closes it. Unlike ``shift_breaks`` (scheduled, drive labor
cost / effective time), these say what is ACTUALLY happening right now, so the
scheduler/roster can tell a real break apart from one that was postponed to
finish a job.

Presence ONLY — this never touches labor cost, effective time, machine downtime,
or MTTR. Those are owned by :mod:`labor_time_service` and the stop/intervention
pipeline and must stay untouched here.

Services mutate + ``flush`` only; the caller (route) owns the transaction commit,
so these are safe to exercise inside a rolled-back test transaction.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import ShiftBreakKind, TechnicianBreak

# An announced break left open longer than this is assumed abandoned (the
# technician forgot to clock back in) and no longer counts as "on break". Keeps a
# forgotten tap from pinning someone "on break" forever on the roster.
MAX_ANNOUNCED_BREAK = timedelta(hours=4)


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


async def _open_breaks(db: AsyncSession, technician_id: UUID) -> list[TechnicianBreak]:
    """All currently-open (not-yet-ended) break rows for a technician, newest
    first. Normally at most one; more only if a write raced."""
    return list((await db.execute(
        select(TechnicianBreak)
        .where(
            TechnicianBreak.technician_id == technician_id,
            TechnicianBreak.ended_at.is_(None),
        )
        .order_by(TechnicianBreak.started_at.desc())
    )).scalars().all())


async def active_break(
    db: AsyncSession, technician_id: UUID, at: Optional[datetime] = None,
) -> Optional[TechnicianBreak]:
    """The technician's live announced break at instant ``at`` (default now), or
    ``None``. An open row older than :data:`MAX_ANNOUNCED_BREAK` is considered
    abandoned and reported as no break (without mutating it here)."""
    now = _as_utc(at) if at else datetime.now(timezone.utc)
    rows = await _open_breaks(db, technician_id)
    if not rows:
        return None
    latest = rows[0]
    if _as_utc(latest.started_at) < now - MAX_ANNOUNCED_BREAK:
        return None
    return latest


async def start_break(
    db: AsyncSession, technician_id: UUID,
    kind: ShiftBreakKind = ShiftBreakKind.short_break,
) -> TechnicianBreak:
    """Open a break for the technician. Idempotent: an already-open fresh break is
    returned as-is (a double tap is harmless). Any stale/abandoned open rows are
    closed first so we never leave dangling breaks. Flushes; caller commits."""
    existing = await active_break(db, technician_id)
    if existing is not None:
        return existing

    now = datetime.now(timezone.utc)
    for stale in await _open_breaks(db, technician_id):
        stale.ended_at = now  # abandoned (past the abandon window) → close it

    rec = TechnicianBreak(technician_id=technician_id, kind=kind, started_at=now)
    db.add(rec)
    await db.flush()
    return rec


async def end_break(db: AsyncSession, technician_id: UUID) -> Optional[TechnicianBreak]:
    """Close the technician's open break(s). Returns the row that was ended (the
    latest), or ``None`` if none was open. Flushes; caller commits."""
    rows = await _open_breaks(db, technician_id)
    if not rows:
        return None
    now = datetime.now(timezone.utc)
    for r in rows:
        r.ended_at = now
    await db.flush()
    return rows[0]
