"""Live "factory right now" scenario — the NOW layer on top of the history sims.

Where simulate_production writes *history* (closed stops, resolved episodes),
this script stages a coherent set of OPEN, ongoing situations on the real
machines so the live map, the insights feed and Ask Ninja have real problems
to talk about:

  · STEFANI          — down 1h50, critical alert nobody answered (MTTA climbing)
  · Homag KAL 370    — technician actively working (purple, open intervention)
  · Ima 2            — MES-detected stop, still unjustified (pink)
  · ROVER B          — planned stop (Nettoyage) in progress
  · Powerflex PWX100 — 7 micro-stops today (bourrage) but currently running
  · SCM MORBIDELLI   — running at ~55 % cadence (degraded performance today)
  · FH6              — running with a reject spike today (quality ~89 %)
  · CX-220#1         — OF SIM-LIVE-2408 late: scheduled 2 days ago, still WIP
  · 8 machines with an open OF run (WIP), everything else running/idle

It also closes stale leftovers (open stops/runs/interventions older than 12 h)
and enables the 15:30–23:30 window on the assembly lines so the live line sim
can run an evening shift.

Everything is TAGGED for clean removal:
  - stops       : comments start with "[SIM-LIVE]"
  - alerts      : number starts with "ALT-LIVE-"   (tickets: "TKT-LIVE-")
  - interventions: operator_note starts with "[SIM-LIVE]"
  - job orders  : job_number starts with "SIM-LIVE-" (cascades runs)

Run inside the backend container:
    docker exec mes_backend python -m scripts.simulate_factory_live
    docker exec mes_backend python -m scripts.simulate_factory_live --clean
"""
import argparse
import asyncio
import random
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import delete, select, update

from app.db.session import AsyncSessionLocal
from app.models.models import (
    AlertPriority, AlertProblemType, AlertShift, AlertStatus, Equipment,
    JobOrder, JobOrderRun, JobOrderSource, JobOrderStatus, Machine,
    MachineIntervention, MachineProductionHourly, MachineProductionLog,
    MachineStatus, MachineStop, MaintenanceAlert, MaintenanceTicket, Plant,
    StopCategory, StopSubcategory, TicketStatus,
)

TAG = "[SIM-LIVE]"
SIM_OF = "SIM-LIVE-"

OPERATORS = ["Jean Tremblay", "Marie Gagné", "Luc Bélanger", "Sophie Roy",
             "Pierre Côté", "Nathalie Fortin"]
TECH = "André Mercier"

