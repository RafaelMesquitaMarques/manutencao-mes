"""Demo simulator for the Pit Stop buffer (fabrication → assemblage).

Populates the buffer with OFs in every state the 3D zone can show:
  in full (100%) · almost (≥90%) · partial · on hold / quality / rework ·
  released (partial outbound) · gone (fully shipped) · late (past scheduled
  date or over the age threshold) · plus a few flagged anomalies (duplicate
  scan, component outside the BOM, unknown OF).

Everything is TAGGED for clean removal:
  - job orders : job_number starts with "SIM-PS-"  (delete cascades BOM,
                 movements and state rows)
  - movements  : source = 'simulated'

Requires scripts.seed_pit_stop to have run (the zone must exist).

Run inside the backend container:
    docker exec mes_backend python -m scripts.simulate_pit_stop --plant QS
    docker exec mes_backend python -m scripts.simulate_pit_stop --plant QS --reset   # wipe SIM data only
    docker exec mes_backend python -m scripts.simulate_pit_stop --plant QS --live    # drip movements forever
Re-running regenerates (it wipes the previous SIM data first).
"""
import argparse
import asyncio
import random
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import delete, func as safunc, select

from app.db.session import AsyncSessionLocal
from app.models.models import (
    Equipment, JobOrder, JobOrderComponent, JobOrderSource, JobOrderStatus,
    Machine, PitStopCategory, PitStopDirection, PitStopHoldKind, PitStopMovement,
    PitStopOfState, PitStopSource, Plant,
)
from app.services.job_order_service import scan_job_order_at_machine
from app.services.pit_stop_service import (
    get_or_create_state, get_pit_stop_equipment, ingest_movement, of_family,
    pit_stop_config,
)

SIM_OF = "SIM-PS-"

PRODUCTS = [
    "Lit plateforme chêne 54\"", "Commode 6 tiroirs noyer", "Table de chevet érable",
    "Bureau étudiant 42\"", "Tête de lit rembourrée Queen", "Armoire 2 portes",
    "Banc d'entrée coussiné", "Étagère 5 tablettes", "Pupitre double mélamine",
    "Sofa 2 places tissu gris", "Fauteuil lounge beige", "Miroir encadré 30x40",
]

# component code prefix per (default) category name
CODE_PREFIX = {
    "Panneaux": "PAN", "Quincaillerie": "QUI", "Tiroirs": "TIR", "Coussins": "COU",
}

# BOM shape per furniture family (see seed_pit_stop.DEFAULT_CATEGORIES):
#   soft goods  → only the rigid components are buffered here (panels + hardware);
#   case goods  → panels + hardware, plus drawers / cushions when the piece has them.
SHARED_CATS = ["Panneaux", "Quincaillerie"]
CG_OPTIONAL = [("Tiroirs", 0.6), ("Coussins", 0.4)]   # (category, probability the piece has it)


def _family_cats(fam, cats, rng):
    """Category names for one OF's BOM, respecting the furniture family: soft goods
    buffer only panels + hardware; case goods add drawers / cushions when present.
    Falls back to a small random pick if the registry lacks the default names."""
    chosen = [c for c in SHARED_CATS if c in cats]
    if fam == "cg":
        for cat, p in CG_OPTIONAL:
            if cat in cats and rng.random() < p:
                chosen.append(cat)
    if not chosen and cats:
        chosen = rng.sample(cats, k=min(2, len(cats)))
    return chosen


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _plant(s, code):
    p = (await s.execute(select(Plant).where(Plant.code == code))).scalar_one_or_none()
    if p is None:
        raise SystemExit(f"plant {code!r} not found")
    return p


async def reset(s, plant) -> int:
    """Remove ONLY simulator data: SIM-PS-* OFs (cascade wipes their BOM,
    movements and state) + any stray simulated movements of the plant."""
    ids = (await s.execute(
        select(JobOrder.id).where(
            JobOrder.job_number.like(SIM_OF + "%"), JobOrder.plant_id == plant.id)
    )).scalars().all()
    await s.execute(delete(PitStopMovement).where(
        PitStopMovement.plant_id == plant.id,
        PitStopMovement.source == PitStopSource.simulated,
    ))
    if ids:
        await s.execute(delete(JobOrder).where(JobOrder.id.in_(ids)))
    return len(ids)


