"""
Seed script — creates plant, equipment, machines, alerts, tickets, and default admin user.

Run inside the backend container:
    docker exec mes_backend python /app/scripts/seed.py
"""
import asyncio
import sys
sys.path.insert(0, '/app')

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import select, func
from datetime import datetime, timezone, timedelta

from app.models.models import (
    Plant, Equipment, User,
    Machine, MaintenanceAlert, MaintenanceTicket,
    AlertProblemType, AlertPriority, AlertShift, AlertStatus, TicketStatus,
)
from app.core.security import hash_password
from app.core.config import settings


async def main() -> None:
    engine  = create_async_engine(settings.DATABASE_URL, echo=False)
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
            {"code": "EQ-001", "name": "CNC Router Line 3",    "location": "Production Line 3", "criticality": "high"},
            {"code": "EQ-002", "name": "Edge Banding Machine",  "location": "Production Line 1", "criticality": "medium"},
            {"code": "EQ-003", "name": "Hydraulic Press A",     "location": "Press Room",         "criticality": "critical"},
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
        admin = r.scalar_one_or_none()
        if not admin:
            admin = User(
                name="Admin",
                email="admin@foliot.com",
                password_hash=hash_password("admin123"),
                language="en",
            )
            db.add(admin)
            await db.flush()
            print("[+] Admin user created:  admin@foliot.com  /  admin123")
        else:
            print("[=] Users already exist — skipping admin creation")

        await db.commit()

        # ── Machines ──────────────────────────────────────────────────────────
        r = await db.execute(select(func.count(Machine.id)))
        if r.scalar() == 0:
            machines_data = [
                {"name": "CNC Router #1",       "department": "Production",  "location": "Line 3"},
                {"name": "CNC Router #2",       "department": "Production",  "location": "Line 3"},
                {"name": "Edge Bander Pro 500", "department": "Finishing",   "location": "Line 1"},
                {"name": "Hydraulic Press A",   "department": "Press Room",  "location": "Press Room"},
                {"name": "Conveyor Belt L2",    "department": "Assembly",    "location": "Line 2"},
            ]
            machine_objs = []
            for md in machines_data:
                m = Machine(**md)
                db.add(m)
                machine_objs.append(m)
            await db.flush()
            for m in machine_objs:
                print(f"[+] Machine created: {m.name}")

            await db.commit()

            # Re-fetch to get IDs
            r = await db.execute(select(Machine).order_by(Machine.created_at))
            machine_objs = r.scalars().all()

            # ── Maintenance Alerts ─────────────────────────────────────────────
            now = datetime.now(timezone.utc)
            alerts_data = [
                {
                    "alert_number":  "ALT-2026-00001",
                    "machine_id":    machine_objs[0].id,
                    "department":    "Production",
                    "problem_type":  AlertProblemType.machine_stop,
                    "priority":      AlertPriority.critical,
                    "description":   "Machine stopped completely — no response on control panel",
                    "created_by":    "Jean-Paul Tremblay",
                    "shift":         AlertShift.morning,
                    "status":        AlertStatus.new_alert,
                    "created_at":    now - timedelta(minutes=15),
                },
                {
                    "alert_number":  "ALT-2026-00002",
                    "machine_id":    machine_objs[2].id,
                    "department":    "Finishing",
                    "problem_type":  AlertProblemType.mechanical,
                    "priority":      AlertPriority.high,
                    "description":   "Abnormal vibration on infeed roller — glue quality affected",
                    "created_by":    "Marie Bouchard",
                    "shift":         AlertShift.afternoon,
                    "status":        AlertStatus.assigned,
                    "assigned_to_id": admin.id,
                    "created_at":    now - timedelta(minutes=45),
                },
                {
                    "alert_number":  "ALT-2026-00003",
                    "machine_id":    machine_objs[4].id,
                    "department":    "Assembly",
                    "problem_type":  AlertProblemType.electrical,
                    "priority":      AlertPriority.medium,
                    "description":   "Intermittent fault on conveyor speed controller",
                    "created_by":    "Carlos Mendes",
                    "shift":         AlertShift.night,
                    "status":        AlertStatus.in_progress,
                    "created_at":    now - timedelta(hours=2),
                },
            ]
            alert_objs = []
            for ad in alerts_data:
                a = MaintenanceAlert(**ad)
                db.add(a)
                alert_objs.append(a)
            await db.flush()
            for a in alert_objs:
                print(f"[+] Alert created: {a.alert_number} ({a.priority})")

            await db.commit()

            # Re-fetch alert IDs
            r = await db.execute(select(MaintenanceAlert).order_by(MaintenanceAlert.created_at))
            alert_objs = r.scalars().all()

            # ── Maintenance Tickets ────────────────────────────────────────────
            tickets_data = [
                {
                    "ticket_number":              "TKT-2026-00001",
                    "alert_id":                   alert_objs[1].id,
                    "machine_id":                 machine_objs[2].id,
                    "priority":                   AlertPriority.high,
                    "status":                     TicketStatus.in_progress,
                    "assigned_to_id":             admin.id,
                    "started_at":                 now - timedelta(minutes=20),
                    "opened_at":                  now - timedelta(minutes=45),
                    "estimated_downtime_minutes": 60,
                },
                {
                    "ticket_number":              "TKT-2026-00002",
                    "machine_id":                 machine_objs[3].id,
                    "priority":                   AlertPriority.medium,
                    "status":                     TicketStatus.open,
                    "opened_at":                  now - timedelta(hours=3),
                    "estimated_downtime_minutes": 120,
                },
            ]
            for td in tickets_data:
                t = MaintenanceTicket(**td)
                db.add(t)
                print(f"[+] Ticket created: {td['ticket_number']} ({td['status']})")

            await db.commit()
        else:
            print("[=] Machines already seeded — skipping maintenance seed")

    await engine.dispose()
    print("\nSeed complete.")


if __name__ == "__main__":
    asyncio.run(main())
