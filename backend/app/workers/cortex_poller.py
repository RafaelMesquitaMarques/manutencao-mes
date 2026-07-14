"""Cortex poller — PULLS end-of-line label scans from the Cortex API and pushes
them into KAIZO as finished units.

The assembly lines (department assemblage) get their QUANTITIES from the label
scanned on each finished piece of furniture as it leaves the line: KAIZO pulls
those scans from the Cortex system's API (we poll them; Cortex does not call us).
One poller service reads every enabled `cortex_stations` row and, per station:

  • fetches the scans newer than the station's cursor from the Cortex API;
  • POSTs each one to  /api/machines/{ref}/of-unit-scan  — +1 finished unit on the
    labelled OF (JobOrderRun) AND on the line's shift/hourly production (OEE);
  • advances the cursor ONLY after a successful ingest, and persists it on the
    station row, so a crash/restart never double-counts a scan.

Auth towards KAIZO reuses each machine's per-machine signal_ingest_token
(X-Signal-Token) — the same provisional scheme as the ADAM gateway, so all
shift/date/OF logic stays server-side. Station config lives in the DB (edited in
/settings/devices) and is reloaded every CORTEX_RELOAD_SEC; health (status /
last_seen_at / last_error) is written back to the row so the platform can show
the stations online/offline. Runs as its own container in the same image as the
backend (see docker-compose `cortex_poller`).

Env:
  CORTEX_API_BASE    base URL of the Cortex API (REQUIRED — no default)
  CORTEX_API_KEY     bearer token for the Cortex API
  KAIZO_API_BASE     KAIZO API base (default http://backend:8000, container-internal)
  CORTEX_RELOAD_SEC  seconds between station-config reloads (default 10)
"""
import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from sqlalchemy.orm import selectinload
from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.models.models import AdamDeviceStatus, CortexStation

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cortex_poller")

CORTEX_BASE = os.environ.get("CORTEX_API_BASE", "").rstrip("/")
CORTEX_KEY = os.environ.get("CORTEX_API_KEY", "")
KAIZO_BASE = os.environ.get("KAIZO_API_BASE", "http://backend:8000").rstrip("/")
RELOAD_SEC = float(os.environ.get("CORTEX_RELOAD_SEC", "10"))
HTTP_TIMEOUT = 10
FETCH_LIMIT = 100
HEARTBEAT_SEC = 30          # min interval between last_seen_at writes for a healthy station


class CortexUnreachable(Exception):
    """The Cortex API could not be reached at all (network/DNS/refused)."""


# ─── Cortex API adapter (sync; runs inside a worker thread) ────────────────────
# The ONLY place that knows the Cortex API's shape. ASSUMED contract until the
# integrator hands us the real spec — adjust HERE and nowhere else:
#
#   GET {CORTEX_API_BASE}/stations/{station_key}/scans?since={cursor}&limit=N
#   Authorization: Bearer {CORTEX_API_KEY}
#   → {"scans": [{"id": "1042",                      ← monotonic scan id (our cursor)
#                 "barcode": "OF-4711",              ← OF number on the unit's label
#                 "ts": "2026-07-11T14:03:22-04:00", ← scan instant (local, with offset)
#                 "product_name": "Commode 6 tiroirs",   (optional)
#                 "quantity": 1}, …]}                    (optional, default 1)
#   Scans are returned OLDEST FIRST; `since` is exclusive.

def _fetch_scans(station_key: str, cursor: str | None) -> list[dict]:
    params = {"limit": str(FETCH_LIMIT)}
    if cursor:
        params["since"] = cursor
    url = (f"{CORTEX_BASE}/stations/{urllib.parse.quote(station_key)}/scans"
           f"?{urllib.parse.urlencode(params)}")
    req = urllib.request.Request(url)
    if CORTEX_KEY:
        req.add_header("Authorization", f"Bearer {CORTEX_KEY}")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Cortex API {e.code}: {e.read().decode()[:120]}") from e
    except Exception as e:  # noqa: BLE001 — URLError, timeout, bad JSON…
        raise CortexUnreachable(f"Cortex API unreachable: {e}") from e
    scans = data.get("scans")
    if not isinstance(scans, list):
        raise RuntimeError("Cortex API: unexpected payload (no 'scans' list)")
    return scans


# ─── KAIZO ingest (sync; runs inside a worker thread) ──────────────────────────

def _ingest_unit(machine_ref: str, token: str, scan: dict) -> tuple[bool, str]:
    barcode = str(scan.get("barcode") or "").strip()
    if not barcode:
        # A scan without a readable barcode can't be attributed — skip, don't block
        # the cursor behind it forever.
        return True, ""
    body = {
        "job_number": barcode,
        "count": int(scan.get("quantity") or 1),
        "ts": scan.get("ts"),
        "product_name": scan.get("product_name"),
    }
    url = f"{KAIZO_BASE}/api/machines/{machine_ref}/of-unit-scan"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Signal-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            resp.read()
        return True, ""
    except urllib.error.HTTPError as e:
        return False, f"KAIZO API {e.code}: {e.read().decode()[:120]}"
    except Exception as e:  # noqa: BLE001 — non-fatal, reported as station error
        return False, f"KAIZO API unreachable: {e}"