async def _lines(s, plant):
    rows = (await s.execute(
        select(Machine).join(Equipment, Machine.equipment_id == Equipment.id).where(
            Machine.plant_id == plant.id, Equipment.block_kind == "assembly_line")
    )).scalars().all()
    return rows


async def _fab_machines(s, plant):
    """Placed fabrication machines with a kiosk — targets of the simulated OF
    scans (their linked conveyors then show the `OF n` chip on the 3D map)."""
    rows = (await s.execute(
        select(Machine, Equipment)
        .join(Equipment, Machine.equipment_id == Equipment.id)
        .where(
            Machine.plant_id == plant.id,
            Equipment.pos_x.isnot(None),
            Equipment.active == True,  # noqa: E712
            Equipment.asset_type == "production",
        )
    )).all()
    return [m for m, e in rows if (e.block_kind or "") not in ("assembly_line", "pit_stop")]


async def _categories(s, plant):
    rows = (await s.execute(
        select(PitStopCategory).where(PitStopCategory.plant_id == plant.id)
        .order_by(PitStopCategory.sort_order)
    )).scalars().all()
    return [c.name for c in rows] or list(CODE_PREFIX)


def _positions_for(cfg, rng, family="cg", n=1):
    """A bin in the family's physical area: soft goods land in the FIRST `sg_lanes`
    lanes, case goods in the rest — matching the CG/SG split drawn on the 3D map."""
    sg = int(cfg.get("sg_lanes", 0) or 0)
    if family == "sg" and sg > 0:
        lane = rng.randint(1, sg)
    else:
        lane = rng.randint(min(sg + 1, cfg["lanes"]), cfg["lanes"])
    return [f"L{lane:02d}-P{rng.randint(1, cfg['slots_per_lane']):02d}" for _ in range(n)]


