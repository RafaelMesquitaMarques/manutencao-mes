"""
Database models for the Foliot MES platform.
Structured for multi-plant support from the ground up.
"""
import uuid
from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, BigInteger, Float, Boolean, DateTime, Date,
    ForeignKey, Text, Enum as SAEnum, JSON, UniqueConstraint
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum

from app.db.base import Base


# ─── Enums ─────────────────────────────────────────────────────────────────────

class WorkOrderStatus(str, enum.Enum):
    open        = "open"
    in_progress = "in_progress"
    on_hold     = "on_hold"
    completed   = "completed"
    cancelled   = "cancelled"

class WorkOrderType(str, enum.Enum):
    corrective  = "corrective"
    preventive  = "preventive"
    predictive  = "predictive"
    inspection  = "inspection"
    improvement = "improvement"

class WorkOrderPriority(str, enum.Enum):
    low      = "low"
    medium   = "medium"
    high     = "high"
    critical = "critical"

class UserRole(str, enum.Enum):
    operator             = "operator"
    technician           = "technician"
    supervisor           = "supervisor"
    maintenance_director = "maintenance_director"
    plant_manager        = "plant_manager"
    director             = "director"
    admin                = "admin"


class AlertPriority(str, enum.Enum):
    low      = "low"
    medium   = "medium"
    high     = "high"
    critical = "critical"


class AlertStatus(str, enum.Enum):
    new_alert   = "new_alert"
    assigned    = "assigned"
    in_progress = "in_progress"
    resolved    = "resolved"
    cancelled   = "cancelled"


class AlertProblemType(str, enum.Enum):
    mechanical         = "mechanical"
    electrical         = "electrical"
    pneumatic          = "pneumatic"
    sensor             = "sensor"
    safety_risk        = "safety_risk"
    quality_impact     = "quality_impact"
    machine_stop       = "machine_stop"
    preventive_request = "preventive_request"
    other              = "other"


class AlertShift(str, enum.Enum):
    morning   = "morning"
    afternoon = "afternoon"
    night     = "night"


class TicketStatus(str, enum.Enum):
    open          = "open"
    in_progress   = "in_progress"
    on_hold_parts = "on_hold_parts"
    on_hold_ext   = "on_hold_ext"
    completed     = "completed"
    cancelled     = "cancelled"

class EquipmentStatus(str, enum.Enum):
    running        = "running"
    in_maintenance = "in_maintenance"
    stopped        = "stopped"
    scrapped       = "scrapped"

class MachineStatus(str, enum.Enum):
    running      = "running"
    stopped      = "stopped"        # unplanned / generic stop (red)
    maintenance  = "maintenance"
    idle         = "idle"
    planned_stop = "planned_stop"
    unjustified  = "unjustified"    # MES-detected stop, no reason entered yet (pink)
    intervention = "intervention"   # technician actively working on the machine (purple)

class StopCategoryType(str, enum.Enum):
    planned     = "planned"
    unplanned   = "unplanned"
    maintenance = "maintenance"

class OperatorShift(str, enum.Enum):
    morning   = "morning"
    afternoon = "afternoon"
    night     = "night"
    all       = "all"

class PageLanguage(str, enum.Enum):
    en = "en"
    fr = "fr"
    es = "es"

class TechnicianSpecialty(str, enum.Enum):
    electromechanical = "electromechanical"
    mechanical        = "mechanical"
    electrical        = "electrical"
    instrumentation   = "instrumentation"
    welding           = "welding"
    hydraulics        = "hydraulics"

class TechnicianShift(str, enum.Enum):
    day      = "day"
    evening  = "evening"
    night    = "night"
    rotating = "rotating"

class ShiftBreakKind(str, enum.Enum):
    """A non-working interval inside a shift. All kinds are deducted from
    effective LABOR time (never from machine downtime). `paid` is informational."""
    lunch       = "lunch"
    short_break = "break"
    pause       = "pause"

class UnavailabilityType(str, enum.Enum):
    """Why a technician is not available for labor over a period."""
    vacation    = "vacation"
    sick        = "sick"
    absence     = "absence"
    training    = "training"
    unavailable = "unavailable"
    other       = "other"

class ExecutionMode(str, enum.Enum):
    internal = "internal"
    external = "external"
    contract = "contract"

class CostTransactionType(str, enum.Enum):
    local_parts    = "local_parts"
    labor          = "labor"
    external_parts = "external_parts"
    contracts      = "contracts"
    rentals        = "rentals"
    other          = "other"

class SupplierOrderStatus(str, enum.Enum):
    pending   = "pending"
    partial   = "partial"
    received  = "received"
    cancelled = "cancelled"

class PurchaseOrderStatus(str, enum.Enum):
    draft     = "draft"
    sent      = "sent"
    confirmed = "confirmed"
    received  = "received"
    cancelled = "cancelled"

class WorkOrderSource(str, enum.Enum):
    manual = "manual"
    ticket = "ticket"
    pm     = "pm"

class HourlyRateCurrency(str, enum.Enum):
    CAD = "CAD"
    USD = "USD"
    EUR = "EUR"

class JobOrderStatus(str, enum.Enum):
    pending     = "pending"
    in_progress = "in_progress"
    completed   = "completed"
    cancelled   = "cancelled"

class JobOrderSource(str, enum.Enum):
    manual      = "manual"
    erp         = "erp"
    cortex      = "cortex"        # scanned via the Cortex label→cobot-program system
    smart_label = "smart_label"   # born when the cutting dept prints the smart label


class PmFrequency(str, enum.Enum):
    daily      = "daily"
    weekly     = "weekly"
    monthly    = "monthly"
    quarterly  = "quarterly"
    semiannual = "semiannual"
    annual     = "annual"


class RecurrenceEndType(str, enum.Enum):
    never             = "never"
    after_occurrences = "after_occurrences"
    on_date           = "on_date"


class OccurrenceStatus(str, enum.Enum):
    scheduled   = "scheduled"
    in_progress = "in_progress"
    completed   = "completed"
    skipped     = "skipped"
    cancelled   = "cancelled"


class OccurrenceCompliance(str, enum.Enum):
    on_time = "on_time"
    early   = "early"
    late    = "late"


# ─── Plant ─────────────────────────────────────────────────────────────────────

class Plant(Base):
    __tablename__ = "plants"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code       = Column(String(20), unique=True, nullable=False)
    name       = Column(String(200), nullable=False)
    address    = Column(String(500))
    timezone   = Column(String(50), default="America/Toronto")
    # Plants sharing a group_code pool their GROUP-SCOPED resources (inventory,
    # suppliers): SJ+Mirabel = 'QC' (one shared warehouse/supplier base, business
    # decision 2026-07-10). NULL = the plant is its own group — a new plant
    # (Las Vegas) is fully isolated unless explicitly grouped.
    group_code = Column(String(20), nullable=True)
    # Default currency for the plant's money fields (budgets, POs, labor rates):
    # QC plants = CAD, Las Vegas = USD.
    currency   = Column(String(3), nullable=False, default="CAD")
    floor_plan_url = Column(String(500))   # uploaded top-down plant layout image (factory map)
    # Geo location (used for the outdoor weather badge on the factory-map overview).
    latitude   = Column(Float, nullable=True)
    longitude  = Column(Float, nullable=True)
    # Cached current weather (refreshed by the _weather_loop from Open-Meteo). temp
    # stored in Celsius; weather_code is the WMO code the UI maps to an icon.
    weather_temp_c     = Column(Float, nullable=True)
    weather_code       = Column(Integer, nullable=True)
    weather_updated_at = Column(DateTime(timezone=True), nullable=True)
    active     = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    equipment = relationship("Equipment", back_populates="plant")
    users     = relationship("UserPlant", back_populates="plant")


class Department(Base):
    """Managed registry of a plant's departments (production areas / org groupings).
    The `department` STRING on Equipment/Machine/JobOrder is chosen from this list —
    it stays a string (no FK migration), this table is the source of truth for the
    pickers + the settings page. Seeded once per plant from the existing distinct
    values; curated by the user afterwards."""
    __tablename__ = "departments"
    __table_args__ = (UniqueConstraint("plant_id", "name", name="uq_departments_plant_name"),)

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id   = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False, index=True)
    name       = Column(String(200), nullable=False)
    is_active  = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


# ─── User ──────────────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id                   = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name                 = Column(String(200), nullable=False)
    nickname             = Column(String(100))   # preferred greeting name; NULL → greet by first name
    email                = Column(String(200), unique=True, nullable=False)
    password_hash        = Column(String(500), nullable=False)
    language             = Column(String(10), default="en")
    temp_unit            = Column(String(1), default="C")   # display unit for temperatures: 'C' | 'F'
    active               = Column(Boolean, default=True)
    role                 = Column(SAEnum(UserRole, native_enum=False), default=UserRole.operator)
    avatar_url           = Column(String(500))
    phone                = Column(String(50))
    job_title            = Column(String(200))
    last_login_at        = Column(DateTime(timezone=True))
    must_change_password = Column(Boolean, default=False)
    invited_by_id        = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    invited_at           = Column(DateTime(timezone=True))
    created_at           = Column(DateTime(timezone=True), server_default=func.now())

    plants               = relationship("UserPlant", back_populates="user", foreign_keys="UserPlant.user_id")
    permissions          = relationship("Permission", back_populates="user", cascade="all, delete-orphan")
    created_work_orders  = relationship("WorkOrder", back_populates="created_by",  foreign_keys="WorkOrder.created_by_id")
    assigned_work_orders = relationship("WorkOrder", back_populates="assigned_to", foreign_keys="WorkOrder.assigned_to_id")
    technician_profile   = relationship("Technician", back_populates="user", uselist=False)


class UserPlant(Base):
    """Junction table: a user can have different roles at each plant.

    THE authoritative source of plant access (multi-plant phase 0): a user may
    only operate on plants they hold a membership row for. `User.role` stays as
    the global role — `admin` means corporate (all plants); for everyone else
    the per-plant `role` here is what authorization resolves against.
    """
    __tablename__ = "user_plants"
    __table_args__ = (UniqueConstraint("user_id", "plant_id", name="uq_user_plants_user_plant"),)

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id       = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    plant_id      = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False)
    role          = Column(SAEnum(UserRole, native_enum=False), default=UserRole.technician)
    is_default    = Column(Boolean, nullable=False, default=False)
    granted_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())

    user  = relationship("User", back_populates="plants", foreign_keys=[user_id])
    plant = relationship("Plant", back_populates="users")


class Permission(Base):
    __tablename__ = "permissions"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id    = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    plant_id   = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    resource   = Column(String(100), nullable=False)
    action     = Column(String(50), nullable=False)
    granted    = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="permissions")


class UserInvitation(Base):
    __tablename__ = "user_invitations"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email         = Column(String(200), nullable=False)
    role          = Column(SAEnum(UserRole, native_enum=False), default=UserRole.operator)
    plant_id      = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    token         = Column(String(128), unique=True, nullable=False)
    invited_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    expires_at    = Column(DateTime(timezone=True), nullable=False)
    accepted_at   = Column(DateTime(timezone=True))
    created_at    = Column(DateTime(timezone=True), server_default=func.now())


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id    = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    token      = Column(String(128), unique=True, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used_at    = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ─── Equipment ─────────────────────────────────────────────────────────────────

class Equipment(Base):
    __tablename__ = "equipment"

    id                 = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id           = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False)
    code               = Column(String(50), nullable=False)
    name               = Column(String(200), nullable=False)
    description        = Column(Text)
    manufacturer       = Column(String(200))
    model              = Column(String(200))
    serial_number      = Column(String(200))
    manufacturing_year = Column(Integer)
    location           = Column(String(200))
    status             = Column(SAEnum(EquipmentStatus, native_enum=False), default=EquipmentStatus.running)
    criticality        = Column(String(20), default="medium")
    # production = has the machine/kiosk/MES layer; auxiliary = maintenance-only (generator, compressor, HVAC, conveyor…)
    asset_type         = Column(String(20), default="production")
    subtype            = Column(String(100), nullable=True)   # free-text descriptive (Generator, Compressor, HVAC…)
    parent_equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=True, index=True)  # machine a cobot/conveyor serves
    # Resizable "orbit" rectangle (map px) — drop a cobot/conveyor inside to auto-link it. Null = footprint+margin.
    orbit_x            = Column(Float, nullable=True)
    orbit_y            = Column(Float, nullable=True)
    orbit_w            = Column(Float, nullable=True)
    orbit_h            = Column(Float, nullable=True)
    function_label     = Column(String(300))   # what the machine does, e.g. "Fraiseuse à contrôle numérique [CNC grooving machine]"
    department         = Column(String(200))   # Excel "Division proposée" — org/budget grouping (level 2)
    # Default cost center (CostCenter.name) pre-selected when a work order on this
    # machine is approved. The approver can still override it per exception.
    cost_center        = Column(String(200), nullable=True)
    family             = Column(String(200))   # Excel "Famille maintenance proposée" — technical family (level 4)
    pm_strategy        = Column(String(300))   # Excel "Stratégie PM proposée"
    cleaning_priority  = Column(String(50))    # Excel "Priorité de nettoyage"
    # ── Factory map / digital-twin layout ──
    pos_x              = Column(Float, nullable=True)
    pos_y              = Column(Float, nullable=True)
    pos_w              = Column(Float, nullable=True)
    pos_h              = Column(Float, nullable=True)
    rotation_deg       = Column(Float, nullable=True)
    icon_url           = Column(String(500), nullable=True)
    model_url          = Column(String(500), nullable=True)   # uploaded .glb/.gltf 3D model
    height_3d          = Column(Float, nullable=True)         # editable 3D block height (world units)
    model_scale        = Column(Float, nullable=True)         # 3D size multiplier — X axis (defaults uniform)
    scale_y            = Column(Float, nullable=True)         # 3D size multiplier — Y axis (height)
    scale_z            = Column(Float, nullable=True)         # 3D size multiplier — Z axis (depth)
    block_kind         = Column(String(40), nullable=True)    # explicit 3D shape: 'cobot' (animated), 'box', … (null = auto)
    hour_meter         = Column(Float, default=0)
    specifications     = Column(JSON, default={})
    qr_code            = Column(Text)
    active             = Column(Boolean, default=True)
    created_at         = Column(DateTime(timezone=True), server_default=func.now())

    plant           = relationship("Plant", back_populates="equipment")
    work_orders     = relationship("WorkOrder", back_populates="equipment")
    plans           = relationship("MaintenancePlan", back_populates="equipment")
    sensor_readings = relationship("SensorReading", back_populates="equipment")
    sensors         = relationship("Sensor", back_populates="equipment")
    pm_templates    = relationship("PmTemplate", back_populates="equipment")


