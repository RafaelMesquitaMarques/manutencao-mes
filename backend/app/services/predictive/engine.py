"""Predictive scoring engine + explainable alert manager.

`evaluate_equipment` runs the layered analysis (rules · baseline anomaly ·
trend · operational · reliability · pattern similarity) for one equipment at
one instant and returns a fully explainable snapshot: every factor carries its
weight, 0..1 value, contribution, observed/expected values and i18n params —
the UI renders reasons from codes, never from prose.

`process_alerts` turns snapshot sequences into alerts with persistence,
hysteresis, cooldown and suppression (maintenance windows, sensor faults,
confidence floor). Notifications fire only in `active` mode.
"""
from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    Alert,
    Equipment,
    FailurePattern,
    FailureEvent,
    Machine,
    NotificationLog,
    PredictiveAlert,
    PredictiveAlertStatus,
    PredictiveHealthSnapshot,
    PredictiveRule,
    Sensor,
)

from .baseline import (
    METRIC_MICROSTOPS,
    METRIC_PRODUCTION,
    METRIC_STOP_MINUTES,
    baseline_for,
    load_baselines,
    robust_sigma,
)
from .config import CORE_FACTORS, CRITICALITY_MULT, EffectiveConfig
from .features import (
    fetch_bucket_series,
    production_rate,
    stop_stats,
    window_features,
    current_context,
)
from .quality import combined_quality_score, sensor_quality
from .reliability import mtbf_signals

log = logging.getLogger("predictive")

ENGINE_VERSION = "1.0.0"

OPEN_STATUSES = (
    PredictiveAlertStatus.new,
    PredictiveAlertStatus.in_review,
    PredictiveAlertStatus.inspection_planned,
    PredictiveAlertStatus.intervention_required,
    PredictiveAlertStatus.monitoring,
)

_FACTOR_FAMILY = {
    "vibration_anomaly": "vibration",
    "temperature_anomaly": "temperature",
    "pressure_anomaly": "pressure",
    "microstops": "operational",
    "stop_minutes": "operational",
    "production_drop": "operational",
    "alarm_activity": "operational",
    "mtbf_consumed": "reliability",
    "mtbf_declining": "reliability",
    "pattern_similarity": "pattern",
    "rule_triggered": "rule",
}

RECOMMENDATIONS = {
    "vibration": "inspect_rotating_parts",
    "temperature": "check_cooling_lubrication",
    "pressure": "check_pressure_circuit",
    "operational": "review_operational_events",
    "reliability": "plan_preventive_inspection",
    "pattern": "inspect_pattern_component",
    "rule": "follow_rule_action",
    "general": "inspect_machine",
}

# Short French lines for the Teams card (the app UI renders reasons via i18n;
# the card is a push medium with the platform's notification language).
_REASON_FR = {
    "vib_above_baseline": "Vibration {sensor} +{pct}% vs baseline",
    "temp_above_baseline": "Température {sensor} +{delta} {unit} vs baseline",
    "press_out_of_baseline": "Pression {sensor} hors plage habituelle",
    "degradation_trend": "Tendance croissante sur {window_h}h ({sensor})",
    "microstops_increase": "{count} microarrêts vs {expected} attendus",
    "stop_time_increase": "{minutes} min d'arrêt vs {expected} attendues",
    "production_drop": "Production -{pct}% vs baseline",
    "alarm_activity": "{count} alarmes capteur en 24h",
    "mtbf_consumed": "{pct}% du MTBF attendu consommé",
    "mtbf_declining": "MTBF en baisse : {recent_h}h récent vs {hist_h}h historique",
    "similar_pattern": "Signature semblable à {matched}/{total} pannes passées",
    "rule_triggered": "Règle «{name}» déclenchée",
}


def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def anomaly_value(z: float) -> float:
    """z≤2σ → 0 (normal band); 6σ → 1."""
    return clamp01((z - 2.0) / 4.0)


def trend_value(sigmas_over_window: float) -> float:
    return clamp01((sigmas_over_window - 0.5) / 2.5)


