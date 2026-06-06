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
    running     = "running"
    stopped     = "stopped"
    maintenance = "maintenance"
    idle        = "idle"

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

class WorkOrderSource(str, enum.Enum):
    manual = "manual"
    ticket = "ticket"


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

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name          = Column(String(200), nullable=False)
    email         = Column(String(200), unique=True, nullable=False)
    password_hash = Column(String(500), nullable=False)
    language      = Column(String(10), default="en")
    active        = Column(Boolean, default=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())

    plants               = relationship("UserPlant", back_populates="user")
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
    qr_code            = Column(String(500))
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
    downtime_minutes = Column(Integer)
    total_cost       = Column(Float)
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

class StockItem(Base):
    __tablename__ = "stock_items"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plant_id     = Column(UUID(as_uuid=True), ForeignKey("plants.id"), nullable=False)
    code         = Column(String(100))
    name         = Column(String(300), nullable=False)
    description  = Column(Text)
    unit         = Column(String(20))
    quantity     = Column(Float, default=0)
    min_quantity = Column(Float, default=0)
    location     = Column(String(200))
    unit_cost    = Column(Float)
    supplier     = Column(String(300))
    created_at   = Column(DateTime(timezone=True), server_default=func.now())

    work_order_items = relationship("WorkOrderStockItem", back_populates="stock_item")


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
    hours_worked  = Column(Float, nullable=False)
    hourly_rate   = Column(Float)
    labor_cost    = Column(Float)
    activity      = Column(String(500))
    notes         = Column(Text)
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

    id                  = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name                = Column(String(200), nullable=False)
    code                = Column(String(50), unique=True, nullable=True)
    department          = Column(String(200))
    location            = Column(String(200))
    is_active           = Column(Boolean, default=True)
    current_status      = Column(SAEnum(MachineStatus, native_enum=False), default=MachineStatus.running)
    current_operator    = Column(String(200), nullable=True)
    current_shift       = Column(SAEnum(AlertShift, native_enum=False), nullable=True)
    last_maintenance_at = Column(DateTime(timezone=True), nullable=True)
    page_slug           = Column(String(200), unique=True, nullable=True)
    created_at          = Column(DateTime(timezone=True), server_default=func.now())

    alerts  = relationship("MaintenanceAlert", back_populates="machine")
    tickets = relationship("MaintenanceTicket", back_populates="machine")


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