# ─── Work Order ────────────────────────────────────────────────────────────────

class WorkOrder(Base):
    __tablename__ = "work_orders"

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    wo_number      = Column(String(20), unique=True, nullable=False)
    equipment_id   = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=False)
    plant_id       = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from equipment/machine
    created_by_id  = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    assigned_to_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    plan_id        = Column(UUID(as_uuid=True), ForeignKey("maintenance_plans.id"), nullable=True)

    type     = Column(SAEnum(WorkOrderType, native_enum=False), nullable=False)
    priority = Column(SAEnum(WorkOrderPriority, native_enum=False), default=WorkOrderPriority.medium)
    status   = Column(SAEnum(WorkOrderStatus, native_enum=False), default=WorkOrderStatus.open)

    title             = Column(String(500), nullable=False)
    short_description = Column(String(200))
    description       = Column(Text)
    root_cause        = Column(Text)
    solution_applied  = Column(Text)
    diagnostic        = Column(Text)
    resolution        = Column(Text)

    opened_at    = Column(DateTime(timezone=True), server_default=func.now())
    due_date     = Column(DateTime(timezone=True))
    started_at   = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    close_date   = Column(Date)

    downtime_hours   = Column(Float)
    repair_hours     = Column(Float)
    estimated_hours  = Column(Float)
    downtime_minutes = Column(Integer)
    total_cost       = Column(Float)
    notes            = Column(Text)
    completion_ratio = Column(Float, default=0)
    # Checklist rigor copied from the PM template at generation: advisory | required | strict
    checklist_enforcement = Column(String(20), default="advisory")
    # Manual priority order within a technician's scheduler column (lower = higher priority)
    board_order = Column(Integer, nullable=True)

    # Execution details
    executor_id    = Column(UUID(as_uuid=True), ForeignKey("technicians.id"), nullable=True)
    execution_mode = Column(SAEnum(ExecutionMode, native_enum=False), default=ExecutionMode.internal)
    classification = Column(String(100))
    failure_code   = Column(String(50))
    component      = Column(String(200))
    tag            = Column(String(100))
    project_number = Column(String(100))
    cost_center    = Column(String(100))
    counter_open   = Column(Float)
    counter_close  = Column(Float)

    # IoT origin
    from_iot = Column(Boolean, default=False)
    alert_id = Column(UUID(as_uuid=True), ForeignKey("alerts.id"), nullable=True)

    # Ticket origin (soft reference — no FK to avoid circular dependency)
    ticket_id = Column(UUID(as_uuid=True), nullable=True)
    source    = Column(SAEnum(WorkOrderSource, native_enum=False), default=WorkOrderSource.manual)

    # PM occurrence origin
    occurrence_id = Column(
        UUID(as_uuid=True),
        ForeignKey("plan_occurrences.id", ondelete="SET NULL", use_alter=True, name="work_orders_occurrence_id_fkey"),
        nullable=True,
    )

    # Scheduler
    scheduled_date       = Column(Date, nullable=True)
    scheduled_start_time = Column(String(10), nullable=True)
    scheduled_end_time   = Column(String(10), nullable=True)

    # Machine reference (soft — parallel to equipment_id for MES machines)
    machine_id                 = Column(UUID(as_uuid=True), nullable=True)
    total_minutes              = Column(Integer, nullable=True)
    estimated_downtime_minutes = Column(Integer, nullable=True)
    actual_downtime_minutes    = Column(Integer, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # WO-level approval — supervisor / maintenance director signs off completed work
    # (mirrors MachineIntervention so office-created WOs also flow through approval).
    approval_status  = Column(String(20), default="pending")  # pending | approved | rejected
    approved_by_id   = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    approved_at      = Column(DateTime(timezone=True), nullable=True)
    approval_note    = Column(Text, nullable=True)
    rejection_reason = Column(Text, nullable=True)

    equipment       = relationship("Equipment", back_populates="work_orders")
    created_by      = relationship("User", back_populates="created_work_orders",  foreign_keys=[created_by_id])
    assigned_to     = relationship("User", back_populates="assigned_work_orders", foreign_keys=[assigned_to_id])
    executor        = relationship("Technician", back_populates="work_orders", foreign_keys=[executor_id])
    plan            = relationship("MaintenancePlan", back_populates="work_orders")
    occurrence      = relationship("PlanOccurrence", foreign_keys=[occurrence_id])
    legacy_items    = relationship("WorkOrderStockItem", back_populates="work_order")
    labor_records   = relationship("LaborRecord", back_populates="work_order", cascade="all, delete-orphan")
    wo_parts        = relationship("WOPart", back_populates="work_order", cascade="all, delete-orphan")
    wo_costs        = relationship("WOCost", back_populates="work_order", cascade="all, delete-orphan")
    wo_actions      = relationship("WOAction", back_populates="work_order", cascade="all, delete-orphan")
    supplier_orders = relationship("SupplierOrder", back_populates="work_order", cascade="all, delete-orphan")
    technician_links = relationship("WorkOrderTechnician", back_populates="work_order", cascade="all, delete-orphan")


# ─── Maintenance Plan ──────────────────────────────────────────────────────────

class MaintenancePlan(Base):
    __tablename__ = "maintenance_plans"

    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    equipment_id      = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=False)
    name              = Column(String(300), nullable=False)
    description       = Column(Text)
    trigger_type      = Column(String(20))  # calendar | hour_meter | cycles
    interval_days     = Column(Integer)
    interval_hours    = Column(Float)
    last_executed_at  = Column(DateTime(timezone=True))
    next_execution_at = Column(DateTime(timezone=True))
    active            = Column(Boolean, default=True)
    checklist         = Column(JSON, default=[])
    created_at        = Column(DateTime(timezone=True), server_default=func.now())

    # ── TPM plant / template ──
    plant_id       = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    pm_template_id = Column(UUID(as_uuid=True), ForeignKey("pm_templates.id", ondelete="SET NULL"), nullable=True)
    plan_type      = Column(String(30), default="preventive")

    # ── TPM recurrence ──
    frequency_type       = Column(SAEnum(PmFrequency, native_enum=False), nullable=True)
    frequency_value      = Column(Integer, default=1)
    frequency_days       = Column(Integer, nullable=True)
    frequency_hours      = Column(Float, nullable=True)
    weekdays             = Column(String(20), nullable=True)  # comma-separated 0=Mon..6=Sun
    start_date           = Column(Date, nullable=True)
    recurrence_end_type  = Column(SAEnum(RecurrenceEndType, native_enum=False), default=RecurrenceEndType.never)
    recurrence_end_value = Column(Integer, nullable=True)
    recurrence_end_date  = Column(Date, nullable=True)

    # ── TPM scheduling/assignment ──
    lead_time_days         = Column(Integer, default=3)
    assigned_technician_id = Column(UUID(as_uuid=True), ForeignKey("technicians.id", ondelete="SET NULL"), nullable=True)
    priority                = Column(String(20), default="medium")
    estimated_hours         = Column(Float, default=1.0)
    is_active               = Column(Boolean, default=True)
    next_due_date           = Column(Date, nullable=True)
    next_due_hours          = Column(Float, nullable=True)
    total_occurrences       = Column(Integer, default=0)
    created_by_id           = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    equipment           = relationship("Equipment", back_populates="plans")
    plant               = relationship("Plant", foreign_keys=[plant_id])
    work_orders         = relationship("WorkOrder", back_populates="plan")
    pm_template         = relationship("PmTemplate", back_populates="plans")
    assigned_technician = relationship("Technician", back_populates="assigned_maintenance_plans", foreign_keys=[assigned_technician_id])
    created_by          = relationship("User", foreign_keys=[created_by_id])
    occurrences         = relationship("PlanOccurrence", back_populates="plan", cascade="all, delete-orphan", order_by="PlanOccurrence.scheduled_date")
    recommended_parts   = relationship("PlanRecommendedPart", back_populates="plan", cascade="all, delete-orphan")


# ─── PM Templates ──────────────────────────────────────────────────────────────

class PmTemplate(Base):
    __tablename__ = "pm_templates"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id        = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    equipment_id    = Column(UUID(as_uuid=True), ForeignKey("equipment.id", ondelete="CASCADE"), nullable=False)
    frequency_type  = Column(SAEnum(PmFrequency, native_enum=False), nullable=False)
    name            = Column(String(200), nullable=False)
    description     = Column(Text, nullable=True)
    estimated_hours = Column(Float, default=1.0)
    is_active       = Column(Boolean, default=True)
    sort_order      = Column(Integer, default=0)
    # How strictly the checklist is enforced on the work order:
    # advisory (guide only) | required (must check required steps) | strict (also a proof photo)
    enforcement     = Column(String(20), default="advisory")

    plant     = relationship("Plant", foreign_keys=[plant_id])
    equipment = relationship("Equipment", back_populates="pm_templates")
    tasks     = relationship("PmTemplateTask", back_populates="template", cascade="all, delete-orphan", order_by="PmTemplateTask.sort_order")
    plans     = relationship("MaintenancePlan", back_populates="pm_template")


class PmTemplateTask(Base):
    __tablename__ = "pm_template_tasks"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    template_id     = Column(UUID(as_uuid=True), ForeignKey("pm_templates.id", ondelete="CASCADE"), nullable=False)
    description     = Column(Text, nullable=False)
    expected_result = Column(Text, nullable=True)   # what must be observed/verified for this step
    sort_order      = Column(Integer, default=0)
    is_required     = Column(Boolean, default=True)

    template = relationship("PmTemplate", back_populates="tasks")
    media    = relationship(
        "PmTaskMedia", back_populates="task",
        cascade="all, delete-orphan", order_by="PmTaskMedia.sort_order",
    )


class PmTaskMedia(Base):
    """Photo / video / external link illustrating a PM template step (SOP)."""
    __tablename__ = "pm_task_media"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id    = Column(UUID(as_uuid=True), ForeignKey("pm_template_tasks.id", ondelete="CASCADE"), nullable=False)
    media_type = Column(String(20), nullable=False)   # image | video | link
    url        = Column(String(1000), nullable=False) # served path (/api/media/..) or external URL
    caption    = Column(String(300), nullable=True)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    task = relationship("PmTemplateTask", back_populates="media")


# ─── Plan Occurrences & Recommended Parts ──────────────────────────────────────

class PlanOccurrence(Base):
    __tablename__ = "plan_occurrences"

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plan_id        = Column(UUID(as_uuid=True), ForeignKey("maintenance_plans.id", ondelete="CASCADE"), nullable=False)
    plant_id       = Column(UUID(as_uuid=True), ForeignKey("plants.id", ondelete="SET NULL"), nullable=True)
    equipment_id   = Column(UUID(as_uuid=True), ForeignKey("equipment.id", ondelete="SET NULL"), nullable=True)
    work_order_id  = Column(UUID(as_uuid=True), ForeignKey("work_orders.id", ondelete="SET NULL"), nullable=True)

    scheduled_date = Column(Date, nullable=False)
    actual_date    = Column(Date, nullable=True)

    is_overridden  = Column(Boolean, default=False)
    override_date  = Column(Date, nullable=True)
    override_note  = Column(Text, nullable=True)

    is_cancelled   = Column(Boolean, default=False)
    cancel_reason  = Column(Text, nullable=True)

    status     = Column(SAEnum(OccurrenceStatus, native_enum=False), default=OccurrenceStatus.scheduled)
    compliance = Column(SAEnum(OccurrenceCompliance, native_enum=False), nullable=True)
    days_late  = Column(Integer, nullable=True)

    reminder_sent      = Column(Boolean, default=False)
    overdue_alert_sent = Column(Boolean, default=False)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    plan       = relationship("MaintenancePlan", back_populates="occurrences")
    plant      = relationship("Plant", foreign_keys=[plant_id])
    equipment  = relationship("Equipment", foreign_keys=[equipment_id])
    work_order = relationship("WorkOrder", foreign_keys=[work_order_id])


class PlanRecommendedPart(Base):
    __tablename__ = "plan_recommended_parts"

    id                   = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plan_id              = Column(UUID(as_uuid=True), ForeignKey("maintenance_plans.id", ondelete="CASCADE"), nullable=False)
    stock_item_id        = Column(UUID(as_uuid=True), ForeignKey("stock_items.id", ondelete="SET NULL"), nullable=True)
    item_code            = Column(String(100), nullable=True)
    item_description     = Column(Text, nullable=True)
    quantity_recommended = Column(Float, default=1)
    unit                 = Column(String(50), nullable=True)

    plan       = relationship("MaintenancePlan", back_populates="recommended_parts")
    stock_item = relationship("StockItem")


# ─── Inventory ─────────────────────────────────────────────────────────────────

class Supplier(Base):
    __tablename__ = "suppliers"

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # NULL = shared/corporate supplier (per-plant vs shared is an open business decision)
    plant_id       = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    code           = Column(String(50),  nullable=True)
    name           = Column(String(300), nullable=False)
    contact_name   = Column(String(200), nullable=True)
    email          = Column(String(200), nullable=True)
    phone          = Column(String(100), nullable=True)
    fax            = Column(String(100), nullable=True)
    website        = Column(String(300), nullable=True)
    address        = Column(Text,        nullable=True)
    city           = Column(String(100), nullable=True)
    country        = Column(String(100), nullable=True)
    category       = Column(String(100), nullable=True)
    payment_terms  = Column(String(100), nullable=True)
    currency       = Column(String(10),  default="CAD")
    lead_time_days = Column(Integer,     nullable=True)
    rating         = Column(Integer,     nullable=True)
    notes          = Column(Text,        nullable=True)
    is_active      = Column(Boolean,     default=True)
    created_at     = Column(DateTime(timezone=True), server_default=func.now())
    updated_at     = Column(DateTime(timezone=True), onupdate=func.now())

    purchase_orders = relationship("PurchaseOrder", back_populates="supplier")


