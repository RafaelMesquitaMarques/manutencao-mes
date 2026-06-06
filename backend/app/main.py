import asyncio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from sqlalchemy import text

from app.core.config import settings
from app.db.session import engine, AsyncSessionLocal
from app.db.base import Base
from app.api.routes import (
    auth, plants, equipment, work_orders,
    maintenance_plans, inventory, alerts, iot, users, kpis, technicians,
    tickets, maintenance_dashboard, machines,
)


async def _escalation_loop() -> None:
    """Check overdue alerts and escalate every 60 seconds."""
    from app.services.escalation_service import EscalationService
    while True:
        await asyncio.sleep(60)
        try:
            async with AsyncSessionLocal() as db:
                await EscalationService(db).check_overdue_alerts()
        except Exception as exc:
            print(f"[EscalationService] {exc}")


async def _run_migrations() -> None:
    """Add new columns to existing tables (idempotent via IF NOT EXISTS)."""
    stmts = [
        # Phase: ticket-WO integration
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS ticket_id UUID",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual'",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS scheduled_date DATE",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS scheduled_start_time VARCHAR(10)",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS scheduled_end_time VARCHAR(10)",
        "ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS work_order_id UUID REFERENCES work_orders(id)",
        # Phase: machine page
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS code VARCHAR(50) UNIQUE",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS current_status VARCHAR(20) NOT NULL DEFAULT 'running'",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS current_operator VARCHAR(200)",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS current_shift VARCHAR(20)",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS last_maintenance_at TIMESTAMPTZ",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS page_slug VARCHAR(200) UNIQUE",
        "ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS machine_page_source BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS opened_by_technician_at TIMESTAMPTZ",
        "ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS closed_by_technician_at TIMESTAMPTZ",
        "ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS problem_type VARCHAR(50)",
        "ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS description TEXT",
    ]
    async with engine.begin() as conn:
        for stmt in stmts:
            await conn.execute(text(stmt))


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _run_migrations()
    task = asyncio.create_task(_escalation_loop())
    yield
    task.cancel()
    await engine.dispose()


app = FastAPI(
    title="MES Maintenance Platform",
    description="Multi-plant maintenance management and industrial monitoring platform",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,                   prefix="/api/auth",          tags=["Authentication"])
app.include_router(plants.router,                 prefix="/api/plants",        tags=["Plants"])
app.include_router(equipment.router,              prefix="/api/equipment",     tags=["Equipment"])
app.include_router(work_orders.router,            prefix="/api/wo",            tags=["Work Orders"])
app.include_router(maintenance_plans.router,      prefix="/api/plans",         tags=["Maintenance Plans"])
app.include_router(inventory.router,              prefix="/api/inventory",     tags=["Inventory"])
app.include_router(alerts.router,                 prefix="/api/alerts",        tags=["Maintenance Alerts"])
app.include_router(tickets.router,                prefix="/api/tickets",       tags=["Maintenance Tickets"])
app.include_router(maintenance_dashboard.router,  prefix="/api/maintenance",   tags=["Maintenance Dashboard"])
app.include_router(iot.router,                    prefix="/api/iot",           tags=["IoT / Sensors"])
app.include_router(users.router,                  prefix="/api/users",         tags=["Users"])
app.include_router(kpis.router,                   prefix="/api/kpis",          tags=["KPIs"])
app.include_router(technicians.router,            prefix="/api/technicians",   tags=["Technicians"])
app.include_router(machines.router,               prefix="/api/machines",      tags=["Machines"])


@app.get("/api/health", tags=["System"])
async def health():
    return {"status": "ok", "version": "0.1.0"}
