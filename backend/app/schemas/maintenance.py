from pydantic import BaseModel, ConfigDict, field_validator
from typing import Optional, List, Any
from uuid import UUID
from datetime import datetime

from app.models.models import (
    AlertPriority, AlertStatus, AlertProblemType, AlertShift, TicketStatus,
    MachineStatus, StopCategoryType, OperatorShift, PageLanguage,
    HourlyRateCurrency, JobOrderStatus, JobOrderSource,
)


# ── Machine ────────────────────────────────────────────────────────────────────

class MachineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:                      UUID
    name:                    str
    code:                    Optional[str] = None
    department:              Optional[str] = None
    location:                Optional[str] = None
    is_active:               bool
    current_status:          Optional[str] = None
    current_operator:        Optional[str] = None
    current_shift:           Optional[str] = None
    current_job_number:      Optional[str] = None
    last_maintenance_at:     Optional[datetime] = None
    last_stop_at:            Optional[datetime] = None
    last_start_at:           Optional[datetime] = None
    page_slug:               Optional[str] = None
    page_language:           Optional[str] = None
    target_availability_pct: Optional[float] = 70.0
    target_count:            Optional[int] = None
    show_production_panel:   bool = True
    show_reject_panel:       bool = True
    show_availability_gauge: bool = True
    show_job_number:         bool = True
    custom_color:            Optional[str] = None
    display_name:            Optional[str] = None
    hourly_rate:             Optional[float] = None
    hourly_rate_currency:    Optional[str] = "CAD"
    target_count_per_shift:  Optional[int] = None
    shifts_config:           Optional[dict] = None
    created_at:              datetime

    @field_validator('show_production_panel', 'show_reject_panel', 'show_availability_gauge', 'show_job_number', mode='before')
    @classmethod
    def _coerce_null_bool(cls, v):
        return True if v is None else v


class MachineListResponse(BaseModel):
    total: int
    items: List[MachineOut]


class MachineCreate(BaseModel):
    name: str
    code: Optional[str] = None
    department: Optional[str] = None
    location: Optional[str] = None
    page_slug: Optional[str] = None


