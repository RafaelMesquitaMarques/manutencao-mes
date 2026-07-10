from pydantic import BaseModel, ConfigDict
from typing import Optional, List, Dict, Any
from uuid import UUID
from datetime import datetime
from app.models.models import EquipmentStatus


class EquipmentCreate(BaseModel):
    plant_id: UUID
    code: str
    name: str
    description: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    serial_number: Optional[str] = None
    manufacturing_year: Optional[int] = None
    location: Optional[str] = None
    criticality: str = "medium"
    asset_type: str = "production"          # production | auxiliary
    subtype: Optional[str] = None
    function_label: Optional[str] = None
    department: Optional[str] = None
    cost_center: Optional[str] = None
    family: Optional[str] = None
    pm_strategy: Optional[str] = None
    cleaning_priority: Optional[str] = None
    model_url: Optional[str] = None
    height_3d: Optional[float] = None
    model_scale: Optional[float] = None
    specifications: Dict[str, Any] = {}


class EquipmentUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    description: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    serial_number: Optional[str] = None
    manufacturing_year: Optional[int] = None
    location: Optional[str] = None
    status: Optional[EquipmentStatus] = None
    criticality: Optional[str] = None
    asset_type: Optional[str] = None
    subtype: Optional[str] = None
    function_label: Optional[str] = None
    department: Optional[str] = None
    cost_center: Optional[str] = None
    family: Optional[str] = None
    pm_strategy: Optional[str] = None
    cleaning_priority: Optional[str] = None
    model_url: Optional[str] = None
    height_3d: Optional[float] = None
    model_scale: Optional[float] = None
    parent_equipment_id: Optional[UUID] = None
    hour_meter: Optional[float] = None
    specifications: Optional[Dict[str, Any]] = None
    active: Optional[bool] = None


class EquipmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    plant_id: UUID
    code: str
    name: str
    description: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    serial_number: Optional[str] = None
    manufacturing_year: Optional[int] = None
    location: Optional[str] = None
    status: EquipmentStatus
    # Effective operational status (kiosk machine / tickets / parent) — set by
    # the list endpoint; None on detail/create responses that don't compute it.
    live_status: Optional[str] = None
    criticality: str
    asset_type: str = "production"
    subtype: Optional[str] = None
    function_label: Optional[str] = None
    department: Optional[str] = None
    cost_center: Optional[str] = None
    family: Optional[str] = None
    pm_strategy: Optional[str] = None
    cleaning_priority: Optional[str] = None
    model_url: Optional[str] = None
    height_3d: Optional[float] = None
    model_scale: Optional[float] = None
    parent_equipment_id: Optional[UUID] = None
    hour_meter: float
    specifications: Dict[str, Any] = {}
    active: bool
    created_at: datetime


class EquipmentListResponse(BaseModel):
    total: int
    items: List[EquipmentOut]
