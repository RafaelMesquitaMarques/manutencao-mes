-- ============================================================================
-- Migration: TimescaleDB foundation for production / stop "big data"
-- Date: 2026-07-08
-- ============================================================================
-- Idempotent — safe to run multiple times. Run AFTER the backend has created
-- the tables (SQLAlchemy create_all), against the live DB:
--
--   docker compose exec -T db psql -U mesadmin -d manutencao \
--     < scripts/migrations/2026-07-08_timescale_production.sql
--
-- Why a standalone migration (not just init_db.sql): docker-entrypoint-initdb.d
-- only runs on a FRESH volume, and even then before create_all exists — so the
-- init_db.sql hypertable blocks were being skipped (guarded by IF EXISTS). This
-- script is the reliable path for the already-initialized database.
--
-- What it does:
--   1. sensor_readings          → hypertable + compression(30d) + retention(2y)
--   2. machine_production_hourly → hypertable + compression(90d)
--        + continuous aggregate  machine_production_daily (parts/rejects per day)
--   3. machine_stops            → time+machine indexes (kept as a plain table on
--        purpose — small, and read by primary key via db.get; see the note below)
--
-- NOTE on machine_stops: it stays a normal Postgres table. It is small (event-
-- level, ~1 GB/year even pessimistically) and is fetched by id (db.get) and
-- updated on justify/close/reclassify, which a hypertable's compressed chunks
-- make awkward. Good composite indexes keep its range scans fast into the tens
-- of millions of rows. Revisit (hypertable + a downtime continuous aggregate)
-- only if micro-stops are ever logged at high frequency.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ── 1. sensor_readings → hypertable (the high-frequency telemetry stream) ──────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sensor_readings')
     AND NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                     WHERE hypertable_name = 'sensor_readings') THEN
    -- The partitioning column must be part of every unique index / PK.
    ALTER TABLE sensor_readings DROP CONSTRAINT IF EXISTS sensor_readings_pkey;
    ALTER TABLE sensor_readings ADD PRIMARY KEY (id, "timestamp");

    PERFORM create_hypertable('sensor_readings', 'timestamp',
      migrate_data => TRUE, if_not_exists => TRUE,
      chunk_time_interval => INTERVAL '7 days');

    ALTER TABLE sensor_readings SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'sensor_id',
      timescaledb.compress_orderby   = '"timestamp" DESC');
    PERFORM add_compression_policy('sensor_readings', INTERVAL '30 days', if_not_exists => TRUE);
    PERFORM add_retention_policy('sensor_readings', INTERVAL '2 years', if_not_exists => TRUE);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_ts ON sensor_readings (sensor_id, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_equip_ts  ON sensor_readings (equipment_id, "timestamp" DESC);

-- ── 2. machine_production_hourly → hypertable (grows with every machine·hour) ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'machine_production_hourly')
     AND NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                     WHERE hypertable_name = 'machine_production_hourly') THEN
    ALTER TABLE machine_production_hourly DROP CONSTRAINT IF EXISTS machine_production_hourly_pkey;
    ALTER TABLE machine_production_hourly ADD PRIMARY KEY (id, hour);

    PERFORM create_hypertable('machine_production_hourly', 'hour',
      migrate_data => TRUE, if_not_exists => TRUE,
      chunk_time_interval => INTERVAL '30 days');

    ALTER TABLE machine_production_hourly SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'machine_id',
      timescaledb.compress_orderby   = 'hour DESC');
    -- Compress raw hourly buckets older than 90 days. No retention drop: the raw
    -- history is small once compressed, and the daily aggregate below is kept
    -- forever for long-range trends regardless.
    PERFORM add_compression_policy('machine_production_hourly', INTERVAL '90 days', if_not_exists => TRUE);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mph_machine_hour ON machine_production_hourly (machine_id, hour DESC);

-- Continuous aggregate: produced / rejected per machine per day, auto-refreshing.
-- Dashboards and BI read THIS (one row per machine·day) instead of scanning raw
-- hourly rows. Monthly/quarterly rollups are a cheap GROUP BY over this view.
CREATE MATERIALIZED VIEW IF NOT EXISTS machine_production_daily
WITH (timescaledb.continuous) AS
SELECT
  machine_id,
  time_bucket(INTERVAL '1 day', hour) AS bucket,
  sum(count)        AS produced,
  sum(reject_count) AS rejected
FROM machine_production_hourly
GROUP BY machine_id, time_bucket(INTERVAL '1 day', hour);

SELECT add_continuous_aggregate_policy('machine_production_daily',
  start_offset      => INTERVAL '90 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE);

-- ── 3. machine_stops → performance indexes (kept as a plain table) ─────────────
CREATE INDEX IF NOT EXISTS idx_machine_stops_machine_started ON machine_stops (machine_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_machine_stops_started         ON machine_stops (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_machine_stops_category        ON machine_stops (stop_category_id);
