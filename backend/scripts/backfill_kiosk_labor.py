#!/usr/bin/env python3
"""
scripts/backfill_kiosk_labor.py
Rebuild work-order labor / repair time / cost for repairs that were measured at
the kiosk before the kiosk→WO bridge existed.

Every completed intervention is replayed through ``kiosk_wo_bridge`` (which is
idempotent — mirrors are keyed by check-in id) and its WO totals are rolled up.
Labor records typed by hand in the office are never touched.

This is deliberately NOT a startup migration: it rewrites historical
repair_hours (→ MTTR) and cost, so it runs when a human decides to.

Interventions whose measured window is implausibly long (a kiosk call left open
for days — common in demo/test data) are SKIPPED and listed, never silently
capped: a 128-hour "repair" would poison MTTR and, once hourly rates exist, the
labor cost. Raise --max-hours to take them anyway.

Usage (inside the backend container, from /app):
    python scripts/backfill_kiosk_labor.py --dry-run
    python scripts/backfill_kiosk_labor.py --apply
    python scripts/backfill_kiosk_labor.py --apply --since 2026-01-01 --max-hours 12
"""
import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select                                    # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool                             # noqa: E402

from app.core.config import settings                             # noqa: E402
from app.models.models import (                                  # noqa: E402
    InterventionTechnician, LaborRecord, MachineIntervention, Machine,
)
from app.services import kiosk_wo_bridge, wo_totals              # noqa: E402


def _aware(dt):
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def _longest_window_hours(db, mi) -> float:
    """The longest labor window the bridge would write for this intervention —
    computed with the same rule as kiosk_wo_bridge.sync_labor, so the decision to
    skip is made BEFORE anything is written."""
    started, completed = _aware(mi.started_at), _aware(mi.completed_at)
    if not started or not completed:
        return 0.0
    rows = (await db.execute(
        select(InterventionTechnician).where(
            InterventionTechnician.intervention_id == mi.id,
            InterventionTechnician.technician_id.isnot(None),
        )
    )).scalars().all()
    spans = []
    for r in rows:
        begin = max(_aware(r.checked_in_at) or started, started)
        end = _aware(r.checked_out_at) or completed
        spans.append((end - begin).total_seconds() / 3600)
    if not spans:
        spans.append((completed - started).total_seconds() / 3600)
    return max(spans)


async def run(apply: bool, since: datetime | None, max_hours: float) -> int:
    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    touched = 0

    async with maker() as db:
        q = select(MachineIntervention).where(
            MachineIntervention.status == "completed",
            MachineIntervention.started_at.isnot(None),
        )
        if since:
            q = q.where(MachineIntervention.completed_at >= since)
        interventions = (await db.execute(q.order_by(MachineIntervention.completed_at.asc()))).scalars().all()

        print(f"{len(interventions)} completed intervention(s) to replay")
        skipped = []
        for mi in interventions:
            wo = await kiosk_wo_bridge.wo_for_intervention(db, mi)
            if not wo:
                continue
            machine = await db.get(Machine, mi.machine_id) if mi.machine_id else None
            # A kiosk call left open for days is not 128 hours of work. Skip it
            # rather than writing history nobody can defend.
            window = await _longest_window_hours(db, mi)
            if window > max_hours:
                skipped.append((wo.wo_number, machine.name if machine else "?", window))
                continue
            before = (await db.execute(
                select(LaborRecord).where(LaborRecord.work_order_id == wo.id)
            )).scalars().all()

            await kiosk_wo_bridge.on_intervention_completed(db, mi)
            await db.flush()

            after = (await db.execute(
                select(LaborRecord).where(LaborRecord.work_order_id == wo.id)
            )).scalars().all()
            added = len(after) - len(before)
            hours = sum(r.hours_worked or 0 for r in after)
            print(
                f"  {wo.wo_number:<16} {(machine.name if machine else '?'):<10} "
                f"+{added} labor record(s), {hours * 60:6.1f} min, "
                f"cost {wo.total_cost if wo.total_cost is not None else '—'}"
            )
            touched += 1

        if skipped:
            print(f"\nSKIPPED {len(skipped)} intervention(s) with a window longer than "
                  f"{max_hours:g} h (left for a human — raise --max-hours to include them):")
            for wo_number, machine_name, hours in skipped:
                print(f"  {wo_number:<16} {machine_name:<10} {hours:8.1f} h")

        if apply:
            await db.commit()
            print(f"\nAPPLIED to {touched} work order(s).")
        else:
            await db.rollback()
            print(f"\nDRY RUN — nothing written ({touched} work order(s) would change).")

    await engine.dispose()
    return touched


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    ap.add_argument("--dry-run", action="store_true", help="explicit dry run (the default)")
    ap.add_argument("--since", help="only interventions completed on/after this date (YYYY-MM-DD)")
    ap.add_argument("--max-hours", type=float, default=12.0,
                    help="skip interventions with a labor window longer than this (default: 12)")
    args = ap.parse_args()

    since = None
    if args.since:
        since = datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)

    asyncio.run(run(apply=args.apply and not args.dry_run, since=since, max_hours=args.max_hours))


if __name__ == "__main__":
    main()
