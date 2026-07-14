"""
Maintenance Intelligence — Calculation Engine
=============================================
Pure deterministic logic. No AI, no external calls.
Reads from existing DB tables and produces a structured IntelligenceFindings object.

MTBF strategy: calculated from maintenance_ticket intervals per machine.
  - Requires at least 2 completed tickets for a machine to compute MTBF.
  - When machine_stops table is available (Phase 2), replace _calc_mtbf_from_tickets()
    with a version reading from machine_stops.started_at intervals.

All monetary / time values in their natural units:
  - time  → minutes (intervention) or hours/days (MTBF)
  - cost  → as stored in DB (no conversion)
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select, and_, case
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


def _as_uuid(plant_id) -> Optional[uuid.UUID]:
    """Coerce the plant_id (string, from build_findings) to a UUID for filtering,
    or None (→ no plant restriction) when absent/malformed. build_findings is
    called PER PLANT by the insights cron, so every sub-query must be scoped to
    the plant the finding is stored under — otherwise a plant's AI insight is
    computed from, and names, every other plant's machines/tickets/technicians."""
    if isinstance(plant_id, uuid.UUID):
        return plant_id
    try:
        return uuid.UUID(plant_id) if plant_id else None
    except (ValueError, TypeError, AttributeError):
        return None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def build_findings(
    db: AsyncSession,
    period_days: int = 7,
    plant_id: Optional[str] = None,
) -> dict:
    """
    Main entry point. Runs all sub-analyses and returns a findings dict
    that maps 1:1 to IntelligenceFindings schema.

    Returns a plain dict (not a Pydantic model) so it can be stored as JSON
    and also validated later via IntelligenceFindings(**findings).
    """
    now       = datetime.now(timezone.utc)
    period_end   = now
    period_start = now - timedelta(days=period_days)

    # Previous period (same length) for trend comparisons
    prev_start = period_start - timedelta(days=period_days)
    prev_end   = period_start

    logger.info(
        "Building intelligence findings | period=%d days | %s → %s",
        period_days, period_start.isoformat(), period_end.isoformat()
    )

    warnings: list[str] = []
    pid = _as_uuid(plant_id)   # scope every sub-query to this plant's data

    # ── Run all analyses in parallel-friendly awaits ──────────────────────
    tickets_current  = await _fetch_tickets(db, period_start, period_end, pid)
    tickets_previous = await _fetch_tickets(db, prev_start, prev_end, pid)
    alerts_current   = await _fetch_alerts(db, period_start, period_end, pid)
    all_machines     = await _fetch_machines(db, pid)
    all_parts        = await _fetch_parts_consumption(db, period_days)

    # ── Summary counts ────────────────────────────────────────────────────
    total_tickets         = len(tickets_current)
    total_alerts          = len(alerts_current)
    total_downtime_min    = sum(
        t.get("total_intervention_minutes") or 0 for t in tickets_current
    )
    overdue_alerts        = sum(1 for a in alerts_current if a.get("is_overdue"))

    # ── MTTR ──────────────────────────────────────────────────────────────
    avg_mttr, mttr_trend, mttr_change_pct = _calc_mttr_trend(
        tickets_current, tickets_previous, warnings
    )

    # ── MTBF (from ticket intervals) ──────────────────────────────────────
    mtbf_result = await _calc_mtbf_from_tickets(db, period_days, warnings, pid)

    # ── Machine risk scores ───────────────────────────────────────────────
    machine_risks = await _calc_machine_risks(
        db, tickets_current, all_machines, period_days, warnings
    )
    critical_machines  = sum(1 for m in machine_risks if m["risk_level"] == "critical")
    high_risk_machines = sum(1 for m in machine_risks if m["risk_level"] == "high")

    # ── Top irritants ─────────────────────────────────────────────────────
    top_irritants = _calc_top_irritants(tickets_current, all_machines)

    # ── Trend analysis ────────────────────────────────────────────────────
    trends = _calc_trends(tickets_current, tickets_previous, all_machines)

    # ── Spare parts risk ─────────────────────────────────────────────────
    spare_risks, parts_below_min = _calc_spare_parts_risk(all_parts, warnings)

    # ── Technician workload ───────────────────────────────────────────────
    tech_workload = await _calc_technician_workload(db, tickets_current, warnings, pid)
    concentration_risk = _detect_concentration_risk(tech_workload)

    return {
        "period_start":               period_start.isoformat(),
        "period_end":                 period_end.isoformat(),
        "plant_id":                   plant_id,
        "total_tickets":              total_tickets,
        "total_alerts":               total_alerts,
        "total_downtime_minutes":     total_downtime_min,
        "overdue_alerts":             overdue_alerts,
        "avg_mttr_minutes":           round(avg_mttr, 1),
        "mttr_trend":                 mttr_trend,
        "mttr_change_pct":            round(mttr_change_pct, 1),
        "machines_with_mtbf":         mtbf_result["machines_with_mtbf"],
        "avg_mtbf_days":              mtbf_result["avg_mtbf_days"],
        "mtbf_trend":                 mtbf_result["mtbf_trend"],
        "mtbf_change_pct":            mtbf_result["mtbf_change_pct"],
        "machine_risks":              machine_risks,
        "critical_machines":          critical_machines,
        "high_risk_machines":         high_risk_machines,
        "top_irritants":              top_irritants,
        "trends":                     trends,
        "spare_parts_at_risk":        spare_risks,
        "parts_below_minimum":        parts_below_min,
        "technician_workload":        tech_workload,
        "concentration_risk":         concentration_risk,
        "insufficient_data_warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Data fetching helpers
# ---------------------------------------------------------------------------

async def _fetch_tickets(
    db: AsyncSession,
    start: datetime,
    end: datetime,
    plant_id: Optional[uuid.UUID] = None,
) -> list[dict]:
    """
    Fetch maintenance tickets in the given period (scoped to `plant_id` when set).
    Returns list of plain dicts to avoid ORM lazy-load issues.
    """
    from app.models.models import MaintenanceTicket, Machine

    conds = [MaintenanceTicket.opened_at >= start, MaintenanceTicket.opened_at < end]
    if plant_id is not None:
        conds.append(MaintenanceTicket.plant_id == plant_id)
    result = await db.execute(
        select(
            MaintenanceTicket.id,
            MaintenanceTicket.machine_id,
            MaintenanceTicket.priority,
            MaintenanceTicket.status,
            MaintenanceTicket.assigned_to_id,
            MaintenanceTicket.opened_at,
            MaintenanceTicket.started_at,
            MaintenanceTicket.completed_at,
            MaintenanceTicket.total_intervention_minutes,
            MaintenanceTicket.estimated_downtime_minutes,
            MaintenanceTicket.parts_used,
            Machine.name.label("machine_name"),
            Machine.department,
        )
        .join(Machine, MaintenanceTicket.machine_id == Machine.id, isouter=True)
        .where(and_(*conds))
        .order_by(MaintenanceTicket.opened_at)
    )
    rows = result.all()
    return [row._asdict() for row in rows]


async def _fetch_alerts(
    db: AsyncSession,
    start: datetime,
    end: datetime,
    plant_id: Optional[uuid.UUID] = None,
) -> list[dict]:
    """Fetch maintenance alerts in the given period (scoped to `plant_id` when set)."""
    from app.models.models import MaintenanceAlert

    conds = [MaintenanceAlert.created_at >= start, MaintenanceAlert.created_at < end]
    if plant_id is not None:
        conds.append(MaintenanceAlert.plant_id == plant_id)
    result = await db.execute(
        select(
            MaintenanceAlert.id,
            MaintenanceAlert.machine_id,
            MaintenanceAlert.priority,
            MaintenanceAlert.status,
            MaintenanceAlert.problem_type,
            MaintenanceAlert.is_overdue,
            MaintenanceAlert.created_at,
        )
        .where(and_(*conds))
    )
    rows = result.all()
    return [row._asdict() for row in rows]


async def _fetch_machines(db: AsyncSession, plant_id: Optional[uuid.UUID] = None) -> list[dict]:
    """Fetch active machines (scoped to `plant_id` when set)."""
    from app.models.models import Machine

    conds = [Machine.is_active == True]  # noqa: E712
    if plant_id is not None:
        conds.append(Machine.plant_id == plant_id)
    result = await db.execute(
        select(
            Machine.id,
            Machine.name,
            Machine.department,
            Machine.location,
            Machine.is_active,
        )
        .where(and_(*conds))
    )
    rows = result.all()
    return [row._asdict() for row in rows]


async def _fetch_parts_consumption(
    db: AsyncSession,
    period_days: int,
) -> list[dict]:
    """
    Fetch stock items with their recent and historical consumption.
    Historical baseline = previous 90 days (or all available data if less).
    Recent = current period.
    """
    from app.models.models import StockItem, WOPart

    now         = datetime.now(timezone.utc)
    recent_start   = now - timedelta(days=period_days)
    baseline_start = now - timedelta(days=90)

    # Recent consumption per part
    recent_result = await db.execute(
        select(
            WOPart.stock_item_id,
            func.sum(WOPart.quantity).label("recent_qty"),
        )
        .where(
            and_(
                WOPart.stock_item_id.isnot(None),
                WOPart.created_at >= recent_start,
            )
        )
        .group_by(WOPart.stock_item_id)
    )
    recent_by_part = {str(r.stock_item_id): float(r.recent_qty) for r in recent_result}

    # 90-day baseline consumption per part (normalised to period_days for comparison)
    baseline_result = await db.execute(
        select(
            WOPart.stock_item_id,
            func.sum(WOPart.quantity).label("baseline_qty"),
        )
        .where(
            and_(
                WOPart.stock_item_id.isnot(None),
                WOPart.created_at >= baseline_start,
                WOPart.created_at < recent_start,
            )
        )
        .group_by(WOPart.stock_item_id)
    )
    # Normalise 90-day total to same period_days window for fair comparison
    baseline_by_part = {
        str(r.stock_item_id): float(r.baseline_qty) * (period_days / 90.0)
        for r in baseline_result
    }

    # All stock items
    items_result = await db.execute(
        select(
            StockItem.id,
            StockItem.code,
            StockItem.name,
            StockItem.quantity,
            StockItem.min_quantity,
        )
    )
    items = items_result.all()

    parts = []
    for item in items:
        sid           = str(item.id)
        recent_qty    = recent_by_part.get(sid, 0.0)
        baseline_qty  = baseline_by_part.get(sid, 0.0)
        parts.append({
            "id":             sid,
            "code":           item.code,
            "name":           item.name,
            "current_qty":    float(item.quantity or 0),
            "min_qty":        float(item.min_quantity or 0),
            "recent_qty":     recent_qty,
            "baseline_qty":   baseline_qty,
        })
    return parts


# ---------------------------------------------------------------------------
# MTTR calculation
# ---------------------------------------------------------------------------

def _calc_mttr_trend(
    current: list[dict],
    previous: list[dict],
    warnings: list[str],
) -> tuple[float, str, float]:
    """
    Returns (avg_mttr_minutes, trend_direction, change_pct).
    Only uses completed tickets with total_intervention_minutes recorded.
    """
    def _avg_mttr(tickets: list[dict]) -> Optional[float]:
        valid = [
            t["total_intervention_minutes"]
            for t in tickets
            if t.get("total_intervention_minutes") and t["total_intervention_minutes"] > 0
        ]
        return sum(valid) / len(valid) if valid else None

    curr_mttr = _avg_mttr(current)
    prev_mttr = _avg_mttr(previous)

    if curr_mttr is None:
        warnings.append("No completed tickets with intervention time recorded — MTTR not available.")
        return 0.0, "stable", 0.0

    if prev_mttr is None or prev_mttr == 0:
        warnings.append("Previous period has no MTTR data — trend comparison not available.")
        return curr_mttr, "stable", 0.0

    change_pct = ((curr_mttr - prev_mttr) / prev_mttr) * 100

    if change_pct <= -10:
        direction = "improved"
    elif change_pct >= 15:
        direction = "deteriorated"
    elif abs(change_pct) > 30:
        direction = "abnormal"
    else:
        direction = "stable"

    return curr_mttr, direction, change_pct


# ---------------------------------------------------------------------------
# MTBF calculation from ticket intervals
# ---------------------------------------------------------------------------

async def _calc_mtbf_from_tickets(
    db: AsyncSession,
    period_days: int,
    warnings: list[str],
    plant_id: Optional[uuid.UUID] = None,
) -> dict:
    """
    Calculates MTBF per machine using the time between consecutive ticket
    open dates. Requires >= 2 tickets per machine.

    NOTE: This is MTBF based on intervention calls, not machine stop events.
    When machine_stops table is implemented (Phase 2), replace this with
    a version reading actual stop intervals from machine_stops.started_at.

    Returns a dict with keys:
        machines_with_mtbf, avg_mtbf_days, mtbf_trend, mtbf_change_pct
    """
    from app.models.models import MaintenanceTicket

    now   = datetime.now(timezone.utc)
    # Use a longer window for MTBF to have enough intervals
    lookback = max(period_days * 3, 90)
    start = now - timedelta(days=lookback)

    conds = [MaintenanceTicket.opened_at >= start]
    if plant_id is not None:
        conds.append(MaintenanceTicket.plant_id == plant_id)
    result = await db.execute(
        select(
            MaintenanceTicket.machine_id,
            MaintenanceTicket.opened_at,
        )
        .where(and_(*conds))
        .order_by(MaintenanceTicket.machine_id, MaintenanceTicket.opened_at)
    )
    rows = result.all()

    # Group by machine
    from collections import defaultdict
    by_machine: dict[str, list[datetime]] = defaultdict(list)
    for row in rows:
        if row.machine_id:
            by_machine[str(row.machine_id)].append(row.opened_at)

    mtbf_values: list[float] = []
    machines_with_data = 0

    for machine_id, timestamps in by_machine.items():
        if len(timestamps) < 2:
            warnings.append(
                f"Machine {machine_id}: only {len(timestamps)} ticket(s) in last "
                f"{lookback} days — MTBF not calculated (minimum 2 required)."
            )
            continue

        intervals_days = [
            (timestamps[i] - timestamps[i - 1]).total_seconds() / 86400
            for i in range(1, len(timestamps))
        ]
        machine_mtbf = sum(intervals_days) / len(intervals_days)
        if machine_mtbf > 0:
            mtbf_values.append(machine_mtbf)
            machines_with_data += 1

    if not mtbf_values:
        warnings.append(
            "Not enough ticket history to calculate MTBF for any machine. "
            "Minimum 2 tickets per machine required."
        )
        return {
            "machines_with_mtbf": 0,
            "avg_mtbf_days":      None,
            "mtbf_trend":         None,
            "mtbf_change_pct":    None,
        }

    avg_mtbf = sum(mtbf_values) / len(mtbf_values)

    # Trend: compare first-half vs second-half of the lookback window
    # A rising MTBF = machines failing LESS often = improvement
    mid = now - timedelta(days=lookback // 2)
    first_half = await _avg_mtbf_window(db, start, mid)
    second_half = await _avg_mtbf_window(db, mid, now)

    mtbf_trend    = None
    mtbf_change   = None
    if first_half and second_half and first_half > 0:
        mtbf_change = ((second_half - first_half) / first_half) * 100
        if mtbf_change >= 10:
            mtbf_trend = "improved"      # more time between failures
        elif mtbf_change <= -10:
            mtbf_trend = "deteriorated"  # failing more often
        elif abs(mtbf_change) > 40:
            mtbf_trend = "abnormal"
        else:
            mtbf_trend = "stable"

    return {
        "machines_with_mtbf": machines_with_data,
        "avg_mtbf_days":      round(avg_mtbf, 2),
        "mtbf_trend":         mtbf_trend,
        "mtbf_change_pct":    round(mtbf_change, 1) if mtbf_change is not None else None,
    }


async def _avg_mtbf_window(
    db: AsyncSession,
    start: datetime,
    end: datetime,
) -> Optional[float]:
    """Helper: average MTBF across all machines in a specific time window."""
    from app.models.models import MaintenanceTicket
    from collections import defaultdict

    result = await db.execute(
        select(
            MaintenanceTicket.machine_id,
            MaintenanceTicket.opened_at,
        )
        .where(
            and_(
                MaintenanceTicket.opened_at >= start,
                MaintenanceTicket.opened_at < end,
                MaintenanceTicket.machine_id.isnot(None),
            )
        )
        .order_by(MaintenanceTicket.machine_id, MaintenanceTicket.opened_at)
    )
    rows = result.all()

    by_machine: dict[str, list[datetime]] = defaultdict(list)
    for row in rows:
        by_machine[str(row.machine_id)].append(row.opened_at)

    all_intervals: list[float] = []
    for timestamps in by_machine.values():
        if len(timestamps) < 2:
            continue
        for i in range(1, len(timestamps)):
            diff = (timestamps[i] - timestamps[i - 1]).total_seconds() / 86400
            if diff > 0:
                all_intervals.append(diff)

    return sum(all_intervals) / len(all_intervals) if all_intervals else None


# ---------------------------------------------------------------------------
# Machine risk scoring
# ---------------------------------------------------------------------------

async def _calc_machine_risks(
    db: AsyncSession,
    tickets: list[dict],
    machines: list[dict],
    period_days: int,
    warnings: list[str],
) -> list[dict]:
    """
    Calculates a risk score (0-100) per machine.

    Score components:
      40pts — ticket frequency vs historical average
      30pts — hours since last ticket vs historical MTBF
      20pts — recurrence of same problem type
      10pts — machine criticality multiplier (from equipment table)

    Risk levels:
      0-25  → low
      26-50 → medium
      51-75 → high
      76-100→ critical
    """
    from app.models.models import MaintenanceTicket
    from collections import defaultdict

    now = datetime.now(timezone.utc)

    # Historical ticket counts (90 days) for baseline frequency
    hist_start = now - timedelta(days=90)
    hist_result = await db.execute(
        select(
            MaintenanceTicket.machine_id,
            func.count(MaintenanceTicket.id).label("count"),
        )
        .where(
            and_(
                MaintenanceTicket.opened_at >= hist_start,
                MaintenanceTicket.machine_id.isnot(None),
            )
        )
        .group_by(MaintenanceTicket.machine_id)
    )
    hist_counts = {str(r.machine_id): r.count for r in hist_result}

    # Last ticket date per machine (for hours-since calculation)
    last_ticket_result = await db.execute(
        select(
            MaintenanceTicket.machine_id,
            func.max(MaintenanceTicket.opened_at).label("last_date"),
        )
        .where(MaintenanceTicket.machine_id.isnot(None))
        .group_by(MaintenanceTicket.machine_id)
    )
    last_ticket = {str(r.machine_id): r.last_date for r in last_ticket_result}

    # Group current tickets by machine for problem-type recurrence
    by_machine: dict[str, list[dict]] = defaultdict(list)
    for t in tickets:
        if t.get("machine_id"):
            by_machine[str(t["machine_id"])].append(t)

    # Build MTBF per machine from the calculator
    mtbf_per_machine = await _calc_mtbf_per_machine(db, warnings)

    machine_id_to_name = {str(m["id"]): m["name"] for m in machines}

    results = []
    for machine in machines:
        mid        = str(machine["id"])
        mname      = machine["name"]
        dept       = machine.get("department", "")

        curr_count = len(by_machine.get(mid, []))
        hist_count = hist_counts.get(mid, 0)

        # Expected frequency in period_days based on 90-day history
        expected_in_period = (hist_count / 90.0) * period_days if hist_count else 0

        # ── Component 1: frequency score (0–40) ──────────────────────────
        if expected_in_period == 0:
            freq_score = min(curr_count * 5, 20)  # no history = moderate penalty
        else:
            ratio = curr_count / expected_in_period
            if ratio <= 0.5:
                freq_score = 0
            elif ratio <= 1.0:
                freq_score = 10
            elif ratio <= 1.5:
                freq_score = 25
            elif ratio <= 2.0:
                freq_score = 35
            else:
                freq_score = 40

        # ── Component 2: time-since-last-ticket vs MTBF (0–30) ───────────
        last_dt          = last_ticket.get(mid)
        mtbf_hours       = mtbf_per_machine.get(mid)  # in hours
        hours_since_last = None
        time_score       = 0

        if last_dt:
            hours_since_last = (now - last_dt.replace(tzinfo=timezone.utc)
                               if last_dt.tzinfo is None
                               else (now - last_dt)).total_seconds() / 3600

            if mtbf_hours and mtbf_hours > 0:
                overdue_ratio = hours_since_last / mtbf_hours
                # Near or beyond MTBF → higher risk
                if overdue_ratio >= 1.5:
                    time_score = 30
                elif overdue_ratio >= 1.0:
                    time_score = 20
                elif overdue_ratio >= 0.75:
                    time_score = 10
                else:
                    time_score = 0

        # ── Component 3: recurrence score (0–20) ─────────────────────────
        mtickets = by_machine.get(mid, [])
        recurrence_score = 0
        top_problems: list[str] = []

        if mtickets:
            problem_counts: dict[str, int] = defaultdict(int)
            for t in mtickets:
                pt = t.get("problem_type") or "unknown"
                # Access alert's problem_type via ticket → alert join if needed
                # For now use machine_id as proxy — problem_type comes from alert
                problem_counts[pt] += 1

            top_problems = sorted(problem_counts, key=problem_counts.get, reverse=True)[:3]
            max_recurrence = max(problem_counts.values())
            if max_recurrence >= 4:
                recurrence_score = 20
            elif max_recurrence >= 3:
                recurrence_score = 15
            elif max_recurrence >= 2:
                recurrence_score = 8
            else:
                recurrence_score = 0

        # ── Component 4: criticality multiplier (1.0x – 1.5x) ───────────
        # Default 1.0 — will be enhanced when machines ↔ equipment linking exists
        criticality_factor = 1.0

        raw_score = (freq_score + time_score + recurrence_score) * criticality_factor
        score     = min(round(raw_score, 1), 100.0)

        if score >= 76:
            risk_level = "critical"
        elif score >= 51:
            risk_level = "high"
        elif score >= 26:
            risk_level = "medium"
        else:
            risk_level = "low"

        mtbf_days = mtbf_per_machine.get(mid)
        results.append({
            "machine_id":              mid,
            "machine_name":            mname,
            "risk_level":              risk_level,
            "ticket_count_period":     curr_count,
            "avg_mtbf_days":           round(mtbf_days / 24, 2) if mtbf_days else None,
            "days_since_last_ticket":  round(hours_since_last / 24, 1) if hours_since_last else None,
            "mtbf_trend":              None,  # per-machine trend is in global mtbf_result
            "top_problem_types":       top_problems,
            "criticality":             None,   # linked equipment criticality (Phase 2)
            # Extra fields for MachineRiskScore storage
            "_score":                   score,
            "_hours_since_last_ticket": hours_since_last,
            "_historical_mtbf_hours":   mtbf_per_machine.get(mid),
            "_criticality_factor":      criticality_factor,
        })

    # Sort: critical → high → medium → low, then by score desc
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    results.sort(key=lambda x: (order[x["risk_level"]], -x["_score"]))
    return results


async def _calc_mtbf_per_machine(
    db: AsyncSession,
    warnings: list[str],
) -> dict[str, float]:
    """
    Returns {machine_id: avg_mtbf_in_hours} for machines with >= 2 tickets.
    Used internally for risk scoring.
    """
    from app.models.models import MaintenanceTicket

    now   = datetime.now(timezone.utc)
    start = now - timedelta(days=180)  # 6-month window for MTBF calculation

    result = await db.execute(
        select(
            MaintenanceTicket.machine_id,
            MaintenanceTicket.opened_at,
        )
        .where(
            and_(
                MaintenanceTicket.opened_at >= start,
                MaintenanceTicket.machine_id.isnot(None),
            )
        )
        .order_by(MaintenanceTicket.machine_id, MaintenanceTicket.opened_at)
    )
    rows = result.all()

    from collections import defaultdict
    by_machine: dict[str, list[datetime]] = defaultdict(list)
    for row in rows:
        by_machine[str(row.machine_id)].append(row.opened_at)

    mtbf: dict[str, float] = {}
    for mid, timestamps in by_machine.items():
        if len(timestamps) < 2:
            continue
        intervals_hours = [
            (timestamps[i] - timestamps[i - 1]).total_seconds() / 3600
            for i in range(1, len(timestamps))
        ]
        avg = sum(intervals_hours) / len(intervals_hours)
        if avg > 0:
            mtbf[mid] = round(avg, 2)

    return mtbf


# ---------------------------------------------------------------------------
# Top irritants
# ---------------------------------------------------------------------------

def _calc_top_irritants(
    tickets: list[dict],
    machines: list[dict],
) -> list[dict]:
    """
    Ranks machines by combined irritant score:
      - 40% weight: total downtime
      - 30% weight: ticket count (recurrence)
      - 30% weight: avg MTTR (resolution difficulty)

    Returns top 5 irritants.
    """
    from collections import defaultdict

    machine_id_to_name = {str(m["id"]): m["name"] for m in machines}

    # Aggregate by machine
    agg: dict[str, dict] = defaultdict(lambda: {
        "count": 0,
        "total_downtime": 0,
        "total_intervention": 0,
        "problem_types": defaultdict(int),
    })

    for t in tickets:
        mid = str(t.get("machine_id") or "unknown")
        agg[mid]["count"] += 1
        agg[mid]["total_downtime"]    += t.get("estimated_downtime_minutes") or 0
        agg[mid]["total_intervention"] += t.get("total_intervention_minutes") or 0
        pt = t.get("problem_type") or "unknown"
        agg[mid]["problem_types"][pt] += 1

    if not agg:
        return []

    # Normalise each metric to 0-1 range
    max_count    = max(v["count"]           for v in agg.values()) or 1
    max_downtime = max(v["total_downtime"]  for v in agg.values()) or 1
    max_mttr     = max(
        v["total_intervention"] / max(v["count"], 1) for v in agg.values()
    ) or 1

    scored: list[dict] = []
    for mid, data in agg.items():
        count      = data["count"]
        downtime   = data["total_downtime"]
        avg_mttr   = data["total_intervention"] / max(count, 1)

        irritant_score = (
            0.4 * (downtime / max_downtime) +
            0.3 * (count    / max_count)    +
            0.3 * (avg_mttr / max_mttr)
        )

        # Recurrence ratio: same problem type appearing >50% of the time
        top_pt     = max(data["problem_types"], key=data["problem_types"].get, default="unknown")
        top_count  = data["problem_types"].get(top_pt, 0)
        recurrence = top_count / max(count, 1)

        # Risk level based on irritant score
        if irritant_score >= 0.75:
            risk_level = "critical"
        elif irritant_score >= 0.5:
            risk_level = "high"
        elif irritant_score >= 0.25:
            risk_level = "medium"
        else:
            risk_level = "low"

        scored.append({
            "machine_id":             mid,
            "machine_name":           machine_id_to_name.get(mid, mid),
            "ticket_count":           count,
            "total_downtime_minutes": downtime,
            "avg_mttr_minutes":       round(avg_mttr, 1),
            "avg_mtbf_days":          None,  # will be filled by risk scoring if needed
            "top_problem_type":       top_pt,
            "risk_level":             risk_level,
            "recurrence_score":       round(recurrence, 2),
        })

    scored.sort(key=lambda x: (
        {"critical": 0, "high": 1, "medium": 2, "low": 3}[x["risk_level"]],
        -x["total_downtime_minutes"]
    ))

    # Add rank
    for i, item in enumerate(scored[:5], start=1):
        item["rank"] = i

    return scored[:5]


# ---------------------------------------------------------------------------
# Trend analysis
# ---------------------------------------------------------------------------

def _calc_trends(
    current: list[dict],
    previous: list[dict],
    machines: list[dict],
) -> list[dict]:
    """
    Compares key metrics between current and previous period.
    Returns a list of TrendItem dicts.
    """
    from collections import defaultdict

    trends: list[dict] = []

    # ── Overall ticket count ──────────────────────────────────────────────
    if previous:
        change = _pct_change(len(current), len(previous))
        trends.append({
            "metric":         "ticket_count",
            "entity_name":    "All machines",
            "current_value":  len(current),
            "previous_value": len(previous),
            "change_pct":     round(change, 1),
            "direction":      _trend_direction(change, lower_is_better=True),
            "unit":           "tickets",
        })

    # ── Overall MTTR ─────────────────────────────────────────────────────
    def _mean_intervention(tickets: list[dict]) -> Optional[float]:
        vals = [t["total_intervention_minutes"] for t in tickets
                if t.get("total_intervention_minutes")]
        return sum(vals) / len(vals) if vals else None

    curr_mttr = _mean_intervention(current)
    prev_mttr = _mean_intervention(previous)
    if curr_mttr and prev_mttr:
        change = _pct_change(curr_mttr, prev_mttr)
        trends.append({
            "metric":         "MTTR",
            "entity_name":    "All machines",
            "current_value":  round(curr_mttr, 1),
            "previous_value": round(prev_mttr, 1),
            "change_pct":     round(change, 1),
            "direction":      _trend_direction(change, lower_is_better=True),
            "unit":           "minutes",
        })

    # ── Per-machine ticket count (top 3 most active) ─────────────────────
    machine_id_to_name = {str(m["id"]): m["name"] for m in machines}

    curr_by_machine: dict[str, int] = defaultdict(int)
    prev_by_machine: dict[str, int] = defaultdict(int)

    for t in current:
        if t.get("machine_id"):
            curr_by_machine[str(t["machine_id"])] += 1
    for t in previous:
        if t.get("machine_id"):
            prev_by_machine[str(t["machine_id"])] += 1

    all_machine_ids = set(curr_by_machine) | set(prev_by_machine)
    machine_trends: list[dict] = []

    for mid in all_machine_ids:
        curr_val = curr_by_machine.get(mid, 0)
        prev_val = prev_by_machine.get(mid, 0)
        if prev_val == 0 and curr_val == 0:
            continue
        change = _pct_change(curr_val, prev_val) if prev_val > 0 else 100.0
        machine_trends.append({
            "metric":         "ticket_count",
            "entity_name":    machine_id_to_name.get(mid, mid),
            "current_value":  float(curr_val),
            "previous_value": float(prev_val),
            "change_pct":     round(change, 1),
            "direction":      _trend_direction(change, lower_is_better=True),
            "unit":           "tickets",
        })

    # Keep top 3 most active (by current period)
    machine_trends.sort(key=lambda x: x["current_value"], reverse=True)
    trends.extend(machine_trends[:3])

    return trends


# ---------------------------------------------------------------------------
# Spare parts risk
# ---------------------------------------------------------------------------

def _calc_spare_parts_risk(
    parts: list[dict],
    warnings: list[str],
) -> tuple[list[dict], int]:
    """
    Identifies parts below minimum stock or with abnormal consumption.
    Returns (risk_list, parts_below_minimum_count).
    """
    risks: list[dict] = []
    below_min = 0

    for p in parts:
        current    = p["current_qty"]
        minimum    = p["min_qty"]
        recent     = p["recent_qty"]
        baseline   = p["baseline_qty"]

        # Stock level risk
        stock_risk = "low"
        if minimum > 0:
            ratio = current / minimum
            if ratio <= 0:
                stock_risk = "critical"
                below_min += 1
            elif ratio < 0.5:
                stock_risk = "high"
                below_min += 1
            elif ratio < 1.0:
                stock_risk = "medium"
                below_min += 1

        # Consumption trend
        consumption_trend = "stable"
        if baseline > 0:
            change = _pct_change(recent, baseline)
            if change >= 50:
                consumption_trend = "abnormal"
            elif change >= 20:
                consumption_trend = "deteriorated"
            elif change <= -20:
                consumption_trend = "improved"
        elif recent > 0:
            consumption_trend = "deteriorated"  # new consumption where there was none

        # Combined risk level
        if stock_risk == "critical" or consumption_trend == "abnormal":
            risk_level = "critical"
        elif stock_risk == "high" or consumption_trend == "deteriorated":
            risk_level = "high"
        elif stock_risk == "medium":
            risk_level = "medium"
        else:
            risk_level = "low"

        # Stockout estimate (days)
        days_until_stockout = None
        if recent > 0 and current >= 0:
            # Daily consumption rate
            daily_rate = recent / 30.0  # assuming 30-day recent window
            if daily_rate > 0:
                days_until_stockout = round(current / daily_rate, 1)

        if risk_level != "low":
            risks.append({
                "stock_item_id":        p["id"],
                "part_code":            p["code"],
                "part_name":            p["name"],
                "current_qty":          current,
                "min_qty":              minimum,
                "consumption_last_30d": recent,
                "avg_consumption_30d":  baseline,
                "consumption_trend":    consumption_trend,
                "linked_machines":      [],  # populated from wo_parts join if needed
                "risk_level":           risk_level,
                "days_until_stockout":  days_until_stockout,
            })

    # Sort by risk level
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    risks.sort(key=lambda x: order[x["risk_level"]])
    return risks, below_min


# ---------------------------------------------------------------------------
# Technician workload
# ---------------------------------------------------------------------------

async def _calc_technician_workload(
    db: AsyncSession,
    tickets: list[dict],
    warnings: list[str],
    plant_id: Optional[uuid.UUID] = None,
) -> list[dict]:
    """
    Analyses workload distribution across technicians (scoped to `plant_id` when
    set — a technician belongs to the plants their user holds membership in).
    Uses labor_records for hours, tickets for count.
    """
    from app.models.models import LaborRecord, Technician, User, UserPlant
    from collections import defaultdict

    now   = datetime.now(timezone.utc)
    start = now - timedelta(days=30)

    # Labor records for the last 30 days
    labor_result = await db.execute(
        select(
            LaborRecord.technician_id,
            func.sum(LaborRecord.hours_worked).label("total_hours"),
            func.count(LaborRecord.id).label("record_count"),
        )
        .where(LaborRecord.date >= start)
        .group_by(LaborRecord.technician_id)
    )
    labor_by_tech = {
        str(r.technician_id): {
            "total_hours":  float(r.total_hours or 0),
            "record_count": int(r.record_count or 0),
        }
        for r in labor_result
    }

    # Ticket counts by assigned technician
    ticket_by_tech: dict[str, int] = defaultdict(int)
    for t in tickets:
        if t.get("assigned_to_id"):
            ticket_by_tech[str(t["assigned_to_id"])] += 1

    # Technician profiles (scoped to the plant's team when plant_id is set)
    tech_stmt = (
        select(
            Technician.id,
            Technician.specialty,
            Technician.shift,
            User.name.label("user_name"),
        )
        .join(User, Technician.user_id == User.id)
        .where(Technician.active == True)  # noqa: E712
    )
    if plant_id is not None:
        tech_stmt = tech_stmt.join(
            UserPlant, UserPlant.user_id == Technician.user_id
        ).where(UserPlant.plant_id == plant_id)
    tech_result = await db.execute(tech_stmt)
    technicians = tech_result.all()

    if not technicians:
        warnings.append("No active technicians found — workload analysis skipped.")
        return []

    total_tickets = sum(ticket_by_tech.values()) or 1
    workload_list: list[dict] = []

    for tech in technicians:
        tid           = str(tech.id)
        labor         = labor_by_tech.get(tid, {"total_hours": 0, "record_count": 0})
        ticket_count  = ticket_by_tech.get(tid, 0)
        total_hours   = labor["total_hours"]
        pct_tickets   = ticket_count / total_tickets

        # Avg resolution: use labor hours as proxy if no direct MTTR by technician
        avg_res_min = (total_hours * 60 / max(ticket_count, 1)) if total_hours > 0 else 0

        # Workload level
        if pct_tickets >= 0.40:
            workload_level = "critical"   # single tech handling 40%+ of all tickets
        elif pct_tickets >= 0.25:
            workload_level = "high"
        elif pct_tickets >= 0.10:
            workload_level = "medium"
        else:
            workload_level = "low"

        workload_list.append({
            "technician_id":          tid,
            "technician_name":        tech.user_name,
            "specialty":              tech.specialty or "unknown",
            "ticket_count":           ticket_count,
            "total_hours":            round(total_hours, 1),
            "avg_resolution_minutes": round(avg_res_min, 1),
            "workload_level":         workload_level,
            "pct_of_team_tickets":    round(pct_tickets * 100, 1),
        })

    workload_list.sort(key=lambda x: x["ticket_count"], reverse=True)
    return workload_list


def _detect_concentration_risk(workload: list[dict]) -> bool:
    """
    Returns True if the top 2 technicians handle >60% of all tickets.
    This signals knowledge/capacity concentration risk.
    """
    if len(workload) < 2:
        return False
    top2_pct = sum(w["pct_of_team_tickets"] for w in workload[:2])
    return top2_pct > 60.0


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def _pct_change(current: float, previous: float) -> float:
    """Percentage change from previous to current. Returns 0 if previous is 0."""
    if previous == 0:
        return 0.0
    return ((current - previous) / previous) * 100


def _trend_direction(change_pct: float, lower_is_better: bool = True) -> str:
    """
    Convert a percentage change to a trend direction string.
    lower_is_better=True for MTTR, ticket count, downtime.
    lower_is_better=False for MTBF, availability.
    """
    if abs(change_pct) > 40:
        return "abnormal"

    if lower_is_better:
        if change_pct <= -10:
            return "improved"
        elif change_pct >= 15:
            return "deteriorated"
        else:
            return "stable"
    else:
        if change_pct >= 10:
            return "improved"
        elif change_pct <= -15:
            return "deteriorated"
        else:
            return "stable"
