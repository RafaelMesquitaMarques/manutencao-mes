"""In-memory production pulse — live rate + short-term trend per machine.

Feeds the assembly-line TVs on the 3D map: shift totals/OEE live in the DB
(machine_production_logs / _hourly), but "how fast RIGHT NOW" and "is the pace
going up or down over the last two minutes" need per-event timing that the
hourly buckets can't provide. Every production ingest (ADAM pulse counts and
end-of-line unit scans) records here; readers get a 10-minute rolling rate and
an up/down/flat trend (last 2 min vs the 2 min before).

Deliberately volatile: lives in the backend process, resets on restart (the TV
shows a flat 0/h until pulses arrive again) — it's a live ticker, not a record.
"""
import threading
import time
from collections import deque

_WINDOW_S = 600.0        # rolling window the rate is computed over (10 min)
_TREND_S = 120.0         # trend compares the last 2 min vs the 2 min before

_buffers: dict[str, deque] = {}
_lock = threading.Lock()


def record_units(machine_id, count: int = 1) -> None:
    """Record `count` freshly-produced unit(s) for a machine (any ingest path)."""
    if count <= 0:
        return
    now = time.monotonic()
    key = str(machine_id)
    with _lock:
        dq = _buffers.setdefault(key, deque())
        dq.append((now, count))
        while dq and now - dq[0][0] > _WINDOW_S:
            dq.popleft()


def stats(machine_id) -> tuple[float, str]:
    """(units_per_hour, trend) for a machine.

    Rate = pace over the last 10 minutes extrapolated to an hour; trend is
    'up' | 'down' | 'flat' comparing the last 2 minutes with the 2 before them.
    """
    now = time.monotonic()
    with _lock:
        dq = _buffers.get(str(machine_id))
        if not dq:
            return 0.0, "flat"
        while dq and now - dq[0][0] > _WINDOW_S:
            dq.popleft()
        total = sum(c for _, c in dq)
        last = sum(c for t, c in dq if now - t <= _TREND_S)
        prev = sum(c for t, c in dq if _TREND_S < now - t <= 2 * _TREND_S)
    rate = total * (3600.0 / _WINDOW_S)
    trend = "up" if last > prev else "down" if last < prev else "flat"
    return rate, trend