class StockItem(Base):
    __tablename__ = "stock_items"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id     = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    code         = Column(String(100))
    name         = Column(String(300), nullable=True)
    description  = Column(Text)
    category     = Column(String(200), nullable=True)
    part_class   = Column(String(200), nullable=True)
    unit         = Column(String(50),  default="Unitaire")
    quantity     = Column(Float, default=0)
    min_quantity = Column(Float, nullable=True)
    unit_cost    = Column(Float)                      # standard cost (manual) — used to value WO/ticket consumption
    average_cost       = Column(Float, nullable=True) # weighted average of all received purchases
    last_purchase_cost = Column(Float, nullable=True) # unit cost of the most recent receipt
    last_purchase_date = Column(Date,  nullable=True) # date of that most recent receipt
    warehouse    = Column(String(100), nullable=True)
    location     = Column(String(200))
    supplier_id  = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=True)
    supplier     = Column(String(300))
    supplier_code      = Column(String(100), nullable=True)
    interal_product_id = Column(String(50),  nullable=True)
    notes        = Column(Text, nullable=True)
    created_at   = Column(DateTime(timezone=True), server_default=func.now())

    work_order_items = relationship("WorkOrderStockItem", back_populates="stock_item")
    movements        = relationship("InventoryMovement", back_populates="stock_item")
    supplier_ref     = relationship("Supplier", foreign_keys=[supplier_id])


class WorkOrderStockItem(Base):
    """Legacy: stock items consumed in a work order (superseded by WOPart)."""
    __tablename__ = "work_order_stock_items"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    work_order_id = Column(UUID(as_uuid=True), ForeignKey("work_orders.id"), nullable=False)
    stock_item_id = Column(UUID(as_uuid=True), ForeignKey("stock_items.id"), nullable=False)
    quantity      = Column(Float, nullable=False)
    unit_cost     = Column(Float)

    work_order = relationship("WorkOrder", back_populates="legacy_items")
    stock_item = relationship("StockItem", back_populates="work_order_items")


# ─── IoT / Sensors ─────────────────────────────────────────────────────────────

class Sensor(Base):
    """Physical sensor installed on a piece of equipment."""
    __tablename__ = "sensors"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=False)
    plant_id     = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from equipment
    code         = Column(String(100), nullable=False)  # MQTT topic identifier
    name         = Column(String(200))
    type         = Column(String(50))   # vibration | temperature | current | pressure
    unit         = Column(String(20))   # mm/s | °C | A | bar
    min_limit    = Column(Float)
    max_limit    = Column(Float)
    active       = Column(Boolean, default=True)
    created_at   = Column(DateTime(timezone=True), server_default=func.now())

    equipment = relationship("Equipment", back_populates="sensors")
    readings  = relationship("SensorReading", back_populates="sensor")


class SensorReading(Base):
    """
    Time-series sensor readings.
    TimescaleDB creates a hypertable on this table via init_db.sql.
    """
    __tablename__ = "sensor_readings"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sensor_id    = Column(UUID(as_uuid=True), ForeignKey("sensors.id"), nullable=False)
    equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=False)
    timestamp    = Column(DateTime(timezone=True), nullable=False, index=True)
    value        = Column(Float, nullable=False)
    quality      = Column(String(10), default="ok")  # ok | error | estimated

    sensor    = relationship("Sensor", back_populates="readings")
    equipment = relationship("Equipment", back_populates="sensor_readings")


class Alert(Base):
    __tablename__ = "alerts"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sensor_id     = Column(UUID(as_uuid=True), ForeignKey("sensors.id"), nullable=False)
    equipment_id  = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=False)
    plant_id      = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from equipment
    type          = Column(String(50))
    severity      = Column(String(20))
    value_read    = Column(Float)
    limit_value   = Column(Float)
    message       = Column(Text)
    acknowledged  = Column(Boolean, default=False)
    work_order_id = Column(UUID(as_uuid=True), nullable=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())


# ─── Technician ────────────────────────────────────────────────────────────────

class Technician(Base):
    __tablename__ = "technicians"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id         = Column(UUID(as_uuid=True), ForeignKey("users.id"), unique=True, nullable=False)
    employee_number = Column(String(50), unique=True)
    specialty       = Column(SAEnum(TechnicianSpecialty, native_enum=False))
    shift           = Column(SAEnum(TechnicianShift, native_enum=False))
    hourly_rate     = Column(Float)
    certifications  = Column(JSON, default=[])
    active          = Column(Boolean, default=True)
    created_at      = Column(DateTime(timezone=True), server_default=func.now())

    user          = relationship("User", back_populates="technician_profile")
    work_orders   = relationship("WorkOrder", back_populates="executor", foreign_keys="WorkOrder.executor_id")
    labor_records = relationship("LaborRecord", back_populates="technician")
    assigned_maintenance_plans = relationship("MaintenancePlan", back_populates="assigned_technician", foreign_keys="MaintenancePlan.assigned_technician_id")
    work_order_links = relationship("WorkOrderTechnician", back_populates="technician", cascade="all, delete-orphan")
    unavailability   = relationship("TechnicianUnavailability", back_populates="technician", cascade="all, delete-orphan")


class WorkOrderTechnician(Base):
    """Many-to-many: technicians assigned to a work order.

    `executor_id` on WorkOrder remains the primary technician (mirrors the
    is_primary row) for backward compatibility with single-technician flows.
    """
    __tablename__ = "work_order_technicians"

    work_order_id = Column(UUID(as_uuid=True), ForeignKey("work_orders.id", ondelete="CASCADE"), primary_key=True)
    technician_id = Column(UUID(as_uuid=True), ForeignKey("technicians.id", ondelete="CASCADE"), primary_key=True)
    is_primary    = Column(Boolean, default=False)
    assigned_at   = Column(DateTime(timezone=True), server_default=func.now())

    work_order = relationship("WorkOrder", back_populates="technician_links")
    technician = relationship("Technician", back_populates="work_order_links")


# ─── Labor Record ──────────────────────────────────────────────────────────────

class LaborRecord(Base):
    __tablename__ = "labor_records"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    work_order_id = Column(UUID(as_uuid=True), ForeignKey("work_orders.id"), nullable=False)
    technician_id = Column(UUID(as_uuid=True), ForeignKey("technicians.id"), nullable=False)
    date          = Column(Date, nullable=False)
    hours_worked  = Column(Float, nullable=False, default=0.0)
    hourly_rate   = Column(Float)
    labor_cost    = Column(Float)
    activity      = Column(String(500))
    notes         = Column(Text)
    started_at    = Column(DateTime(timezone=True), nullable=True)
    stopped_at    = Column(DateTime(timezone=True), nullable=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())
    # ── Effective-labor accounting (Phase 1) ─────────────────────────────────
    # hours_worked stays RAW (feeds repair_hours / MTTR — never reduced by breaks).
    # effective_hours = hours_worked minus overlapping non-working intervals
    # (off-shift unless overtime_approved, lunch, breaks, vacation/unavailability)
    # and is what drives labor_cost. deducted_minutes is kept for UI/audit.
    effective_hours   = Column(Float, nullable=True)
    overtime_approved = Column(Boolean, nullable=False, default=False)
    deducted_minutes  = Column(Float, nullable=True)

    work_order = relationship("WorkOrder", back_populates="labor_records")
    technician = relationship("Technician", back_populates="labor_records")


# ─── Shift templates, breaks & technician availability ───────────────────────────

class ShiftTemplate(Base):
    """A named work shift with clock times and break rules, used to compute
    effective LABOR time and technician availability. A technician is matched to
    a template by `key` == Technician.shift value (day|evening|night|rotating),
    optionally scoped to a plant. Times are plant-local wall clock "HH:MM";
    end <= start means the shift runs past midnight (overnight)."""
    __tablename__ = "shift_templates"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id   = Column(UUID(as_uuid=True), ForeignKey("plants.id", ondelete="CASCADE"), nullable=True)
    key        = Column(String(50), nullable=False)   # matches TechnicianShift value or custom
    name       = Column(String(200), nullable=False, default="")
    start_time = Column(String(5), nullable=False)     # "HH:MM"
    end_time   = Column(String(5), nullable=False)     # "HH:MM"
    active     = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    breaks = relationship(
        "ShiftBreak", back_populates="template",
        cascade="all, delete-orphan", order_by="ShiftBreak.start_time",
    )


class ShiftBreak(Base):
    """A non-working interval inside a shift (lunch, break, pause). Every
    configured break is deducted from effective LABOR time — never from machine
    downtime, ticket duration, or MTTR. `paid` is informational only. Times are
    plant-local wall clock "HH:MM"."""
    __tablename__ = "shift_breaks"

    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    shift_template_id = Column(UUID(as_uuid=True), ForeignKey("shift_templates.id", ondelete="CASCADE"), nullable=False)
    # values_callable → persist/read the enum VALUE ("break") not the member name
    # ("short_break"), matching the seed data and the API schema.
    kind              = Column(SAEnum(ShiftBreakKind, native_enum=False, values_callable=lambda e: [m.value for m in e]), nullable=False, default=ShiftBreakKind.short_break)
    name              = Column(String(200), nullable=False, default="")
    start_time        = Column(String(5), nullable=False)   # "HH:MM"
    end_time          = Column(String(5), nullable=False)   # "HH:MM"
    paid              = Column(Boolean, nullable=False, default=False)
    created_at        = Column(DateTime(timezone=True), server_default=func.now())

    template = relationship("ShiftTemplate", back_populates="breaks")


class TechnicianUnavailability(Base):
    """A period when a technician is not available for labor: vacation, sick,
    absence, training, or a generic unavailable window. Day-granular, inclusive
    [start_date, end_date]. Overlap with a labor record is excluded from effective
    labor time, and the period flags the technician unavailable for assignment and
    capacity planning. Never alters machine downtime or MTTR."""
    __tablename__ = "technician_unavailability"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    technician_id = Column(UUID(as_uuid=True), ForeignKey("technicians.id", ondelete="CASCADE"), nullable=False)
    type          = Column(SAEnum(UnavailabilityType, native_enum=False, values_callable=lambda e: [m.value for m in e]), nullable=False, default=UnavailabilityType.vacation)
    start_date    = Column(Date, nullable=False)
    end_date      = Column(Date, nullable=False)
    notes         = Column(Text)
    created_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())

    technician = relationship("Technician", back_populates="unavailability")


class TechnicianBreak(Base):
    """A break a technician ANNOUNCES in real time from "My Work" — ground truth
    for presence, distinct from the SCHEDULED breaks in ``shift_breaks``.

    An open row (``ended_at`` IS NULL) means the technician is *actually* on break
    right now, so the roster/scheduler can tell a real pause apart from one that
    was postponed to finish a job. This drives the live availability status ONLY;
    it never alters labor cost, effective time, machine downtime, or MTTR
    (scheduled ``shift_breaks`` handle payroll). A row left open longer than the
    service's abandon window is treated as forgotten (the technician never clocked
    back in) and no longer counts as on break."""
    __tablename__ = "technician_breaks"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    technician_id = Column(UUID(as_uuid=True), ForeignKey("technicians.id", ondelete="CASCADE"), nullable=False, index=True)
    kind          = Column(SAEnum(ShiftBreakKind, native_enum=False, values_callable=lambda e: [m.value for m in e]), nullable=False, default=ShiftBreakKind.short_break)
    started_at    = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ended_at      = Column(DateTime(timezone=True), nullable=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())


# ─── WO Parts ──────────────────────────────────────────────────────────────────

class WOPart(Base):
    __tablename__ = "wo_parts"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    work_order_id = Column(UUID(as_uuid=True), ForeignKey("work_orders.id"), nullable=False)
    stock_item_id = Column(UUID(as_uuid=True), ForeignKey("stock_items.id"), nullable=True)
    part_number   = Column(String(100))
    description   = Column(String(500), nullable=False)
    quantity      = Column(Float, nullable=False)
    unit          = Column(String(20), default="un")
    unit_cost     = Column(Float)
    total_cost    = Column(Float)
    supplier      = Column(String(300))
    notes         = Column(Text)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())

    work_order = relationship("WorkOrder", back_populates="wo_parts")
    stock_item = relationship("StockItem")


# ─── WO Costs ──────────────────────────────────────────────────────────────────

class WOCost(Base):
    __tablename__ = "wo_costs"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    work_order_id    = Column(UUID(as_uuid=True), ForeignKey("work_orders.id"), nullable=False)
    transaction_type = Column(SAEnum(CostTransactionType, native_enum=False), nullable=False)
    description      = Column(String(500), nullable=False)
    amount           = Column(Float, nullable=False)
    currency         = Column(String(10), default="CAD")
    reference        = Column(String(200))
    date             = Column(Date, nullable=False)
    notes            = Column(Text)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())

    work_order = relationship("WorkOrder", back_populates="wo_costs")


# ─── WO Actions ────────────────────────────────────────────────────────────────

class WOAction(Base):
    __tablename__ = "wo_actions"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    work_order_id = Column(UUID(as_uuid=True), ForeignKey("work_orders.id"), nullable=False)
    author_id     = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    action_type   = Column(String(50), nullable=False)
    content       = Column(Text)
    old_value     = Column(String(200))
    new_value     = Column(String(200))
    created_at    = Column(DateTime(timezone=True), server_default=func.now())

    # ── PM checklist ──
    description      = Column(Text, nullable=True)
    expected_result  = Column(Text, nullable=True)            # copied from the template step
    template_task_id = Column(UUID(as_uuid=True), nullable=True)  # soft ref → live SOP media
    proof_photo_url  = Column(String(1000), nullable=True)    # technician's evidence (strict mode)
    is_required     = Column(Boolean, default=True)
    is_completed    = Column(Boolean, default=False)
    completed_at    = Column(DateTime(timezone=True), nullable=True)
    completed_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    sort_order      = Column(Integer, default=0)

    work_order   = relationship("WorkOrder", back_populates="wo_actions")
    author       = relationship("User", foreign_keys=[author_id])
    completed_by = relationship("User", foreign_keys=[completed_by_id])


# ─── Supplier Orders ───────────────────────────────────────────────────────────

class SupplierOrder(Base):
    __tablename__ = "supplier_orders"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    work_order_id = Column(UUID(as_uuid=True), ForeignKey("work_orders.id"), nullable=True)
    supplier_name = Column(String(300), nullable=False)
    po_number     = Column(String(100))
    description   = Column(Text)
    amount        = Column(Float)
    currency      = Column(String(10), default="CAD")
    status        = Column(SAEnum(SupplierOrderStatus, native_enum=False), default=SupplierOrderStatus.pending)
    ordered_at    = Column(Date)
    expected_at   = Column(Date)
    received_at   = Column(Date)
    notes         = Column(Text)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())

    work_order = relationship("WorkOrder", back_populates="supplier_orders")


# ─── Maintenance Alerts & Tickets ──────────────────────────────────────────────

