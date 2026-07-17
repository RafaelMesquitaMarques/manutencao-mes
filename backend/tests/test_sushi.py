"""
Yokogawa Sushi Sensor tests — sushi_service.
============================================
Same container harness as test_pit_stop.py: each async body runs on one shared
event loop and every write is ALWAYS rolled back. Covers:

  binary decoding of every documented frame (vibration FLOAT16, XS530 FLOAT32,
  HRI, DIAG, INI, GPS, equipment info) · Data_Status → reading quality ·
  truncated/unknown frames rejected · network-server envelope extraction
  (ChirpStack v4/v3, TTN v3, generic) · sensors auto-provisioned per metric ·
  threshold alarms fire on CROSSINGS only (no flooding) · pressure band ·
  simulation/errored readings never alarm · disabled/unlinked devices store
  nothing · HRI updates health fields · staleness state machine.

Run (inside the backend container):
    pytest tests/test_sushi.py -v
"""
import asyncio
import math
import os
import struct
import sys
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                                  # noqa: E402
from app.models.models import (                                       # noqa: E402
    Alert, Equipment, Plant, Sensor, SensorReading, SushiDevice, SushiSensorModel,
)
from app.services.sushi_service import (                               # noqa: E402
    _recent_duplicate_alert, decode_uplink, device_health, extract_envelope,
    ingest_uplink, namur_state, sensor_code,
)

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    """Async body on the shared loop, always rolled back."""
    def wrapper():
        async def runner():
            s = _maker()()
            try:
                await fn(s)
            finally:
                await s.rollback()
                await s.close()
        _LOOP.run_until_complete(runner())
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


def _now():
    return datetime.now(timezone.utc)


# ─── Frame builders (mirror scripts/simulate_sushi.py) ─────────────────────────

def vib_xyz(acc=3.5, vel=2.8, temp=36.5, status=0):
    return struct.pack(">BHeee", 0x11, status, acc, vel, temp)


def vib_axis(dt=0x12, acc=3.5, vel=2.8, status=0):
    return struct.pack(">BHee", dt, status, acc, vel)


def press_frame(mpa=0.62, status=0):
    return struct.pack(">BHf", 0x30, status, mpa)


def xs530_temp_frame(c=48.0, status=0):
    return struct.pack(">BHf", 0x31, status, c)


def hri_frame(uptime=1440, battery=87.0, rssi=-84, per=2, snr=8.5):
    return bytes([
        0x40, (uptime >> 16) & 0xFF, (uptime >> 8) & 0xFF, uptime & 0xFF,
        int(battery * 2), int(-rssi), int(per),
    ]) + struct.pack("b", int(snr * 4))


# ─── Decoder ───────────────────────────────────────────────────────────────────

def test_decode_vibration_xyz():
    d = decode_uplink(vib_xyz(acc=5.25, vel=3.125, temp=41.5))
    assert d["kind"] == "measurement" and d["axis"] == "XYZ"
    metrics = {m[0]: m for m in d["metrics"]}
    assert metrics["acc"][2] == pytest.approx(5.25, rel=2e-3)
    assert metrics["vel"][2] == pytest.approx(3.125, rel=2e-3)
    assert metrics["temp"][2] == pytest.approx(41.5, rel=2e-3)
    assert all(m[3] == "ok" for m in d["metrics"])


def test_decode_vibration_single_axis_has_no_temp():
    d = decode_uplink(vib_axis(0x12, acc=1.5, vel=0.75))
    assert d["axis"] == "X"
    assert {m[0] for m in d["metrics"]} == {"acc", "vel"}


def test_decode_status_bits_map_to_quality():
    # bit14 = velocity error, bit10 = temperature overrange
    d = decode_uplink(vib_xyz(status=(1 << 14) | (1 << 10)))
    q = {m[0]: m[3] for m in d["metrics"]}
    assert q["vel"] == "error"
    assert q["temp"] == "estimated"
    assert q["acc"] == "ok"


def test_decode_simulation_bit():
    assert decode_uplink(vib_xyz(status=1 << 8))["simulation"] is True


def test_decode_pressure_and_temp_float32():
    d = decode_uplink(press_frame(0.6125))
    assert d["metrics"][0][0] == "press"
    assert d["metrics"][0][2] == pytest.approx(0.6125, rel=1e-6)
    d2 = decode_uplink(xs530_temp_frame(48.25))
    assert d2["metrics"][0][0] == "temp"
    assert d2["metrics"][0][2] == pytest.approx(48.25, rel=1e-6)


