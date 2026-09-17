"""AI-insights (intelligence_calculator) plant-segregation regression.
====================================================================
`build_findings(plant_id=…)` is called PER PLANT by the insights cron and the
result is stored under that plant (AIInsight.plant_id). But the data fetches
queried every plant, so a plant's AI insight was computed from — and its text
named — every other plant's machines/tickets/technicians. Now the fetches are
scoped to the plant:

  · _fetch_machines / _fetch_tickets return only the plant's rows
  · build_findings stays labelled with its plant and never analyses a machine
    outside it

Harness identical to test_plant_segregation.py — INSIDE the backend container,
one shared loop, every write ALWAYS rolled back (read-only here).
"""
import os
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.models.models import Machine, MaintenanceTicket, Plant   # noqa: E402
from app.services.intelligence_calculator import (                # noqa: E402
    _fetch_machines, _fetch_tickets, build_findings,
)
from db_harness import with_session    # noqa: E402


async def _plants(db):
    rows = (await db.execute(select(Plant).where(Plant.code.in_(["QS", "QM", "NL"])))).scalars().all()
    by_code = {p.code: p for p in rows}
    assert set(by_code) == {"QS", "QM", "NL"}, "live plants QS/QM/NL must exist"
    return by_code


@with_session
async def test_fetch_machines_scoped(db):
    p = await _plants(db)
    rows = await _fetch_machines(db, p["QM"].id)
    for r in rows:
        m = await db.get(Machine, r["id"])
        assert m is not None and m.plant_id == p["QM"].id, "foreign machine leaked into findings"
    # a QS machine must not appear in the QM fetch
    qs_id = (await db.execute(select(Machine.id).where(Machine.plant_id == p["QS"].id).limit(1))).scalar()
    if qs_id is not None:
        assert qs_id not in {r["id"] for r in rows}


@with_session
async def test_fetch_tickets_scoped(db):
    p = await _plants(db)
    start = datetime.now(timezone.utc) - timedelta(days=3650)
    end = datetime.now(timezone.utc) + timedelta(days=1)
    rows = await _fetch_tickets(db, start, end, p["QM"].id)
    for r in rows:
        t = await db.get(MaintenanceTicket, r["id"])
        assert t is not None and t.plant_id == p["QM"].id, "foreign ticket leaked into findings"


@with_session
async def test_build_findings_scoped_to_plant(db):
    p = await _plants(db)
    qm_machine_ids = {
        str(m) for m in (await db.execute(
            select(Machine.id).where(Machine.plant_id == p["QM"].id)
        )).scalars().all()
    }
    findings = await build_findings(db, period_days=30, plant_id=str(p["QM"].id))
    assert findings["plant_id"] == str(p["QM"].id)
    # every machine surfaced in the risk analysis belongs to QM
    for risk in findings.get("machine_risks", []):
        mid = risk.get("machine_id")
        if mid is not None:
            assert str(mid) in qm_machine_ids, "risk analysis named a machine outside the plant"
