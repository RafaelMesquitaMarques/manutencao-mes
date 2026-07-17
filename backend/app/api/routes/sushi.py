"""Sushi Sensor data plane — LoRaWAN uplink ingest + condition read model.

Two routers, registered separately in main.py:

  ingest_router     POST /api/sushi/uplink — called by the LoRaWAN network
                    server's HTTP integration (ChirpStack v4/v3, TTN v3,
                    Milesight embedded NS, or the simulator's generic shape).
                    No JWT: authenticated by the deployment-wide
                    SUSHI_INGEST_TOKEN in the X-Ingest-Token header.

  condition_router  GET /api/sushi/equipment/{id}/condition — everything the
                    Equipment "Condition monitoring" tab needs in one call:
                    device health, latest value + bucketed series per metric,
                    recent threshold alerts. Guarded by the `equipment`
                    resource at registration.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import Alert, Equipment, Sensor, SensorReading, SushiDevice, User
from app.services.sushi_service import (
    device_health, extract_envelope, ingest_uplink, namur_state,
    notify_condition_alerts,
)

log = logging.getLogger("sushi")

ingest_router = APIRouter()
condition_router = APIRouter()


# ─── Ingest ────────────────────────────────────────────────────────────────────

@ingest_router.post("/uplink")
async def sushi_uplink(
    request: Request,
    event: str = Query("up"),
    db: AsyncSession = Depends(get_db),
):
    token = settings.SUSHI_INGEST_TOKEN
    if not token:
        raise HTTPException(status_code=503, detail="sushi_ingest_token_not_configured")
    if request.headers.get("X-Ingest-Token") != token:
        raise HTTPException(status_code=401, detail="invalid_ingest_token")

    # ChirpStack posts join/status/ack events to the same URL (?event=…) —
    # only uplinks carry sensor data, the rest are acknowledged and dropped.
    if event not in ("up", "uplink"):
        return {"status": "ignored", "event": event}

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="bad_envelope")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="bad_envelope")

    try:
        dev_eui, raw, meta = extract_envelope(body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    device = (await db.execute(
        select(SushiDevice).where(SushiDevice.dev_eui == dev_eui)
    )).scalar_one_or_none()
    if device is None:
        # Fail closed: devices must be registered (with a plant) before their
        # data is accepted — mirrors the platform's NULL-plant-is-hidden rule.
        log.warning("sushi uplink from unregistered DevEUI %s — register it in /settings/devices", dev_eui)
        raise HTTPException(status_code=404, detail="unknown_device")

    try:
        result = await ingest_uplink(db, device, raw, meta)
    except ValueError as e:
        device.last_uplink_at = datetime.now(timezone.utc)
        device.last_error = str(e)
        await db.commit()
        raise HTTPException(status_code=400, detail=str(e))

    device_id = str(device.id)
    await db.commit()

    # Threshold crossings → SMS/email, fire-and-forget so the network server's
    # webhook gets its 200 without waiting on Twilio.
    if result.get("new_alerts"):
        asyncio.create_task(
            notify_condition_alerts(device_id, result["new_alerts"], result.get("reading_at"))
        )
    return result


# ─── Condition read model ──────────────────────────────────────────────────────

def _bucket_minutes(hours: int) -> int:
    if hours <= 6:
        return 1
    if hours <= 24:
        return 5
    if hours <= 72:
        return 15
    if hours <= 168:
        return 30
    return 120


def _parse_code(code: str) -> tuple[str, Optional[str]]:
    """SUSHI-{EUI}-VEL[-X] → (metric, axis)."""
    parts = code.split("-")
    suffix_map = {"VEL": "vel", "ACC": "acc", "TEMP": "temp", "PRESS": "press"}
    metric = suffix_map.get(parts[2], "unknown") if len(parts) > 2 else "unknown"
    axis = parts[3] if len(parts) > 3 else None
    return metric, axis


# INTERVAL '1 minute' * :n keeps the bind an int — asyncpg cannot encode a
# string into an interval-typed parameter (CAST(:x AS interval) breaks).
_SERIES_SQL = text("""
    SELECT time_bucket(INTERVAL '1 minute' * :bucket_minutes, timestamp) AS bucket,
           avg(value) AS avg_value,
           max(value) AS max_value,
           min(value) AS min_value
    FROM sensor_readings
    WHERE sensor_id = :sensor_id AND timestamp >= :since
    GROUP BY bucket
    ORDER BY bucket