def test_decode_hri_scaling():
    d = decode_uplink(hri_frame(uptime=100000, battery=75.0, rssi=-97, per=3, snr=6.75))
    assert d["kind"] == "health"
    assert d["uptime_min"] == 100000
    assert d["battery_pct"] == 75.0          # stored doubled on the wire
    assert d["rssi_dbm"] == -97.0            # "handled as a negative number"
    assert d["per_pct"] == 3.0
    assert d["snr_db"] == 6.75               # stored ×4 on the wire


def test_decode_diag_ini_gps_equipment():
    diag = decode_uplink(struct.pack(">BII", 0x41, 1 << 31, 1 << 30))
    assert diag["diag_status"] == 1 << 31 and diag["diag_detail"] == 1 << 30
    assert namur_state(diag["diag_status"]) == "failure"
    assert namur_state(0) == "good"

    ini = decode_uplink(b"\x42" + b"PUMP-7\x00\x00\x00\x00")
    assert ini["tag_name"] == "PUMP-7"

    gps = decode_uplink(struct.pack(">Bff", 0x43, -73.5, 45.75))
    assert gps["longitude"] == pytest.approx(-73.5)
    assert gps["latitude"] == pytest.approx(45.75)

    acc_lat = decode_uplink(struct.pack(">Bd", 0x45, 45.7523))
    assert acc_lat["latitude"] == pytest.approx(45.7523)

    info = decode_uplink(struct.pack(">BIHH", 0x47, 0x594F4B4F, 2, 3))
    assert info["dev_type"] == 2 and info["dev_rev"] == 3


def test_decode_rejects_bad_frames():
    with pytest.raises(ValueError):
        decode_uplink(b"")
    with pytest.raises(ValueError):
        decode_uplink(b"\x11\x00\x00\x01")           # truncated vibration
    with pytest.raises(ValueError):
        decode_uplink(b"\x99\x00\x00\x00\x00\x00")   # unknown data type


def test_decode_nan_metric_is_dropped():
    nan16 = struct.pack(">e", math.nan)
    raw = b"\x11\x00\x00" + nan16 + struct.pack(">ee", 2.5, 30.0)
    d = decode_uplink(raw)
    assert {m[0] for m in d["metrics"]} == {"vel", "temp"}


# ─── Envelope extraction ───────────────────────────────────────────────────────

def _b64(raw: bytes) -> str:
    import base64
    return base64.b64encode(raw).decode()


def test_envelope_chirpstack_v4():
    eui, raw, meta = extract_envelope({
        "deviceInfo": {"devEui": "f0f0770a00000001"},
        "data": _b64(vib_xyz()),
        "fPort": 1,
        "rxInfo": [{"rssi": -101, "snr": 4.5}, {"rssi": -88, "snr": 9.0}],
        "time": "2026-07-16T12:00:00+00:00",
    })
    assert eui == "F0F0770A00000001"
    assert raw[0] == 0x11
    assert meta["rssi"] == -88.0 and meta["snr"] == 9.0   # best gateway wins
    assert meta["time"].hour == 12


def test_envelope_ttn_v3():
    eui, raw, meta = extract_envelope({
        "end_device_ids": {"dev_eui": "F0-F0-77-0A-00-00-00-01"},
        "uplink_message": {
            "frm_payload": _b64(press_frame()),
            "f_port": 1,
            "rx_metadata": [{"rssi": -95, "snr": 7.25}],
        },
        "received_at": "2026-07-16T12:34:56.789Z",
    })
    assert eui == "F0F0770A00000001"
    assert raw[0] == 0x30
    assert meta["rssi"] == -95.0


def test_envelope_chirpstack_v3_base64_eui():
    raw_eui = bytes.fromhex("f0f0770a00000001")
    eui, raw, _ = extract_envelope({
        "devEUI": _b64(raw_eui),
        "data": _b64(hri_frame()),
    })
    assert eui == "F0F0770A00000001"
    assert raw[0] == 0x40


def test_envelope_generic_hex():
    eui, raw, meta = extract_envelope({
        "dev_eui": "F0F0770A00000001",
        "payload_hex": vib_xyz().hex(),
        "rssi": -80,
    })
    assert raw == vib_xyz()
    assert meta["rssi"] == -80.0


def test_envelope_rejects_garbage():
    with pytest.raises(ValueError):
        extract_envelope({"hello": "world"})
    with pytest.raises(ValueError):
        extract_envelope({"deviceInfo": {"devEui": "xyz"}, "data": "!!!"})