def level_for(score: float, levels: dict) -> str:
    if score >= levels.get("critical", 70.0):
        return "critical"
    if score >= levels.get("alert", 50.0):
        return "alert"
    if score >= levels.get("watch", 25.0):
        return "watch"
    return "normal"


def compose_score(factors: list[dict], criticality: Optional[str]) -> float:
    total = sum(f["contribution"] for f in factors)
    return round(min(100.0, total * CRITICALITY_MULT.get(criticality or "medium", 1.0)), 1)


def _family_of_sensor(sensor: Sensor) -> str:
    hint = f"{sensor.type or ''} {sensor.code or ''}".lower()
    if "press" in hint:
        return "pressure"
    if "temp" in hint:
        return "temperature"
    if any(k in hint for k in ("vib", "vel", "acc")):
        return "vibration"
    if "current" in hint:
        return "current"
    return "other"


def _mk_factor(code, weight, value, quality, *, observed=None, expected=None,
               unit=None, params=None, reason=None, family=None) -> dict:
    v = clamp01(value)
    return {
        "code": code,
        "family": family or _FACTOR_FAMILY.get(code, "general"),
        "weight": weight,
        "value": round(v, 3),
        "quality": round(quality, 2),
        "contribution": round(weight * v * quality, 2),
        "observed": observed,
        "expected": expected,
        "unit": unit,
        "params": params or {},
        "reason": reason,
    }


async def _alarm_count(db: AsyncSession, sensor_ids, since, until) -> int:
    if not sensor_ids:
        return 0
    rows = (await db.execute(
        select(Alert.id).where(
            Alert.sensor_id.in_(sensor_ids),
            Alert.created_at > since, Alert.created_at <= until,
        )
    )).scalars().all()
    return len(rows)


def pattern_distance(current: dict, pattern_feats: dict, baselines: dict) -> Optional[float]:
    """Mean normalized distance between the live window features and one
    stored pre-failure fingerprint. None = nothing comparable.

    Scale = max(baseline robust σ, 25% of the fingerprint magnitude): the σ
    term keeps ultra-stable signals sensitive, the magnitude term tolerates
    the natural variation between two occurrences of the same failure mode
    (an exact-σ match would never fire on real data)."""
    ds = []
    for metric, pf in pattern_feats.items():
        cf = current.get(metric)
        if cf is None or pf.get("avg") is None:
            continue
        base = baseline_for(baselines, metric, "all")
        sigma = robust_sigma(base) if base is not None else 0.0
        scale = max(sigma, abs(pf["avg"]) * 0.25, 1e-6)
        ds.append(abs(cf["avg"] - pf["avg"]) / scale)
    if not ds:
        return None
    return sum(ds) / len(ds)