class Machine(Base):
    __tablename__ = "machines"

    id                       = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name                     = Column(String(200), nullable=False)
    code                     = Column(String(50), unique=True, nullable=True)
    serial_number            = Column(String(200), nullable=True)
    equipment_id             = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=True)
    department               = Column(String(200))
    location                 = Column(String(200))
    is_active                = Column(Boolean, default=True)
    current_status           = Column(SAEnum(MachineStatus, native_enum=False), default=MachineStatus.running)
    current_operator         = Column(String(200), nullable=True)
    current_operator_id      = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    current_shift            = Column(SAEnum(AlertShift, native_enum=False), nullable=True)
    current_job_number       = Column(String(100), nullable=True)
    last_maintenance_at      = Column(DateTime(timezone=True), nullable=True)
    last_stop_at             = Column(DateTime(timezone=True), nullable=True)
    last_start_at            = Column(DateTime(timezone=True), nullable=True)
    page_slug                = Column(String(200), unique=True, nullable=True)
    page_language            = Column(SAEnum(PageLanguage, native_enum=False), default=PageLanguage.fr)
    target_availability_pct  = Column(Float, default=70.0)
    target_count             = Column(Integer, nullable=True)
    show_production_panel    = Column(Boolean, default=True)
    show_reject_panel        = Column(Boolean, default=True)
    show_availability_gauge  = Column(Boolean, default=True)
    show_job_number          = Column(Boolean, default=True)
    custom_color             = Column(String(20), nullable=True)
    display_name             = Column(String(200), nullable=True)
    hourly_rate              = Column(Float, nullable=True)
    hourly_rate_currency     = Column(SAEnum(HourlyRateCurrency, native_enum=False), default=HourlyRateCurrency.CAD)
    target_count_per_shift   = Column(Integer, nullable=True)
    target_count_per_hour    = Column(Integer, nullable=True)   # master production goal; per-shift & daily are derived from it
    shifts_config            = Column(JSON, nullable=True)   # DERIVED: only the ENABLED shift windows ({key:{start,end}}) — what the whole system reads
    # Full shift grid the UI edits ({key:{start,end,enabled}}, keys morning/afternoon/
    # night) — the source of truth for line shifts. shifts_config above is derived from
    # the enabled ones so every existing consumer keeps seeing only active windows.
    shift_schedule           = Column(JSON, nullable=True)
    # Scheduled pauses inside the work window ([{start:"HH:MM", end:"HH:MM"}, …]) —
    # the assembly-line evolving objective (TV Standard) discounts them, mirroring
    # the Cortex "horloges" config (cadence + window + pauses per line).
    work_pauses              = Column(JSON, nullable=True)
    kiosk_layout             = Column(JSON, nullable=True)   # per-machine resizable panel layout (react-grid-layout)
    signal_ingest_token      = Column(String(120), nullable=True)   # ADAM-6050 production-signal ingest (per machine)
    # ── Factory map / digital-twin layout ──
    plant_id                 = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    # Kiosk access token (phase 4): tablets open /machines/:slug?k=<token>; the
    # kiosk endpoints require it once KIOSK_ENFORCE_TOKEN is on.
    kiosk_token              = Column(String(120), nullable=True)
    pos_x                    = Column(Float, nullable=True)   # top-down map coordinates
    pos_y                    = Column(Float, nullable=True)
    pos_w                    = Column(Float, nullable=True)   # block size on the map
    pos_h                    = Column(Float, nullable=True)
    rotation_deg             = Column(Float, nullable=True)
    icon_url                 = Column(String(500), nullable=True)  # machine photo / icon
    created_at               = Column(DateTime(timezone=True), server_default=func.now())

    equipment          = relationship("Equipment", foreign_keys=[equipment_id])
    alerts             = relationship("MaintenanceAlert", back_populates="machine")
    tickets            = relationship("MaintenanceTicket", back_populates="machine")
    stops              = relationship("MachineStop", back_populates="machine", cascade="all, delete-orphan")
    operators          = relationship("MachineOperator", back_populates="machine", cascade="all, delete-orphan")
    production_logs    = relationship("MachineProductionLog", back_populates="machine", cascade="all, delete-orphan")
    stop_categories    = relationship("StopCategory", back_populates="machine", cascade="all, delete-orphan", foreign_keys="StopCategory.machine_id")
    reject_categories  = relationship("RejectCategory", back_populates="machine", cascade="all, delete-orphan")


# ─── Production I/O devices (Advantech ADAM gateway) ───────────────────────────

class AdamModel(str, enum.Enum):
    adam_6050 = "6050"
    adam_6051 = "6051"

class AdamSignalSource(str, enum.Enum):
    di      = "di"        # software edge-count on a discrete-input channel
    counter = "counter"   # ADAM 32-bit hardware counter register (no missed pulses)
    state   = "state"     # DI LEVEL = running/stopped (conveyor motor contact) — no part counting

class AdamActiveLevel(str, enum.Enum):
    low  = "low"          # idle=1, pulse pulls the line to 0 (bench button on DI0)
    high = "high"

class AdamDeviceStatus(str, enum.Enum):
    unknown = "unknown"   # never polled yet
    online  = "online"    # last poll succeeded
    offline = "offline"   # last poll could not reach the device
    error   = "error"     # reached the device but the read failed


class AdamDevice(Base):
    """An Advantech ADAM I/O module wired to a production machine.

    The central gateway (app.workers.adam_gateway) polls every enabled device
    over Modbus/TCP and pushes readings to the linked machine's production-signal
    / production-count endpoints, authenticated with the machine's
    signal_ingest_token. This row is the single source of truth for a device's
    config — edit it in the UI and the gateway picks it up on its next reload.
    The health fields (status/last_seen_at/last_error) are written by the gateway."""
    __tablename__ = "adam_devices"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name             = Column(String(200), nullable=False)
    model            = Column(SAEnum(AdamModel, native_enum=False), default=AdamModel.adam_6051)
    ip_address       = Column(String(64), nullable=False)
    port             = Column(Integer, default=502)
    machine_id       = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    plant_id         = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    enabled          = Column(Boolean, default=True)
    # Pulse source + wiring
    signal_source    = Column(SAEnum(AdamSignalSource, native_enum=False), default=AdamSignalSource.di)
    channel          = Column(Integer, default=0)        # DI channel (signal_source=di)
    active_level     = Column(SAEnum(AdamActiveLevel, native_enum=False), default=AdamActiveLevel.low)
    counter_reg      = Column(Integer, default=0)        # input-register addr (signal_source=counter)
    idle_timeout_s   = Column(Integer, default=15)       # seconds without a pulse → "not producing"
    poll_interval_ms = Column(Integer, default=100)
    # Health (written by the gateway)
    status           = Column(SAEnum(AdamDeviceStatus, native_enum=False), default=AdamDeviceStatus.unknown)
    last_seen_at     = Column(DateTime(timezone=True), nullable=True)
    last_error       = Column(String(500), nullable=True)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())
    updated_at       = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    machine          = relationship("Machine")


class CortexStation(Base):
    """A Cortex barcode-reading station at the END of an assembly line. KAIZO PULLS
    new scans from the Cortex API (app.workers.cortex_poller) — each row maps one
    Cortex station to the KAIZO machine (the line) whose finished units it reads;
    every scan lands on that machine's /of-unit-scan endpoint (+1 unit on the
    labelled OF + shift/hourly production). `station_key` identifies the station in
    the Cortex API; `last_cursor` is the poller's high-water mark (last scan already
    ingested), persisted so a restart never double-counts. Health fields (status /
    last_seen_at / last_error — same lifecycle as AdamDevice) are written by the
    poller. Config edits in /settings/devices are picked up on the next reload."""
    __tablename__ = "cortex_stations"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name            = Column(String(200), nullable=False)
    station_key     = Column(String(200), nullable=False)   # station id in the Cortex API
    machine_id      = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    plant_id        = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    enabled         = Column(Boolean, default=True)
    poll_interval_s = Column(Integer, default=5)
    last_cursor     = Column(String(200), nullable=True)
    # Health (written by the poller)
    status          = Column(SAEnum(AdamDeviceStatus, native_enum=False), default=AdamDeviceStatus.unknown)
    last_seen_at    = Column(DateTime(timezone=True), nullable=True)
    last_error      = Column(String(500), nullable=True)
    created_at      = Column(DateTime(timezone=True), server_default=func.now())
    updated_at      = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    machine         = relationship("Machine")


class TemperatureSource(str, enum.Enum):
    simulated   = "simulated"    # value generated by the _temperature_loop (no hardware yet)
    adam_analog = "adam_analog"  # future: ADAM analog-input module read over Modbus/TCP
    http        = "http"         # future: sensor/PLC POSTs readings to an ingest endpoint


class TemperatureSensor(Base):
    """A temperature probe placed freely on the factory map (its own pixel-space
    position, like a MapProp). Rendered in the 3D twin as a little thermometer and
    drives the map's temperature badge — the sensor nearest the camera shows its
    indoor reading; away from any sensor the badge falls back to outdoor weather.

    Reading source is pluggable via `source`: today every sensor is `simulated`
    (the in-process _temperature_loop writes last_value_c), and the real Modbus/HTTP
    paths slot in later behind the same row. Value is stored in Celsius; the UI
    converts to the viewer's preferred unit. Config lives in /settings/devices and
    writes are gated by the `settings_devices` resource guard (same as adam_devices)."""
    __tablename__ = "temperature_sensors"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id     = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False, index=True)
    name         = Column(String(200), nullable=False)
    # Binds the sensor to a plant department (registry name). The map badge shows a
    # department's own sensor — a sensor anchors its department, so machineless
    # departments (no machines to anchor them) still resolve correctly.
    department   = Column(String(200), nullable=True)
    enabled      = Column(Boolean, default=True)
    # Free position on the map (same pixel space as equipment/props → converted to 3D).
    pos_x        = Column(Float, default=0)
    pos_y        = Column(Float, default=0)
    height_3d    = Column(Float, nullable=True)   # optional mount height of the 3D thermometer
    source       = Column(SAEnum(TemperatureSource, native_enum=False), default=TemperatureSource.simulated)
    # Simulation params (source=simulated): value oscillates around baseline ± amplitude.
    sim_baseline_c = Column(Float, default=21.0)
    sim_amplitude_c = Column(Float, default=2.0)
    # Hardware config for the future real paths (nullable; ignored while simulated).
    ip_address   = Column(String(64), nullable=True)
    port         = Column(Integer, nullable=True)
    register     = Column(Integer, nullable=True)   # Modbus input-register address
    scale        = Column(Float, nullable=True)     # raw → °C linear scale
    offset       = Column(Float, nullable=True)     # raw → °C linear offset
    # Latest reading + health (written by the reading loop).
    last_value_c    = Column(Float, nullable=True)
    last_reading_at = Column(DateTime(timezone=True), nullable=True)
    status          = Column(SAEnum(AdamDeviceStatus, native_enum=False), default=AdamDeviceStatus.unknown)
    last_error      = Column(String(500), nullable=True)
    created_at      = Column(DateTime(timezone=True), server_default=func.now())
    updated_at      = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    plant           = relationship("Plant")


class SushiSensorModel(str, enum.Enum):
    xs770a = "xs770a"   # wireless vibration sensor (vibration + surface temperature, integrated)
    xs530  = "xs530"    # XS110A wireless comm module + XS530 pressure measurement module
    xs550  = "xs550"    # XS110A wireless comm module + XS550 temperature measurement module


class SushiDevice(Base):
    """A Yokogawa Sushi Sensor — battery-powered LoRaWAN condition-monitoring
    device bound to a piece of `equipment` (NOT `machines`: readings feed the
    asset-health side, like the legacy MQTT sensors).

    Data path: sensor →(LoRaWAN)→ gateway → network server (ChirpStack / TTN /
    embedded NS) →(HTTP integration)→ POST /api/sushi/uplink, authenticated by
    the deployment-wide SUSHI_INGEST_TOKEN (X-Ingest-Token header). The row is
    matched by `dev_eui`; unknown EUIs are rejected (fail closed — register the
    device here first). Decoded measurements land as `Sensor`/`SensorReading`
    rows (codes SUSHI-{EUI}-{VEL|ACC|TEMP|PRESS}[-axis]) so they ride the
    existing hypertable; threshold crossings write `Alert` rows.

    Health fields (battery/RSSI/diag/…) are written by the ingest path from the
    sensor's own HRI (0x40) / DIAG (0x41) frames and radio metadata. Thresholds
    are evaluated backend-side on every measurement uplink; NULL disables a
    threshold. Payload contract: docs/sushi-sensor-contract.md."""
    __tablename__ = "sushi_devices"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id      = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True, index=True)  # backfilled from equipment
    name          = Column(String(200), nullable=False)
    # LoRaWAN DevEUI (EUI-64), stored as 16 uppercase hex chars, no separators.
    dev_eui       = Column(String(16), nullable=False, unique=True, index=True)
    model         = Column(SAEnum(SushiSensorModel, native_enum=False), default=SushiSensorModel.xs770a)
    equipment_id  = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=True)
    enabled       = Column(Boolean, default=True)
    # The sensor's configured update period (set via the Sushi Sensor NFC app).
    # Drives staleness: no uplink for >2.5 periods → stale, >6 → offline.
    update_period_min = Column(Integer, default=60)
    # Alarm thresholds (NULL = not evaluated). Vibration defaults follow the
    # ISO 10816-3 group-2 flexible-support zone boundaries (B→C 4.5, C→D 7.1 mm/s).
    vel_warn_mms  = Column(Float, nullable=True, default=4.5)   # velocity RMS warning (mm/s)
    vel_crit_mms  = Column(Float, nullable=True, default=7.1)   # velocity RMS critical (mm/s)
    acc_warn_ms2  = Column(Float, nullable=True)                # acceleration peak warning (m/s²)
    acc_crit_ms2  = Column(Float, nullable=True)                # acceleration peak critical (m/s²)
    temp_warn_c   = Column(Float, nullable=True)                # surface temperature warning (°C)
    temp_crit_c   = Column(Float, nullable=True)                # surface temperature critical (°C)
    press_min_mpa = Column(Float, nullable=True)                # pressure low bound (MPa)
    press_max_mpa = Column(Float, nullable=True)                # pressure high bound (MPa)
    # Health — written by the ingest path.
    last_uplink_at  = Column(DateTime(timezone=True), nullable=True)
    last_data_type  = Column(String(4), nullable=True)          # last frame type, e.g. "0x11"
    battery_pct     = Column(Float, nullable=True)              # from HRI (device-estimated)
    rssi_dbm        = Column(Float, nullable=True)              # radio metadata (gateway side) or HRI
    snr_db          = Column(Float, nullable=True)
    per_pct         = Column(Float, nullable=True)              # packet error rate, from HRI
    uptime_min      = Column(Integer, nullable=True)            # from HRI
    diag_status     = Column(BigInteger, nullable=True)         # NAMUR NE107 word (0x41), UINT32
    diag_detail     = Column(BigInteger, nullable=True)
    tag_name        = Column(String(20), nullable=True)         # device tag from INI frame (0x42)
    dev_type        = Column(Integer, nullable=True)            # 0x47: 2=vibration, 3=temp module, 5=pressure module
    dev_rev         = Column(Integer, nullable=True)
    latitude        = Column(Float, nullable=True)              # GPS frames (0x43–0x45)
    longitude       = Column(Float, nullable=True)
    last_error      = Column(String(500), nullable=True)
    created_at      = Column(DateTime(timezone=True), server_default=func.now())
    updated_at      = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    equipment       = relationship("Equipment")


