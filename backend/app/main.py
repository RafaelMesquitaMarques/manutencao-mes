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
    suppliers as suppliers_module, reports, escalation, factory_map, costs,
    factory_calendar, adam_devices,
)
from app.api.routes.machine_operator import router as machine_operator_router
from app.api.routes.intervention_type_settings import router as intervention_types_router
from app.api.routes.safety_checklist_settings import router as safety_checklist_router
from app.api.routes.wo_approval import router as wo_approval_router
from app.api.routes.pm_template_settings import router as pm_template_settings_router
from app.api.routes.intelligence import router as intelligence_router
from app.api.routes.uploads import router as uploads_router
from app.api.routes.robot_cells import router as robot_cells_router
from app.api.routes.dashboards import router as dashboards_router
from app.api.routes.live import router as live_router
from app.core.permissions import resource_guard, role_write_guard
from app.models.models import UserRole
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
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS kiosk_layout JSON",
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
        # Scale machine_stops range scans (downtime by machine over time) without
        # hypertabling it (kept plain: small, and fetched by id via db.get).
        "CREATE INDEX IF NOT EXISTS idx_machine_stops_machine_started ON machine_stops (machine_id, started_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_machine_stops_started ON machine_stops (started_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_machine_stops_category ON machine_stops (stop_category_id)",
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
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS intervention_type_id UUID REFERENCES intervention_types(id) ON DELETE SET NULL",
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS intervention_type_name VARCHAR(200)",
        # Phase: intervention timing metrics
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS response_time_minutes FLOAT",
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS intervention_duration_minutes FLOAT",
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS total_downtime_minutes FLOAT",
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS called_by_name VARCHAR(200)",
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS started_by_name VARCHAR(200)",
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS completed_by_name VARCHAR(200)",
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
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS plant_id UUID REFERENCES plants(id)",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS pm_template_id UUID REFERENCES pm_templates(id) ON DELETE SET NULL",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS plan_type VARCHAR(30) DEFAULT 'preventive'",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS frequency_type VARCHAR(30)",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS frequency_value INTEGER DEFAULT 1",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS frequency_days INTEGER",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS frequency_hours DOUBLE PRECISION",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS weekdays VARCHAR(20)",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS start_date DATE",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS recurrence_end_type VARCHAR(20) DEFAULT 'never'",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS recurrence_end_value INTEGER",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS recurrence_end_date DATE",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS lead_time_days INTEGER DEFAULT 3",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS assigned_technician_id UUID REFERENCES technicians(id) ON DELETE SET NULL",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium'",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS estimated_hours DOUBLE PRECISION DEFAULT 1.0",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS next_due_date DATE",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS next_due_hours DOUBLE PRECISION",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS total_occurrences INTEGER DEFAULT 0",
        "ALTER TABLE maintenance_plans ADD COLUMN IF NOT EXISTS created_by_id UUID REFERENCES users(id) ON DELETE SET NULL",
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
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES maintenance_plans(id)",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS occurrence_id UUID REFERENCES plan_occurrences(id) ON DELETE SET NULL",
        "ALTER TABLE wo_actions ADD COLUMN IF NOT EXISTS description TEXT",
        "ALTER TABLE wo_actions ADD COLUMN IF NOT EXISTS is_required BOOLEAN DEFAULT TRUE",
        "ALTER TABLE wo_actions ADD COLUMN IF NOT EXISTS is_completed BOOLEAN DEFAULT FALSE",
        "ALTER TABLE wo_actions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ",
        "ALTER TABLE wo_actions ADD COLUMN IF NOT EXISTS completed_by_id UUID REFERENCES users(id) ON DELETE SET NULL",
        "ALTER TABLE wo_actions ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0",
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
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS equipment_id UUID REFERENCES equipment(id) ON DELETE SET NULL",
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
        "ALTER TABLE escalation_settings ADD COLUMN IF NOT EXISTS notify_on_ticket_opened BOOLEAN DEFAULT TRUE",
        "ALTER TABLE escalation_settings ADD COLUMN IF NOT EXISTS notify_on_ticket_completed BOOLEAN DEFAULT TRUE",
        # Phase: supervisor-controlled technician self-assignment
        "ALTER TABLE escalation_settings ADD COLUMN IF NOT EXISTS technician_self_assign BOOLEAN DEFAULT TRUE",
        # End-of-shift summary (SMS to level-1 contacts) — off until enabled in Settings → Escalation
        "ALTER TABLE escalation_settings ADD COLUMN IF NOT EXISTS shift_report_enabled BOOLEAN DEFAULT FALSE",
        # Phase: work-order-driven maintenance stop (office/mobile flow feeds Availability/OEE)
        "ALTER TABLE machine_stops ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'operator'",
        # Phase: per-machine production-signal ingest token (ADAM-6050)
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS signal_ingest_token VARCHAR(120)",
        # Phase: PM template SOP — expected result per step (media live in pm_task_media, created by create_all)
        "ALTER TABLE pm_template_tasks ADD COLUMN IF NOT EXISTS expected_result TEXT",
        # Phase: checklist rigor on the work order (advisory | required | strict)
        "ALTER TABLE pm_templates ADD COLUMN IF NOT EXISTS enforcement VARCHAR(20) DEFAULT 'advisory'",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS checklist_enforcement VARCHAR(20) DEFAULT 'advisory'",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS board_order INTEGER",
        # Phase: auxiliary (non-productive) equipment — maintenance-only assets
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS asset_type VARCHAR(20) DEFAULT 'production'",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS subtype VARCHAR(100)",
        # Phase: equipment classification fields (promoted from the maintenance Excel import)
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS department VARCHAR(200)",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS family VARCHAR(200)",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS pm_strategy VARCHAR(300)",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS cleaning_priority VARCHAR(50)",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS function_label VARCHAR(300)",
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
        "ALTER TABLE wo_actions ADD COLUMN IF NOT EXISTS expected_result TEXT",
        "ALTER TABLE wo_actions ADD COLUMN IF NOT EXISTS template_task_id UUID",
        "ALTER TABLE wo_actions ADD COLUMN IF NOT EXISTS proof_photo_url VARCHAR(1000)",
        # Phase: parts pricing — snapshot stock price on intervention parts
        "ALTER TABLE intervention_parts ADD COLUMN IF NOT EXISTS unit_cost DOUBLE PRECISION",
        "ALTER TABLE intervention_parts ADD COLUMN IF NOT EXISTS total_cost DOUBLE PRECISION",
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
        "ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS average_cost DOUBLE PRECISION",
        "ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS last_purchase_cost DOUBLE PRECISION",
        "ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS last_purchase_date DATE",
        # Phase: serial number on machines + equipment
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS serial_number VARCHAR(200)",
        # ── Factory map / digital-twin layout ──
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS plant_id UUID REFERENCES plants(id)",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS pos_x DOUBLE PRECISION",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS pos_y DOUBLE PRECISION",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS pos_w DOUBLE PRECISION",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS pos_h DOUBLE PRECISION",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS rotation_deg DOUBLE PRECISION",
        "ALTER TABLE machines ADD COLUMN IF NOT EXISTS icon_url VARCHAR(500)",
        "ALTER TABLE plants ADD COLUMN IF NOT EXISTS floor_plan_url VARCHAR(500)",
        # backfill the machine→plant link from its equipment (one-time, guarded)
        "UPDATE machines SET plant_id = e.plant_id FROM equipment e WHERE machines.equipment_id = e.id AND machines.plant_id IS NULL",
        # equipment carries the map position (the factory map is asset-based, not machine-based)
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS pos_x DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS pos_y DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS pos_w DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS pos_h DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS rotation_deg DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS icon_url VARCHAR(500)",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS model_url VARCHAR(500)",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS height_3d DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS model_scale DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS scale_y DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS scale_z DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS block_kind VARCHAR(40)",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS parent_equipment_id UUID REFERENCES equipment(id)",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS orbit_x DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS orbit_y DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS orbit_w DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS orbit_h DOUBLE PRECISION",
        "ALTER TABLE equipment ADD COLUMN IF NOT EXISTS serial_number VARCHAR(200)",
        # Map props can optionally link to a real equipment (live status / click-through)
        "ALTER TABLE map_props ADD COLUMN IF NOT EXISTS equipment_id UUID REFERENCES equipment(id)",
        # One-time backfill from received purchases (inventory_movements 'addition').
        # Guarded by IS NULL so it only fills items not yet computed.
        """
        UPDATE stock_items s
        SET average_cost = sub.avg_cost
        FROM (
            SELECT stock_item_id,
                   SUM(unit_cost * quantity) / NULLIF(SUM(quantity), 0) AS avg_cost
            FROM inventory_movements
            WHERE movement_type = 'addition' AND unit_cost IS NOT NULL AND quantity > 0
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
            WHERE movement_type = 'addition' AND unit_cost IS NOT NULL
            ORDER BY stock_item_id, created_at DESC
        ) lm
        WHERE s.id = lm.stock_item_id AND s.last_purchase_cost IS NULL
        """,
        # Phase: escalation flexibility — per-contact scope (department/machines)
        # and quiet hours, + minimum priority for the level-0 ticket group
        "ALTER TABLE escalation_contacts ADD COLUMN IF NOT EXISTS scope_department VARCHAR(200)",
        "ALTER TABLE escalation_contacts ADD COLUMN IF NOT EXISTS scope_machine_ids JSON",
        "ALTER TABLE escalation_contacts ADD COLUMN IF NOT EXISTS notify_start VARCHAR(5)",
        "ALTER TABLE escalation_contacts ADD COLUMN IF NOT EXISTS notify_end VARCHAR(5)",
        "ALTER TABLE escalation_contacts ADD COLUMN IF NOT EXISTS critical_bypass BOOLEAN DEFAULT TRUE",
        "ALTER TABLE escalation_settings ADD COLUMN IF NOT EXISTS ticket_group_min_priority VARCHAR(20) DEFAULT 'low'",
        # Phase: escalation lifecycle — same-level reminders + planned-stop pause
        # (the "I'm on it" ack feature was built then removed — DROPs clean it up)
        "ALTER TABLE maintenance_alerts ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ",
        "ALTER TABLE escalation_settings ADD COLUMN IF NOT EXISTS reminder_minutes INTEGER DEFAULT 0",
        "ALTER TABLE escalation_settings ADD COLUMN IF NOT EXISTS pause_during_planned_stop BOOLEAN DEFAULT TRUE",
        "ALTER TABLE maintenance_alerts DROP COLUMN IF EXISTS ack_token",
        "ALTER TABLE maintenance_alerts DROP COLUMN IF EXISTS acknowledged_at",
        "ALTER TABLE maintenance_alerts DROP COLUMN IF EXISTS acknowledged_by",
        "ALTER TABLE escalation_settings DROP COLUMN IF EXISTS ack_enabled",
        # Phase: editable SMS templates + per-trigger channel matrix
        "ALTER TABLE escalation_settings ADD COLUMN IF NOT EXISTS sms_templates JSON",
        "ALTER TABLE escalation_settings ADD COLUMN IF NOT EXISTS channel_matrix JSON",
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
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'pending'",
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS approved_by_id UUID REFERENCES users(id) ON DELETE SET NULL",
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ",
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS approval_note TEXT",
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS rejection_reason TEXT",
        # Office work order = work_orders
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'pending'",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS approved_by_id UUID REFERENCES users(id) ON DELETE SET NULL",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS approval_note TEXT",
        "ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS rejection_reason TEXT",
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
        "ALTER TABLE cost_center_budgets ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'opex'",
        """DO $$ BEGIN
           ALTER TABLE cost_center_budgets DROP CONSTRAINT IF EXISTS uq_cc_budget_year_month_cc;
           ALTER TABLE cost_center_budgets ADD CONSTRAINT uq_cc_budget_year_month_cc_kind
             UNIQUE (year, month, cost_center, kind);
           EXCEPTION WHEN others THEN NULL; END $$""",
        # Cost center on approval + purchase-order commitments (forecast)
        "ALTER TABLE machine_interventions ADD COLUMN IF NOT EXISTS cost_center VARCHAR(200)",
        "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cost_center VARCHAR(200)",
        "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS scope VARCHAR(10) NOT NULL DEFAULT 'opex'",
    ]
    async with engine.begin() as conn:
        for stmt in stmts:
            await conn.execute(text(stmt))
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
    """Generate maintenance intelligence insights every 8 hours, all languages."""
    while True:
        await asyncio.sleep(8 * 3600)
        async with AsyncSessionLocal() as db:
            for lang in ("en", "fr", "es"):
                try:
                    from app.services.intelligence_calculator import build_findings
                    from app.services.intelligence_ai import generate_insight_text
                    from app.models.models import AIInsight
                    findings = await build_findings(db=db, period_days=7)
                    text_out, ai = await generate_insight_text(findings, lang, "full_report")
                    insight = AIInsight(
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
                    logger.error("Intelligence cron %s: %s", lang, e)


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
    pm_task = asyncio.create_task(_pm_loop())
    intel_task = asyncio.create_task(_intelligence_cron())
    shift_report_task = asyncio.create_task(_shift_report_loop())
    yield
    task.cancel()
    pm_task.cancel()
    intel_task.cancel()
    shift_report_task.cancel()
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
app.include_router(work_orders.router,            prefix="/api/wo",            tags=["Work Orders"],          dependencies=[Depends(resource_guard("work_orders"))])
app.include_router(maintenance_plans.router,      prefix="/api/plans",         tags=["Maintenance Plans"],     dependencies=[Depends(role_write_guard(UserRole.supervisor, UserRole.maintenance_director, UserRole.plant_manager, UserRole.director))])
app.include_router(inventory.router,              prefix="/api/inventory",     tags=["Inventory"])
app.include_router(alerts.router,                 prefix="/api/alerts",        tags=["Maintenance Alerts"])
app.include_router(tickets.router,                prefix="/api/tickets",       tags=["Maintenance Tickets"])
app.include_router(maintenance_dashboard.router,  prefix="/api/maintenance",   tags=["Maintenance Dashboard"])
app.include_router(iot.router,                    prefix="/api/iot",           tags=["IoT / Sensors"])
app.include_router(users.router,                  prefix="/api/users",         tags=["Users"])
app.include_router(kpis.router,                   prefix="/api/kpis",          tags=["KPIs"])
app.include_router(costs.router,                  prefix="/api/costs",         tags=["Costs"],                dependencies=[Depends(resource_guard("costs"))])
app.include_router(factory_calendar.router,       prefix="/api/calendar",      tags=["Factory Calendar"],     dependencies=[Depends(resource_guard("calendar"))])
app.include_router(adam_devices.router,           prefix="/api/adam-devices",  tags=["ADAM Devices"],         dependencies=[Depends(resource_guard("settings_devices"))])
app.include_router(reports.router,                prefix="/api/reports",       tags=["Reports"])
app.include_router(escalation.router,             prefix="/api/escalation",    tags=["Escalation"])
app.include_router(technicians.router,            prefix="/api/technicians",   tags=["Technicians"],          dependencies=[Depends(resource_guard("technicians"))])
app.include_router(machines.router,               prefix="/api/machines",      tags=["Machines"])
app.include_router(factory_map.router,            prefix="/api/factory-map",   tags=["Factory Map"])
app.include_router(robot_cells_router,            prefix="/api/robot-cells",   tags=["Robot Cells"])
app.include_router(stop_categories.router,        prefix="/api/stop-categories", tags=["Stop Categories"])
app.include_router(job_orders.router,             prefix="/api/job-orders",      tags=["Job Orders"])
app.include_router(suppliers_module.supplier_router, prefix="/api/suppliers",       tags=["Suppliers"])
app.include_router(suppliers_module.po_router,       prefix="/api/supplier-orders", tags=["Purchase Orders"])
app.include_router(machine_operator_router)
app.include_router(intervention_types_router)
app.include_router(safety_checklist_router)
app.include_router(wo_approval_router)
app.include_router(
    pm_template_settings_router,
    dependencies=[Depends(role_write_guard(
        UserRole.supervisor, UserRole.maintenance_director,
        UserRole.plant_manager, UserRole.director,
    ))],
)
app.include_router(intelligence_router)
app.include_router(uploads_router)
app.include_router(dashboards_router, prefix="/api/dashboards", tags=["Dashboards"])
app.include_router(live_router,       prefix="/api/live",       tags=["Live Updates"])

# Serve uploaded media (photos/videos for SOP steps). Behind nginx /api/ → backend.
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
app.mount("/api/media", StaticFiles(directory=settings.UPLOAD_DIR), name="media")


@app.get("/api/health", tags=["System"])
async def health():
    return {"status": "ok", "version": "0.1.0"}
