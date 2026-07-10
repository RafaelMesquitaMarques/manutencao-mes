"""
Tests for effective labor-time calculation (labor_time_service).
================================================================
Pure, no DB/HTTP. Exercises the interval algebra, the tz-aware window builders,
and compute_breakdown across every edge case in the feature spec:

  fully inside shift · overlapping lunch · overlapping a short break ·
  crossing shift end · crossing midnight (overnight shift) · two technicians
  with different schedules on one ticket · vacation · missing schedule (history)
  · ongoing (no end) · approved overtime.

Golden case (spec example): 11:45–12:45 with a 12:00–12:30 lunch → machine
downtime is 60 min but effective LABOR is 30 min.

Run with: pytest backend/tests/test_labor_time_service.py -v
"""
import os
import sys
from datetime import date, datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))

from app.services import labor_time_service as lts  # noqa: E402

TZ = ZoneInfo("America/Toronto")

# Day shift: 08:00–16:30, lunch 12:00–12:30, breaks 10:00–10:15 & 14:30–14:45.
DAY_START, DAY_END = "08:00", "16:30"
DAY_BREAKS = [("10:00", "10:15"), ("12:00", "12:30"), ("14:30", "14:45")]
# Overnight shift: 22:00–06:00, one break 03:00–03:15.
NIGHT_START, NIGHT_END = "22:00", "06:00"
NIGHT_BREAKS = [("03:00", "03:15")]


def dt(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=TZ)


def _windows(start, end, s, e, breaks):
    span = (start, end)
    return (
        lts.build_shift_windows(s, e, span, TZ),
        lts.build_break_windows(s, breaks, span, TZ),
    )


def _day(start, end, overtime=False, unavailable=()):
    sw, bw = _windows(start, end, DAY_START, DAY_END, DAY_BREAKS)
    uw = lts.build_unavailable_windows(list(unavailable), TZ)
    return lts.compute_breakdown(
        start, end, shift_windows=sw, break_windows=bw,
        unavailable_windows=uw, overtime_approved=overtime,
    )


# ── interval algebra ─────────────────────────────────────────────────────────

def test_subtract_removes_overlap():
    a = [(dt(2026, 6, 1, 9), dt(2026, 6, 1, 12))]
    b = [(dt(2026, 6, 1, 10), dt(2026, 6, 1, 10, 30))]
    assert round(lts.total_minutes(lts.subtract(a, b)), 2) == 150.0  # 180 - 30


def test_intersect_keeps_common():
    a = [(dt(2026, 6, 1, 9), dt(2026, 6, 1, 17))]
    b = [(dt(2026, 6, 1, 16), dt(2026, 6, 1, 18))]
    assert round(lts.total_minutes(lts.intersect(a, b)), 2) == 60.0


# ── core edge cases ──────────────────────────────────────────────────────────

def test_fully_inside_shift_no_deduction():
    bd = _day(dt(2026, 6, 1, 9), dt(2026, 6, 1, 9, 45))
    assert bd.raw_minutes == 45
    assert bd.effective_minutes == 45
    assert bd.deducted_minutes == 0
    assert bd.has_schedule is True


def test_overlapping_lunch_is_the_golden_case():
    # 11:45–12:45, lunch 12:00–12:30 → raw 60, effective 30.
    bd = _day(dt(2026, 6, 1, 11, 45), dt(2026, 6, 1, 12, 45))
    assert bd.raw_minutes == 60
    assert bd.effective_minutes == 30
    assert bd.break_minutes == 30
    assert bd.off_shift_minutes == 0


def test_overlapping_short_break():
    # 09:50–10:20, break 10:00–10:15 → 15 min deducted.
    bd = _day(dt(2026, 6, 1, 9, 50), dt(2026, 6, 1, 10, 20))
    assert bd.raw_minutes == 30
    assert bd.effective_minutes == 15
    assert bd.break_minutes == 15


def test_crossing_shift_end_clips_off_shift():
    # 16:00–17:00, shift ends 16:30 → 30 min off-shift, no break in range.
    bd = _day(dt(2026, 6, 1, 16), dt(2026, 6, 1, 17))
    assert bd.raw_minutes == 60
    assert bd.effective_minutes == 30
    assert bd.off_shift_minutes == 30