class LineTvSettings(Base):
    """Per-plant config for the assembly-line TVs, edited on
    /settings/line-objectives (the clocks config page):
    - efficiency-colour thresholds (green ≥ green_from, amber ≥ amber_from, red
      below) — every line TV's efficiency cell + the global TV's header bar;
    - the GLOBAL clock's OWN objective (cadence/window/pauses) — like the Cortex
      "QS - Global" clock, INDEPENDENT of the per-line objectives. The global
      Réel stays the measured Σ of the lines; only its Standard comes from here
      (falls back to Σ of the line standards while unconfigured)."""
    __tablename__ = "line_tv_settings"

    id                      = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id                = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False, unique=True, index=True)
    green_from              = Column(Float, default=95.0)
    amber_from              = Column(Float, default=80.0)
    global_cadence_per_hour = Column(Integer, nullable=True)
    global_work_start       = Column(String(10), nullable=True)   # "HH:MM"
    global_work_end         = Column(String(10), nullable=True)
    global_pauses           = Column(JSON, nullable=True)         # [{start, end}, …]
    updated_at              = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FactoryZone(Base):
    """A labelled rectangular area on the factory map (e.g. Parallèle, Assemblage)."""
    __tablename__ = "factory_zones"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id   = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False)
    name       = Column(String(200), nullable=False, default="Zone")
    pos_x      = Column(Float, default=0)
    pos_y      = Column(Float, default=0)
    pos_w      = Column(Float, default=300)
    pos_h      = Column(Float, default=200)
    color      = Column(String(20), default="#6366f1")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class MapProp(Base):
    """A decorative, non-tracked block on the factory map (conveyor, lift table, …).
    Visual context only — NOT an asset, so no status/tickets. Geometry mirrors
    equipment (same pos_x/pos_y pixel space → converted to 3D by the same scale)."""
    __tablename__ = "map_props"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id     = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False, index=True)
    equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=True, index=True)  # optional live link
    # A conveyor can be tied to a kiosk machine as its IN/OUT feed: clicking it on the
    # map opens that machine's OFs (Ordres de fabrication). role = input | output.
    machine_id   = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True, index=True)
    role         = Column(String(10), nullable=True)   # input | output (conveyor feed direction)
    kind         = Column(String(40), nullable=False, default="box")   # catalog key: conveyor, lift_table, …
    label        = Column(String(200), nullable=True)
    model_url    = Column(String(500), nullable=True)   # uploaded .glb override (else procedural placeholder)
    pos_x        = Column(Float, default=0)
    pos_y        = Column(Float, default=0)
    pos_w        = Column(Float, default=120)
    pos_h        = Column(Float, default=120)
    rotation_deg = Column(Float, default=0)
    model_scale  = Column(Float, nullable=True)
    scale_y      = Column(Float, nullable=True)
    scale_z      = Column(Float, nullable=True)
    height_3d    = Column(Float, nullable=True)
    created_at   = Column(DateTime(timezone=True), server_default=func.now())


class FactoryView(Base):
    """A user-saved 3D camera viewpoint on the factory map (e.g. "Edge line",
    "Overview") — the operator orbits/zooms to a spot and saves it by name; a
    click flies the camera back to it.

    Stored center-independently so a saved view doesn't drift when machines are
    added/moved (which shifts the scene centroid): the look-at point is kept in
    MAP PIXEL space (same convention as equipment pos_x/pos_y), and the camera is
    kept as an OFFSET vector (camera − target) in world units. On apply the target
    pixel is re-projected with the current centroid and the camera = target + offset."""
    __tablename__ = "factory_views"

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id    = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False, index=True)
    name        = Column(String(120), nullable=False, default="View")
    # When set, this view is a department's custom camera pose (overrides that
    # department's auto bounding-box frame). NULL → a free, user-named view.
    department  = Column(String(120), nullable=True, index=True)
    target_px_x = Column(Float, nullable=False, default=0)   # look-at point, map pixel X
    target_px_y = Column(Float, nullable=False, default=0)   # look-at point, map pixel Y
    target_y    = Column(Float, nullable=False, default=0)   # look-at height, world units (usually ~0, floor)
    offset_x    = Column(Float, nullable=False, default=40)  # camera − target, world units
    offset_y    = Column(Float, nullable=False, default=45)
    offset_z    = Column(Float, nullable=False, default=55)
    sort_order  = Column(Integer, default=0)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())


class HomeMapFavorite(Base):
    """Which saved 3D view each user wants as the landing shot in the Home-page
    factory overview, per plant (absent → automatic top-down). Kept in its own
    table — not on user_plants — so corporate admins (who hold no membership row)
    can set a favourite too. Cascade-deleted with the view it points at."""
    __tablename__ = "home_map_favorites"

    user_id  = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    plant_id = Column(UUID(as_uuid=True), ForeignKey("plants.id", ondelete="CASCADE"), primary_key=True)
    view_id  = Column(UUID(as_uuid=True), ForeignKey("factory_views.id", ondelete="CASCADE"), nullable=False)


# ── Robot cells (FANUC CRX cobots) — telemetry from connected cells ──────────────
# Each cell is an EXISTING Equipment (equipment_id). Read-only: the MES receives,
# stores and displays cell data; it never commands motion or safety.
class RobotCell(Base):
    """Configuration of a robot cell, attached 1:1 to an existing equipment."""
    __tablename__ = "robot_cells"

    id                 = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    equipment_id       = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=False, unique=True, index=True)
    plant_id           = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from equipment
    cell_model         = Column(String(50))    # CRX-25iA | CRX-30iA | CRX-30iAL
    controller         = Column(String(80), default="FANUC R-30iB Mini Plus")
    ip_address         = Column(String(64), nullable=True)
    line               = Column(String(160), nullable=True)   # production line / area / station
    has_machine_motion = Column(Boolean, default=False)        # Vention MachineMotion 2 present
    has_gate           = Column(Boolean, default=False)
    has_scanner        = Column(Boolean, default=False)        # laser scanner / light curtain
    has_safety_module  = Column(Boolean, default=False)
    io_modules         = Column(JSON, default=list)            # extra modules / I/O present
    ingest_token       = Column(String(120), nullable=True)    # per-cell push secret (provisional auth)
    notes              = Column(Text, nullable=True)
    created_at         = Column(DateTime(timezone=True), server_default=func.now())
    updated_at         = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class RobotCellState(Base):
    """Latest live snapshot for a cell (upserted on each telemetry push)."""
    __tablename__ = "robot_cell_states"

    id                  = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cell_id             = Column(UUID(as_uuid=True), ForeignKey("robot_cells.id"), nullable=False, unique=True, index=True)
    # connectivity / mode
    online              = Column(Boolean, default=False)
    run_state           = Column(String(20), nullable=True)   # running | stopped | fault | idle
    op_mode             = Column(String(20), nullable=True)   # auto | manual
    servo_on            = Column(Boolean, nullable=True)
    robot_ready         = Column(Boolean, nullable=True)
    # alarms
    alarm_active        = Column(Boolean, default=False)
    alarm_code          = Column(String(40), nullable=True)
    alarm_message       = Column(String(300), nullable=True)
    # production
    current_program     = Column(String(120), nullable=True)
    current_recipe      = Column(String(120), nullable=True)
    current_wo          = Column(String(120), nullable=True)
    current_sku         = Column(String(120), nullable=True)
    cycle_running       = Column(Boolean, nullable=True)
    cycle_complete      = Column(Boolean, nullable=True)
    last_cycle_s        = Column(Float, nullable=True)
    avg_cycle_s         = Column(Float, nullable=True)
    good_count          = Column(Integer, nullable=True)
    reject_count        = Column(Integer, nullable=True)
    total_count         = Column(Integer, nullable=True)
    # safety (read-only mirror)
    safety_ok           = Column(Boolean, nullable=True)
    estop_active        = Column(Boolean, nullable=True)
    scanner_zone        = Column(String(20), nullable=True)   # clear | occupied
    collaborative_mode  = Column(Boolean, nullable=True)
    reduced_speed       = Column(Boolean, nullable=True)
    stopped_by_safety   = Column(Boolean, nullable=True)
    gate_state          = Column(String(20), nullable=True)   # open | closed | moving | fault
    reset_required      = Column(Boolean, nullable=True)
    # maintenance / reliability
    robot_running_hours = Column(Float, nullable=True)
    servo_hours         = Column(Float, nullable=True)
    cycle_count         = Column(Integer, nullable=True)
    fault_count         = Column(Integer, nullable=True)
    availability        = Column(Float, nullable=True)
    mtbf                = Column(Float, nullable=True)
    mttr                = Column(Float, nullable=True)
    updated_at          = Column(DateTime(timezone=True), nullable=True, index=True)


class RobotCellSample(Base):
    """Time-series history for trends (TimescaleDB hypertable candidate)."""
    __tablename__ = "robot_cell_samples"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cell_id      = Column(UUID(as_uuid=True), ForeignKey("robot_cells.id"), nullable=False, index=True)
    equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=False, index=True)
    timestamp    = Column(DateTime(timezone=True), nullable=False, index=True)
    run_state    = Column(String(20), nullable=True)
    total_count  = Column(Integer, nullable=True)
    good_count   = Column(Integer, nullable=True)
    reject_count = Column(Integer, nullable=True)
    last_cycle_s = Column(Float, nullable=True)
    availability = Column(Float, nullable=True)
    alarm_active = Column(Boolean, nullable=True)


class RobotCellAlarm(Base):
    """Alarm log entries raised/cleared by a cell."""
    __tablename__ = "robot_cell_alarms"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cell_id      = Column(UUID(as_uuid=True), ForeignKey("robot_cells.id"), nullable=False, index=True)
    equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=False, index=True)
    code         = Column(String(40), nullable=True)
    message      = Column(String(300), nullable=True)
    severity     = Column(String(20), default="warning")   # info | warning | critical
    raised_at    = Column(DateTime(timezone=True), nullable=False)
    cleared_at   = Column(DateTime(timezone=True), nullable=True)
    active       = Column(Boolean, default=True, index=True)


class StopCategory(Base):
    __tablename__ = "stop_categories"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id       = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    name             = Column(String(200), nullable=False)
    name_en          = Column(String(200), nullable=True)
    name_fr          = Column(String(200), nullable=True)
    name_es          = Column(String(200), nullable=True)
    type             = Column(SAEnum(StopCategoryType, native_enum=False), nullable=False)
    icon             = Column(String(50), nullable=False, default="⏸")
    color            = Column(String(20), nullable=False, default="#6b7280")
    comment_required = Column(Boolean, default=False)
    triggers_maintenance = Column(Boolean, default=False)
    is_active        = Column(Boolean, default=True)
    is_global        = Column(Boolean, default=False)
    sort_order       = Column(Integer, default=0)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())
    updated_at       = Column(DateTime(timezone=True), onupdate=func.now())

    machine       = relationship("Machine", back_populates="stop_categories", foreign_keys=[machine_id])
    subcategories = relationship("StopSubcategory", back_populates="category", cascade="all, delete-orphan")


class StopSubcategory(Base):
    __tablename__ = "stop_subcategories"

    id                   = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    category_id          = Column(UUID(as_uuid=True), ForeignKey("stop_categories.id"), nullable=False)
    name                 = Column(String(200), nullable=False)
    name_en              = Column(String(200), nullable=True)
    name_fr              = Column(String(200), nullable=True)
    name_es              = Column(String(200), nullable=True)
    icon                 = Column(String(50), nullable=False, default="⏸")
    color                = Column(String(20), nullable=True)
    comment_required     = Column(Boolean, default=False)
    triggers_maintenance = Column(Boolean, default=False)
    is_active            = Column(Boolean, default=True)
    sort_order           = Column(Integer, default=0)

    category = relationship("StopCategory", back_populates="subcategories")


class MachineStop(Base):
    __tablename__ = "machine_stops"

    id                  = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id          = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
    plant_id            = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    started_at          = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ended_at            = Column(DateTime(timezone=True), nullable=True)
    duration_minutes    = Column(Integer, nullable=True)
    stop_category_id    = Column(UUID(as_uuid=True), ForeignKey("stop_categories.id"), nullable=True)
    stop_subcategory_id = Column(UUID(as_uuid=True), ForeignKey("stop_subcategories.id"), nullable=True)
    comments            = Column(Text, nullable=True)
    justified_by        = Column(String(200), nullable=True)
    operator_id         = Column(UUID(as_uuid=True), ForeignKey("machine_operators.id"), nullable=True)
    shift               = Column(SAEnum(AlertShift, native_enum=False), nullable=True)
    job_number          = Column(String(100), nullable=True)
    ticket_id           = Column(UUID(as_uuid=True), ForeignKey("maintenance_tickets.id"), nullable=True)
    source              = Column(String(20), default="operator")   # operator (kiosk) | work_order (office/mobile flow)
    created_at          = Column(DateTime(timezone=True), server_default=func.now())
    updated_at          = Column(DateTime(timezone=True), onupdate=func.now())

    machine     = relationship("Machine", back_populates="stops")
    category    = relationship("StopCategory")
    subcategory = relationship("StopSubcategory")


class MachineOperator(Base):
    __tablename__ = "machine_operators"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id    = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
    plant_id      = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    user_id       = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    name          = Column(String(200), nullable=False)
    employee_code = Column(String(50), nullable=True)
    shift         = Column(SAEnum(OperatorShift, native_enum=False), default=OperatorShift.all)
    is_active     = Column(Boolean, default=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())
    updated_at    = Column(DateTime(timezone=True), onupdate=func.now())

    machine = relationship("Machine", back_populates="operators")


