from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_, true
from datetime import datetime, timedelta, timezone, date, time
from typing import Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from app.db.session import get_db
from app.models.models import (
    WorkOrder, WorkOrderStatus, WorkOrderType,
    Equipment, LaborRecord, WOCost, User, Machine, MachineIntervention,
    WOPart, InterventionPart, MachineStop, MachineProductionLog,
    StopCategory, StopSubcategory, StopCategoryType, Plant,
)
from app.core.security import get_current_user
from app.services.work_calendar import working_dates

router = APIRouter()


_DEFAULT_TZ = "America/Toronto"


async def _range_tz(db: AsyncSession, machine_id: Optional[UUID]) -> ZoneInfo:
    """Timezone to interpret a calendar range in — the machine's plant (or the
    first plant), so a picked day means that local day, not a UTC day."""
    tzname = None
    if machine_id:
        m = await db.get(Machine, machine_id)
        if m and m.plant_id:
            p = await db.get(Plant, m.plant_id)
            tzname = p.timezone if p else None
    if not tzname:
        tzname = (await db.execute(select(Plant.timezone).limit(1))).scalar()
    try:
        return ZoneInfo(tzname or _DEFAULT_TZ)
    except Exception:
        return ZoneInfo(_DEFAULT_TZ)


def _window(period_days: int, start: Optional[date], end: Optional[date], tz: ZoneInfo):
    """Resolve the analysis window. A custom calendar range (start+end, inclusive,
    interpreted in `tz`) wins; otherwise the trailing `period_days` ending now.
    Returns (since, until, start_date, end_date, window_days):
      - since/until  UTC timestamps → for timestamp columns (stops, WO dates…)
      - start_date/end_date  plain dates → for Date columns (production logs, costs)
      - window_days  span in days → capacity-style calcs."""
    now = datetime.now(timezone.utc)
    if start and end:
        since = datetime.combine(start, time.min, tzinfo=tz).astimezone(timezone.utc)
        until = datetime.combine(end, time.max, tzinfo=tz).astimezone(timezone.utc)
        return since, until, start, end, max((end - start).days + 1, 1)
    since = now - timedelta(days=period_days)
    return since, now, since.date(), now.date(), period_days


async def _machine_eq_ids(db: AsyncSession, machine_id: Optional[UUID]) -> Optional[set]:
    """Equipment ids linked to a machine: explicit Machine.equipment_id plus
    the shared UUID for machines auto-provisioned from equipment."""
    if machine_id is None:
        return None
    eq_ids = {machine_id}
    machine = await db.get(Machine, machine_id)
    if machine and machine.equipment_id:
        eq_ids.add(machine.equipment_id)
    return eq_ids


async def _machine_cond(db: AsyncSession, machine_id: Optional[UUID]):
    """WorkOrder filter for a machine. No-op when machine_id is None."""
    if machine_id is None:
        return true()
    eq_ids = await _machine_eq_ids(db, machine_id)
    return or_(
        WorkOrder.machine_id == machine_id,
        WorkOrder.equipment_id.in_(list(eq_ids)),
    )


async def _machine_int_cond(db: AsyncSession, machine_id: Optional[UUID]):
    """MachineIntervention filter for a machine. No-op when machine_id is None."""
    if machine_id is None:
        return true()
    eq_ids = await _machine_eq_ids(db, machine_id)
    return or_(
        MachineIntervention.machine_id == machine_id,
        MachineIntervention.equipment_id.in_(list(eq_ids)),
    )


async def _parts_cost(db: AsyncSession, since, m_cond, i_cond, until=None) -> float:
    """Cost of parts used in the period: WO parts plus approved intervention parts."""
    wo_parts = (await db.execute(
        select(func.sum(WOPart.total_cost))
        .join(WorkOrder, WOPart.work_order_id == WorkOrder.id)
        .where(and_(m_cond, WOPart.created_at >= since, WOPart.total_cost.isnot(None),
                    *( [WOPart.created_at <= until] if until else [] )))
    )).scalar() or 0.0
    int_parts = (await db.execute(
        select(func.sum(InterventionPart.total_cost))
        .join(MachineIntervention, InterventionPart.intervention_id == MachineIntervention.id)
        .where(
            and_(
                i_cond,
                InterventionPart.approval_status == "approved",
                InterventionPart.added_at >= since,
                InterventionPart.total_cost.isnot(None),
                *( [InterventionPart.added_at <= until] if until else [] ),
            )
        )
    )).scalar() or 0.0
    return float(wo_parts) + float(int_parts)


