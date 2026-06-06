from pydantic import BaseModel, ConfigDict
from typing import Optional, List, Any
from uuid import UUID
from datetime import datetime

from app.models.models import AlertPriority, AlertStatus, AlertProblemType, AlertShift, TicketStatus


# ── Machine ────────────────────────────────────────────────────────────────────

class MachineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:         UUID
    name:       str
    department: Optional[str] = None
    location:   Optional[str] = None
    is_active:  bool
    created_at: datetime


class MachineListResponse(BaseModel):
    total: int
    items: List[MachineOut]


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
    alert_id:                   Optional[UUID]        = None
    machine_id:                 UUID
    priority:                   AlertPriority         = AlertPriority.medium
    assigned_to_id:             Optional[UUID]        = None
    estimated_downtime_minutes: Optional[int]         = None


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
