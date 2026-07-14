"""Auto-link conveyor props to the machine whose ORBIT they sit in.

The 3D map shows, over each machine-linked conveyor, the OF currently loaded at
that machine (chip `Entrée/Sortie · OF n`), and clicking it opens the machine's
OF panel. Linking is normally done by hand in the map's Edit mode (select the
conveyor → "machine des OF" + role); this script bulk-fills the obvious cases:

  a conveyor prop whose CENTRE falls inside a production machine's orbit
  rectangle (explicit orbit_* or footprint + 60 px margin — the same rule the
  map uses to auto-link cobots) gets machine_id = that machine.

Conservative on purpose: only props with machine_id still NULL are touched
(manual choices and deliberate unlinks survive), role is left NULL (set
Entrée/Sortie by hand where the direction matters), and assembly lines /
pit stop are never link targets. Re-run any time; idempotent.

Run inside the backend container:
    docker exec mes_backend python -m scripts.link_conveyor_props --plant QS
    docker exec mes_backend python -m scripts.link_conveyor_props --plant QS --unlink-auto  # undo (role IS NULL only)
"""
import argparse
import asyncio

from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.models.models import Equipment, Machine, MapProp, Plant

ORBIT_MARGIN = 60  # px — mirrors frontend ORBIT_MARGIN (Factory3D.tsx)


def _orbit(e: Equipment):
    px, py = e.pos_x or 0, e.pos_y or 0
    pw, ph = e.pos_w or 152, e.pos_h or 64
    return (
        e.orbit_x if e.orbit_x is not None else px - ORBIT_MARGIN,
        e.orbit_y if e.orbit_y is not None else py - ORBIT_MARGIN,
        e.orbit_w if e.orbit_w is not None else pw + 2 * ORBIT_MARGIN,
        e.orbit_h if e.orbit_h is not None else ph + 2 * ORBIT_MARGIN,
    )


async def link(plant_code: str) -> None:
    async with AsyncSessionLocal() as s:
        plant = (await s.execute(select(Plant).where(Plant.code == plant_code))).scalar_one_or_none()
        if plant is None:
            raise SystemExit(f"plant {plant_code!r} not found")

        hosts = (await s.execute(
            select(Equipment, Machine)
            .join(Machine, Machine.equipment_id == Equipment.id)
            .where(
                Equipment.plant_id == plant.id,
                Equipment.active == True,  # noqa: E712
                Equipment.pos_x.isnot(None),
                Equipment.asset_type == "production",
            )
        )).all()
        hosts = [(e, m) for e, m in hosts
                 if (e.block_kind or "") not in ("assembly_line", "pit_stop")]

        props = (await s.execute(
            select(MapProp).where(
                MapProp.plant_id == plant.id,
                MapProp.kind == "conveyor",
                MapProp.machine_id.is_(None),
            )
        )).scalars().all()

        linked = 0
        for p in props:
            cx = p.pos_x + (p.pos_w or 0) / 2
            cy = p.pos_y + (p.pos_h or 0) / 2
            best, best_d = None, None
            for e, m in hosts:
                ox, oy, ow, oh = _orbit(e)
                if ox <= cx <= ox + ow and oy <= cy <= oy + oh:
                    d = (cx - (ox + ow / 2)) ** 2 + (cy - (oy + oh / 2)) ** 2
                    if best_d is None or d < best_d:
                        best, best_d = (e, m), d
            if best is not None:
                p.machine_id = best[1].id
                linked += 1
                print(f"  + conveyor @({p.pos_x:.0f},{p.pos_y:.0f}) → {best[0].name}")
        await s.commit()
        print(f"Linked {linked} conveyor(s); {len(props) - linked} outside every orbit left untouched.")


async def unlink_auto(plant_code: str) -> None:
    """Undo pass: clears machine_id ONLY where role is still NULL (i.e. links this
    script plausibly made — hand-configured Entrée/Sortie conveyors are kept)."""
    async with AsyncSessionLocal() as s:
        plant = (await s.execute(select(Plant).where(Plant.code == plant_code))).scalar_one_or_none()
        if plant is None:
            raise SystemExit(f"plant {plant_code!r} not found")
        props = (await s.execute(
            select(MapProp).where(
                MapProp.plant_id == plant.id,
                MapProp.kind == "conveyor",
                MapProp.machine_id.isnot(None),
                MapProp.role.is_(None),
            )
        )).scalars().all()
        for p in props:
            p.machine_id = None
        await s.commit()
        print(f"Unlinked {len(props)} auto-linked conveyor(s) (role IS NULL).")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", default="QS", help="plant code (default QS)")
    ap.add_argument("--unlink-auto", action="store_true", help="undo: clear links whose role is NULL")
    args = ap.parse_args()
    asyncio.run(unlink_auto(args.plant) if args.unlink_auto else link(args.plant))
