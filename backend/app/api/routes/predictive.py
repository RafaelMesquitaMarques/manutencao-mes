"""Predictive intelligence API — dashboard, machine health, alerts + feedback,
settings/rules (runtime-tunable thresholds), backtesting, failure labeling.

All queries are plant-scoped. Visibility follows the activation ladder:
mode `silent` → admins only; `admin` → supervisor+; `active` → anyone with the
`predictive` resource. Settings/rules writes take a supervisor+ role floor on
top of the resource guard.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func as sa_func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_scoped
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import (
    Equipment,
    FailureEvent,
    Machine,
    MachineBaseline,
    PredictiveAlert,
    PredictiveAlertFeedback,
    PredictiveAlertStatus,
    PredictiveHealthSnapshot,
    PredictiveMachineSettings,
    PredictiveMode,
    PredictiveRule,
    User,
    UserRole,
)
from app.schemas.predictive import (
    AlertStatusUpdate,
    BacktestRequest,
    FailureConfirm,
    FeedbackCreate,
    MachineSettingsUpdate,
    RuleCreate,
    RuleUpdate,
    SettingsUpdate,
)
from app.services.predictive.backtest import run_backtest
from app.services.predictive.config import (
    DEFAULT_FP_WINDOWS,
    DEFAULT_LEVELS,
    DEFAULT_WEIGHTS,
    DEFAULT_WINDOWS,
    effective_config,
    get_machine_settings,
    get_plant_settings,
    log_config_change,
)
from app.services.predictive.engine import evaluate_equipment, process_alerts
from app.services.predictive.failure_sync import sync_failure_events
from app.services.predictive.reliability import mtbf_signals

log = logging.getLogger("predictive")
router = APIRouter()

_MANAGER_ROLES = (
    UserRole.supervisor, UserRole.maintenance_director,
    UserRole.plant_manager, UserRole.director, UserRole.admin,
)

_ADMIN_ONLY = (UserRole.admin,)


def _mode_visible(user: User, mode: str) -> bool:
    """Activation-ladder visibility (silent → admin only; admin → supervisor+)."""
    from app.services.predictive.config import mode_visible_for
    return mode_visible_for(user.role, mode)


def _require_manager(user: User) -> None:
    if user.role not in _MANAGER_ROLES:
        raise HTTPException(status_code=403, detail="predictive_manager_required")


async def _scoped_equipment(db: AsyncSession, equipment_id: UUID, ctx: PlantContext) -> Equipment:
    eq = await db.get(Equipment, equipment_id)
    return ensure_same_plant(eq, ctx, detail="equipment_not_found")


async def _scoped_alert(db: AsyncSession, alert_id: UUID, ctx: PlantContext) -> PredictiveAlert:
    a = await db.get(PredictiveAlert, alert_id)
    return ensure_same_plant(a, ctx, detail="alert_not_found")


def _alert_out(a: PredictiveAlert, equipment_name: Optional[str] = None) -> dict:
    return {
        "id": str(a.id),
        "equipment_id": str(a.equipment_id),
        "equipment_name": equipment_name,
        "machine_id": str(a.machine_id) if a.machine_id else None,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
        "level": a.level, "score": a.score, "kind": a.kind,
        "probable_component": a.probable_component,
        "probable_failure": a.probable_failure,
        "reasons": a.reasons or [],
        "sensors_involved": a.sensors_involved or [],
        "window_hours": a.window_hours,
        "confidence": a.confidence,
        "recommendation": a.recommendation,
        "silent": bool(a.silent),
        "status": a.status.value if hasattr(a.status, "value") else a.status,
        "assigned_to_id": str(a.assigned_to_id) if a.assigned_to_id else None,
        "inspection_due": a.inspection_due.isoformat() if a.inspection_due else None,
        "inspection_result": a.inspection_result,
        "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
        "auto_resolved": bool(a.auto_resolved),
        "ticket_id": str(a.ticket_id) if a.ticket_id else None,
        "engine_version": a.engine_version,
        "config_version": a.config_version,
        "feedback_count": len(a.feedback) if "feedback" in a.__dict__ else None,
    }


# ─── Dashboard ─────────────────────────────────────────────────────────────────

@router.get("/overview")
async def overview(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    settings = await get_plant_settings(db, ctx.plant_id)
    mode = settings.mode.value if settings and hasattr(settings.mode, "value") else (settings.mode if settings else "off")
    if not _mode_visible(user, mode or "off"):
        return {"mode": mode or "off", "visible": False, "machines": [], "kpis": {}}

    latest = (await db.execute(
        select(PredictiveHealthSnapshot)
        .where(PredictiveHealthSnapshot.plant_id == ctx.plant_id)
        .distinct(PredictiveHealthSnapshot.equipment_id)
        .order_by(PredictiveHealthSnapshot.equipment_id, PredictiveHealthSnapshot.ts.desc())
    )).scalars().all()

    eq_ids = [s.equipment_id for s in latest]
    eq_rows = (await db.execute(
        select(Equipment).where(Equipment.id.in_(eq_ids or [None]))
    )).scalars().all()
    eq_by_id = {e.id: e for e in eq_rows}

    open_alerts = (await db.execute(
        plant_scoped(select(PredictiveAlert), PredictiveAlert, ctx)
        .where(PredictiveAlert.resolved_at.is_(None))
    )).scalars().all()
    open_by_eq: dict = {}
    for a in open_alerts:
        open_by_eq.setdefault(a.equipment_id, 0)
        open_by_eq[a.equipment_id] += 1

    machines = []
    for s in latest:
        eq = eq_by_id.get(s.equipment_id)
        if eq is None:
            continue
        machines.append({
            "equipment_id": str(s.equipment_id),
            "name": eq.name, "code": eq.code,
            "department": eq.department, "family": eq.family,
            "criticality": eq.criticality,
            "score": s.score, "level": s.level,
            "confidence": s.confidence, "quality_score": s.quality_score,
            "mtbf_pct": s.mtbf_pct, "maturity": s.maturity,
            "context": s.context_key,
            "ts": s.ts.isoformat() if s.ts else None,
            "open_alerts": open_by_eq.get(s.equipment_id, 0),
        })
    machines.sort(key=lambda m: m["score"], reverse=True)

    since_30d = datetime.now(timezone.utc) - timedelta(days=30)
    fb = (await db.execute(
        select(
            sa_func.count(PredictiveAlertFeedback.id).filter(PredictiveAlertFeedback.was_correct.is_(True)),
            sa_func.count(PredictiveAlertFeedback.id).filter(PredictiveAlertFeedback.was_correct.is_(False)),
            sa_func.count(PredictiveAlertFeedback.id).filter(PredictiveAlertFeedback.prevented_breakdown.is_(True)),
        ).where(
            PredictiveAlertFeedback.plant_id == ctx.plant_id,
            PredictiveAlertFeedback.created_at > since_30d,
        )
    )).one()

    inspections = (await db.execute(
        plant_scoped(select(PredictiveAlert), PredictiveAlert, ctx)
        .where(PredictiveAlert.inspection_due.isnot(None), PredictiveAlert.resolved_at.is_(None))
        .order_by(PredictiveAlert.inspection_due)
        .limit(10)
    )).scalars().all()

    sensor_problems = sum(
        1 for s in latest
        for f in (s.data_quality or {}).values()
        if f.get("status") in ("faulty", "no_data")
    )

    return {
        "mode": mode or "off",
        "visible": True,
        "machines": machines,
        "kpis": {
            "machines_tracked": len(machines),
            "machines_critical": sum(1 for m in machines if m["level"] == "critical"),
            "machines_alert": sum(1 for m in machines if m["level"] == "alert"),
            "machines_insufficient": sum(1 for m in machines if m["maturity"] in ("no_data", "collecting", "baseline_building")),
            "alerts_open": len(open_alerts),
            "alerts_new": sum(1 for a in open_alerts if a.status == PredictiveAlertStatus.new),
            "avg_confidence": round(
                sum(m["confidence"] or 0 for m in machines) / len(machines), 2
            ) if machines else None,
            "feedback_confirmed_30d": int(fb[0]),
            "feedback_false_positive_30d": int(fb[1]),
            "breakdowns_prevented_30d": int(fb[2]),
            "sensor_problems": sensor_problems,
        },
        "next_inspections": [
            {"alert_id": str(a.id), "equipment_id": str(a.equipment_id),
             "due": a.inspection_due.isoformat(), "level": a.level, "kind": a.kind}
            for a in inspections
        ],
    }


# ─── Machine health detail ─────────────────────────────────────────────────────

@router.get("/machines/{equipment_id}")
async def machine_health(
    equipment_id: UUID,
    hours: int = Query(168, ge=6, le=2160),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    eq = await _scoped_equipment(db, equipment_id, ctx)
    settings = await get_plant_settings(db, ctx.plant_id)
    machine_settings = await get_machine_settings(db, eq.id)
    cfg = effective_config(settings, machine_settings)
    if not _mode_visible(user, cfg.mode):
        return {"mode": cfg.mode, "visible": False}

    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    snaps = (await db.execute(
        select(PredictiveHealthSnapshot)
        .where(
            PredictiveHealthSnapshot.equipment_id == eq.id,
            PredictiveHealthSnapshot.ts > since,
        )
        .order_by(PredictiveHealthSnapshot.ts)
    )).scalars().all()
    latest = snaps[-1] if snaps else None

    baselines = (await db.execute(
        select(MachineBaseline).where(MachineBaseline.equipment_id == eq.id)
    )).scalars().all()

    alerts = (await db.execute(
        select(PredictiveAlert)
        .where(PredictiveAlert.equipment_id == eq.id)
        .order_by(PredictiveAlert.created_at.desc())
        .limit(20)
    )).scalars().all()

    mtbf = await mtbf_signals(db, eq.id)

    return {
        "mode": cfg.mode,
        "visible": True,
        "equipment": {
            "id": str(eq.id), "name": eq.name, "code": eq.code,
            "criticality": eq.criticality, "family": eq.family,
            "department": eq.department,
        },
        "latest": {
            "ts": latest.ts.isoformat(),
            "score": latest.score, "level": latest.level,
            "context": latest.context_key,
            "factors": latest.factors or [],
            "data_quality": latest.data_quality or {},
            "quality_score": latest.quality_score,
            "confidence": latest.confidence,
            "mtbf_pct": latest.mtbf_pct,
            "maturity": latest.maturity,
            "engine_version": latest.engine_version,
            "config_version": latest.config_version,
        } if latest else None,
        "history": [
            {"ts": s.ts.isoformat(), "score": s.score, "level": s.level,
             "confidence": s.confidence, "mtbf_pct": s.mtbf_pct}
            for s in snaps
        ],
        "baselines": [
            {"metric_key": b.metric_key, "context_key": b.context_key,
             "unit": b.unit, "n_samples": b.n_samples,
             "median": b.median, "mad": b.mad, "mean": b.mean, "std": b.std,
             "p05": b.p05, "p95": b.p95, "valid": bool(b.valid),
             "frozen": bool(b.frozen), "version": b.version,
             "computed_at": b.computed_at.isoformat() if b.computed_at else None}
            for b in baselines
        ],
        "alerts": [_alert_out(a) for a in alerts],
        "mtbf": mtbf,
        "machine_settings": {
            "enabled": machine_settings.enabled if machine_settings else None,
            "mode": (machine_settings.mode.value if hasattr(machine_settings.mode, "value") else machine_settings.mode)
                    if machine_settings and machine_settings.mode else None,
        },
    }


@router.post("/machines/{equipment_id}/evaluate")
async def evaluate_now(
    equipment_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    """On-demand evaluation (manager action) — same code path as the cron."""
    _require_manager(user)
    eq = await _scoped_equipment(db, equipment_id, ctx)
    settings = await get_plant_settings(db, ctx.plant_id)
    cfg = effective_config(settings, await get_machine_settings(db, eq.id))
    if cfg.mode == "off":
        raise HTTPException(status_code=400, detail="predictive_mode_off")
    machine = (await db.execute(
        select(Machine).where(Machine.equipment_id == eq.id).limit(1)
    )).scalar_one_or_none()
    snap = await evaluate_equipment(db, eq, cfg, machine=machine)
    await process_alerts(db, eq, machine, cfg, snap)
    await db.commit()
    return snap


# ─── Alerts ────────────────────────────────────────────────────────────────────

@router.get("/alerts")
async def list_alerts(
    status: Optional[str] = None,
    level: Optional[str] = None,
    kind: Optional[str] = None,
    equipment_id: Optional[UUID] = None,
    open_only: bool = False,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    settings = await get_plant_settings(db, ctx.plant_id)
    mode = (settings.mode.value if settings and hasattr(settings.mode, "value") else "off") if settings else "off"
    if not _mode_visible(user, mode):
        return {"total": 0, "items": [], "mode": mode, "visible": False}

    stmt = plant_scoped(select(PredictiveAlert), PredictiveAlert, ctx)
    if status:
        stmt = stmt.where(PredictiveAlert.status == status)
    if level:
        stmt = stmt.where(PredictiveAlert.level == level)
    if kind:
        stmt = stmt.where(PredictiveAlert.kind == kind)
    if equipment_id:
        stmt = stmt.where(PredictiveAlert.equipment_id == equipment_id)
    if open_only:
        stmt = stmt.where(PredictiveAlert.resolved_at.is_(None))
    total = (await db.execute(
        select(sa_func.count()).select_from(stmt.subquery())
    )).scalar_one()
    rows = (await db.execute(
        stmt.order_by(PredictiveAlert.created_at.desc()).limit(limit).offset(offset)
    )).scalars().all()

    names = {
        e.id: e.name for e in (await db.execute(
            select(Equipment).where(Equipment.id.in_({a.equipment_id for a in rows} or {None}))
        )).scalars().all()
    }
    return {
        "total": total, "mode": mode, "visible": True,
        "items": [_alert_out(a, names.get(a.equipment_id)) for a in rows],
    }


@router.get("/alerts/{alert_id}")
async def alert_detail(
    alert_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    a = await _scoped_alert(db, alert_id, ctx)
    eq = await db.get(Equipment, a.equipment_id)
    fb = (await db.execute(
        select(PredictiveAlertFeedback).where(PredictiveAlertFeedback.alert_id == a.id)
        .order_by(PredictiveAlertFeedback.created_at)
    )).scalars().all()
    out = _alert_out(a, eq.name if eq else None)
    out["feedback"] = [{
        "id": str(f.id), "was_correct": f.was_correct, "problem_found": f.problem_found,
        "component": f.component, "failure_mode": f.failure_mode, "cause": f.cause,
        "timing": f.timing, "action_taken": f.action_taken,
        "part_replaced": f.part_replaced, "prevented_breakdown": f.prevented_breakdown,
        "back_to_normal": f.back_to_normal, "comments": f.comments,
        "created_at": f.created_at.isoformat() if f.created_at else None,
    } for f in fb]
    return out


@router.patch("/alerts/{alert_id}/status")
async def update_alert_status(
    alert_id: UUID,
    body: AlertStatusUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    a = await _scoped_alert(db, alert_id, ctx)
    a.status = PredictiveAlertStatus(body.status)
    if body.assigned_to_id is not None:
        a.assigned_to_id = body.assigned_to_id
    if body.inspection_due is not None:
        a.inspection_due = body.inspection_due
    if body.inspection_result is not None:
        a.inspection_result = body.inspection_result
    if body.status in ("closed", "false_positive", "intervention_done") and a.resolved_at is None:
        a.resolved_at = datetime.now(timezone.utc)
    await db.commit()
    return _alert_out(a)


@router.post("/alerts/{alert_id}/feedback", status_code=201)
async def add_feedback(
    alert_id: UUID,
    body: FeedbackCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    a = await _scoped_alert(db, alert_id, ctx)
    fb = PredictiveAlertFeedback(
        alert_id=a.id, plant_id=a.plant_id,
        created_by_id=user.id,
        **body.model_dump(exclude_unset=True),
    )
    db.add(fb)
    if body.was_correct is False and a.status in (
        PredictiveAlertStatus.new, PredictiveAlertStatus.in_review, PredictiveAlertStatus.monitoring,
    ):
        a.status = PredictiveAlertStatus.false_positive
        a.resolved_at = a.resolved_at or datetime.now(timezone.utc)
    await db.commit()
    return {"id": str(fb.id), "alert_id": str(a.id)}


@router.post("/alerts/{alert_id}/ticket", status_code=201)
async def create_inspection_ticket(
    alert_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    """Explicit human action — the engine never opens tickets on its own."""
    from app.models.models import AlertPriority, AlertProblemType
    from app.schemas.maintenance import TicketCreate
    from app.services.ticket_service import DuplicateTicketError, TicketService

    a = await _scoped_alert(db, alert_id, ctx)
    if a.ticket_id is not None:
        raise HTTPException(status_code=409, detail="predictive_ticket_exists")
    eq = await db.get(Equipment, a.equipment_id)
    data = TicketCreate(
        machine_id=a.equipment_id,   # create_ticket resolves equipment → machine
        priority=AlertPriority.high if a.level == "critical" else AlertPriority.medium,
        problem_type=AlertProblemType.other,
        description=(
            f"Inspection prédictive — {eq.name if eq else ''}: risque {a.level} "
            f"(score {a.score:.0f}/100, confiance {round((a.confidence or 0) * 100)}%). "
            f"Composant probable: {a.probable_component or '—'}."
        ),
        machine_stopped=False,
    )
    try:
        ticket = await TicketService(db).create_ticket(
            data, created_by=user.name or "Prédictif", notify=False,
        )
    except DuplicateTicketError as e:
        raise HTTPException(status_code=409, detail="predictive_ticket_duplicate") from e
    a.ticket_id = ticket.id
    if a.status == PredictiveAlertStatus.new:
        a.status = PredictiveAlertStatus.inspection_planned
    await db.commit()
    return {"ticket_id": str(ticket.id), "ticket_number": ticket.ticket_number}


# ─── Settings & rules ──────────────────────────────────────────────────────────

@router.get("/settings")
async def get_settings(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    settings = await get_plant_settings(db, ctx.plant_id)
    machine_rows = (await db.execute(
        select(PredictiveMachineSettings).where(PredictiveMachineSettings.plant_id == ctx.plant_id)
    )).scalars().all()
    return {
        "plant": {
            "mode": (settings.mode.value if hasattr(settings.mode, "value") else settings.mode) if settings else "off",
            "eval_interval_min": settings.eval_interval_min if settings else 15,
            "baseline_refresh_hours": settings.baseline_refresh_hours if settings else 24,
            "weights": {**DEFAULT_WEIGHTS, **((settings.weights or {}) if settings else {})},
            "levels": {**DEFAULT_LEVELS, **((settings.levels or {}) if settings else {})},
            "windows": {**DEFAULT_WINDOWS, **((settings.windows or {}) if settings else {})},
            "persistence_evals": settings.persistence_evals if settings else 2,
            "cooldown_hours": settings.cooldown_hours if settings else 12.0,
            "confidence_floor": settings.confidence_floor if settings else 0.35,
            "fingerprint_windows_h": (settings.fingerprint_windows_h if settings else None) or DEFAULT_FP_WINDOWS,
            "prefailure_exclude_h": settings.prefailure_exclude_h if settings else 24,
            "baseline_window_days": settings.baseline_window_days if settings else 30,
            "baseline_min_samples": settings.baseline_min_samples if settings else 50,
            "baseline_drift_cap_pct": settings.baseline_drift_cap_pct if settings else 25.0,
            "version": settings.version if settings else 0,
        },
        "machines": [
            {"equipment_id": str(m.equipment_id), "enabled": m.enabled,
             "mode": (m.mode.value if hasattr(m.mode, "value") else m.mode) if m.mode else None,
             "overrides": m.overrides}
            for m in machine_rows
        ],
    }


@router.put("/settings")
async def update_settings(
    body: SettingsUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    _require_manager(user)
    settings = await get_plant_settings(db, ctx.plant_id, create=True)
    data = body.model_dump(exclude_unset=True)
    for key, value in data.items():
        if key == "mode":
            settings.mode = PredictiveMode(value)
        else:
            setattr(settings, key, value)
    settings.version = (settings.version or 1) + 1
    settings.updated_by_id = user.id
    await log_config_change(db, ctx.plant_id, settings.version, {
        "settings": {k: (v if not isinstance(v, PredictiveMode) else v.value) for k, v in data.items()},
    }, user.id)
    await db.commit()
    return {"ok": True, "version": settings.version}


@router.put("/machines/{equipment_id}/settings")
async def update_machine_settings(
    equipment_id: UUID,
    body: MachineSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    _require_manager(user)
    eq = await _scoped_equipment(db, equipment_id, ctx)
    row = await get_machine_settings(db, eq.id)
    if row is None:
        row = PredictiveMachineSettings(equipment_id=eq.id, plant_id=eq.plant_id)
        db.add(row)
    data = body.model_dump(exclude_unset=True)
    if "enabled" in data:
        row.enabled = data["enabled"]
    if "mode" in data:
        row.mode = PredictiveMode(data["mode"]) if data["mode"] else None
    if "overrides" in data:
        row.overrides = data["overrides"]
    settings = await get_plant_settings(db, ctx.plant_id, create=True)
    settings.version = (settings.version or 1) + 1
    await log_config_change(db, ctx.plant_id, settings.version, {
        "machine_settings": {"equipment_id": str(eq.id), **{k: str(v) for k, v in data.items()}},
    }, user.id)
    await db.commit()
    return {"ok": True}


@router.get("/rules")
async def list_rules(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        plant_scoped(select(PredictiveRule), PredictiveRule, ctx).order_by(PredictiveRule.created_at)
    )).scalars().all()
    return {"items": [{
        "id": str(r.id), "name": r.name,
        "equipment_id": str(r.equipment_id) if r.equipment_id else None,
        "metric_key": r.metric_key, "aggregation": r.aggregation,
        "window_hours": r.window_hours, "operator": r.operator,
        "threshold": r.threshold, "severity": r.severity, "enabled": r.enabled,
    } for r in rows]}


@router.post("/rules", status_code=201)
async def create_rule(
    body: RuleCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    _require_manager(user)
    if body.equipment_id:
        await _scoped_equipment(db, body.equipment_id, ctx)
    rule = PredictiveRule(plant_id=ctx.plant_id, **body.model_dump())
    db.add(rule)
    await db.commit()
    return {"id": str(rule.id)}


@router.patch("/rules/{rule_id}")
async def update_rule(
    rule_id: UUID,
    body: RuleUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    _require_manager(user)
    rule = ensure_same_plant(await db.get(PredictiveRule, rule_id), ctx, detail="rule_not_found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(rule, k, v)
    await db.commit()
    return {"ok": True}


@router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    _require_manager(user)
    rule = ensure_same_plant(await db.get(PredictiveRule, rule_id), ctx, detail="rule_not_found")
    await db.delete(rule)
    await db.commit()


# ─── Backtest & failure labeling ───────────────────────────────────────────────

@router.post("/backtest")
async def backtest(
    body: BacktestRequest,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    _require_manager(user)
    eq = await _scoped_equipment(db, body.equipment_id, ctx)
    settings = await get_plant_settings(db, ctx.plant_id)
    cfg = effective_config(settings, await get_machine_settings(db, eq.id))
    try:
        return await run_backtest(db, eq, cfg, body.start, body.end, body.step_min)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/failures")
async def list_failures(
    days: int = Query(90, ge=1, le=1460),
    equipment_id: Optional[UUID] = None,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    stmt = plant_scoped(select(FailureEvent), FailureEvent, ctx).where(FailureEvent.started_at > since)
    if equipment_id:
        stmt = stmt.where(FailureEvent.equipment_id == equipment_id)
    rows = (await db.execute(stmt.order_by(FailureEvent.started_at.desc()).limit(500))).scalars().all()
    names = {
        e.id: e.name for e in (await db.execute(
            select(Equipment).where(Equipment.id.in_({f.equipment_id for f in rows} or {None}))
        )).scalars().all()
    }
    return {"items": [{
        "id": str(f.id), "equipment_id": str(f.equipment_id),
        "equipment_name": names.get(f.equipment_id),
        "source": f.source.value if hasattr(f.source, "value") else f.source,
        "started_at": f.started_at.isoformat(),
        "ended_at": f.ended_at.isoformat() if f.ended_at else None,
        "failure_type": f.failure_type, "component": f.component,
        "severity": f.severity, "confirmed": bool(f.confirmed), "notes": f.notes,
    } for f in rows]}


@router.post("/failures/sync")
async def failures_sync(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    _require_manager(user)
    created = await sync_failure_events(db, plant_id=ctx.plant_id)
    await db.commit()
    return {"created": created}


@router.post("/failures/{failure_id}/confirm")
async def confirm_failure(
    failure_id: UUID,
    body: FailureConfirm,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(get_current_user),
):
    f = ensure_same_plant(await db.get(FailureEvent, failure_id), ctx, detail="failure_not_found")
    f.confirmed = body.confirmed
    if body.component is not None:
        f.component = body.component
    if body.failure_type is not None:
        f.failure_type = body.failure_type
    if body.notes is not None:
        f.notes = body.notes
    await db.commit()
    return {"ok": True}
