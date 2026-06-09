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
    suppliers as suppliers_module,
)
from app.api.routes.machine_operator import router as machine_operator_router


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


async def _backfill_ticket_alerts() -> None:
    """Create missing MaintenanceAlert records for tickets that have alert_id = NULL."""
    from app.services.ticket_service import backfill_missing_alerts
    try:
        async with AsyncSessionLocal() as db:
            count = await backfill_missing_alerts(db)
            if count:
                print(f"[Startup] Backfill: created {count} missing alert(s) for existing tickets")
    except Exception as exc:
        print(f"[Startup] Backfill failed: {exc}")


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
        # Phase: work order extra fields
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS estimated_hours FLOAT",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS notes TEXT",
        # Phase: MES panel + per-machine categories
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS hourly_rate FLOAT",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS hourly_rate_currency VARCHAR(10) NOT NULL DEFAULT 'CAD'",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS target_count_per_shift INT",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS shifts_config JSONB",
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
            reject_category_id UUID REFERENCES reject_categories(id) ON DELETE SET NULL,
            reject_subcategory_id UUID REFERENCES reject_subcategories(id) ON DELETE SET NULL,
            quantity INT NOT NULL DEFAULT 1,
            operator_id UUID REFERENCES machine_operators(id) ON DELETE SET NULL,
            date DATE NOT NULL DEFAULT CURRENT_DATE,
            shift VARCHAR(20),
            job_number VARCHAR(100),
            comments TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ
        )
        """,
        # Rename reject_logs columns if they exist with old names
        """DO $$ BEGIN ALTER TABLE reject_logs RENAME COLUMN category_id TO reject_category_id;
           EXCEPTION WHEN others THEN NULL; END $$""",
        """DO $$ BEGIN ALTER TABLE reject_logs RENAME COLUMN subcategory_id TO reject_subcategory_id;
           EXCEPTION WHEN others THEN NULL; END $$""",
        """DO $$ BEGIN ALTER TABLE reject_logs RENAME COLUMN comment TO comments;
           EXCEPTION WHEN others THEN NULL; END $$""",
        "ALTER TABLE reject_logs ADD COLUMN IF NOT EXISTS date DATE NOT NULL DEFAULT CURRENT_DATE",
        "ALTER TABLE reject_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
        "ALTER TABLE reject_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ",
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
        # Phase: ticket-WO redesign — new columns on existing tables
        "ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS suggested_technician_id UUID REFERENCES users(id)",
        "ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS machine_id UUID",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS total_minutes INTEGER",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS estimated_downtime_minutes INTEGER",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS actual_downtime_minutes INTEGER",
        # Phase: inventory module — suppliers table + stock_items new columns
        """
        CREATE TABLE IF NOT EXISTS suppliers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            code VARCHAR(50),
            name VARCHAR(300) NOT NULL,
            phone VARCHAR(100),
            email VARCHAR(200),
            fax VARCHAR(100),
            website VARCHAR(300),
            currency VARCHAR(10) DEFAULT 'CAD',
            notes TEXT,
            is_active BOOLEAN DEFAULT TRUE
        )
        """,
        "ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS category VARCHAR(200)",
        "ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS part_class VARCHAR(200)",
        "ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS warehouse VARCHAR(100)",
        "ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL",
        "ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS interal_product_id VARCHAR(50)",
        "ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS notes TEXT",
        # Phase: supplier management module
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_name VARCHAR(200)",
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address TEXT",
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS city VARCHAR(100)",
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS country VARCHAR(100)",
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS category VARCHAR(100)",
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(100)",
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_days INTEGER",
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS rating INTEGER",
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
        "ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ",
        "ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS supplier_code VARCHAR(100)",
        """
        CREATE TABLE IF NOT EXISTS purchase_orders (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_number VARCHAR(50) NOT NULL UNIQUE,
            supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
            status VARCHAR(20) NOT NULL DEFAULT 'draft',
            order_date DATE NOT NULL,
            expected_date DATE,
            received_date DATE,
            total_amount FLOAT,
            currency VARCHAR(10) DEFAULT 'CAD',
            notes TEXT,
            created_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS purchase_order_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
            stock_item_id UUID REFERENCES stock_items(id) ON DELETE SET NULL,
            description VARCHAR(500) NOT NULL,
            quantity FLOAT NOT NULL,
            unit_cost FLOAT NOT NULL,
            total_cost FLOAT NOT NULL,
            received_quantity FLOAT NOT NULL DEFAULT 0,
            notes VARCHAR(500),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        # Phase: inventory movements table
        """
        CREATE TABLE IF NOT EXISTS inventory_movements (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            stock_item_id UUID NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
            work_order_id UUID,
            movement_type VARCHAR(20) NOT NULL,
            quantity FLOAT NOT NULL,
            quantity_before FLOAT NOT NULL,
            quantity_after FLOAT NOT NULL,
            unit_cost FLOAT,
            notes VARCHAR(500),
            created_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        # Phase: machine history table
        """
        CREATE TABLE IF NOT EXISTS machine_history (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            work_order_id UUID,
            ticket_id UUID,
            event_type VARCHAR(30) NOT NULL,
            problem_type VARCHAR(50),
            description TEXT,
            diagnosis TEXT,
            corrective_action TEXT,
            parts_used JSONB DEFAULT '[]',
            technician_id UUID REFERENCES technicians(id) ON DELETE SET NULL,
            downtime_minutes INTEGER,
            total_minutes INTEGER,
            occurred_at TIMESTAMPTZ NOT NULL,
            completed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        # Phase: machine operator call flow
        """
        CREATE TABLE IF NOT EXISTS machine_interventions (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            plant_id        UUID REFERENCES plants(id) ON DELETE SET NULL,
            machine_id      UUID REFERENCES machines(id) ON DELETE SET NULL,
            equipment_id    UUID REFERENCES equipment(id) ON DELETE SET NULL,
            ticket_id       UUID REFERENCES maintenance_tickets(id) ON DELETE SET NULL,
            status          VARCHAR(30) NOT NULL DEFAULT 'waiting',
            called_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            started_at      TIMESTAMPTZ,
            completed_at    TIMESTAMPTZ,
            called_by_id    UUID REFERENCES users(id) ON DELETE SET NULL,
            started_by_id   UUID REFERENCES users(id) ON DELETE SET NULL,
            completed_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
            operator_note   TEXT,
            mechanic_note   TEXT
        )
        """,
        # Phase: alert ↔ ticket direct link
        "ALTER TABLE maintenance_alerts ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES maintenance_tickets(id) ON DELETE SET NULL",
        "ALTER TABLE maintenance_alerts ALTER COLUMN escalation_level SET DEFAULT 0",
        "ALTER TABLE maintenance_alerts ALTER COLUMN is_overdue SET DEFAULT FALSE",
        # Phase: labor record time tracking
        "ALTER TABLE labor_records ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ",
        "ALTER TABLE labor_records ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ",
        # Phase: cost audit log table
        """
        CREATE TABLE IF NOT EXISTS cost_audit_log (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            work_order_id UUID,
            changed_by_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            field_changed VARCHAR(100) NOT NULL,
            old_value VARCHAR(500),
            new_value VARCHAR(500),
            reason TEXT,
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
        await _seed_suppliers(conn)


async def _seed_suppliers(conn) -> None:
    result = await conn.execute(text("SELECT COUNT(*) FROM suppliers WHERE code LIKE 'SUP-%'"))
    if result.scalar() > 0:
        return
    await conn.execute(text("""
        INSERT INTO suppliers (id, code, name, contact_name, email, phone, category, currency, payment_terms, lead_time_days, rating, is_active)
        VALUES
        (gen_random_uuid(), 'SUP-001', 'MSC Industrial Supply',  'Jean Tremblay',   'jtremblay@msci.com',      '514-555-0101', 'Parts', 'CAD', 'Net 30', 5, 4, TRUE),
        (gen_random_uuid(), 'SUP-002', 'Grainger Canada',        'Marie Dupont',    'mdupont@grainger.ca',     '450-555-0202', 'Tools', 'CAD', 'Net 30', 3, 5, TRUE),
        (gen_random_uuid(), 'SUP-003', 'Fastenal Canada',        'Robert Martin',   'rmartin@fastenal.ca',     '514-555-0303', 'Parts', 'CAD', 'Net 60', 7, 3, TRUE)
        ON CONFLICT DO NOTHING
    """))


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
    await _backfill_ticket_alerts()
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
app.include_router(suppliers_module.supplier_router, prefix="/api/suppliers",       tags=["Suppliers"])
app.include_router(suppliers_module.po_router,       prefix="/api/supplier-orders", tags=["Purchase Orders"])
app.include_router(machine_operator_router)


@app.get("/api/health", tags=["System"])
async def health():
    return {"status": "ok", "version": "0.1.0"}
