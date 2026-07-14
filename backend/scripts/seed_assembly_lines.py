"""Seed the St-Jérôme assembly lines (department Assemblage) — 7 tracked assets.

Creates, for each line, the canonical Equipment + linked Machine pair so the
lines get the whole platform for free (kiosk, OEE, stops, OFs, costs, factory
map). The Equipment carries block_kind='assembly_line' → the 2D/3D maps render
the long animated-belt shape; the Machine is what the ADAM state device (belt
running) and the Cortex end-of-line station (finished-unit scans) plug into.

Lines (as of 2026-07): 5 furniture assembly lines, 1 upholstery line and the
"coussins" cell (bed headboards).

IDEMPOTENT: rows are keyed by their code — re-running only creates what is
missing and never touches rows you have since edited. The department name is
taken from the plant's Department registry (case-insensitive match on
"assemblage", created if absent) so pickers and OF filters line up.

After seeding, per line:
  1. provision the signal token   POST /api/machines/<slug>/signal-token
  2. add its ADAM (source=state) and Cortex station in /settings/devices
  3. place it on the factory map (Edit mode) — shape is already assembly_line

Run inside the backend container:
    docker exec mes_backend python -m scripts.seed_assembly_lines --plant QS
"""
import argparse
import asyncio

from sqlalchemy import select, func as safunc

from app.db.session import AsyncSessionLocal
from app.models.models import Department, Equipment, Machine, Plant

# (equipment/machine name, code, kiosk slug)
LINES = [
    ("Ligne d'assemblage 1",  "ASM-L1",   "ligne-assemblage-1"),
    ("Ligne d'assemblage 2",  "ASM-L2",   "ligne-assemblage-2"),
    ("Ligne d'assemblage 3",  "ASM-L3",   "ligne-assemblage-3"),
    ("Ligne d'assemblage 4",  "ASM-L4",   "ligne-assemblage-4"),
    ("Ligne d'assemblage 5",  "ASM-L5",   "ligne-assemblage-5"),
    ("Ligne de rembourrage",  "ASM-REMB", "ligne-rembourrage"),
    ("Cellule coussins",      "ASM-COUS", "cellule-coussins"),
]


async def _department_name(s, plant_id) -> str:
    """The plant's registered department name for assemblage (created if absent)."""
    dept = (await s.execute(
        select(Department).where(
            Department.plant_id == plant_id,
            safunc.lower(Department.name) == "assemblage",
        )
    )).scalars().first()
    if dept is None:
        dept = Department(plant_id=plant_id, name="Assemblage")
        s.add(dept)
        await s.flush()
        print(f"  + department {dept.name!r} registered")
    return dept.name


async def seed(plant_code: str) -> None:
    async with AsyncSessionLocal() as s:
        plant = (await s.execute(
            select(Plant).where(Plant.code == plant_code)
        )).scalar_one_or_none()
        if plant is None:
            raise SystemExit(f"plant {plant_code!r} not found")
        print(f"Seeding assembly lines in {plant.name} ({plant.code})")

        department = await _department_name(s, plant.id)

        for name, code, slug in LINES:
            eq = (await s.execute(
                select(Equipment).where(Equipment.code == code, Equipment.plant_id == plant.id)
            )).scalars().first()
            if eq is None:
                eq = Equipment(
                    plant_id=plant.id,
                    code=code,
                    name=name,
                    department=department,
                    asset_type="production",
                    block_kind="assembly_line",
                    function_label="Ligne d'assemblage de meubles [furniture assembly line]",
                )
                s.add(eq)
                await s.flush()
                print(f"  + equipment {code} · {name}")
            else:
                print(f"  = equipment {code} already exists")

            machine = (await s.execute(
                select(Machine).where(Machine.code == code)
            )).scalars().first()
            if machine is None:
                machine = Machine(
                    name=name,
                    code=code,
                    equipment_id=eq.id,
                    plant_id=plant.id,
                    department=department,
                    page_slug=slug,
                )
                s.add(machine)
                await s.flush()
                print(f"  + machine   {code} · kiosk /machines/{slug}")
            else:
                print(f"  = machine   {code} already exists")

        await s.commit()
        print("Done. Next: provision signal tokens, add the ADAM (source=state) and the"
              " Cortex station per line in /settings/devices, place the lines on the map.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", default="QS", help="plant code (default QS = St-Jérôme)")
    args = ap.parse_args()
    asyncio.run(seed(args.plant))
