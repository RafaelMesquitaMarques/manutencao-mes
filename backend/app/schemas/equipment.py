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
    specifications: Dict[str, Any] = {}


class EquipmentUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    location: Optional[str] = None
    status: Optional[EquipmentStatus] = None
    criticality: Optional[str] = None
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
    location: Optional[str] = None
    status: EquipmentStatus
    criticality: str
    hour_meter: float
    active: bool
    created_at: datetime


class EquipmentListResponse(BaseModel):
    total: int
    items: List[EquipmentOut]
