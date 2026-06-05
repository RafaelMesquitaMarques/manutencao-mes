"""
Modelos principais do banco de dados.
Estruturados para suportar multi-usina desde o início.
"""
import uuid
from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, Float, Boolean, DateTime, Date,
    ForeignKey, Text, Enum as SAEnum, JSON
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum

from app.db.base import Base


# ─── Enums ─────────────────────────────────────────────────────────────────────

class StatusOS(str, enum.Enum):
    open        = "open"
    in_progress = "in_progress"
    on_hold     = "on_hold"
    completed   = "completed"
    cancelled   = "cancelled"

class TipoOS(str, enum.Enum):
    corrective  = "corrective"
    preventive  = "preventive"
    predictive  = "predictive"
    inspection  = "inspection"
    improvement = "improvement"

class PrioridadeOS(str, enum.Enum):
    low      = "low"
    medium   = "medium"
    high     = "high"
    critical = "critical"

class RolUsuario(str, enum.Enum):
    tecnico          = "tecnico"
    supervisor       = "supervisor"
    gestor_usina     = "gestor_usina"
    diretor          = "diretor"
    admin            = "admin"

class StatusEquipamento(str, enum.Enum):
    operando      = "operando"
    em_manutencao = "em_manutencao"
    parado        = "parado"
    sucateado     = "sucateado"

class EspecialidadeTecnico(str, enum.Enum):
    electromechanical = "electromechanical"
    mechanical        = "mechanical"
    electrical        = "electrical"
    instrumentation   = "instrumentation"
    welding           = "welding"
    hydraulics        = "hydraulics"

class TurnoTecnico(str, enum.Enum):
    day      = "day"
    evening  = "evening"
    night    = "night"
    rotating = "rotating"

class ModoExecucao(str, enum.Enum):
    internal = "internal"
    external = "external"
    contract = "contract"

class TipoTransacaoCusto(str, enum.Enum):
    local_parts    = "local_parts"
    labor          = "labor"
    external_parts = "external_parts"
    contracts      = "contracts"
    rentals        = "rentals"
    other          = "other"

class StatusPedidoFornecedor(str, enum.Enum):
    pending   = "pending"
    partial   = "partial"
    received  = "received"
    cancelled = "cancelled"


# ─── Usina ─────────────────────────────────────────────────────────────────────

class Usina(Base):
    __tablename__ = "usinas"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    codigo     = Column(String(20), unique=True, nullable=False)
    nome       = Column(String(200), nullable=False)
    endereco   = Column(String(500))
    timezone   = Column(String(50), default="America/Toronto")
    ativa      = Column(Boolean, default=True)
    criado_em  = Column(DateTime(timezone=True), server_default=func.now())

    # Relacionamentos
    equipamentos = relationship("Equipamento", back_populates="usina")
    usuarios     = relationship("UsuarioUsina", back_populates="usina")


# ─── Usuário ───────────────────────────────────────────────────────────────────

class Usuario(Base):
    __tablename__ = "usuarios"

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    nome           = Column(String(200), nullable=False)
    email          = Column(String(200), unique=True, nullable=False)
    senha_hash     = Column(String(500), nullable=False)
    idioma         = Column(String(10), default="pt")   # pt | en | fr
    ativo          = Column(Boolean, default=True)
    criado_em      = Column(DateTime(timezone=True), server_default=func.now())

    usinas          = relationship("UsuarioUsina", back_populates="usuario")
    ordens_criadas  = relationship("OrdemServico", back_populates="criado_por", foreign_keys="OrdemServico.criado_por_id")
    ordens_exec     = relationship("OrdemServico", back_populates="executado_por", foreign_keys="OrdemServico.executado_por_id")
    tecnico_profile = relationship("Tecnico", back_populates="usuario", uselist=False)


class UsuarioUsina(Base):
    """Tabela de junção: usuário pode ter papéis diferentes em cada usina."""
    __tablename__ = "usuario_usinas"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    usuario_id = Column(UUID(as_uuid=True), ForeignKey("usuarios.id"), nullable=False)
    usina_id   = Column(UUID(as_uuid=True), ForeignKey("usinas.id"), nullable=False)
    papel      = Column(SAEnum(RolUsuario), default=RolUsuario.tecnico)

    usuario    = relationship("Usuario", back_populates="usinas")
    usina      = relationship("Usina", back_populates="usuarios")


# ─── Equipamento ───────────────────────────────────────────────────────────────

