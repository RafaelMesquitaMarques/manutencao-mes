"""Demo simulator for Ordres de fabrication (OF).

Builds a small furniture production line (Débit → Plaquage → Perçage → Assemblage)
and runs OFs through it in various states so the OF page, cost report and factory-map
conveyor panels show realistic data:
  - completed OFs   : full path across all 4 stations, in the past
  - in-progress OFs : partial path with an OPEN run on the current machine (WIP)
  - pending OFs     : created, no runs yet
Plus a few machine stops overlapping runs (so productive time < presence → the cost
rule "stops excluded" is visible).

Everything is TAGGED for clean removal:
  - machines   : name starts with "SIM · "
  - job orders : job_number starts with "SIM-OF-"
  - stops      : comments start with "[SIM]"

Run inside the backend container:
    docker exec mes_backend python -m scripts.simulate_job_orders --plant QS
    docker exec mes_backend python -m scripts.simulate_job_orders --clean
Re-running regenerates (it wipes the previous SIM data first).
"""
import argparse
import asyncio
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, delete

from app.db.session import AsyncSessionLocal
from app.models.models import (
    Plant, Machine, JobOrder, JobOrderRun, MachineStop, Department,
    JobOrderStatus, JobOrderSource, MachineStatus, HourlyRateCurrency,
)

SIM_MACHINE = "SIM · "
SIM_OF = "SIM-OF-"
SIM_STOP = "[SIM]"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# The line: (machine name, department, hourly rate)
LINE = [
    ("SIM · Scie à panneaux",      "Débit",      95.0),
    ("SIM · Plaqueuse de chants",  "Plaquage",   85.0),
    ("SIM · Perceuse CNC",         "Perçage",   110.0),
    ("SIM · Poste d'assemblage",   "Assemblage", 70.0),
]

# (job suffix, product, qty, status, stages) — stages = how far down the line.
PLAN = [
    ("2401", "Table de conférence chêne 2400", 12, "completed",   4),
    ("2402", "Bureau exécutif noyer",           8, "completed",   4),
    ("2403", "Chaise empilable hêtre",         60, "completed",   4),
    ("2404", "Armoire de rangement",           20, "in_progress", 1),  # open @ Débit
    ("2405", "Panneau acoustique mural",       40, "in_progress", 2),  # open @ Plaquage
    ("2406", "Comptoir de réception",           4, "in_progress", 4),  # open @ Assemblage
    ("2407", "Étagère modulaire",              30, "pending",      0),
    ("2408", "Table d'appoint érable",         24, "pending",      0),
]
SOURCES = [JobOrderSource.smart_label, JobOrderSource.cortex, JobOrderSource.manual]


async def _get_plant(s, code):
    if code:
        p = (await s.execute(select(Plant).where(Plant.code == code))).scalar_one_or_none()
        if p:
            return p
    return (await s.execute(select(Plant).order_by(Plant.code))).scalars().first()


async def clean(s) -> int:
    sim_ids = (await s.execute(
        select(Machine.id).where(Machine.name.like(SIM_MACHINE + "%"))
    )).scalars().all()
    if sim_ids:
        await s.execute(delete(MachineStop).where(MachineStop.machine_id.in_(sim_ids)))
    n = len((await s.execute(select(JobOrder.id).where(JobOrder.job_number.like(SIM_OF + "%")))).scalars().all())
    await s.execute(delete(JobOrder).where(JobOrder.job_number.like(SIM_OF + "%")))  # cascades runs
    if sim_ids:
        await s.execute(delete(JobOrderRun).where(JobOrderRun.machine_id.in_(sim_ids)))
        await s.execute(delete(Machine).where(Machine.id.in_(sim_ids)))
    await s.commit()
    return len(sim_ids) + n


def _currency(plant) -> HourlyRateCurrency:
    try:
        return HourlyRateCurrency((plant.currency or "CAD"))
    except ValueError:
        return HourlyRateCurrency.CAD


