"""Yokogawa Sushi Sensor ingestion — LoRaWAN payload decoding + storage.

Decodes the uplink frames documented in "Sushi Sensor Series Software Edition"
IM 01W06C01-01EN §7 (and XS770A Functions IM 01W06E01-11EN §7):

  0x10  XS770A vibration Z-axis + temperature   (FLOAT16 acc/vel/temp)
  0x11  XS770A vibration XYZ composite + temp   (FLOAT16 acc/vel/temp)
  0x12  XS770A vibration X-axis                 (FLOAT16 acc/vel)
  0x13  XS770A vibration Y-axis                 (FLOAT16 acc/vel)
  0x30  XS530 pressure                          (FLOAT32, MPa)
  0x31  XS530 temperature                       (FLOAT32, °C)
  0x40  Health report (HRI): uptime/battery/RSSI/PER/SNR — every 24 h
  0x41  Self-diagnosis (DIAG): NAMUR NE107 status + detail words
  0x42  Initialization: 10-char tag name
  0x43  GPS (FLOAT32 lon/lat) · 0x44/0x45/0x46 accurate GPS (DOUBLE)
  0x47  Equipment info: vendor/dev-type/revision

⚠ BYTE ORDER IS AN ASSUMPTION: the manuals list fields MSB-first but never
name an endianness. We default to big-endian; if first real uplinks decode to
nonsense (e.g. velocity of thousands of mm/s), set SUSHI_BYTE_ORDER=little and
rebuild — nothing else changes. See docs/sushi-sensor-contract.md.

Measurements are stored through the platform's existing IoT tables: one
`Sensor` row per metric (auto-provisioned, code SUSHI-{EUI}-{METRIC}[-AXIS])
and `SensorReading` rows on the TimescaleDB hypertable. Threshold alarms are
evaluated here on CROSSINGS (previous value below → new value at/above) so a
1-minute update period cannot flood the alerts table.
"""
from __future__ import annotations

import base64
import binascii
import logging
import math
import re
import struct
import uuid as uuid_mod
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.models import Alert, Equipment, Machine, Sensor, SensorReading, SushiDevice

log = logging.getLogger("sushi")

_HEX_EUI = re.compile(r"^[0-9A-Fa-f]{16}$")


# ─── Low-level field decoding ──────────────────────────────────────────────────

def _order() -> str:
    return "<" if getattr(settings, "SUSHI_BYTE_ORDER", "big") == "little" else ">"


def _u16(b: bytes) -> int:
    return struct.unpack(_order() + "H", b)[0]


def _u32(b: bytes) -> int:
    return struct.unpack(_order() + "I", b)[0]


def _u24(b: bytes) -> int:
    # UINT24 (HRI uptime) — pad to 4 bytes on the correct side.
    return _u32((b"\x00" + b) if _order() == ">" else (b + b"\x00"))


def _f16(b: bytes) -> float:
    return struct.unpack(_order() + "e", b)[0]


def _f32(b: bytes) -> float:
    return struct.unpack(_order() + "f", b)[0]


def _f64(b: bytes) -> float:
    return struct.unpack(_order() + "d", b)[0]


def _finite(v: float) -> Optional[float]:
    return None if (v is None or math.isnan(v) or math.isinf(v)) else float(v)


# ─── Frame decoding ────────────────────────────────────────────────────────────
# Data_Status bit → per-metric quality. Bits per IM 01W06C01-01EN tables 7-12/13/19/20.
#   error bit → quality "error" (value not trustworthy, excluded from alarms)
#   overrange bit → quality "estimated" (clipped at range limit)

_VIB_AXIS = {0x10: "Z", 0x11: "XYZ", 0x12: "X", 0x13: "Y"}


def _vib_quality(status: int, err_bit: int, over_bit: int) -> str:
    if status & (1 << err_bit):
        return "error"
    if status & (1 << over_bit):
        return "estimated"
    return "ok"