async def evaluate_equipment(
    db: AsyncSession,
    equipment: Equipment,
    cfg: EffectiveConfig,
    *,
    machine: Optional[Machine] = None,
    at: Optional[datetime] = None,
    baselines: Optional[dict] = None,
    persist: bool = True,
) -> dict:
    """One full evaluation. Returns the snapshot dict; persists a
    PredictiveHealthSnapshot row when persist=True."""
    at = at or datetime.now(timezone.utc)
    w = cfg.windows
    long_h = float(w.get("long_h", 24.0))
    medium_h = float(w.get("medium_h", 8.0))
    trend_h = float(w.get("trend_h", 6.0))

    if machine is None:
        machine = (await db.execute(
            select(Machine).where(Machine.equipment_id == equipment.id).limit(1)
        )).scalar_one_or_none()

    sensors = (await db.execute(
        select(Sensor).where(Sensor.equipment_id == equipment.id, Sensor.active.is_(True))
    )).scalars().all()

    rules = (await db.execute(
        select(PredictiveRule).where(
            PredictiveRule.enabled.is_(True),
            PredictiveRule.plant_id == equipment.plant_id,
            (PredictiveRule.equipment_id.is_(None)) | (PredictiveRule.equipment_id == equipment.id),
        )
    )).scalars().all()

    fetch_h = max([long_h, trend_h, medium_h]
                  + [float(r.window_hours or 1) for r in rules]
                  + [float(x) for x in cfg.fingerprint_windows_h])
    since_all = at - timedelta(hours=fetch_h)

    if baselines is None:
        baselines = await load_baselines(db, equipment.id)
    context = await current_context(db, machine, at)

    # ── Per-sensor series + quality ───────────────────────────────────────────
    series: dict[str, list] = {}
    feats_med: dict[str, Optional[dict]] = {}
    quality_findings: dict[str, dict] = {}
    sensor_by_code: dict[str, Sensor] = {}
    from app.models.models import SushiDevice
    periods: dict[str, int] = {}
    devices = (await db.execute(
        select(SushiDevice).where(SushiDevice.equipment_id == equipment.id)
    )).scalars().all()
    for d in devices:
        if d.dev_eui:
            periods[d.dev_eui.upper()] = d.update_period_min or 60

    for sensor in sensors:
        buckets = await fetch_bucket_series(db, sensor.id, since_all, at)
        series[sensor.code] = buckets
        sensor_by_code[sensor.code] = sensor
        period = next((p for eui, p in periods.items() if eui in (sensor.code or "")), 60)
        quality_findings[sensor.code] = await sensor_quality(
            db, sensor, buckets, at, update_period_min=period, window_hours=long_h,
        )
        feats_med[sensor.code] = window_features(buckets, at - timedelta(hours=medium_h), at)

    quality_score = combined_quality_score(quality_findings) if sensors else 0.0

    def _usable(code: str) -> bool:
        return quality_findings.get(code, {}).get("status") in ("ok", "degraded")

    def _q(code: str) -> float:
        return 1.0 if quality_findings.get(code, {}).get("status") == "ok" else 0.6

    factors: list[dict] = []

    # ── L1: baseline anomaly per family ──────────────────────────────────────
    fam_codes = {"vibration": "vib_above_baseline", "temperature": "temp_above_baseline",
                 "pressure": "press_out_of_baseline"}
    fam_factor_code = {"vibration": "vibration_anomaly", "temperature": "temperature_anomaly",
                       "pressure": "pressure_anomaly"}
    best_by_family: dict[str, dict] = {}
    for code, f in feats_med.items():
        if f is None or not _usable(code):
            continue
        sensor = sensor_by_code[code]
        family = _family_of_sensor(sensor)
        if family not in fam_factor_code:
            continue
        base = baseline_for(baselines, code, context)
        if base is None:
            continue
        median = base["median"] if isinstance(base, dict) else base.median
        if median is None:
            continue
        sigma = robust_sigma(base)
        z = (f["avg"] - median) / sigma
        if family == "pressure":
            z = abs(z)
        val = anomaly_value(z)
        cand = {
            "z": z, "val": val, "sensor": code, "avg": f["avg"], "median": median,
            "unit": (base.get("unit") if isinstance(base, dict) else base.unit) or sensor.unit,
            "family": family,
        }
        cur = best_by_family.get(family)
        if cur is None or val > cur["val"]:
            best_by_family[family] = cand
    for family, cand in best_by_family.items():
        pct = round((cand["avg"] / cand["median"] - 1) * 100.0, 1) if abs(cand["median"]) > 1e-9 else None
        factors.append(_mk_factor(
            fam_factor_code[family], cfg.weights.get(fam_factor_code[family], 0.0),
            cand["val"], _q(cand["sensor"]),
            observed=round(cand["avg"], 2), expected=round(cand["median"], 2), unit=cand["unit"],
            params={"sensor": cand["sensor"], "pct": pct, "z": round(cand["z"], 2),
                    "window_h": medium_h, "context": context,
                    "delta": round(cand["avg"] - cand["median"], 1)},
            reason=fam_codes[family], family=family,
        ))

    # ── L2: degradation trend (vibration/temperature, positive slopes) ───────
    best_trend = None
    for code, buckets in series.items():
        if not _usable(code):
            continue
        sensor = sensor_by_code[code]
        family = _family_of_sensor(sensor)
        if family not in ("vibration", "temperature"):
            continue
        f = window_features(buckets, at - timedelta(hours=trend_h), at)
        if f is None or f["slope_per_hour"] <= 0:
            continue
        base = baseline_for(baselines, code, context)
        sigma = robust_sigma(base) if base is not None else max(abs(f["avg"]) * 0.1, 1e-6)
        sigmas = f["slope_per_hour"] * trend_h / sigma
        val = trend_value(sigmas)
        if best_trend is None or val > best_trend["val"]:
            best_trend = {"val": val, "sensor": code, "family": family,
                          "slope": f["slope_per_hour"], "sigmas": sigmas, "unit": sensor.unit}
    if best_trend and best_trend["val"] > 0:
        factors.append(_mk_factor(
            "degradation_trend", cfg.weights.get("degradation_trend", 0.0),
            best_trend["val"], _q(best_trend["sensor"]),
            observed=round(best_trend["slope"], 3), unit=f"{best_trend['unit']}/h" if best_trend["unit"] else None,
            params={"sensor": best_trend["sensor"], "window_h": trend_h,
                    "sigmas": round(best_trend["sigmas"], 2), "family": best_trend["family"]},
            reason="degradation_trend", family=best_trend["family"],
        ))

    # ── L3: operational factors ──────────────────────────────────────────────
    stops = mtbf = prod = None
    if machine is not None:
        stops = await stop_stats(db, machine.id, at - timedelta(hours=medium_h), at)
        base_ms = baseline_for(baselines, METRIC_MICROSTOPS, "all")
        if stops["microstops"] > 0:
            if base_ms is not None:
                med = base_ms["median"] if isinstance(base_ms, dict) else base_ms.median
                expected = max((med or 0.0) / 24.0 * medium_h, 0.25)
                ratio = stops["microstops"] / expected
                val = clamp01((ratio - 1.5) / 2.5)
            else:
                expected = None
                val = clamp01((stops["microstops"] - 3) / 7.0)
            if val > 0:
                factors.append(_mk_factor(
                    "microstops", cfg.weights.get("microstops", 0.0), val, 1.0,
                    observed=stops["microstops"],
                    expected=round(expected, 1) if expected is not None else None,
                    params={"count": stops["microstops"], "window_h": medium_h,
                            "expected": round(expected, 1) if expected is not None else "—"},
                    reason="microstops_increase",
                ))

        base_sm = baseline_for(baselines, METRIC_STOP_MINUTES, "all")
        if stops["stop_minutes"] > 0 and base_sm is not None:
            med = base_sm["median"] if isinstance(base_sm, dict) else base_sm.median
            expected_min = max((med or 0.0) / 24.0 * medium_h, 5.0)
            ratio = stops["stop_minutes"] / expected_min
            val = clamp01((ratio - 1.5) / 2.5)
            if val > 0:
                factors.append(_mk_factor(
                    "stop_minutes", cfg.weights.get("stop_minutes", 0.0), val, 1.0,
                    observed=round(stops["stop_minutes"], 0),
                    expected=round(expected_min, 0), unit="min",
                    params={"minutes": round(stops["stop_minutes"]), "window_h": medium_h,
                            "expected": round(expected_min)},
                    reason="stop_time_increase",
                ))

        prod = await production_rate(db, machine.id, at - timedelta(hours=medium_h), at)
        base_pr = baseline_for(baselines, METRIC_PRODUCTION, "run")
        if prod is not None and base_pr is not None:
            med = base_pr["median"] if isinstance(base_pr, dict) else base_pr.median
            if med and med > 0:
                drop = (1.0 - prod["rate"] / med) * 100.0
                val = clamp01((drop - 15.0) / 50.0)
                if val > 0:
                    factors.append(_mk_factor(
                        "production_drop", cfg.weights.get("production_drop", 0.0), val, 1.0,
                        observed=round(prod["rate"], 1), expected=round(med, 1), unit="pcs/h",
                        params={"pct": round(drop, 1), "window_h": medium_h},
                        reason="production_drop",
                    ))

    n_alarms = await _alarm_count(db, [s.id for s in sensors], at - timedelta(hours=24), at)
    if n_alarms > 0:
        factors.append(_mk_factor(
            "alarm_activity", cfg.weights.get("alarm_activity", 0.0),
            clamp01(n_alarms / 5.0), 1.0,
            observed=n_alarms, params={"count": n_alarms},
            reason="alarm_activity",
        ))

    # ── L4: reliability (MTBF % consumed) ────────────────────────────────────
    mtbf = await mtbf_signals(db, equipment.id, at)
    mtbf_pct = mtbf.get("pct_consumed") if mtbf else None
    if mtbf_pct is not None:
        val = clamp01((mtbf_pct - 70.0) / 60.0)
        if val > 0:
            factors.append(_mk_factor(
                "mtbf_consumed", cfg.weights.get("mtbf_consumed", 0.0), val, 1.0,
                observed=round(mtbf_pct, 1), expected=100.0, unit="%",
                params={"pct": round(mtbf_pct, 1),
                        "hours_since_last": mtbf["hours_since_last"],
                        "mtbf_h": mtbf["mtbf_hist_h"]},
                reason="mtbf_consumed",
            ))
    # Failures getting closer together: recent MTBF meaningfully below history.
    if mtbf and mtbf.get("trend") is not None:
        val = clamp01((1.0 - mtbf["trend"] - 0.15) / 0.45)   # 0.85→0, 0.40→1
        if val > 0:
            factors.append(_mk_factor(
                "mtbf_declining", cfg.weights.get("mtbf_declining", 0.0), val, 1.0,
                observed=mtbf["mtbf_recent_h"], expected=mtbf["mtbf_hist_h"], unit="h",
                params={"recent_h": mtbf["mtbf_recent_h"], "hist_h": mtbf["mtbf_hist_h"],
                        "trend": mtbf["trend"]},
                reason="mtbf_declining",
            ))

    # ── L5: pattern similarity vs pre-failure fingerprints ───────────────────
    # Only fingerprints of failures that happened BEFORE the evaluated instant:
    # a live run sees everything, a backtest replay must not peek at the future
    # (no temporal leakage — the replayed failures' own signatures don't count).
    patterns = (await db.execute(
        select(FailurePattern)
        .join(FailureEvent, FailureEvent.id == FailurePattern.failure_event_id)
        .where(
            FailurePattern.equipment_id == equipment.id,
            FailureEvent.started_at < at,
        )
    )).scalars().all()
    matched_events: list = []
    if patterns:
        current_by_window: dict[float, dict] = {}
        for wh in {float(p.window_hours) for p in patterns}:
            cur: dict[str, dict] = {}
            for code, buckets in series.items():
                if not _usable(code):
                    continue
                f = window_features(buckets, at - timedelta(hours=wh), at)
                if f:
                    cur[code] = f
            current_by_window[wh] = cur
        by_event: dict = {}
        for p in patterns:
            d = pattern_distance(current_by_window.get(float(p.window_hours), {}), p.features or {}, baselines)
            if d is None:
                continue
            prev = by_event.get(p.failure_event_id)
            if prev is None or d < prev:
                by_event[p.failure_event_id] = d
        total = len(by_event)
        matched_events = [eid for eid, d in by_event.items() if d < 1.0]
        if total >= 1 and matched_events:
            # Graduated confidence: matching the single known prior failure is
            # meaningful but weaker evidence than matching a recurring library,
            # so one reference event carries half weight, two or more full.
            val = clamp01(len(matched_events) / total) * clamp01(total / 2.0)
            factors.append(_mk_factor(
                "pattern_similarity", cfg.weights.get("pattern_similarity", 0.0), val, 1.0,
                observed=len(matched_events), expected=total,
                params={"matched": len(matched_events), "total": total},
                reason="similar_pattern",
            ))

    # ── L0: configurable rules ───────────────────────────────────────────────
    for rule in rules:
        obs = await _rule_observation(db, rule, machine, series, at)
        if obs is None:
            continue
        hit = obs > rule.threshold if rule.operator == "gt" else obs < rule.threshold
        if hit:
            factors.append(_mk_factor(
                "rule_triggered", cfg.weights.get(f"rule_{rule.severity}", 20.0), 1.0, 1.0,
                observed=round(obs, 2), expected=rule.threshold,
                params={"name": rule.name, "metric": rule.metric_key,
                        "severity": rule.severity, "window_h": rule.window_hours},
                reason="rule_triggered",
            ))

    # ── Compose ──────────────────────────────────────────────────────────────
    score = compose_score(factors, equipment.criticality)
    level = level_for(score, cfg.levels) if sensors or factors else "no_data"

    core_avail = sum(cfg.weights.get(f["code"], 0.0) for f in factors if f["code"] in CORE_FACTORS)
    core_possible = sum(cfg.weights.get(c, 0.0) for c in CORE_FACTORS) or 1.0
    valid_bases = sum(
        1 for s in sensors if baseline_for(baselines, s.code, context) is not None
    )
    baseline_frac = valid_bases / len(sensors) if sensors else 0.0
    has_op_baselines = any(
        baseline_for(baselines, m, "all" if m != METRIC_PRODUCTION else "run") is not None
        for m in (METRIC_MICROSTOPS, METRIC_STOP_MINUTES, METRIC_PRODUCTION)
    )
    if sensors:
        # Availability counts factors that COULD have fired (signals present), so a
        # healthy machine keeps decent confidence: blend quality + baseline coverage.
        confidence = clamp01(0.55 * quality_score + 0.30 * baseline_frac + 0.15 * min(1.0, core_avail / core_possible + 0.5))
    else:
        # Operational-only machine (no condition sensors): confidence comes from
        # kiosk-data coverage + failure-history depth, capped — the platform never
        # claims sensor-grade certainty it doesn't have.
        op_cov = 1.0 if (has_op_baselines or (stops or {}).get("stops", 0) > 0) else (0.5 if machine else 0.0)
        hist_depth = min(1.0, (mtbf.get("failures_365d", 0) if mtbf else 0) / 4.0)
        confidence = min(0.75, clamp01(0.35 * op_cov + 0.30 * (1.0 if has_op_baselines else 0.0) + 0.35 * hist_depth))

    maturity = _maturity(sensors, feats_med, baseline_frac, has_op_data=has_op_baselines or machine is not None)

    snapshot = {
        "equipment_id": str(equipment.id),
        "ts": at.isoformat(),
        "score": score,
        "level": level,
        "context": context,
        "factors": factors,
        "data_quality": quality_findings,
        "quality_score": round(quality_score, 2),
        "confidence": round(confidence, 2),
        "mtbf": mtbf,
        "mtbf_pct": mtbf_pct,
        "maturity": maturity,
        "matched_failure_events": [str(e) for e in matched_events],
        "engine_version": ENGINE_VERSION,
        "config_version": cfg.version,
    }

    if persist:
        db.add(PredictiveHealthSnapshot(
            equipment_id=equipment.id, plant_id=equipment.plant_id, ts=at,
            score=score, level=level, context_key=context, factors=factors,
            data_quality=quality_findings, quality_score=quality_score,
            confidence=confidence, mtbf_pct=mtbf_pct, maturity=maturity,
            engine_version=ENGINE_VERSION, config_version=cfg.version,
        ))
        await db.flush()
    return snapshot


