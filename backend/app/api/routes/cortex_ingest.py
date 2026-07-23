"""Cobot/Tablette → MES INBOUND API — versioned under /api/v1/cortex (flow 1:
a cobot reads an OF / an operator enters it on their side → their system CALLS
US to start the operation on one or more machines).

POST /events auto-detects TWO payload shapes (see cortex_ingest_service):
  1. the REAL contract their system already sends (C# model — Name, Quantity,
     SkuNumber, UnitCompletionTime, Machines list; camelCase or PascalCase);
  2. the richer envelope we proposed (eventId + machineCode +
     manufacturingOrder) — used by the simulator/tests, open for future types.
Their delivery is fire-and-forget (no retry on their side), so endpoint uptime
and our audit trail are what make losses visible.

Two routers, registered separately in main.py:

  ingest_router   POST /api/v1/cortex/events — the push endpoint Cortex calls.
                  GET  /api/v1/cortex/ping   — connectivity/credential check for
                  the Cortex team (no side effects).
                  No JWT: authenticated by the deployment-wide CORTEX_INGEST_TOKEN
                  (comma-separated values all accepted → zero-downtime rotation;
                  each environment sets its own token in .env). Cortex sends it as
                  `Authorization: Bearer <token>` or `X-Ingest-Token: <token>`.
                  While unset the endpoint answers 503 (ingest disabled).
                  TRANSPORT: the deployment terminates TLS at the edge
                  (nginx/cloudflared) — the public URL handed to the Cortex team
                  must be https://; plain HTTP exists only inside the compose
                  network.

  admin_router    GET /api/v1/cortex/events — recent audit rows for support/
                  debugging, JWT + `settings_devices` resource (registered in
                  main.py). Unresolved events (plant NULL — e.g. a bad
                  machineCode) are visible from any plant: those are precisely
                  the ones support needs to see.

Responses use a STABLE envelope (mirrors the request casing):
  200 {"success": true,  "eventId", "orderNumber", "machineCode", "message"}
  4xx/5xx {"success": false, "eventId", "errorCode", "message"}
with errorCode ∈ ERROR_HTTP_STATUS (cortex_ingest_service). Idempotency is by
eventId: a redelivery after success answers 200 success (duplicate acknowledged,
not reprocessed) so Cortex retries-on-missing-ack converge; a retry after a
failure processes normally. Every call — success or rejection — lands one audit
row in cortex_events with the original payload.

Simulating a call (dev): scripts/simulate_cortex_push.py, e.g.
  docker exec mes_backend python -m scripts.simulate_cortex_push \
      --token dev-token --machine MACHINE-001 --of OF-123456

Flow 2 (kiosk manual scan → we call Cortex → async reply) is NOT implemented
yet by design; its async replies can arrive on this same endpoint as new
eventTypes correlated by eventId/orderNumber, and cortex_events.reading_type
already distinguishes 'cobot' (this flow) from 'manual' (future).
"""
import json
import logging
import secrets
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.plant_context import PlantContext, get_plant_context
from app.db.session import AsyncSessionLocal, get_db
from app.models.models import CortexEvent
from app.services import event_bus
from app.services.cortex_ingest_service import (
    DUPLICATE_MESSAGE, IngestOutcome, process_event,
)

log = logging.getLogger("cortex_ingest")

ingest_router = APIRouter()
admin_router = APIRouter()


def _error_response(status: int, event_id: Optional[str], code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={
        "success": False, "eventId": event_id, "errorCode": code, "message": message,
    })


def _auth_error(request: Request) -> Optional[JSONResponse]:
    """None when the caller presented a valid Cortex token; the error response
    otherwise. Constant-time comparison; multiple active tokens = rotation."""
    tokens = settings.cortex_ingest_tokens
    if not tokens:
        return _error_response(503, None, "INGEST_DISABLED",
                               "Cortex ingest is not configured on this environment "
                               "(CORTEX_INGEST_TOKEN is unset).")
    auth = request.headers.get("Authorization", "")
    presented = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not presented:
        presented = request.headers.get("X-Ingest-Token", "") or ""
    if presented and any(secrets.compare_digest(presented, t) for t in tokens):
        return None
    log.warning("cortex call rejected: missing/invalid credentials (%s %s)",
                request.method, request.url.path)
    return _error_response(401, None, "UNAUTHORIZED",
                           "Missing or invalid Cortex API credentials.")


@ingest_router.get("/ping")
async def cortex_ping(request: Request):
    """Authenticated no-op so the Cortex team can validate URL + credentials
    per environment before sending real events."""
    denied = _auth_error(request)
    if denied:
        return denied
    return {"success": True, "message": "Cortex ingest is reachable.",
            "environment": settings.ENVIRONMENT, "apiVersion": "v1"}


