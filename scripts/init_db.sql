-- KAIZO database initialization — docker-entrypoint-initdb.d (docker-compose.yml)
--
-- Runs ONCE, when the db volume is brand new. At that point the backend has not
-- created a single table yet, so nothing here may touch application tables: one
-- failing statement aborts the first boot (ON_ERROR_STOP), Docker restarts the
-- container and the rest of this file never runs.
--
-- Hypertables, compression/retention policies, the continuous aggregate and
-- their indexes are created by the backend at startup, after create_all:
-- _ensure_timescale() in backend/app/main.py.

-- The timescale image's own init script already does this; kept so the
-- database does not depend on it.
CREATE EXTENSION IF NOT EXISTS timescaledb;
