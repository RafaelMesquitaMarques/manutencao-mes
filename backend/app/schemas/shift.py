from pydantic import BaseModel, ConfigDict, field_validator
from typing import Optional, List
from uuid import UUID
from datetime import datetime, date

from app.models.models import ShiftBreakKind, UnavailabilityType


def _valid_hm(v: str) -> str:
    try:
        h, m = [int(x) for x in str(v).split(":")[:2]]
        assert 0 <= h <= 23 and 0 <= m <= 59
    except (ValueError, TypeError, AssertionError):
        raise ValueError("time must be 'HH:MM'")
    return f"{h:02d}:{m:02d}"


# ── Shift templates & breaks ─────────────────────────────────────────────────

class ShiftBreakIn(BaseModel):
    kind: ShiftBreakKind = ShiftBreakKind.short_break
    name: str = ""
    start_time: str
    end_time: str
    paid: bool = False

    @field_validator("start_time", "end_time")
    @classmethod
    def _v_hm(cls, v: str) -> str:
        return _valid_hm(v)


class ShiftBreakOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    kind: ShiftBreakKind
    name: str
    start_time: str
    end_time: str
    paid: bool


class ShiftTemplateCreate(BaseModel):
    key: str
    name: str = ""
    start_time: str
    end_time: str
    active: bool = True
    plant_id: Optional[UUID] = None
    breaks: List[ShiftBreakIn] = []

    @field_validator("start_time", "end_time")
    @classmethod
    def _v_hm(cls, v: str) -> str:
        return _valid_hm(v)


class ShiftTemplateUpdate(BaseModel):
    key: Optional[str] = None
    name: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    active: Optional[bool] = None
    plant_id: Optional[UUID] = None
    # When provided, replaces the whole break set (None = leave breaks untouched).
    breaks: Optional[List[ShiftBreakIn]] = None


class ShiftTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    plant_id: Optional[UUID] = None
    key: str
    name: str
    start_time: str
    end_time: str
    active: bool
    breaks: List[ShiftBreakOut] = []


# ── Technician unavailability ────────────────────────────────────────────────

class UnavailabilityCreate(BaseModel):
    type: UnavailabilityType = UnavailabilityType.vacation
    start_date: date
    end_date: date
    notes: Optional[str] = None


class UnavailabilityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    technician_id: UUID
    type: UnavailabilityType
    start_date: date
    end_date: date
    notes: Optional[str] = None
    created_by_id: Optional[UUID] = None
    created_at: datetime
    technician_name: Optional[str] = None


# ── Availability (computed) ──────────────────────────────────────────────────

class AvailabilityOut(BaseModel):
    status: str                         # active/available flavor; maps to i18n availability.*
    available: bool
    should_warn: bool
    detail: Optional[str] = None
    has_schedule: bool = False