def _shift_minutes(shifts_config, shift_value: str) -> float:
    """Length of one shift window (minutes) from a machine's shifts_config.
    Handles overnight shifts (end < start). Falls back to 480 (8 h) when the
    config is missing or unparseable."""
    default = 480.0
    cfg = shifts_config.get(shift_value) if isinstance(shifts_config, dict) else None
    if not cfg:
        return default
    start, end = cfg.get("start"), cfg.get("end")
    if not start or not end:
        return default
    try:
        sh, sm = (int(x) for x in start.split(":"))
        eh, em = (int(x) for x in end.split(":"))
        mins = (eh * 60 + em) - (sh * 60 + sm)
        if mins <= 0:
            mins += 24 * 60            # overnight shift (e.g. 23:30 → 07:00)
        return float(mins)
    except (ValueError, AttributeError):
        return default


async def _oee_metrics(db: AsyncSession, machine_ids, since, until, start_date, end_date) -> dict:
    """OEE on the TPM planned-time basis, for one machine, a set, or all (None).

    Planned Production Time = scheduled shift time (recorded production shifts ×
    their shifts_config window) − planned stops. Availability uses unplanned +
    maintenance stops as downtime. Performance/Quality come from production counts.

    Returns pct values, each None when its basis is absent so the UI shows "—"
    instead of a misleading 0 — the cards light up automatically once the plant
    records production and classifies its stops.

    Only working-calendar dates count (Mon-Fri minus holidays; weekends/holidays
    auto-included when production was recorded) — idle weekends don't drag the
    numbers down."""
    wdays = await working_dates(db, start_date, end_date, machine_ids)
    log_cond = [MachineProductionLog.date >= start_date, MachineProductionLog.date <= end_date]
    if machine_ids is not None:
        log_cond.append(MachineProductionLog.machine_id.in_(list(machine_ids)))
    logs = (await db.execute(
        select(
            MachineProductionLog.machine_id, MachineProductionLog.date,
            MachineProductionLog.shift,
            MachineProductionLog.target_count, MachineProductionLog.actual_count,
            MachineProductionLog.reject_count,
        ).where(and_(*log_cond))
    )).all()
    logs = [l for l in logs if l.date in wdays]
    none = {"availability_pct": None, "performance_pct": None,
            "quality_pct": None, "oee_pct": None, "parts_per_hour": None}
    if not logs:
        return none

    cfgs = dict((await db.execute(
        select(Machine.id, Machine.shifts_config)
        .where(Machine.id.in_({l.machine_id for l in logs}))
    )).all())
    scheduled_min = 0.0
    total_target = total_actual = total_reject = 0
    for l in logs:
        sv = l.shift.value if hasattr(l.shift, "value") else str(l.shift)
        scheduled_min += _shift_minutes(cfgs.get(l.machine_id), sv)
        total_target += l.target_count or 0
        total_actual += l.actual_count or 0
        total_reject += l.reject_count or 0

    stop_cond = [MachineStop.started_at >= since, MachineStop.started_at <= until,
                 MachineStop.duration_minutes.isnot(None)]
    if machine_ids is not None:
        stop_cond.append(MachineStop.machine_id.in_(list(machine_ids)))
    d_expr = func.date(MachineStop.started_at)
    stop_rows = (await db.execute(
        select(d_expr.label("d"), StopCategory.type, func.sum(MachineStop.duration_minutes))
        .select_from(MachineStop)
        .join(StopCategory, MachineStop.stop_category_id == StopCategory.id, isouter=True)
        .where(and_(*stop_cond))
        .group_by(d_expr, StopCategory.type)
    )).all()
    wdays_iso = {d.isoformat() for d in wdays}
    planned_min = downtime_min = 0.0
    for d, typ, mins in stop_rows:
        if str(d)[:10] not in wdays_iso:    # stop on a non-working day: skipped with it
            continue
        # Uncategorized stops count as downtime (conservative — they lower availability).
        if typ == StopCategoryType.planned:
            planned_min += float(mins or 0)
        else:
            downtime_min += float(mins or 0)

    ppt = max(scheduled_min - planned_min, 0.0)
    run_min = max(ppt - downtime_min, 0.0)
    availability = (run_min / ppt) if ppt > 0 else None
    performance = min(total_actual / total_target, 1.0) if total_target > 0 else None
    quality = ((total_actual - total_reject) / total_actual) if total_actual > 0 else None
    oee = (availability * performance * quality
           if None not in (availability, performance, quality) else None)

    def pct(v):
        return round(v * 100, 1) if v is not None else None
    return {
        "availability_pct": pct(availability),
        "performance_pct": pct(performance),
        "quality_pct": pct(quality),
        "oee_pct": pct(oee),
        "parts_per_hour": round(total_actual / (run_min / 60.0), 1) if run_min > 0 else None,
    }


