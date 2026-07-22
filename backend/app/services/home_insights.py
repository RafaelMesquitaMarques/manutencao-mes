"""Home "live insights" feed — deterministic anomaly detectors over everything
the platform measures.

Each detector compares a recent window against its own baseline (earlier today,
the trailing days, or a fixed benchmark) and emits structured insights:
``{kind, severity, params, link}``. The frontend renders the sentence via
i18n (``t('insights.<kind>', params)``) — no user-facing prose lives here, per
the project rule that backend strings must be mappable to translations.

Detectors are cheap (a handful of aggregate queries each) and independent: one
failing detector is logged and skipped, never breaking the feed. Every query is
plant-scoped through ``plant_condition``; the caller's view permissions decide
which detectors run at all, so an operator without KPI access never receives
OEE insights.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional
from zoneinfo import ZoneInfo

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import effective_permissions
from app.core.plant_context import PlantContext
from app.core.plant_scope import plant_condition
from app.models.models import (
    AlertStatus,
    Machine,
    MachineIntervention,
    MachineProductionHourly,
    MachineStatus,
    MachineStop,
    MaintenanceAlert,
    MaintenanceTicket,
    Plant,
    StockItem,
    StopCategory,
    StopCategoryType,
    TicketStatus,
    User,
    WorkOrder,
    WorkOrderStatus,
    WorkOrderType,
)

log = logging.getLogger(__name__)

_DEFAULT_TZ = "America/Toronto"
_SEV_RANK = {"critical": 0, "warn": 1, "info": 2, "good": 3}
_MAX_INSIGHTS = 8


@dataclass
class _Snapshot:
    """Shared per-request context so detectors don't re-query the basics."""
    db: AsyncSession
    ctx: PlantContext
    now: datetime                       # aware UTC
    today_start: datetime               # UTC instant of the plant's local midnight
    machines: dict                      # machine_id -> display name (active only)
    statuses: dict                      # machine_id -> MachineStatus value (str)
    open_stops: list                    # (machine_id, started_at, category_type|None)


def _ins(kind: str, severity: str, params: dict, link: Optional[str],
         weight: float = 0.0, machine_id=None) -> dict:
    out: dict[str, Any] = {"kind": kind, "severity": severity,
                           "params": params, "link": link, "weight": weight}
    if machine_id is not None:
        out["machine_id"] = str(machine_id)
    return out


