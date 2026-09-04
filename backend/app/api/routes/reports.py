"""Per-machine maintenance reports.

Consolidates the maintenance KPIs (availability, OEE, MTTR, MTBF, downtime,
costs, PM compliance, backlog, response time) for a single machine, plus a
comparison endpoint across all machines.

A machine's work-order universe is WorkOrder.machine_id == machine.id plus
WorkOrder.equipment_id in the machine's linked equipment (Machine.equipment_id,
or the shared UUID for machines auto-provisioned from equipment).
"""
from datetime import date, datetime, time, timedelta, timezone
from typing import List, Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_

from app.db.session import get_db
from app.models.models import (
    Machine, Equipment, WorkOrder, WorkOrderStatus, WorkOrderType, WOCost,
    MachineStop, StopCategory, StopSubcategory, StopCategoryType, MachineProductionLog,
    MachineProductionHourly, MaintenanceTicket, MachineIntervention, User, WOPart,
    InterventionPart, AlertShift, JobOrder, JobOrderRun, Plant,
)
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_condition
from app.services.mes_service import shift_windows, overlap_seconds, shift_length_minutes
from app.services.work_calendar import working_dates

router = APIRouter()

OPEN_WO_STATUSES = [WorkOrderStatus.open, WorkOrderStatus.in_progress]


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


async def _equipment_ids_for(db: AsyncSession, machine: Machine) -> list[UUID]:
    ids = set()
    if machine.equipment_id:
        ids.add(machine.equipment_id)
    eq = await db.get(Equipment, machine.id)
    if eq:
        ids.add(eq.id)
    return list(ids)


async def _resolve_entity_machine(db: AsyncSession, entity_id: UUID) -> Optional[Machine]:
    """The reports are driven by the Equipment catalog, but the floor data lives
    on Machine rows. Resolve an id (Equipment id from the dropdown, or a Machine
    id) to the Machine that actually carries the data:
      1) a Machine with that id (auto-provisioned machines share the equipment id),
      2) a Machine explicitly linked via equipment_id,
      3) a Machine with the same name (covers unlinked floor rows),
      4) a transient Machine built from the equipment (WO/cost still resolve by
         equipment id; floor metrics are simply empty).
    """
    m = await db.get(Machine, entity_id)
    if m:
        return m
    m = (await db.execute(
        select(Machine).where(Machine.equipment_id == entity_id)
    )).scalars().first()
    if m:
        return m
    eq = await db.get(Equipment, entity_id)
    if not eq:
        return None
    m = (await db.execute(
        select(Machine).where(
            func.lower(Machine.name) == (eq.name or "").lower(),
            Machine.is_active == True,
        )
    )).scalars().first()
    if m:
        return m
    return Machine(
        id=eq.id, name=eq.name, code=eq.code, equipment_id=eq.id,
        plant_id=eq.plant_id,
        target_availability_pct=70.0, shifts_config=None, is_active=True,
    )


def _wo_filter(machine_id: UUID, eq_ids: list[UUID]):
    conds = [WorkOrder.machine_id == machine_id]
    if eq_ids:
        conds.append(WorkOrder.equipment_id.in_(eq_ids))
    return or_(*conds)


async def _fetch_stops(db: AsyncSession, since: datetime, machine_id: Optional[UUID] = None,
                       until: Optional[datetime] = None):
    """Stops in [since, until] with category info, normalized to UTC. A still-open
    stop is clipped at the window end (or now), so a range ending in the past never
    counts downtime that happened after it."""
    now = datetime.now(timezone.utc)
    cap = min(until, now) if until is not None else now
    q = (
        select(MachineStop, StopCategory.type, StopCategory.name, StopCategory.color,
               StopSubcategory.name, StopSubcategory.color)
        .outerjoin(StopCategory, MachineStop.stop_category_id == StopCategory.id)
        .outerjoin(StopSubcategory, MachineStop.stop_subcategory_id == StopSubcategory.id)
        .where(MachineStop.started_at >= since)
    )
    if until is not None:
        q = q.where(MachineStop.started_at <= until)
    if machine_id is not None:
        q = q.where(MachineStop.machine_id == machine_id)
    rows = (await db.execute(q)).all()
    stops = []
    for stop, cat_type, cat_name, cat_color, sub_name, sub_color in rows:
        start = _as_utc(stop.started_at)
        end = min(_as_utc(stop.ended_at), cap) if stop.ended_at else cap
        if end <= start:
            continue
        stops.append({
            "machine_id": stop.machine_id,
            "start": start,
            "end": end,
            "type": cat_type,
            "category": cat_name or "Uncategorized",
            "color": cat_color or "#6b7280",
            "subcategory": sub_name,                       # None when not classified
            "sub_color": sub_color or cat_color or "#6b7280",
        })
    return stops


def _availability_over_period(machine: Machine, stops: list, start_date: date, end_date: date,
                              working: Optional[set] = None):
    """Daily availability trend + period totals from unplanned stop time vs
    planned time (shifts_config, full day when unset). Days outside `working`
    (idle weekends/holidays per the factory calendar) are skipped entirely."""
    now = datetime.now(timezone.utc)
    unplanned = [s for s in stops if s["type"] != StopCategoryType.planned]
    trend = []
    total_planned = 0.0
    total_stopped = 0.0
    d = start_date
    while d <= end_date:
        if working is not None and d not in working:
            d += timedelta(days=1)
            continue
        windows = shift_windows(machine.shifts_config, d)
        planned = sum(overlap_seconds(ws, we, ws, min(we, now)) for ws, we in windows)
        if planned > 0:
            stopped = sum(
                overlap_seconds(s["start"], s["end"], ws, min(we, now))
                for s in unplanned
                for ws, we in windows
            )
            stopped = min(stopped, planned)
            total_planned += planned
            total_stopped += stopped
            trend.append({
                "date": d.isoformat(),
                "pct": round((planned - stopped) / planned * 100, 1),
            })
        d += timedelta(days=1)

    avg_pct = round((total_planned - total_stopped) / total_planned * 100, 1) if total_planned > 0 else None
    return trend, avg_pct, total_planned / 3600.0


