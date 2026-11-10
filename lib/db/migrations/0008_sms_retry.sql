-- ============================================================================
-- 0008_sms_retry.sql
-- AttendX — SMS retry engine (failed-log re-send)
-- Date: 2026-12
--
-- Adds the retry lineage column to sms_logs:
--   retry_of_id  INTEGER  — when a row is a re-send of an earlier failed
--                           attempt, that original row's id. NULL = original
--                           send. "Retry all failed" uses NOT EXISTS on this
--                           column to skip rows that already have a newer
--                           attempt, so parents never get duplicate spam.
--
-- Fully idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--
-- Apply with: psql $DATABASE_URL -f lib/db/migrations/0008_sms_retry.sql
-- (The api-server also applies this automatically at boot — see
--  artifacts/api-server/src/lib/schema-bootstrap.ts.)
-- ============================================================================

ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS retry_of_id INTEGER;

-- Mirror of schema index("sms_logs_retry_of_idx").on(t.retryOfId)
CREATE INDEX IF NOT EXISTS sms_logs_retry_of_idx ON sms_logs (retry_of_id);
