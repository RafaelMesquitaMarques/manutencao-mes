"""Backtesting / simulation mode.

Replays a historical period through the SAME evaluation code (no parallel
logic): baselines are built strictly from data BEFORE the replay start (no
leakage), each step only reads data up to its instant, and alert opening is
simulated with the same persistence rule. Output compares would-be alerts with
the real failure_events of the period: detections, lead times, false positives
— the evidence to review before activating a plant.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Equipment, FailureEvent, Machine

from .baseline import build_baselines_for_equipment
from .config import EffectiveConfig
from .engine import build_reasons, evaluate_equipment, top_kind

MAX_SPAN_DAYS = 45
MIN_STEP_MIN = 15
DETECTION_LOOKAHEAD_H = 72.0


async def run_backtest(
    db: AsyncSession,
    equipment: Equipment,
    cfg: EffectiveConfig,
    start: datetime,
    end: datetime,
    step_min: int = 60,
) -> dict:
    start = start if start.tzinfo else start.replace(tzinfo=timezone.utc)
    end = end if end.tzinfo else end.replace(tzinfo=timezone.utc)
    if end <= start:
        raise ValueError("backtest_invalid_range")
    if (end - start) > timedelta(days=MAX_SPAN_DAYS):
        raise ValueError("backtest_range_too_long")
    step_min = max(int(step_min), MIN_STEP_MIN)

    machine = (await db.execute(
        select(Machine).where(Machine.equipment_id == equipment.id).limit(1)
    )).scalar_one_or_none()

    # Baselines frozen at the replay start — never trained on replayed data.
    baselines = await build_baselines_for_equipment(
        db, equipment, cfg, until=start, persist=False,
    )

    alert_thr = cfg.levels.get("alert", 50.0)
    snapshots: list[dict] = []
    sim_alerts: list[dict] = []
    consecutive = 0
    last_alert_at: dict[str, datetime] = {}

    ts = start
    while ts <= end:
        snap = await evaluate_equipment(
            db, equipment, cfg, machine=machine, at=ts,
            baselines=baselines, persist=False,
        )
        snapshots.append({
            "ts": snap["ts"], "score": snap["score"], "level": snap["level"],
            "confidence": snap["confidence"],
        })
        if snap["score"] >= alert_thr:
            consecutive += 1
            if consecutive >= cfg.persistence_evals:
                kind = top_kind(snap["factors"])
                last = last_alert_at.get(kind)
                if last is None or (ts - last) > timedelta(hours=cfg.cooldown_hours):
                    sim_alerts.append({
                        "opened_at": ts.isoformat(), "kind": kind,
                        "level": snap["level"], "score": snap["score"],
                        "confidence": snap["confidence"],
                        "reasons": build_reasons(snap["factors"], limit=4),
                    })
                    last_alert_at[kind] = ts
        else:
            consecutive = 0
        ts += timedelta(minutes=step_min)

    failures = (await db.execute(
        select(FailureEvent).where(
            FailureEvent.equipment_id == equipment.id,
            FailureEvent.started_at > start,
            FailureEvent.started_at <= end,
        ).order_by(FailureEvent.started_at)
    )).scalars().all()

    alert_times = [datetime.fromisoformat(a["opened_at"]) for a in sim_alerts]
    fail_rows = []
    detected = 0
    lead_times: list[float] = []
    for f in failures:
        f_start = f.started_at if f.started_at.tzinfo else f.started_at.replace(tzinfo=timezone.utc)
        prior = [t for t in alert_times
                 if timedelta(0) <= (f_start - t) <= timedelta(hours=DETECTION_LOOKAHEAD_H)]
        lead = max(((f_start - t).total_seconds() / 3600.0 for t in prior), default=None)
        if prior:
            detected += 1
            lead_times.append(lead)
        fail_rows.append({
            "id": str(f.id), "started_at": f_start.isoformat(),
            "failure_type": f.failure_type, "component": f.component,
            "confirmed": bool(f.confirmed),
            "detected": bool(prior), "lead_hours": round(lead, 1) if lead is not None else None,
        })

    false_positives = sum(
        1 for t in alert_times
        if not any(
            timedelta(0) <= (
                (f.started_at if f.started_at.tzinfo else f.started_at.replace(tzinfo=timezone.utc)) - t
            ) <= timedelta(hours=DETECTION_LOOKAHEAD_H)
            for f in failures
        )
    )

    return {
        "equipment_id": str(equipment.id),
        "start": start.isoformat(), "end": end.isoformat(), "step_min": step_min,
        "snapshots": snapshots,
        "alerts": sim_alerts,
        "failures": fail_rows,
        "metrics": {
            "evaluations": len(snapshots),
            "alerts": len(sim_alerts),
            "failures": len(failures),
            "detected": detected,
            "missed": len(failures) - detected,
            "false_positives": false_positives,
            "avg_lead_hours": round(sum(lead_times) / len(lead_times), 1) if lead_times else None,
            "detection_lookahead_h": DETECTION_LOOKAHEAD_H,
        },
    }
