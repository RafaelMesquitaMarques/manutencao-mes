"""OF (Ordre de fabrication) cost — Phase 2.

Cost of an OF = **productive machine time × the machine's hourly rate**, where
productive time is a run's wall-clock presence MINUS any stop time overlapping it.
Business rule (2026-07-10): stop/downtime is tracked separately and is NEVER
attributed to an OF — the OF only "costs" the machine while it is actually running.

Aggregates per machine, per department and per OF, plus a plant/factory total. All
inputs (job_order_runs, machine_stops) are low-volume plain tables kept ≥10 years.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import JobOrder, JobOrderRun, Machine, MachineStop
from app.services.mes_service import overlap_seconds, _as_utc


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _currency(machine: Optional[Machine]) -> str:
    c = getattr(machine, "hourly_rate_currency", None) if machine else None
    return c.value if hasattr(c, "value") else (str(c) if c else "CAD")


async def _stop_seconds_in_window(
    db: AsyncSession, machine_id: UUID, start: datetime, end: datetime
) -> float:
    """Total stop seconds overlapping [start, end) on a machine — ALL stops (the OF
    is not producing during any stop). Ongoing stops are capped at `end`."""
    r = await db.execute(
        select(MachineStop.started_at, MachineStop.ended_at).where(
            MachineStop.machine_id == machine_id,
            MachineStop.started_at < end,
            or_(MachineStop.ended_at.is_(None), MachineStop.ended_at > start),
        )
    )
    total = 0.0
    for s_start, s_end in r.all():
        se = _as_utc(s_end) if s_end else end
        total += overlap_seconds(_as_utc(s_start), se, start, end)
    return total


async def _run_cost(db: AsyncSession, run: JobOrderRun, cache: dict) -> dict:
    """Cost of one passage: productive minutes (presence − overlapping stops) × rate."""
    machine = cache.get(run.machine_id)
    if machine is None:
        machine = await db.get(Machine, run.machine_id)
        cache[run.machine_id] = machine
    start = _as_utc(run.started_at)
    end = _as_utc(run.ended_at) if run.ended_at else _now()
    gross_s = max(0.0, (end - start).total_seconds())
    stop_s = await _stop_seconds_in_window(db, run.machine_id, start, end)
    prod_s = max(0.0, gross_s - stop_s)
    rate = (machine.hourly_rate or 0.0) if machine else 0.0
    return {
        "run_id": run.id,
        "machine_id": run.machine_id,
        "machine_name": machine.name if machine else None,
        "department": run.department,
        "started_at": run.started_at,
        "ended_at": run.ended_at,
        "gross_minutes": round(gross_s / 60.0, 1),
        "stop_minutes": round(stop_s / 60.0, 1),
        "productive_minutes": round(prod_s / 60.0, 1),
        "pieces": run.pieces or 0,
        "hourly_rate": rate,
        "currency": _currency(machine),
        "cost": round(prod_s / 3600.0 * rate, 2),
        "open": run.ended_at is None,
    }


def _bucket(rows: list, key: str) -> list:
    """Aggregate run-cost rows by a key (machine name or department)."""
    out: dict = {}
    for r in rows:
        k = r[key] or "—"
        b = out.setdefault(k, {"key": k, "productive_minutes": 0.0, "cost": 0.0, "pieces": 0})
        b["productive_minutes"] += r["productive_minutes"]
        b["cost"] += r["cost"]
        b["pieces"] += r["pieces"]
    for b in out.values():
        b["productive_minutes"] = round(b["productive_minutes"], 1)
        b["cost"] = round(b["cost"], 2)
    return sorted(out.values(), key=lambda b: b["cost"], reverse=True)


async def _runs_query(job_order_id: UUID, date_from=None, date_to=None):
    q = select(JobOrderRun).where(JobOrderRun.job_order_id == job_order_id)
    if date_from is not None:
        q = q.where(JobOrderRun.started_at >= date_from)
    if date_to is not None:
        q = q.where(JobOrderRun.started_at < date_to)
    return q.order_by(JobOrderRun.started_at)


async def compute_job_order_cost(
    db: AsyncSession, job_order: JobOrder, cache: Optional[dict] = None,
    date_from=None, date_to=None,
) -> dict:
    """Full cost breakdown for one OF: per-run detail + per-machine / per-department
    buckets + totals."""
    cache = cache if cache is not None else {}
    runs = (await db.execute(await _runs_query(job_order.id, date_from, date_to))).scalars().all()
    run_costs = [await _run_cost(db, r, cache) for r in runs]

    total_prod = round(sum(r["productive_minutes"] for r in run_costs), 1)
    total_stop = round(sum(r["stop_minutes"] for r in run_costs), 1)
    total_gross = round(sum(r["gross_minutes"] for r in run_costs), 1)
    total_cost = round(sum(r["cost"] for r in run_costs), 2)
    total_pieces = sum(r["pieces"] for r in run_costs)
    currency = run_costs[0]["currency"] if run_costs else "CAD"

    return {
        "job_order_id": job_order.id,
        "job_number": job_order.job_number,
        "product_name": job_order.product_name,
        "status": job_order.status,
        "currency": currency,
        "total_gross_minutes": total_gross,
        "total_stop_minutes": total_stop,
        "total_productive_minutes": total_prod,
        "total_pieces": total_pieces,
        "total_cost": total_cost,
        "by_machine": _bucket(run_costs, "machine_name"),
        "by_department": _bucket(run_costs, "department"),
        "runs": run_costs,
    }


async def compute_cost_report(
    db: AsyncSession, base_query, date_from=None, date_to=None,
) -> dict:
    """Aggregated cost per OF for a set of OFs (plant-scoped `base_query` built by the
    caller) + a factory total. When a date range is given, only runs in that window
    are summed and OFs with no such runs are dropped."""
    ofs = (await db.execute(base_query)).scalars().all()
    cache: dict = {}
    items = []
    factory_cost = 0.0
    factory_prod = 0.0
    factory_pieces = 0
    currency = "CAD"
    for jo in ofs:
        c = await compute_job_order_cost(db, jo, cache, date_from, date_to)
        if not c["runs"]:
            continue   # no activity in the window
        currency = c["currency"]
        factory_cost += c["total_cost"]
        factory_prod += c["total_productive_minutes"]
        factory_pieces += c["total_pieces"]
        items.append({
            "job_order_id": jo.id,
            "job_number": jo.job_number,
            "product_name": jo.product_name,
            "status": jo.status,
            "department": jo.department,
            "total_productive_minutes": c["total_productive_minutes"],
            "total_pieces": c["total_pieces"],
            "total_cost": c["total_cost"],
        })
    items.sort(key=lambda r: r["total_productive_minutes"], reverse=True)   # time-first
    return {
        "currency": currency,
        "of_count": len(items),
        "factory_total_cost": round(factory_cost, 2),
        "total_productive_minutes": round(factory_prod, 1),
        "total_pieces": factory_pieces,
        "items": items,
    }


def day_bounds(date_from=None, date_to=None):
    """Convert optional YYYY-MM-DD strings/dates to UTC datetime bounds; date_to is
    inclusive (end of that day)."""
    df = None
    dt_ = None
    if date_from:
        df = datetime.fromisoformat(str(date_from)).replace(tzinfo=timezone.utc)
    if date_to:
        dt_ = (datetime.fromisoformat(str(date_to)) + timedelta(days=1)).replace(tzinfo=timezone.utc)
    return df, dt_
