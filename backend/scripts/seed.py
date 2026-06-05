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

from app.models.models import Usina, Equipamento, Usuario
from app.core.security import hash_password
from app.core.config import settings


async def main() -> None:
    engine = create_async_engine(settings.DATABASE_URL, echo=False)
    Session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with Session() as db:
        # ── Plant ─────────────────────────────────────────────────────────────
        r = await db.execute(select(Usina).where(Usina.codigo == "PLT1"))
        usina = r.scalar_one_or_none()
        if not usina:
            usina = Usina(codigo="PLT1", nome="Foliot Furniture - Plant 1")
            db.add(usina)
            await db.flush()
            print(f"[+] Plant created:  {usina.nome}  (id={usina.id})")
        else:
            print(f"[=] Plant exists:   {usina.nome}")

        # ── Equipment ─────────────────────────────────────────────────────────
        equipment_rows = [
            {"codigo": "EQ-001", "nome": "CNC Router Line 3",   "localizacao": "Production Line 3", "criticidade": "alta"},
            {"codigo": "EQ-002", "nome": "Edge Banding Machine", "localizacao": "Production Line 1", "criticidade": "media"},
            {"codigo": "EQ-003", "nome": "Hydraulic Press A",    "localizacao": "Press Room",         "criticidade": "critica"},
        ]
        for row in equipment_rows:
            r = await db.execute(select(Equipamento).where(Equipamento.codigo == row["codigo"]))
            if not r.scalar_one_or_none():
                db.add(Equipamento(usina_id=usina.id, **row))
                print(f"[+] Equipment created: {row['nome']}")
            else:
                print(f"[=] Equipment exists:  {row['nome']}")

        # ── Default admin user ────────────────────────────────────────────────
        r = await db.execute(select(Usuario).limit(1))
        if not r.scalar_one_or_none():
            admin = Usuario(
                nome="Admin",
                email="admin@foliot.com",
                senha_hash=hash_password("admin123"),
                idioma="en",
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
