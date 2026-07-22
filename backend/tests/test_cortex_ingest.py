"""
Cortex inbound API tests — cortex_ingest_service.process_event.
===============================================================
Same container harness as test_job_order_scan.py: each async body runs on one
shared event loop and every write is ALWAYS rolled back. Covers the flow-1
contract (cobot reads an OF → Cortex pushes it to /api/v1/cortex/events):

  valid OF accepted (scan + enrichment + audit) · unknown machine/site/site
  mismatch · inactive machine · missing required fields · unsupported event
  type · idempotency (duplicate after success, retry after failure) · a new OF
  replaces the active one with history preserved · same-OF redelivery is a
  no-op · unknown extra fields accepted and audited · malformed optional
  fields ignored vs malformed required timestamp rejected · events for two
  machines land independently · unexpected exceptions propagate (the route
  answers INTERNAL_ERROR).

Auth (401/503) lives in the route (_auth_error) and is covered by
test_route_auth_check below without HTTP; true concurrent redelivery is
serialized by the partial unique index uq_cortex_events_event_success +
the route's IntegrityError handler (not exercisable in this rollback harness).

Run (inside the backend container):
    pip install pytest
    pytest tests/test_cortex_ingest.py -v
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                                  # noqa: E402
from app.models.models import (                                       # noqa: E402
    CortexEvent, JobOrder, JobOrderRun, JobOrderSource, JobOrderStatus,
    Machine, Plant,
)
import app.services.cortex_ingest_service as cis                      # noqa: E402
from app.services.cortex_ingest_service import process_event          # noqa: E402
from app.services.job_order_service import get_open_run               # noqa: E402

_LOOP = asyncio.new_event_loop()
_ENGINE = {}


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    """Async body on the shared loop, always rolled back."""
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


async def _plant(s, code=None):
    p = Plant(code=code or f"T{uuid.uuid4().hex[:6]}", name="Test plant")
    s.add(p)
    await s.flush()
    return p


async def _machine(s, plant_id=None, active=True, slug=None):
    m = Machine(
        name=f"CTX-{uuid.uuid4().hex[:8]}",
        code=f"CTX-{uuid.uuid4().hex[:10].upper()}",
        department="Cutting",
        plant_id=plant_id,
        is_active=active,
        page_slug=slug,
    )
    s.add(m)
    await s.flush()
    return m


def _payload(machine_code, of=None, event_id=None, site=None, mo_overrides=None, **overrides):
    body = {
        "eventId": event_id or f"evt-{uuid.uuid4().hex}",
        "eventType": "manufacturing_order_scanned",
        "timestamp": "2026-07-21T14:30:00Z",
        "machineCode": machine_code,
        "cobotCode": "COBOT-001",
        "manufacturingOrder": {
            "orderNumber": of or f"OF-{uuid.uuid4().hex[:10]}",
            "productCode": "ITEM-001",
            "productDescription": "Commode 6 tiroirs",
            "plannedQuantity": 100,
            "completedQuantity": 0,
            "unitOfMeasure": "EA",
            "operationCode": "OP-010",
            "operationDescription": "Perçage façade",
            "plannedStartDate": "2026-07-21T14:00:00Z",
            "plannedEndDate": "2026-07-21T18:00:00Z",
        },
    }
    if site:
        body["siteCode"] = site
    if mo_overrides:
        body["manufacturingOrder"].update(mo_overrides)
    body.update(overrides)
    return body


async def _events_for(s, event_id):
    r = await s.execute(select(CortexEvent).where(CortexEvent.event_id == event_id)
                        .order_by(CortexEvent.received_at))
    return r.scalars().all()


# ─── Happy path ────────────────────────────────────────────────────────────────

@with_session
async def test_valid_of_accepted_and_enriched(s):
    plant = await _plant(s)
    m = await _machine(s, plant_id=plant.id)
    p = _payload(m.code, site=plant.code)
    out = await process_event(s, p)

    assert out.success and not out.duplicate
    assert out.machine.id == m.id
    body = out.response_body()
    assert body["success"] is True
    assert body["eventId"] == p["eventId"]
    assert body["orderNumber"] == p["manufacturingOrder"]["orderNumber"]
    assert body["machineCode"] == m.code
    assert out.http_status == 200

    # OF created, enriched, associated + run open with the payload timestamp
    jo = out.job_order
    assert jo.job_number == p["manufacturingOrder"]["orderNumber"]
    assert jo.status == JobOrderStatus.in_progress
    assert jo.machine_id == m.id and jo.plant_id == plant.id
    assert jo.product_name == "Commode 6 tiroirs"
    assert jo.product_code == "ITEM-001"
    assert jo.target_quantity == 100
    assert jo.completed_quantity == 0
    assert jo.unit_of_measure == "EA"
    assert jo.operation_code == "OP-010"
    assert jo.operation_description == "Perçage façade"
    assert jo.planned_start_at is not None and jo.planned_end_at is not None
    assert m.current_job_number == jo.job_number
    run = await get_open_run(s, m.id)
    assert run is not None and run.job_order_id == jo.id
    assert run.source == JobOrderSource.cortex
    assert run.started_at == datetime(2026, 7, 21, 14, 30, tzinfo=timezone.utc)

    # Audit row: success, raw codes + resolved ids + original payload
    evs = await _events_for(s, p["eventId"])
    assert len(evs) == 1
    ev = evs[0]
    assert ev.result == "success" and ev.error_code is None
    assert ev.machine_id == m.id and ev.plant_id == plant.id and ev.job_order_id == jo.id
    assert ev.machine_code == m.code and ev.site_code == plant.code
    assert ev.cobot_code == "COBOT-001"
    assert ev.reading_type == "cobot"
    assert ev.payload["manufacturingOrder"]["orderNumber"] == jo.job_number


# ─── Lookup failures ───────────────────────────────────────────────────────────

@with_session
async def test_machine_not_found(s):
    p = _payload("NO-SUCH-MACHINE")
    out = await process_event(s, p)
    assert not out.success and out.error_code == "MACHINE_NOT_FOUND"
    assert out.http_status == 404
    assert out.response_body()["errorCode"] == "MACHINE_NOT_FOUND"
    evs = await _events_for(s, p["eventId"])
    assert len(evs) == 1 and evs[0].result == "error"
    assert evs[0].machine_code == "NO-SUCH-MACHINE" and evs[0].machine_id is None


@with_session
async def test_site_not_found(s):
    m = await _machine(s)
    out = await process_event(s, _payload(m.code, site="NOPE"))
    assert not out.success and out.error_code == "SITE_NOT_FOUND"
    assert out.http_status == 404


@with_session
async def test_machine_not_in_site(s):
    plant_a = await _plant(s)
    plant_b = await _plant(s)
    m = await _machine(s, plant_id=plant_a.id)
    out = await process_event(s, _payload(m.code, site=plant_b.code))
    assert not out.success and out.error_code == "MACHINE_NOT_IN_SITE"
    assert out.http_status == 404


@with_session
async def test_inactive_machine(s):
    m = await _machine(s, active=False)
    p = _payload(m.code)
    out = await process_event(s, p)
    assert not out.success and out.error_code == "MACHINE_INACTIVE"
    assert out.http_status == 409
    assert await get_open_run(s, m.id) is None
    evs = await _events_for(s, p["eventId"])
    assert evs[0].machine_id == m.id     # resolved machine still audited


# ─── Payload validation ────────────────────────────────────────────────────────

@with_session
async def test_missing_required_fields(s):
    m = await _machine(s)

    no_of = _payload(m.code)
    no_of["manufacturingOrder"].pop("orderNumber")
    out = await process_event(s, no_of)
    assert not out.success and out.error_code == "INVALID_PAYLOAD"
    assert "orderNumber" in out.message

    no_mo = _payload(m.code)
    no_mo.pop("manufacturingOrder")
    out = await process_event(s, no_mo)
    assert not out.success and out.error_code == "INVALID_PAYLOAD"

    no_machine = _payload(m.code, machineCode=None)
    out = await process_event(s, no_machine)
    assert not out.success and "machineCode" in out.message

    no_event_id = _payload(m.code)
    no_event_id.pop("eventId")
    out = await process_event(s, no_event_id)
    assert not out.success and "eventId" in out.message
    # No eventId → audited with event_id NULL
    assert await get_open_run(s, m.id) is None


@with_session
async def test_unsupported_event_type(s):
    m = await _machine(s)
    out = await process_event(s, _payload(m.code, eventType="something_else"))
    assert not out.success and out.error_code == "UNSUPPORTED_EVENT_TYPE"
    assert out.http_status == 422


@with_session
async def test_malformed_fields(s):
    m = await _machine(s)

    # Malformed REQUIRED timestamp → rejected
    out = await process_event(s, _payload(m.code, timestamp="not-a-date"))
    assert not out.success and out.error_code == "INVALID_PAYLOAD"
    assert "timestamp" in out.message

    # Malformed OPTIONAL fields → ignored, event still succeeds
    p = _payload(m.code, mo_overrides={
        "plannedQuantity": "abc", "completedQuantity": -5,
        "plannedStartDate": "garbage",
    })
    out = await process_event(s, p)
    assert out.success
    jo = out.job_order
    assert jo.target_quantity is None
    assert jo.completed_quantity is None
    assert jo.planned_start_at is None
    assert jo.planned_end_at is not None    # the valid one still lands


@with_session
async def test_unknown_extra_fields_accepted(s):
    m = await _machine(s)
    p = _payload(m.code, futureField={"nested": True},
                 mo_overrides={"newErpCode": "X-1"})
    out = await process_event(s, p)
    assert out.success
    ev = (await _events_for(s, p["eventId"]))[0]
    assert ev.payload["futureField"] == {"nested": True}
    assert ev.payload["manufacturingOrder"]["newErpCode"] == "X-1"


# ─── Idempotency ───────────────────────────────────────────────────────────────

@with_session
async def test_duplicate_after_success(s):
    m = await _machine(s)
    p = _payload(m.code)
    first = await process_event(s, p)
    assert first.success and not first.duplicate
    run_before = await get_open_run(s, m.id)

    second = await process_event(s, p)      # same eventId redelivered
    assert second.success and second.duplicate
    assert second.http_status == 200        # Cortex must read it as an ack
    run_after = await get_open_run(s, m.id)
    assert run_after.id == run_before.id    # nothing reprocessed

    evs = await _events_for(s, p["eventId"])
    assert [e.result for e in evs] == ["success", "duplicate"]


@with_session
async def test_retry_after_failure_processes(s):
    event_id = f"evt-{uuid.uuid4().hex}"
    p = _payload("GHOST-MACHINE", event_id=event_id)
    out = await process_event(s, p)
    assert not out.success

    m = await _machine(s)
    retry = _payload(m.code, event_id=event_id, of=p["manufacturingOrder"]["orderNumber"])
    out = await process_event(s, retry)     # corrected retry, same eventId
    assert out.success and not out.duplicate
    evs = await _events_for(s, event_id)
    assert [e.result for e in evs] == ["error", "success"]


# ─── OF ↔ machine association lifecycle ────────────────────────────────────────

@with_session
async def test_new_of_replaces_active_history_preserved(s):
    m = await _machine(s)
    a = _payload(m.code, of="OF-AAA-" + uuid.uuid4().hex[:6])
    b = _payload(m.code, of="OF-BBB-" + uuid.uuid4().hex[:6])
    out_a = await process_event(s, a)
    out_b = await process_event(s, b)
    assert out_a.success and out_b.success

    # Machine now carries B; A's run is CLOSED, not erased
    assert m.current_job_number == b["manufacturingOrder"]["orderNumber"]
    open_run = await get_open_run(s, m.id)
    assert open_run.job_order_id == out_b.job_order.id
    runs = (await s.execute(select(JobOrderRun).where(JobOrderRun.machine_id == m.id))).scalars().all()
    assert len(runs) == 2
    closed = [r for r in runs if r.ended_at is not None]
    assert len(closed) == 1 and closed[0].job_order_id == out_a.job_order.id
    # Both audit rows still there
    assert (await _events_for(s, a["eventId"]))[0].result == "success"
    assert (await _events_for(s, b["eventId"]))[0].result == "success"


@with_session
async def test_same_of_redelivered_is_noop(s):
    m = await _machine(s)
    of = "OF-SAME-" + uuid.uuid4().hex[:6]
    out1 = await process_event(s, _payload(m.code, of=of))
    out2 = await process_event(s, _payload(m.code, of=of))   # NEW eventId, same OF
    assert out1.success and out2.success
    assert out2.message == cis.ALREADY_ACTIVE_MESSAGE
    runs = (await s.execute(
        select(JobOrderRun).where(JobOrderRun.job_order_id == out1.job_order.id)
    )).scalars().all()
    assert len(runs) == 1                                    # no run churn


@with_session
async def test_events_for_two_machines_land_independently(s):
    plant = await _plant(s)
    m1 = await _machine(s, plant_id=plant.id)
    m2 = await _machine(s, plant_id=plant.id)
    out1 = await process_event(s, _payload(m1.code, site=plant.code))
    out2 = await process_event(s, _payload(m2.code, site=plant.code))
    assert out1.success and out2.success
    assert (await get_open_run(s, m1.id)).job_order_id == out1.job_order.id
    assert (await get_open_run(s, m2.id)).job_order_id == out2.job_order.id


# ─── Internal failure ──────────────────────────────────────────────────────────

@with_session
async def test_internal_error_propagates(s):
    """A DB/bug exception must NOT be swallowed as a business error — the route
    catches it, audits best-effort and answers INTERNAL_ERROR (retry-safe)."""
    m = await _machine(s)
    original = cis.scan_job_order_at_machine

    async def boom(*a, **kw):
        raise RuntimeError("db exploded")

    cis.scan_job_order_at_machine = boom
    try:
        with pytest.raises(RuntimeError):
            await process_event(s, _payload(m.code))
    finally:
        cis.scan_job_order_at_machine = original


# ─── Route-level auth (no HTTP stack needed) ──────────────────────────────────

def test_route_auth_check():
    """_auth_error: 503 while unconfigured, 401 on bad/missing token, None on a
    valid Bearer or X-Ingest-Token (incl. a rotated second value)."""
    from app.api.routes.cortex_ingest import _auth_error

    class FakeRequest:
        def __init__(self, headers):
            self.headers = headers
            self.method = "POST"

            class _U:
                path = "/api/v1/cortex/events"
            self.url = _U()

    old = settings.CORTEX_INGEST_TOKEN
    try:
        settings.CORTEX_INGEST_TOKEN = ""
        resp = _auth_error(FakeRequest({}))
        assert resp is not None and resp.status_code == 503

        settings.CORTEX_INGEST_TOKEN = "tok-a, tok-b"
        assert _auth_error(FakeRequest({"Authorization": "Bearer tok-a"})) is None
        assert _auth_error(FakeRequest({"X-Ingest-Token": "tok-b"})) is None
        for bad in ({}, {"Authorization": "Bearer wrong"}, {"X-Ingest-Token": "wrong"}):
            resp = _auth_error(FakeRequest(bad))
            assert resp is not None and resp.status_code == 401
    finally:
        settings.CORTEX_INGEST_TOKEN = old
