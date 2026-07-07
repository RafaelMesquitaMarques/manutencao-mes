"""Generic live-update WebSocket.

Forwards event-bus hints (see app/services/event_bus.py) to the browser so the
kiosk, dashboards and sidebar badges refetch on change instead of polling.
Same query-token auth as the factory-map WS. A ping is sent when the bus is
quiet so both sides notice dead peers.
"""
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import jwt, JWTError

from app.core.config import settings
from app.services import event_bus

router = APIRouter()

_PING_SECONDS = 20


@router.websocket("/ws")
async def live_ws(websocket: WebSocket, token: str = ""):
    try:
        jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    queue = event_bus.subscribe()
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=_PING_SECONDS)
            except asyncio.TimeoutError:
                event = {"topic": "ping"}
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
