"""
Database models for the Foliot MES platform.
Structured for multi-plant support from the ground up.
"""
import uuid
from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, Float, Boolean, DateTime, Date,
    ForeignKey, Text, Enum as SAEnum, JSON
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
    stopped      = "stopped"
    maintenance  = "maintenance"
    idle         = "idle"
    planned_stop = "planned_stop"

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
    manual = "manual"
    erp    = "erp"


# ─── Plant ─────────────────────────────────────────────────────────────────────

class Plant(Base):
    __tablename__ = "plants"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code       = Column(String(20), unique=True, nullable=False)
    name       = Column(String(200), nullable=False)
    address    = Column(String(500))
    timezone   = Column(String(50), default="America/Toronto")
    active     = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    equipment = relationship("Equipment", back_populates="plant")
    users     = relationship("UserPlant", back_populates="plant")


# ─── User ──────────────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id                   = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name                 = Column(String(200), nullable=False)
    email                = Column(String(200), unique=True, nullable=False)
    password_hash        = Column(String(500), nullable=False)
    language             = Column(String(10), default="en")
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

    plants               = relationship("UserPlant", back_populates="user")
    permissions          = relationship("Permission", back_populates="user", cascade="all, delete-orphan")
    created_work_orders  = relationship("WorkOrder", back_populates="created_by",  foreign_keys="WorkOrder.created_by_id")
    assigned_work_orders = relationship("WorkOrder", back_populates="assigned_to", foreign_keys="WorkOrder.assigned_to_id")
    technician_profile   = relationship("Technician", back_populates="user", uselist=False)


class UserPlant(Base):
    """Junction table: a user can have different roles at each plant."""
    __tablename__ = "user_plants"

    id       = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id  = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    plant_id = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False)
    role     = Column(SAEnum(UserRole, native_enum=False), default=UserRole.technician)

    user  = relationship("User", back_populates="plants")
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


# ─── Work Order ────────────────────────────────────────────────────────────────

class WorkOrder(Base):
    __tablename__ = "work_orders"

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    wo_number      = Column(String(20), unique=True, nullable=False)
    equipment_id   = Column(UUID(as_uuid=True), ForeignKey("equipment.id"), nullable=False)
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

    equipment       = relationship("Equipment", back_populates="work_orders")
    created_by      = relationship("User", back_populates="created_work_orders",  foreign_keys=[created_by_id])
    assigned_to     = relationship("User", back_populates="assigned_work_orders", foreign_keys=[assigned_to_id])
    executor        = relationship("Technician", back_populates="work_orders", foreign_keys=[executor_id])
    plan            = relationship("MaintenancePlan", back_populates="work_orders")
    legacy_items    = relationship("WorkOrderStockItem", back_populates="work_order")
    labor_records   = relationship("LaborRecord", back_populates="work_order", cascade="all, delete-orphan")
    wo_parts        = relationship("WOPart", back_populates="work_order", cascade="all, delete-orphan")
    wo_costs        = relationship("WOCost", back_populates="work_order", cascade="all, delete-orphan")
    wo_actions      = relationship("WOAction", back_populates="work_order", cascade="all, delete-orphan")
    supplier_orders = relationship("SupplierOrder", back_populates="work_order", cascade="all, delete-orphan")


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

    equipment   = relationship("Equipment", back_populates="plans")
    work_orders = relationship("WorkOrder", back_populates="plan")


# ─── Inventory ─────────────────────────────────────────────────────────────────

class Supplier(Base):
    __tablename__ = "suppliers"

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
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
    unit_cost    = Column(Float)
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

    work_order = relationship("WorkOrder", back_populates="labor_records")
    technician = relationship("Technician", back_populates="labor_records")


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

    work_order = relationship("WorkOrder", back_populates="wo_actions")
    author     = relationship("User")


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
    shifts_config            = Column(JSON, nullable=True)
    created_at               = Column(DateTime(timezone=True), server_default=func.now())

    alerts             = relationship("MaintenanceAlert", back_populates="machine")
    tickets            = relationship("MaintenanceTicket", back_populates="machine")
    stops              = relationship("MachineStop", back_populates="machine", cascade="all, delete-orphan")
    operators          = relationship("MachineOperator", back_populates="machine", cascade="all, delete-orphan")
    production_logs    = relationship("MachineProductionLog", back_populates="machine", cascade="all, delete-orphan")
    stop_categories    = relationship("StopCategory", back_populates="machine", cascade="all, delete-orphan", foreign_keys="StopCategory.machine_id")
    reject_categories  = relationship("RejectCategory", back_populates="machine", cascade="all, delete-orphan")


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
    created_at          = Column(DateTime(timezone=True), server_default=func.now())
    updated_at          = Column(DateTime(timezone=True), onupdate=func.now())

    machine     = relationship("Machine", back_populates="stops")
    category    = relationship("StopCategory")
    subcategory = relationship("StopSubcategory")


class MachineOperator(Base):
    __tablename__ = "machine_operators"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id    = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
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


class MaintenanceAlert(Base):
    __tablename__ = "maintenance_alerts"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    alert_number     = Column(String(30), unique=True, nullable=False)
    machine_id       = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=False)
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
    __tablename__ = "job_orders"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    machine_id      = Column(UUID(as_uuid=True), ForeignKey("machines.id"), nullable=True)
    job_number      = Column(String(100), unique=True, nullable=False)
    product_name    = Column(String(300), nullable=True)
    target_quantity = Column(Integer, nullable=True)
    scheduled_date  = Column(Date, nullable=True)
    status          = Column(SAEnum(JobOrderStatus, native_enum=False), default=JobOrderStatus.pending)
    source          = Column(SAEnum(JobOrderSource, native_enum=False), default=JobOrderSource.manual)
    erp_reference   = Column(String(200), nullable=True)
    created_at      = Column(DateTime(timezone=True), server_default=func.now())
    updated_at      = Column(DateTime(timezone=True), onupdate=func.now())


# ─── Purchase Orders ───────────────────────────────────────────────────────────

class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    order_number  = Column(String(50), unique=True, nullable=False)
    supplier_id   = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=False)
    status        = Column(SAEnum(PurchaseOrderStatus, native_enum=False), default=PurchaseOrderStatus.draft)
    order_date    = Column(Date, nullable=False)
    expected_date = Column(Date, nullable=True)
    received_date = Column(Date, nullable=True)
    total_amount  = Column(Float, nullable=True)
    currency      = Column(String(10), default="CAD")
    notes         = Column(Text, nullable=True)
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
