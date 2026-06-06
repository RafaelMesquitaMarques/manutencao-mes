"""
Seed script — creates plant, equipment, and default admin user.

Run inside the backend container:
    docker exec mes_backend python /app/scripts/seed.py
"""
import asyncio
import sys
sys.path.insert(0, '/app')

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select

from app.models.models import Plant, Equipment, User
from app.core.security import hash_password
from app.core.config import settings


async def main() -> None:
    engine = create_async_engine(settings.DATABASE_URL, echo=False)
    Session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with Session() as db:
        # ── Plant ─────────────────────────────────────────────────────────────
        r = await db.execute(select(Plant).where(Plant.code == "PLT1"))
        plant = r.scalar_one_or_none()
        if not plant:
            plant = Plant(code="PLT1", name="Foliot Furniture - Plant 1")
            db.add(plant)
            await db.flush()
            print(f"[+] Plant created:  {plant.name}  (id={plant.id})")
        else:
            print(f"[=] Plant exists:   {plant.name}")

        # ── Equipment ─────────────────────────────────────────────────────────
        equipment_rows = [
            {"code": "EQ-001", "name": "CNC Router Line 3",   "location": "Production Line 3", "criticality": "high"},
            {"code": "EQ-002", "name": "Edge Banding Machine", "location": "Production Line 1", "criticality": "medium"},
            {"code": "EQ-003", "name": "Hydraulic Press A",    "location": "Press Room",         "criticality": "critical"},
        ]
        for row in equipment_rows:
            r = await db.execute(select(Equipment).where(Equipment.code == row["code"]))
            if not r.scalar_one_or_none():
                db.add(Equipment(plant_id=plant.id, **row))
                print(f"[+] Equipment created: {row['name']}")
            else:
                print(f"[=] Equipment exists:  {row['name']}")

        # ── Default admin user ────────────────────────────────────────────────
        r = await db.execute(select(User).limit(1))
        if not r.scalar_one_or_none():
            admin = User(
                name="Admin",
                email="admin@foliot.com",
                password_hash=hash_password("admin123"),
                language="en",
            )
            db.add(admin)
            print("[+] Admin user created:  admin@foliot.com  /  admin123")
        else:
            print("[=] Users already exist — skipping admin creation")

        await db.commit()

    await engine.dispose()
    print("\nSeed complete.")


if __name__ == "__main__":
    asyncio.run(main())