# ─── Service (DB) ──────────────────────────────────────────────────────────────

async def _plant(s):
    p = Plant(code=f"T{uuid.uuid4().hex[:6]}", name="Test plant")
    s.add(p)
    await s.flush()
    return p


async def _equipment(s, plant):
    eq = Equipment(plant_id=plant.id, code=f"EQ-{uuid.uuid4().hex[:6]}", name="Press 9")
    s.add(eq)
    await s.flush()
    return eq


async def _device(s, plant, eq, **kw):
    fields = dict(
        plant_id=plant.id,
        name="Sushi test",
        dev_eui=uuid.uuid4().hex[:16].upper(),
        model=SushiSensorModel.xs770a,
        equipment_id=eq.id if eq is not None else None,
        update_period_min=10,
        vel_warn_mms=4.5, vel_crit_mms=7.1,
    )
    fields.update(kw)
    d = SushiDevice(**fields)
    s.add(d)
    await s.flush()
    return d


async def _alerts(s, device):
    codes = [sensor_code(device.dev_eui, m, a) for m, a in
             [("vel", "XYZ"), ("acc", "XYZ"), ("temp", None), ("press", None)]]
    sensor_ids = (await s.execute(select(Sensor.id).where(Sensor.code.in_(codes)))).scalars().all()
    if not sensor_ids:
        return []
    return (await s.execute(
        select(Alert).where(Alert.sensor_id.in_(sensor_ids)).order_by(Alert.created_at)
    )).scalars().all()


@with_session
async def test_ingest_creates_sensors_and_readings(s):
    plant = await _plant(s)
    eq = await _equipment(s, plant)
    d = await _device(s, plant, eq)
    res = await ingest_uplink(s, d, vib_xyz(acc=3.5, vel=2.8, temp=36.5), {"time": _now(), "rssi": -85})
    assert res["stored"] == 3
    sensors = (await s.execute(
        select(Sensor).where(Sensor.code.like(f"SUSHI-{d.dev_eui}-%"))
    )).scalars().all()
    assert {x.code.rsplit("-", 1)[-1] for x in sensors} == {"VEL", "ACC", "TEMP"}
    assert all(x.equipment_id == eq.id and x.plant_id == plant.id for x in sensors)
    readings = (await s.execute(
        select(SensorReading).where(SensorReading.equipment_id == eq.id)
    )).scalars().all()
    assert len(readings) == 3
    assert d.last_data_type == "0x11"
    assert d.rssi_dbm == -85
    assert d.last_uplink_at is not None


@with_session
async def test_threshold_alerts_fire_on_crossings_only(s):
    plant = await _plant(s)
    eq = await _equipment(s, plant)
    d = await _device(s, plant, eq)
    t0 = _now() - timedelta(minutes=50)
    results = []
    for i, vel in enumerate([3.0, 5.0, 5.5, 7.5, 6.0, 7.3]):
        results.append(await ingest_uplink(
            s, d, vib_xyz(vel=vel, acc=1.0, temp=30.0), {"time": t0 + timedelta(minutes=10 * i)}))
    alerts = [a for a in await _alerts(s, d) if a.type == "sushi_vel"]
    # 3.0 → nothing · 5.0 crosses warn · 5.5 stays (no alert) · 7.5 crosses crit ·
    # 6.0 drops below crit · 7.3 crosses crit again
    assert [a.severity for a in alerts] == ["warning", "critical", "critical"]
    assert alerts[0].limit_value == 4.5
    assert alerts[1].value_read == pytest.approx(7.5, rel=2e-3)
    # ingest reports the crossings so the route can dispatch notifications
    assert "new_alerts" not in results[0]
    assert [a["severity"] for a in results[1]["new_alerts"]] == ["warning"]
    assert [a["severity"] for a in results[3]["new_alerts"]] == ["critical"]
    assert results[3]["new_alerts"][0]["metric"] == "vel"
    assert results[3]["reading_at"] is not None