def _minutes(now: datetime, started: datetime) -> int:
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    return max(int((now - started).total_seconds() // 60), 0)


# ─── Production ────────────────────────────────────────────────────────────────

async def _production_rate_drop(s: _Snapshot) -> list[dict]:
    """Per machine: units/h of the last 2 full hours vs the 6 hours before them.
    Only machines currently running are judged — a stopped machine is covered by
    the stop insights, not blamed twice for producing nothing."""
    h0 = s.now.replace(minute=0, second=0, microsecond=0)
    recent_start = h0 - timedelta(hours=2)
    base_start = h0 - timedelta(hours=8)
    rows = (await s.db.execute(
        select(MachineProductionHourly.machine_id, MachineProductionHourly.hour,
               func.sum(MachineProductionHourly.count))
        .join(Machine, MachineProductionHourly.machine_id == Machine.id)
        .where(plant_condition(Machine, s.ctx),
               MachineProductionHourly.hour >= base_start,
               MachineProductionHourly.hour < h0)
        .group_by(MachineProductionHourly.machine_id, MachineProductionHourly.hour)
    )).all()
    by_machine: dict = {}
    for mid, hour, cnt in rows:
        by_machine.setdefault(mid, []).append((hour, int(cnt or 0)))

    out = []
    for mid, buckets in by_machine.items():
        name = s.machines.get(mid)
        if not name or s.statuses.get(mid) != MachineStatus.running.value:
            continue
        recent_total = sum(c for h, c in buckets if h >= recent_start)
        base_counts = [c for h, c in buckets if h < recent_start and c > 0]
        if len(base_counts) < 3:
            continue                     # not enough history earlier today
        base_avg = sum(base_counts) / len(base_counts)
        recent_avg = recent_total / 2.0
        if base_avg < 6 or recent_avg >= base_avg * 0.75:
            continue
        drop = round((1 - recent_avg / base_avg) * 100)
        out.append(_ins(
            "production_rate_drop",
            "critical" if recent_avg <= base_avg * 0.5 else "warn",
            {"machine": name, "drop": drop,
             "recent": round(recent_avg), "baseline": round(base_avg)},
            "/kpis", weight=drop, machine_id=mid,
        ))
    return out


async def _reject_rate_high(s: _Snapshot) -> list[dict]:
    """Per machine: today's reject rate vs the trailing 7 days."""
    async def rates(since, until):
        rows = (await s.db.execute(
            select(MachineProductionHourly.machine_id,
                   func.sum(MachineProductionHourly.count),
                   func.sum(MachineProductionHourly.reject_count))
            .join(Machine, MachineProductionHourly.machine_id == Machine.id)
            .where(plant_condition(Machine, s.ctx),
                   MachineProductionHourly.hour >= since,
                   MachineProductionHourly.hour < until)
            .group_by(MachineProductionHourly.machine_id)
        )).all()
        return {mid: (int(c or 0), int(r or 0)) for mid, c, r in rows}

    today = await rates(s.today_start, s.now)
    base = await rates(s.today_start - timedelta(days=7), s.today_start)
    out = []
    for mid, (cnt, rej) in today.items():
        name = s.machines.get(mid)
        if not name or cnt < 20 or rej < 5:
            continue
        rate = rej / cnt
        b_cnt, b_rej = base.get(mid, (0, 0))
        b_rate = (b_rej / b_cnt) if b_cnt > 0 else 0.0
        if rate < max(0.05, 2 * b_rate):
            continue
        out.append(_ins(
            "reject_rate_high", "warn",
            {"machine": name, "rate": round(rate * 100, 1),
             "baseline": round(b_rate * 100, 1)},
            "/kpis", weight=rate * 100, machine_id=mid,
        ))
    return out


# ─── Stops / downtime ──────────────────────────────────────────────────────────

async def _stop_justification(s: _Snapshot) -> list[dict]:
    """Per machine: share of closed stops in the last 24 h missing a reason.
    Plant-wide "all justified" good news when discipline is perfect."""
    since = s.now - timedelta(hours=24)
    rows = (await s.db.execute(
        select(MachineStop.machine_id,
               func.count(MachineStop.id),
               func.sum(case((MachineStop.stop_category_id.is_(None), 1), else_=0)))
        .where(plant_condition(MachineStop, s.ctx),
               MachineStop.started_at >= since,
               MachineStop.ended_at.isnot(None))
        .group_by(MachineStop.machine_id)
    )).all()
    out = []
    grand_total = grand_unjust = 0
    for mid, total, unjust in rows:
        total, unjust = int(total or 0), int(unjust or 0)
        grand_total += total
        grand_unjust += unjust
        name = s.machines.get(mid)
        if not name or total < 3 or unjust / total < 0.4:
            continue
        pct = round((1 - unjust / total) * 100)
        out.append(_ins(
            "unjustified_stops",
            "critical" if unjust / total >= 0.7 else "warn",
            {"machine": name, "pct": pct, "unjust": unjust, "total": total},
            "/kpis", weight=100 - pct, machine_id=mid,
        ))
    if not out and grand_total >= 3 and grand_unjust == 0:
        out.append(_ins("stops_all_justified", "good",
                        {"total": grand_total}, "/kpis"))
    return out


async def _ongoing_stops(s: _Snapshot) -> list[dict]:
    """Machines stopped right now (open, non-planned stop) for 30+ minutes.
    Stops open for days are stale records (a parked machine, a forgotten
    entry), not live events — they'd drown the feed, so cap at 72 h."""
    candidates = []
    for mid, started, cat_type in s.open_stops:
        name = s.machines.get(mid)
        if not name or cat_type == StopCategoryType.planned:
            continue
        mins = _minutes(s.now, started)
        if mins < 30 or mins > 72 * 60:
            continue
        candidates.append((mins, mid, name))
    candidates.sort(reverse=True)
    return [
        _ins("ongoing_stop",
             "critical" if mins >= 120 else "warn",
             {"machine": name, "minutes": mins},
             "/factory-map", weight=mins, machine_id=mid)
        for mins, mid, name in candidates[:3]
    ]


async def _downtime_spike(s: _Snapshot) -> list[dict]:
    """Plant-wide unplanned downtime today vs the average of the previous
    14 days (only days that had downtime count, so idle weekends don't dilute)."""
    not_planned = or_(StopCategory.type.is_(None),
                      StopCategory.type != StopCategoryType.planned)
    today_rows = (await s.db.execute(
        select(MachineStop.started_at, MachineStop.duration_minutes)
        .select_from(MachineStop)
        .join(StopCategory, MachineStop.stop_category_id == StopCategory.id, isouter=True)
        .where(plant_condition(MachineStop, s.ctx),
               MachineStop.started_at >= s.today_start, not_planned)
    )).all()
    today_min = sum(
        float(dur) if dur is not None else _minutes(s.now, started)
        for started, dur in today_rows
    )
    base_rows = (await s.db.execute(
        select(func.date(MachineStop.started_at), func.sum(MachineStop.duration_minutes))
        .select_from(MachineStop)
        .join(StopCategory, MachineStop.stop_category_id == StopCategory.id, isouter=True)
        .where(plant_condition(MachineStop, s.ctx),
               MachineStop.started_at >= s.today_start - timedelta(days=14),
               MachineStop.started_at < s.today_start,
               MachineStop.duration_minutes.isnot(None), not_planned)
        .group_by(func.date(MachineStop.started_at))
    )).all()
    day_totals = [float(m or 0) for _, m in base_rows if (m or 0) > 0]
    if len(day_totals) < 3:
        return []
    avg = sum(day_totals) / len(day_totals)
    if today_min < 60 or today_min < avg * 1.5:
        return []
    return [_ins(
        "downtime_spike",
        "critical" if today_min >= avg * 2.5 else "warn",
        {"today": round(today_min / 60, 1), "baseline": round(avg / 60, 1)},
        "/kpis", weight=today_min / max(avg, 1) * 10,
    )]


# ─── Maintenance response ──────────────────────────────────────────────────────

async def _slow_response(s: _Snapshot) -> list[dict]:
    """Average technician response (call → start) today vs the last 30 days."""
    async def samples(since, until):
        rows = (await s.db.execute(
            select(MachineIntervention.response_time_minutes)
            .where(plant_condition(MachineIntervention, s.ctx),
                   MachineIntervention.called_at >= since,
                   MachineIntervention.called_at < until,
                   MachineIntervention.response_time_minutes.isnot(None))
        )).all()
        return [float(r[0]) for r in rows]

    today = await samples(s.today_start, s.now)
    base = await samples(s.today_start - timedelta(days=30), s.today_start)
    if len(today) < 2 or len(base) < 5:
        return []
    t_avg = sum(today) / len(today)
    b_avg = sum(base) / len(base)
    if t_avg < b_avg * 1.5 or t_avg - b_avg < 5:
        return []
    return [_ins(
        "slow_response",
        "critical" if (t_avg >= b_avg * 2.5 and t_avg - b_avg >= 15) else "warn",
        {"today": round(t_avg), "baseline": round(b_avg)},
        "/gestion-bt", weight=t_avg / max(b_avg, 1) * 10,
    )]


async def _stale_tickets(s: _Snapshot) -> list[dict]:
    """Open tickets nobody has started after 2+ hours."""
    threshold = s.now - timedelta(hours=2)
    rows = (await s.db.execute(
        select(MaintenanceTicket.opened_at)
        .where(plant_condition(MaintenanceTicket, s.ctx),
               MaintenanceTicket.status == TicketStatus.open,
               MaintenanceTicket.started_at.is_(None),
               MaintenanceTicket.opened_at <= threshold)
    )).all()
    if not rows:
        return []
    oldest = min(r[0] for r in rows)
    mins = _minutes(s.now, oldest)
    return [_ins(
        "stale_tickets", "warn",
        {"count": len(rows), "minutes": mins},
        "/tickets", weight=mins / 30,
    )]


async def _alert_backlog(s: _Snapshot) -> list[dict]:
    """Maintenance alerts still unassigned (status new) after 60+ minutes."""
    threshold = s.now - timedelta(minutes=60)
    rows = (await s.db.execute(
        select(MaintenanceAlert.created_at)
        .where(plant_condition(MaintenanceAlert, s.ctx),
               MaintenanceAlert.status == AlertStatus.new_alert,
               MaintenanceAlert.created_at <= threshold)
    )).all()
    if not rows:
        return []
    oldest = min(r[0] for r in rows)
    mins = _minutes(s.now, oldest)
    return [_ins(
        "alert_backlog", "warn",
        {"count": len(rows), "minutes": mins},
        "/gestion-bt", weight=mins / 30,
    )]


# ─── Work orders / PM ──────────────────────────────────────────────────────────

async def _overdue_wos(s: _Snapshot) -> list[dict]:
    count = (await s.db.execute(
        select(func.count(WorkOrder.id))
        .where(plant_condition(WorkOrder, s.ctx),
               WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.in_progress]),
               WorkOrder.due_date.isnot(None),
               WorkOrder.due_date < s.now)
    )).scalar() or 0
    if count == 0:
        return []
    return [_ins(
        "overdue_wos", "warn" if count >= 5 else "info",
        {"count": int(count)}, "/work-orders", weight=float(count),
    )]