def decode_uplink(raw: bytes) -> dict[str, Any]:
    """Decode one Sushi Sensor LoRaWAN uplink. Returns a dict with `kind` plus
    kind-specific fields; raises ValueError("bad_payload") on truncated frames
    or unknown data types."""
    if not raw:
        raise ValueError("bad_payload")
    dt = raw[0]

    if dt in _VIB_AXIS:                                   # XS770A vibration
        want = 9 if dt in (0x10, 0x11) else 7             # temp only on 0x10/0x11
        if len(raw) < want:
            raise ValueError("bad_payload")
        status = _u16(raw[1:3])
        out: dict[str, Any] = {
            "kind": "measurement",
            "data_type": dt,
            "axis": _VIB_AXIS[dt],
            "status_word": status,
            "simulation": bool(status & (1 << 8)),
            "metrics": [],
        }
        acc = _finite(_f16(raw[3:5]))
        vel = _finite(_f16(raw[5:7]))
        if acc is not None:
            out["metrics"].append(("acc", _VIB_AXIS[dt], acc, _vib_quality(status, 15, 12)))
        if vel is not None:
            out["metrics"].append(("vel", _VIB_AXIS[dt], vel, _vib_quality(status, 14, 11)))
        if dt in (0x10, 0x11):
            temp = _finite(_f16(raw[7:9]))
            if temp is not None:
                out["metrics"].append(("temp", None, temp, _vib_quality(status, 13, 10)))
        return out

    if dt == 0x30 or dt == 0x31:                          # XS530 pressure / temperature
        if len(raw) < 7:
            raise ValueError("bad_payload")
        status = _u16(raw[1:3])
        value = _finite(_f32(raw[3:7]))
        metric = "press" if dt == 0x30 else "temp"
        out = {
            "kind": "measurement",
            "data_type": dt,
            "axis": None,
            "status_word": status,
            "simulation": bool(status & (1 << 8)),
            "metrics": [],
        }
        if value is not None:
            out["metrics"].append((metric, None, value, _vib_quality(status, 15, 12)))
        return out

    if dt == 0x40:                                        # Health report (HRI)
        if len(raw) < 8:
            raise ValueError("bad_payload")
        return {
            "kind": "health",
            "data_type": dt,
            "uptime_min": _u24(raw[1:4]),
            "battery_pct": raw[4] / 2.0,                  # value is % doubled
            "rssi_dbm": -float(raw[5]),                   # "handled as a negative number"
            "per_pct": float(raw[6]),
            "snr_db": struct.unpack("b", raw[7:8])[0] / 4.0,
        }

    if dt == 0x41:                                        # Self-diagnosis (NAMUR NE107)
        if len(raw) < 9:
            raise ValueError("bad_payload")
        return {
            "kind": "diag",
            "data_type": dt,
            "diag_status": _u32(raw[1:5]),
            "diag_detail": _u32(raw[5:9]),
        }

    if dt == 0x42:                                        # Initialization: tag name
        return {
            "kind": "init",
            "data_type": dt,
            "tag_name": raw[1:11].decode("ascii", errors="replace").rstrip("\x00 "),
        }

    if dt == 0x43:                                        # GPS (lon, lat as FLOAT32)
        if len(raw) < 9:
            raise ValueError("bad_payload")
        return {
            "kind": "gps",
            "data_type": dt,
            "longitude": _finite(_f32(raw[1:5])),
            "latitude": _finite(_f32(raw[5:9])),
        }

    if dt in (0x44, 0x45, 0x46):                          # accurate GPS lon/lat/alt (DOUBLE)
        if len(raw) < 9:
            raise ValueError("bad_payload")
        value = _finite(_f64(raw[1:9]))
        key = {0x44: "longitude", 0x45: "latitude", 0x46: "altitude"}[dt]
        return {"kind": "gps", "data_type": dt, key: value}

    if dt == 0x47:                                        # equipment info
        if len(raw) < 9:
            raise ValueError("bad_payload")
        return {
            "kind": "equipment_info",
            "data_type": dt,
            "vendor_id": _u32(raw[1:5]),
            "dev_type": _u16(raw[5:7]),
            "dev_rev": _u16(raw[7:9]),
        }

    raise ValueError("unknown_data_type")


# ─── Network-server envelope extraction ────────────────────────────────────────

def _b64(data: str) -> Optional[bytes]:
    try:
        return base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        return None


def _eui(value: str) -> Optional[str]:
    """Normalize a DevEUI: accepts 16 hex chars (with/without separators) or the
    base64 of the raw 8 bytes (ChirpStack v3 JSON marshaler)."""
    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"[^0-9A-Fa-f]", "", value)
    if _HEX_EUI.match(cleaned):
        return cleaned.upper()
    raw = _b64(value)
    if raw is not None and len(raw) == 8:
        return raw.hex().upper()
    return None