async def _rule_observation(
    db: AsyncSession, rule: PredictiveRule, machine, series: dict, at: datetime,
) -> Optional[float]:
    since = at - timedelta(hours=float(rule.window_hours or 1))
    if rule.metric_key == METRIC_MICROSTOPS or rule.metric_key == "microstops":
        if machine is None:
            return None
        st = await stop_stats(db, machine.id, since, at)
        return float(st["microstops"])
    if rule.metric_key == "stop_minutes":
        if machine is None:
            return None
        st = await stop_stats(db, machine.id, since, at)
        return float(st["stop_minutes"])
    if rule.metric_key == METRIC_PRODUCTION or rule.metric_key == "production_rate":
        if machine is None:
            return None
        pr = await production_rate(db, machine.id, since, at)
        return float(pr["rate"]) if pr else None
    buckets = series.get(rule.metric_key)
    if buckets is None:
        return None
    f = window_features(buckets, since, at)
    if f is None:
        return None
    return {
        "avg": f["avg"], "max": f["max"], "min": f["min"],
        "last": f["last"], "slope": f["slope_per_hour"], "count": float(f["n"]),
    }.get(rule.aggregation, f["avg"])


def _maturity(sensors, feats_med, baseline_frac: float, *, has_op_data: bool = False) -> str:
    if not sensors:
        # No condition sensors: operational/reliability layers only.
        return "rules_monitoring" if has_op_data else "no_data"
    if all(f is None for f in feats_med.values()):
        return "collecting"
    if baseline_frac <= 0:
        return "baseline_building"
    return "anomaly_active"


