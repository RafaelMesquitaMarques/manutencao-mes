from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime, date
from app.models.models import WorkOrderStatus, WorkOrderType, WorkOrderPriority, ExecutionMode, WorkOrderSource


class WorkOrderCreate(BaseModel):
    equipment_id: UUID
    type: WorkOrderType
    priority: WorkOrderPriority = WorkOrderPriority.medium
    title: str
    short_description: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[datetime] = None
    assigned_to_id: Optional[UUID] = None
    executor_id: Optional[UUID] = None
    execution_mode: Optional[ExecutionMode] = ExecutionMode.internal
    classification: Optional[str] = None
    failure_code: Optional[str] = None
    tag: Optional[str] = None
    component: Optional[str] = None
    project_number: Optional[str] = None
    cost_center: Optional[str] = None
    estimated_hours: Optional[float] = None
    notes: Optional[str] = None


class WorkOrderUpdate(BaseModel):
    status: Optional[WorkOrderStatus] = None
    priority: Optional[WorkOrderPriority] = None
    title: Optional[str] = None
    description: Optional[str] = None
    root_cause: Optional[str] = None
    solution_applied: Optional[str] = None
    due_date: Optional[datetime] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    downtime_hours: Optional[float] = None
    repair_hours: Optional[float] = None
    total_cost: Optional[float] = None
    assigned_to_id: Optional[UUID] = None
    executor_id: Optional[UUID] = None
    scheduled_date: Optional[date] = None
    scheduled_start_time: Optional[str] = None
    scheduled_end_time: Optional[str] = None


class WOAssign(BaseModel):
    executor_id: UUID


class WOSchedule(BaseModel):
    executor_id: UUID
    scheduled_date: date
    scheduled_start_time: Optional[str] = None
    scheduled_end_time: Optional[str] = None


class WorkOrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    wo_number: str
    equipment_id: UUID
    equipment_name: Optional[str] = None
    equipment_location: Optional[str] = None
    created_by_id: Optional[UUID] = None
    assigned_to_id: Optional[UUID] = None
    executor_id: Optional[UUID] = None
    type: WorkOrderType
    priority: WorkOrderPriority
    status: WorkOrderStatus
    title: str
    short_description: Optional[str] = None
    description: Optional[str] = None
    root_cause: Optional[str] = None
    solution_applied: Optional[str] = None
    diagnostic: Optional[str] = None
    resolution: Optional[str] = None
    opened_at: datetime
    due_date: Optional[datetime] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    close_date: Optional[date] = None
    downtime_hours: Optional[float] = None
    downtime_minutes: Optional[int] = None
    repair_hours: Optional[float] = None
    completion_ratio: Optional[float] = None
    total_cost: Optional[float] = None
    execution_mode: Optional[ExecutionMode] = None
    classification: Optional[str] = None
    failure_code: Optional[str] = None
    component: Optional[str] = None
    tag: Optional[str] = None
    counter_open: Optional[float] = None
    counter_close: Optional[float] = None
    project_number: Optional[str] = None
    cost_center: Optional[str] = None
    estimated_hours: Optional[float] = None
    notes: Optional[str] = None
    from_iot: bool = False
    ticket_id: Optional[UUID] = None
    ticket_number: Optional[str] = None
    source: Optional[WorkOrderSource] = None
    assigned_to_name: Optional[str] = None
    executor_name: Optional[str] = None
    scheduled_date: Optional[date] = None
    scheduled_start_time: Optional[str] = None
    scheduled_end_time: Optional[str] = None
    total_minutes: Optional[int] = None
    actual_downtime_minutes: Optional[int] = None
    intervention_parts: Optional[List] = None
    plan_id: Optional[UUID] = None
    occurrence_id: Optional[UUID] = None


class WorkOrderListResponse(BaseModel):
    total: int
    items: List[WorkOrderOut]
