"""Seed the Pit Stop zone (buffer fabrication → assemblage) for one plant.

Creates, idempotently (keyed by code PIT-<plant>):
  • the Equipment row with block_kind='pit_stop' — the 3D map renders the 41
    roller lanes from it; lane geometry, late threshold and the ingest token
    live in equipment.specifications (all editable without a migration);
  • the "Pit Stop" department in the plant's Department registry;
  • default component categories (name + colour) in pit_stop_categories —
    placeholders until the real category list is provided; curate them freely.

Default placement (only when the zone is not placed yet) drops it in the gap
between the fabrication cluster and the assembly lines as measured on the QS
map; adjust in the map's Edit mode like any block.

Run inside the backend container:
    docker exec mes_backend python -m scripts.seed_pit_stop --plant QS
"""
import argparse
import asyncio
import secrets

from sqlalchemy import select, func as safunc

from app.db.session import AsyncSessionLocal
from app.models.models import Department, Equipment, PitStopCategory, Plant

# Lane geometry defaults (physical reality: 41 conveyors of 44 ft, one level).
# The FIRST `sg_lanes` form the (smaller) soft-goods area; the rest are case goods.
SPEC_DEFAULTS = {
    "lanes": 41,
    "lane_length_ft": 44,
    "slots_per_lane": 8,
    "late_after_hours": 24,
    "sg_lanes": 7,             # soft-goods area ≈ 5× smaller than case goods (34 vs 7)
}

# Map placement default: the measured empty gap between fabrication (ends
# x≈1259) and the assembly lines (start x≈2756) on the QS map, sized to the
# real proportions (44 ft ≈ 290 px long, 41 lanes ≈ 1280 px across).
PLACEMENT = {"pos_x": 1840.0, "pos_y": -415.0, "pos_w": 320.0, "pos_h": 1280.0}

# Component categories per furniture family (curate colours freely afterwards):
#   • both → shared by case goods AND soft goods (Panneaux, Quincaillerie)
#   • cg   → case goods only (Tiroirs / Coussins, present only if the piece has them)
#   • sg   → soft goods only (none here — rembourrage is done on the line, not buffered)
# (name, colour, family). Rembourrage was removed: soft goods buffer only their
# rigid components (panels + hardware) in the pit.
DEFAULT_CATEGORIES = [
    ("Panneaux",      "#b98a4e", "both"),
    ("Quincaillerie", "#8f9aa8", "both"),
    ("Tiroirs",       "#5aa9a0", "cg"),
    ("Coussins",      "#d98fb6", "cg"),
]
# Legacy categories to drop when reconciling an already-seeded plant.
LEGACY_CATEGORIES = ("Rembourrage",)


async def _department_name(s, plant_id) -> str:
    dept = (await s.execute(
        select(Department).where(
            Department.plant_id == plant_id,
            safunc.lower(Department.name) == "pit stop",
        )
    )).scalars().first()
    if dept is None:
        dept = Department(plant_id=plant_id, name="Pit Stop")
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
        print(f"Seeding Pit Stop in {plant.name} ({plant.code})")

        department = await _department_name(s, plant.id)
        code = f"PIT-{plant.code}"

        eq = (await s.execute(
            select(Equipment).where(Equipment.code == code, Equipment.plant_id == plant.id)
        )).scalars().first()
        if eq is None:
            eq = Equipment(
                plant_id=plant.id,
                code=code,
                name="Pit Stop",
                department=department,
                asset_type="production",
                block_kind="pit_stop",
                function_label="Zone tampon fabrication → assemblage [staging buffer]",
                specifications={**SPEC_DEFAULTS, "ingest_token": secrets.token_hex(16)},
                **PLACEMENT,
            )
            s.add(eq)
            await s.flush()
            print(f"  + equipment {code} · Pit Stop (placed in the fabrication→assembly gap)")
        else:
            spec = dict(eq.specifications or {})
            changed = False
            for k, v in SPEC_DEFAULTS.items():
                if k not in spec:
                    spec[k] = v
                    changed = True
            if "ingest_token" not in spec:
                spec["ingest_token"] = secrets.token_hex(16)
                changed = True
            if changed:
                eq.specifications = spec
            if eq.block_kind != "pit_stop":
                eq.block_kind = "pit_stop"
                changed = True
            print(f"  = equipment {code} already exists" + (" (spec completed)" if changed else ""))

        # Reconcile the category registry to the CG/SG model (idempotent): ensure
        # every target category exists with the right family and order, keeping any
        # colour the user already curated; drop legacy categories (Rembourrage).
        existing = {
            c.name: c for c in (await s.execute(
                select(PitStopCategory).where(PitStopCategory.plant_id == plant.id)
            )).scalars().all()
        }
        added = updated = removed = 0
        for i, (name, color, family) in enumerate(DEFAULT_CATEGORIES):
            cat = existing.get(name)
            if cat is None:
                s.add(PitStopCategory(plant_id=plant.id, name=name, color=color,
                                      family=family, sort_order=i))
                added += 1
            elif cat.family != family or cat.sort_order != i:
                cat.family, cat.sort_order = family, i   # keep the curated colour
                updated += 1
        for name in LEGACY_CATEGORIES:
            cat = existing.get(name)
            if cat is not None:
                await s.delete(cat)
                removed += 1
        print(f"  = categories reconciled (+{added} new, ~{updated} updated, -{removed} legacy)")

        await s.commit()
        token = (eq.specifications or {}).get("ingest_token")
        print("Done.")
        print(f"  ingest token (X-Signal-Token for POST /api/pit-stop/{plant.id}/ingest): {token}")
        print("  Next: python -m scripts.simulate_pit_stop --plant "
              f"{plant.code}  (demo data)  ·  fine-tune placement in the map's Edit mode.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", default="QS", help="plant code (default QS = St-Jérôme)")
    args = ap.parse_args()
    asyncio.run(seed(args.plant))