class Equipamento(Base):
    __tablename__ = "equipamentos"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    usina_id         = Column(UUID(as_uuid=True), ForeignKey("usinas.id"), nullable=False)
    codigo           = Column(String(50), nullable=False)
    nome             = Column(String(200), nullable=False)
    descricao        = Column(Text)
    fabricante       = Column(String(200))
    modelo           = Column(String(200))
    numero_serie     = Column(String(200))
    ano_fabricacao   = Column(Integer)
    localizacao      = Column(String(200))   # ex: "Linha 3 - Prensa A"
    status           = Column(SAEnum(StatusEquipamento), default=StatusEquipamento.operando)
    criticidade      = Column(String(20), default="media")  # baixa | media | alta | critica
    hora_metro       = Column(Float, default=0)             # horas de operação acumuladas
    especificacoes   = Column(JSON, default={})             # campos livres
    qr_code          = Column(String(500))
    ativo            = Column(Boolean, default=True)
    criado_em        = Column(DateTime(timezone=True), server_default=func.now())

    usina            = relationship("Usina", back_populates="equipamentos")
    ordens           = relationship("OrdemServico", back_populates="equipamento")
    planos           = relationship("PlanoManutencao", back_populates="equipamento")
    leituras_iot     = relationship("LeituraIoT", back_populates="equipamento")
    captores         = relationship("Captor", back_populates="equipamento")


# ─── Ordem de Serviço ──────────────────────────────────────────────────────────

class OrdemServico(Base):
    __tablename__ = "ordens_servico"

    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    numero            = Column(String(20), unique=True, nullable=False)  # ex: OS-2024-00042
    equipamento_id    = Column(UUID(as_uuid=True), ForeignKey("equipamentos.id"), nullable=False)
    criado_por_id     = Column(UUID(as_uuid=True), ForeignKey("usuarios.id"))
    executado_por_id  = Column(UUID(as_uuid=True), ForeignKey("usuarios.id"))
    plano_id          = Column(UUID(as_uuid=True), ForeignKey("planos_manutencao.id"), nullable=True)

    tipo              = Column(SAEnum(TipoOS, native_enum=False), nullable=False)
    prioridade        = Column(SAEnum(PrioridadeOS, native_enum=False), default=PrioridadeOS.medium)
    status            = Column(SAEnum(StatusOS, native_enum=False), default=StatusOS.open)

    titulo            = Column(String(500), nullable=False)
    short_description = Column(String(200))
    descricao         = Column(Text)
    causa_raiz        = Column(Text)
    solucao_aplicada  = Column(Text)
    diagnostic        = Column(Text)
    resolution        = Column(Text)

    data_abertura     = Column(DateTime(timezone=True), server_default=func.now())
    data_prevista     = Column(DateTime(timezone=True))
    data_inicio       = Column(DateTime(timezone=True))
    data_conclusao    = Column(DateTime(timezone=True))
    close_date        = Column(Date)

    tempo_parada_h    = Column(Float)
    tempo_reparo_h    = Column(Float)
    downtime_minutes  = Column(Integer)
    custo_total       = Column(Float)
    completion_ratio  = Column(Float, default=0)

    # Execution details
    executor_id       = Column(UUID(as_uuid=True), ForeignKey("tecnicos.id"), nullable=True)
    execution_mode    = Column(SAEnum(ModoExecucao, native_enum=False), default=ModoExecucao.internal)
    classification    = Column(String(100))
    failure_code      = Column(String(50))
    componente        = Column(String(200))
    tag               = Column(String(100))
    project_number    = Column(String(100))
    cost_center       = Column(String(100))
    counter_open      = Column(Float)
    counter_close     = Column(Float)

    # IoT origin
    origem_iot        = Column(Boolean, default=False)
    alerta_id         = Column(UUID(as_uuid=True), ForeignKey("alertas.id"), nullable=True)

    criado_em         = Column(DateTime(timezone=True), server_default=func.now())
    atualizado_em     = Column(DateTime(timezone=True), onupdate=func.now())

    equipamento       = relationship("Equipamento", back_populates="ordens")
    criado_por        = relationship("Usuario", back_populates="ordens_criadas", foreign_keys=[criado_por_id])
    executado_por     = relationship("Usuario", back_populates="ordens_exec",   foreign_keys=[executado_por_id])
    executor          = relationship("Tecnico", back_populates="ordens", foreign_keys=[executor_id])
    plano             = relationship("PlanoManutencao", back_populates="ordens")
    itens_estoque     = relationship("ItemOS", back_populates="ordem")
    labor_records     = relationship("RegistroLabor", back_populates="ordem", cascade="all, delete-orphan")
    wo_parts          = relationship("WOPart", back_populates="ordem", cascade="all, delete-orphan")
    wo_costs          = relationship("WOCost", back_populates="ordem", cascade="all, delete-orphan")
    wo_actions        = relationship("WOAction", back_populates="ordem", cascade="all, delete-orphan")
    supplier_orders   = relationship("SupplierOrder", back_populates="ordem", cascade="all, delete-orphan")


