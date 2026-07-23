"""Inbound Cortex integration — flow 1: a cobot reads an OF label, Cortex
processes it and PUSHES the result to /api/v1/cortex/events (see
app/api/routes/cortex_ingest.py for transport/auth). This service owns the
business side of one received event:

  validate → resolve site+machine → idempotency check → scan the OF onto the
  machine (scan_job_order_at_machine: closes the previous run, opens a new one,
  history preserved) → enrich the JobOrder with the ERP details Cortex knows →
  write the CortexEvent audit row.

Every call is audited in `cortex_events` — success, duplicate and every
rejection — with the ORIGINAL payload, so nothing is lost even when a lookup
fails. Idempotency is by eventId: a redelivery after a success is acknowledged
as success (duplicate) and NOT reprocessed; a retry after a failure processes
normally. Unknown payload fields are accepted and kept in the audit payload
(forward compatibility); malformed OPTIONAL fields are ignored, malformed
REQUIRED fields reject the event with a stable errorCode.

Nothing here commits — the route commits, so the audit row and the scan land
atomically. Unexpected exceptions (e.g. a DB hiccup) propagate: the route rolls
back, audits best-effort in a fresh session and answers INTERNAL_ERROR, and the
Cortex retry with the same eventId is safe.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import CortexEvent, JobOrder, JobOrderSource, Machine, Plant
from app.services.job_order_service import get_open_run, scan_job_order_at_machine

log = logging.getLogger("cortex_ingest")

EVENT_TYPE_OF_SCANNED = "manufacturing_order_scanned"
SUPPORTED_EVENT_TYPES = {EVENT_TYPE_OF_SCANNED}

# The REAL Cobot/Tablette contract (what their system already sends — C# model:
# Name, Quantity, SkuNumber, UnitCompletionTime, Machines). Detected by the
# presence of a `machines` list; keys accepted in camelCase or PascalCase.
COBOT_EVENT_TYPE = "cobot_push"

# errorCode → HTTP status. Stable contract with the integrator team: 4xx = fix
# the call/data (retrying unchanged will fail again), 409 = machine disabled or
# ambiguous name in KAIZO, 5xx = our fault, retrying the same call is safe.
ERROR_HTTP_STATUS = {
    "INGEST_DISABLED": 503,
    "UNAUTHORIZED": 401,
    "INVALID_JSON": 400,
    "INVALID_PAYLOAD": 400,
    "UNSUPPORTED_EVENT_TYPE": 422,
    "SITE_NOT_FOUND": 404,
    "MACHINE_NOT_FOUND": 404,
    "MACHINE_NOT_IN_SITE": 404,
    "MACHINE_INACTIVE": 409,
    "MACHINE_AMBIGUOUS": 409,
    "INTERNAL_ERROR": 500,
}

SUCCESS_MESSAGE = "Manufacturing order received and associated successfully."
ALREADY_ACTIVE_MESSAGE = ("Manufacturing order received; it was already active "
                          "on this machine.")
DUPLICATE_MESSAGE = ("Event already processed; duplicate delivery acknowledged "
                     "and ignored.")


@dataclass
class IngestOutcome:
    """Everything the route needs to answer the caller and update the live UI."""
    success: bool
    event_id: Optional[str] = None
    order_number: Optional[str] = None
    machine_code: Optional[str] = None
    machine: Optional[Machine] = None
    job_order: Optional[JobOrder] = None
    duplicate: bool = False
    error_code: Optional[str] = None
    message: str = ""
    # Cobot/Tablette push (Machines is a list): per-machine detail for the
    # response + every successfully associated Machine (the route publishes a
    # live-update hint for each).
    machines_results: Optional[list] = None
    machines_ok: Optional[list] = None

    @property
    def http_status(self) -> int:
        if self.success:
            return 200
        return ERROR_HTTP_STATUS.get(self.error_code or "", 400)

    def response_body(self) -> dict:
        """The stable response envelope (camelCase, mirroring the request)."""
        if self.success:
            body = {
                "success": True,
                "eventId": self.event_id,
                "orderNumber": self.order_number,
                "machineCode": self.machine_code,
                "message": self.message or SUCCESS_MESSAGE,
            }
        else:
            body = {
                "success": False,
                "eventId": self.event_id,
                "errorCode": self.error_code,
                "message": self.message,
            }
        if self.machines_results is not None:
            body["machines"] = self.machines_results
        return body


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean_str(value: Any, max_len: int = 200) -> Optional[str]:
    """Trimmed string or None — tolerates numbers and other scalars."""
    if value is None or isinstance(value, (dict, list)):
        return None
    s = str(value).strip()
    return s[:max_len] if s else None


def _parse_dt(value: Any) -> Optional[datetime]:
    """ISO-8601 → aware UTC datetime. Raises ValueError on garbage."""
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError("not a string")
    dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _parse_dt_lenient(value: Any, field: str, event_id: Optional[str]) -> Optional[datetime]:
    """Optional enrichment dates: malformed values are ignored (kept only in
    the audited payload), never a reason to reject the whole event."""
    try:
        return _parse_dt(value)
    except ValueError:
        log.warning("cortex event %s: ignoring malformed %s=%r", event_id, field, value)
        return None


def _parse_int_lenient(value: Any, field: str, event_id: Optional[str]) -> Optional[int]:
    """Optional quantities: accepts ints/numeric strings ≥ 0, ignores the rest."""
    if value is None:
        return None
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        log.warning("cortex event %s: ignoring malformed %s=%r", event_id, field, value)
        return None
    return n if n >= 0 else None


def _get_ci(d: dict, key: str) -> Any:
    """Case-insensitive dict lookup — their C# serializer may emit camelCase or
    PascalCase depending on configuration, accept both."""
    if key in d:
        return d[key]
    lk = key.lower()
    for k, v in d.items():
        if isinstance(k, str) and k.lower() == lk:
            return v
    return None


async def _resolve_machine(db: AsyncSession, ref: str):
    """Machine lookup for the Cobot/Tablette push: unique code → kiosk slug →
    machine NAME (they send « le nom de la machine dans le MES »). A name shared
    by several machines is refused explicitly rather than guessed.
    Returns (machine|None, error_code|None, message|None)."""
    m = (await db.execute(select(Machine).where(Machine.code == ref))).scalar_one_or_none()
    if m is None:
        m = (await db.execute(select(Machine).where(Machine.page_slug == ref))).scalar_one_or_none()
    if m is None:
        matches = (await db.execute(select(Machine).where(Machine.name == ref))).scalars().all()
        if len(matches) > 1:
            return None, "MACHINE_AMBIGUOUS", (
                f"Machine name '{ref}' matches {len(matches)} machines in the MES — "
                "use the unique machine code instead.")
        m = matches[0] if matches else None
    if m is None:
        return None, "MACHINE_NOT_FOUND", f"The machine informed was not found in the MES: '{ref}'."
    if m.is_active is False:
        return m, "MACHINE_INACTIVE", f"Machine '{ref}' is inactive in the MES."
    return m, None, None


async def process_cobot_push(db: AsyncSession, payload: dict) -> IngestOutcome:
    """The REAL Cobot/Tablette → MES push (their existing contract, C# model:
    Name = production/OF number · Quantity = total to produce · SkuNumber (same
    number as the OF today) · UnitCompletionTime (raw, unit TBC) · Machines =
    list of machine identifiers in the MES.

    No eventId/timestamp on their side (fire-and-forget, no retry): idempotency
    rests on the natural no-op of re-pushing an OF to a machine already running
    it. `Machines` may name SEVERAL machines — the OF opens/keeps a run on each
    one pushed, and its runs on machines OUTSIDE the pushed set close (the OF
    moved). One audit row per machine. Flushes, never commits."""
    order_number = _clean_str(_get_ci(payload, "name"), 100)
    sku = _clean_str(_get_ci(payload, "skuNumber"), 100)
    quantity = _parse_int_lenient(_get_ci(payload, "quantity"), "quantity", order_number)
    unit_time = _parse_int_lenient(_get_ci(payload, "unitCompletionTime"),
                                   "unitCompletionTime", order_number)
    machines_raw = _get_ci(payload, "machines")

    async def _fail(code: str, message: str) -> IngestOutcome:
        db.add(CortexEvent(
            event_type=COBOT_EVENT_TYPE, order_number=order_number,
            reading_type="cobot", result="error", error_code=code,
            error_message=message[:500], payload=payload, processed_at=_now(),
        ))
        await db.flush()
        log.warning("cobot push rejected: of=%s → %s (%s)", order_number, code, message)
        return IngestOutcome(False, None, order_number, error_code=code, message=message)

    if not order_number:
        return await _fail("INVALID_PAYLOAD", "Name (the production/OF number) is required.")
    refs: list[str] = []
    if isinstance(machines_raw, list):
        refs = [s for s in ((_clean_str(x, 100) or "") for x in machines_raw) if s]
    if not refs:
        return await _fail("INVALID_PAYLOAD",
                           "Machines must be a non-empty list of machine identifiers.")

    resolved = [(ref, *(await _resolve_machine(db, ref))) for ref in refs]
    keep_ids = frozenset(m.id for _, m, code, _ in resolved if code is None)

    results: list[dict] = []
    machines_ok: list[Machine] = []
    job_order: Optional[JobOrder] = None
    first_error: Optional[tuple] = None
    for ref, m, code, msg in resolved:
        if code is not None:
            first_error = first_error or (code, msg)
            db.add(CortexEvent(
                event_type=COBOT_EVENT_TYPE, machine_code=ref, order_number=order_number,
                machine_id=m.id if m else None, plant_id=m.plant_id if m else None,
                reading_type="cobot", result="error", error_code=code,
                error_message=(msg or "")[:500], payload=payload, processed_at=_now(),
            ))
            results.append({"machine": ref, "success": False, "errorCode": code})
            log.warning("cobot push: of=%s machine '%s' → %s", order_number, ref, code)
            continue
        jo, _run = await scan_job_order_at_machine(
            db, m, order_number, source=JobOrderSource.cortex,
            target_quantity=quantity, keep_open_machine_ids=keep_ids,
        )
        if sku:
            jo.product_code = sku
        if quantity is not None:
            jo.target_quantity = quantity
        if unit_time is not None:
            jo.unit_completion_time = unit_time
        job_order = jo
        machines_ok.append(m)
        db.add(CortexEvent(
            event_type=COBOT_EVENT_TYPE, machine_code=ref, order_number=order_number,
            machine_id=m.id, plant_id=m.plant_id, job_order_id=jo.id,
            reading_type="cobot", result="success", payload=payload, processed_at=_now(),
        ))
        results.append({"machine": ref, "success": True})

    await db.flush()
    if not machines_ok:
        code, msg = first_error
        return IngestOutcome(False, None, order_number,
                             machine_code=refs[0] if len(refs) == 1 else None,
                             error_code=code, message=msg or "", machines_results=results)
    log.info("cobot push ok: of=%s on %d/%d machine(s)", order_number, len(machines_ok), len(refs))
    return IngestOutcome(
        True, None, order_number,
        machine_code=refs[0] if len(refs) == 1 else None,
        machine=machines_ok[0], job_order=job_order,
        machines_results=results, machines_ok=machines_ok,
        message=SUCCESS_MESSAGE if len(machines_ok) == len(refs) else
        f"Manufacturing order associated to {len(machines_ok)} of {len(refs)} machine(s).",
    )


async def process_event(db: AsyncSession, payload: Any) -> IngestOutcome:
    """Process one parsed inbound body. Flushes (audit rows included) but never
    commits; the caller commits. Two accepted shapes, auto-detected:

    1. The REAL Cobot/Tablette push (has a `machines` list) → process_cobot_push.
    2. The richer envelope we proposed (eventId + machineCode + manufacturingOrder)
       — kept for the simulator, tests and future event types."""
    if isinstance(payload, dict) and _get_ci(payload, "machines") is not None:
        return await process_cobot_push(db, payload)
    raw_payload = payload if isinstance(payload, (dict, list)) else {"raw": str(payload)[:2000]}
    body = payload if isinstance(payload, dict) else {}

    event_id = _clean_str(body.get("eventId"))
    event_type = _clean_str(body.get("eventType"), 100)
    site_code = _clean_str(body.get("siteCode"), 50)
    machine_code = _clean_str(body.get("machineCode"), 100)
    cobot_code = _clean_str(body.get("cobotCode"), 100)
    mo = body.get("manufacturingOrder")
    mo = mo if isinstance(mo, dict) else None
    order_number = _clean_str(mo.get("orderNumber"), 100) if mo else None

    audited = False

    def _audit(result: str, *, error_code: Optional[str] = None,
               error_message: Optional[str] = None, plant: Optional[Plant] = None,
               machine: Optional[Machine] = None, job_order: Optional[JobOrder] = None,
               event_timestamp: Optional[datetime] = None) -> None:
        nonlocal audited
        audited = True
        db.add(CortexEvent(
            event_id=event_id,
            event_type=event_type or EVENT_TYPE_OF_SCANNED,
            site_code=site_code,
            machine_code=machine_code,
            cobot_code=cobot_code,
            order_number=order_number,
            plant_id=plant.id if plant else (machine.plant_id if machine else None),
            machine_id=machine.id if machine else None,
            job_order_id=job_order.id if job_order else None,
            reading_type="cobot",
            result=result,
            error_code=error_code,
            error_message=(error_message or "")[:500] or None,
            payload=raw_payload,
            event_timestamp=event_timestamp,
            processed_at=_now(),
        ))

    async def _fail(code: str, message: str, *, plant: Optional[Plant] = None,
                    machine: Optional[Machine] = None,
                    event_timestamp: Optional[datetime] = None) -> IngestOutcome:
        _audit("error", error_code=code, error_message=message, plant=plant,
               machine=machine, event_timestamp=event_timestamp)
        await db.flush()
        log.warning("cortex event rejected: eventId=%s machineCode=%s of=%s → %s (%s)",
                    event_id, machine_code, order_number, code, message)
        return IngestOutcome(False, event_id, order_number, machine_code,
                             error_code=code, message=message)

    # ── Structural validation (required fields → stable error codes) ──────────
    if not isinstance(payload, dict):
        return await _fail("INVALID_PAYLOAD", "Request body must be a JSON object.")
    if not event_id:
        return await _fail("INVALID_PAYLOAD", "eventId is required (idempotency key).")
    if event_type and event_type not in SUPPORTED_EVENT_TYPES:
        return await _fail("UNSUPPORTED_EVENT_TYPE",
                           f"Unsupported eventType '{event_type}'. Supported: "
                           f"{', '.join(sorted(SUPPORTED_EVENT_TYPES))}.")
    try:
        event_ts = _parse_dt(body.get("timestamp"))
    except ValueError:
        return await _fail("INVALID_PAYLOAD", "timestamp must be an ISO-8601 date-time.")
    if not machine_code:
        return await _fail("INVALID_PAYLOAD", "machineCode is required.",
                           event_timestamp=event_ts)
    if mo is None:
        return await _fail("INVALID_PAYLOAD", "manufacturingOrder object is required.",
                           event_timestamp=event_ts)
    if not order_number:
        return await _fail("INVALID_PAYLOAD", "manufacturingOrder.orderNumber is required.",
                           event_timestamp=event_ts)

    # ── Idempotency: a delivery of an ALREADY SUCCESSFUL eventId is only logged ─
    prior = (await db.execute(
        select(CortexEvent.id).where(
            CortexEvent.event_id == event_id,
            CortexEvent.result == "success",
        ).limit(1)
    )).first()
    if prior is not None:
        _audit("duplicate", event_timestamp=event_ts)
        await db.flush()
        log.info("cortex event duplicate: eventId=%s (already processed)", event_id)
        return IngestOutcome(True, event_id, order_number, machine_code,
                             duplicate=True, message=DUPLICATE_MESSAGE)

    # ── Resolve site + machine ────────────────────────────────────────────────
    plant: Optional[Plant] = None
    if site_code:
        plant = (await db.execute(
            select(Plant).where(func.lower(Plant.code) == site_code.lower())
        )).scalar_one_or_none()
        if plant is None:
            return await _fail("SITE_NOT_FOUND",
                               f"The site informed by Cortex was not found: '{site_code}'.",
                               event_timestamp=event_ts)

    machine = (await db.execute(
        select(Machine).where(Machine.code == machine_code)
    )).scalar_one_or_none()
    if machine is None:
        machine = (await db.execute(
            select(Machine).where(Machine.page_slug == machine_code)
        )).scalar_one_or_none()
    if machine is None:
        return await _fail("MACHINE_NOT_FOUND",
                           f"The machine informed by Cortex was not found: '{machine_code}'.",
                           plant=plant, event_timestamp=event_ts)
    if plant is not None and machine.plant_id != plant.id:
        return await _fail("MACHINE_NOT_IN_SITE",
                           f"Machine '{machine_code}' does not belong to site '{site_code}'.",
                           plant=plant, event_timestamp=event_ts)
    if machine.is_active is False:
        return await _fail("MACHINE_INACTIVE",
                           f"Machine '{machine_code}' is inactive in the MES.",
                           plant=plant, machine=machine, event_timestamp=event_ts)

    # ── Enrichment fields (all optional, malformed values ignored) ────────────
    product_code = _clean_str(mo.get("productCode"), 100)
    product_desc = _clean_str(mo.get("productDescription"), 300)
    uom = _clean_str(mo.get("unitOfMeasure"), 20)
    op_code = _clean_str(mo.get("operationCode"), 50)
    op_desc = _clean_str(mo.get("operationDescription"), 300)
    planned_qty = _parse_int_lenient(mo.get("plannedQuantity"), "plannedQuantity", event_id)
    completed_qty = _parse_int_lenient(mo.get("completedQuantity"), "completedQuantity", event_id)
    planned_start = _parse_dt_lenient(mo.get("plannedStartDate"), "plannedStartDate", event_id)
    planned_end = _parse_dt_lenient(mo.get("plannedEndDate"), "plannedEndDate", event_id)

    # ── Associate the OF with the machine (canonical scan funnel: closes the
    # previous run, opens a new one — the full history stays in job_order_runs).
    previous_run = await get_open_run(db, machine.id)
    job_order, run = await scan_job_order_at_machine(
        db, machine, order_number,
        source=JobOrderSource.cortex,
        when=event_ts,
        product_name=product_desc or product_code,
        target_quantity=planned_qty,
    )

    # Cortex/ERP data is richer than a bare scan: update what the payload brings,
    # never blank a field the payload omitted.
    if product_desc:
        job_order.product_name = product_desc
    if product_code:
        job_order.product_code = product_code
    if uom:
        job_order.unit_of_measure = uom
    if op_code:
        job_order.operation_code = op_code
    if op_desc:
        job_order.operation_description = op_desc
    if planned_qty is not None:
        job_order.target_quantity = planned_qty
    if completed_qty is not None:
        job_order.completed_quantity = completed_qty
    if planned_start is not None:
        job_order.planned_start_at = planned_start
    if planned_end is not None:
        job_order.planned_end_at = planned_end

    already_active = previous_run is not None and run is not None and previous_run.id == run.id
    _audit("success", plant=plant, machine=machine, job_order=job_order,
           event_timestamp=event_ts)
    await db.flush()
    log.info("cortex event ok: eventId=%s of=%s machine=%s (%s)%s",
             event_id, order_number, machine_code, machine.id,
             " [already active]" if already_active else "")
    return IngestOutcome(
        True, event_id, order_number, machine_code,
        machine=machine, job_order=job_order,
        message=ALREADY_ACTIVE_MESSAGE if already_active else SUCCESS_MESSAGE,
    )
