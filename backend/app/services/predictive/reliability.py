"""Reliability signals from the unified failure_events read-model.

MTBF is ONE input of the score — never a standalone alarm trigger. The engine
combines `pct_consumed` with the sensor/operational factors, exactly as the
spec requires ("MTBF consumed AND vibration rising ⇒ risk up").
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import FailureEvent

_MIN_GAP_H = 1.0        # closer events are the same incident, not two failures
_HISTORY_DAYS = 365
_RECENT_DAYS = 90


def _gaps_hours(starts: list[datetime]) -> list[float]:
    gaps = []
    for a, b in zip(starts, starts[1:]):
        h = (b - a).total_seconds() / 3600.0
        if h >= _MIN_GAP_H:
            gaps.append(h)
    return gaps


async def mtbf_signals(
    db: AsyncSession, equipment_id, at: Optional[datetime] = None,
) -> Optional[dict]:
    """→ {hours_since_last, mtbf_hist_h, mtbf_recent_h, pct_consumed, trend,
        failures_365d} or None when there is not enough failure history."""
    at = at or datetime.now(timezone.utc)
    rows = (await db.execute(
        select(FailureEvent.started_at)
        .where(
            FailureEvent.equipment_id == equipment_id,
            FailureEvent.started_at <= at,
            FailureEvent.started_at > at - timedelta(days=_HISTORY_DAYS),
        )
        .order_by(FailureEvent.started_at)
    )).scalars().all()
    if not rows:
        return None
    starts = [t if t.tzinfo else t.replace(tzinfo=timezone.utc) for t in rows]
    hours_since_last = (at - starts[-1]).total_seconds() / 3600.0

    gaps = _gaps_hours(starts)
    if len(gaps) < 2:
        return {
            "hours_since_last": round(hours_since_last, 1),
            "mtbf_hist_h": None, "mtbf_recent_h": None,
            "pct_consumed": None, "trend": None,
            "failures_365d": len(starts),
        }
    mtbf_hist = sum(gaps) / len(gaps)
    recent_cut = at - timedelta(days=_RECENT_DAYS)
    recent_gaps = _gaps_hours([t for t in starts if t > recent_cut])
    mtbf_recent = sum(recent_gaps) / len(recent_gaps) if len(recent_gaps) >= 2 else None
    return {
        "hours_since_last": round(hours_since_last, 1),
        "mtbf_hist_h": round(mtbf_hist, 1),
        "mtbf_recent_h": round(mtbf_recent, 1) if mtbf_recent else None,
        "pct_consumed": round(hours_since_last / mtbf_hist * 100.0, 1) if mtbf_hist > 0 else None,
        "trend": round(mtbf_recent / mtbf_hist, 2) if mtbf_recent and mtbf_hist > 0 else None,
        "failures_365d": len(starts),
    }
