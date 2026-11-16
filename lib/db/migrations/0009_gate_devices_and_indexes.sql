-- ============================================================================
-- 0009_gate_devices_and_indexes.sql
-- AttendX Phase 7 — Phone-as-Gate-Camera network + audit-driven index sweep
--
-- 1. Generalizes pi_devices → gate_devices (rename, data preserved) with the
--    new phone-camera columns (device_type, mode, assigned gate, resolution,
--    health, battery, thumbnail, command mailbox) and a daily uptime rollup
--    table for the reliability report.
-- 2. Adds the missing indexes found by the Phase 7 full-system audit on the
--    hottest query paths (attendance dashboards, job queue polling, QR badge
--    door lookups, audit feed, SMS per-student history, review queue).
--
-- Fully idempotent: rename guarded by IF EXISTS, every ADD COLUMN / CREATE
-- TABLE / CREATE INDEX uses IF NOT EXISTS, so racing processes are safe.
--
-- Apply with: psql $DATABASE_URL -f lib/db/migrations/0009_gate_devices_and_indexes.sql
-- (The api-server also applies this automatically at boot — see
--  artifacts/api-server/src/lib/schema-bootstrap.ts.)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. pi_devices → gate_devices (rename preserves every existing Pi row)
-- ----------------------------------------------------------------------------
ALTER TABLE IF EXISTS pi_devices RENAME TO gate_devices;

CREATE TABLE IF NOT EXISTS gate_devices (
  id                          TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  device_type                 TEXT NOT NULL DEFAULT 'pi',
  mode                        TEXT NOT NULL DEFAULT 'face',
  status                      TEXT NOT NULL DEFAULT 'offline',
  assigned_gate_id            TEXT,
  local_ip                    TEXT,
  uptime_seconds              INTEGER,
  cpu_temp_c                  REAL,
  queue_depth                 INTEGER NOT NULL DEFAULT 0,
  fan_temp_c                  REAL,
  fan_state                   TEXT NOT NULL DEFAULT 'unknown',
  resolution                  TEXT,
  fps                         REAL,
  health_status               TEXT NOT NULL DEFAULT 'ok',
  battery_level               REAL,
  connection                  TEXT,
  data_saver                  BOOLEAN NOT NULL DEFAULT FALSE,
  target_quality              TEXT,
  thumbnail                   TEXT,
  thumbnail_at                TIMESTAMP WITH TIME ZONE,
  pending_command             TEXT,
  pending_command_at          TIMESTAMP WITH TIME ZONE,
  current_token_hash          TEXT,
  previous_token_hash         TEXT,
  previous_token_valid_until  TIMESTAMP WITH TIME ZONE,
  token_expires_at            TIMESTAMP WITH TIME ZONE,
  last_seen_at                TIMESTAMP WITH TIME ZONE,
  created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS device_type        TEXT NOT NULL DEFAULT 'pi';
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS mode               TEXT NOT NULL DEFAULT 'face';
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS assigned_gate_id   TEXT;
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS resolution         TEXT;
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS fps                REAL;
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS health_status      TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS battery_level      REAL;
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS connection         TEXT;
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS data_saver         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS target_quality     TEXT;
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS thumbnail          TEXT;
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS thumbnail_at       TIMESTAMP WITH TIME ZONE;
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS pending_command    TEXT;
ALTER TABLE gate_devices ADD COLUMN IF NOT EXISTS pending_command_at TIMESTAMP WITH TIME ZONE;

-- ----------------------------------------------------------------------------
-- 2. device_uptime_days — daily online-time rollup (uptime report)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_uptime_days (
  device_id      TEXT NOT NULL,
  day            DATE NOT NULL,
  online_seconds INTEGER NOT NULL DEFAULT 0,
  heartbeats     INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TIMESTAMP WITH TIME ZONE,
  last_seen_at   TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (device_id, day)
);

-- ----------------------------------------------------------------------------
-- 3. Audit-driven index sweep (hottest un-indexed query paths)
-- ----------------------------------------------------------------------------

-- attendance_logs: dashboards/reports/QR/face all filter by date+classroom
-- or student — previously NO secondary indexes at all (full scans).
CREATE INDEX IF NOT EXISTS idx_attendance_marked_at          ON attendance_logs (marked_at);
CREATE INDEX IF NOT EXISTS idx_attendance_classroom_marked   ON attendance_logs (classroom_id, marked_at);
CREATE INDEX IF NOT EXISTS idx_attendance_student_marked     ON attendance_logs (student_id, marked_at);
CREATE INDEX IF NOT EXISTS idx_attendance_status_marked      ON attendance_logs (status, marked_at);

-- audit_logs: the audit feed orders by created_at and polls every 20s.
CREATE INDEX IF NOT EXISTS idx_audit_created                 ON audit_logs (created_at);

-- jobs: Pi/device workers poll WHERE worker=? AND status='pending';
-- bulk-match dedupe scans recent jobs by (type, created_at).
CREATE INDEX IF NOT EXISTS idx_jobs_worker_status_created    ON jobs (worker, status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_type_created             ON jobs (type, created_at);

-- sms_logs: per-student SMS history drawer filters by student + sent_at.
CREATE INDEX IF NOT EXISTS idx_sms_student_sent              ON sms_logs (student_id, sent_at);

-- qr_issues: the physical door hot path looks a badge up by token_hash;
-- manager views filter by student.
CREATE INDEX IF NOT EXISTS idx_qr_issues_token               ON qr_issues (token_hash);
CREATE INDEX IF NOT EXISTS idx_qr_issues_student             ON qr_issues (student_id);

-- match_reviews: pending-queue dashboards + hourly retention purge.
CREATE INDEX IF NOT EXISTS idx_match_reviews_status          ON match_reviews (status, created_at);
CREATE INDEX IF NOT EXISTS idx_match_reviews_purge           ON match_reviews (purge_at);

-- gate_devices: token lookup is the hottest machine-auth path; type/gate/
-- seen power the Camera Network grid.
CREATE INDEX IF NOT EXISTS idx_gate_devices_token            ON gate_devices (current_token_hash);
CREATE INDEX IF NOT EXISTS idx_gate_devices_type             ON gate_devices (device_type);
CREATE INDEX IF NOT EXISTS idx_gate_devices_gate             ON gate_devices (assigned_gate_id);
CREATE INDEX IF NOT EXISTS idx_gate_devices_seen             ON gate_devices (last_seen_at);
