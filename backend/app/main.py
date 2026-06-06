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
    tickets, maintenance_dashboard, machines, stop_categories, job_orders,
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
        # Phase: machine page v1
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
        # Phase: machine page v2 — MES panel
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS current_operator_id UUID REFERENCES users(id)",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS current_job_number VARCHAR(100)",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS last_stop_at TIMESTAMPTZ",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS last_start_at TIMESTAMPTZ",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS page_language VARCHAR(10) NOT NULL DEFAULT 'fr'",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS target_availability_pct FLOAT NOT NULL DEFAULT 70",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS target_count INT",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS show_production_panel BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS show_reject_panel BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS show_availability_gauge BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS show_job_number BOOLEAN NOT NULL DEFAULT TRUE",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS custom_color VARCHAR(20)",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS display_name VARCHAR(200)",
        # Phase: MES panel + per-machine categories
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS hourly_rate FLOAT",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS hourly_rate_currency VARCHAR(10) NOT NULL DEFAULT 'CAD'",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS target_count_per_shift INT",
        "ALTER TABLE stop_categories ADD COLUMN IF NOT EXISTS machine_id UUID REFERENCES machines(id) ON DELETE CASCADE",
        "ALTER TABLE stop_categories ADD COLUMN IF NOT EXISTS name_en VARCHAR(200)",
        "ALTER TABLE stop_categories ADD COLUMN IF NOT EXISTS name_fr VARCHAR(200)",
        "ALTER TABLE stop_categories ADD COLUMN IF NOT EXISTS name_es VARCHAR(200)",
        "ALTER TABLE stop_categories ADD COLUMN IF NOT EXISTS comment_required BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE stop_categories ADD COLUMN IF NOT EXISTS triggers_maintenance BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE stop_categories ADD COLUMN IF NOT EXISTS is_global BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE stop_subcategories ADD COLUMN IF NOT EXISTS name_en VARCHAR(200)",
        "ALTER TABLE stop_subcategories ADD COLUMN IF NOT EXISTS name_fr VARCHAR(200)",
        "ALTER TABLE stop_subcategories ADD COLUMN IF NOT EXISTS name_es VARCHAR(200)",
        "ALTER TABLE stop_subcategories ADD COLUMN IF NOT EXISTS comment_required BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE machine_stops ADD COLUMN IF NOT EXISTS operator_id UUID REFERENCES machine_operators(id) ON DELETE SET NULL",
        "ALTER TABLE machine_stops ADD COLUMN IF NOT EXISTS shift VARCHAR(20)",
        "ALTER TABLE machine_stops ADD COLUMN IF NOT EXISTS job_number VARCHAR(100)",
        # Phase: user permissions system
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) NOT NULL DEFAULT 'operator'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(200)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by_id UUID REFERENCES users(id) ON DELETE SET NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ",
        """
        CREATE TABLE IF NOT EXISTS permissions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            plant_id UUID REFERENCES plants(id) ON DELETE CASCADE,
            resource VARCHAR(100) NOT NULL,
            action VARCHAR(50) NOT NULL,
            granted BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS user_invitations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email VARCHAR(200) NOT NULL,
            role VARCHAR(50) NOT NULL DEFAULT 'operator',
            plant_id UUID REFERENCES plants(id) ON DELETE SET NULL,
            token VARCHAR(128) UNIQUE NOT NULL,
            invited_by_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            accepted_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token VARCHAR(128) UNIQUE NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS email_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email_type VARCHAR(50) NOT NULL,
            recipient_email VARCHAR(200) NOT NULL,
            subject VARCHAR(500),
            body TEXT,
            status VARCHAR(20) NOT NULL DEFAULT 'sent',
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        # New tables
        """
        CREATE TABLE IF NOT EXISTS reject_categories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            machine_id UUID REFERENCES machines(id) ON DELETE CASCADE,
            name VARCHAR(200) NOT NULL,
            name_en VARCHAR(200), name_fr VARCHAR(200), name_es VARCHAR(200),
            icon VARCHAR(100), color VARCHAR(20),
            comment_required BOOLEAN NOT NULL DEFAULT FALSE,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            is_global BOOLEAN NOT NULL DEFAULT FALSE,
            sort_order INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS reject_subcategories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            category_id UUID NOT NULL REFERENCES reject_categories(id) ON DELETE CASCADE,
            name VARCHAR(200) NOT NULL,
            name_en VARCHAR(200), name_fr VARCHAR(200), name_es VARCHAR(200),
            icon VARCHAR(100), color VARCHAR(20),
            comment_required BOOLEAN NOT NULL DEFAULT FALSE,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS reject_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            category_id UUID REFERENCES reject_categories(id) ON DELETE SET NULL,
            subcategory_id UUID REFERENCES reject_subcategories(id) ON DELETE SET NULL,
            quantity INT NOT NULL DEFAULT 1,
            operator_id UUID REFERENCES machine_operators(id) ON DELETE SET NULL,
            shift VARCHAR(20),
            job_number VARCHAR(100),
            comment TEXT,
            logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS job_orders (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            job_number VARCHAR(100) NOT NULL UNIQUE,
            machine_id UUID REFERENCES machines(id) ON DELETE SET NULL,
            description TEXT,
            target_quantity INT,
            status VARCHAR(30) NOT NULL DEFAULT 'pending',
            source VARCHAR(20) NOT NULL DEFAULT 'manual',
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
    ]
    async with engine.begin() as conn:
        for stmt in stmts:
            await conn.execute(text(stmt))
        # Mark pre-existing global stop categories
        await conn.execute(text(
            "UPDATE stop_categories SET is_global = TRUE WHERE machine_id IS NULL AND is_global = FALSE"
        ))
        await _seed_stop_categories(conn)


