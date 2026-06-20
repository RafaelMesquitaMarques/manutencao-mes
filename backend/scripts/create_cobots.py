"""One-off: align cobot equipment to the real cell layout.

- Fix mis-tagged cobots (subtype → 'Cobot') so they're recognised as cobots.
- Create the cobots that don't exist yet (entry/exit per machine; one combined per CX).
Idempotent: matches by name, skips what already exists. Run:
    docker exec mes_backend python -m scripts.create_cobots
"""
import asyncio
from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.models.models import Equipment

# Cobots to ensure exist (name → code). asset_type=auxiliary, subtype='Cobot'.
TO_CREATE = [
    ("Cobot Entrée TF-54", "COBOT-TF54-IN"),
    ("Cobot Sortie TF-54", "COBOT-TF54-OUT"),
    ("Cobot Entrée KAL", "COBOT-KAL-IN"),
    ("Cobot Sortie KAL", "COBOT-KAL-OUT"),
    ("Cobot CX-220#1", "COBOT-CX220-1"),    # combined entry+exit
    ("Cobot CX-220#2", "COBOT-CX220-2"),    # combined entry+exit
]
# Existing equipment whose subtype should be 'Cobot' but isn't.
FIX_SUBTYPE = ["Cobot entre Stefani"]


async def main():
    async with AsyncSessionLocal() as db:
        # plant of the existing cobots (Saint-Jérôme)
        plant_id = (await db.execute(
            select(Equipment.plant_id).where(Equipment.subtype == "Cobot").limit(1)
        )).scalar_one_or_none()
        if plant_id is None:
            print("Could not resolve plant from existing cobots."); return

        # 1) fix mis-tagged
        for nm in FIX_SUBTYPE:
            eq = (await db.execute(select(Equipment).where(Equipment.name == nm))).scalar_one_or_none()
            if eq and eq.subtype != "Cobot":
                eq.subtype = "Cobot"
                print(f"FIXED subtype → Cobot: {nm}")

        # 2) create missing
        for name, code in TO_CREATE:
            exists = (await db.execute(select(Equipment).where(Equipment.name == name))).scalar_one_or_none()
            if exists:
                print(f"skip (exists): {name}")
                continue
            db.add(Equipment(
                plant_id=plant_id, code=code, name=name,
                asset_type="auxiliary", subtype="Cobot", active=True,
            ))
            print(f"CREATED: {name} [{code}]")

        await db.commit()

        total = (await db.execute(
            select(Equipment).where(Equipment.subtype == "Cobot", Equipment.active == True)
        )).scalars().all()
        print(f"\nTotal active cobots now: {len(total)}")
        for e in sorted(total, key=lambda x: x.name):
            print("  -", e.name)


if __name__ == "__main__":
    asyncio.run(main())
