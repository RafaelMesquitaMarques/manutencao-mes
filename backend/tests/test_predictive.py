"""Predictive intelligence engine tests.
=========================================
Same container harness as test_sushi.py — one shared loop, every write ALWAYS
rolled back (flush only, never commit). Covers:

  robust stats / slope / window features · score composition + level mapping ·
  sensor quality (frozen, stale) · baseline building (pre-failure exclusion,
  run/idle context split) · engine evaluation (anomaly + trend factors,
  snapshot persistence, maturity honesty) · alert lifecycle (persistence,
  hysteresis auto-close, cooldown, maintenance suppression, silent flag) ·
  MTBF signals · failure sync idempotency · fingerprints + pattern similarity ·
  configurable rules · plant isolation + mode-visibility ladder · backtest.

Run (inside the backend container):
    pytest tests/test_predictive.py -v
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                                   # noqa: E402
from app.core.plant_context import resolve_plant_context               # noqa: E402
from app.models.models import (                                        # noqa: E402
    Equipment, FailureEvent, FailurePattern, FailureSource, Machine,
    MachineProductionHourly, PredictiveAlert, PredictiveAlertStatus,
    PredictiveHealthSnapshot, PredictiveMode, PredictiveRule, PredictiveSettings,
    Plant, Sensor, SensorReading, User, UserPlant, UserRole,
    WorkOrder, WorkOrderPriority, WorkOrderStatus, WorkOrderType,
)
from app.services.predictive.backtest import run_backtest              # noqa: E402
from app.services.predictive.baseline import (                         # noqa: E402
    build_baselines_for_equipment, robust_sigma, robust_stats,
)
from app.services.predictive.config import EffectiveConfig             # noqa: E402
from app.services.predictive.engine import (                           # noqa: E402
    anomaly_value, compose_score, evaluate_equipment, level_for, process_alerts,
)
from app.services.predictive.failure_sync import (                     # noqa: E402
    capture_fingerprints, sync_failure_events,
)
from app.services.predictive.features import (                         # noqa: E402
    Bucket, slope_per_hour, window_features,
)
from app.services.predictive.quality import sensor_quality             # noqa: E402
from app.services.predictive.reliability import mtbf_signals           # noqa: E402
from app.api.routes import predictive as predictive_routes             # noqa: E402

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    def wrapper():
        async def runner():
            s = _maker()()
            try:
                await fn(s)
            finally:
                await s.rollback()
                await s.close()
        _LOOP.run_until_complete(runner())
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


def _now():
    return datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _plant(db, code="QS"):
    p = (await db.execute(select(Plant).where(Plant.code == code))).scalars().first()
    assert p is not None, f"live plant {code} must exist"
    return p


async def _mk_equipment(db, plant, criticality="medium"):
    eq = Equipment(plant_id=plant.id, code=f"T-PRED-{uuid.uuid4().hex[:8]}",
                   name="Test predictive rig", criticality=criticality, status="running")
    db.add(eq)
    await db.flush()
    return eq


async def _mk_sensor(db, eq, suffix="VEL", stype="vibration", unit="mm/s"):
    sensor = Sensor(equipment_id=eq.id, plant_id=eq.plant_id,
                    code=f"T-PRED-{uuid.uuid4().hex[:6]}-{suffix}",
                    name=f"test {suffix}", type=stype, unit=unit, active=True)
    db.add(sensor)
    await db.flush()
    return sensor


async def _readings(db, sensor, eq, hours, value_fn, end=None, step_min=60):
    end = end or _now()
    t = end - timedelta(hours=hours)
    rows = []
    while t <= end:
        rows.append(SensorReading(sensor_id=sensor.id, equipment_id=eq.id,
                                  timestamp=t, value=value_fn(t, end), quality="ok"))
        t += timedelta(minutes=step_min)
    db.add_all(rows)
    await db.flush()
    return len(rows)


def _flat(base=2.2):
    return lambda t, end: base + 0.1 * ((t.minute + t.hour) % 3 - 1)


def _ramp_last(base=2.2, rise=3.5, last_h=8):
    def fn(t, end):
        h = (end - t).total_seconds() / 3600.0
        v = base + 0.1 * ((t.hour % 3) - 1)
        if h <= last_h:
            v += (last_h - h) / last_h * rise
        return v
    return fn


def _cfg(plant, mode="silent", **kw):
    cfg = EffectiveConfig(plant_id=plant.id)
    cfg.mode = mode
    cfg.baseline_window_days = kw.pop("baseline_window_days", 10)
    cfg.baseline_min_samples = kw.pop("baseline_min_samples", 24)
    for k, v in kw.items():
        setattr(cfg, k, v)
    return cfg


async def _ctx(db, plant, role=UserRole.maintenance_director):
    u = User(id=uuid.uuid4(), name=f"pr-{uuid.uuid4().hex[:6]}",
             email=f"pr-{uuid.uuid4().hex[:10]}@test.local",
             password_hash="x", role=role, active=True)
    db.add(u)
    await db.flush()
    db.add(UserPlant(user_id=u.id, plant_id=plant.id, role=role, is_default=True))
    await db.flush()
    return u, await resolve_plant_context(db, u, None)


# ─── Pure math ─────────────────────────────────────────────────────────────────

def test_robust_stats_and_sigma():
    st = robust_stats([1.0, 2.0, 2.0, 2.0, 3.0, 100.0])
    assert st["median"] == 2.0
    assert st["mean"] > st["median"]            # outlier pulls the mean, not the median
    assert robust_sigma(st) > 0
    st2 = robust_stats([5.0] * 10)
    assert robust_sigma(st2) > 0                # floored — never zero-division


def test_slope_and_window_features():
    t0 = _now()
    buckets = [Bucket(t=t0 + timedelta(hours=h), avg=2.0 + 0.5 * h, max=2.6 + 0.5 * h,
                      min=1.8 + 0.5 * h, n=4, bad=0) for h in range(6)]
    f = window_features(buckets, t0 - timedelta(hours=1), t0 + timedelta(hours=6))
    assert f is not None and f["n"] == 24
    assert abs(f["slope_per_hour"] - 0.5) < 0.01
    assert slope_per_hour([(0, 1), (1, 1)]) == 0.0   # <3 points → no slope


def test_score_composition_and_levels():
    assert anomaly_value(2.0) == 0.0 and anomaly_value(6.0) == 1.0
    factors = [
        {"code": "vibration_anomaly", "contribution": 20.0},
        {"code": "mtbf_consumed", "contribution": 10.0},
    ]
    assert compose_score(factors, "medium") == 30.0
    assert compose_score(factors, "critical") == 36.0      # criticality multiplier
    levels = {"watch": 25, "alert": 50, "critical": 70}
    assert level_for(10, levels) == "normal"
    assert level_for(30, levels) == "watch"
    assert level_for(55, levels) == "alert"
    assert level_for(80, levels) == "critical"


# ─── Sensor data quality ───────────────────────────────────────────────────────

@with_session
async def test_quality_frozen_sensor(db):
    p = await _plant(db)
    eq = await _mk_equipment(db, p)
    s1 = await _mk_sensor(db, eq, "TEMP", "temperature", "°C")
    await _readings(db, s1, eq, 12, lambda t, e: 41.7)     # identical for 12 h
    q = await sensor_quality(db, s1, [], _now())
    assert q["status"] == "faulty" and "frozen" in q["issues"]


@with_session
async def test_quality_stale_sensor(db):
    p = await _plant(db)
    eq = await _mk_equipment(db, p)
    s1 = await _mk_sensor(db, eq)
    end = _now() - timedelta(hours=30)                     # nothing for 30 h
    await _readings(db, s1, eq, 6, _flat(), end=end)
    q = await sensor_quality(db, s1, [], _now())
    assert q["status"] == "faulty" and "stale" in q["issues"]


# ─── Baselines ─────────────────────────────────────────────────────────────────

@with_session
async def test_baseline_excludes_prefailure(db):
    """The 24h ramp before a failure must NOT contaminate the baseline."""
    p = await _plant(db)
    eq = await _mk_equipment(db, p)
    s1 = await _mk_sensor(db, eq)
    now = _now()
    fail_at = now - timedelta(days=2)

    def fn(t, end):
        h_to_fail = (fail_at - t).total_seconds() / 3600.0
        v = 2.2
        if 0 <= h_to_fail <= 24:
            v += (24 - h_to_fail) / 24 * 4.0               # degradation before failure
        return v
    await _readings(db, s1, eq, 24 * 9, fn)
    db.add(FailureEvent(equipment_id=eq.id, plant_id=p.id, source=FailureSource.manual,
                        source_id=uuid.uuid4(), started_at=fail_at, confirmed=True))
    await db.flush()
    cfg = _cfg(p)
    bases = await build_baselines_for_equipment(db, eq, cfg, persist=True)
    b = bases[(s1.code, "all")]
    assert b["median"] < 2.6, f"pre-failure ramp leaked into baseline: {b['median']}"
    rows = (await db.execute(
        select(SensorReading).where(SensorReading.sensor_id == s1.id).limit(1))).scalars().all()
    assert rows, "sanity: readings exist"


@with_session
async def test_baseline_context_split(db):
    """Production hours split the baseline into run vs idle contexts."""
    p = await _plant(db)
    eq = await _mk_equipment(db, p)
    m = Machine(name=f"T-PRED-M-{uuid.uuid4().hex[:6]}", equipment_id=eq.id,
                plant_id=p.id, is_active=True)
    db.add(m)
    await db.flush()
    s1 = await _mk_sensor(db, eq)
    now = _now()

    prod_rows = []
    for h in range(24 * 8):
        hour = now - timedelta(hours=h)
        producing = (hour.hour % 2 == 0)                    # every other hour runs
        prod_rows.append(MachineProductionHourly(
            machine_id=m.id, hour=hour, count=10 if producing else 0))
    db.add_all(prod_rows)

    def fn(t, end):
        return 4.0 if t.hour % 2 == 0 else 1.0              # vib high at speed
    await _readings(db, s1, eq, 24 * 8, fn, step_min=30)
    cfg = _cfg(p)
    bases = await build_baselines_for_equipment(db, eq, cfg, persist=False)
    assert (s1.code, "run") in bases and (s1.code, "idle") in bases
    assert bases[(s1.code, "run")]["median"] > bases[(s1.code, "idle")]["median"] + 2.0


# ─── Engine evaluation ─────────────────────────────────────────────────────────

async def _seed_rig(db, plant, *, ramp=True, days=10):
    eq = await _mk_equipment(db, plant, criticality="high")
    s1 = await _mk_sensor(db, eq)
    fn = _ramp_last() if ramp else _flat()
    await _readings(db, s1, eq, 24 * days, fn, step_min=30)
    cfg = _cfg(plant)
    await build_baselines_for_equipment(db, eq, cfg, until=_now() - timedelta(hours=12))
    return eq, s1, cfg


@with_session
async def test_evaluate_scores_ramp(db):
    p = await _plant(db)
    eq, s1, cfg = await _seed_rig(db, p, ramp=True)
    snap = await evaluate_equipment(db, eq, cfg)
    codes = {f["code"] for f in snap["factors"]}
    assert "vibration_anomaly" in codes, f"factors: {codes}"
    assert snap["score"] > 0
    assert snap["maturity"] == "anomaly_active"
    row = (await db.execute(
        select(PredictiveHealthSnapshot).where(PredictiveHealthSnapshot.equipment_id == eq.id)
    )).scalars().all()
    assert len(row) == 1 and row[0].engine_version         # audit trail persisted
    vib = next(f for f in snap["factors"] if f["code"] == "vibration_anomaly")
    assert vib["observed"] > vib["expected"], "explainability: observed vs expected"


@with_session
async def test_evaluate_flat_machine_stays_normal(db):
    p = await _plant(db)
    eq, s1, cfg = await _seed_rig(db, p, ramp=False)
    snap = await evaluate_equipment(db, eq, cfg)
    assert snap["level"] in ("normal", "watch")
    assert snap["score"] < 50


@with_session
async def test_evaluate_insufficient_data_honesty(db):
    p = await _plant(db)
    eq = await _mk_equipment(db, p)
    s1 = await _mk_sensor(db, eq)
    await _readings(db, s1, eq, 4, _flat())                # 4h of data, no baseline
    cfg = _cfg(p)
    snap = await evaluate_equipment(db, eq, cfg)
    assert snap["maturity"] == "baseline_building"
    assert all(f["code"] != "vibration_anomaly" for f in snap["factors"])


# ─── Alert lifecycle ───────────────────────────────────────────────────────────

async def _alerts_for(db, eq):
    return (await db.execute(
        select(PredictiveAlert).where(PredictiveAlert.equipment_id == eq.id)
    )).scalars().all()


@with_session
async def test_alert_persistence_then_creation_silent_flag(db):
    p = await _plant(db)
    eq, s1, cfg = await _seed_rig(db, p, ramp=True)
    cfg.levels = {"watch": 10.0, "alert": 15.0, "critical": 60.0, "deadband": 5.0}

    snap1 = await evaluate_equipment(db, eq, cfg)
    assert snap1["score"] >= 15.0, "rig must evaluate above the alert threshold"
    await process_alerts(db, eq, None, cfg, snap1)
    assert await _alerts_for(db, eq) == [], "persistence: 1 eval must NOT alert"

    snap2 = await evaluate_equipment(db, eq, cfg)
    await process_alerts(db, eq, None, cfg, snap2)
    alerts = await _alerts_for(db, eq)
    assert len(alerts) == 1, "2 consecutive evals ≥ alert → one alert"
    a = alerts[0]
    assert a.silent is True                                 # silent mode → recorded, not notified
    assert a.reasons and a.recommendation
    assert a.engine_version and a.config_version is not None


@with_session
async def test_alert_update_not_duplicate_and_autoclose(db):
    p = await _plant(db)
    eq, s1, cfg = await _seed_rig(db, p, ramp=True)
    cfg.levels = {"watch": 10.0, "alert": 15.0, "critical": 60.0, "deadband": 5.0}
    for _ in range(2):
        snap = await evaluate_equipment(db, eq, cfg)
        await process_alerts(db, eq, None, cfg, snap)
    snap = await evaluate_equipment(db, eq, cfg)
    await process_alerts(db, eq, None, cfg, snap)
    alerts = await _alerts_for(db, eq)
    assert len(alerts) == 1, "sustained condition updates the open alert, no duplicates"

    # Hysteresis auto-close: replace history with two comfortable-low snapshots.
    for _ in range(2):
        db.add(PredictiveHealthSnapshot(
            equipment_id=eq.id, plant_id=p.id, ts=datetime.now(timezone.utc),
            score=1.0, level="normal"))
        await db.flush()
        snap_low = dict(snap, score=1.0, level="normal", ts=datetime.now(timezone.utc).isoformat())
        await process_alerts(db, eq, None, cfg, snap_low)
    a = (await _alerts_for(db, eq))[0]
    assert a.status == PredictiveAlertStatus.closed and a.auto_resolved


@with_session
async def test_alert_cooldown(db):
    p = await _plant(db)
    eq, s1, cfg = await _seed_rig(db, p, ramp=True)
    cfg.levels = {"watch": 10.0, "alert": 15.0, "critical": 60.0, "deadband": 5.0}
    for _ in range(2):
        snap = await evaluate_equipment(db, eq, cfg)
        await process_alerts(db, eq, None, cfg, snap)
    a = (await _alerts_for(db, eq))[0]
    a.status = PredictiveAlertStatus.closed
    a.resolved_at = datetime.now(timezone.utc)
    await db.flush()
    snap = await evaluate_equipment(db, eq, cfg)
    await process_alerts(db, eq, None, cfg, snap)
    assert len(await _alerts_for(db, eq)) == 1, "cooldown blocks an immediate re-alert"


@with_session
async def test_alert_suppressed_during_maintenance(db):
    p = await _plant(db)
    eq, s1, cfg = await _seed_rig(db, p, ramp=True)
    cfg.levels = {"watch": 10.0, "alert": 15.0, "critical": 60.0, "deadband": 5.0}
    m = Machine(name=f"T-PRED-M-{uuid.uuid4().hex[:6]}", equipment_id=eq.id,
                plant_id=p.id, is_active=True, current_status="intervention")
    db.add(m)
    await db.flush()
    for _ in range(2):
        snap = await evaluate_equipment(db, eq, cfg, machine=m)
        await process_alerts(db, eq, m, cfg, snap)
    assert await _alerts_for(db, eq) == [], "no predictive alert while under intervention"


# ─── Reliability ───────────────────────────────────────────────────────────────

@with_session
async def test_mtbf_signals(db):
    p = await _plant(db)
    eq = await _mk_equipment(db, p)
    now = _now()
    for d in (40, 30, 20, 10):                              # regular ~10-day cadence
        db.add(FailureEvent(equipment_id=eq.id, plant_id=p.id, source=FailureSource.manual,
                            source_id=uuid.uuid4(), started_at=now - timedelta(days=d),
                            confirmed=True))
    await db.flush()
    sig = await mtbf_signals(db, eq.id, at=now)
    assert sig is not None and sig["mtbf_hist_h"] == pytest.approx(240, rel=0.05)
    assert sig["pct_consumed"] == pytest.approx(100, rel=0.05)


# ─── Failure sync & fingerprints ───────────────────────────────────────────────

@with_session
async def test_failure_sync_idempotent(db):
    p = await _plant(db)
    eq = await _mk_equipment(db, p)
    wo = WorkOrder(wo_number=f"WO-T-{uuid.uuid4().hex[:8]}", equipment_id=eq.id,
                   type=WorkOrderType.corrective, priority=WorkOrderPriority.high,
                   status=WorkOrderStatus.completed, title="bearing seized",
                   failure_code="BRG", component="bearing",
                   opened_at=_now() - timedelta(days=1),
                   completed_at=_now() - timedelta(hours=20))
    db.add(wo)
    await db.flush()
    since = _now() - timedelta(days=2)
    n1 = await sync_failure_events(db, plant_id=p.id, since=since)
    assert n1 >= 1
    ours = (await db.execute(
        select(FailureEvent).where(FailureEvent.source_id == wo.id))).scalars().all()
    assert len(ours) == 1 and ours[0].confirmed and ours[0].component == "bearing"
    n2 = await sync_failure_events(db, plant_id=p.id, since=since)
    ours2 = (await db.execute(
        select(FailureEvent).where(FailureEvent.source_id == wo.id))).scalars().all()
    assert len(ours2) == 1, f"second sync duplicated the event (created {n2})"


@with_session
async def test_fingerprints_and_pattern_similarity(db):
    p = await _plant(db)
    eq = await _mk_equipment(db, p, criticality="high")
    s1 = await _mk_sensor(db, eq)
    now = _now()
    f1, f2 = now - timedelta(days=6), now - timedelta(days=3)

    def fn(t, end):
        v = 2.2
        for fa in (f1, f2):
            h = (fa - t).total_seconds() / 3600.0
            if 0 <= h <= 24:
                v += (24 - h) / 24 * 3.5                    # same signature before both
        h_now = (end - t).total_seconds() / 3600.0
        if h_now <= 8:
            v += (8 - h_now) / 8 * 3.3                      # …and it is happening again
        return v
    await _readings(db, s1, eq, 24 * 9, fn, step_min=30)
    for fa in (f1, f2):
        db.add(FailureEvent(equipment_id=eq.id, plant_id=p.id, source=FailureSource.manual,
                            source_id=uuid.uuid4(), started_at=fa, confirmed=True,
                            component="bearing", failure_type="BRG"))
    await db.flush()
    cfg = _cfg(p)
    made = await capture_fingerprints(db, cfg, plant_id=p.id, limit=10)
    assert made >= 2, "fingerprints captured for the confirmed failures"
    await build_baselines_for_equipment(db, eq, cfg, until=now - timedelta(hours=30))
    snap = await evaluate_equipment(db, eq, cfg)
    codes = {f["code"] for f in snap["factors"]}
    assert "pattern_similarity" in codes, f"factors: {codes}"
    await process_alerts(db, eq, None, cfg, snap)
    snap2 = await evaluate_equipment(db, eq, cfg)
    await process_alerts(db, eq, None, cfg, snap2)
    alerts = await _alerts_for(db, eq)
    if alerts:                                              # component inferred from matched failures
        assert alerts[0].probable_component in ("bearing", None)


@with_session
async def test_sensorless_machine_operational_evaluation(db):
    """A machine with kiosk data but NO condition sensors is evaluated on the
    operational + reliability layers, with honest maturity and capped
    confidence — predictive value before any sensor is installed."""
    p = await _plant(db)
    eq = await _mk_equipment(db, p, criticality="high")
    m = Machine(name=f"T-PRED-M-{uuid.uuid4().hex[:6]}", equipment_id=eq.id,
                plant_id=p.id, is_active=True)
    db.add(m)
    await db.flush()
    now = _now()

    # Normal life: 2 short stops/day for 20 days.
    from app.models.models import MachineStop
    for d in range(1, 21):
        day = now - timedelta(days=d)
        for k in range(2):
            start = day + timedelta(hours=3 * k)
            db.add(MachineStop(machine_id=m.id, plant_id=p.id, started_at=start,
                               ended_at=start + timedelta(minutes=5), duration_minutes=5))
    # Last 6 hours: microstop surge.
    for k in range(8):
        start = now - timedelta(hours=6) + timedelta(minutes=40 * k)
        db.add(MachineStop(machine_id=m.id, plant_id=p.id, started_at=start,
                           ended_at=start + timedelta(minutes=6), duration_minutes=6))
    # Failure history with shrinking intervals → mtbf_declining.
    for d in (300, 180, 80, 45, 20):
        db.add(FailureEvent(equipment_id=eq.id, plant_id=p.id, source=FailureSource.manual,
                            source_id=uuid.uuid4(), started_at=now - timedelta(days=d),
                            confirmed=True))
    await db.flush()

    cfg = _cfg(p)
    baselines = await build_baselines_for_equipment(
        db, eq, cfg, until=now - timedelta(hours=12), persist=False)
    snap = await evaluate_equipment(db, eq, cfg, machine=m, baselines=baselines)
    codes = {f["code"] for f in snap["factors"]}
    assert "microstops" in codes, f"factors: {codes}"
    assert "mtbf_declining" in codes, f"factors: {codes}"
    assert snap["maturity"] == "rules_monitoring"
    assert 0.0 < snap["confidence"] <= 0.75, "sensor-less confidence must be capped"
    assert snap["score"] > 0


@with_session
async def test_pattern_no_future_leakage(db):
    """Evaluating at time T must ignore fingerprints of failures AFTER T —
    otherwise backtests would grade themselves with future knowledge."""
    p = await _plant(db)
    eq = await _mk_equipment(db, p)
    s1 = await _mk_sensor(db, eq)
    now = _now()
    f1, f2 = now - timedelta(days=6), now - timedelta(days=3)

    def fn(t, end):
        v = 2.2
        for fa in (f1, f2):
            h = (fa - t).total_seconds() / 3600.0
            if 0 <= h <= 24:
                v += (24 - h) / 24 * 3.5
        return v
    await _readings(db, s1, eq, 24 * 9, fn, step_min=30)
    for fa in (f1, f2):
        db.add(FailureEvent(equipment_id=eq.id, plant_id=p.id, source=FailureSource.manual,
                            source_id=uuid.uuid4(), started_at=fa, confirmed=True))
    await db.flush()
    cfg = _cfg(p)
    assert await capture_fingerprints(db, cfg, plant_id=p.id, limit=10) >= 2
    baselines = await build_baselines_for_equipment(
        db, eq, cfg, until=now - timedelta(days=8), persist=False)

    # Inside f1's pre-failure ramp, but BEFORE both failures exist.
    at = now - timedelta(days=6, hours=6)
    snap = await evaluate_equipment(db, eq, cfg, at=at, baselines=baselines, persist=False)
    assert all(f["code"] != "pattern_similarity" for f in snap["factors"]), \
        "fingerprints of future failures leaked into the past"


# ─── Configurable rules ────────────────────────────────────────────────────────

@with_session
async def test_rule_triggers_factor(db):
    p = await _plant(db)
    eq, s1, cfg = await _seed_rig(db, p, ramp=True)
    db.add(PredictiveRule(plant_id=p.id, equipment_id=eq.id, name="vib avg 2h > 3",
                          metric_key=s1.code, aggregation="avg", window_hours=2.0,
                          operator="gt", threshold=3.0, severity="alert", enabled=True))
    await db.flush()
    snap = await evaluate_equipment(db, eq, cfg)
    rules = [f for f in snap["factors"] if f["code"] == "rule_triggered"]
    assert rules and rules[0]["params"]["name"] == "vib avg 2h > 3"


# ─── Multi-plant isolation + visibility ladder ────────────────────────────────

@with_session
async def test_cross_plant_alert_404_and_overview_isolation(db):
    qs = await _plant(db, "QS")
    nl = await _plant(db, "NL")
    eq = await _mk_equipment(db, qs)
    db.add(PredictiveHealthSnapshot(equipment_id=eq.id, plant_id=qs.id,
                                    ts=datetime.now(timezone.utc), score=90.0, level="critical"))
    alert = PredictiveAlert(equipment_id=eq.id, plant_id=qs.id, level="critical",
                            score=90.0, kind="vibration")
    db.add(alert)
    await db.flush()

    # Non-corporate role: membership limits access → wrong-plant detail is 404.
    # (Admins are corporate by design and can access every plant.)
    u_nl, ctx_nl = await _ctx(db, nl, role=UserRole.maintenance_director)
    with pytest.raises(HTTPException) as ex:
        await predictive_routes.alert_detail(alert.id, db=db, ctx=ctx_nl, user=u_nl)
    assert ex.value.status_code == 404

    # Overview is filtered by the ACTIVE plant even for a corporate admin.
    u_adm, ctx_adm = await _ctx(db, nl, role=UserRole.admin)
    ov = await predictive_routes.overview(db=db, ctx=ctx_adm, user=u_adm)
    assert all(m["equipment_id"] != str(eq.id) for m in ov.get("machines", []))


@with_session
async def test_mode_visibility_ladder(db):
    qs = await _plant(db, "QS")
    st = (await db.execute(
        select(PredictiveSettings).where(PredictiveSettings.plant_id == qs.id)
    )).scalar_one_or_none()
    if st is None:
        st = PredictiveSettings(plant_id=qs.id, mode=PredictiveMode.silent)
        db.add(st)
    else:
        st.mode = PredictiveMode.silent
    await db.flush()

    u_tech, ctx_t = await _ctx(db, qs, role=UserRole.technician)
    ov = await predictive_routes.overview(db=db, ctx=ctx_t, user=u_tech)
    assert ov["visible"] is False, "silent mode hides data from non-admins"

    u_adm, ctx_a = await _ctx(db, qs, role=UserRole.admin)
    ov2 = await predictive_routes.overview(db=db, ctx=ctx_a, user=u_adm)
    assert ov2["visible"] is True, "silent mode is visible to admins"

    st.mode = PredictiveMode.admin
    await db.flush()
    u_sup, ctx_s = await _ctx(db, qs, role=UserRole.supervisor)
    ov3 = await predictive_routes.overview(db=db, ctx=ctx_s, user=u_sup)
    assert ov3["visible"] is True, "admin mode is visible to supervisors"


# ─── Backtest ──────────────────────────────────────────────────────────────────

@with_session
async def test_backtest_replay(db):
    p = await _plant(db)
    eq = await _mk_equipment(db, p, criticality="high")
    s1 = await _mk_sensor(db, eq)
    now = _now()
    fail_at = now - timedelta(days=1)

    def fn(t, end):
        h = (fail_at - t).total_seconds() / 3600.0
        v = 2.2
        if 0 <= h <= 24:
            v += (24 - h) / 24 * 4.5
        return v
    await _readings(db, s1, eq, 24 * 12, fn, step_min=30)
    db.add(FailureEvent(equipment_id=eq.id, plant_id=p.id, source=FailureSource.manual,
                        source_id=uuid.uuid4(), started_at=fail_at, confirmed=True))
    await db.flush()
    cfg = _cfg(p)
    cfg.levels = {"watch": 8.0, "alert": 12.0, "critical": 60.0, "deadband": 3.0}
    start, end = now - timedelta(days=3), now - timedelta(hours=12)
    result = await run_backtest(db, eq, cfg, start, end, step_min=120)
    assert result["metrics"]["evaluations"] > 10
    assert result["metrics"]["failures"] == 1
    assert result["metrics"]["detected"] == 1, "the pre-failure ramp must be detected"
    f = result["failures"][0]
    assert f["detected"] and f["lead_hours"] is not None and f["lead_hours"] > 0
    with pytest.raises(ValueError):
        await run_backtest(db, eq, cfg, start, start + timedelta(days=120))