@router.get("/summary")
async def get_kpi_summary(
    period_days: int = Query(30, ge=1, le=365),
    machine_id: Optional[UUID] = Query(None),
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tz = await _range_tz(db, machine_id)
    since, until, start_date, end_date, window_days = _window(period_days, start, end, tz)
    m_cond = await _machine_cond(db, machine_id)

    # MTTR: corrective WO repair hours plus machine intervention durations,
    # skipping interventions whose ticket already produced a counted WO
    wo_repair_rows = (await db.execute(
        select(WorkOrder.repair_hours, WorkOrder.ticket_id).where(
            and_(
                m_cond,
                WorkOrder.type == WorkOrderType.corrective,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.completed_at >= since,
                WorkOrder.completed_at <= until,
                WorkOrder.repair_hours.isnot(None),
            )
        )
    )).all()
    repair_samples = [float(r.repair_hours) for r in wo_repair_rows]
    counted_tickets = {r.ticket_id for r in wo_repair_rows if r.ticket_id}

    i_cond = await _machine_int_cond(db, machine_id)
    int_rows = (await db.execute(
        select(
            MachineIntervention.intervention_duration_minutes,
            MachineIntervention.ticket_id,
        ).where(
            and_(
                i_cond,
                MachineIntervention.status == "completed",
                MachineIntervention.called_at >= since,
                MachineIntervention.called_at <= until,
                MachineIntervention.intervention_duration_minutes.isnot(None),
            )
        )
    )).all()
    for r in int_rows:
        if r.ticket_id and r.ticket_id in counted_tickets:
            continue
        repair_samples.append(float(r.intervention_duration_minutes) / 60.0)
    mttr = sum(repair_samples) / len(repair_samples) if repair_samples else 0.0

    # MTTA — mean time to attend: how long maintenance waits between the call and
    # the technician starting the intervention (response/wait time).
    resp_rows = (await db.execute(
        select(MachineIntervention.response_time_minutes).where(
            and_(
                i_cond,
                MachineIntervention.response_time_minutes.isnot(None),
                MachineIntervention.called_at >= since,
                MachineIntervention.called_at <= until,
            )
        )
    )).all()
    resp_samples = [float(r.response_time_minutes) for r in resp_rows]
    mtta_minutes = sum(resp_samples) / len(resp_samples) if resp_samples else 0.0

    backlog_r = await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(
                m_cond,
                WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.in_progress]),
            )
        )
    )
    backlog = backlog_r.scalar() or 0

    total_pm_r = await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(m_cond, WorkOrder.type == WorkOrderType.preventive,
                 WorkOrder.opened_at >= since, WorkOrder.opened_at <= until)
        )
    )
    total_pm = total_pm_r.scalar() or 0

    on_time_r = await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(
                m_cond,
                WorkOrder.type == WorkOrderType.preventive,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.opened_at >= since,
                WorkOrder.opened_at <= until,
                WorkOrder.completed_at.isnot(None),
                WorkOrder.due_date.isnot(None),
                WorkOrder.completed_at <= WorkOrder.due_date,
            )
        )
    )
    on_time = on_time_r.scalar() or 0
    pm_compliance = round((on_time / total_pm * 100) if total_pm > 0 else 0.0, 1)

    cost_r = await db.execute(
        select(func.sum(WOCost.amount))
        .join(WorkOrder, WOCost.work_order_id == WorkOrder.id)
        .where(and_(m_cond, WOCost.date >= start_date, WOCost.date <= end_date))
    )
    total_cost = float(cost_r.scalar() or 0.0)
    total_cost += await _parts_cost(db, since, m_cond, i_cond, until)

    # ── Reliability: downtime, failures, MTBF (maintenance-time basis) ───────
    # MTBF keeps a calendar-uptime basis (failures over operating time); it must
    # work even with no production logs. OEE/Availability below use the stricter
    # planned-time basis. Downtime = corrective-WO downtime + logged stops.
    wo_downtime = (await db.execute(
        select(func.sum(WorkOrder.downtime_hours)).where(
            and_(m_cond, WorkOrder.downtime_hours.isnot(None),
                 WorkOrder.opened_at >= since, WorkOrder.opened_at <= until)
        )
    )).scalar() or 0.0
    stop_cond = (MachineStop.machine_id == machine_id) if machine_id else true()
    stop_minutes = (await db.execute(
        select(func.sum(MachineStop.duration_minutes)).where(
            and_(stop_cond, MachineStop.started_at >= since, MachineStop.started_at <= until,
                 MachineStop.duration_minutes.isnot(None))
        )
    )).scalar() or 0
    downtime_hours = float(wo_downtime) + float(stop_minutes) / 60.0

    # Failures = corrective work orders opened in the period (drives MTBF).
    failures = (await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(m_cond, WorkOrder.type == WorkOrderType.corrective,
                 WorkOrder.opened_at >= since, WorkOrder.opened_at <= until)
        )
    )).scalar() or 0

    if machine_id:
        scope_machines = 1
    else:
        scope_machines = (await db.execute(select(func.count(Machine.id)))).scalar() or 1
    # Capacity counts working-calendar days only (Mon-Fri minus holidays, plus
    # weekends/holidays that were actually worked or when count_weekends is on).
    work_days = len(await working_dates(db, start_date, end_date,
                                        [machine_id] if machine_id else None))
    capacity_hours = max(scope_machines, 1) * max(work_days, 1) * 24.0
    operating_hours = max(capacity_hours - downtime_hours, 0.0)
    mtbf_hours = round(operating_hours / failures, 1) if failures > 0 else round(operating_hours, 1)

    # ── OEE (TPM planned-time basis) — one machine or plant-wide ─────────────
    oee = await _oee_metrics(db, [machine_id] if machine_id else None, since, until, start_date, end_date)

    # Live status/operator for a single machine.
    current_status = None
    operator = None
    if machine_id:
        machine = await db.get(Machine, machine_id)
        if machine:
            current_status = (
                machine.current_status.value
                if hasattr(machine.current_status, "value")
                else str(machine.current_status or "")
            )
            operator = machine.current_operator

    return {
        "mttr_hours": round(float(mttr), 2),
        "mtta_minutes": round(float(mtta_minutes), 1),
        "mtbf_hours": mtbf_hours,
        "availability_pct": oee["availability_pct"],
        "downtime_hours": round(downtime_hours, 2),
        "failures": int(failures),
        "backlog_count": int(backlog),
        "pm_compliance_pct": pm_compliance,
        "total_cost_cad": round(float(total_cost), 2),
        "parts_per_hour": oee["parts_per_hour"],
        "performance_pct": oee["performance_pct"],
        "quality_pct": oee["quality_pct"],
        "oee_pct": oee["oee_pct"],
        "current_status": current_status,
        "operator": operator,
        "period_days": window_days,
    }