async def generate(plant_code):
    async with AsyncSessionLocal() as s:
        await clean(s)
        plant = await _get_plant(s, plant_code)
        if not plant:
            print("No plant found — aborting.")
            return
        cur = _currency(plant)

        # 0) Ensure the line's departments exist in the managed registry (idempotent).
        #    NOT removed on --clean (they may be legit registry entries the user keeps).
        for _, dept, _ in LINE:
            exists = (await s.execute(select(Department).where(
                Department.plant_id == plant.id, Department.name == dept))).scalar_one_or_none()
            if not exists:
                s.add(Department(plant_id=plant.id, name=dept))
        await s.flush()

        # 1) The line of SIM machines.
        line = []
        for name, dept, rate in LINE:
            m = Machine(name=name, department=dept, plant_id=plant.id,
                        hourly_rate=rate, hourly_rate_currency=cur,
                        current_status=MachineStatus.idle, is_active=True)
            s.add(m)
            line.append((m, dept, rate))
        await s.flush()

        created_runs = []   # (run, started, ended) for closed runs → for stops
        counts = {"completed": 0, "in_progress": 0, "pending": 0}

        for suffix, product, qty, status, stages in PLAN:
            src = random.choice(SOURCES)
            jo = JobOrder(job_number=f"{SIM_OF}{suffix}", product_name=product,
                          target_quantity=qty, plant_id=plant.id, source=src,
                          status=JobOrderStatus.pending)
            s.add(jo)
            await s.flush()
            counts[status] += 1

            if status == "pending":
                jo.scheduled_date = (_now() + timedelta(days=random.randint(1, 5))).date()
                continue

            if status == "completed":
                # Forward from 1–3 days ago through every station.
                t = _now() - timedelta(days=random.uniform(1.0, 3.0))
                last = None
                for i in range(stages):
                    m, dept, _ = line[i]
                    dur = random.randint(80, 200)
                    started, ended = t, t + timedelta(minutes=dur)
                    run = JobOrderRun(job_order_id=jo.id, machine_id=m.id, plant_id=plant.id,
                                      department=dept, started_at=started, ended_at=ended,
                                      duration_minutes=dur, pieces=qty,
                                      rejects=random.randint(0, 2), source=src)
                    s.add(run)
                    created_runs.append((run, started, ended, m))
                    last = (m, dept, ended, started if last is None else jo.started_at)
                    if jo.started_at is None:
                        jo.started_at = started
                    t = ended + timedelta(minutes=random.randint(20, 120))
                jo.machine_id, jo.department = last[0].id, last[1]
                jo.status = JobOrderStatus.completed
                jo.completed_at = last[2]

            else:  # in_progress — build backward so the OPEN run is recent.
                m, dept, _ = line[stages - 1]
                open_start = _now() - timedelta(minutes=random.randint(25, 130))
                s.add(JobOrderRun(job_order_id=jo.id, machine_id=m.id, plant_id=plant.id,
                                  department=dept, started_at=open_start, ended_at=None,
                                  duration_minutes=None,
                                  pieces=int(qty * random.uniform(0.3, 0.85)),
                                  rejects=random.randint(0, 1), source=src))
                cursor = open_start
                first_start = open_start
                for i in range(stages - 2, -1, -1):
                    mm, dd, _ = line[i]
                    dur = random.randint(70, 160)
                    ended = cursor - timedelta(minutes=random.randint(15, 60))
                    started = ended - timedelta(minutes=dur)
                    run = JobOrderRun(job_order_id=jo.id, machine_id=mm.id, plant_id=plant.id,
                                      department=dd, started_at=started, ended_at=ended,
                                      duration_minutes=dur, pieces=qty,
                                      rejects=random.randint(0, 2), source=src)
                    s.add(run)
                    created_runs.append((run, started, ended, mm))
                    cursor = started
                    first_start = started
                jo.started_at = first_start
                jo.machine_id, jo.department = m.id, dept
                jo.status = JobOrderStatus.in_progress
                m.current_job_number = jo.job_number
                m.current_status = MachineStatus.running

        # 2) A few stops overlapping closed runs → productive < presence.
        n_stops = 0
        for run, started, ended, m in random.sample(created_runs, min(4, len(created_runs))):
            span = (ended - started).total_seconds() / 60
            if span < 40:
                continue
            off = random.randint(5, int(span - 30))
            dur = random.randint(15, 30)
            s.add(MachineStop(machine_id=m.id, plant_id=plant.id,
                              started_at=started + timedelta(minutes=off),
                              ended_at=started + timedelta(minutes=off + dur),
                              duration_minutes=dur, comments=f"{SIM_STOP} arrêt simulé"))
            n_stops += 1

        await s.commit()
        print(f"Plant {plant.code} — created {len(LINE)} SIM machines, "
              f"{sum(counts.values())} OFs "
              f"({counts['completed']} completed, {counts['in_progress']} in-progress, "
              f"{counts['pending']} pending), {n_stops} stops.")
        print("View: /job-orders  ·  factory map conveyors (tie a conveyor to a SIM machine).")
        print("Remove with: python -m scripts.simulate_job_orders --clean")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", default=None, help="Plant code (e.g. QS). Default: first plant.")
    ap.add_argument("--clean", action="store_true", help="Remove all SIM OF data and machines.")
    args = ap.parse_args()
    if args.clean:
        async with AsyncSessionLocal() as s:
            n = await clean(s)
            print(f"Removed SIM OF data ({n} machines + OFs).")
        return
    await generate(args.plant)


if __name__ == "__main__":
    asyncio.run(main())
