from pydantic import BaseModel, ConfigDict
from typing import Optional, List, Any
from uuid import UUID
from datetime import datetime

from app.models.models import AlertPriority, AlertStatus, AlertProblemType, AlertShift, TicketStatus, MachineStatus


# ── Machine ────────────────────────────────────────────────────────────────────

class MachineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:                  UUID
    name:                str
    code:                Optional[str] = None
    department:          Optional[str] = None
    location:            Optional[str] = None
    is_active:           bool
    current_status:      Optional[str] = None
    current_operator:    Optional[str] = None
    current_shift:       Optional[str] = None
    last_maintenance_at: Optional[datetime] = None
    page_slug:           Optional[str] = None
    created_at:          datetime


class MachineListResponse(BaseModel):
    total: int
    items: List[MachineOut]


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
    id:                  UUID
    name:                str
    code:                Optional[str] = None
    department:          Optional[str] = None
    location:            Optional[str] = None
    is_active:           bool
    current_status:      str
    current_operator:    Optional[str] = None
    current_shift:       Optional[str] = None
    last_maintenance_at: Optional[datetime] = None
    page_slug:           Optional[str] = None
    open_tickets:        List[TicketForMachine] = []


class MachineStatusUpdate(BaseModel):
    status:           MachineStatus
    current_operator: Optional[str] = None
    current_shift:    Optional[str] = None


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