class MachineProductionLog(Base):
    __tablename__ = "machine_production_logs"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id       = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
    plant_id         = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    date             = Column(Date, nullable=False)
    shift            = Column(SAEnum(AlertShift, native_enum=False), nullable=False)
    job_number       = Column(String(100), nullable=True)
    target_count     = Column(Integer, default=0)
    actual_count     = Column(Integer, default=0)
    reject_count     = Column(Integer, default=0)
    availability_pct = Column(Float, default=0.0)
    performance_pct  = Column(Float, default=0.0)
    quality_pct      = Column(Float, default=0.0)
    oee_pct          = Column(Float, default=0.0)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())
    updated_at       = Column(DateTime(timezone=True), onupdate=func.now())

    machine = relationship("Machine", back_populates="production_logs")


class MachineProductionHourly(Base):
    """Real per-hour production counts (ADAM feed) for the pieces/hour chart.
    Complements machine_production_logs (which is per-shift, for OEE): this keeps
    the actual hour each part was produced so the chart shows the true curve
    instead of a synthetic spread. `hour` is truncated to the hour, in UTC."""
    __tablename__ = "machine_production_hourly"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id   = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False, index=True)
    hour         = Column(DateTime(timezone=True), nullable=False, index=True)
    count        = Column(Integer, default=0)
    reject_count = Column(Integer, default=0)
    job_number   = Column(String(100), nullable=True)   # OF loaded when these parts were logged (best-effort)


class MaintenanceAlert(Base):
    __tablename__ = "maintenance_alerts"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    alert_number     = Column(String(30), unique=True, nullable=False)
    machine_id       = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
    plant_id         = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    ticket_id        = Column(UUID(as_uuid=True), ForeignKey("maintenance_tickets.id"), nullable=True)
    department       = Column(String(200))
    problem_type     = Column(SAEnum(AlertProblemType, native_enum=False), nullable=False)
    priority         = Column(SAEnum(AlertPriority, native_enum=False), default=AlertPriority.medium)
    description      = Column(Text)
    created_by       = Column(String(200))
    shift            = Column(SAEnum(AlertShift, native_enum=False))
    status           = Column(SAEnum(AlertStatus, native_enum=False), default=AlertStatus.new_alert)
    assigned_to_id   = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    escalation_level = Column(Integer, default=0)
    escalated_at     = Column(DateTime(timezone=True), nullable=True)
    is_overdue       = Column(Boolean, default=False)
    # Last escalation/reminder SMS for this alert (drives reminder_minutes)
    last_notified_at = Column(DateTime(timezone=True), nullable=True)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())
    updated_at       = Column(DateTime(timezone=True), onupdate=func.now())

    machine     = relationship("Machine", back_populates="alerts")
    assigned_to = relationship("User", foreign_keys=[assigned_to_id])


class MaintenanceTicket(Base):
    __tablename__ = "maintenance_tickets"

    id                         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ticket_number              = Column(String(30), unique=True, nullable=False)
    alert_id                   = Column(UUID(as_uuid=True), ForeignKey("maintenance_alerts.id"), nullable=True)
    machine_id                 = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
    plant_id                   = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    work_order_id              = Column(UUID(as_uuid=True), ForeignKey("work_orders.id"), nullable=True)
    priority                   = Column(SAEnum(AlertPriority, native_enum=False), default=AlertPriority.medium)
    status                     = Column(SAEnum(TicketStatus, native_enum=False), default=TicketStatus.open)
    assigned_to_id             = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    opened_at                  = Column(DateTime(timezone=True), server_default=func.now())
    started_at                 = Column(DateTime(timezone=True), nullable=True)
    completed_at               = Column(DateTime(timezone=True), nullable=True)
    diagnosis                  = Column(Text)
    corrective_action          = Column(Text)
    parts_used                 = Column(JSON, default=[])
    estimated_downtime_minutes = Column(Integer)
    total_intervention_minutes = Column(Integer)
    current_escalation_level   = Column(Integer, default=0)
    last_updated_at            = Column(DateTime(timezone=True), onupdate=func.now())
    problem_type               = Column(SAEnum(AlertProblemType, native_enum=False), nullable=True)
    description                = Column(Text, nullable=True)
    machine_page_source        = Column(Boolean, default=False)
    opened_by_technician_at    = Column(DateTime(timezone=True), nullable=True)
    closed_by_technician_at    = Column(DateTime(timezone=True), nullable=True)
    suggested_technician_id    = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    reported_at                = Column(DateTime(timezone=True), server_default=func.now())

    machine     = relationship("Machine", back_populates="tickets")
    assigned_to = relationship("User", foreign_keys=[assigned_to_id])
    comments    = relationship("TicketComment", back_populates="ticket", cascade="all, delete-orphan")


class EscalationSettings(Base):
    """Singleton row with SLA thresholds and notification toggles."""
    __tablename__ = "escalation_settings"

    id                        = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # NULL = global/legacy row (phase 3 makes escalation per-plant: one row per plant)
    plant_id                  = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    sla_critical_minutes      = Column(Integer, default=10)
    sla_high_minutes          = Column(Integer, default=30)
    sla_medium_minutes        = Column(Integer, default=120)
    sla_low_minutes           = Column(Integer, default=480)
    max_escalation_level      = Column(Integer, default=3)
    sms_enabled               = Column(Boolean, default=True)
    email_enabled             = Column(Boolean, default=True)
    notify_on_critical_alert  = Column(Boolean, default=True)
    notify_on_ticket_assigned = Column(Boolean, default=True)
    notify_on_pm_overdue      = Column(Boolean, default=True)
    # Ticket lifecycle notifications — sent to the level-0 contact group
    notify_on_ticket_opened    = Column(Boolean, default=True)
    notify_on_ticket_completed = Column(Boolean, default=True)
    # Workflow: can technicians claim unassigned tickets themselves?
    technician_self_assign     = Column(Boolean, default=True)
    # End-of-shift summary SMS to level-1 contacts (template-based, no AI)
    shift_report_enabled       = Column(Boolean, default=False)
    # Level-0 ticket group only hears about tickets at or above this priority
    ticket_group_min_priority  = Column(String(20), default="low")
    # Re-notify the current level every N minutes until the alert closes (0 = off)
    reminder_minutes           = Column(Integer, default=0)
    # Don't escalate alerts while the machine is in an open planned stop
    pause_during_planned_stop  = Column(Boolean, default=True)
    # SMS text per notification type — {key: template}; missing/empty = default
    # (defaults live in notification_service.TEMPLATE_DEFAULTS)
    sms_templates              = Column(JSON, nullable=True)
    # Channel per trigger — {trigger: {"sms": bool, "email": bool, "teams": bool}};
    # missing = all on. Refines the global channel switches, does not override them.
    channel_matrix             = Column(JSON, nullable=True)
    # Microsoft Teams: one Adaptive Card per event posted to a channel webhook
    # (a Teams "Workflows" trigger URL — the legacy Office 365 connector webhooks
    # are retired). Per-plant, like the rest of this row. The URL is a secret:
    # anyone holding it can post to the channel.
    teams_enabled              = Column(Boolean, default=False)
    teams_webhook_url          = Column(Text, nullable=True)
    updated_at                = Column(DateTime(timezone=True), onupdate=func.now())


class EscalationContact(Base):
    """Who gets notified at each escalation level (1..max)."""
    __tablename__ = "escalation_contacts"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # NULL = global/legacy contact (phase 3 scopes contacts to their plant)
    plant_id   = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    level      = Column(Integer, nullable=False)
    user_id    = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    via_sms    = Column(Boolean, default=True)
    via_email  = Column(Boolean, default=True)
    is_active  = Column(Boolean, default=True)
    # Scope — both empty = whole factory; machine list wins over department
    scope_department  = Column(String(200), nullable=True)
    scope_machine_ids = Column(JSON, nullable=True)     # list of machine UUID strings
    # Quiet hours — local plant time "HH:MM"; both empty = 24/7.
    # critical_bypass = critical alerts ignore the window (scope always applies)
    notify_start    = Column(String(5), nullable=True)
    notify_end      = Column(String(5), nullable=True)
    critical_bypass = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User")


class NotificationLog(Base):
    __tablename__ = "notification_logs"

    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    alert_id          = Column(UUID(as_uuid=True), ForeignKey("maintenance_alerts.id"), nullable=True)
    ticket_id         = Column(UUID(as_uuid=True), ForeignKey("maintenance_tickets.id"), nullable=True)
    notification_type = Column(String(50))
    recipient_role    = Column(String(100))
    recipient_name    = Column(String(200))
    recipient_contact = Column(String(300))
    message           = Column(Text)
    status            = Column(String(20), default="sent")
    created_at        = Column(DateTime(timezone=True), server_default=func.now())


class ShiftReport(Base):
    """One end-of-shift summary generated by the shift-report cron (template-based,
    no AI tokens). Also the dedup ledger: a (shift_key, window_start) row means
    that shift's report was already produced."""
    __tablename__ = "shift_reports"

    id                  = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id            = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # NULL = legacy (pre multi-plant) report
    shift_key           = Column(String(50), nullable=False)     # shifts_config key (morning|afternoon|night|…)
    window_start        = Column(DateTime(timezone=True), nullable=False)
    window_end          = Column(DateTime(timezone=True), nullable=False)
    body                = Column(Text, nullable=False)           # rendered text (English master copy)
    machines_included   = Column(Integer, default=0)
    recipients_notified = Column(Integer, default=0)
    status              = Column(String(20), default="sent")     # sent | no_recipients | error
    created_at          = Column(DateTime(timezone=True), server_default=func.now())


class TicketComment(Base):
    __tablename__ = "ticket_comments"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ticket_id  = Column(UUID(as_uuid=True), ForeignKey("maintenance_tickets.id"), nullable=False)
    author     = Column(String(200), nullable=False)
    comment    = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    ticket = relationship("MaintenanceTicket", back_populates="comments")


# ─── Reject Categories ─────────────────────────────────────────────────────────

class RejectCategory(Base):
    __tablename__ = "reject_categories"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id       = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    name             = Column(String(200), nullable=False)
    name_en          = Column(String(200), nullable=True)
    name_fr          = Column(String(200), nullable=True)
    name_es          = Column(String(200), nullable=True)
    icon             = Column(String(50), nullable=False, default="❌")
    color            = Column(String(20), nullable=False, default="#ef4444")
    comment_required = Column(Boolean, default=False)
    is_active        = Column(Boolean, default=True)
    is_global        = Column(Boolean, default=False)
    sort_order       = Column(Integer, default=0)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())
    updated_at       = Column(DateTime(timezone=True), onupdate=func.now())

    machine       = relationship("Machine", back_populates="reject_categories")
    subcategories = relationship("RejectSubcategory", back_populates="category", cascade="all, delete-orphan")


class RejectSubcategory(Base):
    __tablename__ = "reject_subcategories"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    category_id      = Column(UUID(as_uuid=True), ForeignKey("reject_categories.id"), nullable=False)
    name             = Column(String(200), nullable=False)
    name_en          = Column(String(200), nullable=True)
    name_fr          = Column(String(200), nullable=True)
    name_es          = Column(String(200), nullable=True)
    icon             = Column(String(50), nullable=False, default="❌")
    color            = Column(String(20), nullable=True)
    comment_required = Column(Boolean, default=False)
    is_active        = Column(Boolean, default=True)
    sort_order       = Column(Integer, default=0)

    category = relationship("RejectCategory", back_populates="subcategories")


class RejectLog(Base):
    __tablename__ = "reject_logs"

    id                    = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id            = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
    plant_id              = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    date                  = Column(Date, nullable=False)
    shift                 = Column(SAEnum(AlertShift, native_enum=False), nullable=False, default=AlertShift.morning)
    job_number            = Column(String(100), nullable=True)
    reject_category_id    = Column(UUID(as_uuid=True), ForeignKey("reject_categories.id"), nullable=True)
    reject_subcategory_id = Column(UUID(as_uuid=True), ForeignKey("reject_subcategories.id"), nullable=True)
    quantity              = Column(Integer, default=1)
    operator_id           = Column(UUID(as_uuid=True), ForeignKey("machine_operators.id"), nullable=True)
    comments              = Column(Text, nullable=True)
    created_at            = Column(DateTime(timezone=True), server_default=func.now())
    updated_at            = Column(DateTime(timezone=True), onupdate=func.now())

    category    = relationship("RejectCategory")
    subcategory = relationship("RejectSubcategory")


# ─── Job Orders ────────────────────────────────────────────────────────────────

class JobOrder(Base):
    """Ordre de fabrication (OF) — a manufacturing order tracked through the plant.
    The label/OF number is scanned at each machine kiosk; every scan opens a
    JobOrderRun (a "passagem") so we can compute time + cost per OF and locate WIP.
    `machine_id`/`department` reflect the CURRENT (last-scanned) location; the full
    path lives in the runs."""
    __tablename__ = "job_orders"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id      = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)  # current/last machine
    plant_id        = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    # OF numbers are unique PER PLANT, not globally: Mirabel supplies St-Jérôme &
    # Las Vegas, so the same number can legitimately exist in different plants.
    job_number      = Column(String(100), nullable=False)
    product_name    = Column(String(300), nullable=True)
    target_quantity = Column(Integer, nullable=True)
    # Equivalent-unit factor per product unit (1 EU = 100 s of assembly-line time),
    # the productivity currency on the Pit Stop TV. Will come from SAP with the OF;
    # the simulator seeds it. NULL → treated as 1.0 (1 unit = 1 EU).
    eu_per_unit     = Column(Float, nullable=True)
    scheduled_date  = Column(Date, nullable=True)
    department      = Column(String(200), nullable=True)   # current/last department (denormalized from the machine)
    status          = Column(SAEnum(JobOrderStatus, native_enum=False), default=JobOrderStatus.pending)
    source          = Column(SAEnum(JobOrderSource, native_enum=False), default=JobOrderSource.manual)
    erp_reference   = Column(String(200), nullable=True)
    started_at      = Column(DateTime(timezone=True), nullable=True)   # first scan (pending → in_progress)
    completed_at    = Column(DateTime(timezone=True), nullable=True)
    created_at      = Column(DateTime(timezone=True), server_default=func.now())
    updated_at      = Column(DateTime(timezone=True), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("plant_id", "job_number", name="uq_job_orders_plant_number"),
    )


