"""Ordres de fabrication (OF) — the scan flow that ties an OF to the machines it
passes through. Every kiosk/Cortex/smart-label scan funnels through
`scan_job_order_at_machine`, which keeps `JobOrderRun` (the "passagem") consistent:
one OPEN run per machine, closed when a different OF is scanned. From those runs we
get time + cost per OF and WIP (an open run = the OF's current location).

No commit here — callers commit, so a scan lands atomically with the status change.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, Tuple
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import JobOrder, JobOrderRun, JobOrderStatus, JobOrderSource, Machine


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def get_open_run(db: AsyncSession, machine_id: UUID) -> Optional[JobOrderRun]:
    """The OF currently loaded on this machine (its open run), if any."""
    r = await db.execute(
        select(JobOrderRun).where(
            JobOrderRun.machine_id == machine_id,
            JobOrderRun.ended_at.is_(None),
        )
    )
    return r.scalar_one_or_none()


def _close_run(run: JobOrderRun, when: datetime) -> None:
    """Stamp ended_at + duration_minutes on a run (in place)."""
    run.ended_at = when
    start = run.started_at
    if start is not None:
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        run.duration_minutes = max(0, int((when - start).total_seconds() // 60))


async def close_open_run(db: AsyncSession, machine_id: UUID, when: Optional[datetime] = None) -> Optional[JobOrderRun]:
    """Close the machine's open run (a new OF arrived, or the field was cleared).
    Stamps ended_at + duration. Returns the closed run (or None if there was none)."""
    run = await get_open_run(db, machine_id)
    if run is None:
        return None
    _close_run(run, when or _now())
    await db.flush()   # release the unique open-run slot before opening a new one
    return run


async def _close_other_open_runs_for_job(
    db: AsyncSession, job_order_id: UUID, current_machine_id: UUID, when: datetime
) -> None:
    """An OF can only be in one place: when it's scanned on a machine, close any
    open run it still has on ANOTHER machine (it physically moved). Keeps the
    invariant "one open run per OF" so WIP location is unambiguous."""
    r = await db.execute(
        select(JobOrderRun).where(
            JobOrderRun.job_order_id == job_order_id,
            JobOrderRun.ended_at.is_(None),
            JobOrderRun.machine_id != current_machine_id,
        )
    )
    for run in r.scalars().all():
        _close_run(run, when)
    await db.flush()


async def _lookup_or_create(
    db: AsyncSession, job_number: str, machine: Machine, source: JobOrderSource,
    product_name: Optional[str] = None, target_quantity: Optional[int] = None,
) -> JobOrder:
    """Find the OF by its number WITHIN the machine's plant, or create it on the fly
    — the OF may be born here (kiosk/Cortex/smart-label) rather than in an ERP. OF
    numbers are unique per plant (the same number can exist in another plant), so the
    lookup must be plant-scoped or a scan could hit a different plant's OF.

    `product_name`/`target_quantity` (from a smart label / Cortex payload) enrich the
    OF: set on creation, and backfilled on an existing OF only when still empty (a scan
    never overwrites details already known)."""
    r = await db.execute(
        select(JobOrder).where(
            JobOrder.job_number == job_number,
            JobOrder.plant_id == machine.plant_id,   # SQLAlchemy renders IS NULL when None
        )
    )
    jo = r.scalar_one_or_none()
    if jo is None:
        jo = JobOrder(
            job_number=job_number,
            source=source,
            status=JobOrderStatus.pending,
            plant_id=machine.plant_id,
            product_name=product_name,
            target_quantity=target_quantity,
        )
        db.add(jo)
        await db.flush()
    else:
        if product_name and not jo.product_name:
            jo.product_name = product_name
        if target_quantity and not jo.target_quantity:
            jo.target_quantity = target_quantity
    return jo


async def scan_job_order_at_machine(
    db: AsyncSession,
    machine: Machine,
    job_number: Optional[str],
    source: JobOrderSource = JobOrderSource.manual,
    operator_id: Optional[UUID] = None,
    when: Optional[datetime] = None,
    product_name: Optional[str] = None,
    target_quantity: Optional[int] = None,
) -> Tuple[Optional[JobOrder], Optional[JobOrderRun]]:
    """Scan an OF at a machine (kiosk / Cortex / smart-label). Closes the machine's
    previous run and opens a new one for this OF; marks the OF in_progress and records
    it as the current location. An empty/None number CLEARS the job (closes the open
    run, no new one). `product_name`/`target_quantity` enrich the OF (see
    `_lookup_or_create`). Does NOT commit. Returns (job_order, open_run) — both None
    when cleared."""
    number = (job_number or "").strip()
    now = when or _now()

    # Cleared field → just close whatever was running.
    if not number:
        await close_open_run(db, machine.id, now)
        machine.current_job_number = None
        return None, None

    jo = await _lookup_or_create(db, number, machine, source, product_name, target_quantity)

    # Re-scanning the SAME OF already loaded here is a no-op (avoid churning runs).
    existing = await get_open_run(db, machine.id)
    if existing is not None and existing.job_order_id == jo.id:
        machine.current_job_number = number
        return jo, existing

    # A different OF (or none) is loaded → close it and open a fresh run.
    await close_open_run(db, machine.id, now)
    # The OF physically moved here: close its open run on any other machine.
    await _close_other_open_runs_for_job(db, jo.id, machine.id, now)
    run = JobOrderRun(
        job_order_id=jo.id,
        machine_id=machine.id,
        plant_id=machine.plant_id,
        department=machine.department,
        operator_id=operator_id,
        started_at=now,
        source=source,
    )
    db.add(run)

    # Reflect the OF's current location + lifecycle.
    machine.current_job_number = number
    jo.machine_id = machine.id
    jo.department = machine.department
    if jo.plant_id is None:
        jo.plant_id = machine.plant_id
    if jo.status == JobOrderStatus.pending:
        jo.status = JobOrderStatus.in_progress
    if jo.started_at is None:
        jo.started_at = now

    await db.flush()
    return jo, run


async def complete_unit_at_machine(
    db: AsyncSession,
    machine: Machine,
    job_number: str,
    count: int = 1,
    rejects: int = 0,
    source: JobOrderSource = JobOrderSource.cortex,
    when: Optional[datetime] = None,
    product_name: Optional[str] = None,
    target_quantity: Optional[int] = None,
) -> Tuple[Optional[JobOrder], Optional[JobOrderRun]]:
    """End-of-line unit scan (assembly lines): the label of a FINISHED unit is read
    as it leaves the line — each scan = `count` unit(s) of that OF produced HERE.
    Ensures the OF's run is open on this machine (interleaved OFs on the same belt
    each switch the open run, via `scan_job_order_at_machine`) and attributes the
    units to it. Unlike `attribute_production` (which credits whatever OF happens
    to be loaded), the scan itself says which OF the unit belongs to. Does NOT
    commit. Returns (job_order, open_run)."""
    jo, run = await scan_job_order_at_machine(
        db, machine, job_number, source=source, when=when,
        product_name=product_name, target_quantity=target_quantity,
    )
    if run is not None:
        run.pieces = (run.pieces or 0) + max(0, count)
        run.rejects = max(0, (run.rejects or 0) + rejects)
    return jo, run


async def attribute_production(
    db: AsyncSession, machine_id: UUID, pieces: int, rejects: int = 0
) -> Optional[str]:
    """Attribute freshly-produced parts to the OF currently loaded on the machine
    (its open run). Returns that OF's job_number so the caller can also stamp it on
    the shift/hourly production rows. No-op (returns None) when no OF is loaded."""
    run = await get_open_run(db, machine_id)
    if run is None:
        return None
    run.pieces = (run.pieces or 0) + max(0, pieces)
    run.rejects = max(0, (run.rejects or 0) + rejects)
    jo = await db.get(JobOrder, run.job_order_id)
    return jo.job_number if jo else None
