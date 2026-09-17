"""Shared harness for the DB-facing integration tests.
=====================================================
These tests run INSIDE the backend container against the live Postgres and are
isolated by transaction: every test gets a session, does its writes, and is
ALWAYS rolled back — the database is never mutated.

Everything that used to be copy-pasted into ~30 test modules now lives here, so
the whole session shares ONE event loop and ONE engine:

  · SQLAlchemy's async engine binds its asyncpg connection to the event loop of
    the first operation and caches it, so it must live on ONE persistent loop
    (a fresh ``asyncio.run()`` per test → "attached to a different loop").
  · One loop + one engine for the session also means the run no longer leaks 30
    never-closed loops and 30 never-disposed engines, and there is a single
    place for session-wide setup (``ensure_hypertable_chunks``) and teardown
    (``shutdown``) — both driven from conftest.py.

Each test is a plain sync function (see ``with_session``) that drives its async
body on that loop, so no async pytest plugin is required.

Run (inside the backend container):
    pip install pytest
    pytest tests/ -q
"""
import asyncio
import logging
import os
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                              # noqa: E402

log = logging.getLogger(__name__)

# The one loop and the one engine for the whole pytest session. NullPool → each
# session gets its own connection on that loop; every test is rolled back, so
# the database is never mutated.
LOOP = asyncio.new_event_loop()
_ENGINE = {}


def engine():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return _ENGINE["e"]


def maker():
    return async_sessionmaker(engine(), expire_on_commit=False)


def run(body):
    """Drive a one-off coroutine function on the shared loop (module-level setup)."""
    return LOOP.run_until_complete(body())


def _wrap(fn, *, commit_as_flush):
    """Turn an ``async def test(s)`` into a SYNC pytest test run on the shared loop.

    NOTE: we deliberately do NOT use functools.wraps — it sets ``__wrapped__``,
    which pytest follows back to the original async function and then refuses to
    run ("async def not natively supported"). We copy name/doc by hand instead."""
    def wrapper():
        async def runner():
            s = maker()()
            if commit_as_flush:
                s.commit = s.flush   # endpoint commits; keep it in the rolled-back txn
            try:
                await fn(s)
            finally:
                await s.rollback()
                await s.close()
        LOOP.run_until_complete(runner())
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


def with_session(fn):
    """``@with_session`` — async body on the shared loop, always rolled back."""
    return _wrap(fn, commit_as_flush=False)


def with_session_commit_as_flush(fn):
    """Same, for tests driving an endpoint that commits: ``commit`` becomes
    ``flush`` so the endpoint's writes stay inside the rolled-back transaction."""
    return _wrap(fn, commit_as_flush=True)


# ── TimescaleDB chunk pre-creation: this suite's old flakiness ───────────────
#
# ``sensor_readings`` and ``machine_production_hourly`` are hypertables. When a
# row's timestamp falls outside every existing chunk, TimescaleDB creates the
# chunk INSIDE the caller's transaction and replays the hypertable's foreign keys
# onto it:
#
#     ALTER TABLE _timescaledb_internal._hyper_1_NNNN_chunk
#       ADD CONSTRAINT ... FOREIGN KEY (equipment_id) REFERENCES public.equipment(id)
#
# That needs ShareRowExclusive on ``equipment``/``sensors``/``machines``, while
# the chunk creation itself already holds ShareUpdateExclusive on the hypertable.
# A test that created an Equipment row holds RowExclusive on ``equipment`` for its
# whole transaction — so two concurrent transactions (two runs of this suite, or
# the suite plus the live app and workers) take those two locks in opposite
# orders and Postgres kills one of them:
#
#     deadlock detected
#     Process A waits for ShareRowExclusiveLock on relation <equipment>; blocked by B.
#     Process B waits for ShareUpdateExclusiveLock on relation <sensor_readings>; blocked by A.
#
# Chunk DDL is transactional, so every rolled-back test RE-CREATED its chunks and
# the race was live on every run — which is why the suite failed a couple of times
# out of ten, on a different random test each time, always a DBAPIError and never
# an assertion.
#
# Creating those chunks ONCE, committed, before any test runs takes the DDL out of
# the test transactions: from then on the writes are plain inserts into an existing
# chunk, and there is no lock-order inversion left to lose. An empty chunk is
# schema, not data — the sentinel rows that bring it into existence are deleted in
# the same transaction, so no row is ever visible to anybody and the suite's
# "never mutate the database" contract still holds for rows.
#
# Keep DAYS_BACK/DAYS_AHEAD at least as wide as the widest window any test writes
# into (today: test_predictive's 12 days of readings ending at ``now``). If a test
# ever writes outside it, chunk DDL — and the flakiness — comes back;
# tests/test_hypertable_chunks.py is the guard that catches that.
#
# There is a ceiling on DAYS_BACK, though: app.main._ensure_timescale installs
#   add_compression_policy('sensor_readings', INTERVAL '30 days')
# so chunks older than 30 days get compressed, and the INSERT+DELETE below is a
# plain write — on a compressed chunk that is a different (and much slower)
# story. 21 days stays clear of it. Widening past 30 means handling compressed
# chunks explicitly, not just bumping the number.
DAYS_BACK = 21
DAYS_AHEAD = 14

