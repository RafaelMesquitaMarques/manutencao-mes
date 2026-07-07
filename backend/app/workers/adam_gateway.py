"""Central ADAM gateway — polls the whole fleet of Advantech ADAM-6050/6051
production-signal modules over Modbus/TCP and pushes readings into KAIZO.

This is the multi-device, DB-driven successor to scripts/adam_poller.py (which
polls a single bench device from CLI args). Instead of one PC per machine, ONE
gateway service reads every enabled `adam_devices` row and, per device:

  • edge-counts pulses on a DI channel (source=di) or reads the 32-bit hardware
    counter (source=counter) — one pulse = one produced part;
  • POSTs parts to  /api/machines/{ref}/production-count  (adds to OEE, marks running);
  • after `idle_timeout_s` with no pulse, POSTs running=False to
    /api/machines/{ref}/production-signal  → KAIZO flips the machine to a detected stop.

Auth reuses each machine's per-machine signal_ingest_token (X-Signal-Token), so
the ingest path is identical to the bench poller — all shift/date/OEE logic stays
server-side. Device config (IP, channel, timeouts, machine link) lives in the DB
and is reloaded every ADAM_RELOAD_SEC, so edits in the UI take effect live.

Health (status / last_seen_at / last_error) is written back to the device row so
the platform can show the fleet online/offline. Runs as its own container in the
same image as the backend (see docker-compose `adam_gateway`); it must have a
network route to the ADAMs on the shop floor (Modbus/TCP, port 502).

Env:
  ADAM_API_BASE    KAIZO API base (default http://backend:8000, container-internal)
  ADAM_RELOAD_SEC  seconds between device-config reloads (default 10)
"""
import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from pymodbus.client import ModbusTcpClient
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.db.session import AsyncSessionLocal
from app.models.models import (
    AdamDevice, AdamDeviceStatus, AdamSignalSource, AdamActiveLevel,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("adam_gateway")

SLAVE_ID = 1
DI_COUNT = 12
API_BASE = os.environ.get("ADAM_API_BASE", "http://backend:8000").rstrip("/")
RELOAD_SEC = float(os.environ.get("ADAM_RELOAD_SEC", "10"))
HTTP_TIMEOUT = 5
HEARTBEAT_SEC = 30          # min interval between last_seen_at writes for a healthy device


# ─── HTTP ingest (sync; runs inside a worker thread) ───────────────────────────

def _post(path: str, token: str, body: dict) -> tuple[bool, str]:
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Signal-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            resp.read()
        return True, ""
    except urllib.error.HTTPError as e:
        return False, f"API {e.code}: {e.read().decode()[:120]}"
    except Exception as e:  # noqa: BLE001 — non-fatal, reported as device error
        return False, f"API unreachable: {e}"


# ─── Modbus reads (sync) ───────────────────────────────────────────────────────

def _read_di(client: ModbusTcpClient, channel: int):
    rr = client.read_discrete_inputs(address=0, count=DI_COUNT, device_id=SLAVE_ID)
    if rr.isError():
        rr = client.read_coils(address=0, count=DI_COUNT, device_id=SLAVE_ID)
    if rr.isError():
        return None
    return 1 if rr.bits[channel] else 0


def _read_counter(client: ModbusTcpClient, reg: int):
    rr = client.read_input_registers(address=reg, count=2, device_id=SLAVE_ID)
    if rr.isError():
        rr = client.read_holding_registers(address=reg, count=2, device_id=SLAVE_ID)
    if rr.isError():
        return None
    lo, hi = rr.registers[0], rr.registers[1]
    return lo | (hi << 16)


class Runtime:
    """Per-device polling state + config snapshot (detached from the DB session)."""

    def __init__(self, dev: AdamDevice):
        self.client: ModbusTcpClient | None = None
        self.prev_di = None
        self.prev_counter = None
        self.last_pulse = 0.0
        self.producing = False
        self.next_poll = 0.0
        self.reported_status: str | None = None
        self.last_health_write = 0.0
        self.apply(dev)

    def apply(self, dev: AdamDevice) -> None:
        """Refresh the config snapshot from a DB row. Resets the Modbus client if
        the endpoint changed so the next tick reconnects."""
        endpoint = (dev.ip_address, dev.port)
        prev_endpoint = getattr(self, "endpoint", None)
        self.endpoint = endpoint
        self.name = dev.name
        self.ip = dev.ip_address
        self.port = dev.port or 502
        self.source = dev.signal_source or AdamSignalSource.di
        self.channel = dev.channel or 0
        self.active_bit = 0 if (dev.active_level or AdamActiveLevel.low) == AdamActiveLevel.low else 1
        self.counter_reg = dev.counter_reg or 0
        self.idle_timeout = float(dev.idle_timeout_s or 15)
        self.poll_interval = max(0.02, (dev.poll_interval_ms or 100) / 1000.0)
        m = dev.machine
        self.machine_ref = (m.page_slug or str(m.id)) if m else None
        self.token = m.signal_ingest_token if m else None
        if prev_endpoint is not None and prev_endpoint != endpoint:
            self.close()
            self.prev_di = None
            self.prev_counter = None

    def close(self) -> None:
        if self.client is not None:
            try:
                self.client.close()
            except Exception:
                pass
            self.client = None


def _tick(rt: Runtime, now_mono: float) -> dict | None:
    """Poll one device once (Modbus + HTTP ingest). Runs in a worker thread.
    Returns a health delta {status, error} or None if it isn't this device's turn
    to poll yet / it's unconfigured."""
    if now_mono < rt.next_poll:
        return None
    rt.next_poll = now_mono + rt.poll_interval

    if not rt.machine_ref or not rt.token:
        return {"status": AdamDeviceStatus.error, "error": "no linked machine or token"}

    # Connect on demand.
    if rt.client is None:
        rt.client = ModbusTcpClient(rt.ip, port=rt.port, timeout=2)
        if not rt.client.connect():
            rt.client = None
            return {"status": AdamDeviceStatus.offline, "error": f"cannot connect to {rt.ip}:{rt.port}"}

    # Read the pulse source.
    pulses = 0
    if rt.source == AdamSignalSource.di:
        cur = _read_di(rt.client, rt.channel)
        if cur is None:
            rt.close()
            return {"status": AdamDeviceStatus.error, "error": "DI read failed"}
        if rt.prev_di is not None and rt.prev_di != rt.active_bit and cur == rt.active_bit:
            pulses = 1
        rt.prev_di = cur
    else:
        cur = _read_counter(rt.client, rt.counter_reg)
        if cur is None:
            rt.close()
            return {"status": AdamDeviceStatus.error, "error": "counter read failed"}
        if rt.prev_counter is not None and cur >= rt.prev_counter:
            pulses = cur - rt.prev_counter
        rt.prev_counter = cur

    # Emit parts.
    if pulses:
        rt.last_pulse = now_mono
        rt.producing = True
        wall = datetime.now().astimezone().isoformat()
        ok, err = _post(f"/api/machines/{rt.machine_ref}/production-count", rt.token,
                         {"count": pulses, "ts": wall})
        if not ok:
            return {"status": AdamDeviceStatus.error, "error": err}
        log.info("%s: +%d part(s)", rt.name, pulses)

    # Idle → report a stop.
    if rt.producing and now_mono - rt.last_pulse > rt.idle_timeout:
        rt.producing = False
        ok, err = _post(f"/api/machines/{rt.machine_ref}/production-signal", rt.token,
                        {"running": False})
        if not ok:
            return {"status": AdamDeviceStatus.error, "error": err}
        log.info("%s: idle %.0fs → running=False", rt.name, rt.idle_timeout)

    return {"status": AdamDeviceStatus.online, "error": None}


async def _write_health(device_id, delta: dict) -> None:
    async with AsyncSessionLocal() as session:
        dev = await session.get(AdamDevice, device_id)
        if not dev:
            return
        dev.status = delta["status"]
        dev.last_error = delta.get("error")
        if delta["status"] == AdamDeviceStatus.online:
            dev.last_seen_at = datetime.now(timezone.utc)
        await session.commit()


async def _load_devices() -> list[AdamDevice]:
    async with AsyncSessionLocal() as session:
        rows = (await session.execute(
            select(AdamDevice)
            .where(AdamDevice.enabled == True)  # noqa: E712
            .options(selectinload(AdamDevice.machine))
        )).scalars().all()
        # Detach so we can read attrs after the session closes.
        for r in rows:
            _ = r.machine
        session.expunge_all()
        return list(rows)


async def main() -> None:
    log.info("ADAM gateway starting. API=%s reload=%ss", API_BASE, RELOAD_SEC)
    runtimes: dict = {}
    last_reload = 0.0

    while True:
        now = time.monotonic()

        # Reload device config periodically (picks up UI edits / new devices).
        if now - last_reload >= RELOAD_SEC:
            last_reload = now
            try:
                devices = await _load_devices()
            except Exception as e:  # noqa: BLE001
                log.error("device reload failed: %s", e)
                devices = []
                # keep existing runtimes on a transient DB hiccup
            if devices is not None:
                seen_ids = set()
                for dev in devices:
                    seen_ids.add(dev.id)
                    if dev.id in runtimes:
                        runtimes[dev.id].apply(dev)
                    else:
                        runtimes[dev.id] = Runtime(dev)
                        log.info("tracking device %s (%s)", dev.name, dev.ip_address)
                for gone in [d for d in runtimes if d not in seen_ids]:
                    runtimes[gone].close()
                    del runtimes[gone]

        # Poll every device that's due (concurrently, blocking I/O off the loop).
        if runtimes:
            ids = list(runtimes.keys())
            results = await asyncio.gather(
                *(asyncio.to_thread(_tick, runtimes[i], now) for i in ids),
                return_exceptions=True,
            )
            for device_id, res in zip(ids, results):
                rt = runtimes.get(device_id)
                if rt is None:
                    continue
                if isinstance(res, Exception):
                    res = {"status": AdamDeviceStatus.error, "error": str(res)[:200]}
                    rt.close()
                if not res:
                    continue
                status = res["status"]
                # Write health on any status change, or as a heartbeat while online.
                changed = status.value != rt.reported_status
                heartbeat = status == AdamDeviceStatus.online and now - rt.last_health_write >= HEARTBEAT_SEC
                if changed or heartbeat:
                    rt.reported_status = status.value
                    rt.last_health_write = now
                    try:
                        await _write_health(device_id, res)
                    except Exception as e:  # noqa: BLE001
                        log.error("health write failed for %s: %s", device_id, e)

        await asyncio.sleep(0.05)


if __name__ == "__main__":
    asyncio.run(main())