def extract_envelope(body: dict) -> tuple[str, bytes, dict[str, Any]]:
    """Pull (dev_eui, raw_payload, radio_meta) out of a network server's HTTP
    integration JSON. Supported shapes, tried in order:

      · ChirpStack v4:  deviceInfo.devEui + data (b64) + rxInfo[].rssi/snr + time
      · TTN v3:         end_device_ids.dev_eui + uplink_message.frm_payload (b64)
      · ChirpStack v3 / Milesight embedded NS:  devEUI + data (b64)
      · Generic/test:   dev_eui + payload_hex | frm_payload (b64)

    Raises ValueError("bad_envelope") when nothing matches.
    """
    meta: dict[str, Any] = {}

    def _radio(rx: Any, rssi_key: str = "rssi", snr_key: str = "snr") -> None:
        if isinstance(rx, list) and rx and isinstance(rx[0], dict):
            best = max(rx, key=lambda r: r.get(rssi_key) if isinstance(r.get(rssi_key), (int, float)) else -999)
            if isinstance(best.get(rssi_key), (int, float)):
                meta["rssi"] = float(best[rssi_key])
            if isinstance(best.get(snr_key), (int, float)):
                meta["snr"] = float(best[snr_key])

    def _time(value: Any) -> None:
        if isinstance(value, str) and value:
            try:
                meta["time"] = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                pass

    # ChirpStack v4
    info = body.get("deviceInfo")
    if isinstance(info, dict) and info.get("devEui"):
        eui = _eui(info["devEui"])
        raw = _b64(body.get("data") or "")
        if eui and raw:
            _radio(body.get("rxInfo"))
            _time(body.get("time"))
            meta["f_port"] = body.get("fPort")
            return eui, raw, meta

    # TTN v3
    ids = body.get("end_device_ids")
    up = body.get("uplink_message")
    if isinstance(ids, dict) and isinstance(up, dict) and ids.get("dev_eui"):
        eui = _eui(ids["dev_eui"])
        raw = _b64(up.get("frm_payload") or "")
        if eui and raw:
            _radio(up.get("rx_metadata"))
            _time(body.get("received_at") or up.get("received_at"))
            meta["f_port"] = up.get("f_port")
            return eui, raw, meta

    # ChirpStack v3 / Milesight embedded NS
    if body.get("devEUI"):
        eui = _eui(body["devEUI"])
        raw = _b64(body.get("data") or "")
        if eui and raw:
            _radio(body.get("rxInfo"), rssi_key="rssi", snr_key="loRaSNR")
            _time(body.get("time"))
            meta["f_port"] = body.get("fPort")
            return eui, raw, meta

    # Generic / simulator
    if body.get("dev_eui"):
        eui = _eui(body["dev_eui"])
        raw = None
        if body.get("payload_hex"):
            try:
                raw = bytes.fromhex(re.sub(r"\s", "", body["payload_hex"]))
            except ValueError:
                raw = None
        elif body.get("frm_payload"):
            raw = _b64(body["frm_payload"])
        if eui and raw:
            if isinstance(body.get("rssi"), (int, float)):
                meta["rssi"] = float(body["rssi"])
            if isinstance(body.get("snr"), (int, float)):
                meta["snr"] = float(body["snr"])
            _time(body.get("time"))
            return eui, raw, meta

    raise ValueError("bad_envelope")


# ─── Storage ───────────────────────────────────────────────────────────────────

METRIC_DEFS = {
    # metric → (sensor code suffix, sensor type, unit, human label)
    "vel":   ("VEL",   "vibration",   "mm/s", "velocity RMS"),
    "acc":   ("ACC",   "vibration",   "m/s²", "acceleration peak"),
    "temp":  ("TEMP",  "temperature", "°C",   "surface temperature"),
    "press": ("PRESS", "pressure",    "MPa",  "pressure"),
}

# metric → (warn attr, crit attr) on SushiDevice — high-side thresholds
_HI_THRESHOLDS = {
    "vel":  ("vel_warn_mms", "vel_crit_mms"),
    "acc":  ("acc_warn_ms2", "acc_crit_ms2"),
    "temp": ("temp_warn_c", "temp_crit_c"),
}


