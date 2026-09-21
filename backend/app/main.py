import asyncio
import logging
import os
import re
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from sqlalchemy import text

from app.core.config import settings
from app.db.session import engine, AsyncSessionLocal
from app.db.base import Base
from app.api.routes import (
    auth, plants, equipment, work_orders,
    maintenance_plans, inventory, alerts, iot, users, kpis, technicians,
    tickets, maintenance_dashboard, machines, stop_categories, job_orders,
    suppliers as suppliers_module, reports, escalation, factory_map, costs, costs_control,
    departments as departments_module,
    factory_calendar, adam_devices, cortex_stations, shift_templates,
    temperature_sensors, pit_stop, sushi, sushi_devices, home_insights,
    of_watch, predictive, factory_replay,
)
from app.api.routes.machine_operator import router as machine_operator_router
from app.api.routes.cortex_ingest import (
    ingest_router as cortex_ingest_router,
    admin_router as cortex_ingest_admin_router,
)
from app.api.routes.sops import (
    router as sops_router,
    execution_router as sop_execution_router,
    kiosk_router as sop_kiosk_router,
)
from app.api.routes.intervention_type_settings import router as intervention_types_router
from app.api.routes.safety_checklist_settings import router as safety_checklist_router
from app.api.routes.cleaning_checklist_settings import router as cleaning_checklist_router
from app.api.routes.wo_approval import router as wo_approval_router
from app.api.routes.pm_template_settings import router as pm_template_settings_router
from app.api.routes.intelligence import router as intelligence_router
from app.api.routes.uploads import router as uploads_router
from app.api.routes.robot_cells import router as robot_cells_router
from app.api.routes.dashboards import router as dashboards_router
from app.api.routes.live import router as live_router
from app.core.permissions import resource_guard, role_write_guard
from app.core.kiosk_guard import kiosk_ref_guard
from app.core.plant_scope import path_plant_guard
from app.models.models import Equipment, MachineIntervention, MaintenancePlan, PlanOccurrence, PmTemplate, UserRole, WorkOrder
from app.services import event_bus

logger = logging.getLogger(__name__)


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


async def _of_watch_loop() -> None:
    """Fire inactivity alerts for watched OFs (map "spots") every 60 seconds.
    One alert per stall episode — see of_watch_service.check_inactivity."""
    from app.services import of_watch_service
    while True:
        await asyncio.sleep(60)
        try:
            async with AsyncSessionLocal() as db:
                await of_watch_service.check_inactivity(db)
        except Exception as exc:
            print(f"[OFWatch] {exc}")


async def _pm_loop() -> None:
    """Check overdue PM occurrences and send reminders/alerts every hour."""
    from app.services import pm_service
    while True:
        await asyncio.sleep(3600)
        try:
            async with AsyncSessionLocal() as db:
                await pm_service.check_overdue_occurrences(db)
                await pm_service.check_upcoming_reminders(db)
        except Exception as exc:
            print(f"[PMService] {exc}")


async def _shift_report_loop() -> None:
    """End-of-shift summary SMS (template-based, no AI). Checks every 60s for
    shift windows that just ended; no-op until enabled in Settings → Escalation."""
    from app.services import shift_report_service
    while True:
        await asyncio.sleep(60)
        try:
            async with AsyncSessionLocal() as db:
                await shift_report_service.check_and_send(db)
        except Exception as exc:
            print(f"[ShiftReport] {exc}")


async def _weather_loop() -> None:
    """Refresh each active plant's cached outdoor weather from Open-Meteo every
    15 min (feeds the factory-map overview badge). Plants without coordinates are
    skipped; one plant failing never stops the others."""
    from sqlalchemy import select
    from app.models.models import Plant
    from app.services.weather_service import fetch_open_meteo
    while True:
        try:
            async with AsyncSessionLocal() as db:
                plants = (await db.execute(
                    select(Plant).where(
                        Plant.active == True,  # noqa: E712
                        Plant.latitude.isnot(None), Plant.longitude.isnot(None))
                )).scalars().all()
                for p in plants:
                    try:
                        w = await fetch_open_meteo(p.latitude, p.longitude)
                        if w.get("temp_c") is not None:
                            p.weather_temp_c = w["temp_c"]
                            p.weather_code = w.get("code")
                            p.weather_updated_at = datetime.now(timezone.utc)
                    except Exception as exc:  # noqa: BLE001 — skip this plant, keep the rest
                        print(f"[Weather] {p.code}: {exc}")
                await db.commit()
        except Exception as exc:
            print(f"[Weather] {exc}")
        await asyncio.sleep(900)


def _simulated_temp_c(sensor) -> float:
    """Baseline ± amplitude on a slow ~10-min sine plus a little jitter — a
    believable indoor curve until real hardware replaces the simulated source."""
    import math, random, time
    base = sensor.sim_baseline_c if sensor.sim_baseline_c is not None else 21.0
    amp = sensor.sim_amplitude_c if sensor.sim_amplitude_c is not None else 2.0
    phase = (time.time() / 600.0) * 2 * math.pi
    return round(base + amp * math.sin(phase) + random.uniform(-0.3, 0.3), 1)


