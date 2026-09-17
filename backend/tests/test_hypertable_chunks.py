"""Guards on the fix for this suite's deadlock flakiness.
========================================================
The suite used to fail ~2 runs in 10, on a different random test each time,
always with a ``DBAPIError`` and never an assertion. Cause: a test whose
``sensor_readings``/``machine_production_hourly`` row landed outside every
existing TimescaleDB chunk made Timescale create the chunk INSIDE the test's
transaction, which replays the hypertable's foreign keys onto the new chunk:

    ALTER TABLE _timescaledb_internal._hyper_1_NNNN_chunk
      ADD CONSTRAINT ... FOREIGN KEY (equipment_id) REFERENCES public.equipment(id)

That wants ShareRowExclusive on ``equipment``/``sensors``/``machines`` while
holding ShareUpdateExclusive on the hypertable, and a test that already created
an Equipment row holds RowExclusive on ``equipment`` for its whole transaction.
Two concurrent transactions therefore took the two locks in opposite orders and
Postgres killed one — the full mechanism is in db_harness.py.

conftest.py now pre-creates those chunks once, committed, so no test transaction
ever runs that DDL, and every module shares one loop and one engine. These two
tests fail if either half stops holding.

Useful diagnostic when investigating time-series churn by hand — Timescale hands
out chunk ids from a sequence and rolled-back chunk creation still burns them, so
a suite that keeps creating and discarding chunks shows up as a gap between the
committed chunks and the counter (it was 10 chunks against a counter of 2274
when this was found, and the counter no longer moves during a run):

    select (select count(*) from timescaledb_information.chunks) as chunks,
           (select last_value from _timescaledb_catalog.chunk_id_seq) as ids_used;
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import db_harness                                                      # noqa: E402
from db_harness import with_session                                    # noqa: E402


@with_session
async def test_no_chunk_is_missing_in_the_written_window(s):
    """Every day the suite writes time-series rows into already has a chunk, so a
    test insert stays a plain insert and never escalates into foreign-key DDL."""
    start, end = db_harness.window()
    conn = await s.connection()
    for spec in db_harness.HYPERTABLES:
        missing = await db_harness.missing_chunk_days(conn, spec, start, end)
        assert missing == [], (
            f"{spec['table']} has no chunk for {[d.date().isoformat() for d in missing]} — "
            "a test writing there would create it inside its own transaction and the suite "
            "goes back to deadlocking under concurrent DB access. If a test legitimately "
            "writes further out, widen db_harness.DAYS_BACK/DAYS_AHEAD.")


@with_session
async def test_the_whole_session_shares_one_engine_and_one_loop(s):
    """The per-module loops and engines are gone: 30 modules used to build their
    own, which leaked them and left no single place for session setup."""
    import asyncio

    assert asyncio.get_running_loop() is db_harness.LOOP
    assert db_harness.engine() is db_harness.engine()
    assert s.get_bind() is db_harness.engine().sync_engine   # get_bind() unwraps to the sync engine
