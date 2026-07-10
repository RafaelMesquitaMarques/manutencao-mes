"""Effective labor-time calculation.

Separates two concepts that KAIZO must never conflate:

  * **Machine downtime / MTTR / stop duration** — wall-clock time the machine is
    unavailable until production resumes. Computed elsewhere from timestamps
    (``machine_stops``, ``machine_interventions``, ``work_orders.repair_hours``).
    This module NEVER touches it.

  * **Effective labor time** — the technician's *paid working* time applied to an
    intervention. Equal to the raw assigned span MINUS overlapping non-working
    intervals: off-shift time (unless approved overtime), lunch, breaks, and
    vacation/unavailability. This is what drives ``labor_cost``.

The core (:func:`compute_breakdown`) is a pure function over UTC interval lists
so it is trivially unit-testable. The async helpers build those intervals from a
technician's shift template + breaks + unavailability and the plant timezone.

Design rules baked in here:
  * ``hours_worked`` (raw) is preserved by callers; only ``effective_hours`` /
    ``labor_cost`` use this module. Downtime and MTTR stay raw.
  * When a technician has no shift schedule configured, or data is incomplete
    (common for historical records), we fall back to ``effective == raw`` and set
    ``has_schedule = False`` rather than guessing — never destroying information.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional, Sequence, Tuple
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.models import (
    Equipment, LaborRecord, Plant, ShiftBreak, ShiftTemplate,
    Technician, TechnicianUnavailability, WorkOrder,
)

# Interval = (start, end) as timezone-aware UTC datetimes, start < end.
Interval = Tuple[datetime, datetime]

DEFAULT_TZ = "America/Toronto"   # Foliot plant timezone (see CONTEXT.md)


# ── interval algebra (pure) ──────────────────────────────────────────────────

def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def total_minutes(intervals: Sequence[Interval]) -> float:
    return sum(max(0.0, (e - s).total_seconds()) for s, e in intervals) / 60.0


def _normalize(intervals: Sequence[Interval]) -> List[Interval]:
    """Sort, drop empties, and merge overlapping/adjacent intervals."""
    clean = [(s, e) for s, e in intervals if e > s]
    if not clean:
        return []
    clean.sort()
    merged = [clean[0]]
    for s, e in clean[1:]:
        ls, le = merged[-1]
        if s <= le:
            merged[-1] = (ls, max(le, e))
        else:
            merged.append((s, e))
    return merged


def intersect(a: Sequence[Interval], b: Sequence[Interval]) -> List[Interval]:
    """Intervals present in BOTH a and b."""
    aa, bb = _normalize(a), _normalize(b)
    out: List[Interval] = []
    i = j = 0
    while i < len(aa) and j < len(bb):
        s = max(aa[i][0], bb[j][0])
        e = min(aa[i][1], bb[j][1])
        if e > s:
            out.append((s, e))
        if aa[i][1] < bb[j][1]:
            i += 1
        else:
            j += 1
    return out


def subtract(a: Sequence[Interval], b: Sequence[Interval]) -> List[Interval]:
    """Intervals in a with any part of b removed."""
    aa, bb = _normalize(a), _normalize(b)
    if not bb:
        return aa
    out: List[Interval] = []
    for s, e in aa:
        cur = s
        for bs, be in bb:
            if be <= cur or bs >= e:
                continue
            if bs > cur:
                out.append((cur, min(bs, e)))
            cur = max(cur, be)
            if cur >= e:
                break
        if cur < e:
            out.append((cur, e))
    return _normalize(out)


# ── result shape ─────────────────────────────────────────────────────────────

@dataclass
class LaborBreakdown:
    """Full accounting for one labor span. Minutes are floats.

    ``deducted_minutes`` is the sum of the three deduction buckets and equals
    ``raw_minutes - effective_minutes``. ``has_schedule`` is False when no shift
    template was available (fallback: effective == raw)."""
    raw_minutes: float
    effective_minutes: float
    deducted_minutes: float
    off_shift_minutes: float = 0.0
    break_minutes: float = 0.0
    unavailable_minutes: float = 0.0
    has_schedule: bool = False
    overtime_approved: bool = False

    @property
    def raw_hours(self) -> float:
        return round(self.raw_minutes / 60.0, 4)

    @property
    def effective_hours(self) -> float:
        return round(self.effective_minutes / 60.0, 4)


def compute_breakdown(
    started_at: datetime,
    stopped_at: datetime,
    *,
    shift_windows: Optional[Sequence[Interval]],
    break_windows: Sequence[Interval] = (),
    unavailable_windows: Sequence[Interval] = (),
    overtime_approved: bool = False,
) -> LaborBreakdown:
    """Pure effective-time calculation over UTC intervals.

    ``shift_windows`` = the technician's working windows overlapping the span, or
    ``None`` when no schedule is known (→ no off-shift clipping, ``has_schedule``
    False). ``break_windows`` / ``unavailable_windows`` are the non-working
    intervals to subtract. When ``overtime_approved`` is True, off-shift time is
    NOT clipped (the whole span counts, minus breaks/unavailability).

    The three deduction buckets are disjoint (computed by successive subtraction)
    so they sum exactly to ``deducted_minutes``.
    """
    s = _as_utc(started_at)
    e = _as_utc(stopped_at)
    if e <= s:
        return LaborBreakdown(0.0, 0.0, 0.0, has_schedule=shift_windows is not None,
                              overtime_approved=overtime_approved)

    base: List[Interval] = [(s, e)]
    raw = total_minutes(base)
    has_schedule = shift_windows is not None

    # 1) off-shift clipping (skipped for approved overtime or when no schedule)
    if overtime_approved or shift_windows is None:
        after_shift = list(base)
    else:
        after_shift = intersect(base, shift_windows)
    off_shift = raw - total_minutes(after_shift)

    # 2) breaks / lunch
    after_break = subtract(after_shift, break_windows)
    break_min = total_minutes(after_shift) - total_minutes(after_break)

    # 3) vacation / unavailability
    after_unavail = subtract(after_break, unavailable_windows)
    unavail_min = total_minutes(after_break) - total_minutes(after_unavail)

    effective = total_minutes(after_unavail)
    deducted = max(0.0, raw - effective)
    return LaborBreakdown(
        raw_minutes=round(raw, 4),
        effective_minutes=round(effective, 4),
        deducted_minutes=round(deducted, 4),
        off_shift_minutes=round(max(0.0, off_shift), 4),
        break_minutes=round(max(0.0, break_min), 4),
        unavailable_minutes=round(max(0.0, unavail_min), 4),
        has_schedule=has_schedule,
        overtime_approved=overtime_approved,
    )


# ── window builders (pure, tz-aware) ─────────────────────────────────────────

def _parse(value: str) -> Optional[Tuple[int, int]]:
    """Parse "HH:MM" → (hour, minute), or None if malformed/out of range."""
    try:
        h, m = [int(x) for x in str(value).split(":")[:2]]
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h, m
    except (ValueError, TypeError, AttributeError):
        return None
    return None


def build_shift_windows(
    start_hm: str, end_hm: str, span: Interval, tz: ZoneInfo,
) -> List[Interval]:
    """Concrete UTC shift windows (one per day) overlapping ``span``. HH:MM are
    plant-local wall clock. Overnight shifts (end <= start) roll to the next day.
    Iterates the local dates the span could touch (± 1 day for overnight)."""
    s = _parse(start_hm)
    e = _parse(end_hm)
    if not s or not e:
        return []
    span_s, span_e = _as_utc(span[0]), _as_utc(span[1])
    first = span_s.astimezone(tz).date() - timedelta(days=1)
    last = span_e.astimezone(tz).date() + timedelta(days=1)
    out: List[Interval] = []
    d = first
    while d <= last:
        ws = datetime(d.year, d.month, d.day, s[0], s[1], tzinfo=tz)
        we = datetime(d.year, d.month, d.day, e[0], e[1], tzinfo=tz)
        if we <= ws:
            we += timedelta(days=1)
        out.append((ws.astimezone(timezone.utc), we.astimezone(timezone.utc)))
        d += timedelta(days=1)
    return _normalize(out)


def build_break_windows(
    shift_start_hm: str,
    breaks: Sequence[Tuple[str, str]],
    span: Interval,
    tz: ZoneInfo,
) -> List[Interval]:
    """Concrete UTC break windows overlapping ``span``. Each break's HH:MM is
    anchored to the same local date as its shift instance; a break earlier than
    the shift start (e.g. a 03:00 lunch on a 22:00 night shift) rolls to the next
    day so it lands inside the overnight shift."""
    sh = _parse(shift_start_hm)
    if not sh:
        return []
    span_s, span_e = _as_utc(span[0]), _as_utc(span[1])
    first = span_s.astimezone(tz).date() - timedelta(days=1)
    last = span_e.astimezone(tz).date() + timedelta(days=1)
    shift_start_minutes = sh[0] * 60 + sh[1]
    out: List[Interval] = []
    d = first
    while d <= last:
        for bs_str, be_str in breaks:
            bs = _parse(bs_str)
            be = _parse(be_str)
            if not bs or not be:
                continue
            roll = timedelta(days=1) if (bs[0] * 60 + bs[1]) < shift_start_minutes else timedelta(0)
            b_start = datetime(d.year, d.month, d.day, bs[0], bs[1], tzinfo=tz) + roll
            b_end = datetime(d.year, d.month, d.day, be[0], be[1], tzinfo=tz) + roll
            if b_end <= b_start:
                b_end += timedelta(days=1)
            out.append((b_start.astimezone(timezone.utc), b_end.astimezone(timezone.utc)))
        d += timedelta(days=1)
    return _normalize(out)


def build_unavailable_windows(
    periods: Sequence[Tuple[date, date]], tz: ZoneInfo,
) -> List[Interval]:
    """Full-day UTC windows for inclusive [start_date, end_date] local-date
    periods (vacation, absence, …). A period covers local 00:00 of start_date
    through 00:00 of the day after end_date."""
    out: List[Interval] = []
    for sd, ed in periods:
        if ed < sd:
            sd, ed = ed, sd
        w_start = datetime(sd.year, sd.month, sd.day, 0, 0, tzinfo=tz)
        end_day = ed + timedelta(days=1)
        w_end = datetime(end_day.year, end_day.month, end_day.day, 0, 0, tzinfo=tz)
        out.append((w_start.astimezone(timezone.utc), w_end.astimezone(timezone.utc)))
    return _normalize(out)


# ── async DB-facing helpers ──────────────────────────────────────────────────

async def _plant_tz(db: AsyncSession, wo: Optional[WorkOrder]) -> ZoneInfo:
    """Resolve the plant timezone for a work order (via its equipment), falling
    back to the default plant tz. Never raises — bad/unknown tz → default."""
    tzname = DEFAULT_TZ
    try:
        if wo is not None and wo.equipment_id:
            row = (await db.execute(
                select(Plant.timezone).select_from(Equipment)
                .join(Plant, Equipment.plant_id == Plant.id)
                .where(Equipment.id == wo.equipment_id)
            )).first()
            if row and row[0]:
                tzname = row[0]
    except Exception:
        tzname = DEFAULT_TZ
    try:
        return ZoneInfo(tzname)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


async def _shift_template_for(db: AsyncSession, tech: Technician) -> Optional[ShiftTemplate]:
    """The active shift template matching the technician's shift key. Plant-scoped
    templates win over global (plant_id NULL). Returns None when none configured
    (→ effective falls back to raw)."""
    shift_val = tech.shift.value if hasattr(tech.shift, "value") else tech.shift
    if not shift_val:
        return None
    rows = (await db.execute(
        select(ShiftTemplate)
        .options(selectinload(ShiftTemplate.breaks))  # eager: avoid async lazy-load
        .where(
            ShiftTemplate.key == shift_val,
            ShiftTemplate.active == True,  # noqa: E712
        )
    )).scalars().all()
    if not rows:
        return None
    rows.sort(key=lambda t: 0 if t.plant_id is not None else 1)
    return rows[0]


async def _unavailable_periods(
    db: AsyncSession, technician_id: UUID, span: Interval, tz: ZoneInfo,
) -> List[Tuple[date, date]]:
    span_s = _as_utc(span[0]).astimezone(tz).date()
    span_e = _as_utc(span[1]).astimezone(tz).date()
    rows = (await db.execute(
        select(TechnicianUnavailability.start_date, TechnicianUnavailability.end_date)
        .where(
            TechnicianUnavailability.technician_id == technician_id,
            TechnicianUnavailability.end_date >= span_s,
            TechnicianUnavailability.start_date <= span_e,
        )
    )).all()
    return [(r[0], r[1]) for r in rows]


async def breakdown_for_span(
    db: AsyncSession,
    technician: Optional[Technician],
    started_at: datetime,
    stopped_at: datetime,
    *,
    overtime_approved: bool = False,
    work_order: Optional[WorkOrder] = None,
) -> LaborBreakdown:
    """Effective-time breakdown for a technician working [started_at, stopped_at].

    Fallbacks (never raise, never corrupt): no technician / no shift template /
    unparseable data → ``has_schedule=False`` and ``effective == raw`` minus any
    unavailability we do know about."""
    started_at = _as_utc(started_at)
    stopped_at = _as_utc(stopped_at)
    if stopped_at <= started_at:
        return compute_breakdown(started_at, stopped_at, shift_windows=None,
                                 overtime_approved=overtime_approved)

    span: Interval = (started_at, stopped_at)
    tz = await _plant_tz(db, work_order)

    shift_windows: Optional[List[Interval]] = None
    break_windows: List[Interval] = []
    unavailable_windows: List[Interval] = []

    if technician is not None:
        tpl = await _shift_template_for(db, technician)
        if tpl is not None:
            shift_windows = build_shift_windows(tpl.start_time, tpl.end_time, span, tz)
            brs = [(b.start_time, b.end_time) for b in (tpl.breaks or [])]
            break_windows = build_break_windows(tpl.start_time, brs, span, tz)
        periods = await _unavailable_periods(db, technician.id, span, tz)
        unavailable_windows = build_unavailable_windows(periods, tz)

    return compute_breakdown(
        started_at, stopped_at,
        shift_windows=shift_windows,
        break_windows=break_windows,
        unavailable_windows=unavailable_windows,
        overtime_approved=overtime_approved,
    )


async def apply_to_record(
    db: AsyncSession, rec: LaborRecord, *, work_order: Optional[WorkOrder] = None,
) -> LaborBreakdown:
    """Compute and stamp effective_hours / deducted_minutes / labor_cost on a
    labor record from its started_at/stopped_at, WITHOUT touching hours_worked
    (raw, feeds repair_hours/MTTR). No timestamps → leave effective == raw so the
    record and its cost stay consistent with legacy behavior. Returns the
    breakdown for callers that want to surface it."""
    tech = await db.get(Technician, rec.technician_id) if rec.technician_id else None

    if rec.started_at and rec.stopped_at:
        bd = await breakdown_for_span(
            db, tech, rec.started_at, rec.stopped_at,
            overtime_approved=bool(rec.overtime_approved), work_order=work_order,
        )
        rec.effective_hours = bd.effective_hours
        rec.deducted_minutes = bd.deducted_minutes
    else:
        # Manual entry with no timestamps: effective == raw (no schedule overlap
        # to compute). Preserve legacy cost behavior.
        rec.effective_hours = round(rec.hours_worked or 0.0, 4)
        rec.deducted_minutes = 0.0
        bd = LaborBreakdown(
            raw_minutes=round((rec.hours_worked or 0.0) * 60, 4),
            effective_minutes=round((rec.hours_worked or 0.0) * 60, 4),
            deducted_minutes=0.0, has_schedule=False,
            overtime_approved=bool(rec.overtime_approved),
        )

    rate = rec.hourly_rate or (tech.hourly_rate if tech else None)
    if rate is not None:
        rec.hourly_rate = rate
        rec.labor_cost = round(rate * (rec.effective_hours or 0.0), 2)
    return bd