async def _pm_compliance(s: _Snapshot) -> list[dict]:
    """On-time preventive completion over the trailing 30 days (same
    methodology as the KPI summary: completed-on-time / opened)."""
    since = s.now - timedelta(days=30)
    base = and_(plant_condition(WorkOrder, s.ctx),
                WorkOrder.type == WorkOrderType.preventive,
                WorkOrder.opened_at >= since)
    total = (await s.db.execute(select(func.count(WorkOrder.id)).where(base))).scalar() or 0
    if total < 4:
        return []
    on_time = (await s.db.execute(
        select(func.count(WorkOrder.id))
        .where(base,
               WorkOrder.status == WorkOrderStatus.completed,
               WorkOrder.completed_at.isnot(None),
               WorkOrder.due_date.isnot(None),
               WorkOrder.completed_at <= WorkOrder.due_date)
    )).scalar() or 0
    pct = round(on_time / total * 100)
    if pct >= 75:
        return []
    return [_ins(
        "pm_compliance_low", "warn" if pct < 60 else "info",
        {"pct": pct}, "/kpis", weight=100 - pct,
    )]


# ─── Inventory ─────────────────────────────────────────────────────────────────

async def _low_stock(s: _Snapshot) -> list[dict]:
    rows = (await s.db.execute(
        select(StockItem.code, StockItem.name, StockItem.quantity, StockItem.min_quantity)
        .where(plant_condition(StockItem, s.ctx),
               StockItem.min_quantity.isnot(None),
               StockItem.min_quantity > 0,
               StockItem.quantity <= StockItem.min_quantity)
    )).all()
    if not rows:
        return []
    worst = min(rows, key=lambda r: (r.quantity or 0) / float(r.min_quantity))
    item = worst.name or worst.code or "—"
    return [_ins(
        "low_stock", "info",
        {"count": len(rows), "item": item},
        "/inventory", weight=float(len(rows)),
    )]


