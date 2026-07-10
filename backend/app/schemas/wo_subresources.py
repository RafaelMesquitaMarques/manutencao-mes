from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime, date
from app.models.models import CostTransactionType


class LaborCreate(BaseModel):
    technician_id: UUID
    date: date
    hours_worked: float
    hourly_rate: Optional[float] = None
    activity: Optional[str] = None
    notes: Optional[str] = None


class LaborOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    work_order_id: UUID
    technician_id: UUID
    technician_name: Optional[str] = None
    date: date
    hours_worked: float                       # RAW assigned time (feeds repair_hours/MTTR)
    effective_hours: Optional[float] = None    # after deducting non-working intervals → drives labor_cost
    deducted_minutes: Optional[float] = None   # raw − effective, in minutes (breaks/lunch/off-shift/unavailability)
    overtime_approved: bool = False
    hourly_rate: Optional[float] = None
    labor_cost: Optional[float] = None
    activity: Optional[str] = None
    notes: Optional[str] = None
    started_at: Optional[datetime] = None
    stopped_at: Optional[datetime] = None
    created_at: datetime


class WOPartCreate(BaseModel):
    stock_item_id: Optional[UUID] = None
    part_number: Optional[str] = None
    description: str
    quantity: float
    unit: str = "un"
    unit_cost: Optional[float] = None
    supplier: Optional[str] = None
    notes: Optional[str] = None


class WOPartOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    work_order_id: UUID
    stock_item_id: Optional[UUID] = None
    part_number: Optional[str] = None
    description: str
    quantity: float
    unit: str
    unit_cost: Optional[float] = None
    total_cost: Optional[float] = None
    supplier: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime


class WOCostCreate(BaseModel):
    transaction_type: CostTransactionType
    description: str
    amount: float
    currency: str = "CAD"
    reference: Optional[str] = None
    date: date
    notes: Optional[str] = None


class WOCostOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    work_order_id: UUID
    transaction_type: CostTransactionType
    description: str
    amount: float
    currency: str
    reference: Optional[str] = None
    date: date
    notes: Optional[str] = None
    created_at: datetime


class WOActionCreate(BaseModel):
    action_type: str
    content: Optional[str] = None
    old_value: Optional[str] = None
    new_value: Optional[str] = None


class WOActionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    work_order_id: UUID
    author_id: Optional[UUID] = None
    action_type: str
    content: Optional[str] = None
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    created_at: datetime

    # ── PM checklist ──
    description: Optional[str] = None
    expected_result: Optional[str] = None
    template_task_id: Optional[UUID] = None
    proof_photo_url: Optional[str] = None
    media: List[dict] = []                 # live SOP photos/videos/links from the template step
    is_required: bool = True
    is_completed: bool = False
    completed_at: Optional[datetime] = None
    completed_by_id: Optional[UUID] = None
    sort_order: int = 0


class WOActionToggle(BaseModel):
    is_completed: bool


class WOCostSummary(BaseModel):
    labor_total: float = 0.0          # effective labor cost (what is billed)
    parts_total: float = 0.0
    other_total: float = 0.0
    grand_total: float = 0.0
    # Transparency for the labor report: raw assigned time vs effective vs the gap.
    labor_raw_hours: float = 0.0
    labor_effective_hours: float = 0.0
    labor_deducted_minutes: float = 0.0


class LaborListResponse(BaseModel):
    total: int
    items: List[LaborOut]


class WOPartListResponse(BaseModel):
    total: int
    items: List[WOPartOut]


class WOCostListResponse(BaseModel):
    total: int
    items: List[WOCostOut]


class WOActionListResponse(BaseModel):
    total: int
    items: List[WOActionOut]