async def _spawn_of(s, plant, cfg, cats, lines, idx, rng, profile):
    """One OF with BOM + inbound history matching `profile`
    (full | almost | partial | hw_wait | hold | released | gone)."""
    jo = JobOrder(
        job_number=f"{SIM_OF}{2000 + idx}",
        plant_id=plant.id,
        product_name=rng.choice(PRODUCTS),
        target_quantity=rng.choice([12, 24, 36, 48, 60]),
        eu_per_unit=round(rng.uniform(0.4, 1.6), 1),   # EU factor (1 EU = 100 s of line time)
        scheduled_date=date.today() + timedelta(days=rng.randint(-2, 6)),
        status=JobOrderStatus.in_progress,
        source=JobOrderSource.erp,
    )
    s.add(jo)
    await s.flush()

    # BOM composition follows the furniture family (same rule as the API's
    # of_family): soft goods buffer only panels + hardware; case goods add drawers
    # and/or cushions when the piece has them.
    fam = of_family(jo.product_name, [])
    chosen = _family_cats(fam, cats, rng)
    bom = []
    for i, cat in enumerate(chosen):
        prefix = CODE_PREFIX.get(cat, cat[:3].upper())
        required = rng.choice([8, 12, 16, 24, 32, 48])
        code = f"{prefix}-{idx:03d}{chr(65 + i)}"
        s.add(JobOrderComponent(
            job_order_id=jo.id, component_code=code, label=f"{cat} · {jo.product_name}",
            category=cat, required_qty=required, source=PitStopSource.simulated,
        ))
        bom.append((code, required))
    await s.flush()

    factor = {
        "full": 1.0, "released": 1.0, "gone": 1.0, "hold": rng.uniform(0.4, 1.0),
        "almost": rng.uniform(0.90, 0.99), "partial": rng.uniform(0.25, 0.85),
        "hw_wait": 1.0,   # everything in full EXCEPT the hardware (below)
    }[profile]
    age_h = rng.uniform(30, 70) if rng.random() < 0.25 else rng.uniform(2, 20)
    t0 = _now() - timedelta(hours=age_h)
    positions = _positions_for(cfg, rng, fam, n=1 if rng.random() < 0.8 else 2)

    for code, required in bom:
        target = required if factor >= 1.0 else int(round(required * factor))
        # per-component jitter so partial OFs miss SOME components, not all evenly
        if profile in ("partial", "almost", "hold") and rng.random() < 0.5:
            target = min(required, max(0, target + rng.randint(-3, 3)))
        # hw_wait: complete except the quincaillerie → feeds the board's
        # "Dispo en attente de Quincaillerie" row
        if profile == "hw_wait" and code.startswith("QUI"):
            target = int(round(required * rng.uniform(0.3, 0.7)))
        sent, batch_i = 0, 0
        while sent < target:
            qty = min(target - sent, rng.randint(max(2, required // 3), required))
            when = t0 + timedelta(hours=rng.uniform(0, age_h * 0.8), seconds=batch_i)
            await ingest_movement(
                s, plant.id, job_number=jo.job_number, component_code=code,
                direction=PitStopDirection.inbound, quantity=qty,
                position_code=rng.choice(positions), occurred_at=when,
                source=PitStopSource.simulated,
            )
            sent += qty
            batch_i += 1

    st = await get_or_create_state(s, jo.id, plant.id)
    if lines:
        st.destination_machine_id = rng.choice(lines).id
    if rng.random() < 0.35:
        st.priority = rng.randint(1, 9)

    if profile == "hold":
        st.hold_kind = rng.choice(list(PitStopHoldKind))
        st.hold_reason = {"hold": "Attente de planification", "quality": "Défaut de placage à vérifier",
                          "rework": "Perçage à reprendre"}[st.hold_kind.value]
    if profile in ("released", "gone"):
        st.released_at = _now() - timedelta(hours=rng.uniform(0.5, 4))
        ship = 1.0 if profile == "gone" else rng.uniform(0.2, 0.6)
        dest = rng.choice(lines).code if lines else None
        for code, required in bom:
            qty = int(round(required * ship))
            if qty <= 0:
                continue
            await ingest_movement(
                s, plant.id, job_number=jo.job_number, component_code=code,
                direction=PitStopDirection.outbound, quantity=qty,
                destination=dest, occurred_at=_now() - timedelta(minutes=rng.randint(5, 90)),
                source=PitStopSource.simulated,
            )
    return jo


async def _anomalies(s, plant, cfg, rng):
    """A few flagged-but-recorded events so the anomaly path shows in demos."""
    jo = (await s.execute(
        select(JobOrder).where(JobOrder.job_number.like(SIM_OF + "%"),
                               JobOrder.plant_id == plant.id).limit(1)
    )).scalars().first()
    if jo is None:
        return
    comp = (await s.execute(
        select(JobOrderComponent).where(JobOrderComponent.job_order_id == jo.id).limit(1)
    )).scalars().first()
    when = _now().replace(microsecond=0)
    if comp is not None:  # duplicate: identical event twice
        for _ in range(2):
            await ingest_movement(
                s, plant.id, job_number=jo.job_number, component_code=comp.component_code,
                direction=PitStopDirection.inbound, quantity=1,
                position_code=_positions_for(cfg, rng)[0], occurred_at=when,
                source=PitStopSource.simulated,
            )
    await ingest_movement(  # component outside the BOM
        s, plant.id, job_number=jo.job_number, component_code="HORS-BOM-01",
        direction=PitStopDirection.inbound, quantity=2,
        position_code=_positions_for(cfg, rng)[0], source=PitStopSource.simulated,
    )
    await ingest_movement(  # OF the platform has never seen (created on the fly + flagged)
        s, plant.id, job_number=f"{SIM_OF}GHOST", component_code="PAN-GHOST",
        direction=PitStopDirection.inbound, quantity=6,
        position_code=_positions_for(cfg, rng)[0], source=PitStopSource.simulated,
    )


async def _stalled_ofs(s, plant, cats, lines, rng, n=3):
    """OFs "parked between steps" (the Ima-4 case): worked at a fabrication
    machine hours ago, never scanned at the next step, nothing sent to the
    buffer yet — they surface ONLY as the +N queue badge on that machine's
    conveyors. Backdated scan + clear so their dwell reads 2-6 h."""
    fabs = await _fab_machines(s, plant)
    if not fabs:
        return 0
    for i in range(n):
        jo = await _spawn_live_of(s, plant, cats, lines, rng, f"{SIM_OF}{2900 + i}")
        machine = rng.choice(fabs)
        t0 = _now() - timedelta(hours=rng.uniform(3, 7))
        await scan_job_order_at_machine(s, machine, jo.job_number,
                                        source=JobOrderSource.manual, when=t0)
        # the "next OF" moment: its run closes here → parked since then
        await scan_job_order_at_machine(s, machine, None,
                                        when=t0 + timedelta(minutes=rng.randint(25, 70)))
        print(f"  ◦ stalled {jo.job_number} parked at {machine.name}")
    return n


# The cutting saws (Coupe function): no input conveyor, only a planned pipeline
# of pending OFs stacked behind them.
CUTTING_NAMES = ["SELCO", "Schelling 3", "Schelling 4", "FH6"]


async def _cutting_machines(s, plant):
    rows = (await s.execute(
        select(Machine).join(Equipment, Machine.equipment_id == Equipment.id).where(
            Machine.plant_id == plant.id,
            Equipment.pos_x.isnot(None),          # placed → the one that renders
            safunc.lower(Machine.name).in_([n.lower() for n in CUTTING_NAMES]),
        )
    )).scalars().all()
    return rows


async def _add_bom(s, jo, cats, rng):
    """Attach a small BOM to an OF (so a drained pipeline OF can flow to the buffer)."""
    for i, cat in enumerate(_family_cats(of_family(jo.product_name, []), cats, rng)):
        prefix = CODE_PREFIX.get(cat, cat[:3].upper())
        s.add(JobOrderComponent(
            job_order_id=jo.id, component_code=f"{prefix}-{jo.job_number.rsplit('-', 1)[-1]}{chr(65 + i)}",
            label=f"{cat} · {jo.product_name}", category=cat,
            required_qty=rng.choice([8, 12, 16, 24, 32]), source=PitStopSource.simulated,
        ))
    await s.flush()


async def _next_num(s, plant) -> int:
    """Max numeric SIM-PS suffix + 1 (unique across pending + in-progress)."""
    rows = (await s.execute(
        select(JobOrder.job_number).where(
            JobOrder.job_number.like(SIM_OF + "%"), JobOrder.plant_id == plant.id)
    )).scalars().all()
    nums = [int(x) for jn in rows if (x := jn.rsplit("-", 1)[-1]).isdigit()]
    return (max(nums) if nums else 2000) + 1


async def _new_pending_of(s, plant, machine, rng, number):
    """One PLANNED OF: pending, assigned to a machine, no BOM/movements yet — pure
    plan. Renders as a raw-panel slab in the machine's pipeline until scanned."""
    jo = JobOrder(
        job_number=number,
        plant_id=plant.id,
        product_name=rng.choice(PRODUCTS),
        target_quantity=rng.choice([12, 24, 36, 48]),
        machine_id=machine.id,                    # production planning assigned it here
        department=machine.department,
        scheduled_date=date.today() + timedelta(days=rng.randint(-1, 5)),
        status=JobOrderStatus.pending,
        source=JobOrderSource.erp,
    )
    s.add(jo)
    await s.flush()
    return jo


async def _seed_pipeline(s, plant, rng) -> int:
    """Fill each cutting saw's pipeline with a few pending OFs (soonest-first plan)."""
    machines = await _cutting_machines(s, plant)
    if not machines:
        print("  ▤ pipeline: no cutting machines found — skipped")
        return 0
    idx = await _next_num(s, plant)
    n = 0
    for m in machines:
        for _ in range(rng.randint(4, 9)):
            await _new_pending_of(s, plant, m, rng, f"{SIM_OF}{idx}")
            idx += 1
            n += 1
    print(f"  ▤ pipeline: {n} planned OFs across {len(machines)} cutting machines "
          f"({', '.join(m.name for m in machines)})")
    return n


PROFILE_MIX = (["full"] * 5 + ["almost"] * 4 + ["partial"] * 6 + ["hw_wait"] * 2
               + ["hold"] * 2 + ["released"] * 2 + ["gone"] * 1)


async def generate(plant_code: str, n_ofs: int, seed: int) -> None:
    rng = random.Random(seed)
    async with AsyncSessionLocal() as s:
        plant = await _plant(s, plant_code)
        eq = await get_pit_stop_equipment(s, plant.id)
        if eq is None:
            raise SystemExit("Pit stop not seeded — run scripts.seed_pit_stop first")
        cfg = pit_stop_config(eq)
        wiped = await reset(s, plant)
        cats = await _categories(s, plant)
        lines = await _lines(s, plant)
        profiles = [PROFILE_MIX[i % len(PROFILE_MIX)] for i in range(n_ofs)]
        rng.shuffle(profiles)
        for i, profile in enumerate(profiles):
            await _spawn_of(s, plant, cfg, cats, lines, i + 1, rng, profile)
        await _anomalies(s, plant, cfg, rng)
        stalled = await _stalled_ofs(s, plant, cats, lines, rng)
        pipeline = await _seed_pipeline(s, plant, rng)
        await s.commit()
        print(f"Wiped {wiped} previous SIM OFs · created {n_ofs} OFs "
              f"({', '.join(f'{profiles.count(p)} {p}' for p in dict.fromkeys(profiles))}) "
              f"+ 3 anomaly events + {stalled} stalled-at-machine OFs "
              f"+ {pipeline} pipeline OFs in {plant.code}.")


async def _spawn_live_of(s, plant, cats, lines, rng, number):
    """A brand-new OF 'coming off the machines': BOM + destination, no goods yet
    (the first inbound batch lands right after, so its stack pops into view)."""
    jo = JobOrder(
        job_number=number,
        plant_id=plant.id,
        product_name=rng.choice(PRODUCTS),
        target_quantity=rng.choice([12, 24, 36, 48]),
        scheduled_date=date.today() + timedelta(days=rng.randint(0, 4)),
        status=JobOrderStatus.in_progress,
        source=JobOrderSource.erp,
    )
    s.add(jo)
    await s.flush()
    for i, cat in enumerate(_family_cats(of_family(jo.product_name, []), cats, rng)):
        prefix = CODE_PREFIX.get(cat, cat[:3].upper())
        s.add(JobOrderComponent(
            job_order_id=jo.id, component_code=f"{prefix}-{number.rsplit('-', 1)[-1]}{chr(65 + i)}",
            label=f"{cat} · {jo.product_name}", category=cat,
            required_qty=rng.choice([8, 12, 16, 24, 32]), source=PitStopSource.simulated,
        ))
    await s.flush()
    st = await get_or_create_state(s, jo.id, plant.id)
    if lines:
        st.destination_machine_id = rng.choice(lines).id
    if rng.random() < 0.3:
        st.priority = rng.randint(1, 9)
    return jo


async def live(plant_code: str, seed: int) -> None:  # noqa: ARG001 — live varies every run on purpose
    """Continuous production demo (Ctrl-C to stop): every few seconds one event
    happens, exactly as if the SAP feed were live —

      ▶ a NEW OF starts arriving from fabrication (a stack pops up and grows),
      + inbound batches fill the missing components (plate red → yellow → green),
      ✔ the OF turns complete, ↗ gets released toward its assembly line,
      − outbound batches shrink the stack until ✕ it leaves the buffer.

    Watch the 3D map: the buffer poll (~15 s) shows a handful of these per tick."""
    rng = random.Random()                      # unseeded — a different story every run
    MAX_ACTIVE = 26                            # keep the buffer readable
    positions: dict[str, str] = {}             # OF → its lane/slot (stacks stay put)
    print("Live production demo — one event every few seconds (Ctrl-C to stop).")
    while True:
        async with AsyncSessionLocal() as s:
            plant = await _plant(s, plant_code)
            eq = await get_pit_stop_equipment(s, plant.id)
            if eq is None:
                raise SystemExit("Pit stop not seeded — run scripts.seed_pit_stop first")
            cfg = pit_stop_config(eq)
            cats = await _categories(s, plant)
            lines = await _lines(s, plant)
            fabs = await _fab_machines(s, plant)
            cutters = await _cutting_machines(s, plant)

            # Planned pipeline: pending OFs behind each cutting saw (drains as scanned).
            pending = (await s.execute(
                select(JobOrder).where(
                    JobOrder.job_number.like(SIM_OF + "%"),
                    JobOrder.plant_id == plant.id,
                    JobOrder.status == JobOrderStatus.pending,
                ).order_by(JobOrder.scheduled_date, JobOrder.created_at)
            )).scalars().all()
            pending_by_machine: dict = {}
            for j in pending:
                pending_by_machine.setdefault(j.machine_id, []).append(j)

            # Buffer flow works on IN-PROGRESS OFs only (pending = plan, not yet cut).
            orders = (await s.execute(
                select(JobOrder).where(
                    JobOrder.job_number.like(SIM_OF + "%"),
                    JobOrder.plant_id == plant.id,
                    JobOrder.status == JobOrderStatus.in_progress,
                )
            )).scalars().all()
            ids = [j.id for j in orders]
            bom: dict = {}
            for c in (await s.execute(
                select(JobOrderComponent).where(JobOrderComponent.job_order_id.in_(ids))
            )).scalars().all() if ids else []:
                bom.setdefault(c.job_order_id, []).append(c)
            got: dict = {}
            out: dict = {}
            for of_id, code, direction, qty in (await s.execute(
                select(PitStopMovement.job_order_id, PitStopMovement.component_code,
                       PitStopMovement.direction, safunc.coalesce(safunc.sum(PitStopMovement.quantity), 0))
                .where(PitStopMovement.job_order_id.in_(ids))
                .group_by(PitStopMovement.job_order_id, PitStopMovement.component_code,
                          PitStopMovement.direction)
            )).all() if ids else []:
                (got if direction == PitStopDirection.inbound else out) \
                    .setdefault(of_id, {})[code] = int(qty)
            states = {st.job_order_id: st for st in (await s.execute(
                select(PitStopOfState).where(PitStopOfState.job_order_id.in_(ids))
            )).scalars().all()} if ids else {}

            def on_hand(jo):
                g, o = got.get(jo.id, {}), out.get(jo.id, {})
                return sum(max(0, g.get(k, 0) - o.get(k, 0)) for k in g)

            def missing(jo):
                g = got.get(jo.id, {})
                return [(c, c.required_qty - g.get(c.component_code, 0))
                        for c in bom.get(jo.id, []) if g.get(c.component_code, 0) < c.required_qty]

            incomplete = [j for j in orders if bom.get(j.id) and missing(j)
                          and (states.get(j.id) is None or states[j.id].left_at is None or on_hand(j) > 0)]
            ready = [j for j in orders if bom.get(j.id) and not missing(j) and on_hand(j) > 0]
            active = sum(1 for j in orders if on_hand(j) > 0)

            def pos_for(jo):
                if jo.job_number not in positions:
                    positions[jo.job_number] = _positions_for(
                        cfg, rng, of_family(jo.product_name, []))[0]
                return positions[jo.job_number]

            roll = rng.random()
            if cutters and roll < 0.20:
                # ▤ pipeline event on a cutting saw: DRAIN (scan the next planned OF
                # → it becomes the loaded OF and flows on) or REFILL (planning adds a
                # new pending OF). Keeps each saw's pipeline between ~2 and ~10 deep.
                machine = rng.choice(cutters)
                queue = pending_by_machine.get(machine.id, [])
                if queue and (len(queue) > 8 or rng.random() < 0.55):
                    jo = queue[0]                              # soonest scheduled = next to cut
                    await _add_bom(s, jo, cats, rng)           # now it can flow to the buffer
                    await scan_job_order_at_machine(s, machine, jo.job_number, source=JobOrderSource.manual)
                    await s.commit()
                    print(f"  ▤→ {machine.name} cuts {jo.job_number} (pipeline −1 → {len(queue) - 1})")
                elif len(queue) < 10:
                    jo = await _new_pending_of(s, plant, machine, rng, f"{SIM_OF}{await _next_num(s, plant)}")
                    await s.commit()
                    print(f"  ▤+ planning → {machine.name} pipeline {jo.job_number} (→ {len(queue) + 1})")
            elif (not incomplete or roll < 0.32) and active < MAX_ACTIVE:
                # ▶ a new OF starts arriving from the machines
                number = f"{SIM_OF}{await _next_num(s, plant)}"
                jo = await _spawn_live_of(s, plant, cats, lines, rng, number)
                comp = (await s.execute(
                    select(JobOrderComponent).where(JobOrderComponent.job_order_id == jo.id)
                )).scalars().first()
                qty = min(comp.required_qty, rng.randint(3, 10))
                await ingest_movement(
                    s, plant.id, job_number=jo.job_number, component_code=comp.component_code,
                    direction=PitStopDirection.inbound, quantity=qty,
                    position_code=pos_for(jo), source=PitStopSource.simulated,
                )
                await s.commit()
                print(f"  ▶ new OF {jo.job_number} ({jo.product_name}) arriving at {pos_for(jo)} "
                      f"(+{qty} {comp.component_code})")
            elif fabs and incomplete and roll < 0.32:
                # ⚙ kiosk scan: a fabrication machine starts producing one of the
                # incomplete buffer OFs — its linked conveyors show the OF chip.
                machine = rng.choice(fabs)
                jo = rng.choice(incomplete)
                await scan_job_order_at_machine(s, machine, jo.job_number, source=JobOrderSource.manual)
                await s.commit()
                print(f"  ⚙ {machine.name} kiosk scan → {jo.job_number} ({jo.product_name})")
            elif incomplete and (roll < 0.78 or not ready):
                # + inbound batch for a missing component (fabrication producing)
                jo = rng.choice(incomplete)
                comp, short = rng.choice(missing(jo))
                qty = min(short, rng.randint(3, 14))
                await ingest_movement(
                    s, plant.id, job_number=jo.job_number, component_code=comp.component_code,
                    direction=PitStopDirection.inbound, quantity=qty,
                    position_code=pos_for(jo), source=PitStopSource.simulated,
                )
                await s.commit()
                now_full = qty >= short and len(missing(jo)) == 1
                rec = got.get(jo.id, {}).get(comp.component_code, 0) + qty
                print(f"  + {qty:>2} × {comp.component_code} → {jo.job_number} "
                      f"({rec}/{comp.required_qty})" + ("   ✔ OF complete (100 %)" if now_full else ""))
            elif ready:
                # ↗ release once, then ship batches out to the line until gone
                jo = rng.choice(ready)
                st = states.get(jo.id) or await get_or_create_state(s, jo.id, plant.id)
                dest = None
                if st.destination_machine_id:
                    dest = next((ln for ln in lines if ln.id == st.destination_machine_id), None)
                if dest is None and lines:
                    dest = rng.choice(lines)
                if st.released_at is None:
                    st.released_at = _now()
                    await s.commit()
                    print(f"  ↗ {jo.job_number} released → {dest.name if dest else '—'}")
                else:
                    g, o = got.get(jo.id, {}), out.get(jo.id, {})
                    code = rng.choice([k for k in g if g.get(k, 0) - o.get(k, 0) > 0])
                    stock = g[code] - o.get(code, 0)
                    qty = min(stock, rng.randint(5, 16))
                    await ingest_movement(
                        s, plant.id, job_number=jo.job_number, component_code=code,
                        direction=PitStopDirection.outbound, quantity=qty,
                        destination=dest.code if dest else None, source=PitStopSource.simulated,
                    )
                    await s.commit()
                    gone = on_hand(jo) - qty <= 0
                    print(f"  - {qty:>2} × {code} → {dest.name if dest else 'line'} ({jo.job_number})"
                          + ("   ✕ OF left the buffer" if gone else ""))
        await asyncio.sleep(rng.uniform(2.5, 5))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", default="QS", help="plant code (default QS)")
    ap.add_argument("--ofs", type=int, default=22, help="number of OFs to create")
    ap.add_argument("--seed", type=int, default=7, help="RNG seed (repeatable demos)")
    ap.add_argument("--reset", action="store_true", help="only wipe SIM data and exit")
    ap.add_argument("--live", action="store_true", help="drip movements forever")
    args = ap.parse_args()
    if args.reset:
        async def _r():
            async with AsyncSessionLocal() as s:
                n = await reset(s, await _plant(s, args.plant))
                await s.commit()
                print(f"Wiped {n} SIM OFs (+ simulated movements).")
        asyncio.run(_r())
    elif args.live:
        asyncio.run(live(args.plant, args.seed))
    else:
        asyncio.run(generate(args.plant, args.ofs, args.seed))