def sensor_code(dev_eui: str, metric: str, axis: Optional[str]) -> str:
    suffix, *_ = METRIC_DEFS[metric]
    code = f"SUSHI-{dev_eui}-{suffix}"
    if axis and axis != "XYZ":                # composite XYZ is the canonical series
        code += f"-{axis}"
    return code


async def _get_or_create_sensor(
    s: AsyncSession, device: SushiDevice, metric: str, axis: Optional[str]
) -> Sensor:
    code = sensor_code(device.dev_eui, metric, axis)
    row = (await s.execute(select(Sensor).where(Sensor.code == code))).scalar_one_or_none()
    if row is not None:
        # Follow the device if it was re-linked to another equipment.
        if row.equipment_id != device.equipment_id and device.equipment_id is not None:
            row.equipment_id = device.equipment_id
            row.plant_id = device.plant_id
        return row
    suffix, stype, unit, label = METRIC_DEFS[metric]
    row = Sensor(
        equipment_id=device.equipment_id,
        plant_id=device.plant_id,
        code=code,
        name=f"{device.name} — {label}" + (f" ({axis})" if axis else ""),
        type=stype,
        unit=unit,
        active=True,
    )
    s.add(row)
    await s.flush()
    return row


async def _previous_value(s: AsyncSession, sensor_id) -> Optional[float]:
    return (await s.execute(
        select(SensorReading.value)
        .where(SensorReading.sensor_id == sensor_id)
        .order_by(SensorReading.timestamp.desc())
        .limit(1)
    )).scalar_one_or_none()


def _crossed(prev: Optional[float], new: float, threshold: float) -> bool:
    """Alarm on the transition into the band only (or on the very first reading
    already inside it) — never on every reading that stays above."""
    return new >= threshold and (prev is None or prev < threshold)


def _crossed_low(prev: Optional[float], new: float, threshold: float) -> bool:
    return new <= threshold and (prev is None or prev > threshold)


async def _threshold_alerts(
    s: AsyncSession, device: SushiDevice, sensor: Sensor,
    metric: str, prev: Optional[float], value: float,
) -> list[dict]:
    """Create Alert rows for crossings; returns a summary of what was created
    so the ingest route can dispatch notifications after commit."""
    unit = METRIC_DEFS[metric][2]
    created: list[dict] = []

    def _alert(severity: str, limit: float, direction: str) -> None:
        # id set explicitly — column defaults only fire at flush, and the
        # summary below needs the id before that.
        a = Alert(
            id=uuid_mod.uuid4(),
            sensor_id=sensor.id,
            equipment_id=sensor.equipment_id,
            plant_id=device.plant_id,
            type=f"sushi_{metric}",
            severity=severity,
            value_read=value,
            limit_value=limit,
            message=f"{sensor.name}: {value:g} {unit} {direction} {severity} limit {limit:g} {unit}",
        )
        s.add(a)
        created.append({
            "alert_id": str(a.id),
            "sensor_id": str(sensor.id),
            "metric": metric,
            "severity": severity,
            "value": value,
            "limit": limit,
        })

    if metric in _HI_THRESHOLDS:
        warn_attr, crit_attr = _HI_THRESHOLDS[metric]
        warn, crit = getattr(device, warn_attr), getattr(device, crit_attr)
        if crit is not None and _crossed(prev, value, crit):
            _alert("critical", crit, "above")
        elif warn is not None and _crossed(prev, value, warn):
            _alert("warning", warn, "above")
    elif metric == "press":
        if device.press_max_mpa is not None and _crossed(prev, value, device.press_max_mpa):
            _alert("warning", device.press_max_mpa, "above")
        if device.press_min_mpa is not None and _crossed_low(prev, value, device.press_min_mpa):
            _alert("warning", device.press_min_mpa, "below")
    return created


