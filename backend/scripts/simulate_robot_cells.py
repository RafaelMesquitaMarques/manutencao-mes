"""Robot-cell simulator — stands in for real FANUC CRX cells until they're connected.

Picks existing cobot equipment, ensures each has a RobotCell config, then pushes
realistic telemetry frames through the SAME ingestion service the real transport
will use. Run inside the backend container, e.g.:

    docker exec mes_backend python -m scripts.simulate_robot_cells --cells 5 --frames 30 --interval 1

With --frames 0 it loops forever (Ctrl-C to stop). Direct in-process ingestion
(no HTTP) so it works regardless of the transport/auth we finalize later.
"""
import argparse
import asyncio
import math
import random
import secrets
from datetime import datetime, timezone

from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.models.models import Equipment, RobotCell
from app.schemas.robot_cell import CellTelemetry
from app.services.robot_cell_ingest import ingest_telemetry

MODELS = ["CRX-25iA", "CRX-30iA", "CRX-30iAL"]


async def _ensure_cells(db, n: int):
    """Attach RobotCell config to up to n existing cobot equipment."""
    eqs = (await db.execute(
        select(Equipment).where(Equipment.subtype.ilike("%cobot%")).limit(n)
    )).scalars().all()
    cells = []
    for i, eq in enumerate(eqs):
        cell = (await db.execute(
            select(RobotCell).where(RobotCell.equipment_id == eq.id)
        )).scalar_one_or_none()
        if cell is None:
            cell = RobotCell(
                equipment_id=eq.id, cell_model=MODELS[i % len(MODELS)],
                ip_address=f"10.10.{i // 254}.{10 + i % 254}", line=f"Line {1 + i % 4}",
                has_machine_motion=(i % 2 == 0), has_gate=(i % 3 == 0),
                has_scanner=True, has_safety_module=True,
                ingest_token=secrets.token_urlsafe(24),
            )
            db.add(cell)
    await db.commit()
    return (await db.execute(
        select(RobotCell).join(Equipment, RobotCell.equipment_id == Equipment.id)
        .where(Equipment.subtype.ilike("%cobot%")).limit(n)
    )).scalars().all()


def _frame(sim: dict, seed: float) -> CellTelemetry:
    """One realistic telemetry frame; `sim` carries per-cell counters across frames."""
    # Occasional fault (~4%), otherwise running with cycles ticking.
    faulted = random.random() < 0.04
    if faulted:
        sim["faults"] += 1
        run_state = "fault"
    else:
        run_state = "running" if random.random() < 0.9 else "idle"
    if run_state == "running":
        sim["total"] += 1
        if random.random() < 0.95:
            sim["good"] += 1
        else:
            sim["reject"] += 1
        sim["last_cycle"] = round(28 + 6 * math.sin(seed) + random.uniform(-2, 2), 1)
        sim["run_hours"] += sim["last_cycle"] / 3600.0
    total = max(sim["total"], 1)
    return CellTelemetry(
        online=True, run_state=run_state, op_mode="auto",
        servo_on=not faulted, robot_ready=not faulted,
        alarm_active=faulted,
        alarm_code="SRVO-050" if faulted else None,
        alarm_message="Collision detect alarm" if faulted else None,
        current_program="PALLET_PICK", current_sku=sim["sku"], current_wo=sim["wo"],
        cycle_running=(run_state == "running"), cycle_complete=(run_state == "running"),
        last_cycle_s=sim["last_cycle"], avg_cycle_s=round(31.0, 1),
        good_count=sim["good"], reject_count=sim["reject"], total_count=sim["total"],
        safety_ok=not faulted, estop_active=False,
        scanner_zone="occupied" if random.random() < 0.2 else "clear",
        collaborative_mode=True, reduced_speed=random.random() < 0.3,
        stopped_by_safety=False,
        gate_state=random.choice(["closed", "closed", "closed", "open", "moving"]),
        reset_required=faulted,
        robot_running_hours=round(sim["run_hours"], 2), servo_hours=round(sim["run_hours"] * 0.9, 2),
        cycle_count=sim["total"], fault_count=sim["faults"],
        availability=round(100 * sim["good"] / total, 1),
        mtbf=round(sim["run_hours"] / max(sim["faults"], 1), 2),
        mttr=round(random.uniform(0.2, 1.5), 2),
    )


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cells", type=int, default=5)
    ap.add_argument("--frames", type=int, default=30, help="0 = loop forever")
    ap.add_argument("--interval", type=float, default=1.0)
    args = ap.parse_args()

    async with AsyncSessionLocal() as db:
        cells = await _ensure_cells(db, args.cells)
    if not cells:
        print("No cobot equipment found (subtype like 'cobot'). Tag some equipment first.")
        return
    print(f"Simulating {len(cells)} cell(s). Ctrl-C to stop.")

    sims = {c.id: {"total": random.randint(50, 400), "good": 0, "reject": 0, "faults": 0,
                   "run_hours": random.uniform(100, 2000), "last_cycle": 30.0,
                   "sku": random.choice(["PNL-A100", "PNL-B220", "DRW-330"]),
                   "wo": f"WO-2026-{random.randint(1000, 9999)}"} for c in cells}
    for s in sims.values():
        s["good"] = int(s["total"] * 0.95)
        s["reject"] = s["total"] - s["good"]

    n = 0
    while args.frames == 0 or n < args.frames:
        async with AsyncSessionLocal() as db:
            fresh = (await db.execute(select(RobotCell).where(RobotCell.id.in_(list(sims.keys()))))).scalars().all()
            for cell in fresh:
                await ingest_telemetry(db, cell, _frame(sims[cell.id], n * 0.3))
        n += 1
        print(f"frame {n} pushed for {len(sims)} cells")
        if args.frames == 0 or n < args.frames:
            await asyncio.sleep(args.interval)
    print("done.")


if __name__ == "__main__":
    asyncio.run(main())