@with_session
async def test_sms_cooldown_detects_recent_duplicate(s):
    plant = await _plant(s)
    eq = await _equipment(s, plant)
    d = await _device(s, plant, eq)
    t0 = _now() - timedelta(minutes=30)
    # The dispatch check runs right after each uplink (as the route does), so
    # the first crossing sees no sibling yet…
    r1 = await ingest_uplink(s, d, vib_xyz(vel=8.0, acc=1.0, temp=30.0), {"time": t0})
    first = r1["new_alerts"][0]
    assert await _recent_duplicate_alert(
        s, uuid.UUID(first["sensor_id"]), "critical", uuid.UUID(first["alert_id"])) is False
    # …while a re-crossing inside the hour is suppressed by the cooldown.
    await ingest_uplink(s, d, vib_xyz(vel=6.0, acc=1.0, temp=30.0), {"time": t0 + timedelta(minutes=10)})
    r2 = await ingest_uplink(s, d, vib_xyz(vel=8.2, acc=1.0, temp=30.0), {"time": t0 + timedelta(minutes=20)})
    second = r2["new_alerts"][0]
    assert await _recent_duplicate_alert(
        s, uuid.UUID(second["sensor_id"]), "critical", uuid.UUID(second["alert_id"])) is True


@with_session
async def test_first_reading_already_above_threshold_alerts(s):
    plant = await _plant(s)
    eq = await _equipment(s, plant)
    d = await _device(s, plant, eq)
    await ingest_uplink(s, d, vib_xyz(vel=9.0, acc=1.0, temp=30.0), {})
    alerts = [a for a in await _alerts(s, d) if a.type == "sushi_vel"]
    assert [a.severity for a in alerts] == ["critical"]


@with_session
async def test_pressure_band_alerts(s):
    plant = await _plant(s)
    eq = await _equipment(s, plant)
    d = await _device(s, plant, eq, model=SushiSensorModel.xs530,
                      vel_warn_mms=None, vel_crit_mms=None,
                      press_min_mpa=0.50, press_max_mpa=0.75)
    t0 = _now() - timedelta(minutes=30)
    for i, mpa in enumerate([0.62, 0.45, 0.44, 0.80]):
        await ingest_uplink(s, d, press_frame(mpa), {"time": t0 + timedelta(minutes=10 * i)})
    alerts = [a for a in await _alerts(s, d) if a.type == "sushi_press"]
    assert len(alerts) == 2                      # one below-min crossing, one above-max
    assert {a.severity for a in alerts} == {"warning"}


@with_session
async def test_simulation_and_errored_readings_never_alert(s):
    plant = await _plant(s)
    eq = await _equipment(s, plant)
    d = await _device(s, plant, eq)
    await ingest_uplink(s, d, vib_xyz(vel=9.9, status=1 << 8), {})          # simulation mode
    await ingest_uplink(s, d, vib_xyz(vel=9.9, status=1 << 14), {})         # velocity error bit
    assert [a for a in await _alerts(s, d) if a.type == "sushi_vel"] == []
    q = (await s.execute(
        select(SensorReading.quality).where(SensorReading.equipment_id == eq.id)
    )).scalars().all()
    assert "error" in q                          # errored reading stored, flagged


@with_session
async def test_disabled_and_unlinked_devices_store_nothing(s):
    plant = await _plant(s)
    eq = await _equipment(s, plant)
    off = await _device(s, plant, eq, enabled=False)
    res = await ingest_uplink(s, off, vib_xyz(), {})
    assert res["stored"] == 0 and off.last_uplink_at is not None

    loose = await _device(s, plant, None)
    res2 = await ingest_uplink(s, loose, vib_xyz(), {})
    assert res2["note"] == "not_linked_to_equipment"
    assert loose.last_error == "not_linked_to_equipment"
    readings = (await s.execute(
        select(SensorReading).join(Sensor, Sensor.id == SensorReading.sensor_id)
        .where(Sensor.code.like(f"SUSHI-{loose.dev_eui}-%"))
    )).scalars().all()
    assert readings == []


@with_session
async def test_hri_diag_ini_update_device(s):
    plant = await _plant(s)
    eq = await _equipment(s, plant)
    d = await _device(s, plant, eq)
    await ingest_uplink(s, d, hri_frame(uptime=2880, battery=64.0, rssi=-90, per=1, snr=7.0), {})
    assert d.battery_pct == 64.0 and d.uptime_min == 2880 and d.per_pct == 1.0
    assert d.rssi_dbm == -90.0                   # HRI used when no radio meta

    await ingest_uplink(s, d, struct.pack(">BII", 0x41, (1 << 28) | 1, 1 << 30), {})
    assert namur_state(d.diag_status) == "maintenance"

    await ingest_uplink(s, d, b"\x42" + b"FH6-MOTOR\x00", {})
    assert d.tag_name == "FH6-MOTOR"