async def ingest_uplink(s: AsyncSession, device: SushiDevice, raw: bytes, meta: dict) -> dict:
    """Apply one decoded uplink to the device + readings tables. The caller
    commits. Returns a small summary dict (for the HTTP response / logs)."""
    decoded = decode_uplink(raw)
    now = datetime.now(timezone.utc)
    ts = meta.get("time") or now

    device.last_uplink_at = now
    device.last_data_type = f"0x{decoded['data_type']:02x}"
    device.last_error = None
    if "rssi" in meta:
        device.rssi_dbm = meta["rssi"]
    if "snr" in meta:
        device.snr_db = meta["snr"]

    kind = decoded["kind"]
    stored = 0
    new_alerts: list[dict] = []

    if kind == "measurement":
        if not device.enabled:
            return {"status": "ok", "kind": kind, "stored": 0, "note": "device_disabled"}
        if device.equipment_id is None:
            device.last_error = "not_linked_to_equipment"
            return {"status": "ok", "kind": kind, "stored": 0, "note": "not_linked_to_equipment"}
        for metric, axis, value, quality in decoded["metrics"]:
            sensor = await _get_or_create_sensor(s, device, metric, axis)
            prev = await _previous_value(s, sensor.id)
            s.add(SensorReading(
                sensor_id=sensor.id,
                equipment_id=sensor.equipment_id,
                timestamp=ts,
                value=value,
                quality=quality,
            ))
            stored += 1
            if quality == "ok" and not decoded.get("simulation"):
                new_alerts += await _threshold_alerts(s, device, sensor, metric, prev, value)

    elif kind == "health":
        device.uptime_min = decoded["uptime_min"]
        device.battery_pct = decoded["battery_pct"]
        device.per_pct = decoded["per_pct"]
        # The device-side HRI radio stats only apply when the gateway didn't
        # already provide fresher ones in this envelope.
        device.rssi_dbm = meta.get("rssi", decoded["rssi_dbm"])
        device.snr_db = meta.get("snr", decoded["snr_db"])

    elif kind == "diag":
        device.diag_status = decoded["diag_status"]
        device.diag_detail = decoded["diag_detail"]

    elif kind == "init":
        device.tag_name = decoded["tag_name"]

    elif kind == "gps":
        if decoded.get("latitude") is not None:
            device.latitude = decoded["latitude"]
        if decoded.get("longitude") is not None:
            device.longitude = decoded["longitude"]

    elif kind == "equipment_info":
        device.dev_type = decoded["dev_type"]
        device.dev_rev = decoded["dev_rev"]

    out: dict = {"status": "ok", "kind": kind, "stored": stored}
    if new_alerts:
        out["new_alerts"] = new_alerts
        out["reading_at"] = ts.isoformat()
    return out


# ─── Condition-alert SMS dispatch ──────────────────────────────────────────────
# Fired from the ingest ROUTE only (fire-and-forget, own session) — the
# simulator's direct backfill calls never reach it, so replaying history can
# never page anyone. Warning crossings stay in-app; critical ones send SMS.

SMS_SEVERITIES = {"critical"}
SMS_COOLDOWN_MIN = 60      # max one SMS per sensor+severity per hour
SMS_FRESHNESS_MIN = 15     # never page for an old/replayed frame

METRIC_SMS_LABELS = {      # SMS copy is French, like every template in the platform
    "vel": "vibration (vitesse RMS)",
    "acc": "vibration (accélération)",
    "temp": "température",
    "press": "pression",
}


async def _recent_duplicate_alert(
    s: AsyncSession, sensor_id, severity: str, exclude_id, minutes: int = SMS_COOLDOWN_MIN,
) -> bool:
    """True when the same sensor already alerted at this severity inside the
    cooldown window (a value hovering around the threshold re-crosses often —
    the platform keeps every Alert row, people get paged once an hour)."""
    since = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    row = (await s.execute(
        select(Alert.id).where(
            Alert.sensor_id == sensor_id,
            Alert.severity == severity,
            Alert.created_at >= since,
            Alert.id != exclude_id,
        ).limit(1)
    )).first()
    return row is not None


# Which maintenance problem type a condition metric maps to on the auto ticket.
_METRIC_PROBLEM_TYPE = {"vel": "mechanical", "acc": "mechanical", "temp": "mechanical", "press": "pneumatic"}