HYPERTABLES = (
    {
        "table": "sensor_readings",
        "column": "timestamp",
        "parents": "SELECT s.id AS sensor_id, s.equipment_id AS equipment_id "
                   "FROM sensors s JOIN equipment e ON e.id = s.equipment_id LIMIT 1",
        "insert": "INSERT INTO sensor_readings (id, sensor_id, equipment_id, timestamp, value, quality) "
                  "VALUES (gen_random_uuid(), :sensor_id, :equipment_id, :ts, 0, 'ok')",
    },
    {
        "table": "machine_production_hourly",
        "column": "hour",
        "parents": "SELECT id AS machine_id FROM machines LIMIT 1",
        "insert": "INSERT INTO machine_production_hourly (id, machine_id, hour, count, reject_count) "
                  "VALUES (gen_random_uuid(), :machine_id, :ts, 0, 0)",
    },
)

_IS_HYPERTABLE = text(
    "SELECT EXISTS (SELECT 1 FROM timescaledb_information.hypertables "
    "WHERE hypertable_schema = 'public' AND hypertable_name = :table)")

_MISSING_DAYS = text("""
    SELECT d.day FROM generate_series(:start, :end, INTERVAL '1 day') AS d(day)
     WHERE NOT EXISTS (
       SELECT 1 FROM timescaledb_information.chunks c
        WHERE c.hypertable_schema = 'public' AND c.hypertable_name = :table
          AND d.day >= c.range_start AND d.day < c.range_end)
     ORDER BY d.day
""")


_WINDOW = {}


def window():
    """The [start, end] the suite writes time-series rows into.

    Pinned on first call and reused for the rest of the session: a window
    recomputed from ``now`` would widen by a day if a run crossed midnight UTC,
    so the chunks pre-created at session start would no longer be the ones the
    guard test checks for."""
    if "w" not in _WINDOW:
        day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        _WINDOW["w"] = (day - timedelta(days=DAYS_BACK), day + timedelta(days=DAYS_AHEAD))
    return _WINDOW["w"]


async def missing_chunk_days(conn, spec, start, end):
    """Days in [start, end] that ``spec['table']`` has no chunk for."""
    if not await conn.scalar(_IS_HYPERTABLE, {"table": spec["table"]}):
        return []                                   # not a hypertable here → nothing to do
    return list((await conn.execute(
        _MISSING_DAYS, {"start": start, "end": end, "table": spec["table"]})).scalars().all())


async def _warm(spec, start, end):
    """Commit the chunks ``spec['table']`` is missing over [start, end], leaving no row."""
    async with engine().begin() as conn:
        days = await missing_chunk_days(conn, spec, start, end)
        if not days:
            return 0
        parents = (await conn.execute(text(spec["parents"]))).mappings().first()
        if parents is None:
            log.warning("tests: no FK parent row for %s — its chunks are left to the tests, "
                        "which makes the suite deadlock-prone under concurrent DB access",
                        spec["table"])
            return 0
        # Locks land in the same order TimescaleDB's own chunk creation uses
        # (hypertable, then the FK parents), so this adds no new lock ordering.
        for day in days:
            await conn.execute(text(spec["insert"]), {**parents, "ts": day})
        await conn.execute(
            text(f'DELETE FROM {spec["table"]} WHERE "{spec["column"]}" = ANY(:days)'),
            {"days": days})
        return len(days)


def ensure_hypertable_chunks():
    """Session setup: no test transaction should ever have to create a chunk."""
    async def body():
        start, end = window()
        for spec in HYPERTABLES:
            made = await _warm(spec, start, end)
            if made:
                log.info("tests: pre-created %d %s chunk day(s)", made, spec["table"])
    run(body)


def shutdown():
    """Session teardown: dispose the engine, close the loop."""
    if "e" in _ENGINE:
        LOOP.run_until_complete(_ENGINE.pop("e").dispose())
    LOOP.close()
