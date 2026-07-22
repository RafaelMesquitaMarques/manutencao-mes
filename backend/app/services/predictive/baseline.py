"""Per-machine, per-context operating baselines.

Robust statistics (median/MAD + mean/σ, p05/p95) per equipment × metric ×
operating context, computed over a trailing window with controlled learning:

  * pre-failure horizons and maintenance interventions are EXCLUDED, so the
    baseline never learns degradation as normal;
  * a drift guard freezes the stored baseline (instead of absorbing the shift)
    when the new statistics move beyond the configured cap while the machine's
    recent health is degraded — a supervisor unfreezes by re-running after the
    fix, or the guard clears itself once health recovers.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    Equipment,
    FailureEvent,
    Machine,
    MachineBaseline,
    MachineIntervention,
    PredictiveHealthSnapshot,
    Sensor,
)

from .config import EffectiveConfig
from .features import fetch_bucket_series, run_hour_set

_EPS = 1e-9

# Synthetic (non-sensor) metrics that also get baselines.
METRIC_MICROSTOPS = "microstops_per_day"
METRIC_STOP_MINUTES = "stop_minutes_per_day"
METRIC_PRODUCTION = "production_per_hour"

_DAILY_STOPS_SQL = text("""
    SELECT date_trunc('day', started_at) AS day,
           count(*) FILTER (WHERE duration_minutes IS NOT NULL AND duration_minutes <= :micro_max) AS micro,
           coalesce(sum(duration_minutes), 0) AS minutes
    FROM machine_stops
    WHERE machine_id = :machine_id AND started_at > :since AND started_at <= :until
    GROUP BY 1 ORDER BY 1
