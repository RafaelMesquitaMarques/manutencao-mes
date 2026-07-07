"""Demo production-history simulator — fills the MES with ~2 days of realistic
shop-floor data for a platform presentation, WITHOUT touching real data.

It populates the tables the dashboards read:
  - machine_production_logs  (machine × date × shift)  → OEE / availability /
    performance / quality  → factory-map card, KPI dashboard, machine reports
  - machine_stops            → downtime (availability) + kiosk timeline
  - maintenance alerts/tickets/interventions → MTTR / MTTA + maintenance views

Profile: "realistic" = most machines healthy (OEE ~75-90%), a couple of problem
machines (low OEE + a maintenance episode) so the platform is seen "catching" them.

Everything it writes is TAGGED so it can be removed cleanly:
  - production logs / job-stops / job orders : job_number starts with "SIM-"
  - machine_stops                            : comments start with "[SIM]"
  - interventions                            : operator_note starts with "[SIM]"
  - alerts / tickets                         : number starts with "ALT-SIM-" / "TKT-SIM-"

Run inside the backend container:
    docker exec mes_backend python -m scripts.simulate_production --days 2
    docker exec mes_backend python -m scripts.simulate_production --clean   # wipe sim data

Re-running is idempotent: generate() wipes the previous sim data first.
"""
import argparse
import asyncio
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, delete, update

from app.db.session import AsyncSessionLocal
from app.models.models import (
    Machine, MachineProductionLog, MachineStop, StopCategory, StopSubcategory,
    MaintenanceAlert, MaintenanceTicket, MachineIntervention,
    AlertShift, AlertPriority, AlertStatus, AlertProblemType,
    TicketStatus, StopCategoryType,
)

TAG = "[SIM]"
SIMJOB = "SIM-"

# Shift → start hour (UTC) of an 8h window.
SHIFTS = [(AlertShift.morning, 6), (AlertShift.afternoon, 14), (AlertShift.night, 22)]
SHIFT_MIN = 8 * 60

# OEE archetypes: (availability, performance, quality) ranges in %.
ARCH = {
    "healthy": ((88, 96), (90, 98), (97.0, 99.5)),
    "average": ((78, 88), (80, 92), (94.0, 98.0)),
    "problem": ((55, 74), (65, 82), (88.0, 95.0)),
}

OPERATORS = ["Jean Tremblay", "Marie Gagné", "Luc Bélanger", "Sophie Roy",
             "Pierre Côté", "Nathalie Fortin", "Marc Lavoie", "Julie Bergeron"]
TECHS = ["André Mercier", "Éric Dubois", "Carl Pelletier", "Steve Gauthier"]
PROBLEMS = [AlertProblemType.mechanical, AlertProblemType.electrical,
            AlertProblemType.pneumatic, AlertProblemType.sensor]
# Machines we *prefer* to make the showcase "problem" cases (clear where to click).
SHOWCASE = ["stefani", "ima 5", "homag kal", "powerflex"]


def _r(rng):  # uniform from a (lo, hi) tuple, 1 decimal
    return round(random.uniform(*rng), 1)


async def clean(db):
    """Remove every tagged simulation row (safe — never touches real data)."""
    # Break the alert<->ticket cross-FK before deleting either side.
    await db.execute(update(MaintenanceAlert).where(
        MaintenanceAlert.alert_number.like("ALT-SIM-%")).values(ticket_id=None))
    await db.execute(update(MaintenanceTicket).where(
        MaintenanceTicket.ticket_number.like("TKT-SIM-%")).values(alert_id=None))
    await db.execute(delete(MachineIntervention).where(MachineIntervention.operator_note.like(f"{TAG}%")))
    await db.execute(delete(MachineStop).where(MachineStop.comments.like(f"{TAG}%")))
    await db.execute(delete(MaintenanceTicket).where(MaintenanceTicket.ticket_number.like("TKT-SIM-%")))
    await db.execute(delete(MaintenanceAlert).where(MaintenanceAlert.alert_number.like("ALT-SIM-%")))
    await db.execute(delete(MachineProductionLog).where(MachineProductionLog.job_number.like(f"{SIMJOB}%")))
    await db.commit()