""")


def _threshold_out(d: SushiDevice) -> dict:
    return {
        "vel_warn_mms": d.vel_warn_mms, "vel_crit_mms": d.vel_crit_mms,
        "acc_warn_ms2": d.acc_warn_ms2, "acc_crit_ms2": d.acc_crit_ms2,
        "temp_warn_c": d.temp_warn_c, "temp_crit_c": d.temp_crit_c,
        "press_min_mpa": d.press_min_mpa, "press_max_mpa": d.press_max_mpa,
    }


@condition_router.get("/equipment/{equipment_id}/condition")
async def equipment_condition(
    equipment_id: UUID,
    hours: int = Query(24, ge=1, le=2160),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    ensure_same_plant(await db.get(Equipment, equipment_id), ctx, detail="equipment_not_found")

    devices = (await db.execute(
        select(SushiDevice).where(SushiDevice.equipment_id == equipment_id).order_by(SushiDevice.name)
    )).scalars().all()

    sensors = (await db.execute(
        select(Sensor).where(
            Sensor.equipment_id == equipment_id,
            Sensor.code.like("SUSHI-%"),
        ).order_by(Sensor.code)
    )).scalars().all()

    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    bucket = _bucket_minutes(hours)

    series = []
    for sensor in sensors:
        rows = (await db.execute(_SERIES_SQL, {
            "bucket_minutes": bucket,
            "sensor_id": sensor.id,
            "since": since,
        })).all()
        latest = (await db.execute(
            select(SensorReading.value, SensorReading.timestamp, SensorReading.quality)
            .where(SensorReading.sensor_id == sensor.id)
            .order_by(SensorReading.timestamp.desc())
            .limit(1)
        )).first()
        metric, axis = _parse_code(sensor.code)
        series.append({
            "sensor_id": str(sensor.id),
            "code": sensor.code,
            "name": sensor.name,
            "metric": metric,
            "axis": axis,
            "unit": sensor.unit,
            "latest": {
                "value": latest.value,
                "timestamp": latest.timestamp.isoformat(),
                "quality": latest.quality,
            } if latest else None,
            "points": [
                {
                    "t": r.bucket.isoformat(),
                    "avg": float(r.avg_value),
                    "max": float(r.max_value),
                    "min": float(r.min_value),
                }
                for r in rows
            ],
        })

    alerts = []
    if sensors:
        sensor_ids = [s.id for s in sensors]
        rows = (await db.execute(
            select(Alert).where(Alert.sensor_id.in_(sensor_ids))
            .order_by(Alert.created_at.desc()).limit(20)
        )).scalars().all()
        alerts = [
            {
                "id": str(a.id),
                "type": a.type,
                "severity": a.severity,
                "value_read": a.value_read,
                "limit_value": a.limit_value,
                "message": a.message,
                "acknowledged": bool(a.acknowledged),
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in rows
        ]

    return {
        "devices": [
            {
                "id": str(d.id),
                "name": d.name,
                "dev_eui": d.dev_eui,
                "model": d.model.value if d.model else None,
                "enabled": bool(d.enabled),
                "health": device_health(d),
                "namur": namur_state(d.diag_status),
                "last_uplink_at": d.last_uplink_at.isoformat() if d.last_uplink_at else None,
                "battery_pct": d.battery_pct,
                "rssi_dbm": d.rssi_dbm,
                "snr_db": d.snr_db,
                "per_pct": d.per_pct,
                "update_period_min": d.update_period_min,
                "tag_name": d.tag_name,
                "thresholds": _threshold_out(d),
            }
            for d in devices
        ],
        "series": series,
        "alerts": alerts,
        "hours": hours,
        "bucket_minutes": bucket,
    }
