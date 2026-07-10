"""Technician availability resolution.

Answers "can this technician be treated as available right now (or at a given
instant) for planning, assignment, capacity, and labor?" by combining:

  * global active/inactive status (``technicians.active`` and ``users.active``);
  * the assigned work shift + its clock window (``shift_templates``);
  * scheduled breaks / lunch inside that shift (``shift_breaks``);
  * vacation / absence / unavailability periods (``technician_unavailability``).

This is advisory: the UI uses it to warn before assigning an unavailable
technician (never to silently block), and reports use it for capacity. It has no
effect on machine downtime or MTTR.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    ShiftBreakKind, Technician, TechnicianUnavailability, User,
)
from app.services import labor_time_service as lts

# Status values (stable strings the frontend maps to i18n keys under
# `availability.*`). "available" is the only assignable-without-warning state.
INACTIVE = "inactive"          # global active flag off (technician or user)
ON_VACATION = "on_vacation"    # covered by a vacation period
UNAVAILABLE = "unavailable"    # covered by a non-vacation unavailability period
OFF_SHIFT = "off_shift"        # outside the shift window
AT_LUNCH = "at_lunch"          # inside a lunch break
ON_BREAK = "on_break"          # inside a short break / pause
AVAILABLE = "available"        # working, on shift, not on break

# Reasons that make assignment questionable → UI shows a warning + confirm.
WARN_STATUSES = {INACTIVE, ON_VACATION, UNAVAILABLE, OFF_SHIFT}


@dataclass
class Availability:
    status: str
    available: bool                 # True only when status == AVAILABLE
    should_warn: bool               # UI should warn+confirm before assigning
    detail: Optional[str] = None    # e.g. unavailability type or shift name
    has_schedule: bool = False      # a shift template was found


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


async def availability_at(
    db: AsyncSession, technician: Technician, at: Optional[datetime] = None,
) -> Availability:
    """Resolve availability for ``technician`` at instant ``at`` (default: now).

    Precedence: inactive → unavailability period → off-shift → on break/lunch →
    available. When no shift template is configured we cannot tell on/off shift,
    so we only report inactive/unavailability and otherwise ``available`` with
    ``has_schedule=False`` (conservative: never a false "off_shift")."""
    now = _as_utc(at) if at else datetime.now(timezone.utc)

    # 1) global active flags
    if not technician.active:
        return Availability(INACTIVE, False, True, detail="technician", has_schedule=False)
    user = await db.get(User, technician.user_id) if technician.user_id else None
    if user is not None and not user.active:
        return Availability(INACTIVE, False, True, detail="user", has_schedule=False)

    tz = ZoneInfo(lts.DEFAULT_TZ)
    local_date = now.astimezone(tz).date()

    # 2) unavailability periods (vacation / absence / …)
    row = (await db.execute(
        select(TechnicianUnavailability.type)
        .where(
            TechnicianUnavailability.technician_id == technician.id,
            TechnicianUnavailability.start_date <= local_date,
            TechnicianUnavailability.end_date >= local_date,
        ).limit(1)
    )).first()
    if row is not None:
        utype = row[0].value if hasattr(row[0], "value") else row[0]
        status = ON_VACATION if utype == "vacation" else UNAVAILABLE
        return Availability(status, False, True, detail=utype, has_schedule=False)

    # 3) shift window + breaks
    tpl = await lts._shift_template_for(db, technician)
    if tpl is None:
        # No schedule known → don't fabricate an off-shift state.
        return Availability(AVAILABLE, True, False, has_schedule=False)

    span = (now - timedelta(minutes=1), now + timedelta(minutes=1))
    shift_windows = lts.build_shift_windows(tpl.start_time, tpl.end_time, span, tz)
    in_shift = any(s <= now < e for s, e in shift_windows)
    if not in_shift:
        return Availability(OFF_SHIFT, False, True, detail=tpl.name or tpl.key, has_schedule=True)

    # inside shift: check breaks (lunch vs other) for a precise state
    for b in (tpl.breaks or []):
        windows = lts.build_break_windows(tpl.start_time, [(b.start_time, b.end_time)], span, tz)
        if any(s <= now < e for s, e in windows):
            kind = b.kind.value if hasattr(b.kind, "value") else b.kind
            status = AT_LUNCH if kind == ShiftBreakKind.lunch.value else ON_BREAK
            return Availability(status, False, False, detail=b.name or kind, has_schedule=True)

    return Availability(AVAILABLE, True, False, detail=tpl.name or tpl.key, has_schedule=True)