async def generate(db, days: int):
    await clean(db)                                   # idempotent: start from a clean slate
    now = datetime.now(timezone.utc)

    machines = (await db.execute(
        select(Machine).where(Machine.is_active == True, Machine.equipment_id.isnot(None))  # noqa: E712
    )).scalars().all()
    if not machines:
        print("No active machines with equipment link found."); return

    cats = {c.type: c for c in (await db.execute(
        select(StopCategory).where(StopCategory.is_global == True)  # noqa: E712
    )).scalars().all()}
    cat_planned = cats.get(StopCategoryType.planned)
    cat_unplanned = cats.get(StopCategoryType.unplanned)
    cat_maint = cats.get(StopCategoryType.maintenance)

    # Subcategories per category (sorted), so each stop also gets a subgroup — the
    # Pareto drill-down works on real data. Weighted so the first subgroup dominates
    # (a natural Pareto shape) instead of a flat split.
    subs_by_cat: dict = {}
    for s in (await db.execute(
        select(StopSubcategory).where(StopSubcategory.is_active == True)  # noqa: E712
    )).scalars().all():
        subs_by_cat.setdefault(s.category_id, []).append(s)
    for lst in subs_by_cat.values():
        lst.sort(key=lambda s: s.sort_order)

    def pick_sub(cat_id):
        lst = subs_by_cat.get(cat_id)
        if not lst:
            return None
        weights = [len(lst) - i for i in range(len(lst))]   # first = heaviest
        return random.choices(lst, weights=weights)[0]

    # Assign archetypes — prefer the showcase names as the "problem" machines.
    problem = [m for m in machines if any(k in m.name.lower() for k in SHOWCASE)][:2]
    if len(problem) < 2:
        problem = (problem + [m for m in machines if m not in problem])[:2]
    arch = {}
    for m in machines:
        if m in problem:
            arch[m.id] = "problem"
        else:
            arch[m.id] = random.choices(["healthy", "average"], weights=[72, 28])[0]

    dates = [(now - timedelta(days=i)).date() for i in range(days)]
    n_logs = n_stops = 0

    for m in machines:
        a_rng, p_rng, q_rng = ARCH[arch[m.id]]
        m.current_operator = random.choice(OPERATORS)
        # Give machines a day/evening/night shift so the timeline + pieces-per-hour
        # chart show proper shift windows (e.g. "Quart de jour 07:00–15:30").
        if not m.shifts_config:
            m.shifts_config = {
                "morning":   {"start": "07:00", "end": "15:30"},
                "afternoon": {"start": "15:30", "end": "23:30"},
                "night":     {"start": "23:30", "end": "07:00"},
            }
        target_shift = m.target_count_per_shift or random.randint(320, 560)
        for d in dates:
            for shift, start_hour in SHIFTS:
                avail, perf, qual = _r(a_rng), _r(p_rng), _r(q_rng)
                actual = round(target_shift * perf / 100)
                reject = round(actual * (1 - qual / 100))
                oee = round(avail / 100 * perf / 100 * qual / 100 * 100, 1)
                db.add(MachineProductionLog(
                    machine_id=m.id, date=d, shift=shift, job_number=f"{SIMJOB}{(m.code or 'M')[:10]}",
                    target_count=target_shift, actual_count=actual, reject_count=reject,
                    availability_pct=avail, performance_pct=perf, quality_pct=qual, oee_pct=oee,
                ))
                n_logs += 1
                # Downtime for that shift → 1 machine_stop (planned/unplanned), clamped to the past.
                down = round(SHIFT_MIN * (1 - avail / 100))
                if down >= 5 and (cat_planned or cat_unplanned):
                    cat = random.choice([c for c in (cat_planned, cat_unplanned) if c])
                    sub = pick_sub(cat.id)
                    start = datetime(d.year, d.month, d.day, start_hour, tzinfo=timezone.utc) \
                        + timedelta(minutes=random.randint(30, 300))
                    if start + timedelta(minutes=down) > now:
                        start = now - timedelta(minutes=down + 10)
                    db.add(MachineStop(
                        machine_id=m.id, started_at=start, ended_at=start + timedelta(minutes=down),
                        duration_minutes=down, stop_category_id=cat.id,
                        stop_subcategory_id=sub.id if sub else None, shift=shift,
                        comments=f"{TAG} {cat.name}", justified_by=m.current_operator,
                    ))
                    n_stops += 1

    # ── Maintenance episodes (alerts → tickets → interventions) ──
    # The 2 problem machines + a few random others, spread over the window.
    targets = problem + random.sample([m for m in machines if m not in problem],
                                      k=min(4, max(0, len(machines) - 2)))
    n_evt = 0
    for i, m in enumerate(targets, 1):
        called = now - timedelta(hours=random.uniform(2, days * 24 - 2))
        wait = round(random.uniform(6, 25), 1)            # MTTA (response time)
        dur = round(random.uniform(40, 130), 1)           # MTTR (intervention duration)
        started = called + timedelta(minutes=wait)
        completed = started + timedelta(minutes=dur)
        if completed > now:
            completed = now - timedelta(minutes=5); started = completed - timedelta(minutes=dur)
            called = started - timedelta(minutes=wait)
        ptype = random.choice(PROBLEMS)
        prio = AlertPriority.critical if m in problem else random.choice([AlertPriority.high, AlertPriority.medium])
        tech = random.choice(TECHS)

        alert = MaintenanceAlert(
            alert_number=f"ALT-SIM-{i:04d}", machine_id=m.id, problem_type=ptype, priority=prio,
            status=AlertStatus.resolved, description=f"{TAG} {ptype.value} fault on {m.name}",
            created_by=random.choice(OPERATORS), shift=random.choice([s for s, _ in SHIFTS]),
            created_at=called,
        )
        db.add(alert); await db.flush()
        ticket = MaintenanceTicket(
            ticket_number=f"TKT-SIM-{i:04d}", alert_id=alert.id, machine_id=m.id, priority=prio,
            status=TicketStatus.completed, opened_at=called, started_at=started, completed_at=completed,
            problem_type=ptype, diagnosis=f"{TAG} {ptype.value} issue diagnosed",
            corrective_action="Component adjusted / replaced", total_intervention_minutes=int(dur),
        )
        db.add(ticket); await db.flush()
        alert.ticket_id = ticket.id
        db.add(MachineIntervention(
            plant_id=m.plant_id, machine_id=m.id, equipment_id=m.equipment_id, ticket_id=ticket.id,
            status="completed", called_at=called, started_at=started, completed_at=completed,
            response_time_minutes=wait, intervention_duration_minutes=dur, total_downtime_minutes=wait + dur,
            called_by_name=alert.created_by, started_by_name=tech, completed_by_name=tech,
            intervention_type_name="Corrective", operator_note=f"{TAG} called for {ptype.value}",
            mechanic_note="Resolved.", approval_status="approved",
        ))
        # The maintenance stop on the timeline (yellow wait + purple intervention, linked by ticket).
        if cat_maint:
            db.add(MachineStop(
                machine_id=m.id, started_at=called, ended_at=completed,
                duration_minutes=int(wait + dur), stop_category_id=cat_maint.id,
                comments=f"{TAG} {cat_maint.name}", justified_by=alert.created_by, ticket_id=ticket.id,
            ))
            n_stops += 1
        n_evt += 1

    await db.commit()
    print(f"✓ Simulated {days} day(s):")
    print(f"  machines        : {len(machines)}")
    print(f"  production logs : {n_logs}")
    print(f"  machine stops   : {n_stops}")
    print(f"  maintenance evts: {n_evt}")
    print(f"  showcase problem machines (click these): {', '.join(m.name for m in problem)}")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=2, help="days of history (default 2)")
    ap.add_argument("--clean", action="store_true", help="remove all simulated data and exit")
    args = ap.parse_args()
    async with AsyncSessionLocal() as db:
        if args.clean:
            await clean(db); print("✓ Simulation data removed."); return
        await generate(db, args.days)


if __name__ == "__main__":
    asyncio.run(main())