""")


def robust_stats(values: list[float]) -> dict:
    """mean/std/median/MAD/p05/p95/min/max of a value list (n>=1)."""
    vs = sorted(values)
    n = len(vs)

    def pct(p: float) -> float:
        if n == 1:
            return vs[0]
        idx = p * (n - 1)
        lo = int(idx)
        hi = min(lo + 1, n - 1)
        frac = idx - lo
        return vs[lo] * (1 - frac) + vs[hi] * frac

    mean = sum(vs) / n
    std = (sum((v - mean) ** 2 for v in vs) / n) ** 0.5 if n > 1 else 0.0
    median = pct(0.5)
    mad = sorted(abs(v - median) for v in vs)[n // 2] if n > 1 else 0.0
    return {
        "n": n, "mean": mean, "std": std, "median": median, "mad": mad,
        "p05": pct(0.05), "p95": pct(0.95), "min": vs[0], "max": vs[-1],
    }


def robust_sigma(base: dict | MachineBaseline) -> float:
    """Comparable σ: 1.4826·MAD when available, else std, floored to a tiny
    fraction of the median so z-scores stay finite on ultra-stable signals."""
    get = (lambda k: base.get(k)) if isinstance(base, dict) else (lambda k: getattr(base, {
        "mad": "mad", "std": "std", "median": "median"}[k], None))
    mad = get("mad") or 0.0
    std = get("std") or 0.0
    median = abs(get("median") or 0.0)
    sigma = 1.4826 * mad if mad > _EPS else std
    return max(sigma, 0.02 * median, _EPS)


async def _excluded_intervals(
    db: AsyncSession, equipment: Equipment, machine: Optional[Machine],
    since: datetime, until: datetime, prefailure_h: int,
) -> list[tuple[datetime, datetime]]:
    out: list[tuple[datetime, datetime]] = []
    events = (await db.execute(
        select(FailureEvent.started_at, FailureEvent.ended_at).where(
            FailureEvent.equipment_id == equipment.id,
            FailureEvent.started_at > since - timedelta(hours=prefailure_h),
            FailureEvent.started_at <= until,
        )
    )).all()
    for e in events:
        out.append((
            e.started_at - timedelta(hours=prefailure_h),
            (e.ended_at or e.started_at) + timedelta(hours=2),
        ))
    if machine is not None:
        ivs = (await db.execute(
            select(MachineIntervention.started_at, MachineIntervention.completed_at).where(
                MachineIntervention.machine_id == machine.id,
                MachineIntervention.started_at.isnot(None),
                MachineIntervention.started_at <= until,
                (MachineIntervention.completed_at.is_(None))
                | (MachineIntervention.completed_at > since),
            )
        )).all()
        for iv in ivs:
            out.append((iv.started_at, iv.completed_at or (iv.started_at + timedelta(hours=4))))
    return out


def _excluded(t: datetime, intervals: list[tuple[datetime, datetime]]) -> bool:
    return any(a <= t <= b for a, b in intervals)


async def _recent_health_level(db: AsyncSession, equipment_id) -> Optional[str]:
    row = (await db.execute(
        select(PredictiveHealthSnapshot.level)
        .where(PredictiveHealthSnapshot.equipment_id == equipment_id)
        .order_by(PredictiveHealthSnapshot.ts.desc())
        .limit(1)
    )).scalar_one_or_none()
    return row


async def build_baselines_for_equipment(
    db: AsyncSession,
    equipment: Equipment,
    cfg: EffectiveConfig,
    *,
    until: Optional[datetime] = None,
    persist: bool = True,
) -> dict[tuple[str, str], dict]:
    """Compute (and optionally persist) all baselines of one equipment.
    Returns {(metric_key, context_key): stats dict} for in-memory use
    (engine evaluation, backtests)."""
    until = until or datetime.now(timezone.utc)
    since = until - timedelta(days=cfg.baseline_window_days)
    machine = (await db.execute(
        select(Machine).where(Machine.equipment_id == equipment.id).limit(1)
    )).scalar_one_or_none()
    excluded = await _excluded_intervals(db, equipment, machine, since, until, cfg.prefailure_exclude_h)

    run_hours = await run_hour_set(db, machine.id, since, until) if machine else None
    computed: dict[tuple[str, str], dict] = {}

    # ── Sensor metrics (hourly bucket averages) ───────────────────────────────
    sensors = (await db.execute(
        select(Sensor).where(Sensor.equipment_id == equipment.id, Sensor.active.is_(True))
    )).scalars().all()
    for sensor in sensors:
        buckets = await fetch_bucket_series(db, sensor.id, since, until, bucket_minutes=60)
        usable = [b for b in buckets if b.avg is not None and not _excluded(b.t, excluded)]
        if not usable:
            continue
        by_ctx: dict[str, list[float]] = {"all": [b.avg for b in usable]}
        if run_hours is not None:
            hour_of = lambda t: t.replace(minute=0, second=0, microsecond=0)  # noqa: E731
            by_ctx["run"] = [b.avg for b in usable if hour_of(b.t) in run_hours]
            by_ctx["idle"] = [b.avg for b in usable if hour_of(b.t) not in run_hours]
        for ctx, values in by_ctx.items():
            if not values:
                continue
            stats = robust_stats(values)
            stats["unit"] = sensor.unit
            computed[(sensor.code, ctx)] = stats

    # ── Synthetic operational metrics ─────────────────────────────────────────
    if machine is not None:
        rows = (await db.execute(_DAILY_STOPS_SQL, {
            "machine_id": machine.id, "since": since, "until": until, "micro_max": 10,
        })).all()
        days = [r for r in rows if not _excluded(
            r.day.replace(tzinfo=r.day.tzinfo or timezone.utc), excluded)]
        if days:
            computed[(METRIC_MICROSTOPS, "all")] = {**robust_stats([float(r.micro) for r in days]), "unit": "stops/day"}
            computed[(METRIC_STOP_MINUTES, "all")] = {**robust_stats([float(r.minutes) for r in days]), "unit": "min/day"}
        prod = (await db.execute(text("""
            SELECT count FROM machine_production_hourly
            WHERE machine_id = :mid AND hour > :since AND hour <= :until AND count > 0
        """), {"mid": machine.id, "since": since, "until": until})).scalars().all()
        if prod:
            computed[(METRIC_PRODUCTION, "run")] = {**robust_stats([float(v) for v in prod]), "unit": "pcs/h"}

    if persist:
        await _persist(db, equipment, cfg, computed, until)
    return computed


async def _persist(
    db: AsyncSession, equipment: Equipment, cfg: EffectiveConfig,
    computed: dict[tuple[str, str], dict], until: datetime,
) -> None:
    existing = {
        (b.metric_key, b.context_key): b
        for b in (await db.execute(
            select(MachineBaseline).where(MachineBaseline.equipment_id == equipment.id)
        )).scalars().all()
    }
    recent_level = await _recent_health_level(db, equipment.id)
    degraded_now = recent_level in ("alert", "critical")

    for (metric, ctx), stats in computed.items():
        valid = stats["n"] >= cfg.baseline_min_samples
        row = existing.get((metric, ctx))
        if row is None:
            row = MachineBaseline(
                equipment_id=equipment.id, plant_id=equipment.plant_id,
                metric_key=metric, context_key=ctx,
            )
            db.add(row)
        elif row.valid and row.median is not None and degraded_now:
            # Drift guard: while health is degraded, a big statistical shift is
            # more likely the degradation itself than a new normal → freeze.
            ref = max(abs(row.median), _EPS)
            if abs(stats["median"] - row.median) / ref * 100.0 > cfg.baseline_drift_cap_pct:
                row.frozen = True
                continue
        row.frozen = False
        row.unit = stats.get("unit")
        row.n_samples = stats["n"]
        row.mean = stats["mean"]
        row.std = stats["std"]
        row.median = stats["median"]
        row.mad = stats["mad"]
        row.p05 = stats["p05"]
        row.p95 = stats["p95"]
        row.min_value = stats["min"]
        row.max_value = stats["max"]
        row.window_days = cfg.baseline_window_days
        row.valid = valid
        row.version = (row.version or 0) + 1
        row.computed_at = until


async def load_baselines(db: AsyncSession, equipment_id) -> dict[tuple[str, str], MachineBaseline]:
    rows = (await db.execute(
        select(MachineBaseline).where(MachineBaseline.equipment_id == equipment_id)
    )).scalars().all()
    return {(b.metric_key, b.context_key): b for b in rows}


def baseline_for(
    baselines: dict, metric_key: str, context: str,
) -> Optional[dict | MachineBaseline]:
    """Context-aware lookup with fallback to the 'all' baseline."""
    b = baselines.get((metric_key, context)) or baselines.get((metric_key, "all"))
    if b is None:
        return None
    valid = b.get("n", 0) > 0 if isinstance(b, dict) else b.valid
    return b if valid or isinstance(b, dict) else None