def _downtime_summary(stops: list):
    unplanned_min = 0
    planned_min = 0
    pareto: dict = {}
    sub_pareto: dict = {}
    for s in stops:
        minutes = int((s["end"] - s["start"]).total_seconds() / 60)
        if s["type"] == StopCategoryType.planned:
            planned_min += minutes
        else:
            unplanned_min += minutes
        key = s["category"]
        if key not in pareto:
            pareto[key] = {
                "category": key,
                "color": s["color"],
                "type": s["type"].value if hasattr(s["type"], "value") else (str(s["type"]) if s["type"] else "unplanned"),
                "count": 0,
                "minutes": 0,
            }
        pareto[key]["count"] += 1
        pareto[key]["minutes"] += minutes
        # subcategory Pareto — stops with no subcategory fall under "Unspecified"
        sub_key = s.get("subcategory") or "Unspecified"
        if sub_key not in sub_pareto:
            sub_pareto[sub_key] = {
                "category": sub_key,
                "color": s.get("sub_color") if s.get("subcategory") else "#475569",
                "count": 0,
                "minutes": 0,
            }
        sub_pareto[sub_key]["count"] += 1
        sub_pareto[sub_key]["minutes"] += minutes
    return {
        "unplanned_minutes": unplanned_min,
        "planned_minutes": planned_min,
        "stops_count": len(stops),
        "pareto": sorted(pareto.values(), key=lambda x: x["minutes"], reverse=True),
        "sub_pareto": sorted(sub_pareto.values(), key=lambda x: x["minutes"], reverse=True),
    }


# ─── Productivity (pieces produced) ────────────────────────────────────────────
# One production-log row IS one machine·date·shift, so a shift is the atomic unit
# of every breakdown below: pieces/rejects/target come straight off the row, and
# "production hours" is the sum of those shifts' configured window lengths (the
# same basis the OEE cards use) — that is what makes pieces/hour comparable
# across machines running different shift grids.

_PROD_TZ_DEFAULT = "America/Toronto"


async def _plant_tz(db: AsyncSession, plant_id) -> ZoneInfo:
    """Hour-of-day only means something in plant-local time (buckets are UTC)."""
    tzname = None
    if plant_id:
        p = await db.get(Plant, plant_id)
        tzname = p.timezone if p else None
    if not tzname:
        tzname = (await db.execute(select(Plant.timezone).limit(1))).scalar()
    try:
        return ZoneInfo(tzname or _PROD_TZ_DEFAULT)
    except Exception:
        return ZoneInfo(_PROD_TZ_DEFAULT)


def _report_window(period_days: int, start: Optional[date], end: Optional[date],
                   tz: ZoneInfo) -> tuple[datetime, datetime, date, date]:
    """The analysis window every Machine Reports endpoint runs on. A custom range
    (start+end, inclusive, read as plant-local days) overrides the trailing
    `period_days`, which stays as the fallback for callers that pass no dates.
    Returns (since, until, start_date, end_date): timestamps for the event tables,
    plain dates for the Date-keyed ones (production logs, costs).

    `until` matters as much as `since`: a range ending in the past must not pull in
    everything recorded after it."""
    now = datetime.now(timezone.utc)
    if start and end:
        if end < start:
            raise HTTPException(422, "invalid_range")
        since = datetime.combine(start, time.min, tzinfo=tz).astimezone(timezone.utc)
        until = datetime.combine(end, time.max, tzinfo=tz).astimezone(timezone.utc)
        return since, until, start, end
    since = now - timedelta(days=period_days)
    return since, now, since.date(), now.date()


def _pct(num: float, den: float) -> Optional[float]:
    return round(num / den * 100, 1) if den else None


def _shift_value(shift) -> str:
    return shift.value if hasattr(shift, "value") else str(shift or "")


def _new_bucket(key: str, label: str, **extra) -> dict:
    b = {"key": key, "label": label, "pieces": 0, "rejects": 0, "target": 0,
         "hours": 0.0, "shifts": 0, "oee_sum": 0.0, "oee_n": 0,
         "machines": set(), "dates": set(), "operators": set()}
    b.update(extra)
    return b


def _add_to_bucket(b: dict, row, hours: float) -> None:
    b["pieces"] += int(row.actual_count or 0)
    b["rejects"] += int(row.reject_count or 0)
    b["target"] += int(row.target_count or 0)
    b["hours"] += hours
    b["shifts"] += 1
    if row.oee_pct:
        b["oee_sum"] += float(row.oee_pct)
        b["oee_n"] += 1
    b["machines"].add(row.machine_id)
    b["dates"].add(row.date)
    if row.operator_name:
        b["operators"].add(row.operator_name)


def _close_bucket(b: dict) -> dict:
    pieces, rejects, target = b["pieces"], b["rejects"], b["target"]
    good = pieces - rejects
    days, shifts, hours = len(b["dates"]), b["shifts"], b["hours"]
    out = {
        "key": b["key"],
        "label": b["label"],
        "pieces": pieces,
        "rejects": rejects,
        "good_pieces": good,
        "target": target,
        "attainment_pct": _pct(pieces, target),      # actual vs planned output
        "quality_pct": _pct(good, pieces),           # first-pass good rate
        "scrap_pct": _pct(rejects, pieces),
        "production_hours": round(hours, 1),
        "pieces_per_hour": round(pieces / hours, 1) if hours else None,
        "shifts": shifts,
        "pieces_per_shift": round(pieces / shifts) if shifts else None,
        "days": days,
        "pieces_per_day": round(pieces / days) if days else None,
        "machines": len(b["machines"]),
        "operators": len(b["operators"]),
        "oee_pct": round(b["oee_sum"] / b["oee_n"], 1) if b["oee_n"] else None,
    }
    # Carry caller-supplied extras (code, department, shift, machine_id, flags…)
    # while dropping the internal accumulators — `dates` in particular is a set
    # per bucket, which would balloon the payload for nothing.
    for k, v in b.items():
        if k not in out and k not in ("hours", "oee_sum", "oee_n", "dates"):
            out[k] = v
    return out


def _prod_log_query(start_date: date, end_date: date):
    """Shift production logs joined to their machine (name/department/shift grid)."""
    return (
        select(
            MachineProductionLog.machine_id,
            MachineProductionLog.date,
            MachineProductionLog.shift,
            MachineProductionLog.target_count,
            MachineProductionLog.actual_count,
            MachineProductionLog.reject_count,
            MachineProductionLog.oee_pct,
            MachineProductionLog.operator_name,
            MachineProductionLog.job_number,
            Machine.name.label("machine_name"),
            Machine.display_name.label("machine_display_name"),
            Machine.code.label("machine_code"),
            Machine.department.label("machine_department"),
            Machine.shifts_config,
        )
        .join(Machine, MachineProductionLog.machine_id == Machine.id)
        .where(MachineProductionLog.date >= start_date, MachineProductionLog.date <= end_date)
    )


