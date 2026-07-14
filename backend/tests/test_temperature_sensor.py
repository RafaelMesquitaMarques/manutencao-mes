"""
Temperature sensors + outdoor weather.
========================================
Same isolation contract as the other suites: DB writes run in a session that is
rolled back at the end, so the database is never mutated. The pure-async weather
tests touch no DB and run on their own loop.

Run (inside the backend container):
    pytest tests/test_temperature_sensor.py -v
"""
import asyncio
import os
import sys
import uuid

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                                       # noqa: E402
from app.models.models import (                                           # noqa: E402
    Plant, TemperatureSensor, TemperatureSource, AdamDeviceStatus,
)
from app.api.routes.factory_map import _sensor_dict                        # noqa: E402
from app.api.routes.temperature_sensors import _sensor_out                 # noqa: E402
from app.services import weather_service                                   # noqa: E402
from app.main import _simulated_temp_c                                     # noqa: E402

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
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


# ── Model round-trip + serialization ──────────────────────────────────────────
@with_session
async def test_sensor_persist_and_serialize(s):
    """A sensor persists with its plant + position and both serializers expose the
    fields the UI needs (map payload = position + reading; settings = full config)."""
    plant = Plant(id=uuid.uuid4(), code=f"T{uuid.uuid4().hex[:6]}", name="Temp Test Plant")
    s.add(plant)
    await s.flush()

    sensor = TemperatureSensor(
        id=uuid.uuid4(), plant_id=plant.id, name="Zone A probe",
        pos_x=120.0, pos_y=80.0, sim_baseline_c=22.0, last_value_c=22.4,
        status=AdamDeviceStatus.online,
    )
    s.add(sensor)
    await s.flush()

    m = _sensor_dict(sensor)
    assert m["name"] == "Zone A probe"
    assert m["pos_x"] == 120.0 and m["pos_y"] == 80.0
    assert m["last_value_c"] == 22.4
    assert m["status"] == "online"

    cfg = _sensor_out(sensor)
    assert cfg["source"] == "simulated"          # default source
    assert cfg["sim_baseline_c"] == 22.0
    assert cfg["enabled"] is True


# ── Simulation bounds ─────────────────────────────────────────────────────────
def test_simulated_reading_within_bounds():
    """The simulated value stays within baseline ± (amplitude + jitter margin)."""
    sensor = TemperatureSensor(
        name="sim", sim_baseline_c=20.0, sim_amplitude_c=3.0,
        source=TemperatureSource.simulated,
    )
    for _ in range(200):
        v = _simulated_temp_c(sensor)
        assert 20.0 - 3.0 - 0.5 <= v <= 20.0 + 3.0 + 0.5


# ── Weather service (httpx mocked) ────────────────────────────────────────────
class _FakeResp:
    def __init__(self, payload):
        self._p = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._p


class _FakeClient:
    payload = {"current": {"temperature_2m": 12.3, "weather_code": 3}}

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, params=None):
        return _FakeResp(self.payload)


def test_weather_service_parses_open_meteo(monkeypatch):
    monkeypatch.setattr(weather_service.httpx, "AsyncClient", _FakeClient)
    res = asyncio.run(weather_service.fetch_open_meteo(45.78, -74.0))
    assert res == {"temp_c": 12.3, "code": 3}