@with_session
async def test_series_bucket_sql(s):
    """The condition endpoint's time_bucket SQL must bind cleanly via asyncpg
    (interval params can't be strings) and aggregate per bucket."""
    from app.api.routes.sushi import _SERIES_SQL
    plant = await _plant(s)
    eq = await _equipment(s, plant)
    d = await _device(s, plant, eq)
    t0 = _now() - timedelta(minutes=30)
    for i in range(6):
        await ingest_uplink(s, d, vib_xyz(vel=2.0 + i, acc=1.0, temp=30.0),
                            {"time": t0 + timedelta(minutes=5 * i)})
    vel_sensor = (await s.execute(
        select(Sensor).where(Sensor.code == sensor_code(d.dev_eui, "vel", "XYZ"))
    )).scalar_one()
    rows = (await s.execute(_SERIES_SQL, {
        "bucket_minutes": 10,
        "sensor_id": vel_sensor.id,
        "since": t0 - timedelta(minutes=1),
    })).all()
    assert len(rows) >= 3
    assert rows[0].max_value >= rows[0].avg_value >= rows[0].min_value


@with_session
async def test_condition_ticket_created_without_stopping_machine(s):
    """Critical crossing → maintenance ticket + linked alert in the WO queue,
    machine_stopped=False (no waiting intervention), duplicate reuses the open
    ticket. NOTE: create_ticket commits — this test cleans up after itself."""
    from sqlalchemy import delete as sa_delete
    from app.models.models import (
        Machine, MachineIntervention, MaintenanceAlert, MaintenanceTicket, Plant as PlantM,
        Equipment as EquipmentM, SushiDevice as SushiDeviceM,
    )
    from app.services.sushi_service import _ensure_condition_ticket

    plant = await _plant(s)
    eq = await _equipment(s, plant)
    d = await _device(s, plant, eq)
    a = {"metric": "vel", "severity": "critical", "value": 8.0, "limit": 7.1,
         "sensor_id": str(uuid.uuid4()), "alert_id": str(uuid.uuid4())}
    try:
        number = await _ensure_condition_ticket(s, d, eq.name, a)
        assert number and "TKT" in number

        ticket = (await s.execute(
            select(MaintenanceTicket).where(MaintenanceTicket.ticket_number == number)
        )).scalar_one()
        assert ticket.status.value == "open"
        assert ticket.priority.value == "high"
        assert "8.00 mm/s" in (ticket.description or "")
        alert = await s.get(MaintenanceAlert, ticket.alert_id)
        assert alert is not None and alert.status.value == "new_alert"
        # the machine keeps running: no waiting intervention was created
        iv = (await s.execute(
            select(MachineIntervention).where(MachineIntervention.ticket_id == ticket.id)
        )).scalars().all()
        assert iv == []

        # second critical while the ticket is open → reuse, never a second ticket
        number2 = await _ensure_condition_ticket(s, d, eq.name, a)
        assert number2 == number
        count = (await s.execute(
            select(MaintenanceTicket.id).where(MaintenanceTicket.machine_id == ticket.machine_id)
        )).all()
        assert len(count) == 1
    finally:
        # create_ticket committed — remove everything this test persisted
        ticket_row = (await s.execute(
            select(MaintenanceTicket).where(MaintenanceTicket.machine_id == eq.id)
        )).scalar_one_or_none()
        if ticket_row is not None:
            # alert.ticket_id and ticket.alert_id reference each other — break
            # the cycle before deleting either side.
            ticket_row.alert_id = None
            await s.flush()
            await s.execute(sa_delete(MaintenanceAlert).where(MaintenanceAlert.machine_id == eq.id))
            await s.execute(sa_delete(MaintenanceTicket).where(MaintenanceTicket.id == ticket_row.id))
        await s.execute(sa_delete(SushiDeviceM).where(SushiDeviceM.id == d.id))
        await s.execute(sa_delete(Machine).where(Machine.equipment_id == eq.id))
        await s.execute(sa_delete(EquipmentM).where(EquipmentM.id == eq.id))
        await s.execute(sa_delete(PlantM).where(PlantM.id == plant.id))
        await s.commit()


def test_device_health_states():
    d = SushiDevice(name="x", dev_eui="A" * 16, update_period_min=10)
    assert device_health(d) == "unknown"
    now = _now()
    d.last_uplink_at = now - timedelta(minutes=5)
    assert device_health(d, now) == "online"
    d.last_uplink_at = now - timedelta(minutes=40)
    assert device_health(d, now) == "stale"
    d.last_uplink_at = now - timedelta(minutes=90)
    assert device_health(d, now) == "offline"
