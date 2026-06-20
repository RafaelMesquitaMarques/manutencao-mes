#!/usr/bin/env python3
"""One-time catch-up: ensure every existing production equipment has its kiosk/Machine.
Idempotent (reuses the same service the API uses), safe to re-run.

    docker exec --env PYTHONPATH=/app mes_backend python /app/scripts/backfill_machines.py
"""
import asyncio
from sqlalchemy import select
from app.db.session import AsyncSessionLocal
from app.models.models import Equipment
from app.services.equipment_machine_sync import ensure_machine_for_equipment


async def main():
    async with AsyncSessionLocal() as db:
        # Process ALL equipment so the invariant is fully established in both
        # directions: production+active → kiosk on; auxiliary/inactive → kiosk off.
        eqs = (await db.execute(select(Equipment))).scalars().all()
        for eq in eqs:
            await ensure_machine_for_equipment(db, eq)
        await db.commit()
        print(f"Synced kiosks across {len(eqs)} equipment rows.")


asyncio.run(main())