def test_break_outside_span_not_deducted():
    bd = _day(dt(2026, 6, 1, 8), dt(2026, 6, 1, 9))  # before the 10:00 break
    assert bd.effective_minutes == 60
    assert bd.break_minutes == 0


# ── overnight / midnight ─────────────────────────────────────────────────────

def test_crossing_midnight_within_overnight_shift():
    # 23:30–00:30 inside a 22:00–06:00 shift → fully worked, no deduction.
    start, end = dt(2026, 6, 1, 23, 30), dt(2026, 6, 2, 0, 30)
    sw, bw = _windows(start, end, NIGHT_START, NIGHT_END, NIGHT_BREAKS)
    bd = lts.compute_breakdown(start, end, shift_windows=sw, break_windows=bw)
    assert bd.raw_minutes == 60
    assert bd.effective_minutes == 60
    assert bd.off_shift_minutes == 0


def test_overnight_shift_end_and_break():
    # 02:50–06:30 inside 22:00–06:00: break 03:00–03:15 (15) + off-shift after
    # 06:00 (30) → effective = 220 - 15 - 30 = 175.
    start, end = dt(2026, 6, 2, 2, 50), dt(2026, 6, 2, 6, 30)
    sw, bw = _windows(start, end, NIGHT_START, NIGHT_END, NIGHT_BREAKS)
    bd = lts.compute_breakdown(start, end, shift_windows=sw, break_windows=bw)
    assert bd.raw_minutes == 220
    assert bd.break_minutes == 15
    assert bd.off_shift_minutes == 30
    assert bd.effective_minutes == 175


# ── two technicians, one ticket ──────────────────────────────────────────────

def test_two_technicians_different_shifts_same_span():
    start, end = dt(2026, 6, 1, 11, 45), dt(2026, 6, 1, 12, 45)
    # Tech A: day shift, hits lunch → 30 min effective.
    a = _day(start, end)
    # Tech B: evening shift 16:30–00:30 → the span is entirely off-shift → 0.
    sw, bw = _windows(start, end, "16:30", "00:30", [])
    b = lts.compute_breakdown(start, end, shift_windows=sw, break_windows=bw)
    assert a.effective_minutes == 30
    assert b.effective_minutes == 0
    assert b.off_shift_minutes == 60
    # Machine downtime (raw) is identical for both — 60 min.
    assert a.raw_minutes == b.raw_minutes == 60


# ── vacation / unavailability ────────────────────────────────────────────────

def test_vacation_excludes_all_labor():
    d = date(2026, 6, 1)
    bd = _day(dt(2026, 6, 1, 9), dt(2026, 6, 1, 10), unavailable=[(d, d)])
    assert bd.raw_minutes == 60
    assert bd.effective_minutes == 0
    assert bd.unavailable_minutes == 60


# ── fallbacks: missing schedule / ongoing ────────────────────────────────────

def test_missing_schedule_falls_back_to_raw():
    # Historical record with no shift template → effective == raw, flagged.
    bd = lts.compute_breakdown(
        dt(2026, 6, 1, 11, 45), dt(2026, 6, 1, 12, 45), shift_windows=None,
    )
    assert bd.raw_minutes == 60
    assert bd.effective_minutes == 60
    assert bd.has_schedule is False


def test_zero_or_reversed_span_is_zero():
    same = dt(2026, 6, 1, 9)
    bd = lts.compute_breakdown(same, same, shift_windows=None)
    assert bd.raw_minutes == 0
    assert bd.effective_minutes == 0


# ── overtime ─────────────────────────────────────────────────────────────────

def test_approved_overtime_keeps_off_shift_time():
    start, end = dt(2026, 6, 1, 16), dt(2026, 6, 1, 17)  # 30 min past shift end
    without = _day(start, end)
    with_ot = _day(start, end, overtime=True)
    assert without.effective_minutes == 30           # off-shift clipped
    assert with_ot.effective_minutes == 60           # overtime approved → kept
    assert with_ot.off_shift_minutes == 0


# ── window builder sanity ────────────────────────────────────────────────────

def test_build_shift_windows_overnight_rolls_past_midnight():
    span = (dt(2026, 6, 1, 22), dt(2026, 6, 2, 7))
    windows = lts.build_shift_windows("22:00", "06:00", span, TZ)
    # Each window must be 8h (end rolled +1 day), not negative/zero.
    assert windows
    for s, e in windows:
        assert (e - s).total_seconds() == 8 * 3600