class JobOrderRun(Base):
    """One "passagem" of an OF through a machine: from the moment its number is
    scanned there until a different OF is scanned (or the run is closed). This is
    the keystone for BOTH cost (Σ duration × machine.hourly_rate) and WIP (an open
    run = the OF's current location). One row per scan — low volume, kept ≥10 years."""
    __tablename__ = "job_order_runs"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_order_id     = Column(UUID(as_uuid=True), ForeignKey("job_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    machine_id       = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False, index=True)
    plant_id         = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    department       = Column(String(200), nullable=True)   # snapshot of the machine's department at scan time
    operator_id      = Column(UUID(as_uuid=True), ForeignKey("machine_operators.id"), nullable=True)
    started_at       = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ended_at         = Column(DateTime(timezone=True), nullable=True)   # NULL = the OF is currently on this machine
    duration_minutes = Column(Integer, nullable=True)                   # filled when the run closes
    pieces           = Column(Integer, default=0)   # parts produced during this run (attributed from the ADAM feed)
    rejects          = Column(Integer, default=0)
    source           = Column(SAEnum(JobOrderSource, native_enum=False), default=JobOrderSource.manual)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())


# ─── Purchase Orders ───────────────────────────────────────────────────────────

class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    order_number  = Column(String(50), unique=True, nullable=False)
    supplier_id   = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=False)
    plant_id      = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled via cost-center site rule
    status        = Column(SAEnum(PurchaseOrderStatus, native_enum=False), default=PurchaseOrderStatus.draft)
    order_date    = Column(Date, nullable=False)
    expected_date = Column(Date, nullable=True)
    received_date = Column(Date, nullable=True)
    total_amount  = Column(Float, nullable=True)
    currency      = Column(String(10), default="CAD")
    notes         = Column(Text, nullable=True)
    # Cost control: which cost center this purchase books to (SAP cost-center
    # name) and whether it's OPEX or CAPEX. An open PO (sent/confirmed, not yet
    # received) is a committed spend that feeds the forecast in its expected month.
    cost_center   = Column(String(200), nullable=True)
    scope         = Column(String(10), nullable=False, default="opex")  # opex | capex
    created_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())
    updated_at    = Column(DateTime(timezone=True), onupdate=func.now())

    supplier   = relationship("Supplier", back_populates="purchase_orders")
    created_by = relationship("User", foreign_keys=[created_by_id])
    items      = relationship("PurchaseOrderItem", back_populates="order", cascade="all, delete-orphan")


class PurchaseOrderItem(Base):
    __tablename__ = "purchase_order_items"

    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    order_id          = Column(UUID(as_uuid=True), ForeignKey("purchase_orders.id"), nullable=False)
    stock_item_id     = Column(UUID(as_uuid=True), ForeignKey("stock_items.id"), nullable=True)
    description       = Column(String(500), nullable=False)
    quantity          = Column(Float, nullable=False)
    unit_cost         = Column(Float, nullable=False)
    total_cost        = Column(Float, nullable=False)
    received_quantity = Column(Float, default=0)
    notes             = Column(String(500), nullable=True)
    created_at        = Column(DateTime(timezone=True), server_default=func.now())

    order      = relationship("PurchaseOrder", back_populates="items")
    stock_item = relationship("StockItem")


# ─── Inventory Movements ───────────────────────────────────────────────────────

class InventoryMovement(Base):
    __tablename__ = "inventory_movements"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    stock_item_id    = Column(UUID(as_uuid=True), ForeignKey("stock_items.id"), nullable=False)
    work_order_id    = Column(UUID(as_uuid=True), nullable=True)  # soft ref
    movement_type    = Column(String(20), nullable=False)  # deduction | addition | adjustment
    quantity         = Column(Float, nullable=False)
    quantity_before  = Column(Float, nullable=False)
    quantity_after   = Column(Float, nullable=False)
    unit_cost        = Column(Float)
    notes            = Column(String(500))
    created_by_id    = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())

    stock_item = relationship("StockItem", back_populates="movements")
    created_by = relationship("User")


# ─── Machine History ───────────────────────────────────────────────────────────

class MachineHistory(Base):
    __tablename__ = "machine_history"

    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id        = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
    plant_id          = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled from machine
    work_order_id     = Column(UUID(as_uuid=True), nullable=True)  # soft ref
    ticket_id         = Column(UUID(as_uuid=True), nullable=True)  # soft ref
    event_type        = Column(String(30), nullable=False)  # corrective | preventive | inspection
    problem_type      = Column(String(50))
    description       = Column(Text)
    diagnosis         = Column(Text)
    corrective_action = Column(Text)
    parts_used        = Column(JSON, default=[])
    technician_id     = Column(UUID(as_uuid=True), ForeignKey("technicians.id"), nullable=True)
    downtime_minutes  = Column(Integer)
    total_minutes     = Column(Integer)
    occurred_at       = Column(DateTime(timezone=True), nullable=False)
    completed_at      = Column(DateTime(timezone=True))
    created_at        = Column(DateTime(timezone=True), server_default=func.now())

    machine    = relationship("Machine")
    technician = relationship("Technician")


# ─── Cost Audit Log ───────────────────────────────────────────────────────────

class CostAuditLog(Base):
    __tablename__ = "cost_audit_log"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    work_order_id = Column(UUID(as_uuid=True), nullable=True)  # soft ref
    changed_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    field_changed = Column(String(100), nullable=False)
    old_value     = Column(String(500))
    new_value     = Column(String(500))
    reason        = Column(Text)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())

    changed_by = relationship("User")


# ─── Machine Intervention (operator call flow) ────────────────────────────────

# ─── Intervention Types ───────────────────────────────────────────────────────

class InterventionType(Base):
    __tablename__ = "intervention_types"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id     = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=True)
    name         = Column(String(200), nullable=False)
    icon         = Column(String(100), nullable=True)
    color        = Column(String(20), default="#388bfd")
    sort_order   = Column(Integer, default=0)
    is_active    = Column(Boolean, default=True)


class MachineIntervention(Base):
    __tablename__ = "machine_interventions"

    id                     = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id               = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    machine_id             = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    equipment_id           = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=True)
    ticket_id              = Column(UUID(as_uuid=True), ForeignKey("maintenance_tickets.id"), nullable=True)
    status                 = Column(String(30), default="waiting")
    called_at              = Column(DateTime(timezone=True), server_default=func.now())
    started_at             = Column(DateTime(timezone=True), nullable=True)
    completed_at           = Column(DateTime(timezone=True), nullable=True)
    called_by_id           = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    started_by_id          = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    completed_by_id        = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    operator_note                 = Column(Text, nullable=True)
    mechanic_note                 = Column(Text, nullable=True)
    intervention_type_id          = Column(UUID(as_uuid=True), ForeignKey("intervention_types.id"), nullable=True)
    intervention_type_name        = Column(String(200), nullable=True)
    response_time_minutes         = Column(Float, nullable=True)
    intervention_duration_minutes = Column(Float, nullable=True)
    total_downtime_minutes        = Column(Float, nullable=True)
    called_by_name                = Column(String(200), nullable=True)
    started_by_name               = Column(String(200), nullable=True)
    completed_by_name             = Column(String(200), nullable=True)
    # WO-level approval — supervisor / maintenance director signs off the whole
    # completed intervention (work done + parts used), not just individual parts.
    approval_status               = Column(String(20), default="pending")  # pending | approved | rejected
    approved_by_id                = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    approved_at                   = Column(DateTime(timezone=True), nullable=True)
    approval_note                 = Column(Text, nullable=True)
    rejection_reason              = Column(Text, nullable=True)
    # Cost center the approver books this intervention's cost to (SAP cost-center
    # name, e.g. "Maintenance"). Chosen at approval; drives cost attribution.
    cost_center                   = Column(String(200), nullable=True)


class InterventionTechnician(Base):
    """Technicians checked in on an intervention (kiosk check-in). Several techs
    can work the same intervention; the first check-in also backfills
    ``started_by_name`` so the map pictograms have a name. ``name`` is
    denormalized at check-in time so history survives user renames."""
    __tablename__ = "intervention_technicians"
    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    intervention_id = Column(UUID(as_uuid=True), ForeignKey("machine_interventions.id"), nullable=False)
    technician_id   = Column(UUID(as_uuid=True), ForeignKey("technicians.id"), nullable=True)
    name            = Column(String(200), nullable=False)
    checked_in_at   = Column(DateTime(timezone=True), server_default=func.now())
    checked_out_at  = Column(DateTime(timezone=True), nullable=True)


class SafetyChecklist(Base):
    __tablename__ = "safety_checklists"
    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id     = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=True)
    name         = Column(String(200), default="Safety checklist")
    is_active    = Column(Boolean, default=True)


class SafetyChecklistItem(Base):
    __tablename__ = "safety_checklist_items"
    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    checklist_id = Column(UUID(as_uuid=True), ForeignKey("safety_checklists.id"), nullable=True)
    text         = Column(Text, nullable=False)
    sort_order   = Column(Integer, default=0)
    is_required  = Column(Boolean, default=True)


class InterventionChecklistResponse(Base):
    __tablename__ = "intervention_checklist_responses"
    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    intervention_id   = Column(UUID(as_uuid=True), ForeignKey("machine_interventions.id"), nullable=True)
    checklist_item_id = Column(UUID(as_uuid=True), ForeignKey("safety_checklist_items.id"), nullable=True)
    item_text         = Column(Text, nullable=False)
    checked           = Column(Boolean, default=False)
    checked_at        = Column(DateTime(timezone=True), nullable=True)
    checked_by_id     = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)


class CleaningChecklist(Base):
    """Operator cleaning task list, shown on the kiosk when a stop is declared
    with the linked stop category (e.g. "Nettoyage"). One per equipment."""
    __tablename__ = "cleaning_checklists"
    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id         = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    equipment_id     = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=True)
    stop_category_id = Column(UUID(as_uuid=True), ForeignKey("stop_categories.id"), nullable=True)
    name             = Column(String(200), default="Cleaning checklist")
    is_active        = Column(Boolean, default=True)


class CleaningChecklistItem(Base):
    __tablename__ = "cleaning_checklist_items"
    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    checklist_id = Column(UUID(as_uuid=True), ForeignKey("cleaning_checklists.id"), nullable=True)
    text         = Column(Text, nullable=False)
    sort_order   = Column(Integer, default=0)
    is_required  = Column(Boolean, default=True)


class StopCleaningResponse(Base):
    """Which cleaning tasks the operator ticked during a given machine stop.
    item_text denormalized so history survives checklist edits."""
    __tablename__ = "stop_cleaning_responses"
    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    stop_id           = Column(UUID(as_uuid=True), ForeignKey("machine_stops.id"), nullable=False)
    checklist_item_id = Column(UUID(as_uuid=True), ForeignKey("cleaning_checklist_items.id"), nullable=True)
    item_text         = Column(Text, nullable=False)
    checked           = Column(Boolean, default=False)
    checked_at        = Column(DateTime(timezone=True), nullable=True)
    checked_by        = Column(String(200), nullable=True)   # operator name (kiosk is unauthenticated)


class InterventionPart(Base):
    __tablename__ = "intervention_parts"
    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    intervention_id  = Column(UUID(as_uuid=True), ForeignKey("machine_interventions.id"), nullable=True)
    stock_item_id    = Column(UUID(as_uuid=True), ForeignKey("stock_items.id"), nullable=True)
    item_code        = Column(String(100), nullable=True)
    item_description = Column(Text, nullable=True)
    quantity_used    = Column(Float, default=1.0)
    unit             = Column(String(50), nullable=True)
    unit_cost        = Column(Float, nullable=True)   # snapshot of stock price at usage time
    total_cost       = Column(Float, nullable=True)
    added_by_id      = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    added_at         = Column(DateTime(timezone=True), server_default=func.now())
    approval_status  = Column(String(20), default="pending")
    approved_by_id   = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    approved_at      = Column(DateTime(timezone=True), nullable=True)
    rejection_reason = Column(Text, nullable=True)


# ─── Maintenance Intelligence Module ─────────────────────────────────────────

class AIInsight(Base):
    """
    Stores every generated intelligence insight.
    One record per generation request (language + period + type).
    Enables historical comparison and audit trail.
    """
    __tablename__ = "ai_insights"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id         = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    insight_type     = Column(SAEnum(
                           "daily_summary", "machine_risk", "top_irritants",
                           "trend_analysis", "spare_parts", "technician_workload",
                           "full_report",
                           name="insighttype", native_enum=False
                       ), nullable=False, default="full_report")
    language         = Column(String(5), nullable=False, default="en")   # en | fr | es
    period_start     = Column(DateTime(timezone=True), nullable=False)
    period_end       = Column(DateTime(timezone=True), nullable=False)
    period_days      = Column(Integer, nullable=False, default=7)

    # Raw structured findings from calculation engine (always stored)
    findings_json    = Column(JSON, nullable=False, default={})

    # Natural language output (empty string if no API key)
    insight_text     = Column(Text, nullable=False, default="")
    ai_generated     = Column(Boolean, nullable=False, default=False)
    generated_by_model = Column(String(100), nullable=True)             # e.g. "claude-sonnet-4-6"

    generated_at     = Column(DateTime(timezone=True), server_default=func.now())
    generated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)

    recommendations  = relationship("AIRecommendation", back_populates="insight",
                                    cascade="all, delete-orphan")


class AIRecommendation(Base):
    """
    Individual recommended actions extracted from an insight.
    Users can acknowledge or dismiss each one.
    """
    __tablename__ = "ai_recommendations"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    insight_id       = Column(UUID(as_uuid=True), ForeignKey("ai_insights.id",
                                                              ondelete="CASCADE"),
                              nullable=False)

    title            = Column(String(300), nullable=False)
    evidence         = Column(Text, nullable=False)
    impact           = Column(Text, nullable=False)
    recommendation   = Column(Text, nullable=False)
    risk_level       = Column(SAEnum(
                           "low", "medium", "high", "critical",
                           name="rec_risk_level", native_enum=False
                       ), nullable=False, default="medium")

    related_machine_id   = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    related_equipment_id = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=True)
    related_category     = Column(String(100), nullable=True)
    related_period       = Column(String(100), nullable=True)

    confidence           = Column(Float, nullable=True)

    status               = Column(SAEnum(
                               "pending", "acknowledged", "dismissed",
                               name="rec_status", native_enum=False
                           ), nullable=False, default="pending")
    acknowledged_by      = Column(String(200), nullable=True)
    acknowledged_at      = Column(DateTime(timezone=True), nullable=True)
    created_at           = Column(DateTime(timezone=True), server_default=func.now())

    insight              = relationship("AIInsight", back_populates="recommendations")


