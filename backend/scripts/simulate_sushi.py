"""Demo simulator for Yokogawa Sushi Sensors (LoRaWAN condition monitoring).

Creates two demo devices bound to real equipment of the plant and replays a
realistic history through the REAL decode path (binary Yokogawa frames →
sushi_service.ingest_uplink), so charts, thresholds, alerts and health chips
all light up exactly as they will with hardware:

  SIM-SUSHI-VIB  (XS770A on the busiest machine)
      · 7 days of vibration: ~2.2 mm/s baseline drifting up to ~5.2 mm/s in
        the last day → crosses the 4.5 mm/s ISO warning (one alert)
      · surface temperature daily cycle 33–39 °C
      · HRI battery report every 24 h (87 % → slowly down)
  SIM-SUSHI-PRESS  (XS110A+XS530 on a second machine)
      · 7 days of pressure: 0.62 MPa ± noise with a short dip
      · module temperature ~48 °C

Everything is TAGGED for clean removal:
  - devices : name starts with "SIM-SUSHI-" (dev_eui prefix F0F0)
  - sensors : code starts with "SUSHI-F0F0" (cascade: readings + alerts wiped)

Run inside the backend container:
    docker exec mes_backend python -m scripts.simulate_sushi --plant QS
    docker exec mes_backend python -m scripts.simulate_sushi --plant QS --reset   # wipe SIM data only
    docker exec mes_backend python -m scripts.simulate_sushi --plant QS --live    # drip one uplink/min forever
    docker exec mes_backend python -m scripts.simulate_sushi --plant QS --http http://localhost:8000
        # --live via the real HTTP endpoint (needs SUSHI_INGEST_TOKEN set)
Re-running regenerates (it wipes the previous SIM data first).

TARGET MODE — feed one ALREADY-REGISTERED device (by DevEUI) as a healthy
running machine (XS770A-style vibration + temperature, no alarm ramp). Uses the
device's own update period; wipes that EUI's previous readings before a
backfill so charts start clean:
    docker exec mes_backend python -m scripts.simulate_sushi --target F0F0530000000001 --days 2
    docker exec -d mes_backend python -m scripts.simulate_sushi --target F0F0530000000001 \
        --days 0 --live --http http://localhost:8000     # live drip only, real webhook
Stop the live drip:  docker exec mes_backend pkill -f simulate_sushi
"""
import argparse
import asyncio
import json
import math
import random
import struct
import urllib.request
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models.models import (
    Alert, Equipment, Plant, Sensor, SensorReading, SushiDevice, SushiSensorModel,
)
from app.services.sushi_service import ingest_uplink

SIM_NAME = "SIM-SUSHI-"
SIM_EUI_PREFIX = "F0F0"
VIB_EUI = SIM_EUI_PREFIX + "770A00000001"
PRESS_EUI = SIM_EUI_PREFIX + "530000000001"


def _now():
    return datetime.now(timezone.utc)


# ─── Binary frame builders (big-endian, per IM 01W06C01-01EN §7) ───────────────

def frame_vibration_xyz(acc_ms2: float, vel_mms: float, temp_c: float, status: int = 0) -> bytes:
    return struct.pack(">BHeee", 0x11, status, acc_ms2, vel_mms, temp_c)


def frame_pressure(mpa: float, status: int = 0) -> bytes:
    return struct.pack(">BHf", 0x30, status, mpa)


def frame_xs530_temp(temp_c: float, status: int = 0) -> bytes:
    return struct.pack(">BHf", 0x31, status, temp_c)


def frame_hri(uptime_min: int, battery_pct: float, rssi_dbm: float, per_pct: float, snr_db: float) -> bytes:
    # Data_Type · UpTime UINT24 · Battery (%×2) · RSSI (as positive) · PER % · SNR (dB×4)
    u = uptime_min & 0xFFFFFF
    return bytes([
        0x40,
        (u >> 16) & 0xFF, (u >> 8) & 0xFF, u & 0xFF,
        max(0, min(255, int(battery_pct * 2))),
        max(0, min(255, int(-rssi_dbm))),
        max(0, min(255, int(per_pct))),
    ]) + struct.pack("b", int(snr_db * 4))


