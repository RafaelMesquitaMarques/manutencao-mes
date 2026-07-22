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

# errorCode → HTTP status. Stable contract with the Cortex team: 4xx = fix the
# call/data (retrying unchanged will fail again), 409 = the machine is disabled
# in KAIZO, 5xx = our fault, retry with the SAME eventId.
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
    "INTERNAL_ERROR": 500,
}

SUCCESS_MESSAGE = "Manufacturing order received and associated successfully."
ALREADY_ACTIVE_MESSAGE = ("Manufacturing order received; it was already active "
                          "on this machine.")
DUPLICATE_MESSAGE = ("Event already processed; duplicate delivery acknowledged "
                     "and ignored.")


@dataclass
class IngestOutcome:
    """Everything the route needs to answer Cortex and update the live UI."""
    success: bool
    event_id: Optional[str] = None
    order_number: Optional[str] = None
    machine_code: Optional[str] = None
    machine: Optional[Machine] = None
    job_order: Optional[JobOrder] = None
    duplicate: bool = False
    error_code: Optional[str] = None
    message: str = ""

    @property
    def http_status(self) -> int:
        if self.success:
            return 200
        return ERROR_HTTP_STATUS.get(self.error_code or "", 400)

    def response_body(self) -> dict:
        """The stable response envelope (camelCase, mirroring the request)."""
        if self.success:
            return {
                "success": True,
                "eventId": self.event_id,
                "orderNumber": self.order_number,
                "machineCode": self.machine_code,
                "message": self.message or SUCCESS_MESSAGE,
            }
        return {
            "success": False,
            "eventId": self.event_id,
            "errorCode": self.error_code,
            "message": self.message,
        }


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


async def process_event(db: AsyncSession, payload: Any) -> IngestOutcome:
    """Process one parsed inbound Cortex body. Flushes (audit row included) but
    never commits; the caller commits. See the module docstring for semantics."""
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