# ─── Alert manager ─────────────────────────────────────────────────────────────

def top_kind(factors: list[dict]) -> str:
    active = [f for f in factors if f["contribution"] > 0]
    if not active:
        return "general"
    return max(active, key=lambda f: f["contribution"])["family"]


def build_reasons(factors: list[dict], limit: int = 6) -> list[dict]:
    picked = sorted(
        (f for f in factors if f["value"] > 0.05 and f.get("reason")),
        key=lambda f: f["contribution"], reverse=True,
    )[:limit]
    return [{
        "code": f["reason"], "params": f["params"],
        "observed": f["observed"], "expected": f["expected"], "unit": f["unit"],
    } for f in picked]


async def _probable_from_patterns(db: AsyncSession, matched_ids: list) -> tuple[Optional[str], Optional[str]]:
    if not matched_ids:
        return None, None
    rows = (await db.execute(
        select(FailureEvent.component, FailureEvent.failure_type)
        .where(FailureEvent.id.in_(matched_ids))
    )).all()
    comps = Counter(r.component for r in rows if r.component)
    types = Counter(r.failure_type for r in rows if r.failure_type)
    return (comps.most_common(1)[0][0] if comps else None,
            types.most_common(1)[0][0] if types else None)


async def recent_levels(db: AsyncSession, equipment_id, n: int) -> list[str]:
    rows = (await db.execute(
        select(PredictiveHealthSnapshot.level, PredictiveHealthSnapshot.score)
        .where(PredictiveHealthSnapshot.equipment_id == equipment_id)
        .order_by(PredictiveHealthSnapshot.ts.desc())
        .limit(n)
    )).all()
    return [(r.level, r.score) for r in rows]


