"""In-process pub/sub for live UI updates.

Successful mutations publish small "something changed" hints; the /api/live/ws
WebSocket forwards them to connected browsers, which refetch through the regular
REST endpoints. Events carry identifiers only — never records — so no response
serialization is duplicated here.

Topics:
  machines — a machine (or its tickets/stops/production) changed.
             `ref` is the raw path ref (machine id, code or page_slug) when the
             mutation was machine-scoped, or None for a broadcast (e.g. a ticket
             closed from the office — the machine isn't in the URL).
  badges   — alert/ticket/work-order counters may have moved (sidebar badges).

Single-process only (matches the in-lifespan cron pattern); if the backend ever
scales to multiple workers this needs a Redis pub/sub backend instead.
"""
import asyncio
from typing import Any, Optional

_subscribers: set[asyncio.Queue] = set()

# A browser that stops reading gets its queue capped; dropped events are fine —
# every consumer keeps a slow polling fallback that catches it up.
_MAX_QUEUE = 100


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=_MAX_QUEUE)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subscribers.discard(q)


def publish(topic: str, **data: Any) -> None:
    event = {"topic": topic, **data}
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass


def publish_machine(ref: Optional[str] = None) -> None:
    publish("machines", ref=ref)


def publish_badges() -> None:
    publish("badges")
