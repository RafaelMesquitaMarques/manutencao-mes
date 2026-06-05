from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime
from app.models.models import EspecialidadeTecnico, TurnoTecnico


class TecnicoCreate(BaseModel):
    user_id: UUID
    employee_number: Optional[str] = None
    specialty: Optional[EspecialidadeTecnico] = None
    shift: Optional[TurnoTecnico] = None
    hourly_rate: Optional[float] = None
    certifications: Optional[List[str]] = []


class TecnicoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    employee_number: Optional[str] = None
    specialty: Optional[EspecialidadeTecnico] = None
    shift: Optional[TurnoTecnico] = None
    hourly_rate: Optional[float] = None
    certifications: List[str] = []
    active: bool
    created_at: datetime
    full_name: Optional[str] = None
    email: Optional[str] = None


class TecnicoListResponse(BaseModel):
    total: int
    items: List[TecnicoOut]
