from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime
from app.models.models import TechnicianSpecialty, TechnicianShift


class TechnicianCreate(BaseModel):
    user_id: UUID
    employee_number: Optional[str] = None
    specialty: Optional[TechnicianSpecialty] = None
    shift: Optional[TechnicianShift] = None
    hourly_rate: Optional[float] = None
    certifications: Optional[List[str]] = []


class TechnicianOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    employee_number: Optional[str] = None
    specialty: Optional[TechnicianSpecialty] = None
    shift: Optional[TechnicianShift] = None
    hourly_rate: Optional[float] = None
    certifications: List[str] = []
    active: bool
    created_at: datetime
    full_name: Optional[str] = None
    email: Optional[str] = None


class TechnicianListResponse(BaseModel):
    total: int
    items: List[TechnicianOut]
