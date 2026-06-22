"""
IoT Worker: consumes MQTT messages from sensors,
stores time-series data in TimescaleDB, and generates automatic alerts.

Expected MQTT topics:
  usinas/{plant_id}/captores/{sensor_code}/leitura
  Payload JSON: {"valor": 12.5, "timestamp": "2024-01-01T10:00:00Z"}

NOTE: The topic pattern is kept unchanged — changing it would break device firmware.
"""
import asyncio
import json
import logging
from datetime import datetime, timezone

import aiomqtt
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models.models import Sensor, SensorReading, Alert

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("iot_worker")


async def process_reading(session: AsyncSession, sensor_code: str, payload: dict):
    """Store sensor reading and check limits to generate alerts."""

    result = await session.execute(
        select(Sensor).where(Sensor.code == sensor_code, Sensor.active == True)
    )
    sensor = result.scalar_one_or_none()
    if not sensor:
        log.warning(f"Sensor not found: {sensor_code}")
        return

    value = float(payload.get("valor", 0))
    ts_str = payload.get("timestamp")
    timestamp = datetime.fromisoformat(ts_str) if ts_str else datetime.now(timezone.utc)

    # Store reading in TimescaleDB hypertable
    reading = SensorReading(
        sensor_id=sensor.id,
        equipment_id=sensor.equipment_id,
        timestamp=timestamp,
        value=value,
    )
    session.add(reading)

    # Check limits and generate alert if needed
    alert = None
    if sensor.max_limit is not None and value > sensor.max_limit:
        alert = Alert(
            sensor_id=sensor.id,
            equipment_id=sensor.equipment_id,
            type="limit_exceeded",
            severity="critical" if value > sensor.max_limit * 1.2 else "warning",
            value_read=value,
            limit_value=sensor.max_limit,
            message=f"{sensor.name}: value {value} {sensor.unit} above limit {sensor.max_limit}",
        )
    elif sensor.min_limit is not None and value < sensor.min_limit:
        alert = Alert(
            sensor_id=sensor.id,
            equipment_id=sensor.equipment_id,
            type="limit_exceeded",
            severity="warning",
            value_read=value,
            limit_value=sensor.min_limit,
            message=f"{sensor.name}: value {value} {sensor.unit} below limit {sensor.min_limit}",
        )

    if alert:
        session.add(alert)
        log.warning(f"ALERT [{alert.severity}] {alert.message}")
        # FUTURE — auto corrective WO from sensor alert (DEFERRED by decision 2026-06-20:
        # vibration/temperature do NOT auto-create WOs yet). Infra ready: Alert has
        # equipment_id/severity/work_order_id. To enable, call a service here that creates
        # a corrective WO (from_iot=True), links alert.work_order_id, and dedups per equipment.

    await session.commit()
    log.debug(f"Reading stored: {sensor_code} = {value} {sensor.unit}")


async def main():
    log.info(f"Connecting to MQTT broker {settings.MQTT_BROKER}:{settings.MQTT_PORT}")

    async with aiomqtt.Client(settings.MQTT_BROKER, settings.MQTT_PORT) as client:
        # Subscribe to all sensor reading topics across all plants
        await client.subscribe("usinas/+/captores/+/leitura")
        log.info("Subscribed: usinas/+/captores/+/leitura")

        async with client.messages() as messages:
            async for message in messages:
                try:
                    topic_parts = str(message.topic).split("/")
                    # usinas/{plant_id}/captores/{sensor_code}/leitura
                    sensor_code = topic_parts[3] if len(topic_parts) >= 4 else None
                    if not sensor_code:
                        continue

                    payload = json.loads(message.payload.decode())

                    async with AsyncSessionLocal() as session:
                        await process_reading(session, sensor_code, payload)

                except Exception as e:
                    log.error(f"Error processing message: {e}")


if __name__ == "__main__":
    asyncio.run(main())
