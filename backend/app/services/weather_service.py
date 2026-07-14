"""Outdoor weather for the factory-map overview badge.

Reads the current temperature + WMO weather code from Open-Meteo (free, no API
key) for a plant's latitude/longitude. The value is cached on the Plant row by
`_weather_loop` (app.main); this module is only the fetch. In the UI the source is
labelled "MétéoMédia" (The Weather Network) even though the data comes from
Open-Meteo — the plan's chosen provider.
"""
import httpx

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


async def fetch_open_meteo(latitude: float, longitude: float) -> dict:
    """Current weather for the given coordinates → {"temp_c": float|None,
    "code": int|None}. Raises httpx errors on network/HTTP failure; the caller
    (the loop) logs and skips so one plant never blocks the rest."""
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "current": "temperature_2m,weather_code",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(OPEN_METEO_URL, params=params)
        resp.raise_for_status()
        data = resp.json()
    cur = data.get("current") or {}
    return {"temp_c": cur.get("temperature_2m"), "code": cur.get("weather_code")}