@router.get("/backlog")
async def get_backlog(
    machine_id: Optional[UUID] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    m_cond = await _machine_cond(db, machine_id)
    result = await db.execute(
        select(WorkOrder.id, WorkOrder.opened_at).where(
            and_(
                m_cond,
                WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.in_progress]),
            )
        )
    )
    rows = result.all()
    buckets = {"0_7": 0, "7_30": 0, "30_plus": 0}
    for row in rows:
        opened = row.opened_at if row.opened_at.tzinfo else row.opened_at.replace(tzinfo=timezone.utc)
        age = (now - opened).days
        if age <= 7:
            buckets["0_7"] += 1
        elif age <= 30:
            buckets["7_30"] += 1
        else:
            buckets["30_plus"] += 1

    return {
        "total": len(rows),
        "buckets": [
            {"label": "0–7 days", "count": buckets["0_7"]},
            {"label": "7–30 days", "count": buckets["7_30"]},
            {"label": "30+ days", "count": buckets["30_plus"]},
        ],
    }


@router.get("/mttr")
async def get_mttr_by_equipment(
    period_days: int = Query(90, ge=1, le=365),
    machine_id: Optional[UUID] = Query(None),
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tz = await _range_tz(db, machine_id)
    since, until, _sd, _ed, _wd = _window(period_days, start, end, tz)
    m_cond = await _machine_cond(db, machine_id)

    # WO-based repairs grouped by equipment
    wo_rows = (await db.execute(
        select(WorkOrder.repair_hours, WorkOrder.ticket_id, Equipment.name, Equipment.code)
        .join(Equipment, WorkOrder.equipment_id == Equipment.id)
        .where(
            and_(
                m_cond,
                WorkOrder.type == WorkOrderType.corrective,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.completed_at >= since,
                WorkOrder.completed_at <= until,
                WorkOrder.repair_hours.isnot(None),
            )
        )
    )).all()

    groups: dict = {}
    counted_tickets = set()
    for r in wo_rows:
        g = groups.setdefault(r.name, {"code": r.code, "samples": []})
        g["samples"].append(float(r.repair_hours))
        if r.ticket_id:
            counted_tickets.add(r.ticket_id)

    # Machine interventions grouped by machine, merged by display name
    i_cond = await _machine_int_cond(db, machine_id)
    int_rows = (await db.execute(
        select(
            MachineIntervention.machine_id,
            MachineIntervention.equipment_id,
            MachineIntervention.intervention_duration_minutes,
            MachineIntervention.ticket_id,
        ).where(
            and_(
                i_cond,
                MachineIntervention.status == "completed",
                MachineIntervention.called_at >= since,
                MachineIntervention.called_at <= until,
                MachineIntervention.intervention_duration_minutes.isnot(None),
            )
        )
    )).all()
    if int_rows:
        machines_map = {
            m.id: m for m in (await db.execute(select(Machine))).scalars().all()
        }
        for r in int_rows:
            if r.ticket_id and r.ticket_id in counted_tickets:
                continue
            name, code = None, None
            m = machines_map.get(r.machine_id)
            if m:
                name, code = (m.display_name or m.name), m.code
            elif r.equipment_id:
                eq = await db.get(Equipment, r.equipment_id)
                if eq:
                    name, code = eq.name, eq.code
            if not name:
                continue
            g = groups.setdefault(name, {"code": code, "samples": []})
            g["samples"].append(float(r.intervention_duration_minutes) / 60.0)

    items = [
        {
            "equipment": name,
            "code": g["code"],
            "avg_repair_hours": round(sum(g["samples"]) / len(g["samples"]), 2),
            "repairs": len(g["samples"]),
        }
        for name, g in groups.items()
    ]
    return sorted(items, key=lambda x: x["avg_repair_hours"], reverse=True)


@router.get("/cost")
async def get_cost_by_type(
    period_days: int = Query(30, ge=1, le=365),
    machine_id: Optional[UUID] = Query(None),
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tz = await _range_tz(db, machine_id)
    since, until, start_date, end_date, _wd = _window(period_days, start, end, tz)
    m_cond = await _machine_cond(db, machine_id)
    result = await db.execute(
        select(WOCost.transaction_type, func.sum(WOCost.amount).label("total"))
        .join(WorkOrder, WOCost.work_order_id == WorkOrder.id)
        .where(and_(m_cond, WOCost.date >= start_date, WOCost.date <= end_date))
        .group_by(WOCost.transaction_type)
    )
    rows = result.all()
    out = [{"type": row.transaction_type, "total": round(float(row.total), 2)} for row in rows]

    i_cond = await _machine_int_cond(db, machine_id)
    parts_total = await _parts_cost(db, since, m_cond, i_cond, until)
    if parts_total:
        out.append({"type": "parts_used", "total": round(parts_total, 2)})
    return out


@router.get("/downtime-pareto")
async def get_downtime_pareto(
    period_days: int = Query(30, ge=1, le=365),
    machine_id: Optional[UUID] = Query(None),
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Downtime grouped by stop reason (category) → subcategory, worst first — the
    actionable Pareto with drill-down. Each category carries its own subcategory
    breakdown (for the % of subcategories) plus the group totals. Localized names
    carried in all three locales; colour is the category's/subcategory's own.
    Uncategorized stops fall under a null category."""
    tz = await _range_tz(db, machine_id)
    since, until, _sd, _ed, _wd = _window(period_days, start, end, tz)
    cond = [MachineStop.started_at >= since, MachineStop.started_at <= until,
            MachineStop.duration_minutes.isnot(None)]
    if machine_id:
        cond.append(MachineStop.machine_id == machine_id)
    # One row per (category × subcategory); fold into nested groups below.
    rows = (await db.execute(
        select(
            StopCategory.id.label("cat_id"),
            StopCategory.name, StopCategory.name_en, StopCategory.name_fr,
            StopCategory.name_es, StopCategory.color, StopCategory.type,
            StopSubcategory.id.label("sub_id"),
            StopSubcategory.name.label("sub_name"),
            StopSubcategory.name_en.label("sub_name_en"),
            StopSubcategory.name_fr.label("sub_name_fr"),
            StopSubcategory.name_es.label("sub_name_es"),
            StopSubcategory.color.label("sub_color"),
            func.sum(MachineStop.duration_minutes).label("minutes"),
            func.count(MachineStop.id).label("count"),
        )
        .select_from(MachineStop)
        .join(StopCategory, MachineStop.stop_category_id == StopCategory.id, isouter=True)
        .join(StopSubcategory, MachineStop.stop_subcategory_id == StopSubcategory.id, isouter=True)
        .where(and_(*cond))
        .group_by(
            StopCategory.id, StopCategory.name, StopCategory.name_en, StopCategory.name_fr,
            StopCategory.name_es, StopCategory.color, StopCategory.type,
            StopSubcategory.id, StopSubcategory.name, StopSubcategory.name_en,
            StopSubcategory.name_fr, StopSubcategory.name_es, StopSubcategory.color,
        )
    )).all()

    cats: dict = {}
    for r in rows:
        key = str(r.cat_id) if r.cat_id else "__none__"
        cat = cats.get(key)
        if cat is None:
            cat = {
                "name": r.name,
                "name_en": r.name_en, "name_fr": r.name_fr, "name_es": r.name_es,
                "color": r.color or "#6b7280",
                "type": r.type.value if hasattr(r.type, "value") else r.type,
                "minutes": 0, "count": 0,
                "subcategories": [],
            }
            cats[key] = cat
        mins, cnt = int(r.minutes or 0), int(r.count or 0)
        cat["minutes"] += mins
        cat["count"] += cnt
        # Only emit a subcategory entry when the stop actually carried one; the
        # frontend surfaces the "unspecified" remainder (group total − Σ subs).
        if r.sub_id is not None:
            cat["subcategories"].append({
                "name": r.sub_name,
                "name_en": r.sub_name_en, "name_fr": r.sub_name_fr, "name_es": r.sub_name_es,
                "color": r.sub_color or r.color or "#6b7280",
                "minutes": mins, "count": cnt,
            })
    for cat in cats.values():
        cat["subcategories"].sort(key=lambda s: s["minutes"], reverse=True)
    return sorted(cats.values(), key=lambda x: x["minutes"], reverse=True)


@router.get("/oee-trend")
async def get_oee_trend(
    period_days: int = Query(30, ge=1, le=365),
    machine_id: Optional[UUID] = Query(None),
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Daily Availability / Performance / Quality / OEE over the period, same
    planned-time methodology as /summary, bucketed per calendar day. Non-working
    days (idle weekends/holidays) don't produce a bucket."""
    tz = await _range_tz(db, machine_id)
    since, until, start_date, end_date, _wd = _window(period_days, start, end, tz)
    wdays = await working_dates(db, start_date, end_date,
                                [machine_id] if machine_id else None)
    log_cond = [MachineProductionLog.date >= start_date, MachineProductionLog.date <= end_date]
    if machine_id:
        log_cond.append(MachineProductionLog.machine_id == machine_id)
    logs = (await db.execute(
        select(
            MachineProductionLog.date, MachineProductionLog.machine_id,
            MachineProductionLog.shift, MachineProductionLog.target_count,
            MachineProductionLog.actual_count, MachineProductionLog.reject_count,
        ).where(and_(*log_cond))
    )).all()
    logs = [l for l in logs if l.date in wdays]
    if not logs:
        return []
    cfgs = dict((await db.execute(
        select(Machine.id, Machine.shifts_config)
        .where(Machine.id.in_({l.machine_id for l in logs}))
    )).all())

    d_expr = func.date(MachineStop.started_at)
    stop_cond = [MachineStop.started_at >= since, MachineStop.started_at <= until,
                 MachineStop.duration_minutes.isnot(None)]
    if machine_id:
        stop_cond.append(MachineStop.machine_id == machine_id)
    stop_rows = (await db.execute(
        select(d_expr.label("d"), StopCategory.type, func.sum(MachineStop.duration_minutes))
        .select_from(MachineStop)
        .join(StopCategory, MachineStop.stop_category_id == StopCategory.id, isouter=True)
        .where(and_(*stop_cond))
        .group_by(d_expr, StopCategory.type)
    )).all()
    planned_by_day, downtime_by_day = {}, {}
    for d, typ, mins in stop_rows:
        key = str(d)
        if typ == StopCategoryType.planned:
            planned_by_day[key] = planned_by_day.get(key, 0.0) + float(mins or 0)
        else:
            downtime_by_day[key] = downtime_by_day.get(key, 0.0) + float(mins or 0)

    agg: dict = {}
    for l in logs:
        a = agg.setdefault(str(l.date), {"sched": 0.0, "target": 0, "actual": 0, "reject": 0})
        sv = l.shift.value if hasattr(l.shift, "value") else str(l.shift)
        a["sched"] += _shift_minutes(cfgs.get(l.machine_id), sv)
        a["target"] += l.target_count or 0
        a["actual"] += l.actual_count or 0
        a["reject"] += l.reject_count or 0

    def pct(v):
        return round(v * 100, 1) if v is not None else None
    out = []
    for key in sorted(agg):
        a = agg[key]
        ppt = max(a["sched"] - planned_by_day.get(key, 0.0), 0.0)
        run = max(ppt - downtime_by_day.get(key, 0.0), 0.0)
        avail = (run / ppt) if ppt > 0 else None
        perf = min(a["actual"] / a["target"], 1.0) if a["target"] > 0 else None
        qual = ((a["actual"] - a["reject"]) / a["actual"]) if a["actual"] > 0 else None
        oee = (avail * perf * qual if None not in (avail, perf, qual) else None)
        out.append({"date": key, "availability_pct": pct(avail), "performance_pct": pct(perf),
                    "quality_pct": pct(qual), "oee_pct": pct(oee)})
    return out


@router.get("/oee-by-machine")
async def get_oee_by_machine(
    period_days: int = Query(30, ge=1, le=365),
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Per-machine OEE for the period — worst first, so problem machines surface."""
    tz = await _range_tz(db, None)
    since, until, start_date, end_date, _wd = _window(period_days, start, end, tz)
    mids = [r[0] for r in (await db.execute(
        select(MachineProductionLog.machine_id)
        .where(MachineProductionLog.date >= start_date, MachineProductionLog.date <= end_date)
        .group_by(MachineProductionLog.machine_id)
    )).all()]
    if not mids:
        return []
    machines = {m.id: m for m in (await db.execute(
        select(Machine).where(Machine.id.in_(mids))
    )).scalars().all()}
    items = []
    for mid in mids:
        m = machines.get(mid)
        if not m:
            continue
        met = await _oee_metrics(db, [mid], since, until, start_date, end_date)
        items.append({
            "machine_id": str(mid),
            "name": m.display_name or m.name,
            "code": m.code,
            "availability_pct": met["availability_pct"],
            "performance_pct": met["performance_pct"],
            "quality_pct": met["quality_pct"],
            "oee_pct": met["oee_pct"],
        })
    # Worst OEE first (machines with no computable OEE sort last).
    return sorted(items, key=lambda x: (x["oee_pct"] is None, x["oee_pct"] or 0))