# ─── Weekly OEE health ─────────────────────────────────────────────────────────

async def _oee_week(s: _Snapshot) -> list[dict]:
    # Reuses the KPI route's TPM planned-time OEE so both screens always agree.
    # (Route→service is the normal direction; this one exception avoids
    # duplicating the whole methodology here.)
    from app.api.routes.kpis import _oee_metrics
    since = s.now - timedelta(days=7)
    met = await _oee_metrics(s.db, None, since, s.now,
                             since.date(), s.now.date(), s.ctx)
    oee = met.get("oee_pct")
    if oee is None:
        return []
    if oee >= 85:
        return [_ins("oee_strong_week", "good", {"pct": oee}, "/kpis")]
    if oee < 60:
        return [_ins("oee_low_week", "warn" if oee < 45 else "info",
                     {"pct": oee}, "/kpis", weight=60 - oee)]
    return []


# ─── Assembly ──────────────────────────────────────────────────────────────────

# resource → detectors. A detector only runs when the caller can view its
# resource, so the feed never leaks numbers a role is not allowed to read.
_DETECTORS: list[tuple[str, Callable[[_Snapshot], Awaitable[list[dict]]]]] = [
    ("kpis", _production_rate_drop),
    ("kpis", _reject_rate_high),
    ("kpis", _stop_justification),
    ("equipment", _ongoing_stops),
    ("kpis", _downtime_spike),
    ("tickets", _slow_response),
    ("tickets", _stale_tickets),
    ("alerts", _alert_backlog),
    ("work_orders", _overdue_wos),
    ("kpis", _pm_compliance),
    ("inventory", _low_stock),
    ("kpis", _oee_week),
]