class MachineRiskScore(Base):
    """
    Computed risk score per machine / equipment.
    Recalculated on every intelligence generation run. History is preserved.
    """
    __tablename__ = "machine_risk_scores"

    id                      = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id              = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    equipment_id            = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=True)
    machine_name            = Column(String(200), nullable=False)

    score                   = Column(Float, nullable=False)
    risk_level              = Column(SAEnum(
                                  "low", "medium", "high", "critical",
                                  name="risk_score_level", native_enum=False
                              ), nullable=False, default="low")

    hours_since_last_ticket = Column(Float, nullable=True)
    historical_mtbf_hours   = Column(Float, nullable=True)
    recent_ticket_count     = Column(Integer, nullable=False, default=0)
    criticality_factor      = Column(Float, nullable=False, default=1.0)
    top_failure_modes       = Column(JSON, nullable=True)

    computed_at             = Column(DateTime(timezone=True), server_default=func.now())
    insight_id              = Column(UUID(as_uuid=True), ForeignKey("ai_insights.id",
                                                                    ondelete="SET NULL"),
                                    nullable=True)


class SparePartRisk(Base):
    """
    Risk assessment per spare part.
    Identifies parts below safety stock or with abnormal consumption.
    """
    __tablename__ = "spare_parts_risk"

    id                      = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    stock_item_id           = Column(UUID(as_uuid=True), ForeignKey("stock_items.id"),
                                    nullable=False)

    part_code               = Column(String(100), nullable=False)
    part_name               = Column(String(300), nullable=False)

    current_qty             = Column(Float, nullable=False, default=0)
    safety_qty              = Column(Float, nullable=False, default=0)

    avg_consumption_30d     = Column(Float, nullable=False, default=0)
    recent_consumption_30d  = Column(Float, nullable=False, default=0)
    consumption_trend       = Column(SAEnum(
                                  "improved", "stable", "deteriorated", "abnormal",
                                  name="consumption_trend", native_enum=False
                              ), nullable=False, default="stable")

    linked_machines         = Column(JSON, nullable=True, default=list)

    risk_level              = Column(SAEnum(
                                  "low", "medium", "high", "critical",
                                  name="part_risk_level", native_enum=False
                              ), nullable=False, default="low")
    days_until_stockout     = Column(Float, nullable=True)

    computed_at             = Column(DateTime(timezone=True), server_default=func.now())
    insight_id              = Column(UUID(as_uuid=True), ForeignKey("ai_insights.id",
                                                                    ondelete="SET NULL"),
                                    nullable=True)


class Dashboard(Base):
    """A user-built custom dashboard: a free-form grid of widget tiles, each bound
    to a machine + a widget type (status | stops | production). Opened by slug for
    TV displays. `tiles` holds both the layout and the bindings:
        [{ "i": str, "machine_id": uuid, "widget": str, "x": int, "y": int, "w": int, "h": int }]"""
    __tablename__ = "dashboards"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug          = Column(String(140), unique=True, nullable=False, index=True)
    name          = Column(String(200), nullable=False)
    plant_id      = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    created_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    is_shared     = Column(Boolean, default=True)
    tiles         = Column(JSON, default=list)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())
    updated_at    = Column(DateTime(timezone=True), onupdate=func.now())


class MaintenanceBudget(Base):
    """Monthly maintenance budget, tracked against actual costs on the Costs page.
    One row per (year, month); amount in the plant currency (CAD by default)."""
    __tablename__ = "maintenance_budgets"
    # One budget per (plant, year, month); the shared/combined row has plant_id NULL.
    __table_args__ = (UniqueConstraint("plant_id", "year", "month", name="uq_maintenance_budget_plant_ym"),)

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id   = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # NULL = legacy/ambiguous — see backfill report
    year       = Column(Integer, nullable=False, index=True)
    month      = Column(Integer, nullable=False)   # 1..12
    amount     = Column(Float, nullable=False, default=0.0)
    currency   = Column(String(3), nullable=False, default="CAD")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class CostCenterBudget(Base):
    """Monthly budget for one cost center (Budget-vs-Actual view). A cost center
    is the department the spend rolls up to — WorkOrder.cost_center when set,
    else the work order's equipment department. One row per (year, month,
    cost_center, kind), where kind splits the envelope into opex | capex."""
    __tablename__ = "cost_center_budgets"
    __table_args__ = (UniqueConstraint("year", "month", "cost_center", "kind",
                                       name="uq_cc_budget_year_month_cc_kind"),)

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id    = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled via cost-center site rule
    cost_center = Column(String(200), nullable=False, index=True)
    year        = Column(Integer, nullable=False, index=True)
    month       = Column(Integer, nullable=False)   # 1..12
    kind        = Column(String(10), nullable=False, default="opex", index=True)  # opex | capex
    amount      = Column(Float, nullable=False, default=0.0)
    currency    = Column(String(3), nullable=False, default="CAD")
    created_at  = Column(DateTime(timezone=True), server_default=func.now())
    updated_at  = Column(DateTime(timezone=True), onupdate=func.now())


class FactoryCalendarSettings(Base):
    """Singleton: which days count as working days for machine KPIs. The factory
    normally runs Mon-Fri; with count_weekends off, a Saturday/Sunday only counts
    when production was actually recorded that day (overtime auto-detected)."""
    __tablename__ = "factory_calendar_settings"

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # NULL = global/legacy row (phase 3 makes the work calendar per-plant)
    plant_id       = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    count_weekends = Column(Boolean, nullable=False, default=False)
    updated_at     = Column(DateTime(timezone=True), onupdate=func.now())


class FactoryHoliday(Base):
    """A non-working holiday date. Excluded from machine-KPI working time unless
    production was actually recorded on it (worked holiday)."""
    __tablename__ = "factory_holidays"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # NULL = global/legacy holiday (phase 3: per-plant calendars — QC vs NV holidays;
    # the unique(date) constraint moves to (plant_id, date) then)
    plant_id   = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)
    date       = Column(Date, nullable=False, unique=True, index=True)
    name       = Column(String(200), nullable=False, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class CostCenter(Base):
    """A manageable cost center for the P&L. Spend rolls up to a cost center via
    the department→cost-center map (CostCenterDepartment); budgets are keyed by
    the cost center's name."""
    __tablename__ = "cost_centers"
    __table_args__ = (UniqueConstraint("name", name="uq_cost_center_name"),)

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id   = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled via cost-center site rule (replaces name matching)
    name       = Column(String(200), nullable=False)
    code       = Column(String(50))
    active     = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class CostCenterDepartment(Base):
    """Maps an equipment department (the raw grouping on Equipment.department) to
    a cost center. One department belongs to at most one cost center."""
    __tablename__ = "cost_center_departments"
    __table_args__ = (UniqueConstraint("department", name="uq_ccdept_department"),)

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cost_center_id = Column(UUID(as_uuid=True), ForeignKey("cost_centers.id", ondelete="CASCADE"), nullable=False, index=True)
    department     = Column(String(200), nullable=False)


class SapCostLine(Base):
    """One month of SAP GL budget/actual for a (cost center, account) pair,
    imported from the monthly SAC extract. The SAP fiscal year runs Dec–Nov:
    pos 1 = December of fiscal_year-1, pos 12 = November. When lines exist for a
    fiscal year, they are the official Budget-vs-Actual series on the Costs page
    (OPEX); a re-import replaces the whole fiscal year."""
    __tablename__ = "sap_cost_lines"
    __table_args__ = (UniqueConstraint("fiscal_year", "pos", "cost_center_code", "account_code",
                                       name="uq_sap_line_fy_pos_cc_acct"),)

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id         = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=True)  # backfilled via cost-center site rule
    fiscal_year      = Column(Integer, nullable=False, index=True)
    pos              = Column(Integer, nullable=False)   # 1..12 fiscal position (1 = Dec)
    year             = Column(Integer, nullable=False)   # calendar year of the month
    month            = Column(Integer, nullable=False)   # calendar month 1..12
    cost_center_code = Column(String(50), nullable=False, index=True)
    cost_center      = Column(String(200), nullable=False)   # descriptive name, e.g. "Maintenance"
    account_code     = Column(String(50), nullable=False)
    account_name     = Column(String(200), nullable=False)
    budget           = Column(Float, nullable=False, default=0.0)
    actual           = Column(Float, nullable=False, default=0.0)
    comment          = Column(Text)
    currency         = Column(String(3), nullable=False, default="CAD")
    imported_at      = Column(DateTime(timezone=True), server_default=func.now())


# ─── Pit Stop (buffer fabrication → assemblage) ────────────────────────────────
# The physical zone itself is an Equipment row with block_kind='pit_stop' (map
# placement/editing for free); its lane geometry + late threshold + ingest token
# live in equipment.specifications JSON. The tables below carry the OF-level data:
# what each OF needs (BOM), every in/out movement (the scan ledger, SAP-fed later,
# simulator-fed today) and the small manual state (priority/hold/release).

class PitStopSource(str, enum.Enum):
    simulated = "simulated"   # written by scripts/simulate_pit_stop.py — removable
    sap       = "sap"         # the future SAP feed (docs/pit-stop-sap-contract.md)


class PitStopDirection(str, enum.Enum):
    inbound  = "in"    # components arriving from fabrication (scanned into the buffer)
    outbound = "out"   # components leaving toward an assembly line (SAP movement)


class PitStopHoldKind(str, enum.Enum):
    hold    = "hold"      # generic managerial hold
    quality = "quality"   # quality issue
    rework  = "rework"    # sent back for rework


class JobOrderComponent(Base):
    """One BOM line of an OF, for Pit Stop completeness: which component and how
    many are required before the OF is 'in full'. Source of truth will be SAP;
    the simulator seeds it today. Completeness compares CUMULATIVE received
    (Σ inbound movements) against required_qty — once received, a component stays
    satisfied even after it exits to the line."""
    __tablename__ = "job_order_components"
    __table_args__ = (
        UniqueConstraint("job_order_id", "component_code", name="uq_job_order_components_of_code"),
    )

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_order_id   = Column(UUID(as_uuid=True), ForeignKey("job_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    component_code = Column(String(100), nullable=False)
    label          = Column(String(300), nullable=True)
    category       = Column(String(100), nullable=True)   # PitStopCategory.name (colour on the 3D stack)
    required_qty   = Column(Integer, nullable=False, default=0)
    source         = Column(SAEnum(PitStopSource, native_enum=False), default=PitStopSource.sap)
    created_at     = Column(DateTime(timezone=True), server_default=func.now())
    updated_at     = Column(DateTime(timezone=True), onupdate=func.now())


class PitStopMovement(Base):
    """One scanned movement in the Pit Stop ledger (immutable, append-only):
    `count` units of a component of an OF entering (in) or leaving (out) the
    buffer. On-hand per (OF, component) = Σ in − Σ out. Anomalies (duplicate scan,
    component not in the BOM, negative balance…) are FLAGGED, never rejected —
    the physical world already happened."""
    __tablename__ = "pit_stop_movements"

    id                     = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id               = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False, index=True)
    job_order_id           = Column(UUID(as_uuid=True), ForeignKey("job_orders.id", ondelete="CASCADE"), nullable=False, index=True)
    component_code         = Column(String(100), nullable=False)
    direction              = Column(SAEnum(PitStopDirection, native_enum=False), nullable=False)
    quantity               = Column(Integer, nullable=False, default=1)
    # SAP/HANA storage address as free text — the real format is TBD with the SAP
    # team; the assumed simulator format is "L{lane:02d}-P{slot:02d}".
    position_code          = Column(String(100), nullable=True)
    destination_machine_id = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)  # on out: which line it left for
    occurred_at            = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    source                 = Column(SAEnum(PitStopSource, native_enum=False), default=PitStopSource.sap)
    anomaly                = Column(String(50), nullable=True)   # duplicate | unknown_of | unknown_component | negative_balance
    raw                    = Column(JSON, nullable=True)         # original payload, for SAP-side debugging
    created_at             = Column(DateTime(timezone=True), server_default=func.now())


class PitStopOfState(Base):
    """The small NON-derivable state of an OF in the buffer: manual priority,
    hold, release, and the presence timestamps maintained by the ingest. All the
    rest (on-hand, completeness, late…) is computed from movements + BOM at read
    time — never stored."""
    __tablename__ = "pit_stop_of_states"

    id                     = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_order_id           = Column(UUID(as_uuid=True), ForeignKey("job_orders.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)
    plant_id               = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False, index=True)
    priority               = Column(Integer, nullable=True)      # manual for now (lower = release first)
    hold_kind              = Column(SAEnum(PitStopHoldKind, native_enum=False), nullable=True)
    hold_reason            = Column(String(300), nullable=True)
    released_at            = Column(DateTime(timezone=True), nullable=True)
    released_by_id         = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    destination_machine_id = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)  # target assembly line (SAP later, simulator/manual now)
    first_in_at            = Column(DateTime(timezone=True), nullable=True)   # first inbound (buffer age runs from here)
    last_movement_at       = Column(DateTime(timezone=True), nullable=True)
    left_at                = Column(DateTime(timezone=True), nullable=True)   # total on-hand hit 0 (cleared if goods come back)
    created_at             = Column(DateTime(timezone=True), server_default=func.now())
    updated_at             = Column(DateTime(timezone=True), onupdate=func.now())


class PitStopCategory(Base):
    """Per-plant registry of component categories shown on the Pit Stop 3D stacks
    (name + colour). User-curated (the real category list comes later); the seed
    creates sensible defaults. JobOrderComponent.category references the name.

    `family` records which furniture family the component belongs to and drives
    the CG/SG split of the buffer: 'both' = shared (Panneaux, Quincaillerie),
    'cg' = case goods only (Tiroirs, Coussins), 'sg' = soft goods only. The
    legend groups categories by family and the buffer is physically split into a
    case-goods area and a (smaller) soft-goods area."""
    __tablename__ = "pit_stop_categories"
    __table_args__ = (UniqueConstraint("plant_id", "name", name="uq_pit_stop_categories_plant_name"),)

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id   = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False, index=True)
    name       = Column(String(100), nullable=False)
    color      = Column(String(20), nullable=False, default="#8b5cf6")
    family     = Column(String(10), nullable=False, default="both")   # 'cg' | 'sg' | 'both'
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
