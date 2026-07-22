"""Demo/validation simulator for the predictive intelligence layer.

Builds a self-contained demo equipment ("SIM-PRED-01") with vibration +
temperature sensors and writes a month of history that exercises every MVP
mechanism through the REAL pipeline (baseline builder, failure sync,
fingerprints, engine scoring, alerting):

  · 30 days of normal operation (vib ~2.2 mm/s, temp ~35 °C, hourly readings)
  · 3 historical failures (failure_events) — the two most recent preceded by a
    24 h vibration ramp → pre-failure fingerprints get captured
  · the LAST 8 hours ramp again (vib → ~5.8 mm/s, temp +10 °C) → baseline
    anomaly + trend + pattern-similarity factors all fire on evaluation
  · one extra frozen-value sensor → data-quality finding (sensor fault ≠
    machine fault)

Everything is TAGGED for clean removal:
  - equipment code 'SIM-PRED-01', sensors code prefix 'SIM-PRED-'

Run inside the backend container:
    docker exec mes_backend python -m scripts.simulate_predictive --plant QS
    docker exec mes_backend python -m scripts.simulate_predictive --plant QS --reset
    docker exec mes_backend python -m scripts.simulate_predictive --plant QS --evaluate
        # also run sync + baselines + one engine evaluation at the end
"""
import argparse
import asyncio
import random
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select

from app.db.session import AsyncSessionLocal
from app.models.models import (
    Equipment,
    FailureEvent,
    FailurePattern,
    FailureSource,
    MachineBaseline,
    Plant,
    PredictiveAlert,
    PredictiveHealthSnapshot,
    PredictiveMode,
    Sensor,
    SensorReading,
)
from app.services.predictive.baseline import build_baselines_for_equipment
from app.services.predictive.config import effective_config, get_plant_settings
from app.services.predictive.engine import evaluate_equipment, process_alerts
from app.services.predictive.failure_sync import capture_fingerprints

EQ_CODE = "SIM-PRED-01"
SENSOR_PREFIX = "SIM-PRED-"
DAYS = 30


async def _reset(s) -> None:
    eq = (await s.execute(select(Equipment).where(Equipment.code == EQ_CODE))).scalar_one_or_none()
    sensors = (await s.execute(select(Sensor).where(Sensor.code.like(f"{SENSOR_PREFIX}%")))).scalars().all()
    for sensor in sensors:
        await s.execute(delete(SensorReading).where(SensorReading.sensor_id == sensor.id))
        await s.execute(delete(Sensor).where(Sensor.id == sensor.id))
    if eq is not None:
        await s.execute(delete(FailurePattern).where(FailurePattern.equipment_id == eq.id))
        await s.execute(delete(FailureEvent).where(FailureEvent.equipment_id == eq.id))
        await s.execute(delete(MachineBaseline).where(MachineBaseline.equipment_id == eq.id))
        await s.execute(delete(PredictiveHealthSnapshot).where(PredictiveHealthSnapshot.equipment_id == eq.id))
        await s.execute(delete(PredictiveAlert).where(PredictiveAlert.equipment_id == eq.id))
        await s.execute(delete(Equipment).where(Equipment.id == eq.id))
    await s.commit()
    print("SIM-PRED data wiped.")


def _vib(now: datetime, t: datetime, ramps: list[datetime]) -> float:
    base = 2.2 + random.uniform(-0.25, 0.25)
    for ramp_end in ramps:
        h_to = (ramp_end - t).total_seconds() / 3600.0
        if 0 <= h_to <= 24:                       # 24 h pre-failure ramp
            base += (24 - h_to) / 24 * 3.2
    h_from_now = (now - t).total_seconds() / 3600.0
    if h_from_now <= 8:                           # the live degradation
        base += (8 - h_from_now) / 8 * 3.4
    return round(max(0.3, base), 3)


def _temp(now: datetime, t: datetime, ramps: list[datetime]) -> float:
    daily = 2.0 * __import__("math").sin(t.hour / 24 * 6.28)
    base = 35.0 + daily + random.uniform(-0.6, 0.6)
    for ramp_end in ramps:                        # bearings run hot before failing
        h_to = (ramp_end - t).total_seconds() / 3600.0
        if 0 <= h_to <= 24:
            base += (24 - h_to) / 24 * 14.0
    h_from_now = (now - t).total_seconds() / 3600.0
    if h_from_now <= 8:
        base += (8 - h_from_now) / 8 * 10.0
    return round(base, 2)


