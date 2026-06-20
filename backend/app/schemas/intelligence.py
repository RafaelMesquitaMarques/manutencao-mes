"""
Pydantic schemas for the Maintenance Intelligence module.
All inputs/outputs for /api/intelligence/* endpoints.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class RiskLevel(str, Enum):
    low      = "low"
    medium   = "medium"
    high     = "high"
    critical = "critical"


class InsightType(str, Enum):
    daily_summary       = "daily_summary"
    machine_risk        = "machine_risk"
    top_irritants       = "top_irritants"
    trend_analysis      = "trend_analysis"
    spare_parts         = "spare_parts"
    technician_workload = "technician_workload"
    full_report         = "full_report"


class RecommendationStatus(str, Enum):
    pending      = "pending"
    acknowledged = "acknowledged"
    dismissed    = "dismissed"


class TrendDirection(str, Enum):
    improved    = "improved"
    stable      = "stable"
    deteriorated = "deteriorated"
    abnormal    = "abnormal"


# ---------------------------------------------------------------------------
# Sub-objects used inside findings / insights
# ---------------------------------------------------------------------------

class MachineRiskDetail(BaseModel):
    machine_id: str
    machine_name: str
    risk_level: RiskLevel
    ticket_count_period: int
    avg_mtbf_days: Optional[float]          # None = insufficient data
    days_since_last_ticket: Optional[float]
    mtbf_trend: Optional[TrendDirection]
    top_problem_types: list[str]
    criticality: Optional[str]              # from equipment table if linked


class IrritantDetail(BaseModel):
    rank: int
    machine_id: str
    machine_name: str
    ticket_count: int
    total_downtime_minutes: int
    avg_mttr_minutes: float
    avg_mtbf_days: Optional[float]
    top_problem_type: str
    risk_level: RiskLevel
    recurrence_score: float                 # 0-1, higher = more repetitive


class TrendItem(BaseModel):
    metric: str                             # e.g. "MTTR", "MTBF", "ticket_count"
    entity_name: str                        # machine name, technician name, etc.
    current_value: float
    previous_value: float
    change_pct: float                       # positive = increase
    direction: TrendDirection
    unit: str                               # "minutes", "days", "count", etc.


class SparePartRiskDetail(BaseModel):
    stock_item_id: str
    part_code: str
    part_name: str
    current_qty: float
    min_qty: float
    consumption_last_30d: float
    avg_consumption_30d: float              # historical average
    consumption_trend: TrendDirection
    linked_machines: list[str]             # machine names that used this part
    risk_level: RiskLevel
    days_until_stockout: Optional[float]   # None = cannot estimate


class TechnicianWorkloadDetail(BaseModel):
    technician_id: str
    technician_name: str
    specialty: str
    ticket_count: int
    total_hours: float
    avg_resolution_minutes: float
    workload_level: RiskLevel              # reusing RiskLevel: low=light, critical=overloaded
    pct_of_team_tickets: float


# ---------------------------------------------------------------------------
# Core findings object — output of calculation engine, input to AI layer
# ---------------------------------------------------------------------------

class IntelligenceFindings(BaseModel):
    """
    Structured findings produced by the deterministic calculation engine.
    This is what gets sent to the AI layer for language generation.
    All values are facts derived from real data — never invented.
    """
    period_start: datetime
    period_end: datetime
    plant_id: Optional[str]

    # Summary counts
    total_tickets: int
    total_alerts: int
    total_downtime_minutes: int
    overdue_alerts: int

    # MTTR
    avg_mttr_minutes: float
    mttr_trend: TrendDirection
    mttr_change_pct: float

    # MTBF (calculated from ticket intervals)
    machines_with_mtbf: int                # how many machines have enough data
    avg_mtbf_days: Optional[float]
    mtbf_trend: Optional[TrendDirection]
    mtbf_change_pct: Optional[float]

    # Machine risk
    machine_risks: list[MachineRiskDetail]
    critical_machines: int
    high_risk_machines: int

    # Top irritants
    top_irritants: list[IrritantDetail]

    # Trends
    trends: list[TrendItem]

    # Spare parts
    spare_parts_at_risk: list[SparePartRiskDetail]
    parts_below_minimum: int

    # Technician workload
    technician_workload: list[TechnicianWorkloadDetail]
    concentration_risk: bool               # True if >60% tickets on <=2 technicians

    # Data quality flags
    insufficient_data_warnings: list[str]  # e.g. "Machine X has only 1 ticket — MTBF not calculated"


# ---------------------------------------------------------------------------
# Stored models (DB → API output)
# ---------------------------------------------------------------------------

class RecommendationOut(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    insight_id: uuid.UUID
    title: str
    evidence: str
    impact: str
    recommendation: str
    risk_level: RiskLevel
    # Defaults so the route can validate from column-only dicts.
    # related_machine_name is never a DB column — it stays None unless resolved.
    related_machine_name: Optional[str] = None
    related_category: Optional[str] = None
    confidence: Optional[float] = None
    status: RecommendationStatus
    acknowledged_by: Optional[str] = None
    acknowledged_at: Optional[datetime] = None
    created_at: datetime


class InsightOut(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    plant_id: Optional[uuid.UUID] = None
    insight_type: InsightType
    language: str
    period_start: datetime
    period_end: datetime
    findings_json: dict[str, Any]
    insight_text: str                      # AI-generated natural language (or structured fallback)
    ai_generated: bool                     # False if no API key configured
    generated_at: datetime
    generated_by_model: Optional[str] = None
    recommendations: list[RecommendationOut] = []


class MachineRiskScoreOut(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    machine_id: Optional[uuid.UUID] = None
    machine_name: str
    score: float                           # 0-100
    risk_level: RiskLevel
    hours_since_last_ticket: Optional[float] = None
    historical_mtbf_hours: Optional[float] = None
    recent_ticket_count: int
    criticality_factor: float
    computed_at: datetime


class SparePartRiskOut(BaseModel):
    model_config = {"from_attributes": True}

    id: uuid.UUID
    stock_item_id: uuid.UUID
    part_code: str
    part_name: str
    current_qty: float
    safety_qty: float
    avg_consumption_30d: float
    recent_consumption_30d: float
    risk_level: RiskLevel
    computed_at: datetime


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------

class GenerateInsightRequest(BaseModel):
    language: str = Field(default="en", pattern="^(en|fr|es)$")
    period_days: int = Field(default=7, ge=1, le=90)
    insight_type: InsightType = Field(default=InsightType.full_report)
    plant_id: Optional[uuid.UUID] = None


class AcknowledgeRecommendationRequest(BaseModel):
    acknowledged_by: str = Field(..., min_length=1, max_length=200)


# ---------------------------------------------------------------------------
# Conversational Q&A (tool-use chat)
# ---------------------------------------------------------------------------

class ChatMessageIn(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = Field(..., min_length=1, max_length=8000)


class ChatAskRequest(BaseModel):
    messages: list[ChatMessageIn] = Field(..., min_length=1, max_length=40)
    language: str = "en"


class ChatAskResponse(BaseModel):
    answer: str
    used_tools: list[str] = []
    ai_generated: bool = True


# ---------------------------------------------------------------------------
# List responses
# ---------------------------------------------------------------------------

class InsightListResponse(BaseModel):
    total: int
    items: list[InsightOut]


class MachineRiskListResponse(BaseModel):
    total: int
    items: list[MachineRiskScoreOut]


class SparePartRiskListResponse(BaseModel):
    total: int
    items: list[SparePartRiskOut]
