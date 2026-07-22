from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime

from app.models.models import SopCategory, SopStatus


# ─── SOP Step Media ─────────────────────────────────────────────────────────────

class SopStepMediaCreate(BaseModel):
    media_type: str                       # image | video | link
    url: str
    caption: Optional[str] = None
    sort_order: int = 0


class SopStepMediaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    step_id: UUID
    media_type: str
    url: str
    caption: Optional[str] = None
    sort_order: int


# ─── SOP Steps ──────────────────────────────────────────────────────────────────

class SopStepCreate(BaseModel):
    title: Optional[str] = None
    instruction: str
    expected_result: Optional[str] = None
    warning: Optional[str] = None
    sort_order: int = 0
    is_required: bool = True


class SopStepUpdate(BaseModel):
    title: Optional[str] = None
    instruction: Optional[str] = None
    expected_result: Optional[str] = None
    warning: Optional[str] = None
    sort_order: Optional[int] = None
    is_required: Optional[bool] = None


class SopStepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sop_id: UUID
    title: Optional[str] = None
    instruction: str
    expected_result: Optional[str] = None
    warning: Optional[str] = None
    sort_order: int
    is_required: bool
    media: List[SopStepMediaOut] = []


class SopStepsReorder(BaseModel):
    step_ids: List[UUID]                  # full ordered list of the SOP's step ids


# ─── SOP equipment links ────────────────────────────────────────────────────────

class SopEquipmentOut(BaseModel):
    equipment_id: UUID
    equipment_name: Optional[str] = None
    equipment_code: Optional[str] = None


# ─── SOPs ───────────────────────────────────────────────────────────────────────

class SopCreate(BaseModel):
    title: str
    category: SopCategory = SopCategory.operation
    description: Optional[str] = None
    estimated_minutes: Optional[float] = None
    equipment_ids: List[UUID] = []
    steps: List[SopStepCreate] = []


class SopUpdate(BaseModel):
    title: Optional[str] = None
    category: Optional[SopCategory] = None
    description: Optional[str] = None
    estimated_minutes: Optional[float] = None
    equipment_ids: Optional[List[UUID]] = None   # full replacement when provided


class SopOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    plant_id: Optional[UUID] = None
    sop_number: str
    title: str
    category: SopCategory
    description: Optional[str] = None
    status: SopStatus
    version: int
    estimated_minutes: Optional[float] = None
    created_by_name: Optional[str] = None
    published_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    step_count: int = 0
    equipment: List[SopEquipmentOut] = []
    steps: List[SopStepOut] = []          # empty on list responses (kept light)


class SopListResponse(BaseModel):
    total: int
    items: List[SopOut]


# ─── Executions (step-by-step runs) ─────────────────────────────────────────────

class SopExecutionStart(BaseModel):
    sop_id: UUID
    equipment_id: Optional[UUID] = None
    operator_name: Optional[str] = None


class KioskExecutionStart(BaseModel):
    operator_name: Optional[str] = None   # defaults to the machine's current operator


class SopExecutionStepSet(BaseModel):
    checked: bool = True


class SopExecutionComplete(BaseModel):
    notes: Optional[str] = None


class SopExecutionStepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    step_id: UUID
    checked: bool
    checked_at: Optional[datetime] = None


class SopExecutionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sop_id: UUID
    equipment_id: Optional[UUID] = None
    machine_id: Optional[UUID] = None
    machine_name: Optional[str] = None
    user_id: Optional[UUID] = None
    operator_name: Optional[str] = None
    sop_version: Optional[int] = None
    source: str
    status: str
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    duration_seconds: Optional[float] = None
    notes: Optional[str] = None
    steps: List[SopExecutionStepOut] = []


class SopExecutionListResponse(BaseModel):
    total: int
    items: List[SopExecutionOut]
