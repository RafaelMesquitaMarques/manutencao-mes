"""Pydantic schemas for the predictive intelligence API."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class SettingsUpdate(BaseModel):
    mode: Optional[str] = Field(None, pattern="^(off|silent|admin|active)$")
    eval_interval_min: Optional[int] = Field(None, ge=5, le=1440)
    baseline_refresh_hours: Optional[int] = Field(None, ge=1, le=168)
    weights: Optional[dict[str, float]] = None
    levels: Optional[dict[str, float]] = None
    windows: Optional[dict[str, float]] = None
    persistence_evals: Optional[int] = Field(None, ge=1, le=10)
    cooldown_hours: Optional[float] = Field(None, ge=0, le=168)
    confidence_floor: Optional[float] = Field(None, ge=0, le=1)
    fingerprint_windows_h: Optional[list[float]] = None
    prefailure_exclude_h: Optional[int] = Field(None, ge=1, le=168)
    baseline_window_days: Optional[int] = Field(None, ge=7, le=180)
    baseline_min_samples: Optional[int] = Field(None, ge=5, le=5000)
    baseline_drift_cap_pct: Optional[float] = Field(None, ge=1, le=500)


class MachineSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[str] = Field(None, pattern="^(off|silent|admin|active)$")
    overrides: Optional[dict[str, Any]] = None


class RuleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    equipment_id: Optional[UUID] = None
    metric_key: str = Field(..., min_length=1, max_length=120)
    aggregation: str = Field("avg", pattern="^(avg|max|min|last|slope|count)$")
    window_hours: float = Field(1.0, gt=0, le=168)
    operator: str = Field("gt", pattern="^(gt|lt)$")
    threshold: float
    severity: str = Field("alert", pattern="^(watch|alert|critical)$")
    enabled: bool = True


class RuleUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    metric_key: Optional[str] = None
    aggregation: Optional[str] = Field(None, pattern="^(avg|max|min|last|slope|count)$")
    window_hours: Optional[float] = Field(None, gt=0, le=168)
    operator: Optional[str] = Field(None, pattern="^(gt|lt)$")
    threshold: Optional[float] = None
    severity: Optional[str] = Field(None, pattern="^(watch|alert|critical)$")
    enabled: Optional[bool] = None


class AlertStatusUpdate(BaseModel):
    status: str = Field(..., pattern="^(new|in_review|inspection_planned|intervention_required|intervention_done|false_positive|monitoring|closed)$")
    assigned_to_id: Optional[UUID] = None
    inspection_due: Optional[datetime] = None
    inspection_result: Optional[str] = None


class FeedbackCreate(BaseModel):
    was_correct: Optional[bool] = None
    problem_found: Optional[bool] = None
    component: Optional[str] = Field(None, max_length=200)
    failure_mode: Optional[str] = Field(None, max_length=200)
    cause: Optional[str] = Field(None, max_length=500)
    timing: Optional[str] = Field(None, pattern="^(early|on_time|late)$")
    action_taken: Optional[str] = Field(None, max_length=500)
    part_replaced: Optional[bool] = None
    prevented_breakdown: Optional[bool] = None
    back_to_normal: Optional[bool] = None
    comments: Optional[str] = None


class BacktestRequest(BaseModel):
    equipment_id: UUID
    start: datetime
    end: datetime
    step_min: int = Field(60, ge=15, le=1440)


class FailureConfirm(BaseModel):
    confirmed: bool = True
    component: Optional[str] = Field(None, max_length=200)
    failure_type: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = None
