from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime, date

from app.models.models import PmFrequency, RecurrenceEndType, OccurrenceStatus, OccurrenceCompliance


# ─── PM Template Tasks ──────────────────────────────────────────────────────────

class PmTemplateTaskCreate(BaseModel):
    description: str
    sort_order: int = 0
    is_required: bool = True


class PmTemplateTaskUpdate(BaseModel):
    description: Optional[str] = None
    sort_order: Optional[int] = None
    is_required: Optional[bool] = None


class PmTemplateTaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    template_id: UUID
    description: str
    sort_order: int
    is_required: bool


# ─── PM Templates ────────────────────────────────────────────────────────────────

class PmTemplateCreate(BaseModel):
    equipment_id: UUID
    frequency_type: PmFrequency
    name: str
    description: Optional[str] = None
    estimated_hours: float = 1.0
    sort_order: int = 0
    tasks: List[PmTemplateTaskCreate] = []


class PmTemplateUpdate(BaseModel):
    frequency_type: Optional[PmFrequency] = None
    name: Optional[str] = None
    description: Optional[str] = None
    estimated_hours: Optional[float] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None


class PmTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    plant_id: Optional[UUID] = None
    equipment_id: UUID
    equipment_name: Optional[str] = None
    frequency_type: PmFrequency
    name: str
    description: Optional[str] = None
    estimated_hours: float
    is_active: bool
    sort_order: int
    tasks: List[PmTemplateTaskOut] = []


class PmTemplateListResponse(BaseModel):
    total: int
    items: List[PmTemplateOut]


# ─── Plan Recommended Parts ──────────────────────────────────────────────────────

class PlanRecommendedPartCreate(BaseModel):
    stock_item_id: Optional[UUID] = None
    item_code: Optional[str] = None
    item_description: Optional[str] = None
    quantity_recommended: float = 1
    unit: Optional[str] = None


class PlanRecommendedPartOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    plan_id: UUID
    stock_item_id: Optional[UUID] = None
    item_code: Optional[str] = None
    item_description: Optional[str] = None
    quantity_recommended: float
    unit: Optional[str] = None


# ─── Maintenance Plans ────────────────────────────────────────────────────────────

class MaintenancePlanCreate(BaseModel):
    equipment_id: UUID
    name: str
    description: Optional[str] = None
    pm_template_id: Optional[UUID] = None
    plan_type: str = "preventive"

    frequency_type: PmFrequency
    frequency_value: int = 1
    frequency_days: Optional[int] = None
    frequency_hours: Optional[float] = None
    weekdays: Optional[str] = None
    start_date: date

    recurrence_end_type: RecurrenceEndType = RecurrenceEndType.never
    recurrence_end_value: Optional[int] = None
    recurrence_end_date: Optional[date] = None

    lead_time_days: int = 3
    assigned_technician_id: Optional[UUID] = None
    priority: str = "medium"
    estimated_hours: float = 1.0

    recommended_parts: List[PlanRecommendedPartCreate] = []


class MaintenancePlanUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    pm_template_id: Optional[UUID] = None
    plan_type: Optional[str] = None

    frequency_type: Optional[PmFrequency] = None
    frequency_value: Optional[int] = None
    frequency_days: Optional[int] = None
    frequency_hours: Optional[float] = None
    weekdays: Optional[str] = None
    start_date: Optional[date] = None

    recurrence_end_type: Optional[RecurrenceEndType] = None
    recurrence_end_value: Optional[int] = None
    recurrence_end_date: Optional[date] = None

    lead_time_days: Optional[int] = None
    assigned_technician_id: Optional[UUID] = None
    priority: Optional[str] = None
    estimated_hours: Optional[float] = None
    is_active: Optional[bool] = None


class MaintenancePlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    equipment_id: UUID
    equipment_name: Optional[str] = None
    plant_id: Optional[UUID] = None
    name: str
    description: Optional[str] = None

    pm_template_id: Optional[UUID] = None
    pm_template_name: Optional[str] = None
    plan_type: Optional[str] = None

    frequency_type: Optional[PmFrequency] = None
    frequency_value: Optional[int] = None
    frequency_days: Optional[int] = None
    frequency_hours: Optional[float] = None
    weekdays: Optional[str] = None
    start_date: Optional[date] = None

    recurrence_end_type: Optional[RecurrenceEndType] = None
    recurrence_end_value: Optional[int] = None
    recurrence_end_date: Optional[date] = None

    lead_time_days: Optional[int] = None
    assigned_technician_id: Optional[UUID] = None
    assigned_technician_name: Optional[str] = None
    priority: Optional[str] = None
    estimated_hours: Optional[float] = None
    is_active: bool

    next_due_date: Optional[date] = None
    next_due_hours: Optional[float] = None
    total_occurrences: Optional[int] = None
    created_by_id: Optional[UUID] = None
    created_at: datetime

    recommended_parts: List[PlanRecommendedPartOut] = []


class MaintenancePlanListResponse(BaseModel):
    total: int
    items: List[MaintenancePlanOut]
    overdue_count: int = 0
    due_this_week: int = 0


# ─── Plan Occurrences ─────────────────────────────────────────────────────────────

class PlanOccurrenceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    plan_id: UUID
    plan_name: Optional[str] = None
    plant_id: Optional[UUID] = None
    equipment_id: Optional[UUID] = None
    equipment_name: Optional[str] = None
    work_order_id: Optional[UUID] = None
    work_order_number: Optional[str] = None

    scheduled_date: date
    actual_date: Optional[date] = None

    is_overridden: bool
    override_date: Optional[date] = None
    override_note: Optional[str] = None

    is_cancelled: bool
    cancel_reason: Optional[str] = None

    status: OccurrenceStatus
    compliance: Optional[OccurrenceCompliance] = None
    days_late: Optional[int] = None

    reminder_sent: bool
    overdue_alert_sent: bool
    created_at: datetime


class OccurrenceOverride(BaseModel):
    override_date: Optional[date] = None
    override_note: Optional[str] = None


class OccurrenceCancel(BaseModel):
    cancel_reason: Optional[str] = None


class PlanOccurrenceListResponse(BaseModel):
    total: int
    items: List[PlanOccurrenceOut]


# ─── Calendar / Dashboard / Reports ──────────────────────────────────────────────

class PlanCalendarItem(BaseModel):
    id: UUID
    plan_id: UUID
    plan_name: str
    equipment_id: Optional[UUID] = None
    equipment_name: Optional[str] = None
    date: date
    status: OccurrenceStatus
    compliance: Optional[OccurrenceCompliance] = None
    is_overridden: bool
    is_cancelled: bool
    work_order_id: Optional[UUID] = None
    priority: Optional[str] = None


class PmDashboard(BaseModel):
    total_plans: int
    active_plans: int
    overdue_occurrences: int
    due_this_week: int
    completed_this_month: int
    compliance_rate: float
    upcoming: List[PlanOccurrenceOut] = []
    overdue: List[PlanOccurrenceOut] = []