async def _plant_tz(db: AsyncSession, ctx: PlantContext) -> ZoneInfo:
    tzname = None
    if ctx.plant_id:
        p = await db.get(Plant, ctx.plant_id)
        tzname = p.timezone if p else None
    if not tzname:
        tzname = (await db.execute(select(Plant.timezone).limit(1))).scalar()
    try:
        return ZoneInfo(tzname or _DEFAULT_TZ)
    except Exception:
        return ZoneInfo(_DEFAULT_TZ)


async def build_home_insights(db: AsyncSession, user: User, ctx: PlantContext) -> dict:
    perms = await effective_permissions(db, user)

    def allowed(resource: str) -> bool:
        return "*" in perms or f"{resource}:view" in perms

    now = datetime.now(timezone.utc)
    tz = await _plant_tz(db, ctx)
    today_start = datetime.combine(now.astimezone(tz).date(), time.min,
                                   tzinfo=tz).astimezone(timezone.utc)

    machine_rows = (await db.execute(
        select(Machine.id, Machine.display_name, Machine.name, Machine.current_status)
        .where(plant_condition(Machine, ctx), Machine.is_active.is_(True))
    )).all()
    machines = {r.id: (r.display_name or r.name) for r in machine_rows}
    statuses = {
        r.id: (r.current_status.value if hasattr(r.current_status, "value")
               else str(r.current_status or ""))
        for r in machine_rows
    }
    open_stop_rows = (await db.execute(
        select(MachineStop.machine_id, MachineStop.started_at, StopCategory.type)
        .select_from(MachineStop)
        .join(StopCategory, MachineStop.stop_category_id == StopCategory.id, isouter=True)
        .where(plant_condition(MachineStop, ctx), MachineStop.ended_at.is_(None))
    )).all()

    snap = _Snapshot(db=db, ctx=ctx, now=now, today_start=today_start,
                     machines=machines, statuses=statuses,
                     open_stops=[tuple(r) for r in open_stop_rows])

    insights: list[dict] = []
    for resource, detector in _DETECTORS:
        if not allowed(resource):
            continue
        try:
            insights.extend(await detector(snap))
        except Exception:                                    # noqa: BLE001
            log.warning("home insight detector %s failed", detector.__name__,
                        exc_info=True)

    insights.sort(key=lambda i: (_SEV_RANK.get(i["severity"], 9), -i["weight"]))
    for i in insights:
        i.pop("weight", None)
    return {"generated_at": now.isoformat(), "insights": insights[:_MAX_INSIGHTS]}