class MachinePatch(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    department: Optional[str] = None
    location: Optional[str] = None
    is_active: Optional[bool] = None
    page_slug: Optional[str] = None
    shifts_config: Optional[dict] = None


# ── Machine page ───────────────────────────────────────────────────────────────

class TicketForMachine(BaseModel):
    id:                      UUID
    ticket_number:           str
    status:                  str
    priority:                str
    problem_type:            Optional[str] = None
    description:             Optional[str] = None
    assigned_to_name:        Optional[str] = None
    opened_at:               datetime
    opened_by_technician_at: Optional[datetime] = None
    work_order_id:           Optional[UUID] = None
    work_order_number:       Optional[str] = None


class MachinePageData(BaseModel):
    id:                      UUID
    name:                    str
    code:                    Optional[str] = None
    department:              Optional[str] = None
    location:                Optional[str] = None
    is_active:               bool
    current_status:          str
    current_operator:        Optional[str] = None
    current_shift:           Optional[str] = None
    current_job_number:      Optional[str] = None
    last_maintenance_at:     Optional[datetime] = None
    last_stop_at:            Optional[datetime] = None
    last_start_at:           Optional[datetime] = None
    page_slug:               Optional[str] = None
    page_language:           str = "fr"
    target_availability_pct: float = 70.0
    target_count:            Optional[int] = None
    show_production_panel:   bool = True
    show_reject_panel:       bool = True
    show_availability_gauge: bool = True
    show_job_number:         bool = True
    custom_color:            Optional[str] = None
    display_name:            Optional[str] = None
    hourly_rate:             Optional[float] = None
    hourly_rate_currency:    Optional[str] = "CAD"
    target_count_per_shift:  Optional[int] = None
    open_tickets:            List[TicketForMachine] = []


class MachineStatusUpdate(BaseModel):
    status:           MachineStatus
    current_operator: Optional[str] = None
    current_shift:    Optional[str] = None


class MachineJobUpdate(BaseModel):
    job_number: Optional[str] = None


class MachineOperatorUpdate(BaseModel):
    operator_name: Optional[str] = None
    operator_id:   Optional[UUID] = None


class MachineConfigUpdate(BaseModel):
    display_name:            Optional[str]   = None
    page_language:           Optional[str]   = None
    custom_color:            Optional[str]   = None
    target_availability_pct: Optional[float] = None
    target_count:            Optional[int]   = None
    target_count_per_shift:  Optional[int]   = None
    show_production_panel:   Optional[bool]  = None
    show_reject_panel:       Optional[bool]  = None
    show_availability_gauge: Optional[bool]  = None
    show_job_number:         Optional[bool]  = None
    hourly_rate:             Optional[float] = None
    hourly_rate_currency:    Optional[str]   = None


class MachineRejectUpdate(BaseModel):
    delta: int = 1  # +1 or -1


# ── Stop Categories ───────────────────────────────────────────────────────────

class StopSubcategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:                   UUID
    category_id:          UUID
    name:                 str
    name_en:              Optional[str] = None
    name_fr:              Optional[str] = None
    name_es:              Optional[str] = None
    icon:                 str
    color:                Optional[str] = None
    comment_required:     bool = False
    triggers_maintenance: bool
    is_active:            bool
    sort_order:           int


class StopCategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:                   UUID
    machine_id:           Optional[UUID] = None
    name:                 str
    name_en:              Optional[str] = None
    name_fr:              Optional[str] = None
    name_es:              Optional[str] = None
    type:                 StopCategoryType
    icon:                 str
    color:                str
    comment_required:     bool = False
    triggers_maintenance: bool = False
    is_active:            bool
    is_global:            bool = False
    sort_order:           int
    subcategories:        List[StopSubcategoryOut] = []


class StopCategoryCreate(BaseModel):
    name:                str
    name_en:             Optional[str] = None
    name_fr:             Optional[str] = None
    name_es:             Optional[str] = None
    type:                StopCategoryType
    icon:                str = "⏸"
    color:               str = "#6b7280"
    comment_required:    bool = False
    triggers_maintenance: bool = False
    sort_order:          int = 0


class StopCategoryUpdate(BaseModel):
    name:                Optional[str]              = None
    name_en:             Optional[str]              = None
    name_fr:             Optional[str]              = None
    name_es:             Optional[str]              = None
    type:                Optional[StopCategoryType] = None
    icon:                Optional[str]              = None
    color:               Optional[str]              = None
    comment_required:    Optional[bool]             = None
    triggers_maintenance: Optional[bool]            = None
    is_active:           Optional[bool]             = None
    sort_order:          Optional[int]              = None


class StopSubcategoryCreate(BaseModel):
    name:                str
    name_en:             Optional[str]  = None
    name_fr:             Optional[str]  = None
    name_es:             Optional[str]  = None
    icon:                str = "⏸"
    color:               Optional[str]  = None
    comment_required:    bool = False
    triggers_maintenance: bool = False
    sort_order:          int = 0


class StopSubcategoryUpdate(BaseModel):
    name:                Optional[str]  = None
    name_en:             Optional[str]  = None
    name_fr:             Optional[str]  = None
    name_es:             Optional[str]  = None
    icon:                Optional[str]  = None
    color:               Optional[str]  = None
    comment_required:    Optional[bool] = None
    triggers_maintenance: Optional[bool] = None
    is_active:           Optional[bool] = None
    sort_order:          Optional[int]  = None


class SortOrderItem(BaseModel):
    id:         UUID
    sort_order: int


# ── Reject Categories ─────────────────────────────────────────────────────────

class RejectSubcategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:               UUID
    category_id:      UUID
    name:             str
    name_en:          Optional[str] = None
    name_fr:          Optional[str] = None
    name_es:          Optional[str] = None
    icon:             str
    color:            Optional[str] = None
    comment_required: bool = False
    is_active:        bool
    sort_order:       int


class RejectCategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:               UUID
    machine_id:       Optional[UUID] = None
    name:             str
    name_en:          Optional[str] = None
    name_fr:          Optional[str] = None
    name_es:          Optional[str] = None
    icon:             str
    color:            str
    comment_required: bool = False
    is_active:        bool
    is_global:        bool = False
    sort_order:       int
    subcategories:    List[RejectSubcategoryOut] = []


class RejectCategoryCreate(BaseModel):
    name:             str
    name_en:          Optional[str] = None
    name_fr:          Optional[str] = None
    name_es:          Optional[str] = None
    icon:             str = "❌"
    color:            str = "#ef4444"
    comment_required: bool = False
    sort_order:       int = 0


class RejectCategoryUpdate(BaseModel):
    name:             Optional[str]  = None
    name_en:          Optional[str]  = None
    name_fr:          Optional[str]  = None
    name_es:          Optional[str]  = None
    icon:             Optional[str]  = None
    color:            Optional[str]  = None
    comment_required: Optional[bool] = None
    is_active:        Optional[bool] = None
    sort_order:       Optional[int]  = None


class RejectSubcategoryCreate(BaseModel):
    name:             str
    name_en:          Optional[str] = None
    name_fr:          Optional[str] = None
    name_es:          Optional[str] = None
    icon:             str = "❌"
    color:            Optional[str] = None
    comment_required: bool = False
    sort_order:       int = 0


class RejectSubcategoryUpdate(BaseModel):
    name:             Optional[str]  = None
    name_en:          Optional[str]  = None
    name_fr:          Optional[str]  = None
    name_es:          Optional[str]  = None
    icon:             Optional[str]  = None
    color:            Optional[str]  = None
    comment_required: Optional[bool] = None
    is_active:        Optional[bool] = None
    sort_order:       Optional[int]  = None


class RejectLogCreate(BaseModel):
    reject_category_id:    Optional[UUID] = None
    reject_subcategory_id: Optional[UUID] = None
    quantity:              int = 1
    comments:              Optional[str] = None
    job_number:            Optional[str] = None


class CloneCategoriesRequest(BaseModel):
    source_machine_id: UUID
    target_machine_ids: List[UUID]
    category_type:     str  # 'stop' | 'reject'


# ── Machine Stops ─────────────────────────────────────────────────────────────

class MachineStopCreate(BaseModel):
    stop_category_id:    Optional[UUID] = None
    stop_subcategory_id: Optional[UUID] = None
    comments:            Optional[str]  = None
    justified_by:        Optional[str]  = None
    operator_id:         Optional[UUID] = None
    shift:               Optional[str]  = None
    job_number:          Optional[str]  = None


class MachineStopClose(BaseModel):
    stop_category_id:    Optional[UUID] = None
    stop_subcategory_id: Optional[UUID] = None
    comments:            Optional[str]  = None
    justified_by:        Optional[str]  = None


class StopCategoryMini(BaseModel):
    id:    UUID
    name:  str
    icon:  str
    color: str
    type:  str


class StopSubcategoryMini(BaseModel):
    id:    UUID
    name:  str
    icon:  str
    color: Optional[str] = None
    triggers_maintenance: bool


class MachineStopOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:               UUID
    machine_id:       UUID
    started_at:       datetime
    ended_at:         Optional[datetime] = None
    duration_minutes: Optional[int]      = None
    comments:         Optional[str]      = None
    justified_by:     Optional[str]      = None
    ticket_id:        Optional[UUID]     = None
    category:         Optional[StopCategoryMini] = None
    subcategory:      Optional[StopSubcategoryMini] = None


# ── Machine Operators ─────────────────────────────────────────────────────────

class MachineOperatorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:            UUID
    machine_id:    UUID
    user_id:       Optional[UUID]   = None
    name:          str
    employee_code: Optional[str]    = None
    shift:         OperatorShift
    is_active:     bool
    created_at:    datetime


class MachineOperatorCreate(BaseModel):
    name:          str
    employee_code: Optional[str]  = None
    shift:         OperatorShift  = OperatorShift.all
    user_id:       Optional[UUID] = None


class MachineOperatorUpdate(BaseModel):
    name:          Optional[str]          = None
    employee_code: Optional[str]          = None
    shift:         Optional[OperatorShift] = None
    user_id:       Optional[UUID]         = None
    is_active:     Optional[bool]         = None


# ── Extended MES Data ─────────────────────────────────────────────────────────

class MESDataExtended(BaseModel):
    production_count:       int   = 0
    target:                 int   = 0
    oee_pct:                float = 0.0
    availability_pct:       float = 0.0
    reject_count:           int   = 0
    downtime_today_minutes: int   = 0
    is_placeholder:         bool  = True


class MaintenanceRequestCreate(BaseModel):
    problem_type:  AlertProblemType
    priority:      AlertPriority = AlertPriority.high
    description:   Optional[str] = None
    operator_name: str
    shift:         Optional[AlertShift] = None


class MESData(BaseModel):
    production_count:       int = 0
    target:                 int = 0
    oee_pct:                float = 0.0
    downtime_today_minutes: int = 0
    is_placeholder:         bool = True


# ── Alert ──────────────────────────────────────────────────────────────────────

class AlertCreate(BaseModel):
    machine_id:   UUID
    department:   Optional[str] = None
    problem_type: AlertProblemType
    priority:     AlertPriority = AlertPriority.medium
    description:  Optional[str] = None
    created_by:   str
    shift:        Optional[AlertShift] = None


class AlertUpdate(BaseModel):
    department:    Optional[str]              = None
    problem_type:  Optional[AlertProblemType] = None
    priority:      Optional[AlertPriority]    = None
    description:   Optional[str]              = None
    status:        Optional[AlertStatus]      = None
    assigned_to_id: Optional[UUID]            = None


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:               UUID
    alert_number:     str
    machine_id:       UUID
    machine_name:     Optional[str] = None
    department:       Optional[str] = None
    problem_type:     AlertProblemType
    priority:         AlertPriority
    description:      Optional[str] = None
    created_by:       Optional[str] = None
    shift:            Optional[AlertShift] = None
    status:           AlertStatus
    assigned_to_id:   Optional[UUID] = None
    assigned_to_name: Optional[str] = None
    ticket_id:        Optional[UUID] = None
    escalation_level: int
    escalated_at:     Optional[datetime] = None
    is_overdue:       bool
    created_at:       datetime
    updated_at:       Optional[datetime] = None


class AlertListResponse(BaseModel):
    total: int
    items: List[AlertOut]


# ── Ticket ─────────────────────────────────────────────────────────────────────

class TicketCreate(BaseModel):
    alert_id:                   Optional[UUID]          = None
    machine_id:                 UUID
    priority:                   AlertPriority           = AlertPriority.medium
    assigned_to_id:             Optional[UUID]          = None
    estimated_downtime_minutes: Optional[int]           = None
    problem_type:               Optional[AlertProblemType] = None
    description:                Optional[str]           = None
    machine_page_source:        bool                    = False


class TicketUpdate(BaseModel):
    status:                     Optional[TicketStatus] = None
    assigned_to_id:             Optional[UUID]         = None
    diagnosis:                  Optional[str]          = None
    corrective_action:          Optional[str]          = None
    parts_used:                 Optional[List[Any]]    = None
    estimated_downtime_minutes: Optional[int]          = None
    total_intervention_minutes: Optional[int]          = None


class TicketClose(BaseModel):
    diagnosis:                  str
    corrective_action:          str
    total_intervention_minutes: int
    parts_used:                 Optional[List[Any]] = None
    estimated_downtime_minutes: Optional[int]       = None


class CommentCreate(BaseModel):
    author:  str
    comment: str


class CommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:         UUID
    ticket_id:  UUID
    author:     str
    comment:    str
    created_at: datetime


class TicketOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:                         UUID
    ticket_number:              str
    alert_id:                   Optional[UUID]      = None
    machine_id:                 UUID
    machine_name:               Optional[str]       = None
    priority:                   AlertPriority
    status:                     TicketStatus
    assigned_to_id:             Optional[UUID]      = None
    assigned_to_name:           Optional[str]       = None
    work_order_id:              Optional[UUID]      = None
    work_order_number:          Optional[str]       = None
    work_order_status:          Optional[str]       = None
    problem_type:               Optional[AlertProblemType] = None
    description:                Optional[str]       = None
    machine_page_source:        bool                = False
    opened_by_technician_at:    Optional[datetime]  = None
    closed_by_technician_at:    Optional[datetime]  = None
    opened_at:                  datetime
    started_at:                 Optional[datetime]  = None
    completed_at:               Optional[datetime]  = None
    diagnosis:                  Optional[str]       = None
    corrective_action:          Optional[str]       = None
    parts_used:                 Optional[List[Any]] = None
    estimated_downtime_minutes: Optional[int]       = None
    total_intervention_minutes: Optional[int]       = None
    current_escalation_level:   int
    last_updated_at:            Optional[datetime]  = None
    comments:                   Optional[List[CommentOut]] = None


class TicketListResponse(BaseModel):
    total: int
    items: List[TicketOut]


# ── Supervisor overview ────────────────────────────────────────────────────────

class TicketSummary(BaseModel):
    id:                       UUID
    ticket_number:            str
    machine_name:             Optional[str] = None
    priority:                 str
    problem_type:             str
    status:                   str
    opened_at:                datetime
    is_overdue:               bool
    current_escalation_level: int
    work_order_id:            Optional[UUID] = None


class WOSummary(BaseModel):
    id:                   UUID
    wo_number:            str
    ticket_id:            Optional[UUID]   = None
    ticket_number:        Optional[str]    = None
    machine_name:         Optional[str]    = None
    priority:             str
    status:               str
    opened_at:            datetime
    executor_id:          Optional[UUID]   = None
    executor_name:        Optional[str]    = None
    scheduled_date:       Optional[str]    = None
    scheduled_start_time: Optional[str]    = None
    scheduled_end_time:   Optional[str]    = None


class SupervisorOverview(BaseModel):
    pending_tickets:  List[TicketSummary]
    unassigned_wos:   List[WOSummary]
    unscheduled_wos:  List[WOSummary]


# ── Job Orders ─────────────────────────────────────────────────────────────────

class JobOrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:              UUID
    machine_id:      Optional[UUID] = None
    job_number:      str
    product_name:    Optional[str] = None
    target_quantity: Optional[int] = None
    scheduled_date:  Optional[Any] = None
    status:          JobOrderStatus
    source:          JobOrderSource
    erp_reference:   Optional[str] = None
    created_at:      datetime


class JobOrderCreate(BaseModel):
    machine_id:      Optional[UUID] = None
    job_number:      str
    product_name:    Optional[str] = None
    target_quantity: Optional[int] = None
    scheduled_date:  Optional[Any] = None
    source:          JobOrderSource = JobOrderSource.manual
    erp_reference:   Optional[str] = None


class JobOrderUpdate(BaseModel):
    product_name:    Optional[str]           = None
    target_quantity: Optional[int]           = None
    scheduled_date:  Optional[Any]           = None
    status:          Optional[JobOrderStatus] = None
    machine_id:      Optional[UUID]          = None