PRODUCTS = [
    "Table de conférence chêne 2400", "Bureau exécutif noyer",
    "Commode 6 tiroirs noyer", "Armoire de rangement 2 portes",
    "Bibliothèque modulaire", "Panneau mélamine 4x8 blanc",
    "Tête de lit capitonnée Queen", "Étagère 5 tablettes",
    "Table de chevet érable", "Comptoir de réception",
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ─── Stale leftovers (previous sims / disconnected benches) ───────────────────

async def close_stale(s) -> None:
    now = _now()
    horizon = now - timedelta(hours=12)
    n = {"stops": 0, "runs": 0, "interv": 0, "alerts": 0, "tickets": 0, "ofs": 0}

    for stop in (await s.execute(select(MachineStop).where(
            MachineStop.ended_at.is_(None), MachineStop.started_at < horizon))).scalars():
        dur = random.randint(45, 90)
        stop.ended_at = stop.started_at + timedelta(minutes=dur)
        stop.duration_minutes = dur
        n["stops"] += 1

    for run in (await s.execute(select(JobOrderRun).where(
            JobOrderRun.ended_at.is_(None), JobOrderRun.started_at < horizon))).scalars():
        run.ended_at = run.started_at + timedelta(minutes=120)
        run.duration_minutes = 120
        n["runs"] += 1

    for iv in (await s.execute(select(MachineIntervention).where(
            MachineIntervention.completed_at.is_(None),
            MachineIntervention.called_at < horizon))).scalars():
        started = iv.started_at or iv.called_at + timedelta(minutes=15)
        iv.started_at = started
        iv.completed_at = started + timedelta(minutes=75)
        iv.status = "completed"
        iv.response_time_minutes = iv.response_time_minutes or 15.0
        iv.intervention_duration_minutes = 75.0
        iv.total_downtime_minutes = (iv.response_time_minutes or 15.0) + 75.0
        iv.completed_by_name = iv.started_by_name or TECH
        n["interv"] += 1

    day_ago = now - timedelta(hours=24)
    for al in (await s.execute(select(MaintenanceAlert).where(
            MaintenanceAlert.status.in_([AlertStatus.new_alert, AlertStatus.assigned,
                                         AlertStatus.in_progress]),
            MaintenanceAlert.created_at < day_ago))).scalars():
        al.status = AlertStatus.resolved
        n["alerts"] += 1
    for tk in (await s.execute(select(MaintenanceTicket).where(
            MaintenanceTicket.status.in_([TicketStatus.open, TicketStatus.in_progress]),
            MaintenanceTicket.opened_at < day_ago))).scalars():
        tk.status = TicketStatus.completed
        tk.completed_at = tk.completed_at or now - timedelta(hours=6)
        n["tickets"] += 1

    # Old SIM in-progress OFs whose runs just got closed → completed history.
    for jo in (await s.execute(select(JobOrder).where(
            JobOrder.status == JobOrderStatus.in_progress,
            JobOrder.job_number.like("SIM-%"),
            ~JobOrder.job_number.like(f"{SIM_OF}%"),
            JobOrder.created_at < day_ago))).scalars():
        jo.status = JobOrderStatus.completed
        jo.completed_at = jo.completed_at or now - timedelta(hours=20)
        n["ofs"] += 1

    await s.commit()
    print(f"stale closed: {n}")


# ─── The NOW layer ─────────────────────────────────────────────────────────────

async def _cats(s):
    cats = {c.name: c for c in (await s.execute(
        select(StopCategory).where(StopCategory.is_global == True)  # noqa: E712
    )).scalars().all()}
    subs = {}
    for sub in (await s.execute(select(StopSubcategory))).scalars().all():
        subs[sub.name] = sub
    return cats, subs


def _stop(m, started, cat=None, sub=None, ended=None, comment="", by=None,
          ticket_id=None, source="operator"):
    dur = int((ended - started).total_seconds() / 60) if ended else None
    return MachineStop(
        machine_id=m.id, plant_id=m.plant_id, started_at=started, ended_at=ended,
        duration_minutes=dur, stop_category_id=cat.id if cat else None,
        stop_subcategory_id=sub.id if sub else None, shift=AlertShift.afternoon,
        comments=f"{TAG} {comment}".strip(), justified_by=by,
        ticket_id=ticket_id, source=source,
    )


async def now_layer(s) -> None:
    now = _now()
    today = now.date()
    plants = {p.code: p for p in (await s.execute(select(Plant))).scalars().all()}
    qs = plants["QS"]

    rows = (await s.execute(
        select(Machine, Equipment.block_kind)
        .join(Equipment, Machine.equipment_id == Equipment.id)
        .where(Machine.is_active == True,  # noqa: E712
               Machine.plant_id.in_([qs.id, plants["QM"].id]))
    )).all()
    machines = {m.name: m for m, _ in rows}
    lines = [m for m, bk in rows if bk == "assembly_line"]
    floor = [m for m, bk in rows if bk != "assembly_line" and not (m.code or "").startswith("EXTE-")]

    cats, subs = await _cats(s)
    unplanned, planned, maint = cats.get("Unplanned Stop"), cats.get("Planned Stop"), cats.get("Maintenance Requested")

    # 1) Baseline sweep: everything runs the afternoon shift; two idle.
    idle_codes = {"MILL-CUT-01", "PARA-GRO-01"}
    for m in floor:
        m.current_shift = AlertShift.afternoon
        m.current_operator = m.current_operator or random.choice(OPERATORS)
        m.current_status = MachineStatus.idle if m.code in idle_codes else MachineStatus.running
        if m.code in idle_codes:
            m.current_job_number = None

    # 2) Open OF runs (WIP) on 8 real machines.
    seq = 2401
    def of_on(m, frac, minutes_ago, src=JobOrderSource.smart_label, product=None,
              qty=None, scheduled=None, started_days_ago=None):
        nonlocal seq
        qty = qty or random.choice([16, 24, 32, 40, 60])
        jo = JobOrder(
            job_number=f"{SIM_OF}{seq}", product_name=product or random.choice(PRODUCTS),
            target_quantity=qty, plant_id=m.plant_id, department=m.department,
            machine_id=m.id, source=src, status=JobOrderStatus.in_progress,
            started_at=now - timedelta(days=started_days_ago) if started_days_ago
                       else now - timedelta(minutes=minutes_ago),
            scheduled_date=scheduled,
        )
        s.add(jo)
        run = JobOrderRun(
            job_order_id=None, machine_id=m.id, plant_id=m.plant_id,
            department=m.department, started_at=now - timedelta(minutes=minutes_ago),
            ended_at=None, duration_minutes=None,
            pieces=int(qty * frac), rejects=random.randint(0, 1), source=src,
        )
        m.current_job_number = jo.job_number
        seq += 1
        return jo, run

    wip = []
    for name, frac, ago in [
        ("Ima 5", 0.55, 95), ("Schelling 3", 0.4, 70), ("SCM MORBIDELLI M400 2016", 0.35, 120),
        ("FH6", 0.6, 80), ("Powerflex PWX100", 0.5, 45), ("UX-200#1", 0.3, 30),
        ("Rover", 0.7, 140),
    ]:
        m = machines.get(name)
        if m:
            wip.append(of_on(m, frac, ago))

    # Late OF: scheduled 2 days ago, two stations done, still WIP on CX-220#1.
    cx = machines.get("CX-220#1")
    late_jo = None
    if cx:
        late_jo, late_run = of_on(
            cx, 0.6, 180, src=JobOrderSource.cortex, product="Commode 6 tiroirs noyer",
            qty=48, scheduled=today - timedelta(days=2), started_days_ago=2)
        wip.append((late_jo, late_run))

    await s.flush()
    for jo, run in wip:
        run.job_order_id = jo.id
        s.add(run)
    if late_jo is not None:
        for st_name, days_ago, dur in [("Schelling 3", 2, 95), ("Ima 3", 1, 110)]:
            st = machines.get(st_name)
            if st is None:
                continue
            started = now - timedelta(days=days_ago, minutes=dur)
            s.add(JobOrderRun(
                job_order_id=late_jo.id, machine_id=st.id, plant_id=st.plant_id,
                department=st.department, started_at=started,
                ended_at=started + timedelta(minutes=dur), duration_minutes=dur,
                pieces=48, rejects=1, source=JobOrderSource.cortex))

    # Pending queue for the next days.
    for k, d in [(0, 0), (1, 1)]:
        s.add(JobOrder(
            job_number=f"{SIM_OF}{seq + k}", product_name=random.choice(PRODUCTS),
            target_quantity=random.choice([20, 36]), plant_id=qs.id,
            source=JobOrderSource.smart_label, status=JobOrderStatus.pending,
            scheduled_date=today + timedelta(days=d)))

    # 3) STEFANI — down 1h50, critical alert unanswered (MTTA climbing).
    stef = machines.get("STEFANI")
    if stef:
        called = now - timedelta(minutes=105)
        stef.current_status = MachineStatus.stopped
        stef.current_job_number = None
        s.add(_stop(stef, now - timedelta(minutes=110), unplanned, subs.get("Maintenance"),
                    comment="Casse du groupe d'encollage — attente maintenance",
                    by=stef.current_operator))
        alert = MaintenanceAlert(
            alert_number="ALT-LIVE-0001", machine_id=stef.id, plant_id=stef.plant_id,
            department=stef.department, problem_type=AlertProblemType.mechanical,
            priority=AlertPriority.critical, status=AlertStatus.new_alert,
            description=f"{TAG} Groupe d'encollage bloqué — bris mécanique, production arrêtée",
            created_by=stef.current_operator, shift=AlertShift.afternoon,
            created_at=called, is_overdue=True, escalation_level=1,
            escalated_at=now - timedelta(minutes=45),
        )
        s.add(alert)
        s.add(MachineIntervention(
            plant_id=stef.plant_id, machine_id=stef.id, equipment_id=stef.equipment_id,
            status="waiting", called_at=called, called_by_name=stef.current_operator,
            operator_note=f"{TAG} Encolleuse bloquée, appel maintenance — personne n'a répondu",
        ))

    # 4) Homag KAL 370 — technician actively working (purple).
    homag = machines.get("Homag KAL 370")
    if homag:
        called = now - timedelta(minutes=55)
        started = now - timedelta(minutes=40)
        homag.current_status = MachineStatus.intervention
        homag.current_job_number = None
        ticket = MaintenanceTicket(
            ticket_number="TKT-LIVE-0002", machine_id=homag.id, plant_id=homag.plant_id,
            priority=AlertPriority.high, status=TicketStatus.in_progress,
            opened_at=called, started_at=started, problem_type=AlertProblemType.electrical,
            description=f"{TAG} Variateur d'entraînement en défaut (code F0034)",
            diagnosis="Variateur en défaut thermique — ventilation encrassée",
        )
        s.add(ticket)
        await s.flush()
        alert2 = MaintenanceAlert(
            alert_number="ALT-LIVE-0002", machine_id=homag.id, plant_id=homag.plant_id,
            department=homag.department, problem_type=AlertProblemType.electrical,
            priority=AlertPriority.high, status=AlertStatus.in_progress,
            description=f"{TAG} Variateur d'entraînement en défaut — technicien sur place",
            created_by=homag.current_operator, shift=AlertShift.afternoon,
            created_at=called, ticket_id=ticket.id,
        )
        s.add(alert2)
        s.add(MachineIntervention(
            plant_id=homag.plant_id, machine_id=homag.id, equipment_id=homag.equipment_id,
            ticket_id=ticket.id, status="in_progress", called_at=called, started_at=started,
            called_by_name=homag.current_operator, started_by_name=TECH,
            response_time_minutes=15.0, intervention_type_name="Corrective",
            operator_note=f"{TAG} Ligne en défaut variateur",
            mechanic_note="Ventilation nettoyée, test de redémarrage en cours",
        ))
        s.add(_stop(homag, called, maint, None, comment="Variateur d'entraînement en défaut",
                    by=homag.current_operator, ticket_id=ticket.id))

    # 5) Ima 2 — MES-detected stop, still unjustified (pink).
    ima2 = machines.get("Ima 2")
    if ima2:
        ima2.current_status = MachineStatus.unjustified
        ima2.current_job_number = None
        s.add(_stop(ima2, now - timedelta(minutes=25), None, None,
                    comment="", by=None, source="mes"))

    # 6) ROVER B — planned cleaning stop in progress.
    rover_b = machines.get("ROVER B")
    if rover_b:
        rover_b.current_status = MachineStatus.planned_stop
        rover_b.current_job_number = None
        s.add(_stop(rover_b, now - timedelta(minutes=30), planned, subs.get("Nettoyage"),
                    comment="Nettoyage hebdomadaire", by=rover_b.current_operator))

    # 7) Powerflex — 7 micro-stops today (feed jams), currently running.
    pwx = machines.get("Powerflex PWX100")
    if pwx:
        reasons = [("Materials Stop", "Bourrage alimentation panneaux"),
                   ("Materials Stop", "Bourrage convoyeur sortie"),
                   ("Quality Stop", "Contrôle épaisseur hors tolérance"),
                   ("Materials Stop", "Bourrage alimentation panneaux"),
                   ("No Operator", "Opérateur appelé ailleurs"),
                   ("Materials Stop", "Bourrage alimentation panneaux"),
                   ("Quality Stop", "Reprise de perçage")]
        t = now - timedelta(hours=6)
        for sub_name, why in reasons:
            dur = random.randint(5, 12)
            s.add(_stop(pwx, t, unplanned, subs.get(sub_name),
                        ended=t + timedelta(minutes=dur), comment=why,
                        by=pwx.current_operator))
            t += timedelta(minutes=random.randint(35, 55))

    # 8) SCM MORBIDELLI — degraded cadence today (~55 % of target).
    scm = machines.get("SCM MORBIDELLI M400 2016")
    if scm:
        tph = scm.target_count_per_hour or (scm.target_count_per_shift or 480) // 8
        for log in (await s.execute(select(MachineProductionLog).where(
                MachineProductionLog.machine_id == scm.id,
                MachineProductionLog.date == today))).scalars():
            log.performance_pct = round(random.uniform(52, 58), 1)
            log.availability_pct = round(random.uniform(84, 88), 1)
            log.quality_pct = round(random.uniform(96, 98), 1)
            log.actual_count = round((log.target_count or 400) * log.performance_pct / 100)
            log.reject_count = round(log.actual_count * (1 - log.quality_pct / 100))
            log.oee_pct = round(log.availability_pct * log.performance_pct
                                * log.quality_pct / 10000, 1)
        for h in range(6, 0, -1):
            hour = (now - timedelta(hours=h)).replace(minute=0, second=0, microsecond=0)
            s.add(MachineProductionHourly(
                machine_id=scm.id, hour=hour,
                count=max(1, int(tph * random.uniform(0.5, 0.6))),
                reject_count=random.randint(0, 2), job_number=scm.current_job_number))

    # 9) FH6 — reject spike today (quality ~89 %).
    fh6 = machines.get("FH6")
    if fh6:
        for log in (await s.execute(select(MachineProductionLog).where(
                MachineProductionLog.machine_id == fh6.id,
                MachineProductionLog.date == today))).scalars():
            log.quality_pct = round(random.uniform(88, 90), 1)
            log.reject_count = round((log.actual_count or 0) * (1 - log.quality_pct / 100))
            log.oee_pct = round((log.availability_pct or 85) * (log.performance_pct or 85)
                                * log.quality_pct / 10000, 1)

    # 10) Assembly lines: enable the evening window so the live sim can run now.
    for m in lines:
        cfg = dict(m.shifts_config or {})
        cfg.setdefault("morning", {"start": "07:00", "end": "15:25"})
        cfg["afternoon"] = {"start": "15:30", "end": "23:30"}
        m.shifts_config = cfg
        m.current_shift = AlertShift.afternoon

    await s.commit()
    print("now layer staged: 1 breakdown (STEFANI), 1 intervention (Homag KAL 370), "
          "1 unjustified (Ima 2), 1 planned stop (ROVER B), 7 micro-stops (Powerflex), "
          "degraded cadence (SCM M400), reject spike (FH6), late OF (CX-220#1), "
          f"{len(wip)} WIP OFs, evening window on {len(lines)} assembly lines.")


# ─── Clean ────────────────────────────────────────────────────────────────────

async def clean(s) -> None:
    await s.execute(update(MaintenanceAlert).where(
        MaintenanceAlert.alert_number.like("ALT-LIVE-%")).values(ticket_id=None))
    await s.execute(delete(MachineIntervention).where(
        MachineIntervention.operator_note.like(f"{TAG}%")))
    await s.execute(delete(MachineStop).where(MachineStop.comments.like(f"{TAG}%")))
    await s.execute(delete(MaintenanceTicket).where(
        MaintenanceTicket.ticket_number.like("TKT-LIVE-%")))
    await s.execute(delete(MaintenanceAlert).where(
        MaintenanceAlert.alert_number.like("ALT-LIVE-%")))
    await s.execute(delete(MachineProductionHourly).where(
        MachineProductionHourly.job_number.like(f"{SIM_OF}%")))
    await s.execute(delete(JobOrder).where(JobOrder.job_number.like(f"{SIM_OF}%")))
    await s.execute(update(Machine).where(
        Machine.current_job_number.like(f"{SIM_OF}%")).values(current_job_number=None))
    await s.commit()
    print("SIM-LIVE data removed.")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()
    async with AsyncSessionLocal() as s:
        if args.clean:
            await clean(s)
            return
        await clean(s)          # idempotent re-run
        await close_stale(s)
        await now_layer(s)


if __name__ == "__main__":
    asyncio.run(main())