async def _seed_stop_categories(conn) -> None:
    """Insert default stop categories and subcategories if none exist."""
    result = await conn.execute(text("SELECT COUNT(*) FROM stop_categories"))
    if result.scalar() > 0:
        return
    await conn.execute(text("""
        INSERT INTO stop_categories (id, name, type, icon, color, is_active, sort_order) VALUES
        (gen_random_uuid(), 'Planned Stop',           'planned',     '🕐', '#3b82f6', true, 1),
        (gen_random_uuid(), 'Maintenance Requested',  'maintenance', '⚠️', '#f59e0b', true, 2),
        (gen_random_uuid(), 'Unplanned Stop',         'unplanned',   '❌', '#ef4444', true, 3)
    """))
    r = await conn.execute(text(
        "SELECT id, name FROM stop_categories WHERE name = 'Unplanned Stop'"
    ))
    row = r.fetchone()
    if row:
        uid = row[0]
        await conn.execute(text(f"""
            INSERT INTO stop_subcategories (id, category_id, name, icon, color, triggers_maintenance, is_active, sort_order) VALUES
            (gen_random_uuid(), '{uid}', 'No Operator',    '🚫', '#6b7280', false, true, 1),
            (gen_random_uuid(), '{uid}', 'Maintenance',    '🔧', '#f59e0b', true,  true, 2),
            (gen_random_uuid(), '{uid}', 'Quality Stop',   '✅', '#10b981', false, true, 3),
            (gen_random_uuid(), '{uid}', 'Materials Stop', '📦', '#8b5cf6', false, true, 4),
            (gen_random_uuid(), '{uid}', 'IT Stop',        '💻', '#06b6d4', false, true, 5)
        """))


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
app.include_router(stop_categories.router,        prefix="/api/stop-categories", tags=["Stop Categories"])
app.include_router(job_orders.router,             prefix="/api/job-orders",      tags=["Job Orders"])


@app.get("/api/health", tags=["System"])
async def health():
    return {"status": "ok", "version": "0.1.0"}