@ingest_router.post("/events")
async def receive_cortex_event(request: Request, db: AsyncSession = Depends(get_db)):
    """Receive one Cortex event (manufacturing_order_scanned). See the module
    docstring for the full contract; business rules live in
    cortex_ingest_service.process_event."""
    denied = _auth_error(request)
    if denied:
        return denied

    raw = await request.body()
    try:
        payload = json.loads(raw)
    except ValueError:
        # Unparseable body: audit what we can (truncated raw text, no eventId).
        db.add(CortexEvent(result="error", error_code="INVALID_JSON",
                           error_message="Request body is not valid JSON",
                           payload={"raw_text": raw[:2000].decode("utf-8", errors="replace")},
                           processed_at=datetime.now(timezone.utc)))
        await db.commit()
        log.warning("cortex event rejected: body is not valid JSON (%d bytes)", len(raw))
        return _error_response(400, None, "INVALID_JSON", "Request body is not valid JSON.")

    event_id = payload.get("eventId") if isinstance(payload, dict) else None
    event_id = str(event_id) if event_id is not None else None
    try:
        outcome = await process_event(db, payload)
        await db.commit()
    except IntegrityError:
        # Two deliveries of the same eventId raced past the SELECT; the partial
        # unique index (one 'success' per eventId) let exactly one commit win.
        # This one is by definition a duplicate — acknowledge it as such.
        await db.rollback()
        log.info("cortex event duplicate (commit race): eventId=%s", event_id)
        outcome = IngestOutcome(True, event_id,
                                duplicate=True, message=DUPLICATE_MESSAGE)
        try:
            db.add(CortexEvent(event_id=event_id, result="duplicate",
                               payload=payload if isinstance(payload, (dict, list)) else None,
                               processed_at=datetime.now(timezone.utc)))
            await db.commit()
        except Exception:   # noqa: BLE001 — the ack matters more than this audit row
            await db.rollback()
            log.exception("cortex duplicate audit write failed for eventId=%s", event_id)
    except Exception:   # noqa: BLE001 — DB down, unexpected bug…
        await db.rollback()
        log.exception("cortex event processing failed: eventId=%s", event_id)
        # Best-effort audit on a FRESH session (the request session may be broken).
        try:
            async with AsyncSessionLocal() as audit_db:
                audit_db.add(CortexEvent(
                    event_id=event_id, result="error", error_code="INTERNAL_ERROR",
                    error_message="Unexpected error while processing the event",
                    payload=payload if isinstance(payload, (dict, list)) else None,
                    processed_at=datetime.now(timezone.utc)))
                await audit_db.commit()
        except Exception:   # noqa: BLE001
            log.exception("cortex INTERNAL_ERROR audit write failed for eventId=%s", event_id)
        return _error_response(500, event_id, "INTERNAL_ERROR",
                               "Unexpected error while processing the event; "
                               "retry with the same eventId is safe.")

    # Live UI: the kiosk/dashboards listen on /api/live/ws and refetch on this
    # hint (the /api/v1 path is outside the middleware's machine-path regex, so
    # publish explicitly). A Cobot/Tablette push may target several machines —
    # hint each one. Nothing changed on a duplicate — no hint needed.
    if outcome.success and not outcome.duplicate:
        targets = outcome.machines_ok or ([outcome.machine] if outcome.machine else [])
        for m in targets:
            event_bus.publish_machine(m.page_slug or str(m.id))

    return JSONResponse(status_code=outcome.http_status, content=outcome.response_body())


@admin_router.get("/events")
async def list_cortex_events(
    machine_id: Optional[str] = None,
    event_id: Optional[str] = None,
    result: Optional[str] = Query(None, pattern="^(success|duplicate|error)$"),
    include_payload: bool = False,
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Audit trail of inbound Cortex calls (newest first) for support/debugging.
    Scoped to the active plant, PLUS unresolved events (plant NULL — bad
    machineCode/siteCode), which are exactly what needs debugging."""
    stmt = (
        select(CortexEvent)
        .where(or_(CortexEvent.plant_id == ctx.plant_id, CortexEvent.plant_id.is_(None)))
        .order_by(CortexEvent.received_at.desc())
        .limit(limit)
    )
    if machine_id:
        stmt = stmt.where(CortexEvent.machine_id == machine_id)
    if event_id:
        stmt = stmt.where(CortexEvent.event_id == event_id)
    if result:
        stmt = stmt.where(CortexEvent.result == result)
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {
            "id": str(r.id),
            "eventId": r.event_id,
            "eventType": r.event_type,
            "siteCode": r.site_code,
            "machineCode": r.machine_code,
            "cobotCode": r.cobot_code,
            "orderNumber": r.order_number,
            "plantId": str(r.plant_id) if r.plant_id else None,
            "machineId": str(r.machine_id) if r.machine_id else None,
            "jobOrderId": str(r.job_order_id) if r.job_order_id else None,
            "readingType": r.reading_type,
            "result": r.result,
            "errorCode": r.error_code,
            "errorMessage": r.error_message,
            "eventTimestamp": r.event_timestamp.isoformat() if r.event_timestamp else None,
            "receivedAt": r.received_at.isoformat() if r.received_at else None,
            "processedAt": r.processed_at.isoformat() if r.processed_at else None,
            **({"payload": r.payload} if include_payload else {}),
        }
        for r in rows
    ]
