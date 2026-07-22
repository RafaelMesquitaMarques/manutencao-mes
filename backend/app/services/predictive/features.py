"""Window feature extraction over sensor_readings + operational tables.

One SQL fetch per sensor returns bucketed points for the LONGEST window; every
sub-window feature (avg/max/std/slope/…) is derived in Python from those
buckets — no per-feature queries, no full-history scans (incremental by
design: the engine only ever reads the trailing analysis window).

Plain-PostgreSQL bucketing (epoch floor) is used instead of time_bucket() so
the module also works on a non-TimescaleDB database (mirrors the non-fatal
_ensure_timescale philosophy).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import MachineProductionHourly, MachineStop

BUCKET_MINUTES = 15
MICROSTOP_MAX_MIN = 10          # a stop shorter than this counts as a microstop
_EPS = 1e-9

_SERIES_SQL = text("""
    SELECT to_timestamp(floor(extract(epoch FROM "timestamp") / :bucket_s) * :bucket_s) AS bucket,
           avg(value)  FILTER (WHERE quality = 'ok') AS avg_ok,
           max(value)  FILTER (WHERE quality = 'ok') AS max_ok,
           min(value)  FILTER (WHERE quality = 'ok') AS min_ok,
           count(*)                                   AS n,
           count(*)    FILTER (WHERE quality <> 'ok') AS bad
    FROM sensor_readings
    WHERE sensor_id = :sensor_id AND "timestamp" > :since AND "timestamp" <= :until
    GROUP BY 1 ORDER BY 1
""")


@dataclass
class Bucket:
    t: datetime
    avg: Optional[float]
    max: Optional[float]
    min: Optional[float]
    n: int
    bad: int


async def fetch_bucket_series(
    db: AsyncSession, sensor_id, since: datetime, until: datetime,
    bucket_minutes: int = BUCKET_MINUTES,
) -> list[Bucket]:
    rows = (await db.execute(_SERIES_SQL, {
        "bucket_s": bucket_minutes * 60,
        "sensor_id": sensor_id,
        "since": since,
        "until": until,
    })).all()
    out = []
    for r in rows:
        t = r.bucket if r.bucket.tzinfo else r.bucket.replace(tzinfo=timezone.utc)
        out.append(Bucket(
            t=t,
            avg=float(r.avg_ok) if r.avg_ok is not None else None,
            max=float(r.max_ok) if r.max_ok is not None else None,
            min=float(r.min_ok) if r.min_ok is not None else None,
            n=int(r.n), bad=int(r.bad),
        ))
    return out


def slope_per_hour(points: Sequence[tuple[float, float]]) -> float:
    """Least-squares slope of (hours, value) pairs; 0.0 with <3 points."""
    if len(points) < 3:
        return 0.0
    n = len(points)
    sx = sum(p[0] for p in points)
    sy = sum(p[1] for p in points)
    sxx = sum(p[0] * p[0] for p in points)
    sxy = sum(p[0] * p[1] for p in points)
    denom = n * sxx - sx * sx
    if abs(denom) < _EPS:
        return 0.0
    return (n * sxy - sx * sy) / denom


def window_features(buckets: Sequence[Bucket], since: datetime, until: datetime) -> Optional[dict]:
    """Aggregate the buckets that fall inside [since, until]. None = no usable data."""
    sel = [b for b in buckets if since < b.t <= until and b.avg is not None]
    if not sel:
        return None
    avgs = [b.avg for b in sel]
    n_readings = sum(b.n for b in sel)
    mean = sum(avgs) / len(avgs)
    var = sum((v - mean) ** 2 for v in avgs) / len(avgs) if len(avgs) > 1 else 0.0
    t0 = sel[0].t
    pts = [((b.t - t0).total_seconds() / 3600.0, b.avg) for b in sel]
    return {
        "n": n_readings,
        "buckets": len(sel),
        "avg": mean,
        "max": max(b.max if b.max is not None else b.avg for b in sel),
        "min": min(b.min if b.min is not None else b.avg for b in sel),
        "std": var ** 0.5,
        "last": sel[-1].avg,
        "slope_per_hour": slope_per_hour(pts),
        "bad": sum(b.bad for b in sel),
    }


# ─── Operational metrics (machine side) ────────────────────────────────────────

def _clamped_stop_minutes(started, ended, since, until) -> float:
    a = max(started, since)
    b = min(ended or until, until)
    return max(0.0, (b - a).total_seconds() / 60.0)


async def stop_stats(
    db: AsyncSession, machine_id, since: datetime, until: datetime,
    micro_max_min: int = MICROSTOP_MAX_MIN,
) -> dict:
    """Microstop count + total stop minutes inside the window (ongoing stops
    clamped to the window edge)."""
    rows = (await db.execute(
        select(MachineStop.started_at, MachineStop.ended_at, MachineStop.duration_minutes)
        .where(
            MachineStop.machine_id == machine_id,
            MachineStop.started_at <= until,
            (MachineStop.ended_at.is_(None)) | (MachineStop.ended_at > since),
        )
    )).all()
    micro = 0
    minutes = 0.0
    for r in rows:
        if r.started_at is None:
            continue
        dur = r.duration_minutes
        if dur is None and r.ended_at is not None:
            dur = (r.ended_at - r.started_at).total_seconds() / 60.0
        if dur is not None and dur <= micro_max_min and r.started_at > since:
            micro += 1
        minutes += _clamped_stop_minutes(r.started_at, r.ended_at, since, until)
    return {"microstops": micro, "stop_minutes": round(minutes, 1), "stops": len(rows)}


async def production_rate(
    db: AsyncSession, machine_id, since: datetime, until: datetime,
) -> Optional[dict]:
    """Average parts/hour over hours that actually produced. None = no data."""
    rows = (await db.execute(
        select(MachineProductionHourly.hour, MachineProductionHourly.count)
        .where(
            MachineProductionHourly.machine_id == machine_id,
            MachineProductionHourly.hour > since,
            MachineProductionHourly.hour <= until,
        )
    )).all()
    producing = [int(r.count or 0) for r in rows if (r.count or 0) > 0]
    if not producing:
        return None
    return {"rate": sum(producing) / len(producing), "run_hours": len(producing), "hours": len(rows)}


async def run_hour_set(
    db: AsyncSession, machine_id, since: datetime, until: datetime,
) -> Optional[set[datetime]]:
    """UTC hours with production > 0. None = machine has NO production feed in
    the window at all (context split impossible → callers fall back to 'all')."""
    rows = (await db.execute(
        select(MachineProductionHourly.hour, MachineProductionHourly.count)
        .where(
            MachineProductionHourly.machine_id == machine_id,
            MachineProductionHourly.hour > since,
            MachineProductionHourly.hour <= until,
        )
    )).all()
    if not rows:
        return None
    return {
        r.hour.replace(minute=0, second=0, microsecond=0, tzinfo=r.hour.tzinfo or timezone.utc)
        for r in rows if (r.count or 0) > 0
    }


async def current_context(
    db: AsyncSession, machine, at: datetime,
) -> str:
    """Operating context of the moment being evaluated: run | idle | all.
    'all' when no context signal exists (no production feed and no status)."""
    if machine is None:
        return "all"
    hours = await run_hour_set(db, machine.id, at - timedelta(hours=3), at)
    if hours is not None:
        return "run" if hours else "idle"
    status = getattr(machine, "current_status", None)
    status = status.value if hasattr(status, "value") else status
    if status in ("running",):
        return "run"
    if status in ("stopped", "waiting"):
        return "idle"
    return "all"
