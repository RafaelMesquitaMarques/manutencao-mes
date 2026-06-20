"""Link cobots/conveyors to the machine they serve, set their 3D block kind, and
auto-place them near that machine on the map. Parent is inferred from the name
(editable later in the 3D editor). Idempotent; run:

    docker exec mes_backend python -m scripts.link_cobots_to_machines
"""
import asyncio
import re
from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.models.models import Equipment

# name token in the cobot/conveyor  →  exact/ilike name of the PARENT machine
PARENT_RULES = [
    (r"\bima\s*4\b",        "Ima 4"),
    (r"\bima\s*5\b",        "Ima 5"),
    (r"stefani",            "STEFANI"),
    (r"powe?rflex",         "Powerflex PWX100"),
    (r"tf.?-?\s*54",        "TF-54"),
    (r"\bkal\b",            "Homag KAL 370"),
    (r"cx.?-?220.?#?\s*2",  "CX-220#2"),
    (r"cx.?-?220.?#?\s*1",  "CX-220#1%"),     # ilike (long descriptive name)
    (r"\bux",               "UX-200#1"),       # UX-200 #1/#2 share these cobots
]

SLOT_W, SLOT_H = 90, 90          # cobot footprint
CONV_W, CONV_H = 360, 90         # conveyor footprint


async def main():
    async with AsyncSessionLocal() as db:
        all_eq = (await db.execute(select(Equipment))).scalars().all()
        by_name = {e.name: e for e in all_eq}

        def resolve_parent(target: str):
            if target.endswith("%"):
                pref = target[:-1]
                for e in all_eq:
                    if e.name.startswith(pref):
                        return e
                return None
            return by_name.get(target)

        targets = [(re.compile(rx, re.I), resolve_parent(name)) for rx, name in PARENT_RULES]

        # blocks to wire: cobots + conveyors
        blocks = [e for e in all_eq if "cobot" in (e.subtype or "").lower()
                  or "conveyor" in (e.subtype or "").lower() or "convoyeur" in e.name.lower()]

        # grid fallback origin (top-left corner of the map) for unplaced parents
        grid = [40, 40]
        matched = unmatched = placed = 0
        for b in blocks:
            is_cobot = "cobot" in (b.subtype or "").lower()
            b.block_kind = "cobot" if is_cobot else "conveyor"
            w, h = (SLOT_W, SLOT_H) if is_cobot else (CONV_W, CONV_H)
            if b.pos_w is None:
                b.pos_w = w
            if b.pos_h is None:
                b.pos_h = h

            parent = next((p for rx, p in targets if p and rx.search(b.name)), None)
            if parent:
                b.parent_equipment_id = parent.id
                matched += 1
            else:
                unmatched += 1

            if b.pos_x is None or b.pos_y is None:           # place if not placed yet
                entry = "entr" in b.name.lower()
                if parent and parent.pos_x is not None and parent.pos_y is not None:
                    dx = -(w + 20) if entry else (parent.pos_w or 152) + 20
                    b.pos_x = max(0, round(parent.pos_x + dx))
                    b.pos_y = round(parent.pos_y + (parent.pos_h or 64) + 20 if not is_cobot else parent.pos_y)
                else:
                    b.pos_x, b.pos_y = grid[0], grid[1]
                    grid[0] += w + 20
                    if grid[0] > 1200:
                        grid[0] = 40
                        grid[1] += h + 20
                placed += 1
            print(f"{'COBOT' if is_cobot else 'CONV '} {b.name:38s} → parent={parent.name if parent else '— (set manually)'}")

        await db.commit()
        print(f"\nblocks: {len(blocks)} | parent matched: {matched} | unmatched: {unmatched} | placed: {placed}")


if __name__ == "__main__":
    asyncio.run(main())