def _aggregate_production(rows: list) -> dict:
    """Fold shift logs into every breakdown the productivity views need. `rows`
    come from `_prod_log_query`, already filtered/scoped by the caller."""
    totals = _new_bucket("total", "total")
    by_machine: dict = {}
    by_shift: dict = {}
    by_operator: dict = {}
    by_department: dict = {}
    by_date: dict = {}
    by_weekday: dict = {}
    matrix: dict = {}

    for r in rows:
        sv = _shift_value(r.shift)
        hours = shift_length_minutes(r.shifts_config, sv) / 60.0
        label = r.machine_display_name or r.machine_name
        _add_to_bucket(totals, r, hours)

        b = by_machine.setdefault(str(r.machine_id), _new_bucket(
            str(r.machine_id), label, code=r.machine_code, department=r.machine_department))
        _add_to_bucket(b, r, hours)

        b = by_shift.setdefault(sv, _new_bucket(sv, sv))
        _add_to_bucket(b, r, hours)

        # No operator on the row → an explicit "unattributed" bucket, never a
        # silent drop: the report must show how much output nobody is credited for.
        op_key = r.operator_name or ""
        b = by_operator.setdefault(op_key, _new_bucket(
            op_key, r.operator_name or "", unattributed=not r.operator_name))
        _add_to_bucket(b, r, hours)

        dep_key = r.machine_department or ""
        b = by_department.setdefault(dep_key, _new_bucket(
            dep_key, r.machine_department or "", unassigned=not r.machine_department))
        _add_to_bucket(b, r, hours)

        iso = r.date.isoformat()
        b = by_date.setdefault(iso, _new_bucket(iso, iso))
        _add_to_bucket(b, r, hours)

        wd = str(r.date.weekday())          # 0 = Monday
        b = by_weekday.setdefault(wd, _new_bucket(wd, wd))
        _add_to_bucket(b, r, hours)

        mk = f"{r.machine_id}|{sv}"
        b = matrix.setdefault(mk, _new_bucket(
            mk, label, shift=sv, machine_id=str(r.machine_id)))
        _add_to_bucket(b, r, hours)

    def ranked(d: dict) -> list:
        return sorted((_close_bucket(b) for b in d.values()),
                      key=lambda x: x["pieces"] or 0, reverse=True)

    shift_order = [s.value for s in AlertShift]
    return {
        "totals": _close_bucket(totals),
        "by_machine": ranked(by_machine),
        "by_shift": sorted(
            (_close_bucket(b) for b in by_shift.values()),
            key=lambda x: shift_order.index(x["key"]) if x["key"] in shift_order else 99),
        "by_operator": ranked(by_operator),
        "by_department": ranked(by_department),
        "by_weekday": sorted((_close_bucket(b) for b in by_weekday.values()),
                             key=lambda x: int(x["key"])),
        "trend": [
            {"date": b["key"], "pieces": b["pieces"], "rejects": b["rejects"],
             "target": b["target"], "good_pieces": b["pieces"] - b["rejects"]}
            for b in sorted(by_date.values(), key=lambda x: x["key"])
        ],
        "machine_shift": [_close_bucket(b) for b in matrix.values()],
    }


async def _hour_of_day(db: AsyncSession, since: datetime, until: datetime,
                       tz: ZoneInfo, machine_ids: Optional[list] = None,
                       ctx: Optional[PlantContext] = None) -> dict:
    """Pieces by hour of the plant-local day, from the REAL per-hour buckets
    (machine_production_hourly — the ADAM/end-of-line-scan feed). Only machines
    wired to that feed contribute, so the result reports how many did: the UI says
    so instead of implying the whole plant. Never synthesises a curve from shift
    totals (the kiosk does that for its live chart; a report must not)."""
    q = select(
        MachineProductionHourly.hour, MachineProductionHourly.count,
        MachineProductionHourly.reject_count, MachineProductionHourly.machine_id,
    ).where(MachineProductionHourly.hour >= since, MachineProductionHourly.hour <= until)
    if machine_ids is not None:
        q = q.where(MachineProductionHourly.machine_id.in_(machine_ids))
    elif ctx is not None:
        q = q.join(Machine, MachineProductionHourly.machine_id == Machine.id) \
             .where(plant_condition(Machine, ctx))
    rows = (await db.execute(q)).all()

    hours = [{"hour": h, "pieces": 0, "rejects": 0} for h in range(24)]
    machines = set()
    for r in rows:
        local = _as_utc(r.hour).astimezone(tz)
        hours[local.hour]["pieces"] += int(r.count or 0)
        hours[local.hour]["rejects"] += int(r.reject_count or 0)
        machines.add(r.machine_id)
    total = sum(h["pieces"] for h in hours)
    return {
        "hours": hours,
        "machines": len(machines),
        "pieces": total,
        "peak_hour": max(hours, key=lambda h: h["pieces"])["hour"] if total else None,
    }


async def _by_job_order(db: AsyncSession, since: datetime,
                        machine_ids: Optional[list] = None,
                        ctx: Optional[PlantContext] = None, limit: int = 20,
                        until: Optional[datetime] = None) -> list:
    """Pieces per OF (ordre de fabrication) from the runs — the authoritative
    per-OF count (JobOrderRun.pieces), summed over every passage in the window."""
    pieces = func.coalesce(func.sum(JobOrderRun.pieces), 0)
    q = (
        select(
            JobOrder.job_number, JobOrder.product_name,
            JobOrder.target_quantity, JobOrder.status,
            pieces.label("pieces"),
            func.coalesce(func.sum(JobOrderRun.rejects), 0).label("rejects"),
            func.coalesce(func.sum(JobOrderRun.duration_minutes), 0).label("minutes"),
            func.count(JobOrderRun.id).label("runs"),
            func.count(func.distinct(JobOrderRun.machine_id)).label("machines"),
        )
        .join(JobOrder, JobOrderRun.job_order_id == JobOrder.id)
        .where(JobOrderRun.started_at >= since,
               *([JobOrderRun.started_at <= until] if until is not None else []))
        .group_by(JobOrder.id, JobOrder.job_number, JobOrder.product_name,
                  JobOrder.target_quantity, JobOrder.status)
        .order_by(pieces.desc())
        .limit(limit)
    )
    if machine_ids is not None:
        q = q.where(JobOrderRun.machine_id.in_(machine_ids))
    elif ctx is not None:
        q = q.where(plant_condition(JobOrderRun, ctx))
    rows = (await db.execute(q)).all()
    out = []
    for r in rows:
        p, rej, mins = int(r.pieces or 0), int(r.rejects or 0), int(r.minutes or 0)
        out.append({
            "job_number": r.job_number,
            "product_name": r.product_name,
            "target_quantity": r.target_quantity,
            "status": r.status.value if hasattr(r.status, "value") else str(r.status),
            "pieces": p,
            "rejects": rej,
            "good_pieces": p - rej,
            "completion_pct": _pct(p, r.target_quantity or 0),
            "quality_pct": _pct(p - rej, p),
            "runs": int(r.runs or 0),
            "machines": int(r.machines or 0),
            "minutes": mins,
            "pieces_per_hour": round(p / (mins / 60.0), 1) if mins else None,
        })
    return out


