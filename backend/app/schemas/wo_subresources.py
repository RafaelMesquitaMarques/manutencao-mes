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
    hours_worked: float
    hourly_rate: Optional[float] = None
    labor_cost: Optional[float] = None
    activity: Optional[str] = None
    notes: Optional[str] = None
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


class WOCostSummary(BaseModel):
    labor_total: float = 0.0
    parts_total: float = 0.0
    other_total: float = 0.0
    grand_total: float = 0.0


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
