"""Sensor data-quality validation.

A sensor problem must never read as a machine problem: findings here mark a
sensor `faulty` (excluded from scoring) or `degraded` (its factors are
discounted), and the combined quality score feeds alert confidence and the
suppression floor.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Sensor, SensorReading

from .features import Bucket

# Permissive physical plausibility ranges by sensor-type keyword. A reading
# outside these is a sensor/ingest defect, not physics.
_PHYSICAL_RANGES: list[tuple[tuple[str, ...], float, float]] = [
    (("vibration", "velocity", "vel"), -0.01, 500.0),      # mm/s RMS
    (("acceleration", "acc"), -0.01, 2000.0),              # m/s²
    (("temperature", "temp"), -60.0, 500.0),               # °C
    (("pressure", "press"), -1.0, 100.0),                  # MPa
    (("current",), -1.0, 5000.0),                          # A
]

FROZEN_MIN_REPEATS = 6
FROZEN_MIN_SPAN_H = 2.0
STALE_FLOOR_MIN = 180.0
GAP_MIN_FRACTION = 0.3
BAD_QUALITY_FRACTION = 0.3

_STATUS_SCORE = {"ok": 1.0, "degraded": 0.6, "faulty": 0.15}


def _physical_range(sensor: Sensor) -> Optional[tuple[float, float]]:
    hint = f"{sensor.type or ''} {sensor.code or ''}".lower()
    for keys, lo, hi in _PHYSICAL_RANGES:
        if any(k in hint for k in keys):
            return lo, hi
    return None


async def _recent_raw(db: AsyncSession, sensor_id, until: datetime, limit: int = 8):
    return (await db.execute(
        select(SensorReading.value, SensorReading.timestamp)
        .where(SensorReading.sensor_id == sensor_id, SensorReading.timestamp <= until)
        .order_by(SensorReading.timestamp.desc())
        .limit(limit)
    )).all()


def _frozen(rows) -> bool:
    """Identical consecutive values across a meaningful span ⇒ stuck sensor."""
    if len(rows) < FROZEN_MIN_REPEATS:
        return False
    head = rows[:FROZEN_MIN_REPEATS]
    if len({r.value for r in head}) != 1:
        return False
    span_h = (head[0].timestamp - head[-1].timestamp).total_seconds() / 3600.0
    return span_h >= FROZEN_MIN_SPAN_H


async def sensor_quality(
    db: AsyncSession,
    sensor: Sensor,
    buckets: Sequence[Bucket],
    until: datetime,
    *,
    update_period_min: Optional[int] = None,
    window_hours: float = 24.0,
) -> dict:
    """→ {"status": ok|degraded|faulty|no_data, "issues": [codes], "last_at": iso|None}"""
    issues: list[str] = []
    rows = await _recent_raw(db, sensor.id, until)
    if not rows:
        return {"status": "no_data", "issues": ["no_readings"], "last_at": None}

    last = rows[0]
    last_ts = last.timestamp if last.timestamp.tzinfo else last.timestamp.replace(tzinfo=timezone.utc)
    period = max(float(update_period_min or 60), 1.0)
    silent_min = (until - last_ts).total_seconds() / 60.0
    if silent_min > max(STALE_FLOOR_MIN, period * 2.5):
        issues.append("stale")

    if _frozen(rows):
        issues.append("frozen")

    rng = _physical_range(sensor)
    if rng and not (rng[0] <= last.value <= rng[1]):
        issues.append("impossible_value")

    total = sum(b.n for b in buckets)
    bad = sum(b.bad for b in buckets)
    if total and bad / total > BAD_QUALITY_FRACTION:
        issues.append("bad_quality_flags")

    # Gap check only when not already stale (stale implies missing data) and the
    # sensor's own cadence could plausibly fill the window.
    if "stale" not in issues and period > 0:
        expected = window_hours * 60.0 / period
        if expected >= 4 and total < expected * GAP_MIN_FRACTION:
            issues.append("irregular_gaps")

    # Isolated spike: last value far outside the window's own dispersion.
    avgs = [b.avg for b in buckets if b.avg is not None]
    if len(avgs) >= 8:
        mean = sum(avgs) / len(avgs)
        std = (sum((v - mean) ** 2 for v in avgs) / len(avgs)) ** 0.5
        if std > 0 and abs(last.value - mean) > 6 * std:
            issues.append("spike_suspect")

    if {"stale", "frozen", "impossible_value"} & set(issues):
        status = "faulty"
    elif issues:
        status = "degraded"
    else:
        status = "ok"
    return {"status": status, "issues": issues, "last_at": last_ts.isoformat()}


def combined_quality_score(findings: dict[str, dict]) -> float:
    """0..1 across sensors; sensors with no data at all count as 0.3 (unknown,
    not proof of a problem)."""
    if not findings:
        return 0.0
    scores = [
        _STATUS_SCORE.get(f.get("status", "ok"), 0.3) if f.get("status") != "no_data" else 0.3
        for f in findings.values()
    ]
    return sum(scores) / len(scores)