@router.get("/machine/{machine_id}")
async def machine_report(
    machine_id: UUID,
    period_days: int = Query(30, ge=1, le=365),
    start: Optional[date] = Query(None, description="custom range start (inclusive)"),
    end: Optional[date] = Query(None, description="custom range end (inclusive)"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    machine = await _resolve_entity_machine(db, machine_id)
    if not machine:
        raise HTTPException(404, "Equipment / machine not found")
    ensure_same_plant(machine, ctx, detail="Equipment / machine not found")

    # `now` stays the clock for as-of-today figures (backlog age); `until` is the
    # window end, which may well be in the past.
    now = datetime.now(timezone.utc)
    tz = await _plant_tz(db, machine.plant_id)
    since, until, since_date, end_date = _report_window(period_days, start, end, tz)
    eq_ids = await _equipment_ids_for(db, machine)
    if machine_id not in eq_ids:        # the selected catalog id always counts for WO/cost
        eq_ids.append(machine_id)
    wo_cond = _wo_filter(machine.id, eq_ids)

    # ── Stops: availability trend, downtime, Pareto ──────────────────────────
    stops = await _fetch_stops(db, since, machine.id, until)
    working = await working_dates(db, since_date, end_date, [machine.id])
    trend, avg_availability, planned_hours = _availability_over_period(
        machine, stops, since_date, end_date, working
    )
    downtime = _downtime_summary(stops)

    # ── OEE from production logs ─────────────────────────────────────────────
    oee_rows = (await db.execute(
        select(
            MachineProductionLog.date,
            func.avg(MachineProductionLog.oee_pct).label("oee"),
            func.avg(MachineProductionLog.performance_pct).label("perf"),
            func.avg(MachineProductionLog.quality_pct).label("qual"),
        )
        .where(
            MachineProductionLog.machine_id == machine.id,
            MachineProductionLog.date >= since_date,
            MachineProductionLog.date <= end_date,
            MachineProductionLog.oee_pct > 0,
        )
        .group_by(MachineProductionLog.date)
        .order_by(MachineProductionLog.date)
    )).all()
    oee_trend = [{"date": r.date.isoformat(), "pct": round(float(r.oee), 1)} for r in oee_rows]
    avg_oee = round(sum(float(r.oee) for r in oee_rows) / len(oee_rows), 1) if oee_rows else None
    avg_perf = round(sum(float(r.perf) for r in oee_rows) / len(oee_rows), 1) if oee_rows else None
    avg_qual = round(sum(float(r.qual) for r in oee_rows) / len(oee_rows), 1) if oee_rows else None

    # ── Productivity: pieces produced, by shift / operator / OF / hour ───────
    prod_rows = (await db.execute(
        _prod_log_query(since_date, end_date).where(
            MachineProductionLog.machine_id == machine.id)
    )).all()
    prod = _aggregate_production(prod_rows)
    prod_totals = {k: v for k, v in prod["totals"].items() if k not in ("key", "label")}
    production = {
        **prod_totals,
        "trend": prod["trend"],
        "best_day": max(prod["trend"], key=lambda d: d["pieces"], default=None),
        "by_shift": prod["by_shift"],
        "by_operator": prod["by_operator"],
        "by_weekday": prod["by_weekday"],
        "by_hour": await _hour_of_day(db, since, until, tz, machine_ids=[machine.id]),
        "by_job_order": await _by_job_order(db, since, machine_ids=[machine.id], limit=12,
                                            until=until),
        "target_per_shift": machine.target_count_per_shift,
        "target_per_hour": machine.target_count_per_hour,
    }

    # ── MTTR (corrective completed WOs) ──────────────────────────────────────
    mttr_r = (await db.execute(
        select(func.avg(WorkOrder.repair_hours), func.count(WorkOrder.id)).where(
            and_(
                wo_cond,
                WorkOrder.type == WorkOrderType.corrective,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.completed_at >= since,
                WorkOrder.completed_at <= until,
                WorkOrder.repair_hours.isnot(None),
            )
        )
    )).one()
    mttr_hours = round(float(mttr_r[0]), 2) if mttr_r[0] is not None else None
    repairs = int(mttr_r[1] or 0)

    # ── Failures and MTBF ────────────────────────────────────────────────────
    failures = (await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(wo_cond, WorkOrder.type == WorkOrderType.corrective,
                 WorkOrder.opened_at >= since, WorkOrder.opened_at <= until)
        )
    )).scalar() or 0
    if failures == 0:
        failures = (await db.execute(
            select(func.count(MaintenanceTicket.id)).where(
                MaintenanceTicket.machine_id == machine.id,
                MaintenanceTicket.opened_at >= since,
                MaintenanceTicket.opened_at <= until,
            )
        )).scalar() or 0
    uptime_hours = max(0.0, planned_hours - downtime["unplanned_minutes"] / 60)
    mtbf_hours = round(uptime_hours / failures, 1) if failures > 0 else None

    # ── PM compliance ────────────────────────────────────────────────────────
    pm_total = (await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(wo_cond, WorkOrder.type == WorkOrderType.preventive,
                 WorkOrder.opened_at >= since, WorkOrder.opened_at <= until)
        )
    )).scalar() or 0
    pm_on_time = (await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(
                wo_cond,
                WorkOrder.type == WorkOrderType.preventive,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.opened_at >= since,
                WorkOrder.opened_at <= until,
                WorkOrder.completed_at.isnot(None),
                WorkOrder.due_date.isnot(None),
                WorkOrder.completed_at <= WorkOrder.due_date,
            )
        )
    )).scalar() or 0

    # ── Backlog ──────────────────────────────────────────────────────────────
    backlog_rows = (await db.execute(
        select(WorkOrder.opened_at).where(and_(wo_cond, WorkOrder.status.in_(OPEN_WO_STATUSES)))
    )).all()
    buckets = {"0_7": 0, "7_30": 0, "30_plus": 0}
    for row in backlog_rows:
        age = (now - _as_utc(row.opened_at)).days
        if age <= 7:
            buckets["0_7"] += 1
        elif age <= 30:
            buckets["7_30"] += 1
        else:
            buckets["30_plus"] += 1

    # ── Costs ────────────────────────────────────────────────────────────────
    cost_rows = (await db.execute(
        select(WOCost.transaction_type, func.sum(WOCost.amount).label("total"))
        .join(WorkOrder, WOCost.work_order_id == WorkOrder.id)
        .where(and_(wo_cond, WOCost.date >= since_date, WOCost.date <= end_date))
        .group_by(WOCost.transaction_type)
    )).all()
    costs_by_type = [{"type": r.transaction_type, "total": round(float(r.total), 2)} for r in cost_rows]

    # Parts used: WO parts + approved intervention parts (priced from stock)
    wo_parts_sum = (await db.execute(
        select(func.sum(WOPart.total_cost))
        .join(WorkOrder, WOPart.work_order_id == WorkOrder.id)
        .where(and_(wo_cond, WOPart.created_at >= since, WOPart.created_at <= until,
                    WOPart.total_cost.isnot(None)))
    )).scalar() or 0.0
    ip_cond = [MachineIntervention.machine_id == machine.id]
    if eq_ids:
        ip_cond.append(MachineIntervention.equipment_id.in_(eq_ids))
    int_parts_sum = (await db.execute(
        select(func.sum(InterventionPart.total_cost))
        .join(MachineIntervention, InterventionPart.intervention_id == MachineIntervention.id)
        .where(
            or_(*ip_cond),
            InterventionPart.approval_status == "approved",
            InterventionPart.added_at >= since,
            InterventionPart.added_at <= until,
            InterventionPart.total_cost.isnot(None),
        )
    )).scalar() or 0.0
    parts_cost = round(float(wo_parts_sum) + float(int_parts_sum), 2)
    if parts_cost:
        costs_by_type.append({"type": "parts_used", "total": parts_cost})
    total_cost = round(sum(c["total"] for c in costs_by_type), 2)

    # ── Interventions (call flow) ────────────────────────────────────────────
    int_cond = [MachineIntervention.machine_id == machine.id]
    if eq_ids:
        int_cond.append(MachineIntervention.equipment_id.in_(eq_ids))
    int_r = (await db.execute(
        select(
            func.count(MachineIntervention.id),
            func.avg(MachineIntervention.response_time_minutes),
            func.avg(MachineIntervention.intervention_duration_minutes),
            func.avg(MachineIntervention.total_downtime_minutes),
        ).where(
            or_(*int_cond),
            MachineIntervention.status == "completed",
            MachineIntervention.called_at >= since,
            MachineIntervention.called_at <= until,
        )
    )).one()

    # Fall back to intervention data when the WO universe has no repair records
    int_count = int(int_r[0] or 0)
    if repairs == 0 and int_count > 0 and int_r[2] is not None:
        mttr_hours = round(float(int_r[2]) / 60, 2)
        repairs = int_count
    if failures == 0 and int_count > 0:
        failures = int_count
        mtbf_hours = round(uptime_hours / failures, 1)

    # ── Tickets ──────────────────────────────────────────────────────────────
    tickets_opened = (await db.execute(
        select(func.count(MaintenanceTicket.id)).where(
            MaintenanceTicket.machine_id == machine.id,
            MaintenanceTicket.opened_at >= since,
            MaintenanceTicket.opened_at <= until,
        )
    )).scalar() or 0
    resolution_r = (await db.execute(
        select(func.avg(
            func.extract("epoch", MaintenanceTicket.completed_at) -
            func.extract("epoch", MaintenanceTicket.opened_at)
        )).where(
            MaintenanceTicket.machine_id == machine.id,
            MaintenanceTicket.opened_at >= since,
            MaintenanceTicket.opened_at <= until,
            MaintenanceTicket.completed_at.isnot(None),
        )
    )).scalar()
    avg_resolution_hours = round(float(resolution_r) / 3600, 1) if resolution_r else None
    avg_resolution_seconds = round(float(resolution_r), 1) if resolution_r else None

    return {
        "machine": {
            "id": str(machine.id),
            "name": machine.display_name or machine.name,
            "code": machine.code,
            "department": machine.department,
            "equipment_id": str(machine.equipment_id) if machine.equipment_id else None,
            "target_availability_pct": machine.target_availability_pct or 70.0,
        },
        "period_days": period_days,
        "start": since_date.isoformat(),
        "end": end_date.isoformat(),
        "custom_range": bool(start and end),
        "availability": {"avg_pct": avg_availability, "trend": trend},
        "oee": {
            "avg_oee_pct": avg_oee,
            "avg_performance_pct": avg_perf,
            "avg_quality_pct": avg_qual,
            "trend": oee_trend,
        },
        "downtime": downtime,
        "production": production,
        "mttr": {"hours": mttr_hours, "repairs": repairs},
        "mtbf": {"hours": mtbf_hours, "failures": int(failures)},
        "pm_compliance": {
            "pct": round(pm_on_time / pm_total * 100, 1) if pm_total > 0 else None,
            "total": int(pm_total),
            "on_time": int(pm_on_time),
        },
        "backlog": {
            "total": len(backlog_rows),
            "buckets": [
                {"label": "0–7", "count": buckets["0_7"]},
                {"label": "7–30", "count": buckets["7_30"]},
                {"label": "30+", "count": buckets["30_plus"]},
            ],
        },
        "costs": {"total": total_cost, "by_type": costs_by_type},
        "interventions": {
            "count": int(int_r[0] or 0),
            "avg_response_minutes": round(float(int_r[1]), 1) if int_r[1] is not None else None,
            "avg_duration_minutes": round(float(int_r[2]), 1) if int_r[2] is not None else None,
            "avg_downtime_minutes": round(float(int_r[3]), 1) if int_r[3] is not None else None,
        },
        "tickets": {"opened": int(tickets_opened), "avg_resolution_hours": avg_resolution_hours, "avg_resolution_seconds": avg_resolution_seconds},
    }