async def _temperature_loop() -> None:
    """Write a fresh reading for every enabled temperature sensor every 30s.
    Today all sensors use the `simulated` source; the real Modbus/HTTP paths slot
    in behind the same rows later (switch on `sensor.source`)."""
    from sqlalchemy import select
    from app.models.models import TemperatureSensor, TemperatureSource, AdamDeviceStatus
    while True:
        try:
            async with AsyncSessionLocal() as db:
                sensors = (await db.execute(
                    select(TemperatureSensor).where(TemperatureSensor.enabled == True)  # noqa: E712
                )).scalars().all()
                now = datetime.now(timezone.utc)
                for s in sensors:
                    if s.source == TemperatureSource.simulated:
                        s.last_value_c = _simulated_temp_c(s)
                        s.last_reading_at = now
                        s.status = AdamDeviceStatus.online
                        s.last_error = None
                    # adam_analog / http: real hardware paths handled elsewhere (future)
                await db.commit()
        except Exception as exc:
            print(f"[TempSim] {exc}")
        await asyncio.sleep(30)


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
    """Bring an existing database up to the current schema.

    Entries are either a ("table", "column", "TYPE SQL") tuple — an ADD COLUMN,
    gated against information_schema so it is only ISSUED when actually missing
    (see the comment after the list: IF NOT EXISTS does not avoid the lock) — or
    a raw SQL string for everything that is not a plain ADD COLUMN: CREATE
    TABLE/INDEX, ALTER ... TYPE, DROP CONSTRAINT, DO blocks, GRANTs, backfills.
    Order is significant and preserved; all of it is idempotent and re-runs on
    every boot.
    """
    stmts = [
        # Phase: predictive intelligence — failure-mode labeling provenance
        ('failure_events', 'label_source', 'VARCHAR(20)'),
        ('failure_events', 'label_confidence', 'FLOAT'),
        # Phase: ticket-WO integration
        ('work_orders', 'ticket_id', 'UUID'),
        ('work_orders', 'source', "VARCHAR(20) NOT NULL DEFAULT 'manual'"),
        ('work_orders', 'scheduled_date', 'DATE'),
        ('work_orders', 'scheduled_start_time', 'VARCHAR(10)'),
        ('work_orders', 'scheduled_end_time', 'VARCHAR(10)'),
        ('maintenance_tickets', 'work_order_id', 'UUID REFERENCES work_orders(id)'),
        # Phase: machine page v1
        ('machines', 'code', 'VARCHAR(50) UNIQUE'),
        ('machines', 'current_status', "VARCHAR(20) NOT NULL DEFAULT 'running'"),
        ('machines', 'current_operator', 'VARCHAR(200)'),
        ('machines', 'current_shift', 'VARCHAR(20)'),
        ('machines', 'last_maintenance_at', 'TIMESTAMPTZ'),
        ('machines', 'page_slug', 'VARCHAR(200) UNIQUE'),
        ('maintenance_tickets', 'machine_page_source', 'BOOLEAN NOT NULL DEFAULT FALSE'),
        ('maintenance_tickets', 'opened_by_technician_at', 'TIMESTAMPTZ'),
        ('maintenance_tickets', 'closed_by_technician_at', 'TIMESTAMPTZ'),
        ('maintenance_tickets', 'problem_type', 'VARCHAR(50)'),
        ('maintenance_tickets', 'description', 'TEXT'),
        # Phase: machine page v2 — MES panel
        ('machines', 'current_operator_id', 'UUID REFERENCES users(id)'),
        ('machines', 'current_job_number', 'VARCHAR(100)'),
        ('machines', 'kiosk_layout', 'JSON'),
        ('machines', 'work_pauses', 'JSON'),
        ('line_tv_settings', 'global_cadence_per_hour', 'INTEGER'),
        ('line_tv_settings', 'global_work_start', 'VARCHAR(10)'),
        ('line_tv_settings', 'global_work_end', 'VARCHAR(10)'),
        ('line_tv_settings', 'global_pauses', 'JSON'),
        ('machines', 'last_stop_at', 'TIMESTAMPTZ'),
        ('machines', 'last_start_at', 'TIMESTAMPTZ'),
        ('machines', 'page_language', "VARCHAR(10) NOT NULL DEFAULT 'fr'"),
        ('machines', 'target_availability_pct', 'FLOAT NOT NULL DEFAULT 70'),
        ('machines', 'target_count', 'INT'),
        ('machines', 'show_production_panel', 'BOOLEAN NOT NULL DEFAULT TRUE'),
        ('machines', 'show_reject_panel', 'BOOLEAN NOT NULL DEFAULT TRUE'),
        ('machines', 'show_availability_gauge', 'BOOLEAN NOT NULL DEFAULT TRUE'),
        ('machines', 'show_job_number', 'BOOLEAN NOT NULL DEFAULT TRUE'),
        ('machines', 'custom_color', 'VARCHAR(20)'),
        ('machines', 'display_name', 'VARCHAR(200)'),
        # Phase: work order extra fields
        ('work_orders', 'estimated_hours', 'FLOAT'),
        ('work_orders', 'notes', 'TEXT'),
        # Phase: MES panel + per-machine categories
        ('machines', 'hourly_rate', 'FLOAT'),
        ('machines', 'hourly_rate_currency', "VARCHAR(10) NOT NULL DEFAULT 'CAD'"),
        ('machines', 'target_count_per_shift', 'INT'),
        ('machines', 'target_count_per_hour', 'INT'),
        ('machines', 'shifts_config', 'JSONB'),
        ('machines', 'shift_schedule', 'JSONB'),
        ('stop_categories', 'machine_id', 'UUID REFERENCES machines(id) ON DELETE CASCADE'),
        ('stop_categories', 'name_en', 'VARCHAR(200)'),
        ('stop_categories', 'name_fr', 'VARCHAR(200)'),
        ('stop_categories', 'name_es', 'VARCHAR(200)'),
        ('stop_categories', 'comment_required', 'BOOLEAN NOT NULL DEFAULT FALSE'),
        ('stop_categories', 'triggers_maintenance', 'BOOLEAN NOT NULL DEFAULT FALSE'),
        ('stop_categories', 'is_global', 'BOOLEAN NOT NULL DEFAULT FALSE'),
        ('stop_subcategories', 'name_en', 'VARCHAR(200)'),
        ('stop_subcategories', 'name_fr', 'VARCHAR(200)'),
        ('stop_subcategories', 'name_es', 'VARCHAR(200)'),
        ('stop_subcategories', 'comment_required', 'BOOLEAN NOT NULL DEFAULT FALSE'),
        ('machine_stops', 'operator_id', 'UUID REFERENCES machine_operators(id) ON DELETE SET NULL'),
        ('machine_stops', 'shift', 'VARCHAR(20)'),
        ('machine_stops', 'job_number', 'VARCHAR(100)'),
        # Scale machine_stops range scans (downtime by machine over time) without
        # hypertabling it (kept plain: small, and fetched by id via db.get).
        "CREATE INDEX IF NOT EXISTS idx_machine_stops_machine_started ON machine_stops (machine_id, started_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_machine_stops_started ON machine_stops (started_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_machine_stops_category ON machine_stops (stop_category_id)",
        # Phase: user permissions system
        ('users', 'role', "VARCHAR(50) NOT NULL DEFAULT 'operator'"),
        ('users', 'avatar_url', 'VARCHAR(500)'),
        ('users', 'phone', 'VARCHAR(50)'),
        ('users', 'job_title', 'VARCHAR(200)'),
        ('users', 'last_login_at', 'TIMESTAMPTZ'),
        ('users', 'must_change_password', 'BOOLEAN NOT NULL DEFAULT FALSE'),
        ('users', 'invited_by_id', 'UUID REFERENCES users(id) ON DELETE SET NULL'),
        ('users', 'invited_at', 'TIMESTAMPTZ'),
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
        ('reject_logs', 'date', 'DATE NOT NULL DEFAULT CURRENT_DATE'),
        ('reject_logs', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()'),
        ('reject_logs', 'updated_at', 'TIMESTAMPTZ'),
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
        ('maintenance_tickets', 'suggested_technician_id', 'UUID REFERENCES users(id)'),
        ('maintenance_tickets', 'reported_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()'),
        ('work_orders', 'machine_id', 'UUID'),
        ('work_orders', 'total_minutes', 'INTEGER'),
        ('work_orders', 'estimated_downtime_minutes', 'INTEGER'),
        ('work_orders', 'actual_downtime_minutes', 'INTEGER'),
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
        ('stock_items', 'category', 'VARCHAR(200)'),
        ('stock_items', 'part_class', 'VARCHAR(200)'),
        ('stock_items', 'warehouse', 'VARCHAR(100)'),
        ('stock_items', 'supplier_id', 'UUID REFERENCES suppliers(id) ON DELETE SET NULL'),
        ('stock_items', 'interal_product_id', 'VARCHAR(50)'),
        ('stock_items', 'notes', 'TEXT'),
        # Phase: supplier management module
        ('suppliers', 'contact_name', 'VARCHAR(200)'),
        ('suppliers', 'address', 'TEXT'),
        ('suppliers', 'city', 'VARCHAR(100)'),
        ('suppliers', 'country', 'VARCHAR(100)'),
        ('suppliers', 'category', 'VARCHAR(100)'),
        ('suppliers', 'payment_terms', 'VARCHAR(100)'),
        ('suppliers', 'lead_time_days', 'INTEGER'),
        ('suppliers', 'rating', 'INTEGER'),
        ('suppliers', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()'),
        ('suppliers', 'updated_at', 'TIMESTAMPTZ'),
        ('stock_items', 'supplier_code', 'VARCHAR(100)'),
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
        # Phase: intervention types per machine
        """
        CREATE TABLE IF NOT EXISTS intervention_types (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            plant_id     UUID REFERENCES plants(id) ON DELETE CASCADE,
            equipment_id UUID REFERENCES equipment(id) ON DELETE CASCADE,
            name         VARCHAR(200) NOT NULL,
            icon         VARCHAR(100),
            color        VARCHAR(20) DEFAULT '#388bfd',
            sort_order   INTEGER DEFAULT 0,
            is_active    BOOLEAN DEFAULT TRUE
        )
        """,
        ('machine_interventions', 'intervention_type_id', 'UUID REFERENCES intervention_types(id) ON DELETE SET NULL'),
        ('machine_interventions', 'intervention_type_name', 'VARCHAR(200)'),
        # Phase: intervention timing metrics
        ('machine_interventions', 'response_time_minutes', 'FLOAT'),
        ('machine_interventions', 'intervention_duration_minutes', 'FLOAT'),
        ('machine_interventions', 'total_downtime_minutes', 'FLOAT'),
        ('machine_interventions', 'called_by_name', 'VARCHAR(200)'),
        ('machine_interventions', 'started_by_name', 'VARCHAR(200)'),
        ('machine_interventions', 'completed_by_name', 'VARCHAR(200)'),
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
        # Phase: technician check-in on interventions (multi-tech + map pictograms)
        """
        CREATE TABLE IF NOT EXISTS intervention_technicians (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            intervention_id UUID NOT NULL REFERENCES machine_interventions(id) ON DELETE CASCADE,
            technician_id   UUID REFERENCES technicians(id) ON DELETE SET NULL,
            name            VARCHAR(200) NOT NULL,
            checked_in_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            checked_out_at  TIMESTAMPTZ
        )
        """,
        # Phase: safety checklist + intervention parts
        """
        CREATE TABLE IF NOT EXISTS safety_checklists (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            plant_id     UUID REFERENCES plants(id) ON DELETE SET NULL,
            equipment_id UUID REFERENCES equipment(id) ON DELETE SET NULL,
            name         VARCHAR(200) NOT NULL DEFAULT 'Safety checklist',
            is_active    BOOLEAN NOT NULL DEFAULT TRUE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS safety_checklist_items (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            checklist_id UUID REFERENCES safety_checklists(id) ON DELETE CASCADE,
            text         TEXT NOT NULL,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            is_required  BOOLEAN NOT NULL DEFAULT TRUE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS intervention_checklist_responses (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            intervention_id   UUID REFERENCES machine_interventions(id) ON DELETE CASCADE,
            checklist_item_id UUID REFERENCES safety_checklist_items(id) ON DELETE SET NULL,
            item_text         TEXT NOT NULL,
            checked           BOOLEAN NOT NULL DEFAULT FALSE,
            checked_at        TIMESTAMPTZ,
            checked_by_id     UUID REFERENCES users(id) ON DELETE SET NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS intervention_parts (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            intervention_id  UUID REFERENCES machine_interventions(id) ON DELETE CASCADE,
            stock_item_id    UUID REFERENCES stock_items(id) ON DELETE SET NULL,
            item_code        VARCHAR(100),
            item_description TEXT,
            quantity_used    FLOAT NOT NULL DEFAULT 1.0,
            unit             VARCHAR(50),
            added_by_id      UUID REFERENCES users(id) ON DELETE SET NULL,
            added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            approval_status  VARCHAR(20) NOT NULL DEFAULT 'pending',
            approved_by_id   UUID REFERENCES users(id) ON DELETE SET NULL,
            approved_at      TIMESTAMPTZ,
            rejection_reason TEXT
        )
        """,
        # Phase: alert ↔ ticket direct link
        ('maintenance_alerts', 'ticket_id', 'UUID REFERENCES maintenance_tickets(id) ON DELETE SET NULL'),
        "ALTER TABLE maintenance_alerts ALTER COLUMN escalation_level SET DEFAULT 0",
        "ALTER TABLE maintenance_alerts ALTER COLUMN is_overdue SET DEFAULT FALSE",
        # Phase: labor record time tracking
        ('labor_records', 'started_at', 'TIMESTAMPTZ'),
        ('labor_records', 'stopped_at', 'TIMESTAMPTZ'),
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
        # Phase: TPM preventive maintenance module
        """
        CREATE TABLE IF NOT EXISTS pm_templates (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            plant_id        UUID REFERENCES plants(id),
            equipment_id    UUID NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
            frequency_type  VARCHAR(30) NOT NULL,
            name            VARCHAR(200) NOT NULL,
            description     TEXT,
            estimated_hours DOUBLE PRECISION DEFAULT 1.0,
            is_active       BOOLEAN DEFAULT TRUE,
            sort_order      INTEGER DEFAULT 0
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS pm_template_tasks (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            template_id UUID NOT NULL REFERENCES pm_templates(id) ON DELETE CASCADE,
            description TEXT NOT NULL,
            sort_order  INTEGER DEFAULT 0,
            is_required BOOLEAN DEFAULT TRUE
        )
        """,
        ('maintenance_plans', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('maintenance_plans', 'pm_template_id', 'UUID REFERENCES pm_templates(id) ON DELETE SET NULL'),
        ('maintenance_plans', 'plan_type', "VARCHAR(30) DEFAULT 'preventive'"),
        ('maintenance_plans', 'frequency_type', 'VARCHAR(30)'),
        ('maintenance_plans', 'frequency_value', 'INTEGER DEFAULT 1'),
        ('maintenance_plans', 'frequency_days', 'INTEGER'),
        ('maintenance_plans', 'frequency_hours', 'DOUBLE PRECISION'),
        ('maintenance_plans', 'weekdays', 'VARCHAR(20)'),
        ('maintenance_plans', 'start_date', 'DATE'),
        ('maintenance_plans', 'recurrence_end_type', "VARCHAR(20) DEFAULT 'never'"),
        ('maintenance_plans', 'recurrence_end_value', 'INTEGER'),
        ('maintenance_plans', 'recurrence_end_date', 'DATE'),
        ('maintenance_plans', 'lead_time_days', 'INTEGER DEFAULT 3'),
        ('maintenance_plans', 'assigned_technician_id', 'UUID REFERENCES technicians(id) ON DELETE SET NULL'),
        ('maintenance_plans', 'priority', "VARCHAR(20) DEFAULT 'medium'"),
        ('maintenance_plans', 'estimated_hours', 'DOUBLE PRECISION DEFAULT 1.0'),
        ('maintenance_plans', 'is_active', 'BOOLEAN DEFAULT TRUE'),
        ('maintenance_plans', 'next_due_date', 'DATE'),
        ('maintenance_plans', 'next_due_hours', 'DOUBLE PRECISION'),
        ('maintenance_plans', 'total_occurrences', 'INTEGER DEFAULT 0'),
        ('maintenance_plans', 'created_by_id', 'UUID REFERENCES users(id) ON DELETE SET NULL'),
        """
        CREATE TABLE IF NOT EXISTS plan_occurrences (
            id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            plan_id            UUID NOT NULL REFERENCES maintenance_plans(id) ON DELETE CASCADE,
            plant_id           UUID REFERENCES plants(id) ON DELETE SET NULL,
            equipment_id       UUID REFERENCES equipment(id) ON DELETE SET NULL,
            work_order_id      UUID REFERENCES work_orders(id) ON DELETE SET NULL,
            scheduled_date     DATE NOT NULL,
            actual_date        DATE,
            is_overridden      BOOLEAN DEFAULT FALSE,
            override_date      DATE,
            override_note      TEXT,
            is_cancelled       BOOLEAN DEFAULT FALSE,
            cancel_reason      TEXT,
            status             VARCHAR(20) DEFAULT 'scheduled',
            compliance         VARCHAR(20),
            days_late          INTEGER,
            reminder_sent      BOOLEAN DEFAULT FALSE,
            overdue_alert_sent BOOLEAN DEFAULT FALSE,
            created_at         TIMESTAMPTZ DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS plan_recommended_parts (
            id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            plan_id              UUID NOT NULL REFERENCES maintenance_plans(id) ON DELETE CASCADE,
            stock_item_id        UUID REFERENCES stock_items(id) ON DELETE SET NULL,
            item_code            VARCHAR(100),
            item_description     TEXT,
            quantity_recommended DOUBLE PRECISION DEFAULT 1,
            unit                 VARCHAR(50)
        )
        """,
        ('work_orders', 'plan_id', 'UUID REFERENCES maintenance_plans(id)'),
        ('work_orders', 'occurrence_id', 'UUID REFERENCES plan_occurrences(id) ON DELETE SET NULL'),
        ('wo_actions', 'description', 'TEXT'),
        ('wo_actions', 'is_required', 'BOOLEAN DEFAULT TRUE'),
        ('wo_actions', 'is_completed', 'BOOLEAN DEFAULT FALSE'),
        ('wo_actions', 'completed_at', 'TIMESTAMPTZ'),
        ('wo_actions', 'completed_by_id', 'UUID REFERENCES users(id) ON DELETE SET NULL'),
        ('wo_actions', 'sort_order', 'INTEGER DEFAULT 0'),
        # Phase: multi-technician work orders — backfill join table from executor_id
        """
        INSERT INTO work_order_technicians (work_order_id, technician_id, is_primary)
        SELECT wo.id, wo.executor_id, TRUE
        FROM work_orders wo
        JOIN technicians t ON t.id = wo.executor_id
        WHERE wo.executor_id IS NOT NULL
        ON CONFLICT DO NOTHING
        """,
        # Heal tickets whose assignment drifted from their linked WO
        """
        UPDATE maintenance_tickets mt
        SET assigned_to_id = wo.assigned_to_id
        FROM work_orders wo
        WHERE (wo.ticket_id = mt.id OR mt.work_order_id = wo.id)
          AND wo.assigned_to_id IS NOT NULL
          AND mt.assigned_to_id IS DISTINCT FROM wo.assigned_to_id
        """,
        # Phase: per-machine reports — explicit Machine -> Equipment link
        ('machines', 'equipment_id', 'UUID REFERENCES equipment(id) ON DELETE SET NULL'),
        # Backfill: machines auto-provisioned from equipment share the same UUID
        "UPDATE machines SET equipment_id = id WHERE equipment_id IS NULL AND id IN (SELECT id FROM equipment)",
        # Backfill: match remaining machines to equipment by code
        """
        UPDATE machines m
        SET equipment_id = e.id
        FROM equipment e
        WHERE m.equipment_id IS NULL
          AND m.code IS NOT NULL
          AND m.code = e.code
        """,
        # Phase: ticket lifecycle SMS notifications
        ('escalation_settings', 'notify_on_ticket_opened', 'BOOLEAN DEFAULT TRUE'),
        ('escalation_settings', 'notify_on_ticket_completed', 'BOOLEAN DEFAULT TRUE'),
        # Phase: supervisor-controlled technician self-assignment
        ('escalation_settings', 'technician_self_assign', 'BOOLEAN DEFAULT TRUE'),
        # End-of-shift summary (SMS to level-1 contacts) — off until enabled in Settings → Escalation
        ('escalation_settings', 'shift_report_enabled', 'BOOLEAN DEFAULT FALSE'),
        # Phase: work-order-driven maintenance stop (office/mobile flow feeds Availability/OEE)
        ('machine_stops', 'source', "VARCHAR(20) DEFAULT 'operator'"),
        # Phase: per-machine production-signal ingest token (ADAM-6050)
        ('machines', 'signal_ingest_token', 'VARCHAR(120)'),
        # Phase 4 multi-plant: per-machine kiosk access token (KIOSK_ENFORCE_TOKEN)
        ('machines', 'kiosk_token', 'VARCHAR(120)'),
        # Phase: PM template SOP — expected result per step (media live in pm_task_media, created by create_all)
        ('pm_template_tasks', 'expected_result', 'TEXT'),
        # Phase: checklist rigor on the work order (advisory | required | strict)
        ('pm_templates', 'enforcement', "VARCHAR(20) DEFAULT 'advisory'"),
        ('work_orders', 'checklist_enforcement', "VARCHAR(20) DEFAULT 'advisory'"),
        ('work_orders', 'board_order', 'INTEGER'),
        # Phase: auxiliary (non-productive) equipment — maintenance-only assets
        ('equipment', 'asset_type', "VARCHAR(20) DEFAULT 'production'"),
        ('equipment', 'subtype', 'VARCHAR(100)'),
        # Phase: equipment classification fields (promoted from the maintenance Excel import)
        ('equipment', 'department', 'VARCHAR(200)'),
        ('equipment', 'cost_center', 'VARCHAR(200)'),
        ('equipment', 'family', 'VARCHAR(200)'),
        ('equipment', 'pm_strategy', 'VARCHAR(300)'),
        ('equipment', 'cleaning_priority', 'VARCHAR(50)'),
        ('equipment', 'function_label', 'VARCHAR(300)'),
        # One-time backfill from the import's specifications JSON (guarded by IS NULL)
        """
        UPDATE equipment SET
            department = COALESCE(department, NULLIF(specifications->>'division', '')),
            family = COALESCE(family, NULLIF(specifications->>'famille', '')),
            pm_strategy = COALESCE(pm_strategy, NULLIF(specifications->>'pm_strategy', '')),
            cleaning_priority = COALESCE(cleaning_priority, NULLIF(specifications->>'cleaning_priority', ''))
        WHERE specifications IS NOT NULL
          AND (department IS NULL OR family IS NULL OR pm_strategy IS NULL OR cleaning_priority IS NULL)
        """,
        ('wo_actions', 'expected_result', 'TEXT'),
        ('wo_actions', 'template_task_id', 'UUID'),
        ('wo_actions', 'proof_photo_url', 'VARCHAR(1000)'),
        # Phase: parts pricing — snapshot stock price on intervention parts
        ('intervention_parts', 'unit_cost', 'DOUBLE PRECISION'),
        ('intervention_parts', 'total_cost', 'DOUBLE PRECISION'),
        """
        UPDATE intervention_parts ip
        SET unit_cost = s.unit_cost,
            total_cost = s.unit_cost * COALESCE(ip.quantity_used, 1)
        FROM stock_items s
        WHERE ip.stock_item_id = s.id
          AND ip.unit_cost IS NULL
          AND s.unit_cost IS NOT NULL
        """,
        # Phase: average cost + last purchase cost on stock items
        ('stock_items', 'average_cost', 'DOUBLE PRECISION'),
        ('stock_items', 'last_purchase_cost', 'DOUBLE PRECISION'),
        ('stock_items', 'last_purchase_date', 'DATE'),
        # Phase: serial number on machines + equipment
        ('machines', 'serial_number', 'VARCHAR(200)'),
        # ── Factory map / digital-twin layout ──
        ('machines', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('machines', 'pos_x', 'DOUBLE PRECISION'),
        ('machines', 'pos_y', 'DOUBLE PRECISION'),
        ('machines', 'pos_w', 'DOUBLE PRECISION'),
        ('machines', 'pos_h', 'DOUBLE PRECISION'),
        ('machines', 'rotation_deg', 'DOUBLE PRECISION'),
        ('machines', 'icon_url', 'VARCHAR(500)'),
        ('plants', 'floor_plan_url', 'VARCHAR(500)'),
        # backfill the machine→plant link from its equipment (one-time, guarded)
        "UPDATE machines SET plant_id = e.plant_id FROM equipment e WHERE machines.equipment_id = e.id AND machines.plant_id IS NULL",
        # equipment carries the map position (the factory map is asset-based, not machine-based)
        ('equipment', 'pos_x', 'DOUBLE PRECISION'),
        ('equipment', 'pos_y', 'DOUBLE PRECISION'),
        ('equipment', 'pos_w', 'DOUBLE PRECISION'),
        ('equipment', 'pos_h', 'DOUBLE PRECISION'),
        ('equipment', 'rotation_deg', 'DOUBLE PRECISION'),
        ('equipment', 'icon_url', 'VARCHAR(500)'),
        ('equipment', 'model_url', 'VARCHAR(500)'),
        ('equipment', 'height_3d', 'DOUBLE PRECISION'),
        ('equipment', 'model_scale', 'DOUBLE PRECISION'),
        ('equipment', 'scale_y', 'DOUBLE PRECISION'),
        ('equipment', 'scale_z', 'DOUBLE PRECISION'),
        ('equipment', 'block_kind', 'VARCHAR(40)'),
        ('equipment', 'parent_equipment_id', 'UUID REFERENCES equipment(id)'),
        ('equipment', 'orbit_x', 'DOUBLE PRECISION'),
        ('equipment', 'orbit_y', 'DOUBLE PRECISION'),
        ('equipment', 'orbit_w', 'DOUBLE PRECISION'),
        ('equipment', 'orbit_h', 'DOUBLE PRECISION'),
        ('equipment', 'serial_number', 'VARCHAR(200)'),
        # Map props can optionally link to a real equipment (live status / click-through)
        ('map_props', 'equipment_id', 'UUID REFERENCES equipment(id)'),
        # ── Why an entry raised the count: a purchase receipt is money paid for
        # these units, a reversal is units coming back from a part line that did
        # not keep them. movement_type cannot tell them apart (both were
        # 'addition'), yet the purchase-price backfills below must only ever see
        # receipts. Guarded on information_schema so a steady-state boot takes NO
        # exclusive lock: ALTER TABLE grabs AccessExclusive before it even reads
        # the catalog, so IF NOT EXISTS alone would still block the workers.
        """
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema='public' AND table_name='inventory_movements'
                           AND column_name='source') THEN
            ALTER TABLE inventory_movements ADD COLUMN source VARCHAR(20);
          END IF;
        END $$
        """,
        # Classify the history, which predates the column. Receiving a purchase
        # order is the only code path that has ever written an entry directly,
        # and it has stamped this exact note since the module landed (8e541c8);
        # every other entry came from InventoryService, whose callers are all
        # reversals of a consumption line. So the note settles it both ways, and
        # rows with no note fall to the safe side (not a purchase).
        """
        UPDATE inventory_movements
        SET source = 'purchase'
        WHERE source IS NULL AND movement_type = 'addition'
          AND notes LIKE 'Purchase Order %'
        """,
        # Reversals also take the movement_type they would be written with today,
        # so one query finds them all regardless of when they happened. Only the
        # label changes: quantity, direction and history stay exactly as booked.
        """
        UPDATE inventory_movements
        SET source = 'reversal', movement_type = 'return'
        WHERE source IS NULL AND movement_type = 'addition'
        """,
        # One-time backfill of the purchase prices, from RECEIPTS only (see above).
        # Guarded by IS NULL so it only fills items not yet computed.
        """
        UPDATE stock_items s
        SET average_cost = sub.avg_cost
        FROM (
            SELECT stock_item_id,
                   SUM(unit_cost * quantity) / NULLIF(SUM(quantity), 0) AS avg_cost
            FROM inventory_movements
            WHERE source = 'purchase' AND unit_cost IS NOT NULL AND quantity > 0
            GROUP BY stock_item_id
        ) sub
        WHERE s.id = sub.stock_item_id AND s.average_cost IS NULL
        """,
        """
        UPDATE stock_items s
        SET last_purchase_cost = lm.unit_cost,
            last_purchase_date = lm.created_at::date
        FROM (
            SELECT DISTINCT ON (stock_item_id) stock_item_id, unit_cost, created_at
            FROM inventory_movements
            WHERE source = 'purchase' AND unit_cost IS NOT NULL
            ORDER BY stock_item_id, created_at DESC
        ) lm
        WHERE s.id = lm.stock_item_id AND s.last_purchase_cost IS NULL
        """,
        # Phase: escalation flexibility — per-contact scope (department/machines)
        # and quiet hours, + minimum priority for the level-0 ticket group
        ('escalation_contacts', 'scope_department', 'VARCHAR(200)'),
        ('escalation_contacts', 'scope_machine_ids', 'JSON'),
        ('escalation_contacts', 'notify_start', 'VARCHAR(5)'),
        ('escalation_contacts', 'notify_end', 'VARCHAR(5)'),
        ('escalation_contacts', 'critical_bypass', 'BOOLEAN DEFAULT TRUE'),
        ('escalation_settings', 'ticket_group_min_priority', "VARCHAR(20) DEFAULT 'low'"),
        # Phase: escalation lifecycle — same-level reminders + planned-stop pause
        # (the "I'm on it" ack feature was built then removed — DROPs clean it up)
        ('maintenance_alerts', 'last_notified_at', 'TIMESTAMPTZ'),
        ('escalation_settings', 'reminder_minutes', 'INTEGER DEFAULT 0'),
        ('escalation_settings', 'pause_during_planned_stop', 'BOOLEAN DEFAULT TRUE'),
        "ALTER TABLE maintenance_alerts DROP COLUMN IF EXISTS ack_token",
        "ALTER TABLE maintenance_alerts DROP COLUMN IF EXISTS acknowledged_at",
        "ALTER TABLE maintenance_alerts DROP COLUMN IF EXISTS acknowledged_by",
        "ALTER TABLE escalation_settings DROP COLUMN IF EXISTS ack_enabled",
        # Phase: editable SMS templates + per-trigger channel matrix
        ('escalation_settings', 'sms_templates', 'JSON'),
        ('escalation_settings', 'channel_matrix', 'JSON'),
        # Phase: Microsoft Teams channel notifications (Workflows webhook per plant)
        ('escalation_settings', 'teams_enabled', 'BOOLEAN DEFAULT FALSE'),
        ('escalation_settings', 'teams_webhook_url', 'TEXT'),
        # Phase: OF alerts split from machine alerts — own Teams channel (empty =
        # shared) + own recipients group (escalation_contacts.category = 'of')
        ('escalation_settings', 'of_teams_webhook_url', 'TEXT'),
        ('escalation_contacts', 'category', 'VARCHAR(20)'),
        # Phase: WO-level approval — supervisor/director approves completed work
        # (whole intervention OR whole formal work order), not just individual parts.
        # A marker table makes the historical "grandfather" backfill run exactly once,
        # so a genuinely-pending completed item is never auto-approved on the next boot.
        """
        CREATE TABLE IF NOT EXISTS _kaizo_migrations (
            key VARCHAR(100) PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        # Floor work order = MachineIntervention
        ('machine_interventions', 'approval_status', "VARCHAR(20) NOT NULL DEFAULT 'pending'"),
        ('machine_interventions', 'approved_by_id', 'UUID REFERENCES users(id) ON DELETE SET NULL'),
        ('machine_interventions', 'approved_at', 'TIMESTAMPTZ'),
        ('machine_interventions', 'approval_note', 'TEXT'),
        ('machine_interventions', 'rejection_reason', 'TEXT'),
        # Office work order = work_orders
        ('work_orders', 'approval_status', "VARCHAR(20) NOT NULL DEFAULT 'pending'"),
        ('work_orders', 'approved_by_id', 'UUID REFERENCES users(id) ON DELETE SET NULL'),
        ('work_orders', 'approved_at', 'TIMESTAMPTZ'),
        ('work_orders', 'approval_note', 'TEXT'),
        ('work_orders', 'rejection_reason', 'TEXT'),
        # One-time grandfather: everything already completed at rollout (incl. thousands of
        # imported historical WOs) is marked approved so the queue isn't flooded; only future
        # completions require sign-off. Interventions still holding pending parts stay queued.
        """
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM _kaizo_migrations WHERE key = 'grandfather_approval_2026_06_21') THEN
            UPDATE machine_interventions mi
              SET approval_status = 'approved', approved_at = COALESCE(mi.approved_at, mi.completed_at)
              WHERE mi.approval_status = 'pending' AND mi.status = 'completed'
                AND NOT EXISTS (
                    SELECT 1 FROM intervention_parts ip
                    WHERE ip.intervention_id = mi.id AND ip.approval_status = 'pending'
                );
            UPDATE work_orders
              SET approval_status = 'approved', approved_at = COALESCE(approved_at, completed_at)
              WHERE approval_status = 'pending' AND status = 'completed';
            INSERT INTO _kaizo_migrations(key) VALUES ('grandfather_approval_2026_06_21');
          END IF;
        END $$
        """,
        # Costs page: budgets split into OPEX / CAPEX envelopes
        ('cost_center_budgets', 'kind', "VARCHAR(10) NOT NULL DEFAULT 'opex'"),
        """DO $$ BEGIN
           ALTER TABLE cost_center_budgets DROP CONSTRAINT IF EXISTS uq_cc_budget_year_month_cc;
           ALTER TABLE cost_center_budgets ADD CONSTRAINT uq_cc_budget_year_month_cc_kind
             UNIQUE (year, month, cost_center, kind);
           EXCEPTION WHEN others THEN NULL; END $$""",
        # Cost center on approval + purchase-order commitments (forecast)
        ('machine_interventions', 'cost_center', 'VARCHAR(200)'),
        ('purchase_orders', 'cost_center', 'VARCHAR(200)'),
        ('purchase_orders', 'scope', "VARCHAR(10) NOT NULL DEFAULT 'opex'"),
        # Phase: effective labor time (shift templates, breaks, technician
        # unavailability). effective_hours drives labor_cost; hours_worked stays
        # raw so repair_hours / MTTR / downtime are never affected.
        ('labor_records', 'effective_hours', 'FLOAT'),
        ('labor_records', 'overtime_approved', 'BOOLEAN NOT NULL DEFAULT FALSE'),
        ('labor_records', 'deducted_minutes', 'FLOAT'),
        """
        CREATE TABLE IF NOT EXISTS shift_templates (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            plant_id UUID REFERENCES plants(id) ON DELETE CASCADE,
            key VARCHAR(50) NOT NULL,
            name VARCHAR(200) NOT NULL DEFAULT '',
            start_time VARCHAR(5) NOT NULL,
            end_time VARCHAR(5) NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS shift_breaks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            shift_template_id UUID NOT NULL REFERENCES shift_templates(id) ON DELETE CASCADE,
            kind VARCHAR(20) NOT NULL DEFAULT 'break',
            name VARCHAR(200) NOT NULL DEFAULT '',
            start_time VARCHAR(5) NOT NULL,
            end_time VARCHAR(5) NOT NULL,
            paid BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS technician_unavailability (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            technician_id UUID NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
            type VARCHAR(20) NOT NULL DEFAULT 'vacation',
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            notes TEXT,
            created_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_shift_templates_key ON shift_templates (key)",
        "CREATE INDEX IF NOT EXISTS idx_shift_breaks_template ON shift_breaks (shift_template_id)",
        "CREATE INDEX IF NOT EXISTS idx_tech_unavail_tech ON technician_unavailability (technician_id, start_date, end_date)",
        # Phase: multi-plant (phase 0) — user_plants becomes the authoritative
        # plant-access table (role per plant). See docs/multi-plant-architecture-assessment.md.
        ('user_plants', 'is_default', 'BOOLEAN NOT NULL DEFAULT FALSE'),
        ('user_plants', 'granted_by_id', 'UUID REFERENCES users(id) ON DELETE SET NULL'),
        ('user_plants', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()'),
        # De-dup defensively before the unique index (table is tiny; keeps the oldest id).
        """
        DELETE FROM user_plants a USING user_plants b
        WHERE a.user_id = b.user_id AND a.plant_id = b.plant_id AND a.id > b.id
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_user_plants_user_plant ON user_plants (user_id, plant_id)",
        "CREATE INDEX IF NOT EXISTS idx_user_plants_user ON user_plants (user_id)",
        # One-time, behavior-preserving membership backfill: every existing user gets a
        # membership in every ACTIVE plant with their current global role — this matches
        # today's reality (no plant enforcement existed, everyone effectively saw both
        # plants). Users who already had exactly one membership keep that plant as their
        # default; everyone else defaults to the oldest plant (Saint-Jérôme). Runs once
        # (marker row), so plants created later — e.g. Las Vegas — are NEVER auto-granted.
        """
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM _kaizo_migrations WHERE key = 'plant_membership_backfill_2026_07_10') THEN
            UPDATE user_plants up SET is_default = TRUE
            WHERE NOT EXISTS (SELECT 1 FROM user_plants x WHERE x.user_id = up.user_id AND x.id <> up.id)
              AND NOT EXISTS (SELECT 1 FROM user_plants d WHERE d.user_id = up.user_id AND d.is_default);
            INSERT INTO user_plants (id, user_id, plant_id, role, is_default)
            SELECT gen_random_uuid(), u.id, p.id, u.role, FALSE
            FROM users u CROSS JOIN plants p
            WHERE p.active = TRUE
              AND NOT EXISTS (SELECT 1 FROM user_plants up WHERE up.user_id = u.id AND up.plant_id = p.id);
            UPDATE user_plants up SET is_default = TRUE
            WHERE up.plant_id = (SELECT id FROM plants WHERE active = TRUE ORDER BY created_at, code LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM user_plants d WHERE d.user_id = up.user_id AND d.is_default);
            INSERT INTO _kaizo_migrations (key) VALUES ('plant_membership_backfill_2026_07_10');
          END IF;
        END $$
        """,
        # Phase: multi-plant (phase 1) — plant ownership columns on transactional
        # tables. All nullable (NOT NULL comes after validation, phase 3+). The
        # backfills are IS NULL-guarded and run every boot, so rows written by
        # pre-phase-2 code self-heal from their machine/equipment on restart.
        # Hypertables (sensor_readings, machine_production_hourly) deliberately get
        # NO plant column: compressed chunks can't be updated; they derive their
        # plant via sensor/equipment/machine joins. Technicians also get none —
        # their plant scope IS user_plants (SJ+MIRA share the maintenance team).
        ('work_orders', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('sensors', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('alerts', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('robot_cells', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('machine_stops', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('machine_operators', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('machine_production_logs', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('maintenance_alerts', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('maintenance_tickets', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('reject_logs', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('job_orders', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('machine_history', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('adam_devices', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('suppliers', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('purchase_orders', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('maintenance_budgets', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('cost_center_budgets', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('cost_centers', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('sap_cost_lines', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('escalation_settings', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('escalation_contacts', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('factory_calendar_settings', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('factory_holidays', 'plant_id', 'UUID REFERENCES plants(id)'),
        ('shift_reports', 'plant_id', 'UUID REFERENCES plants(id)'),
        # ── Phase: temperature sensors + outdoor weather badge (factory map)
        ('users', 'temp_unit', "VARCHAR(1) DEFAULT 'C'"),
        # ── Phase: preferred greeting name, set in User Management (NULL → first name)
        ('users', 'nickname', 'VARCHAR(100)'),
        ('plants', 'latitude', 'DOUBLE PRECISION'),
        ('plants', 'longitude', 'DOUBLE PRECISION'),
        ('plants', 'weather_temp_c', 'DOUBLE PRECISION'),
        ('plants', 'weather_code', 'INTEGER'),
        ('plants', 'weather_updated_at', 'TIMESTAMPTZ'),
        # Seed coordinates for the known plants (only where unset, so admin edits in
        # Settings → Plants are never clobbered). Open-Meteo reads these for the badge.
        "UPDATE plants SET latitude = 45.7805, longitude = -74.0037 WHERE code IN ('PLT1','QS') AND latitude IS NULL",
        "UPDATE plants SET latitude = 45.6501, longitude = -74.0848 WHERE code IN ('MIRA','QM') AND latitude IS NULL",
        "UPDATE plants SET latitude = 36.1699, longitude = -115.1398 WHERE code = 'NL' AND latitude IS NULL",
        ('temperature_sensors', 'department', 'VARCHAR(200)'),
        # ── Backfill: machine-derived (documented rule: row's plant = its machine's plant)
        "UPDATE maintenance_alerts t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE maintenance_tickets t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE machine_stops t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE machine_operators t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE machine_production_logs t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE reject_logs t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE job_orders t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE machine_history t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE adam_devices t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE cortex_stations t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE machine_interventions t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        # Dashboards carry no direct FK — derive the plant from the first machine
        # their tiles bind to. Text-compare (never cast the tile value to uuid) so a
        # malformed tile can never abort startup; an empty/machineless board stays NULL.
        "UPDATE dashboards d SET plant_id = m.plant_id FROM machines m WHERE d.plant_id IS NULL AND d.tiles IS NOT NULL AND m.plant_id IS NOT NULL AND m.id::text = (SELECT t->>'machine_id' FROM jsonb_array_elements(d.tiles::jsonb) t WHERE (t->>'machine_id') IS NOT NULL LIMIT 1)",
        # ── Backfill: equipment-derived (row's plant = its equipment's plant)
        "UPDATE work_orders t SET plant_id = e.plant_id FROM equipment e WHERE t.equipment_id = e.id AND t.plant_id IS NULL",
        "UPDATE work_orders t SET plant_id = m.plant_id FROM machines m WHERE t.machine_id = m.id AND t.plant_id IS NULL AND m.plant_id IS NOT NULL",
        "UPDATE sensors t SET plant_id = e.plant_id FROM equipment e WHERE t.equipment_id = e.id AND t.plant_id IS NULL",
        "UPDATE alerts t SET plant_id = e.plant_id FROM equipment e WHERE t.equipment_id = e.id AND t.plant_id IS NULL",
        "UPDATE robot_cells t SET plant_id = e.plant_id FROM equipment e WHERE t.equipment_id = e.id AND t.plant_id IS NULL",
        "UPDATE maintenance_plans t SET plant_id = e.plant_id FROM equipment e WHERE t.equipment_id = e.id AND t.plant_id IS NULL",
        "UPDATE pm_templates t SET plant_id = e.plant_id FROM equipment e WHERE t.equipment_id = e.id AND t.plant_id IS NULL",
        "UPDATE plan_occurrences t SET plant_id = e.plant_id FROM equipment e WHERE t.equipment_id = e.id AND t.plant_id IS NULL",
        "UPDATE plan_occurrences t SET plant_id = p.plant_id FROM maintenance_plans p WHERE t.plan_id = p.id AND t.plant_id IS NULL AND p.plant_id IS NOT NULL",
        "UPDATE intervention_types t SET plant_id = e.plant_id FROM equipment e WHERE t.equipment_id = e.id AND t.plant_id IS NULL",
        "UPDATE safety_checklists t SET plant_id = e.plant_id FROM equipment e WHERE t.equipment_id = e.id AND t.plant_id IS NULL",
        # ── One-time: cost site rule. Encodes the EXISTING runtime rule from
        # costs.py::_site_of() ("mirabel" in the cost-center name → Mirabel, else
        # Saint-Jérôme) into data — the very rule the Costs page already applies.
        # One-time by marker so rows created later are never guessed at boot
        # (they show up in the ambiguity report instead).
        """
        DO $$
        DECLARE
          mira UUID := (SELECT id FROM plants WHERE code IN ('MIRA', 'QM') LIMIT 1);
          sj   UUID := (SELECT id FROM plants WHERE code IN ('PLT1', 'QS') LIMIT 1);
        BEGIN
          IF sj IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _kaizo_migrations WHERE key = 'plant_cost_site_rule_2026_07_10') THEN
            UPDATE cost_centers SET plant_id = CASE WHEN lower(name) LIKE '%mirabel%' THEN COALESCE(mira, sj) ELSE sj END WHERE plant_id IS NULL;
            UPDATE cost_center_budgets SET plant_id = CASE WHEN lower(cost_center) LIKE '%mirabel%' THEN COALESCE(mira, sj) ELSE sj END WHERE plant_id IS NULL;
            UPDATE sap_cost_lines SET plant_id = CASE WHEN lower(cost_center) LIKE '%mirabel%' THEN COALESCE(mira, sj) ELSE sj END WHERE plant_id IS NULL;
            UPDATE purchase_orders SET plant_id = CASE WHEN lower(cost_center) LIKE '%mirabel%' THEN COALESCE(mira, sj) ELSE sj END WHERE plant_id IS NULL AND cost_center IS NOT NULL;
            INSERT INTO _kaizo_migrations (key) VALUES ('plant_cost_site_rule_2026_07_10');
          END IF;
        END $$
        """,
        # ── One-time: open-decision answers (user, 2026-07-10). (1) The orphan
        # machines are Saint-Jérôme's (the 4 active confirmed by name; the inactive
        # leftovers are old SJ demos/duplicates kept under SJ until cleanup).
        # (2) The existing supplier base belongs to the Quebec operation → owned by
        # PLT1, shared with Mirabel via the plant group below. (3) SJ+Mirabel form
        # group 'QC': group-scoped resources (inventory, suppliers) pool across it.
        ('plants', 'group_code', 'VARCHAR(20)'),
        """
        DO $$
        DECLARE sj UUID := (SELECT id FROM plants WHERE code IN ('PLT1', 'QS') LIMIT 1);
        BEGIN
          IF sj IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _kaizo_migrations WHERE key = 'plant_decisions_2026_07_10') THEN
            UPDATE machines SET plant_id = sj WHERE plant_id IS NULL;
            UPDATE suppliers SET plant_id = sj WHERE plant_id IS NULL;
            UPDATE plants SET group_code = 'QC' WHERE code IN ('PLT1', 'MIRA', 'QS', 'QM');
            INSERT INTO _kaizo_migrations (key) VALUES ('plant_decisions_2026_07_10');
          END IF;
        END $$
        """,
        # ── One-time: official site codes (user, 2026-07-10) — QS = Saint-Jérôme,
        # QM = Mirabel (Las Vegas will be NL). Everything joins by plant_id (UUID),
        # so renaming the display/lookup code is safe; the earlier one-time blocks
        # above accept both spellings for fresh installs.
        """
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM _kaizo_migrations WHERE key = 'plant_codes_qs_qm_2026_07_10') THEN
            UPDATE plants SET code = 'QS' WHERE code = 'PLT1';
            UPDATE plants SET code = 'QM' WHERE code = 'MIRA';
            INSERT INTO _kaizo_migrations (key) VALUES ('plant_codes_qs_qm_2026_07_10');
          END IF;
        END $$
        """,
        # ── Phase 3: per-plant uniqueness. The legacy single-calendar/single-budget
        # constraints block a second plant from having its own rows; move them to
        # (plant_id, …) with NULLS NOT DISTINCT so the legacy shared rows (NULL)
        # stay unique among themselves too.
        """DO $$ BEGIN
           ALTER TABLE factory_holidays DROP CONSTRAINT IF EXISTS factory_holidays_date_key;
           EXCEPTION WHEN others THEN NULL; END $$""",
        "DROP INDEX IF EXISTS ix_factory_holidays_date",
        "CREATE INDEX IF NOT EXISTS idx_factory_holidays_date ON factory_holidays (date)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_holidays_plant_date ON factory_holidays (plant_id, date) NULLS NOT DISTINCT",
        """DO $$ BEGIN
           ALTER TABLE maintenance_budgets DROP CONSTRAINT IF EXISTS uq_maintenance_budget_year_month;
           EXCEPTION WHEN others THEN NULL; END $$""",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_budget_plant_ym ON maintenance_budgets (plant_id, year, month) NULLS NOT DISTINCT",
        "CREATE INDEX IF NOT EXISTS idx_shift_reports_plant ON shift_reports (plant_id)",
        "CREATE INDEX IF NOT EXISTS idx_escalation_contacts_plant ON escalation_contacts (plant_id)",
        # ── Phase 5: row-level security as defense-in-depth. Policies are
        # FAIL-OPEN when the app.plant_ids GUC is unset — normal app sessions,
        # crons, workers and migrations never set it, so nothing changes for
        # them (the app-layer PlantContext remains the primary enforcement).
        # The GUC is set ONLY inside Ask Ninja's READ ONLY SQL transaction for
        # non-corporate users, which fences the one arbitrary-SQL path in the
        # platform to the caller's plants. FORCE is required because the app
        # connects as the table owner (owners bypass plain RLS). NULL-plant
        # rows (shared/legacy config) stay visible by design.
        # ALTER TABLE takes an ACCESS EXCLUSIVE lock even when it changes
        # nothing, and this whole stmts list runs as ONE transaction that holds
        # every lock until the final commit — re-running the ALTERs unguarded
        # deadlocked startup against the always-on workers (cortex_poller had
        # cortex_stations and wanted machines; this transaction held machines
        # and wanted cortex_stations). Guard on pg_class so steady-state boots
        # take no exclusive locks at all.
        """
        DO $$
        DECLARE
          t text;
          expr text := $e$ current_setting('app.plant_ids', true) IS NULL
            OR current_setting('app.plant_ids', true) = ''
            OR plant_id IS NULL
            OR plant_id::text = ANY (string_to_array(current_setting('app.plant_ids', true), ',')) $e$;
        BEGIN
          FOREACH t IN ARRAY ARRAY[
            'equipment','machines','work_orders','maintenance_alerts','maintenance_tickets',
            'machine_stops','machine_interventions','machine_operators','machine_production_logs',
            'reject_logs','job_orders','machine_history','sensors','alerts','robot_cells',
            'suppliers','purchase_orders','stock_items','maintenance_plans','pm_templates',
            'plan_occurrences','intervention_types','safety_checklists','factory_zones','map_props',
            'cost_centers','cost_center_budgets','maintenance_budgets','sap_cost_lines',
            'escalation_settings','escalation_contacts','factory_calendar_settings',
            'factory_holidays','shift_reports','adam_devices','cortex_stations','shift_templates',
            'line_tv_settings','dashboards','ai_insights','temperature_sensors',
            'sap_cost_links','cost_forecast_adjustments','cost_alert_rules','cost_actions'
          ] LOOP
            IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name = t) THEN
              IF NOT EXISTS (
                SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = t
                  AND c.relrowsecurity AND c.relforcerowsecurity
              ) THEN
                EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
                EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
              END IF;
              IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename = t AND policyname = 'plant_isolation') THEN
                EXECUTE format('CREATE POLICY plant_isolation ON %I FOR ALL USING (%s) WITH CHECK (%s)', t, expr, expr);
              END IF;
            END IF;
          END LOOP;
        END $$
        """,
        # ── Phase 6: Las Vegas onboarding. Plant currency column; the NL plant is
        # created ISOLATED (no group → own inventory/suppliers/numbering series
        # NL-WO-…), on America/Los_Angeles and USD, with its OWN escalation and
        # calendar rows so it never follows the shared QC configuration. No user
        # is granted access here — NL memberships are always assigned explicitly
        # in Settings → Users.
        ('plants', 'currency', "VARCHAR(3) NOT NULL DEFAULT 'CAD'"),
        """
        DO $$
        DECLARE nl UUID;
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM _kaizo_migrations WHERE key = 'nl_onboarding_2026_07_10') THEN
            IF NOT EXISTS (SELECT 1 FROM plants WHERE code = 'NL') THEN
              INSERT INTO plants (id, code, name, timezone, currency, group_code, active)
              VALUES (gen_random_uuid(), 'NL', 'Foliot Furniture (Las Vegas)', 'America/Los_Angeles', 'USD', NULL, TRUE);
            END IF;
            SELECT id INTO nl FROM plants WHERE code = 'NL';
            -- Own escalation config: platform defaults, but SMS/email OFF until
            -- NL contacts exist (no notification can ever route to QC people).
            IF NOT EXISTS (SELECT 1 FROM escalation_settings WHERE plant_id = nl) THEN
              INSERT INTO escalation_settings (id, plant_id, sms_enabled, email_enabled, shift_report_enabled)
              VALUES (gen_random_uuid(), nl, FALSE, FALSE, FALSE);
            END IF;
            -- Own calendar (independent of Quebec holidays; NV dates added in Settings → Calendar).
            IF NOT EXISTS (SELECT 1 FROM factory_calendar_settings WHERE plant_id = nl) THEN
              INSERT INTO factory_calendar_settings (id, plant_id, count_weekends)
              VALUES (gen_random_uuid(), nl, FALSE);
            END IF;
            INSERT INTO _kaizo_migrations (key) VALUES ('nl_onboarding_2026_07_10');
          END IF;
        END $$
        """,
        # ── Phase 5b: the app connects as the bootstrap SUPERUSER (mesadmin), and
        # superusers bypass RLS entirely — so Ask Ninja's SQL runs under this
        # dedicated non-superuser, read-only role instead (SET LOCAL ROLE inside
        # its transaction), where the plant_isolation policies DO apply. The role
        # can only SELECT, and never sees the credential tables at all.
        """
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaizo_ninja') THEN
            CREATE ROLE kaizo_ninja NOLOGIN;
          END IF;
        END $$
        """,
        "GRANT USAGE ON SCHEMA public TO kaizo_ninja",
        "GRANT SELECT ON ALL TABLES IN SCHEMA public TO kaizo_ninja",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO kaizo_ninja",
        "REVOKE ALL ON password_reset_tokens FROM kaizo_ninja",
        "REVOKE ALL ON user_invitations FROM kaizo_ninja",
        # Group-scoped tables (shared QC warehouse/supplier base) match the UI's
        # group visibility: their policy reads the wider app.plant_ids_grouped GUC.
        # DROP/CREATE POLICY also take ACCESS EXCLUSIVE locks — only swap the
        # policy when it doesn't reference the grouped GUC yet (same deadlock
        # risk as the RLS block above).
        """
        DO $$
        DECLARE
          t text;
          gexpr text := $e$ current_setting('app.plant_ids_grouped', true) IS NULL
            OR current_setting('app.plant_ids_grouped', true) = ''
            OR plant_id IS NULL
            OR plant_id::text = ANY (string_to_array(current_setting('app.plant_ids_grouped', true), ',')) $e$;
        BEGIN
          FOREACH t IN ARRAY ARRAY['stock_items', 'suppliers'] LOOP
            IF NOT EXISTS (
              SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                AND policyname = 'plant_isolation' AND qual LIKE '%plant_ids_grouped%'
            ) THEN
              EXECUTE format('DROP POLICY IF EXISTS plant_isolation ON %I', t);
              EXECUTE format('CREATE POLICY plant_isolation ON %I FOR ALL USING (%s) WITH CHECK (%s)', t, gexpr, gexpr);
            END IF;
          END LOOP;
        END $$
        """,
        # ── Indexes for plant-scoped queries (composites on the hot time-ordered lists)
        "CREATE INDEX IF NOT EXISTS idx_wo_plant_opened ON work_orders (plant_id, opened_at DESC)",
        # Phase: Interal work-order history import (2026-09-18)
        ('work_orders', 'import_source', 'VARCHAR(40)'),
        ('work_orders', 'import_ref', 'VARCHAR(40)'),
        ('work_orders', 'legacy_technician', 'VARCHAR(200)'),
        ('work_orders', 'legacy_location', 'VARCHAR(200)'),
        ('work_orders', 'legacy_meta', 'JSONB'),
        ('equipment', 'import_source', 'VARCHAR(40)'),
        ('equipment', 'import_ref', 'VARCHAR(40)'),
        # re-importing the same export must upsert, never duplicate
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_import_ref "
        "ON work_orders (import_source, import_ref) WHERE import_source IS NOT NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_import_ref "
        "ON equipment (import_source, import_ref) WHERE import_source IS NOT NULL",
        # the list pages through opened_at DESC; id is the tiebreaker that keeps
        # that ordering stable across pages at 65k rows
        "CREATE INDEX IF NOT EXISTS idx_wo_opened_id ON work_orders (opened_at DESC, id)",
        "CREATE INDEX IF NOT EXISTS idx_wo_plant_status ON work_orders (plant_id, status)",
        # one machine's orders: the equipment page's list and count, machine
        # reports and KPIs for picked machines each read the whole table without it
        "CREATE INDEX IF NOT EXISTS idx_wo_equipment_opened ON work_orders (equipment_id, opened_at DESC)",
        # reports and KPIs OR machine_id with equipment_id, and a BitmapOr needs
        # both sides indexed; machine_id is NULL on every order today, so it is empty
        "CREATE INDEX IF NOT EXISTS idx_wo_machine ON work_orders (machine_id) WHERE machine_id IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_tickets_plant_opened ON maintenance_tickets (plant_id, opened_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_malerts_plant_created ON maintenance_alerts (plant_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_stops_plant_started ON machine_stops (plant_id, started_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_prodlogs_plant_date ON machine_production_logs (plant_id, date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_rejects_plant_date ON reject_logs (plant_id, date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_mhistory_plant_occurred ON machine_history (plant_id, occurred_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_interventions_plant_called ON machine_interventions (plant_id, called_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_machines_plant ON machines (plant_id)",
        "CREATE INDEX IF NOT EXISTS idx_equipment_plant ON equipment (plant_id)",
        "CREATE INDEX IF NOT EXISTS idx_stock_items_plant ON stock_items (plant_id)",
        "CREATE INDEX IF NOT EXISTS idx_job_orders_plant ON job_orders (plant_id)",
        "CREATE INDEX IF NOT EXISTS idx_suppliers_plant ON suppliers (plant_id)",
        "CREATE INDEX IF NOT EXISTS idx_pos_plant ON purchase_orders (plant_id)",
        "CREATE INDEX IF NOT EXISTS idx_sensors_plant ON sensors (plant_id)",
        "CREATE INDEX IF NOT EXISTS idx_cost_centers_plant ON cost_centers (plant_id)",
        "CREATE INDEX IF NOT EXISTS idx_sap_lines_plant ON sap_cost_lines (plant_id)",
        # Phase: Ordres de fabrication (OF) — reconcile job_orders with the model
        # (the original CREATE TABLE used `description`; the model uses `product_name`
        # + scheduled_date/erp_reference/department/started_at/completed_at). Idempotent
        # ADD COLUMN IF NOT EXISTS guarantees every column exists regardless of how the
        # table was first created (DDL vs create_all).
        ('job_orders', 'product_name', 'VARCHAR(300)'),
        ('job_orders', 'scheduled_date', 'DATE'),
        ('job_orders', 'department', 'VARCHAR(200)'),
        ('job_orders', 'erp_reference', 'VARCHAR(200)'),
        ('job_orders', 'started_at', 'TIMESTAMPTZ'),
        ('job_orders', 'completed_at', 'TIMESTAMPTZ'),
        ('job_orders', 'updated_at', 'TIMESTAMPTZ'),
        # Pit Stop TV: equivalent-unit factor per product unit (1 EU = 100 s of
        # assembly-line time). Will come from SAP with the OF; simulator seeds it.
        ('job_orders', 'eu_per_unit', 'DOUBLE PRECISION'),
        # Pit Stop CG/SG split: which furniture family a component category belongs
        # to ('both' shared · 'cg' case goods · 'sg' soft goods). Drives the legend
        # grouping and the physically split buffer areas. seed_pit_stop reconciles.
        ('pit_stop_categories', 'family', "VARCHAR(10) NOT NULL DEFAULT 'both'"),
        # OF numbers are unique PER PLANT, not globally (Mirabel supplies St-Jérôme &
        # Las Vegas — the same number can exist in different plants). Drop the old
        # global unique constraint and scope uniqueness to (plant_id, job_number).
        "ALTER TABLE job_orders DROP CONSTRAINT IF EXISTS job_orders_job_number_key",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_job_orders_plant_number ON job_orders (plant_id, job_number)",
        # Carry the OF onto the raw per-hour production feed so pieces can be attributed.
        ('machine_production_hourly', 'job_number', 'VARCHAR(100)'),
        # Keystone: one "passagem" of an OF through a machine (scan → next scan).
        """
        CREATE TABLE IF NOT EXISTS job_order_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            job_order_id UUID NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
            machine_id UUID NOT NULL REFERENCES machines(id),
            plant_id UUID REFERENCES plants(id),
            department VARCHAR(200),
            operator_id UUID REFERENCES machine_operators(id) ON DELETE SET NULL,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at TIMESTAMPTZ,
            duration_minutes INT,
            pieces INT NOT NULL DEFAULT 0,
            rejects INT NOT NULL DEFAULT 0,
            source VARCHAR(20) NOT NULL DEFAULT 'manual',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_jobruns_job ON job_order_runs (job_order_id, started_at)",
        "CREATE INDEX IF NOT EXISTS idx_jobruns_machine_started ON job_order_runs (machine_id, started_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_jobruns_plant_started ON job_order_runs (plant_id, started_at DESC)",
        # One OPEN run per machine (the OF currently loaded there) — makes close/lookup O(1).
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_jobruns_open_per_machine ON job_order_runs (machine_id) WHERE ended_at IS NULL",
        # The JobOrderSource enum grew (cortex, smart_label) but a native_enum=False
        # column keeps its ORIGINAL VARCHAR length (job_orders.source was VARCHAR(6)
        # from manual/erp) → 'smart_label' (11) would overflow. Widen both.
        "ALTER TABLE job_orders ALTER COLUMN source TYPE VARCHAR(20)",
        "ALTER TABLE job_order_runs ALTER COLUMN source TYPE VARCHAR(20)",
        # A conveyor prop can be tied to a kiosk machine (in/out feed): clicking it on
        # the map opens that machine's OFs.
        ('map_props', 'machine_id', 'UUID REFERENCES machines(id)'),
        ('map_props', 'role', 'VARCHAR(10)'),
        # A saved 3D view can be pinned to a department (its machines) — a custom camera
        # pose overriding that department's auto bounding-box frame. NULL = free view.
        # (create_all only makes NEW tables, never adds a column to the existing one.)
        ('factory_views', 'department', 'VARCHAR(120)'),
        "CREATE INDEX IF NOT EXISTS idx_factory_views_dept ON factory_views (plant_id, department)",
        # Phase: managed department registry (per plant). The department string on
        # equipment/machine/OF is chosen from this list.
        """
        CREATE TABLE IF NOT EXISTS departments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            plant_id UUID NOT NULL REFERENCES plants(id),
            name VARCHAR(200) NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ
        )
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_plant_name ON departments (plant_id, name)",
        "CREATE INDEX IF NOT EXISTS idx_departments_plant ON departments (plant_id)",
        # One-time seed per plant from the existing distinct equipment/machine departments.
        # Guarded by NOT EXISTS(any dept for that plant) so user curation (incl. deletes)
        # sticks — never re-seeds a plant that already has a managed list.
        """
        INSERT INTO departments (id, plant_id, name, is_active, sort_order)
        SELECT gen_random_uuid(), src.plant_id, src.department, TRUE, 0 FROM (
            SELECT DISTINCT plant_id, department FROM equipment
              WHERE department IS NOT NULL AND department <> '' AND plant_id IS NOT NULL
            UNION
            SELECT DISTINCT plant_id, department FROM machines
              WHERE department IS NOT NULL AND department <> '' AND plant_id IS NOT NULL
        ) src
        WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.plant_id = src.plant_id)
        ON CONFLICT DO NOTHING
        """,
        # create_all makes is_active/sort_order nullable (Python-side default) → the raw
        # seed left them NULL. Coalesce so the list filter (is_active IS TRUE) shows them.
        "UPDATE departments SET is_active = COALESCE(is_active, TRUE), sort_order = COALESCE(sort_order, 0)",
        # Phase: OF watch (map "spot" + inactivity alerts). Production counts are
        # movement too — stamp them on the run so a line working the same OF for
        # an hour never looks stalled (job_order_watches itself comes via create_all).
        ('job_order_runs', 'last_piece_at', 'TIMESTAMPTZ'),
        # Phase: Cortex inbound API (/api/v1/cortex — cobot pushes the scanned OF).
        # ERP/Cortex enrichment shown on the kiosk OF panel; the cortex_events
        # audit/idempotency table itself comes via create_all.
        ('job_orders', 'product_code', 'VARCHAR(100)'),
        ('job_orders', 'unit_of_measure', 'VARCHAR(20)'),
        ('job_orders', 'operation_code', 'VARCHAR(50)'),
        ('job_orders', 'operation_description', 'VARCHAR(300)'),
        ('job_orders', 'planned_start_at', 'TIMESTAMPTZ'),
        ('job_orders', 'planned_end_at', 'TIMESTAMPTZ'),
        ('job_orders', 'completed_quantity', 'INT'),
        # Cobot/Tablette real contract: unit time per piece (raw value, unit TBC
        # with the integrator team).
        ('job_orders', 'unit_completion_time', 'INT'),
        # Sushi device tag_name doubles as the user-editable component/position
        # label ("Palier avant") — 20 chars (the 0x42 hardware tag is 10) is too
        # short for that. Guarded widen: no exclusive lock on steady-state boots.
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'sushi_devices' AND column_name = 'tag_name'
                  AND character_maximum_length < 60
            ) THEN
                ALTER TABLE sushi_devices ALTER COLUMN tag_name TYPE VARCHAR(60);
            END IF;
        END $$
        """,
        # Cleaning checklist now links to a stop SUBcategory (e.g. Planned Stop →
        # Nettoyage); stop_category_id stays as the legacy pre-subcategory link.
        ('cleaning_checklists', 'stop_subcategory_id', 'UUID REFERENCES stop_subcategories(id)'),
        # Phase: productivity reporting — pieces per OPERATOR. Nothing linked output
        # to a person before this: the shift log had no operator column and
        # job_order_runs.operator_id was never written. The shift log is the right
        # grain (one machine·date·shift = one operator's turn on that machine);
        # operator_name is the snapshot we group by (see MachineProductionLog).
        ('machine_production_logs', 'operator_id', 'UUID REFERENCES machine_operators(id) ON DELETE SET NULL'),
        ('machine_production_logs', 'operator_name', 'VARCHAR(200)'),
        "CREATE INDEX IF NOT EXISTS idx_prodlogs_operator ON machine_production_logs (operator_name, date DESC)",
        # Phase: kiosk → work order bridge. A repair declared on the floor is
        # clocked by the kiosk check-in ledger and its parts live on the
        # intervention; nothing of that ever reached the WO, so Labor was empty,
        # repair_hours/MTTR unstamped and cost 0 for every kiosk-driven repair.
        # These columns carry the provenance of the mirrored rows.
        # ON DELETE SET NULL on both: an intervention (or a simulator run) must
        # stay deletable, and the labor itself outlives its provenance link.
        ('labor_records', 'intervention_id', 'UUID REFERENCES machine_interventions(id) ON DELETE SET NULL'),
        ('labor_records', 'intervention_technician_id', 'UUID REFERENCES intervention_technicians(id) ON DELETE SET NULL'),
        "CREATE INDEX IF NOT EXISTS idx_labor_intervention_tech ON labor_records (intervention_technician_id)",
        "CREATE INDEX IF NOT EXISTS idx_labor_intervention ON labor_records (intervention_id)",
        # Part pricing falls back to the purchase history when no catalog price was
        # ever set (the inventory XML carries none), so keep those columns filled.
        """
        UPDATE intervention_parts ip
        SET unit_cost = COALESCE(s.unit_cost, s.average_cost, s.last_purchase_cost),
            total_cost = COALESCE(s.unit_cost, s.average_cost, s.last_purchase_cost)
                         * COALESCE(ip.quantity_used, 1)
        FROM stock_items s
        WHERE ip.stock_item_id = s.id
          AND ip.unit_cost IS NULL
          AND COALESCE(s.unit_cost, s.average_cost, s.last_purchase_cost) IS NOT NULL
        """,
        # ── Stock settlement per part line: how much inventory this line really
        # took out, so a reversal (reject / remove / lower the quantity) gives
        # back exactly that and never more. Guarded on information_schema so a
        # steady-state boot takes NO exclusive lock: ALTER TABLE grabs
        # AccessExclusive before it even reads the catalog, so IF NOT EXISTS
        # alone would still block the workers.
        """
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema='public' AND table_name='intervention_parts'
                           AND column_name='stock_deducted') THEN
            ALTER TABLE intervention_parts ADD COLUMN stock_deducted DOUBLE PRECISION;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema='public' AND table_name='wo_parts'
                           AND column_name='stock_deducted') THEN
            ALTER TABLE wo_parts ADD COLUMN stock_deducted DOUBLE PRECISION;
          END IF;
        END $$
        """,
        # Backfill: lines that already settled stock. Approved kiosk parts and
        # every office part did deduct (both paths always did), so the amount to
        # credit back is the line quantity — the only number history holds.
        """
        UPDATE intervention_parts SET stock_deducted = COALESCE(quantity_used, 0)
        WHERE stock_deducted IS NULL AND stock_item_id IS NOT NULL
          AND approval_status = 'approved'
        """,
        """
        UPDATE wo_parts SET stock_deducted = COALESCE(quantity, 0)
        WHERE stock_deducted IS NULL AND stock_item_id IS NOT NULL
        """,
        # ── Phase: Interal inventory extraction (xlsx) — columns the previous
        # XML import had no source for. See scripts/import_inventory_xlsx.py for
        # what each one is mapped from and why the rest of the sheet is skipped.
        ('stock_items', 'quantity_available', 'DOUBLE PRECISION'),
        ('stock_items', 'preferred_supplier', 'VARCHAR(300)'),
        ('stock_items', 'preferred_supplier_code', 'VARCHAR(50)'),
        ('stock_items', 'inventory_code', 'VARCHAR(100)'),
        ('stock_items', 'stockable', 'BOOLEAN'),
        ('stock_items', 'sale_markup', 'DOUBLE PRECISION'),
        ('stock_items', 'drawing_revision', 'VARCHAR(200)'),
        ('stock_items', 'source_note', 'VARCHAR(300)'),
        ('stock_items', 'archived', 'BOOLEAN NOT NULL DEFAULT FALSE'),
        ('stock_items', 'import_incomplete', 'BOOLEAN NOT NULL DEFAULT FALSE'),
        ('stock_items', 'source_synced_at', 'TIMESTAMPTZ'),
        # The importer looks every row up by (plant, code) — 10 000 lookups per
        # run against a table that had no index on code at all.
        "CREATE INDEX IF NOT EXISTS idx_stock_items_plant_code ON stock_items (plant_id, code)",
        # Every list, KPI and search now filters archived rows out; without this
        # the default catalogue view scans the retired half of the table too.
        "CREATE INDEX IF NOT EXISTS idx_stock_items_archived ON stock_items (archived)",
        # Phase: Interal purchase-order import — provenance + the two money
        # figures the ERP keeps apart. All nullable: existing POs are untouched
        # and every one of these reads as "not imported".
        ('purchase_orders', 'subtotal_amount', 'DOUBLE PRECISION'),
        ('purchase_orders', 'external_ref', 'VARCHAR(100)'),
        ('purchase_orders', 'import_source', 'VARCHAR(30)'),
        ('purchase_orders', 'import_ref', 'VARCHAR(80)'),
        ('purchase_orders', 'legacy_meta', 'JSON'),
        # The idempotency key itself. Partial, so the millions of hand-made POs
        # with no provenance never collide with each other on (NULL, NULL) —
        # and re-running a loader can only ever hit the row it already wrote.
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_import_ref ON purchase_orders "
        "(import_source, import_ref) WHERE import_source IS NOT NULL",
    ]
    # `ADD COLUMN IF NOT EXISTS` is statement-level idempotency, NOT lock avoidance.
    # Taking an AccessExclusiveLock is the FIRST step of executing any ALTER TABLE,
    # before the command inspects the catalog at all — so on a steady-state boot,
    # where every column already exists, these still lock all ~50 tables and, being
    # one transaction, hold every lock until commit. Anything reading or writing
    # those tables queues behind the boot, and a worker already holding a row lock
    # deadlocks against it (that is the 2026-07-17 zombie-uvicorn/empty-UI outage).
    # So gate on the catalog first and never ISSUE an ALTER that has nothing to do.
    # One round-trip for all pairs, rather than 286 per-statement DO blocks; same
    # reasoning as the guarded widen of sushi_devices.tag_name above, generalized.
    #
    # The whole schema is ~1.6k rows, so it is fetched unparameterized: binding a
    # table-name array would put driver-specific array adaptation on the boot path
    # for no measurable gain, and filtering in Python cannot fail at runtime.
    wanted = [e for e in stmts if isinstance(e, tuple)]
    async with engine.connect() as conn:
        rows = await conn.execute(
            text("SELECT table_name, column_name FROM information_schema.columns "
                 "WHERE table_schema = current_schema()"))
        present = {(r[0], r[1]) for r in rows}

    pending: list[str] = []
    skipped = 0
    for entry in stmts:
        if isinstance(entry, tuple):
            table, column, type_sql = entry
            if (table, column) in present:
                skipped += 1
                continue
            # IF NOT EXISTS is still kept: `present` is a snapshot taken before any
            # of this runs, and some of these tables are created by a raw CREATE
            # TABLE later in this same list, so the ALTER must stay self-guarding.
            pending.append(
                f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {type_sql}")
        else:
            # Raw-SQL escape hatch: DO blocks, CREATE TABLE/INDEX, ALTER ... TYPE,
            # DROP CONSTRAINT, GRANT, backfill UPDATEs — passed through untouched.
            pending.append(entry)

    # print(flush) rather than logger: app loggers have no handler under uvicorn
    # (only the sqlalchemy echo surfaces), and stdout is block-buffered in the
    # container (no PYTHONUNBUFFERED), so an unflushed print never reaches
    # `docker logs`. This line is the boot's proof that a steady-state start
    # issues no ALTER at all, so it has to be visible.
    print(f"[Startup] Migrations: {skipped}/{len(wanted)} ADD COLUMN already "
          f"applied (not issued); {len(pending)} statement(s) to run", flush=True)

    # Each statement commits on its own (AUTOCOMMIT — same precedent as
    # _ensure_timescale) so one slow ALTER holds its own lock for its own duration
    # instead of pinning ~50 unrelated tables until the whole list finishes.
    # Nothing here depends on all-or-nothing: every statement is idempotent
    # (IF NOT EXISTS / DO-block guarded / _kaizo_migrations ledger) and re-runs on
    # the next boot, so a partial application self-heals — whereas the single
    # transaction made one bad statement roll back all the good ones, every boot.
    ac_engine = engine.execution_options(isolation_level="AUTOCOMMIT")
    async with ac_engine.connect() as conn:
        for stmt in pending:
            await conn.execute(text(stmt))

    # The data fix-ups and seeds below stay in one transaction: unlike the DDL they
    # are not individually self-guarding, and they touch only a handful of tables.
    async with engine.begin() as conn:
        # Mark pre-existing global stop categories (IS DISTINCT FROM also catches NULL,
        # otherwise the kiosk's global fallback finds nothing and stop reasons go blank).
        await conn.execute(text(
            "UPDATE stop_categories SET is_global = TRUE WHERE machine_id IS NULL AND is_global IS DISTINCT FROM TRUE"
        ))
        # Coalesce NULL boolean flags on stop categories so StopCategoryOut never 500s.
        await conn.execute(text(
            "UPDATE stop_categories SET comment_required = COALESCE(comment_required, FALSE), "
            "triggers_maintenance = COALESCE(triggers_maintenance, FALSE), is_active = COALESCE(is_active, TRUE)"
        ))
        # Canonical color per stop type (planned=blue, unplanned=red, maintenance=yellow)
        # for the standard/global categories, so the kiosk timeline, config page and stop
        # modal stay consistent. Per-machine custom categories keep their own color.
        await conn.execute(text(
            "UPDATE stop_categories SET color = CASE type "
            "WHEN 'planned' THEN '#3b82f6' WHEN 'unplanned' THEN '#ef4444' "
            "WHEN 'maintenance' THEN '#eab308' ELSE color END "
            "WHERE machine_id IS NULL"
        ))
        # Same for reject categories (global fallback + NULL bool flags).
        await conn.execute(text(
            "UPDATE reject_categories SET is_global = TRUE WHERE machine_id IS NULL AND is_global IS DISTINCT FROM TRUE"
        ))
        await conn.execute(text(
            "UPDATE reject_categories SET comment_required = COALESCE(comment_required, FALSE), is_active = COALESCE(is_active, TRUE)"
        ))
        # Legacy seeds (and rows cloned from them) stored emoji as icons, but the
        # config UI's icon picker writes IconLibrary keys — the two render styles
        # don't match. Normalize emoji to their IconLibrary equivalent.
        emoji_icons = {
            "🕐": "clock24", "⏰": "clock24", "⏸": "clock24",
            "⚠️": "exclamation", "⚠": "exclamation",
            "❌": "no-entry", "🚫": "no-operator", "🔧": "wrench",
            "✅": "quality", "📦": "materials", "💻": "computer",
            "🧹": "broom", "🔍": "magnifier", "⚡": "lightning", "🔥": "fire",
        }
        icon_case = " ".join(f"WHEN '{e}' THEN '{k}'" for e, k in emoji_icons.items())
        icon_in = ", ".join(f"'{e}'" for e in emoji_icons)
        for icon_table in ("stop_categories", "stop_subcategories",
                           "reject_categories", "reject_subcategories"):
            await conn.execute(text(
                f"UPDATE {icon_table} SET icon = CASE icon {icon_case} END "
                f"WHERE icon IN ({icon_in})"
            ))
        await _seed_stop_categories(conn)
        await _seed_suppliers(conn)
        await _seed_shift_templates(conn)


async def _seed_shift_templates(conn) -> None:
    """Insert default shift templates + breaks if none exist. These are editable
    in Settings; they map to Technician.shift (day|evening|night). Times are
    plant-local wall clock. A lunch + two short breaks per shift are the common
    Foliot layout; adjust per plant in the UI. Only used for LABOR-cost/effective
    time and availability — machine downtime is unaffected."""
    result = await conn.execute(text("SELECT COUNT(*) FROM shift_templates"))
    if result.scalar() > 0:
        return
    # (key, name, start, end, [(kind, name, start, end, paid), ...])
    defaults = [
        ("day",     "Day",     "08:00", "16:30",
         [("break", "Morning break",   "10:00", "10:15", True),
          ("lunch", "Lunch",           "12:00", "12:30", False),
          ("break", "Afternoon break", "14:30", "14:45", True)]),
        ("evening", "Evening", "16:30", "00:30",
         [("break", "Break",           "18:30", "18:45", True),
          ("lunch", "Meal",            "20:30", "21:00", False)]),
        ("night",   "Night",   "00:30", "08:00",
         [("break", "Break",           "03:00", "03:15", True),
          ("lunch", "Meal",            "05:00", "05:30", False)]),
    ]
    for key, name, start, end, breaks in defaults:
        r = await conn.execute(text(
            "INSERT INTO shift_templates (id, key, name, start_time, end_time, active) "
            "VALUES (gen_random_uuid(), :k, :n, :s, :e, TRUE) RETURNING id"
        ), {"k": key, "n": name, "s": start, "e": end})
        tpl_id = r.scalar()
        for kind, bname, bs, be, paid in breaks:
            await conn.execute(text(
                "INSERT INTO shift_breaks (id, shift_template_id, kind, name, start_time, end_time, paid) "
                "VALUES (gen_random_uuid(), :t, :k, :n, :s, :e, :p)"
            ), {"t": tpl_id, "k": kind, "n": bname, "s": bs, "e": be, "p": paid})


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
        (gen_random_uuid(), 'Planned Stop',           'planned',     'clock24',     '#3b82f6', true, 1),
        (gen_random_uuid(), 'Maintenance Requested',  'maintenance', 'exclamation', '#f59e0b', true, 2),
        (gen_random_uuid(), 'Unplanned Stop',         'unplanned',   'no-entry',    '#ef4444', true, 3)
    """))
    r = await conn.execute(text(
        "SELECT id, name FROM stop_categories WHERE name = 'Unplanned Stop'"
    ))
    row = r.fetchone()
    if row:
        uid = row[0]
        await conn.execute(text(f"""
            INSERT INTO stop_subcategories (id, category_id, name, icon, color, triggers_maintenance, is_active, sort_order) VALUES
            (gen_random_uuid(), '{uid}', 'No Operator',    'no-operator', '#6b7280', false, true, 1),
            (gen_random_uuid(), '{uid}', 'Maintenance',    'wrench',      '#f59e0b', true,  true, 2),
            (gen_random_uuid(), '{uid}', 'Quality Stop',   'quality',     '#10b981', false, true, 3),
            (gen_random_uuid(), '{uid}', 'Materials Stop', 'materials',   '#8b5cf6', false, true, 4),
            (gen_random_uuid(), '{uid}', 'IT Stop',        'computer',    '#06b6d4', false, true, 5)
        """))


async def _intelligence_cron() -> None:
    """Generate maintenance intelligence insights every 8 hours, all languages —
    one insight PER PLANT, so each plant's page (and Las Vegas especially) only
    ever describes its own operation."""
    while True:
        await asyncio.sleep(8 * 3600)
        async with AsyncSessionLocal() as db:
            from sqlalchemy import select as _sel
            from app.models.models import AIInsight, Plant
            plants = (await db.execute(
                _sel(Plant).where(Plant.active == True)  # noqa: E712
            )).scalars().all()
            for plant in plants:
                for lang in ("en", "fr", "es"):
                    try:
                        from app.services.intelligence_calculator import build_findings
                        from app.services.intelligence_ai import generate_insight_text
                        findings = await build_findings(db=db, period_days=7, plant_id=str(plant.id))
                        text_out, ai = await generate_insight_text(findings, lang, "full_report")
                        insight = AIInsight(
                            plant_id=plant.id,
                            insight_type="full_report", language=lang,
                            period_start=datetime.now(timezone.utc) - timedelta(days=7),
                            period_end=datetime.now(timezone.utc),
                            period_days=7, findings_json=findings,
                            insight_text=text_out, ai_generated=ai,
                            generated_by_model="claude-sonnet-4-6" if ai else None,
                        )
                        db.add(insight)
                        await db.commit()
                    except Exception as e:
                        logger.error("Intelligence cron %s/%s: %s", plant.code, lang, e)


async def _ensure_timescale() -> None:
    """TimescaleDB setup for the high-volume production / telemetry tables.

    Runs on AUTOCOMMIT: continuous-aggregate DDL and create_hypertable(migrate_data)
    cannot run inside a transaction block (unlike _run_migrations, which does).
    Idempotent — guarded by catalog checks + IF NOT EXISTS, so it's a no-op once
    applied. Mirrors scripts/migrations/2026-07-08_timescale_production.sql, which
    is the manual path for a DBA; this is the automatic one for fresh installs.
    Non-fatal: on a non-TimescaleDB database it logs and skips."""
    stmts = [
        "CREATE EXTENSION IF NOT EXISTS timescaledb",
        # sensor_readings → hypertable (high-frequency telemetry stream)
        """DO $$ BEGIN
             IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='sensor_readings')
                AND NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='sensor_readings') THEN
               ALTER TABLE sensor_readings DROP CONSTRAINT IF EXISTS sensor_readings_pkey;
               ALTER TABLE sensor_readings ADD PRIMARY KEY (id, "timestamp");
               PERFORM create_hypertable('sensor_readings','timestamp', migrate_data=>TRUE, if_not_exists=>TRUE, chunk_time_interval=>INTERVAL '7 days');
               ALTER TABLE sensor_readings SET (timescaledb.compress, timescaledb.compress_segmentby='sensor_id', timescaledb.compress_orderby='"timestamp" DESC');
               PERFORM add_compression_policy('sensor_readings', INTERVAL '30 days', if_not_exists=>TRUE);
               PERFORM add_retention_policy('sensor_readings', INTERVAL '2 years', if_not_exists=>TRUE);
             END IF;
           END $$""",
        'CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_ts ON sensor_readings (sensor_id, "timestamp" DESC)',
        'CREATE INDEX IF NOT EXISTS idx_sensor_readings_equip_ts ON sensor_readings (equipment_id, "timestamp" DESC)',
        # machine_production_hourly → hypertable (grows with every machine·hour)
        """DO $$ BEGIN
             IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='machine_production_hourly')
                AND NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='machine_production_hourly') THEN
               ALTER TABLE machine_production_hourly DROP CONSTRAINT IF EXISTS machine_production_hourly_pkey;
               ALTER TABLE machine_production_hourly ADD PRIMARY KEY (id, hour);
               PERFORM create_hypertable('machine_production_hourly','hour', migrate_data=>TRUE, if_not_exists=>TRUE, chunk_time_interval=>INTERVAL '30 days');
               ALTER TABLE machine_production_hourly SET (timescaledb.compress, timescaledb.compress_segmentby='machine_id', timescaledb.compress_orderby='hour DESC');
               PERFORM add_compression_policy('machine_production_hourly', INTERVAL '90 days', if_not_exists=>TRUE);
             END IF;
           END $$""",
        "CREATE INDEX IF NOT EXISTS idx_mph_machine_hour ON machine_production_hourly (machine_id, hour DESC)",
        # Continuous aggregate: produced/rejected per machine per day (auto-refresh).
        # Dashboards/BI read this instead of scanning raw hourly rows.
        """CREATE MATERIALIZED VIEW IF NOT EXISTS machine_production_daily
           WITH (timescaledb.continuous) AS
           SELECT machine_id, time_bucket(INTERVAL '1 day', hour) AS bucket,
                  sum(count) AS produced, sum(reject_count) AS rejected
           FROM machine_production_hourly
           GROUP BY machine_id, time_bucket(INTERVAL '1 day', hour)""",
        """SELECT add_continuous_aggregate_policy('machine_production_daily',
             start_offset => INTERVAL '90 days', end_offset => INTERVAL '1 hour',
             schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)""",
    ]
    try:
        ac_engine = engine.execution_options(isolation_level="AUTOCOMMIT")
        async with ac_engine.connect() as conn:
            for stmt in stmts:
                await conn.execute(text(stmt))
    except Exception as e:  # noqa: BLE001 — non-fatal; app must boot without Timescale
        logger.warning("TimescaleDB setup skipped/failed (non-fatal): %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _run_migrations()
    await _ensure_timescale()
    await _backfill_ticket_alerts()
    task = asyncio.create_task(_escalation_loop())
    of_watch_task = asyncio.create_task(_of_watch_loop())
    pm_task = asyncio.create_task(_pm_loop())
    intel_task = asyncio.create_task(_intelligence_cron())
    shift_report_task = asyncio.create_task(_shift_report_loop())
    weather_task = asyncio.create_task(_weather_loop())
    temperature_task = asyncio.create_task(_temperature_loop())
    from app.services.predictive.runner import predictive_loop
    predictive_task = asyncio.create_task(predictive_loop())
    yield
    task.cancel()
    of_watch_task.cancel()
    pm_task.cancel()
    intel_task.cancel()
    shift_report_task.cancel()
    weather_task.cancel()
    temperature_task.cancel()
    predictive_task.cancel()
    await engine.dispose()


app = FastAPI(
    title="MES Maintenance Platform",
    description="Multi-plant maintenance management and industrial monitoring platform",
    version="0.1.0",
    lifespan=lifespan,
)

# Auth is header-based (Bearer JWT, no cookies), so credentials aren't needed.
# A wildcard origin with credentials is invalid in browsers — only enable credentials
# when explicit origins are configured for production.
_cors_origins = settings.cors_origins_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Live-update events ────────────────────────────────────────────────────────
# Any successful mutation on these paths publishes a hint on the event bus, and
# /api/live/ws pushes it to connected browsers (kiosk, dashboards, badges), which
# then refetch. Path-based so every current and future endpoint is covered without
# per-route publish calls.
_MUTATING_METHODS = {"POST", "PATCH", "PUT", "DELETE"}
# Machine-scoped: the ref (id, code or page_slug — _get_machine accepts all three)
# is in the path, so clients can refetch only their own machine.
_MACHINE_PATH = re.compile(r"^/api/(?:machines|machine-operator)/([^/]+)")
# Office-side changes that can flip a machine's effective status (ticket opened/
# closed, alert converted, WO started) but don't carry the machine in the URL →
# broadcast (ref=None). Low-rate operations, so a plant-wide refetch is fine.
_MACHINE_BROADCAST_PATH = re.compile(r"^/api/(?:alerts|tickets|wo)(?:/|$)")
_BADGES_PATH = re.compile(r"^/api/(?:alerts|tickets|wo|machine-operator)(?:/|$)")


@app.middleware("http")
async def _publish_live_events(request, call_next):
    response = await call_next(request)
    if request.method in _MUTATING_METHODS and response.status_code < 400:
        path = request.url.path
        machine = _MACHINE_PATH.match(path)
        if machine:
            event_bus.publish_machine(machine.group(1))
        elif _MACHINE_BROADCAST_PATH.match(path):
            event_bus.publish_machine(None)
        if _BADGES_PATH.match(path):
            event_bus.publish_badges()
    return response

app.include_router(auth.router,                   prefix="/api/auth",          tags=["Authentication"])
app.include_router(plants.router,                 prefix="/api/plants",        tags=["Plants"])
app.include_router(equipment.router,              prefix="/api/equipment",     tags=["Equipment"],            dependencies=[Depends(resource_guard("equipment"))])
app.include_router(work_orders.router,            prefix="/api/wo",            tags=["Work Orders"],          dependencies=[Depends(resource_guard("work_orders")), Depends(path_plant_guard(WorkOrder, "work_order_id", detail="Work order not found"))])
app.include_router(maintenance_plans.router,      prefix="/api/plans",         tags=["Maintenance Plans"],     dependencies=[Depends(role_write_guard(UserRole.supervisor, UserRole.maintenance_director, UserRole.plant_manager, UserRole.director)), Depends(path_plant_guard(MaintenancePlan, "plan_id", detail="Plan not found")), Depends(path_plant_guard(PlanOccurrence, "occurrence_id", detail="Occurrence not found"))])
app.include_router(inventory.router,              prefix="/api/inventory",     tags=["Inventory"],            dependencies=[Depends(role_write_guard(UserRole.supervisor, UserRole.maintenance_director, UserRole.plant_manager, UserRole.director))])
app.include_router(alerts.router,                 prefix="/api/alerts",        tags=["Maintenance Alerts"])
app.include_router(tickets.router,                prefix="/api/tickets",       tags=["Maintenance Tickets"])
app.include_router(maintenance_dashboard.router,  prefix="/api/maintenance",   tags=["Maintenance Dashboard"])
app.include_router(iot.router,                    prefix="/api/iot",           tags=["IoT / Sensors"])
app.include_router(users.router,                  prefix="/api/users",         tags=["Users"])
app.include_router(kpis.router,                   prefix="/api/kpis",          tags=["KPIs"])
app.include_router(home_insights.router,          prefix="/api/insights",      tags=["Home Insights"])
app.include_router(predictive.router,             prefix="/api/predictive",    tags=["Predictive"],           dependencies=[Depends(resource_guard("predictive"))])
app.include_router(costs.router,                  prefix="/api/costs",         tags=["Costs"],                dependencies=[Depends(resource_guard("costs"))])
# Cost-control layer (reconciliation, cut-off/forecast, commitments, alerts,
# actions, executive report) — same prefix and same guard as the Costs router.
app.include_router(costs_control.router,          prefix="/api/costs",         tags=["Costs"],                dependencies=[Depends(resource_guard("costs"))])
app.include_router(factory_calendar.router,       prefix="/api/calendar",      tags=["Factory Calendar"],     dependencies=[Depends(resource_guard("calendar"))])
app.include_router(adam_devices.router,           prefix="/api/adam-devices",  tags=["ADAM Devices"],         dependencies=[Depends(resource_guard("settings_devices"))])
app.include_router(cortex_stations.router,        prefix="/api/cortex-stations", tags=["Cortex Stations"],    dependencies=[Depends(resource_guard("settings_devices"))])
app.include_router(temperature_sensors.router,    prefix="/api/temperature-sensors", tags=["Temperature Sensors"], dependencies=[Depends(resource_guard("settings_devices"))])
app.include_router(sushi_devices.router,          prefix="/api/sushi-devices", tags=["Sushi Devices"],         dependencies=[Depends(resource_guard("settings_devices"))])
app.include_router(sushi.condition_router,        prefix="/api/sushi",         tags=["Sushi Condition"],       dependencies=[Depends(resource_guard("equipment"))])
app.include_router(sushi.ingest_router,           prefix="/api/sushi",         tags=["Sushi Ingest"])  # network-server webhook — X-Ingest-Token, no JWT
app.include_router(cortex_ingest_router,          prefix="/api/v1/cortex",     tags=["Cortex Ingest"])  # Cortex push (cobot OF reads) — Bearer CORTEX_INGEST_TOKEN, no JWT
app.include_router(cortex_ingest_admin_router,    prefix="/api/v1/cortex",     tags=["Cortex Ingest"],  dependencies=[Depends(resource_guard("settings_devices"))])
app.include_router(reports.router,                prefix="/api/reports",       tags=["Reports"])
app.include_router(escalation.router,             prefix="/api/escalation",    tags=["Escalation"])
app.include_router(technicians.router,            prefix="/api/technicians",   tags=["Technicians"],          dependencies=[Depends(resource_guard("technicians"))])
app.include_router(shift_templates.router,        prefix="/api/shift-templates", tags=["Shift Templates"],     dependencies=[Depends(resource_guard("technicians"))])
app.include_router(machines.router,               prefix="/api/machines",      tags=["Machines"],             dependencies=[Depends(kiosk_ref_guard("ref"))])
app.include_router(factory_map.router,            prefix="/api/factory-map",   tags=["Factory Map"])
app.include_router(factory_replay.router,         prefix="/api/factory-replay", tags=["Factory Replay"])
app.include_router(robot_cells_router,            prefix="/api/robot-cells",   tags=["Robot Cells"])
app.include_router(stop_categories.router,        prefix="/api/stop-categories", tags=["Stop Categories"])
app.include_router(job_orders.router,             prefix="/api/job-orders",      tags=["Job Orders"])
app.include_router(pit_stop.router,               prefix="/api/pit-stop",        tags=["Pit Stop"])
app.include_router(of_watch.router,               prefix="/api/of-watch",        tags=["OF Watch"])
app.include_router(departments_module.router,     prefix="/api/departments",     tags=["Departments"])
app.include_router(suppliers_module.supplier_router, prefix="/api/suppliers",       tags=["Suppliers"],            dependencies=[Depends(role_write_guard(UserRole.supervisor, UserRole.maintenance_director, UserRole.plant_manager, UserRole.director))])
app.include_router(suppliers_module.po_router,       prefix="/api/supplier-orders", tags=["Purchase Orders"],      dependencies=[Depends(role_write_guard(UserRole.supervisor, UserRole.maintenance_director, UserRole.plant_manager, UserRole.director))])
app.include_router(machine_operator_router, dependencies=[Depends(kiosk_ref_guard("machine_id"))])
# SOP library: writes need sops:create/update/delete (supervisor+ by default);
# reads pass with auth. Executions: any authenticated user may follow a SOP.
# Kiosk SOP routes share the machine-page trust level (per-machine kiosk token).
app.include_router(sops_router,           dependencies=[Depends(resource_guard("sops"))])
app.include_router(sop_execution_router)
app.include_router(sop_kiosk_router,      dependencies=[Depends(kiosk_ref_guard("ref"))])
app.include_router(intervention_types_router)
# Checklist config is keyed on /{equipment_id}; guard that the equipment is on a
# plant the caller can access so machine checklists never cross the plant boundary.
app.include_router(safety_checklist_router, dependencies=[Depends(path_plant_guard(Equipment, "equipment_id", detail="Equipment not found"))])
app.include_router(cleaning_checklist_router, dependencies=[Depends(path_plant_guard(Equipment, "equipment_id", detail="Equipment not found"))])
app.include_router(
    wo_approval_router,
    dependencies=[
        # Sign-off is a managerial action: reads pass with auth, but only a
        # supervisor+ may approve/reject/edit (an operator or technician must not).
        Depends(role_write_guard(UserRole.supervisor, UserRole.maintenance_director, UserRole.plant_manager, UserRole.director)),
        # …and never across the plant boundary.
        Depends(path_plant_guard(MachineIntervention, "intervention_id", detail="Work order not found")),
        Depends(path_plant_guard(WorkOrder, "work_order_id", detail="Work order not found")),
    ],
)
app.include_router(
    pm_template_settings_router,
    dependencies=[
        Depends(role_write_guard(
            UserRole.supervisor, UserRole.maintenance_director,
            UserRole.plant_manager, UserRole.director,
        )),
        Depends(path_plant_guard(PmTemplate, "template_id", detail="PM template not found")),
    ],
)
app.include_router(intelligence_router)
app.include_router(uploads_router)
app.include_router(
    dashboards_router, prefix="/api/dashboards", tags=["Dashboards"],
    # Reads stay open (TV displays), but building/editing/deleting a shared
    # dashboard is a supervisor+ action — not something an operator may do.
    dependencies=[Depends(role_write_guard(UserRole.supervisor, UserRole.maintenance_director, UserRole.plant_manager, UserRole.director))],
)
app.include_router(live_router,       prefix="/api/live",       tags=["Live Updates"])

# Serve uploaded media (photos/videos for SOP steps). Behind nginx /api/ → backend.
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
app.mount("/api/media", StaticFiles(directory=settings.UPLOAD_DIR), name="media")


@app.get("/api/health", tags=["System"])
async def health():
    return {"status": "ok", "version": "0.1.0"}