def frame_ini(tag: str) -> bytes:
    return b"\x42" + tag.encode("ascii")[:10].ljust(10, b"\x00")


# ─── Signal generators ─────────────────────────────────────────────────────────

def vib_profile(ts: datetime, end: datetime, rng: random.Random) -> tuple[float, float, float]:
    """(acc m/s², vel mm/s, temp °C) — healthy baseline, drifting up in the last 24 h."""
    hours_left = (end - ts).total_seconds() / 3600.0
    ramp = max(0.0, 1.0 - hours_left / 24.0)          # 0 until last day, →1 at the end
    vel = 2.2 + 0.25 * math.sin(ts.timestamp() / 7200) + rng.gauss(0, 0.12) + 3.0 * ramp
    acc = 3.4 + 0.4 * math.sin(ts.timestamp() / 5400) + rng.gauss(0, 0.25) + 2.2 * ramp
    hour = ts.hour + ts.minute / 60
    temp = 36.0 + 3.0 * math.sin((hour - 9) / 24 * 2 * math.pi) + rng.gauss(0, 0.3) + 1.5 * ramp
    return max(0.05, acc), max(0.05, vel), temp


def press_profile(ts: datetime, rng: random.Random) -> float:
    dip = -0.08 if ts.hour == 14 and ts.minute < 20 else 0.0   # daily short dip
    return 0.62 + 0.015 * math.sin(ts.timestamp() / 3600) + rng.gauss(0, 0.004) + dip


def healthy_vib(ts: datetime, rng: random.Random) -> tuple[float, float, float]:
    """(acc m/s², vel mm/s, temp °C) — machine running normally, well inside the
    ISO zone (vel ~2.4 mm/s), surface temp with a mild daily cycle."""
    vel = 2.4 + 0.3 * math.sin(ts.timestamp() / 5400) + rng.gauss(0, 0.15)
    acc = 3.1 + 0.35 * math.sin(ts.timestamp() / 4200) + rng.gauss(0, 0.2)
    hour = ts.hour + ts.minute / 60
    temp = 37.0 + 2.5 * math.sin((hour - 9) / 24 * 2 * math.pi) + rng.gauss(0, 0.3)
    return max(0.05, acc), max(0.05, vel), temp


DEGRADE_RAMP_HOURS = 12.0


def degrade_vib(ts: datetime, end: datetime, rng: random.Random) -> tuple[float, float, float]:
    """Progressive bearing failure: healthy until ~12 h before `end`, then the
    velocity climbs through the ISO warning (4.5) and critical (7.1) boundaries,
    with acceleration and surface temperature rising along. At `end` (and in
    live mode, where end=now) it plateaus around 7.8 mm/s — firmly critical."""
    acc, vel, temp = healthy_vib(ts, rng)
    hours_left = max(0.0, (end - ts).total_seconds() / 3600.0)
    r = max(0.0, 1.0 - hours_left / DEGRADE_RAMP_HOURS) ** 1.4
    return acc + 4.5 * r, vel + 5.4 * r, temp + 9.0 * r


# ─── DB helpers ────────────────────────────────────────────────────────────────

async def _plant(s, code):
    p = (await s.execute(select(Plant).where(Plant.code == code))).scalar_one_or_none()
    if p is None:
        raise SystemExit(f"plant {code} not found")
    return p


