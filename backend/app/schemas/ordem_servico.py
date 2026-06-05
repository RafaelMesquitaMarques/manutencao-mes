from pydantic import BaseModel, Field, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime, date
from app.models.models import StatusOS, TipoOS, PrioridadeOS, ModoExecucao


class OSCreate(BaseModel):
    equipment_id: UUID
    type: TipoOS
    priority: PrioridadeOS = PrioridadeOS.medium
    title: str
    short_description: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[datetime] = None
    assigned_to_id: Optional[UUID] = None
    executor_id: Optional[UUID] = None
    execution_mode: Optional[ModoExecucao] = ModoExecucao.internal
    classification: Optional[str] = None
    failure_code: Optional[str] = None
    tag: Optional[str] = None
    componente: Optional[str] = None
    project_number: Optional[str] = None
    cost_center: Optional[str] = None


class OSUpdate(BaseModel):
    """Internal PATCH — uses ORM column names directly."""
    status: Optional[StatusOS] = None
    prioridade: Optional[PrioridadeOS] = None
    titulo: Optional[str] = None
    descricao: Optional[str] = None
    causa_raiz: Optional[str] = None
    solucao_aplicada: Optional[str] = None
    data_prevista: Optional[datetime] = None
    data_inicio: Optional[datetime] = None
    data_conclusao: Optional[datetime] = None
    tempo_parada_h: Optional[float] = None
    tempo_reparo_h: Optional[float] = None
    custo_total: Optional[float] = None
    executado_por_id: Optional[UUID] = None


class OSOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: UUID
    wo_number: str = Field(validation_alias='numero')
    equipment_id: UUID = Field(validation_alias='equipamento_id')
    equipment_name: Optional[str] = None
    equipment_location: Optional[str] = None
    created_by_id: Optional[UUID] = Field(default=None, validation_alias='criado_por_id')
    assigned_to_id: Optional[UUID] = Field(default=None, validation_alias='executado_por_id')
    executor_id: Optional[UUID] = None
    type: TipoOS = Field(validation_alias='tipo')
    priority: PrioridadeOS = Field(validation_alias='prioridade')
    status: StatusOS
    title: str = Field(validation_alias='titulo')
    short_description: Optional[str] = None
    description: Optional[str] = Field(default=None, validation_alias='descricao')
    root_cause: Optional[str] = Field(default=None, validation_alias='causa_raiz')
    solution: Optional[str] = Field(default=None, validation_alias='solucao_aplicada')
    diagnostic: Optional[str] = None
    resolution: Optional[str] = None
    opened_at: datetime = Field(validation_alias='data_abertura')
    due_date: Optional[datetime] = Field(default=None, validation_alias='data_prevista')
    started_at: Optional[datetime] = Field(default=None, validation_alias='data_inicio')
    completed_at: Optional[datetime] = Field(default=None, validation_alias='data_conclusao')
    close_date: Optional[date] = None
    downtime_hours: Optional[float] = Field(default=None, validation_alias='tempo_parada_h')
    downtime_minutes: Optional[int] = None
    repair_hours: Optional[float] = Field(default=None, validation_alias='tempo_reparo_h')
    completion_ratio: Optional[float] = None
    total_cost: Optional[float] = Field(default=None, validation_alias='custo_total')
    execution_mode: Optional[ModoExecucao] = None
    classification: Optional[str] = None
    failure_code: Optional[str] = None
    componente: Optional[str] = None
    tag: Optional[str] = None
    counter_open: Optional[float] = None
    counter_close: Optional[float] = None
    project_number: Optional[str] = None
    cost_center: Optional[str] = None
    from_iot: bool = Field(validation_alias='origem_iot')


class OSListResponse(BaseModel):
    total: int
    items: List[OSOut]
