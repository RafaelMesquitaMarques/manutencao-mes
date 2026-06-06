-- MES Maintenance Platform — database initialization
-- Executed automatically by Docker on first startup

-- Enable TimescaleDB extension (included in the base image)
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Create hypertable for IoT sensor time-series data
-- (executed after SQLAlchemy creates the table via create_all)
-- This block is idempotent: it does not fail if the hypertable already exists

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'sensor_readings'
  ) THEN
    PERFORM create_hypertable(
      'sensor_readings', 'timestamp',
      if_not_exists => TRUE,
      chunk_time_interval => INTERVAL '7 days'
    );

    -- Auto-compression policy (data older than 30 days)
    PERFORM add_compression_policy(
      'sensor_readings',
      INTERVAL '30 days',
      if_not_exists => TRUE
    );

    -- Retention policy (drop data older than 2 years)
    PERFORM add_retention_policy(
      'sensor_readings',
      INTERVAL '2 years',
      if_not_exists => TRUE
    );
  END IF;
END $$;

-- Additional performance indexes
CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_ts
  ON sensor_readings (sensor_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_sensor_readings_equip_ts
  ON sensor_readings (equipment_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_wo_status
  ON work_orders (status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_wo_equipment
  ON work_orders (equipment_id, status);

CREATE INDEX IF NOT EXISTS idx_alerts_unacknowledged
  ON alerts (acknowledged, created_at DESC)
  WHERE acknowledged = false;