# ─── Plano de Manutenção ───────────────────────────────────────────────────────

class PlanoManutencao(Base):
    __tablename__ = "planos_manutencao"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    equipamento_id  = Column(UUID(as_uuid=True), ForeignKey("equipamentos.id"), nullable=False)
    nome            = Column(String(300), nullable=False)
    descricao       = Column(Text)
    tipo_gatilho    = Column(String(20))  # "calendario" | "horametro" | "ciclos"
    intervalo_dias  = Column(Integer)
    intervalo_horas = Column(Float)
    ultima_exec     = Column(DateTime(timezone=True))
    proxima_exec    = Column(DateTime(timezone=True))
    ativo           = Column(Boolean, default=True)
    checklist       = Column(JSON, default=[])   # lista de tarefas do plano
    criado_em       = Column(DateTime(timezone=True), server_default=func.now())

    equipamento     = relationship("Equipamento", back_populates="planos")
    ordens          = relationship("OrdemServico", back_populates="plano")


# ─── Estoque ───────────────────────────────────────────────────────────────────

class ItemEstoque(Base):
    __tablename__ = "itens_estoque"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    usina_id         = Column(UUID(as_uuid=True), ForeignKey("usinas.id"), nullable=False)
    codigo           = Column(String(100))
    nome             = Column(String(300), nullable=False)
    descricao        = Column(Text)
    unidade          = Column(String(20))   # un | kg | m | L
    quantidade       = Column(Float, default=0)
    quantidade_min   = Column(Float, default=0)   # ponto de reposição
    localizacao      = Column(String(200))
    custo_unitario   = Column(Float)
    fornecedor       = Column(String(300))
    criado_em        = Column(DateTime(timezone=True), server_default=func.now())

    usos_em_os       = relationship("ItemOS", back_populates="item_estoque")


class ItemOS(Base):
    """Peças/materiais consumidos em uma OS."""
    __tablename__ = "itens_os"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ordem_id         = Column(UUID(as_uuid=True), ForeignKey("ordens_servico.id"), nullable=False)
    item_estoque_id  = Column(UUID(as_uuid=True), ForeignKey("itens_estoque.id"), nullable=False)
    quantidade       = Column(Float, nullable=False)
    custo_unitario   = Column(Float)

    ordem            = relationship("OrdemServico", back_populates="itens_estoque")
    item_estoque     = relationship("ItemEstoque", back_populates="usos_em_os")


# ─── IoT / Captores ────────────────────────────────────────────────────────────

class Captor(Base):
    """Captor físico instalado em um equipamento."""
    __tablename__ = "captores"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    equipamento_id  = Column(UUID(as_uuid=True), ForeignKey("equipamentos.id"), nullable=False)
    codigo          = Column(String(100), nullable=False)   # id no MQTT topic
    nome            = Column(String(200))
    tipo            = Column(String(50))   # vibração | temperatura | corrente | pressão
    unidade         = Column(String(20))   # mm/s | °C | A | bar
    limite_min      = Column(Float)
    limite_max      = Column(Float)
    ativo           = Column(Boolean, default=True)
    criado_em       = Column(DateTime(timezone=True), server_default=func.now())

    equipamento     = relationship("Equipamento", back_populates="captores")
    leituras        = relationship("LeituraIoT", back_populates="captor")


class LeituraIoT(Base):
    """
    Série temporal de leituras dos captores.
    TimescaleDB cria automaticamente hypertable nesta tabela via init_db.sql
    """
    __tablename__ = "leituras_iot"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    captor_id       = Column(UUID(as_uuid=True), ForeignKey("captores.id"), nullable=False)
    equipamento_id  = Column(UUID(as_uuid=True), ForeignKey("equipamentos.id"), nullable=False)
    timestamp       = Column(DateTime(timezone=True), nullable=False, index=True)
    valor           = Column(Float, nullable=False)
    qualidade       = Column(String(10), default="ok")  # ok | erro | estimado

    captor          = relationship("Captor", back_populates="leituras")
    equipamento     = relationship("Equipamento", back_populates="leituras_iot")


class Alerta(Base):
    __tablename__ = "alertas"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    captor_id       = Column(UUID(as_uuid=True), ForeignKey("captores.id"), nullable=False)
    equipamento_id  = Column(UUID(as_uuid=True), ForeignKey("equipamentos.id"), nullable=False)
    tipo            = Column(String(50))
    severidade      = Column(String(20))
    valor_lido      = Column(Float)
    limite          = Column(Float)
    mensagem        = Column(Text)
    reconhecido     = Column(Boolean, default=False)
    os_gerada_id    = Column(UUID(as_uuid=True), nullable=True)
    criado_em       = Column(DateTime(timezone=True), server_default=func.now())


