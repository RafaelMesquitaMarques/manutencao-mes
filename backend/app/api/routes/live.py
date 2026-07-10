"""Generic live-update WebSocket.

Forwards event-bus hints (see app/services/event_bus.py) to the browser so the
kiosk, dashboards and sidebar badges refetch on change instead of polling.
Same query-token auth as the factory-map WS. A ping is sent when the bus is
quiet so both sides notice dead peers.

Multi-plant: machine-scoped events are forwarded only when the machine belongs
to a plant the token's user can access — a Las Vegas browser never even learns
that a Quebec machine changed. Broadcast hints (ref None) and badge ticks carry
no record data (the refetch they trigger is plant-scoped by the REST API), so
they pass through.
"""
import asyncio
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import jwt, JWTError
from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models.models import Machine, User, UserPlant, UserRole
from app.services import event_bus

router = APIRouter()

_PING_SECONDS = 20


async def _allowed_plants(token: str) -> Optional[frozenset]:
    """Token → the user's allowed plant ids (None = reject the connection).
    Corporate admin gets an open filter (empty frozenset sentinel = all)."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            return None
    except JWTError:
        return None
    async with AsyncSessionLocal() as db:
        user = await db.get(User, UUID(user_id))
        if not user or not user.active:
            return None
        if user.role == UserRole.admin:
            return frozenset()          # sentinel: no filtering
        ids = (await db.execute(
            select(UserPlant.plant_id).where(UserPlant.user_id == user.id)
        )).scalars().all()
        return frozenset(ids)


async def _machine_plant(ref: str, cache: dict):
    """Resolve a machine event ref (id, code or page_slug) to its plant id,
    memoized per connection. Unknown refs resolve to None (treated as foreign)."""
    if ref in cache:
        return cache[ref]
    plant = None
    async with AsyncSessionLocal() as db:
        m = None
        try:
            m = await db.get(Machine, UUID(ref))
        except (ValueError, AttributeError):
            m = None
        if m is None:
            m = (await db.execute(
                select(Machine).where(
                    (Machine.code == ref) | (Machine.page_slug == ref)
                ).limit(1)
            )).scalars().first()
        plant = m.plant_id if m else None
    cache[ref] = plant
    return plant


@router.websocket("/ws")
async def live_ws(websocket: WebSocket, token: str = ""):
    allowed = await _allowed_plants(token)
    if allowed is None:
        await websocket.close(code=1008)
        return
    unfiltered = len(allowed) == 0          # corporate admin sentinel
    await websocket.accept()
    queue = event_bus.subscribe()
    plant_cache: dict = {}
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=_PING_SECONDS)
            except asyncio.TimeoutError:
                event = {"topic": "ping"}
            if not unfiltered and event.get("topic") == "machines" and event.get("ref"):
                plant = await _machine_plant(str(event["ref"]), plant_cache)
                if plant is not None and plant not in allowed:
                    continue            # another plant's machine — drop silently
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        event_bus.unsubscribe(queue)