async def _pick_equipment(s, plant, n=2):
    rows = (await s.execute(
        select(Equipment).where(
            Equipment.plant_id == plant.id,
            Equipment.block_kind.is_(None) | (Equipment.block_kind == ""),
        ).order_by(Equipment.name).limit(50)
    )).scalars().all()
    if not rows:
        rows = (await s.execute(
            select(Equipment).where(Equipment.plant_id == plant.id).limit(50)
        )).scalars().all()
    if len(rows) < n:
        raise SystemExit("plant has no equipment to attach the demo sensors to")
    distinct, seen = [], set()
    for r in rows:                     # two homonymous assets would confuse the demo
        if r.name not in seen:
            distinct.append(r)
            seen.add(r.name)
    return (distinct if len(distinct) >= n else rows)[:n]


async def _reset(s):
    euis = (await s.execute(
        select(SushiDevice.dev_eui).where(SushiDevice.name.like(f"{SIM_NAME}%"))
    )).scalars().all()
    for eui in euis:
        sensor_ids = (await s.execute(
            select(Sensor.id).where(Sensor.code.like(f"SUSHI-{eui}-%"))
        )).scalars().all()
        if sensor_ids:
            await s.execute(delete(Alert).where(Alert.sensor_id.in_(sensor_ids)))
            await s.execute(delete(SensorReading).where(SensorReading.sensor_id.in_(sensor_ids)))
            await s.execute(delete(Sensor).where(Sensor.id.in_(sensor_ids)))
    await s.execute(delete(SushiDevice).where(SushiDevice.name.like(f"{SIM_NAME}%")))
    await s.commit()
    print(f"reset: removed {len(euis)} SIM device(s) + sensors/readings/alerts")


async def _create_devices(s, plant):
    eq = await _pick_equipment(s, plant, 2)
    vib = SushiDevice(
        plant_id=plant.id, name=f"{SIM_NAME}VIB", dev_eui=VIB_EUI,
        model=SushiSensorModel.xs770a, equipment_id=eq[0].id,
        update_period_min=10, vel_warn_mms=4.5, vel_crit_mms=7.1,
        temp_warn_c=60.0, temp_crit_c=75.0,
    )
    press = SushiDevice(
        plant_id=plant.id, name=f"{SIM_NAME}PRESS", dev_eui=PRESS_EUI,
        model=SushiSensorModel.xs530, equipment_id=eq[1].id,
        update_period_min=10, vel_warn_mms=None, vel_crit_mms=None,
        press_min_mpa=0.50, press_max_mpa=0.75, temp_warn_c=70.0, temp_crit_c=85.0,
    )
    s.add_all([vib, press])
    await s.commit()
    print(f"devices: {vib.name} → {eq[0].name} | {press.name} → {eq[1].name}")
    return vib, press


async def _backfill(s, vib, press, days: float):
    rng = random.Random(770)
    end = _now()
    start = end - timedelta(days=days)
    period = timedelta(minutes=10)
    ts = start
    count = 0
    uptime0 = 60 * 24 * 200                            # device has been on ~200 days
    next_hri = start
    battery = 87.0

    await ingest_uplink(s, vib, frame_ini("SIM-VIB"), {"time": start})
    await ingest_uplink(s, press, frame_ini("SIM-PRESS"), {"time": start})

    async def _step(ts):
        """One timestep, committed on its own — short transactions keep clear of
        the TimescaleDB background jobs (compression policy takes heavy locks)."""
        nonlocal battery, next_hri
        acc, vel, temp = vib_profile(ts, end, rng)
        meta_v = {"time": ts, "rssi": -84 + rng.gauss(0, 4), "snr": 8.5 + rng.gauss(0, 1.5)}
        await ingest_uplink(s, vib, frame_vibration_xyz(acc, vel, temp), meta_v)

        meta_p = {"time": ts, "rssi": -92 + rng.gauss(0, 4), "snr": 6.0 + rng.gauss(0, 1.5)}
        await ingest_uplink(s, press, frame_pressure(press_profile(ts, rng)), meta_p)
        if ts.minute < 10:                              # XS530 module temp ~hourly
            await ingest_uplink(s, press, frame_xs530_temp(48 + rng.gauss(0, 1.2)), meta_p)

        if ts >= next_hri:                              # daily health report
            uptime = uptime0 + int((ts - start).total_seconds() / 60)
            await ingest_uplink(s, vib, frame_hri(uptime, battery, -84, 2, 8.5), {"time": ts})
            await ingest_uplink(s, press, frame_hri(uptime, battery - 3, -92, 4, 6.0), {"time": ts})
            battery -= 0.15
            next_hri = ts + timedelta(hours=24)
        await s.commit()

    while ts <= end:
        for attempt in (1, 2, 3):
            try:
                await _step(ts)
                break
            except Exception:
                # Deadlock with a TimescaleDB background job — roll back and retry.
                # rollback() expires ORM state: refresh explicitly (async-safe).
                await s.rollback()
                if attempt == 3:
                    raise
                await s.refresh(vib)
                await s.refresh(press)
                await asyncio.sleep(0.5 * attempt)
        count += 2
        ts += period

    print(f"backfill: ~{count} uplinks over {days:g} day(s) (10-min period)")


