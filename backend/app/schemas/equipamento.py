from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, List, Dict, Any
from uuid import UUID
from datetime import datetime
from app.models.models import StatusEquipamento


class EquipamentoCreate(BaseModel):
    usina_id: UUID
    codigo: str
    nome: str
    descricao: Optional[str] = None
    fabricante: Optional[str] = None
    modelo: Optional[str] = None
    numero_serie: Optional[str] = None
    ano_fabricacao: Optional[int] = None
    localizacao: Optional[str] = None
    criticidade: str = "media"
    especificacoes: Dict[str, Any] = {}


class EquipamentoUpdate(BaseModel):
    nome: Optional[str] = None
    descricao: Optional[str] = None
    localizacao: Optional[str] = None
    status: Optional[StatusEquipamento] = None
    criticidade: Optional[str] = None
    hora_metro: Optional[float] = None
    especificacoes: Optional[Dict[str, Any]] = None
    ativo: Optional[bool] = None


class EquipamentoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: UUID
    usina_id: UUID
    code: str = Field(validation_alias='codigo')
    name: str = Field(validation_alias='nome')
    description: Optional[str] = Field(default=None, validation_alias='descricao')
    manufacturer: Optional[str] = Field(default=None, validation_alias='fabricante')
    location: Optional[str] = Field(default=None, validation_alias='localizacao')
    status: StatusEquipamento
    criticality: str = Field(validation_alias='criticidade')
    hour_meter: float = Field(validation_alias='hora_metro')
    active: bool = Field(validation_alias='ativo')
    created_at: datetime = Field(validation_alias='criado_em')


class EquipamentoListResponse(BaseModel):
    total: int
    items: List[EquipamentoOut]