async def process_alerts(
    db: AsyncSession,
    equipment: Equipment,
    machine: Optional[Machine],
    cfg: EffectiveConfig,
    snapshot: dict,
) -> Optional[PredictiveAlert]:
    """Alert lifecycle for one fresh (persisted) snapshot. Returns the alert
    created/updated, if any."""
    at = datetime.fromisoformat(snapshot["ts"])
    levels = cfg.levels
    alert_thr = levels.get("alert", 50.0)
    watch_thr = levels.get("watch", 25.0)
    deadband = levels.get("deadband", 5.0)

    open_alerts = (await db.execute(
        select(PredictiveAlert).where(
            PredictiveAlert.equipment_id == equipment.id,
            PredictiveAlert.resolved_at.is_(None),
            PredictiveAlert.status.in_(OPEN_STATUSES),
        )
    )).scalars().all()

    history = await recent_levels(db, equipment.id, cfg.persistence_evals)

    # Auto-close: score comfortably back under the watch band (hysteresis) for
    # the whole persistence horizon → alerts still untouched by a human close.
    if open_alerts and history and all(s < watch_thr - deadband for _, s in history):
        for a in open_alerts:
            if a.status in (PredictiveAlertStatus.new, PredictiveAlertStatus.monitoring):
                a.status = PredictiveAlertStatus.closed
                a.auto_resolved = True
                a.resolved_at = at
        return None

    sustained = (
        len(history) >= cfg.persistence_evals
        and all(s >= alert_thr for _, s in history[: cfg.persistence_evals])
    )
    if not sustained:
        return None

    kind = top_kind(snapshot["factors"])
    reasons = build_reasons(snapshot["factors"])
    live = next((a for a in open_alerts), None)
    if live is not None:
        live.score = snapshot["score"]
        live.level = snapshot["level"]
        live.reasons = reasons
        live.confidence = snapshot["confidence"]
        live.updated_at = at
        return live

    # ── Suppression gates for NEW alerts ─────────────────────────────────────
    status = getattr(machine, "current_status", None)
    status = status.value if hasattr(status, "value") else status
    if status in ("intervention", "maintenance"):
        return None
    if (snapshot.get("quality_score") or 0.0) < 0.3:
        return None
    if (snapshot.get("confidence") or 0.0) < cfg.confidence_floor:
        return None
    cooldown_cut = at - timedelta(hours=cfg.cooldown_hours)
    recent_same = (await db.execute(
        select(PredictiveAlert.id).where(
            PredictiveAlert.equipment_id == equipment.id,
            PredictiveAlert.kind == kind,
            PredictiveAlert.created_at > cooldown_cut,
        ).limit(1)
    )).scalar_one_or_none()
    if recent_same is not None:
        return None

    component, failure_type = await _probable_from_patterns(
        db, snapshot.get("matched_failure_events") or [])
    alert = PredictiveAlert(
        equipment_id=equipment.id,
        machine_id=machine.id if machine else None,
        plant_id=equipment.plant_id,
        level=snapshot["level"], score=snapshot["score"], kind=kind,
        probable_component=component, probable_failure=failure_type,
        reasons=reasons,
        sensors_involved=sorted({
            f["params"].get("sensor") for f in snapshot["factors"] if f["params"].get("sensor")
        }),
        window_hours=cfg.windows.get("long_h", 24.0),
        confidence=snapshot["confidence"],
        recommendation=RECOMMENDATIONS.get(kind, RECOMMENDATIONS["general"]),
        silent=cfg.mode in ("silent", "admin"),
        engine_version=ENGINE_VERSION, config_version=cfg.version,
    )
    db.add(alert)
    await db.flush()
    if cfg.mode == "active":
        await _notify_alert(db, equipment, machine, alert)
    return alert