async def _seed(plant_code: str, evaluate: bool) -> None:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    async with AsyncSessionLocal() as s:
        plant = (await s.execute(select(Plant).where(Plant.code == plant_code))).scalar_one_or_none()
        if plant is None:
            raise SystemExit(f"plant {plant_code} not found")
        await _reset(s)

        eq = Equipment(
            plant_id=plant.id, code=EQ_CODE, name="SIM Predictive Press 01",
            criticality="high", asset_type="auxiliary", subtype="Simulator",
            location="Demo", status="running",
        )
        s.add(eq)
        await s.flush()

        def mk_sensor(suffix, stype, unit):
            return Sensor(equipment_id=eq.id, plant_id=plant.id,
                          code=f"{SENSOR_PREFIX}{suffix}", name=f"SIM {suffix}",
                          type=stype, unit=unit, active=True)

        vib = mk_sensor("VEL", "vibration", "mm/s")
        tmp = mk_sensor("TEMP", "temperature", "°C")
        frz = mk_sensor("TEMP-FROZEN", "temperature", "°C")
        s.add_all([vib, tmp, frz])
        await s.flush()

        fail_times = [now - timedelta(days=20), now - timedelta(days=12), now - timedelta(days=5)]
        ramps = fail_times[1:]      # the two most recent failures had a signature

        readings = []
        t = now - timedelta(days=DAYS)
        while t <= now:
            readings.append(SensorReading(sensor_id=vib.id, equipment_id=eq.id,
                                          timestamp=t, value=_vib(now, t, ramps), quality="ok"))
            readings.append(SensorReading(sensor_id=tmp.id, equipment_id=eq.id,
                                          timestamp=t, value=_temp(now, t, ramps), quality="ok"))
            readings.append(SensorReading(sensor_id=frz.id, equipment_id=eq.id, timestamp=t,
                                          value=41.7 if (now - t) <= timedelta(hours=12)
                                          else round(38 + random.uniform(-1, 1), 2),
                                          quality="ok"))
            t += timedelta(hours=1)
        s.add_all(readings)

        for i, ft in enumerate(fail_times):
            s.add(FailureEvent(
                equipment_id=eq.id, plant_id=plant.id,
                source=FailureSource.manual, source_id=uuid.uuid4(),
                started_at=ft, ended_at=ft + timedelta(hours=3),
                failure_type="bearing_failure", component="Roulement moteur",
                severity="high", confirmed=True,
                notes=f"SIM historical failure #{i + 1}",
            ))
        await s.commit()
        print(f"Seeded {len(readings)} readings, 3 failures on {EQ_CODE}.")

        settings = await get_plant_settings(s, plant.id, create=True)
        if settings.mode == PredictiveMode.off:
            settings.mode = PredictiveMode.silent
            print("Plant predictive mode: off → silent (record-only).")
        await s.commit()

        if evaluate:
            cfg = effective_config(settings)
            n = await capture_fingerprints(s, cfg, plant_id=plant.id)
            await s.commit()
            print(f"Fingerprints captured: {n}")
            await build_baselines_for_equipment(s, eq, cfg)
            await s.commit()
            print("Baselines built.")
            snap = await evaluate_equipment(s, eq, cfg)
            await process_alerts(s, eq, None, cfg, snap)
            await s.commit()
            print(f"Evaluation: score={snap['score']} level={snap['level']} "
                  f"confidence={snap['confidence']} maturity={snap['maturity']}")
            for f in snap["factors"]:
                print(f"  - {f['code']}: value={f['value']} contribution={f['contribution']}")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", default="QS")
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--evaluate", action="store_true")
    args = ap.parse_args()
    if args.reset:
        async with AsyncSessionLocal() as s:
            await _reset(s)
        return
    await _seed(args.plant, args.evaluate)


if __name__ == "__main__":
    asyncio.run(main())
