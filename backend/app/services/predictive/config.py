"""Effective predictive configuration: plant settings + per-machine overrides.

All tuning lives in the DB (predictive_settings / predictive_machine_settings);
the constants here are only the fallback defaults for absent JSON fields, so
thresholds are adjustable at runtime without code changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    Equipment,
    PredictiveConfigLog,
    PredictiveMachineSettings,
    PredictiveMode,
    PredictiveSettings,
)

DEFAULT_WEIGHTS: dict[str, float] = {
    "vibration_anomaly": 20.0,
    "temperature_anomaly": 15.0,
    "pressure_anomaly": 5.0,
    "degradation_trend": 15.0,
    "microstops": 10.0,
    "stop_minutes": 10.0,
    "production_drop": 5.0,
    "alarm_activity": 5.0,
    "mtbf_consumed": 15.0,
    "mtbf_declining": 10.0,
    "pattern_similarity": 10.0,
    # Rule hits add on top of the analytic factors.
    "rule_watch": 10.0,
    "rule_alert": 20.0,
    "rule_critical": 40.0,
}

DEFAULT_LEVELS: dict[str, float] = {"watch": 25.0, "alert": 50.0, "critical": 70.0, "deadband": 5.0}
DEFAULT_WINDOWS: dict[str, float] = {"short_h": 1.0, "medium_h": 8.0, "long_h": 24.0, "trend_h": 6.0}
DEFAULT_FP_WINDOWS: list[float] = [1.0, 4.0, 24.0]

# Weight sum used for the "how much of the signal do we actually have" part of
# confidence (rules excluded — they are extras, not expected signals).
CORE_FACTORS = (
    "vibration_anomaly", "temperature_anomaly", "pressure_anomaly", "degradation_trend",
    "microstops", "stop_minutes", "production_drop", "alarm_activity",
    "mtbf_consumed", "mtbf_declining", "pattern_similarity",
)

CRITICALITY_MULT = {"low": 0.9, "medium": 1.0, "high": 1.1, "critical": 1.2}

MANAGER_ROLES = {"supervisor", "maintenance_director", "plant_manager", "director", "admin"}


def mode_visible_for(role, mode: Optional[str]) -> bool:
    """Activation-ladder visibility, shared by every read surface (predictive
    routes, factory map): silent → admins only; admin → supervisor+; active →
    anyone who reached the endpoint."""
    role = role.value if hasattr(role, "value") else str(role)
    if role == "admin":
        return True
    if mode == "active":
        return True
    if mode == "admin":
        return role in MANAGER_ROLES
    return False


@dataclass
class EffectiveConfig:
    plant_id: Any
    mode: str = "off"
    eval_interval_min: int = 15
    baseline_refresh_hours: int = 24
    weights: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))
    levels: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_LEVELS))
    windows: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_WINDOWS))
    persistence_evals: int = 2
    cooldown_hours: float = 12.0
    confidence_floor: float = 0.35
    fingerprint_windows_h: list[float] = field(default_factory=lambda: list(DEFAULT_FP_WINDOWS))
    prefailure_exclude_h: int = 24
    baseline_window_days: int = 30
    baseline_min_samples: int = 50
    baseline_drift_cap_pct: float = 25.0
    version: int = 0


def _merge_dict(base: dict, override: Optional[dict]) -> dict:
    out = dict(base)
    for k, v in (override or {}).items():
        if v is not None:
            out[k] = v
    return out


def effective_config(
    settings: Optional[PredictiveSettings],
    machine: Optional[PredictiveMachineSettings] = None,
) -> EffectiveConfig:
    """Fold the plant row + optional machine override into one config."""
    cfg = EffectiveConfig(plant_id=getattr(settings, "plant_id", None))
    if settings is not None:
        cfg.mode = settings.mode.value if hasattr(settings.mode, "value") else str(settings.mode or "off")
        cfg.eval_interval_min = settings.eval_interval_min or 15
        cfg.baseline_refresh_hours = settings.baseline_refresh_hours or 24
        cfg.weights = _merge_dict(DEFAULT_WEIGHTS, settings.weights)
        cfg.levels = _merge_dict(DEFAULT_LEVELS, settings.levels)
        cfg.windows = _merge_dict(DEFAULT_WINDOWS, settings.windows)
        cfg.persistence_evals = settings.persistence_evals or 2
        cfg.cooldown_hours = settings.cooldown_hours if settings.cooldown_hours is not None else 12.0
        cfg.confidence_floor = settings.confidence_floor if settings.confidence_floor is not None else 0.35
        cfg.fingerprint_windows_h = list(settings.fingerprint_windows_h or DEFAULT_FP_WINDOWS)
        cfg.prefailure_exclude_h = settings.prefailure_exclude_h or 24
        cfg.baseline_window_days = settings.baseline_window_days or 30
        cfg.baseline_min_samples = settings.baseline_min_samples or 50
        cfg.baseline_drift_cap_pct = settings.baseline_drift_cap_pct or 25.0
        cfg.version = settings.version or 1
    if machine is not None:
        if machine.enabled is False:
            cfg.mode = "off"
        elif machine.mode is not None:
            cfg.mode = machine.mode.value if hasattr(machine.mode, "value") else str(machine.mode)
        ov = machine.overrides or {}
        cfg.weights = _merge_dict(cfg.weights, ov.get("weights"))
        cfg.levels = _merge_dict(cfg.levels, ov.get("levels"))
        cfg.windows = _merge_dict(cfg.windows, ov.get("windows"))
    return cfg


async def get_plant_settings(
    db: AsyncSession, plant_id, *, create: bool = False
) -> Optional[PredictiveSettings]:
    row = (await db.execute(
        select(PredictiveSettings).where(PredictiveSettings.plant_id == plant_id)
    )).scalar_one_or_none()
    if row is None and create:
        row = PredictiveSettings(plant_id=plant_id, mode=PredictiveMode.off)
        db.add(row)
        await db.flush()
    return row


async def get_machine_settings(
    db: AsyncSession, equipment_id
) -> Optional[PredictiveMachineSettings]:
    return (await db.execute(
        select(PredictiveMachineSettings).where(PredictiveMachineSettings.equipment_id == equipment_id)
    )).scalar_one_or_none()


async def effective_for_equipment(db: AsyncSession, equipment: Equipment) -> EffectiveConfig:
    settings = await get_plant_settings(db, equipment.plant_id)
    machine = await get_machine_settings(db, equipment.id)
    return effective_config(settings, machine)


async def log_config_change(db: AsyncSession, plant_id, version: int, payload: dict, user_id=None) -> None:
    db.add(PredictiveConfigLog(
        plant_id=plant_id, version=version, payload=payload, changed_by_id=user_id,
    ))