async def _ensure_condition_ticket(s: AsyncSession, device: SushiDevice, equipment_name: str, a: dict) -> Optional[str]:
    """Carry a critical condition crossing into the maintenance flow: one
    ticket + its linked alert (ALT-…) so it shows up in Gestion BT / My Work.
    `machine_stopped=False` — condition monitoring catches problems while the
    machine is still RUNNING, so no waiting-intervention is created and the
    kiosk/map status is untouched. Reuses the machine's existing open ticket
    instead of stacking a second one. Returns the ticket number."""
    from app.models.models import AlertPriority, AlertProblemType
    from app.schemas.maintenance import TicketCreate
    from app.services.ticket_service import DuplicateTicketError, TicketService

    unit = METRIC_DEFS[a["metric"]][2]
    label = METRIC_SMS_LABELS.get(a["metric"], a["metric"])
    data = TicketCreate(
        machine_id=device.equipment_id,     # create_ticket resolves equipment → machine
        priority=AlertPriority.high,        # urgent, but the machine still runs (no 10-min SLA storm)
        problem_type=AlertProblemType(_METRIC_PROBLEM_TYPE.get(a["metric"], "other")),
        description=(
            f"Surveillance de condition — {equipment_name}: {label} "
            f"{a['value']:.2f} {unit} au-dessus du seuil critique {a['limit']:g} {unit} "
            f"(capteur {device.name}). Machine toujours en marche."
        ),
        machine_stopped=False,
    )
    try:
        ticket = await TicketService(s).create_ticket(data, created_by=f"Capteur {device.name}", notify=False)
        return ticket.ticket_number
    except DuplicateTicketError as e:
        return e.existing.get("ticket_number")


async def notify_condition_alerts(device_id: str, new_alerts: list[dict], reading_at_iso: Optional[str]) -> None:
    """Critical threshold crossings of one uplink → maintenance ticket in the
    WO-management queue + SMS/email page. Own session + swallow-all: a
    notification failure must never affect ingestion."""
    from app.db.session import AsyncSessionLocal
    from app.services.notification_service import NotificationService

    try:
        to_send = [a for a in new_alerts if a["severity"] in SMS_SEVERITIES]
        if not to_send:
            return
        if reading_at_iso:
            ts = datetime.fromisoformat(reading_at_iso)
            if datetime.now(timezone.utc) - ts > timedelta(minutes=SMS_FRESHNESS_MIN):
                return
        async with AsyncSessionLocal() as s:
            device = await s.get(SushiDevice, uuid_mod.UUID(device_id))
            if device is None or device.equipment_id is None:
                return
            eq = await s.get(Equipment, device.equipment_id)
            machine = (await s.execute(
                select(Machine).where(Machine.equipment_id == device.equipment_id).limit(1)
            )).scalar_one_or_none()
            equipment_name = eq.name if eq else device.name
            svc = NotificationService(s)
            for a in to_send:
                # The ticket enters the queue regardless of the SMS cooldown.
                ticket_number = await _ensure_condition_ticket(s, device, equipment_name, a)
                if machine is None:
                    # create_ticket may have just created the Machine row —
                    # scoped escalation contacts need it to match.
                    machine = (await s.execute(
                        select(Machine).where(Machine.equipment_id == device.equipment_id).limit(1)
                    )).scalar_one_or_none()
                if await _recent_duplicate_alert(
                    s, uuid_mod.UUID(a["sensor_id"]), a["severity"], uuid_mod.UUID(a["alert_id"]),
                ):
                    continue
                await svc.notify_condition_alert(
                    equipment_name=equipment_name,
                    plant_id=device.plant_id,
                    machine=machine,
                    severity=a["severity"],
                    metric_label=METRIC_SMS_LABELS.get(a["metric"], a["metric"]),
                    value=a["value"],
                    unit=METRIC_DEFS[a["metric"]][2],
                    limit_value=a["limit"],
                    ticket_number=ticket_number,
                )
            await s.commit()
    except Exception:
        log.exception("condition-alert notification failed (ingest unaffected)")


# ─── Read model helpers ────────────────────────────────────────────────────────

def device_health(device: SushiDevice, now: Optional[datetime] = None) -> str:
    """online | stale | offline | unknown — from last uplink vs update period."""
    if device.last_uplink_at is None:
        return "unknown"
    now = now or datetime.now(timezone.utc)
    period = max(device.update_period_min or 60, 1)
    silent_min = (now - device.last_uplink_at).total_seconds() / 60.0
    if silent_min <= period * 2.5:
        return "online"
    if silent_min <= period * 6:
        return "stale"
    return "offline"


# NAMUR NE107 representative bits (word MSB side): F/C/O/M.
def namur_state(diag_status: Optional[int]) -> Optional[str]:
    if diag_status is None:
        return None
    if diag_status & (1 << 31):
        return "failure"
    if diag_status & (1 << 29):
        return "out_of_spec"
    if diag_status & (1 << 28):
        return "maintenance"
    if diag_status & (1 << 30):
        return "check"
    return "good"