async def _live(plant_code: str, http_base: str | None):
    rng = random.Random()
    print("live mode — one uplink per device every 60 s (Ctrl+C to stop)")
    while True:
        async with AsyncSessionLocal() as s:
            vib = (await s.execute(select(SushiDevice).where(SushiDevice.dev_eui == VIB_EUI))).scalar_one()
            press = (await s.execute(select(SushiDevice).where(SushiDevice.dev_eui == PRESS_EUI))).scalar_one()
            now = _now()
            acc, vel, temp = vib_profile(now, now, rng)   # steady state (ramp done)
            frames = [
                (vib, frame_vibration_xyz(acc, vel + rng.gauss(0, 0.2), temp), -84),
                (press, frame_pressure(press_profile(now, rng)), -92),
            ]
            for dev, raw, rssi in frames:
                if http_base:
                    _post_http(http_base, dev.dev_eui, raw, rssi)
                else:
                    await ingest_uplink(s, dev, raw, {"time": now, "rssi": rssi, "snr": 7.5})
            await s.commit()
            print(f"{now:%H:%M:%S}  vel={vel:.2f} mm/s  temp={temp:.1f} °C  press ok")
        await asyncio.sleep(60)


def _post_http(base: str, dev_eui: str, raw: bytes, rssi: float):
    """Exercise the real webhook path (ChirpStack-v4-shaped envelope)."""
    import base64
    body = {
        "deviceInfo": {"devEui": dev_eui},
        "data": base64.b64encode(raw).decode(),
        "fPort": 1,
        "rxInfo": [{"rssi": rssi, "snr": 7.5}],
        "time": _now().isoformat(),
    }
    req = urllib.request.Request(
        f"{base.rstrip('/')}/api/sushi/uplink?event=up",
        data=json.dumps(body).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Ingest-Token", settings.SUSHI_INGEST_TOKEN or "")
    with urllib.request.urlopen(req, timeout=5) as resp:
        resp.read()


# ─── Target mode: feed one already-registered device as a healthy machine ─────

async def _target_device(s, eui: str):
    dev = (await s.execute(select(SushiDevice).where(SushiDevice.dev_eui == eui))).scalar_one_or_none()
    if dev is None:
        raise SystemExit(f"device {eui} not registered — add it in /settings/devices first")
    return dev


async def _wipe_eui(s, eui: str):
    """Clean slate for one EUI's series (old readings may belong to a previous
    model/equipment binding of the same physical device row)."""
    sensor_ids = (await s.execute(
        select(Sensor.id).where(Sensor.code.like(f"SUSHI-{eui}-%"))
    )).scalars().all()
    if sensor_ids:
        await s.execute(delete(Alert).where(Alert.sensor_id.in_(sensor_ids)))
        await s.execute(delete(SensorReading).where(SensorReading.sensor_id.in_(sensor_ids)))
        await s.execute(delete(Sensor).where(Sensor.id.in_(sensor_ids)))
        await s.commit()
        print(f"wiped {len(sensor_ids)} previous series for {eui}")


async def _backfill_target(eui: str, days: float, profile: str = "healthy"):
    async with AsyncSessionLocal() as s:
        dev = await _target_device(s, eui)
        await _wipe_eui(s, eui)
        rng = random.Random(int(eui[-6:], 16))
        end = _now()
        start = end - timedelta(days=days)
        period = timedelta(minutes=max(dev.update_period_min or 10, 1))
        battery = 91.0
        next_hri = start
        ts = start
        count = 0

        async def _step(ts):
            nonlocal battery, next_hri
            acc, vel, temp = (degrade_vib(ts, end, rng) if profile == "degrade"
                              else healthy_vib(ts, rng))
            meta = {"time": ts, "rssi": -87 + rng.gauss(0, 3), "snr": 7.5 + rng.gauss(0, 1)}
            await ingest_uplink(s, dev, frame_vibration_xyz(acc, vel, temp), meta)
            if ts >= next_hri:
                uptime = 60 * 24 * 120 + int((ts - start).total_seconds() / 60)
                await ingest_uplink(s, dev, frame_hri(uptime, battery, -87, 1, 7.5), {"time": ts})
                battery -= 0.1
                next_hri = ts + timedelta(hours=24)
            await s.commit()

        while ts <= end:
            for attempt in (1, 2, 3):
                try:
                    await _step(ts)
                    break
                except Exception:
                    await s.rollback()               # deadlock with a TSDB background job
                    if attempt == 3:
                        raise
                    await s.refresh(dev)
                    await asyncio.sleep(0.5 * attempt)
            count += 1
            ts += period
        print(f"target backfill: {count} uplinks over {days:g} day(s) → {dev.name} ({eui})")


async def _live_target(eui: str, http_base: str | None, profile: str = "healthy"):
    rng = random.Random()
    print(f"live target {eui} [{profile}] — one uplink per minute (pkill -f simulate_sushi to stop)")
    while True:
        now = _now()
        acc, vel, temp = (degrade_vib(now, now, rng) if profile == "degrade"
                          else healthy_vib(now, rng))
        raw = frame_vibration_xyz(acc, vel, temp)
        if http_base:
            _post_http(http_base, eui, raw, -87 + rng.gauss(0, 3))
        else:
            async with AsyncSessionLocal() as s:
                dev = await _target_device(s, eui)
                await ingest_uplink(s, dev, raw, {"time": now, "rssi": -87, "snr": 7.5})
                await s.commit()
        print(f"{now:%H:%M:%S}  vel={vel:.2f} mm/s  temp={temp:.1f} °C", flush=True)
        await asyncio.sleep(60)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", default="QS")
    ap.add_argument("--days", type=float, default=7.0)
    ap.add_argument("--reset", action="store_true", help="wipe SIM data only and exit")
    ap.add_argument("--live", action="store_true", help="drip fresh uplinks forever")
    ap.add_argument("--http", default=None, help="live mode posts to this API base URL (real webhook path)")
    ap.add_argument("--target", default=None,
                    help="DevEUI of an already-registered device — healthy vibration+temp feed (no reset/create)")
    ap.add_argument("--profile", default="healthy", choices=["healthy", "degrade"],
                    help="target mode signal shape: steady-state vs progressive bearing failure")
    args = ap.parse_args()

    if args.target:
        eui = "".join(c for c in args.target if c.isalnum()).upper()
        if args.days > 0:
            await _backfill_target(eui, args.days, args.profile)
        if args.live or args.http:
            await _live_target(eui, args.http, args.profile)
        return

    async with AsyncSessionLocal() as s:
        if args.reset:
            await _reset(s)
            return
        plant = await _plant(s, args.plant)
        await _reset(s)
        vib, press = await _create_devices(s, plant)
        await _backfill(s, vib, press, args.days)

    if args.live or args.http:
        await _live(args.plant, args.http)


if __name__ == "__main__":
    asyncio.run(main())