# ─── Técnico ───────────────────────────────────────────────────────────────────

class Tecnico(Base):
    __tablename__ = "tecnicos"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id          = Column(UUID(as_uuid=True), ForeignKey("usuarios.id"), unique=True, nullable=False)
    employee_number  = Column(String(50), unique=True)
    specialty        = Column(SAEnum(EspecialidadeTecnico, native_enum=False))
    shift            = Column(SAEnum(TurnoTecnico, native_enum=False))
    hourly_rate      = Column(Float)
    certifications   = Column(JSON, default=[])
    active           = Column(Boolean, default=True)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())

    usuario          = relationship("Usuario", back_populates="tecnico_profile")
    ordens           = relationship("OrdemServico", back_populates="executor", foreign_keys="OrdemServico.executor_id")
    labor_records    = relationship("RegistroLabor", back_populates="tecnico")


# ─── Registro de Labor ─────────────────────────────────────────────────────────

class RegistroLabor(Base):
    __tablename__ = "labor_records"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ordem_id         = Column(UUID(as_uuid=True), ForeignKey("ordens_servico.id"), nullable=False)
    tecnico_id       = Column(UUID(as_uuid=True), ForeignKey("tecnicos.id"), nullable=False)
    date             = Column(Date, nullable=False)
    hours_worked     = Column(Float, nullable=False)
    hourly_rate      = Column(Float)
    labor_cost       = Column(Float)
    activity         = Column(String(500))
    notes            = Column(Text)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())

    ordem            = relationship("OrdemServico", back_populates="labor_records")
    tecnico          = relationship("Tecnico", back_populates="labor_records")


# ─── WO Parts ──────────────────────────────────────────────────────────────────

class WOPart(Base):
    __tablename__ = "wo_parts"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ordem_id         = Column(UUID(as_uuid=True), ForeignKey("ordens_servico.id"), nullable=False)
    item_estoque_id  = Column(UUID(as_uuid=True), ForeignKey("itens_estoque.id"), nullable=True)
    part_number      = Column(String(100))
    description      = Column(String(500), nullable=False)
    quantity         = Column(Float, nullable=False)
    unit             = Column(String(20), default="un")
    unit_cost        = Column(Float)
    total_cost       = Column(Float)
    supplier         = Column(String(300))
    notes            = Column(Text)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())

    ordem            = relationship("OrdemServico", back_populates="wo_parts")
    item_estoque     = relationship("ItemEstoque")


# ─── WO Costs ──────────────────────────────────────────────────────────────────

class WOCost(Base):
    __tablename__ = "wo_costs"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ordem_id         = Column(UUID(as_uuid=True), ForeignKey("ordens_servico.id"), nullable=False)
    transaction_type = Column(SAEnum(TipoTransacaoCusto, native_enum=False), nullable=False)
    description      = Column(String(500), nullable=False)
    amount           = Column(Float, nullable=False)
    currency         = Column(String(10), default="CAD")
    reference        = Column(String(200))
    date             = Column(Date, nullable=False)
    notes            = Column(Text)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())

    ordem            = relationship("OrdemServico", back_populates="wo_costs")


# ─── WO Actions ────────────────────────────────────────────────────────────────

class WOAction(Base):
    __tablename__ = "wo_actions"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ordem_id         = Column(UUID(as_uuid=True), ForeignKey("ordens_servico.id"), nullable=False)
    author_id        = Column(UUID(as_uuid=True), ForeignKey("usuarios.id"), nullable=True)
    action_type      = Column(String(50), nullable=False)  # comment | status_change | assignment | attachment
    content          = Column(Text)
    old_value        = Column(String(200))
    new_value        = Column(String(200))
    created_at       = Column(DateTime(timezone=True), server_default=func.now())

    ordem            = relationship("OrdemServico", back_populates="wo_actions")
    author           = relationship("Usuario")


# ─── Supplier Orders ───────────────────────────────────────────────────────────

class SupplierOrder(Base):
    __tablename__ = "supplier_orders"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ordem_id         = Column(UUID(as_uuid=True), ForeignKey("ordens_servico.id"), nullable=True)
    supplier_name    = Column(String(300), nullable=False)
    po_number        = Column(String(100))
    description      = Column(Text)
    amount           = Column(Float)
    currency         = Column(String(10), default="CAD")
    status           = Column(SAEnum(StatusPedidoFornecedor, native_enum=False), default=StatusPedidoFornecedor.pending)
    ordered_at       = Column(Date)
    expected_at      = Column(Date)
    received_at      = Column(Date)
    notes            = Column(Text)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())

    ordem            = relationship("OrdemServico", back_populates="supplier_orders")