def _reason_fr(r: dict) -> str:
    tpl = _REASON_FR.get(r.get("code"), r.get("code") or "")
    params = {**(r.get("params") or {}), "unit": r.get("unit") or ""}
    try:
        return tpl.format(**{k: (v if v is not None else "—") for k, v in params.items()})
    except (KeyError, IndexError):
        return tpl


async def _notify_alert(db: AsyncSession, equipment, machine, alert: PredictiveAlert) -> None:
    """Teams card (best effort, never fatal) + notification_logs audit row."""
    from app.core.config import settings as app_settings
    from app.services.notification_service import (
        build_teams_payload, get_escalation_settings, teams_channel_on,
    )
    try:
        esc = await get_escalation_settings(db, equipment.plant_id)
        url = teams_channel_on(esc)
        title = f"Prédictif — risque {alert.level} : {equipment.name}"
        lines = [
            f"Machine: {machine.name if machine else equipment.name}",
            f"Score: {alert.score:.0f}/100",
            f"Confiance: {round((alert.confidence or 0) * 100)}%",
        ] + [_reason_fr(r) for r in (alert.reasons or [])[:4]]
        base = (app_settings.PUBLIC_BASE_URL or "").strip().rstrip("/")
        link = f"{base}/predictive" if base else None
        status = "skipped"
        if url:
            payload = build_teams_payload(
                title, lines, link,
                accent="attention" if alert.level == "critical" else "warning",
            )
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload)
            status = "sent" if resp.status_code < 300 else f"error_{resp.status_code}"
        db.add(NotificationLog(
            notification_type="predictive_teams",
            recipient_role="maintenance",
            message=title,
            status=status,
        ))
    except Exception:
        log.exception("predictive notification failed (evaluation unaffected)")