class Runtime:
    """Per-station polling state + config snapshot (detached from the DB session)."""

    def __init__(self, st: CortexStation):
        self.next_poll = 0.0
        self.reported_status: str | None = None
        self.last_health_write = 0.0
        self.cursor: str | None = st.last_cursor
        self._synced_cursor: str | None = st.last_cursor
        self.apply(st)

    def apply(self, st: CortexStation) -> None:
        """Refresh the config snapshot from a DB row. The in-memory cursor stays
        authoritative UNLESS the row's cursor differs from the one we last wrote —
        that means someone edited it in the DB/UI (e.g. cleared it to re-read),
        so we adopt it."""
        self.name = st.name
        self.key = st.station_key
        self.poll_interval = max(1.0, float(st.poll_interval_s or 5))
        m = st.machine
        self.machine_ref = (m.page_slug or str(m.id)) if m else None
        self.token = m.signal_ingest_token if m else None
        if st.last_cursor != self._synced_cursor:
            self.cursor = st.last_cursor
            self._synced_cursor = st.last_cursor


def _tick(rt: Runtime, now_mono: float) -> dict | None:
    """Poll one station once (Cortex fetch + KAIZO ingest). Runs in a worker
    thread. Returns a health/cursor delta or None if it isn't this station's
    turn to poll yet."""
    if now_mono < rt.next_poll:
        return None
    rt.next_poll = now_mono + rt.poll_interval

    if not CORTEX_BASE:
        return {"status": AdamDeviceStatus.error, "error": "CORTEX_API_BASE not configured"}
    if not rt.machine_ref or not rt.token:
        return {"status": AdamDeviceStatus.error, "error": "no linked machine or token"}

    try:
        scans = _fetch_scans(rt.key, rt.cursor)
    except CortexUnreachable as e:
        return {"status": AdamDeviceStatus.offline, "error": str(e)[:500]}
    except Exception as e:  # noqa: BLE001
        return {"status": AdamDeviceStatus.error, "error": str(e)[:500]}

    moved = False
    for scan in scans:
        ok, err = _ingest_unit(rt.machine_ref, rt.token, scan)
        if not ok:
            # Stop here — the cursor stays on the last ingested scan, so the next
            # tick retries from this one. Nothing is lost, nothing double-counts.
            return {"status": AdamDeviceStatus.error, "error": err, "cursor_moved": moved}
        scan_id = scan.get("id")
        if scan_id is not None:
            rt.cursor = str(scan_id)
            moved = True
        if scan.get("barcode"):
            log.info("%s: OF %s +%s unit(s)", rt.name, scan["barcode"], scan.get("quantity") or 1)

    return {"status": AdamDeviceStatus.online, "error": None, "cursor_moved": moved}


async def _write_back(station_id, rt: Runtime, delta: dict) -> None:
    async with AsyncSessionLocal() as session:
        st = await session.get(CortexStation, station_id)
        if not st:
            return
        st.status = delta["status"]
        st.last_error = delta.get("error")
        if delta["status"] == AdamDeviceStatus.online:
            st.last_seen_at = datetime.now(timezone.utc)
        st.last_cursor = rt.cursor
        await session.commit()
        rt._synced_cursor = rt.cursor


async def _load_stations() -> list[CortexStation]:
    async with AsyncSessionLocal() as session:
        rows = (await session.execute(
            select(CortexStation)
            .where(CortexStation.enabled == True)  # noqa: E712
            .options(selectinload(CortexStation.machine))
        )).scalars().all()
        # Detach so we can read attrs after the session closes.
        for r in rows:
            _ = r.machine
        session.expunge_all()
        return list(rows)


async def main() -> None:
    log.info("Cortex poller starting. Cortex=%s KAIZO=%s reload=%ss",
             CORTEX_BASE or "(NOT CONFIGURED)", KAIZO_BASE, RELOAD_SEC)
    if not CORTEX_BASE:
        log.error("CORTEX_API_BASE is not set — stations will report a config error "
                  "until it is provided.")
    runtimes: dict = {}
    last_reload = 0.0

    while True:
        now = time.monotonic()

        # Reload station config periodically (picks up UI edits / new stations).
        if now - last_reload >= RELOAD_SEC:
            last_reload = now
            try:
                stations = await _load_stations()
            except Exception as e:  # noqa: BLE001
                log.error("station reload failed: %s", e)
                stations = None     # keep existing runtimes on a transient DB hiccup
            if stations is not None:
                seen_ids = set()
                for st in stations:
                    seen_ids.add(st.id)
                    if st.id in runtimes:
                        runtimes[st.id].apply(st)
                    else:
                        runtimes[st.id] = Runtime(st)
                        log.info("tracking station %s (%s)", st.name, st.station_key)
                for gone in [i for i in runtimes if i not in seen_ids]:
                    del runtimes[gone]

        # Poll every station that's due (concurrently, blocking I/O off the loop).
        if runtimes:
            ids = list(runtimes.keys())
            results = await asyncio.gather(
                *(asyncio.to_thread(_tick, runtimes[i], now) for i in ids),
                return_exceptions=True,
            )
            for station_id, res in zip(ids, results):
                rt = runtimes.get(station_id)
                if rt is None:
                    continue
                if isinstance(res, Exception):
                    res = {"status": AdamDeviceStatus.error, "error": str(res)[:200]}
                if not res:
                    continue
                status = res["status"]
                # Write back on any status change, whenever the cursor advanced,
                # or as a heartbeat while online.
                changed = status.value != rt.reported_status
                heartbeat = status == AdamDeviceStatus.online and now - rt.last_health_write >= HEARTBEAT_SEC
                if changed or heartbeat or res.get("cursor_moved"):
                    rt.reported_status = status.value
                    rt.last_health_write = now
                    try:
                        await _write_back(station_id, rt, res)
                    except Exception as e:  # noqa: BLE001
                        log.error("write-back failed for %s: %s", station_id, e)

        await asyncio.sleep(0.2)


if __name__ == "__main__":
    asyncio.run(main())