@router.get("/machines/compare")
async def compare_machines(
    period_days: int = Query(30, ge=1, le=365),
    start: Optional[date] = Query(None, description="custom range start (inclusive)"),
    end: Optional[date] = Query(None, description="custom range end (inclusive)"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    # Backlog is "as of now" by definition; everything else honours the window.
    tz = await _plant_tz(db, ctx.plant_id)
    since, until, since_date, end_date = _report_window(period_days, start, end, tz)

    # Canonical entity list = the Equipment catalog (matches the Equipment page);
    # resolve each to the Machine that actually carries the floor data.
    # Auxiliary (utility) assets have no MES/OEE layer — exclude them from the
    # per-machine comparison (coalesce so legacy NULL rows count as production).
    equipment = (await db.execute(
        select(Equipment)
        .where(
            Equipment.active == True,
            func.coalesce(Equipment.asset_type, "production") != "auxiliary",
            plant_condition(Equipment, ctx),
        )
        .order_by(Equipment.name)
    )).scalars().all()
    if not equipment:
        return {"period_days": period_days, "start": since_date.isoformat(),
                "end": end_date.isoformat(), "custom_range": bool(start and end),
                "items": []}

    entities = [(eq, await _resolve_entity_machine(db, eq.id)) for eq in equipment]
    entities = [(eq, m) for eq, m in entities if m is not None]

    machine_ids = {m.id for _, m in entities}
    eq_to_machine: dict = {}
    for eq, m in entities:
        eq_to_machine[eq.id] = m.id
        if m.equipment_id:
            eq_to_machine[m.equipment_id] = m.id

    def wo_machine(wo_machine_id, wo_equipment_id):
        if wo_machine_id in machine_ids:
            return wo_machine_id
        return eq_to_machine.get(wo_equipment_id)

    # ── Batch queries ────────────────────────────────────────────────────────
    all_stops = await _fetch_stops(db, since, None, until)
    stops_by_machine: dict = {}
    for s in all_stops:
        stops_by_machine.setdefault(s["machine_id"], []).append(s)

    oee_rows = (await db.execute(
        select(MachineProductionLog.machine_id, func.avg(MachineProductionLog.oee_pct))
        .where(MachineProductionLog.date >= since_date,
               MachineProductionLog.date <= end_date,
               MachineProductionLog.oee_pct > 0)
        .group_by(MachineProductionLog.machine_id)
    )).all()
    oee_by_machine = {r[0]: round(float(r[1]), 1) for r in oee_rows}

    wo_rows = (await db.execute(
        select(
            WorkOrder.machine_id, WorkOrder.equipment_id, WorkOrder.type,
            WorkOrder.status, WorkOrder.repair_hours, WorkOrder.opened_at,
            WorkOrder.completed_at,
        ).where(WorkOrder.opened_at >= since, WorkOrder.opened_at <= until)
    )).all()

    open_rows = (await db.execute(
        select(WorkOrder.machine_id, WorkOrder.equipment_id)
        .where(WorkOrder.status.in_(OPEN_WO_STATUSES))
    )).all()

    cost_rows = (await db.execute(
        select(WorkOrder.machine_id, WorkOrder.equipment_id, func.sum(WOCost.amount))
        .join(WorkOrder, WOCost.work_order_id == WorkOrder.id)
        .where(WOCost.date >= since_date, WOCost.date <= end_date)
        .group_by(WorkOrder.machine_id, WorkOrder.equipment_id)
    )).all()

    wo_parts_rows = (await db.execute(
        select(WorkOrder.machine_id, WorkOrder.equipment_id, func.sum(WOPart.total_cost))
        .join(WorkOrder, WOPart.work_order_id == WorkOrder.id)
        .where(WOPart.created_at >= since, WOPart.created_at <= until,
               WOPart.total_cost.isnot(None))
        .group_by(WorkOrder.machine_id, WorkOrder.equipment_id)
    )).all()

    int_parts_rows = (await db.execute(
        select(
            MachineIntervention.machine_id, MachineIntervention.equipment_id,
            func.sum(InterventionPart.total_cost),
        )
        .join(MachineIntervention, InterventionPart.intervention_id == MachineIntervention.id)
        .where(
            InterventionPart.approval_status == "approved",
            InterventionPart.added_at >= since,
            InterventionPart.added_at <= until,
            InterventionPart.total_cost.isnot(None),
        )
        .group_by(MachineIntervention.machine_id, MachineIntervention.equipment_id)
    )).all()

    int_rows = (await db.execute(
        select(
            MachineIntervention.machine_id, MachineIntervention.equipment_id,
            MachineIntervention.response_time_minutes,
            MachineIntervention.intervention_duration_minutes,
        ).where(
            MachineIntervention.status == "completed",
            MachineIntervention.called_at >= since,
            MachineIntervention.called_at <= until,
        )
    )).all()

    ticket_rows = (await db.execute(
        select(MaintenanceTicket.machine_id, func.count(MaintenanceTicket.id))
        .where(MaintenanceTicket.opened_at >= since, MaintenanceTicket.opened_at <= until)
        .group_by(MaintenanceTicket.machine_id)
    )).all()
    tickets_by_machine = {r[0]: int(r[1]) for r in ticket_rows}

    # ── Aggregate per machine ────────────────────────────────────────────────
    agg = {
        m.id: {"repair_sum": 0.0, "repairs": 0, "failures": 0, "cost": 0.0,
               "backlog": 0, "responses": [], "durations": [], "int_count": 0}
        for _, m in entities
    }
    for r in wo_rows:
        mid = wo_machine(r.machine_id, r.equipment_id)
        if mid is None:
            continue
        if r.type == WorkOrderType.corrective:
            agg[mid]["failures"] += 1
            if r.status == WorkOrderStatus.completed and r.repair_hours is not None:
                agg[mid]["repair_sum"] += float(r.repair_hours)
                agg[mid]["repairs"] += 1
    for r in open_rows:
        mid = wo_machine(r.machine_id, r.equipment_id)
        if mid is not None:
            agg[mid]["backlog"] += 1
    for r in cost_rows:
        mid = wo_machine(r[0], r[1])
        if mid is not None and r[2] is not None:
            agg[mid]["cost"] += float(r[2])
    for r in wo_parts_rows:
        mid = wo_machine(r[0], r[1])
        if mid is not None and r[2] is not None:
            agg[mid]["cost"] += float(r[2])
    for r in int_parts_rows:
        mid = r[0] if r[0] in machine_ids else eq_to_machine.get(r[1])
        if mid is not None and r[2] is not None:
            agg[mid]["cost"] += float(r[2])
    for r in int_rows:
        mid = r.machine_id if r.machine_id in machine_ids else eq_to_machine.get(r.equipment_id)
        if mid is None:
            continue
        agg[mid]["int_count"] += 1
        if r.response_time_minutes is not None:
            agg[mid]["responses"].append(float(r.response_time_minutes))
        if r.intervention_duration_minutes is not None:
            agg[mid]["durations"].append(float(r.intervention_duration_minutes))

    items = []
    for eq, m in entities:
        m_stops = stops_by_machine.get(m.id, [])
        working = await working_dates(db, since_date, end_date, [m.id])
        _, avg_availability, planned_hours = _availability_over_period(
            m, m_stops, since_date, end_date, working
        )
        downtime = _downtime_summary(m_stops)
        a = agg[m.id]
        uptime_hours = max(0.0, planned_hours - downtime["unplanned_minutes"] / 60)

        # Fall back to intervention/ticket data when WOs carry no repair records
        if a["repairs"] > 0:
            mttr_hours = round(a["repair_sum"] / a["repairs"], 2)
            repairs = a["repairs"]
        elif a["durations"]:
            mttr_hours = round(sum(a["durations"]) / len(a["durations"]) / 60, 2)
            repairs = len(a["durations"])
        else:
            mttr_hours, repairs = None, 0
        failures = a["failures"] or tickets_by_machine.get(m.id, 0) or a["int_count"]

        items.append({
            "machine_id": str(eq.id),
            "name": eq.name,
            "code": eq.code,
            "department": eq.location,
            "target_availability_pct": m.target_availability_pct or 70.0,
            "availability_pct": avg_availability,
            "oee_pct": oee_by_machine.get(m.id),
            "downtime_minutes": downtime["unplanned_minutes"],
            "stops_count": downtime["stops_count"],
            "mttr_hours": mttr_hours,
            "repairs": repairs,
            "failures": failures,
            "mtbf_hours": round(uptime_hours / failures, 1) if failures > 0 else None,
            "total_cost": round(a["cost"], 2),
            "backlog_count": a["backlog"],
            "avg_response_minutes": round(sum(a["responses"]) / len(a["responses"]), 1) if a["responses"] else None,
        })

    return {"period_days": period_days, "start": since_date.isoformat(),
            "end": end_date.isoformat(), "custom_range": bool(start and end),
            "items": items}


# ─── Productivity filters, facets and comparison ───────────────────────────────
# The overview and the comparison read the SAME filtered row set, so both live on
# these helpers: one window resolver, one query builder, one facet query. That is
# what keeps "compare machines" and "pieces by machine" from ever disagreeing.

COMPARE_DIMENSIONS = ("machine", "operator", "shift", "department")


async def _auxiliary_equipment_ids(db: AsyncSession, ctx: PlantContext) -> list:
    """Equipment flagged as auxiliary (utility) — no MES layer, so it must never
    appear as a producing machine. Mirrors the Report/Compare tabs' exclusion.
    `asset_type` lives on Equipment; a machine links by equipment_id, or shares
    the id when it was auto-provisioned from the equipment."""
    return list((await db.execute(
        select(Equipment.id).where(
            func.coalesce(Equipment.asset_type, "production") == "auxiliary",
            plant_condition(Equipment, ctx),
        )
    )).scalars().all())


def _prod_filtered_query(start_date: date, end_date: date, ctx: PlantContext,
                         aux_ids: list, *, shift: Optional[str] = None,
                         department: Optional[str] = None,
                         machine_ids: Optional[list] = None,
                         operators: Optional[list] = None,
                         unattributed: bool = False):
    """The plant's shift production logs for the window, minus auxiliary assets,
    narrowed by the request's filters. `operators` matches the name snapshot on the
    log; `unattributed=True` widens it to also keep rows with no operator, so
    "these people + whatever nobody claimed" is expressible."""
    q = _prod_log_query(start_date, end_date).where(
        plant_condition(MachineProductionLog, ctx))
    if aux_ids:
        q = q.where(
            ~Machine.id.in_(aux_ids),
            or_(Machine.equipment_id.is_(None), ~Machine.equipment_id.in_(aux_ids)),
        )
    if shift:
        try:
            shift_enum = AlertShift(shift)
        except ValueError:
            raise HTTPException(422, "invalid_shift")
        q = q.where(MachineProductionLog.shift == shift_enum)
    if department:
        q = q.where(Machine.department == department)
    if machine_ids:
        q = q.where(MachineProductionLog.machine_id.in_(machine_ids))
    if operators:
        cond = MachineProductionLog.operator_name.in_(operators)
        if unattributed:
            cond = or_(cond, MachineProductionLog.operator_name.is_(None))
        q = q.where(cond)
    elif unattributed:
        q = q.where(MachineProductionLog.operator_name.is_(None))
    return q


async def _prod_facets(db: AsyncSession, ctx: PlantContext, start_date: date,
                       end_date: date, aux_ids: list) -> dict:
    """Everything the filter/compare pickers can offer, computed WITHOUT the
    request's own filters — otherwise selecting one machine would empty the machine
    list. Only entities that actually produced in the window are offered."""
    rows = (await db.execute(
        select(
            MachineProductionLog.machine_id,
            MachineProductionLog.operator_name,
            Machine.name, Machine.display_name, Machine.code, Machine.department,
            func.sum(MachineProductionLog.actual_count).label("pieces"),
        )
        .join(Machine, MachineProductionLog.machine_id == Machine.id)
        .where(
            MachineProductionLog.date >= start_date,
            MachineProductionLog.date <= end_date,
            plant_condition(MachineProductionLog, ctx),
            *([~Machine.id.in_(aux_ids),
               or_(Machine.equipment_id.is_(None), ~Machine.equipment_id.in_(aux_ids))]
              if aux_ids else []),
        )
        .group_by(
            MachineProductionLog.machine_id, MachineProductionLog.operator_name,
            Machine.name, Machine.display_name, Machine.code, Machine.department,
        )
    )).all()

    machines: dict = {}
    operators: dict = {}
    for r in rows:
        pieces = int(r.pieces or 0)
        m = machines.setdefault(str(r.machine_id), {
            "id": str(r.machine_id),
            "label": r.display_name or r.name,
            "code": r.code,
            "department": r.department,
            "pieces": 0,
        })
        m["pieces"] += pieces
        if r.operator_name:
            o = operators.setdefault(r.operator_name, {"name": r.operator_name, "pieces": 0})
            o["pieces"] += pieces
    return {
        # Busiest first: with dozens of machines the useful ones are at the top.
        "machines": sorted(machines.values(), key=lambda m: -m["pieces"]),
        "operators": sorted(operators.values(), key=lambda o: -o["pieces"]),
        "departments": sorted({m["department"] for m in machines.values() if m["department"]}),
        "shifts": [s.value for s in AlertShift],
    }


def _dim_identity(row, dimension: str) -> tuple[str, str, dict]:
    """(key, label, extras) of a row along a comparison dimension."""
    if dimension == "machine":
        return (str(row.machine_id), row.machine_display_name or row.machine_name,
                {"code": row.machine_code, "department": row.machine_department})
    if dimension == "operator":
        return (row.operator_name or "", row.operator_name or "",
                {"unattributed": not row.operator_name})
    if dimension == "shift":
        sv = _shift_value(row.shift)
        return sv, sv, {}
    return (row.machine_department or "", row.machine_department or "",
            {"unassigned": not row.machine_department})


def _compare_available(rows: list, dimension: str) -> list:
    """Every entity present in the filtered rows, with just enough to populate the
    comparison picker (key/label/pieces). Deliberately NOT `_compare_entities`:
    that builds a daily series and a cross-breakdown per entity, which is pure
    waste when all the picker needs is a ranked list of names."""
    tally: dict = {}
    for r in rows:
        key, label, extras = _dim_identity(r, dimension)
        e = tally.get(key)
        if e is None:
            e = tally[key] = {"key": key, "label": label, "pieces": 0, **extras}
        e["pieces"] += int(r.actual_count or 0)
    return sorted(tally.values(), key=lambda e: -e["pieces"])


def _compare_entities(rows: list, dimension: str, keys: Optional[list],
                      top: int) -> tuple[list, list]:
    """Per-entity metrics + daily series along `dimension`, for side-by-side
    comparison. `keys` pins the entities (order preserved); without it the top
    `top` by pieces are chosen. Returns (entities, dates) where `dates` is the
    union of days any selected entity produced on — the frontend aligns its series
    on it, so a machine idle on a day reads as a gap, not as a shifted curve."""
    ents: dict = {}
    for r in rows:
        key, label, extras = _dim_identity(r, dimension)
        if keys is not None and key not in keys:
            continue
        sv = _shift_value(r.shift)
        hours = shift_length_minutes(r.shifts_config, sv) / 60.0
        e = ents.get(key)
        if e is None:
            e = ents[key] = {
                "bucket": _new_bucket(key, label, **extras),
                "by_date": {},
                "by_shift": {},
                # The cross-breakdown that makes each direction useful: who ran a
                # machine, and which machines an operator ran.
                "cross": {},
            }
        _add_to_bucket(e["bucket"], r, hours)

        iso = r.date.isoformat()
        d = e["by_date"].setdefault(iso, _new_bucket(iso, iso))
        _add_to_bucket(d, r, hours)

        b = e["by_shift"].setdefault(sv, _new_bucket(sv, sv))
        _add_to_bucket(b, r, hours)

        if dimension in ("machine", "shift", "department"):
            ck, clabel = (r.operator_name or ""), (r.operator_name or "")
            cextra = {"unattributed": not r.operator_name}
        else:
            ck = str(r.machine_id)
            clabel = r.machine_display_name or r.machine_name
            cextra = {"code": r.machine_code}
        c = e["cross"].setdefault(ck, _new_bucket(ck, clabel, **cextra))
        _add_to_bucket(c, r, hours)

    if keys is not None:
        ordered = [ents[k] for k in keys if k in ents]
    else:
        ordered = sorted(ents.values(), key=lambda e: -e["bucket"]["pieces"])[:top]

    out = []
    dates = set()
    for e in ordered:
        dates.update(e["by_date"].keys())
        out.append({
            **_close_bucket(e["bucket"]),
            "trend": [
                {"date": b["key"], "pieces": b["pieces"], "rejects": b["rejects"],
                 "good_pieces": b["pieces"] - b["rejects"], "target": b["target"]}
                for b in sorted(e["by_date"].values(), key=lambda x: x["key"])
            ],
            "by_shift": sorted(
                (_close_bucket(b) for b in e["by_shift"].values()),
                key=lambda x: ([s.value for s in AlertShift].index(x["key"])
                               if x["key"] in [s.value for s in AlertShift] else 99)),
            "cross": sorted((_close_bucket(b) for b in e["cross"].values()),
                            key=lambda x: -x["pieces"]),
        })
    return out, sorted(dates)


@router.get("/productivity")
async def productivity_report(
    period_days: int = Query(30, ge=1, le=365),
    start: Optional[date] = Query(None, description="custom range start (inclusive)"),
    end: Optional[date] = Query(None, description="custom range end (inclusive)"),
    shift: Optional[str] = Query(None, description="morning|afternoon|night"),
    department: Optional[str] = Query(None),
    machine_id: Optional[List[UUID]] = Query(None, description="repeatable"),
    operator: Optional[List[str]] = Query(None, description="repeatable, operator name"),
    include_unattributed: bool = Query(False, description="with `operator`, also keep unattributed output"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Plant-wide productivity: pieces produced, broken down by machine, operator,
    shift, department, weekday, hour of day and OF.

    Everything comes off the shift production logs (machine·date·shift) except the
    hour-of-day curve (real per-hour buckets) and the per-OF counts (job-order
    runs) — each reports its own coverage, so a partially-instrumented plant reads
    honestly instead of looking either empty or overstated. `facets` lists the
    filter options for the window, computed unfiltered so the pickers never
    collapse onto the current selection."""
    tz = await _plant_tz(db, ctx.plant_id)
    since, until, start_date, end_date = _report_window(period_days, start, end, tz)
    aux_ids = await _auxiliary_equipment_ids(db, ctx)

    q = _prod_filtered_query(
        start_date, end_date, ctx, aux_ids, shift=shift, department=department,
        machine_ids=machine_id, operators=operator, unattributed=include_unattributed,
    )
    rows = (await db.execute(q)).all()
    agg = _aggregate_production(rows)

    # The OF and hour-of-day feeds are plant-scoped in their own right; as soon as
    # any machine-narrowing filter is on, restrict them to the machines that
    # survived so the whole page describes one slice (an empty list yields nothing).
    narrowed = bool(department or machine_id or operator or include_unattributed)
    scoped_ids = list({r.machine_id for r in rows}) if narrowed else None

    return {
        "period_days": period_days,
        "start": start_date.isoformat(),
        "end": end_date.isoformat(),
        "custom_range": bool(start and end),
        "filters": {
            "shift": shift,
            "department": department,
            "machine_ids": [str(m) for m in (machine_id or [])],
            "operators": operator or [],
            "include_unattributed": include_unattributed,
        },
        "timezone": str(tz),
        "totals": agg["totals"],
        "trend": agg["trend"],
        "best_day": max(agg["trend"], key=lambda d: d["pieces"], default=None),
        "by_machine": agg["by_machine"],
        "by_shift": agg["by_shift"],
        "by_operator": agg["by_operator"],
        "by_department": agg["by_department"],
        "by_weekday": agg["by_weekday"],
        "machine_shift": agg["machine_shift"],
        "by_hour": await _hour_of_day(db, since, until, tz, machine_ids=scoped_ids, ctx=ctx),
        "by_job_order": await _by_job_order(db, since, machine_ids=scoped_ids, ctx=ctx),
        "facets": await _prod_facets(db, ctx, start_date, end_date, aux_ids),
    }


@router.get("/productivity/compare")
async def productivity_compare(
    dimension: str = Query("machine", description="machine|operator|shift|department"),
    key: Optional[List[str]] = Query(None, description="repeatable; entities to compare (default: top by pieces)"),
    top: int = Query(5, ge=1, le=12, description="how many entities when `key` is omitted"),
    period_days: int = Query(30, ge=1, le=365),
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    shift: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    machine_id: Optional[List[UUID]] = Query(None),
    operator: Optional[List[str]] = Query(None),
    include_unattributed: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Side-by-side comparison of machines, operators, shifts or departments over
    the same window and filters as the overview: full metrics per entity, a daily
    series each (aligned on `dates`), their shift split, and a `cross` breakdown —
    who ran a machine, or which machines an operator ran."""
    if dimension not in COMPARE_DIMENSIONS:
        raise HTTPException(422, "invalid_dimension")
    tz = await _plant_tz(db, ctx.plant_id)
    _since, _until, start_date, end_date = _report_window(period_days, start, end, tz)
    aux_ids = await _auxiliary_equipment_ids(db, ctx)

    rows = (await db.execute(_prod_filtered_query(
        start_date, end_date, ctx, aux_ids, shift=shift, department=department,
        machine_ids=machine_id, operators=operator, unattributed=include_unattributed,
    ))).all()
    entities, dates = _compare_entities(rows, dimension, key, top)

    return {
        "dimension": dimension,
        "period_days": period_days,
        "start": start_date.isoformat(),
        "end": end_date.isoformat(),
        "custom_range": bool(start and end),
        "requested_keys": key or [],
        "entities": entities,
        "dates": dates,
        # Same filtered universe the entities came from, so the picker can offer
        # every comparable entity even when only a few are selected.
        "available": _compare_available(rows, dimension),
        "facets": await _prod_facets(db, ctx, start_date, end_date, aux_ids),
    }
