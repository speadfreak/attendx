import type { RequestHandler } from "express";
import { pool } from "@workspace/db";

/**
 * Runtime schema bootstrap — Phase 6 self-healing.
 *
 * Fresh deploys (and some existing databases) are missing migration
 * `0007_phase6_sms_geo_fraud`, which makes ~10 endpoints 500 (sms-logs,
 * sms logging INSERTs, QR scan paths, fraud/gates endpoints, the fraud
 * section of the notification feed). Instead of requiring a manual
 * `psql -f migrations/0007…` step, the server applies the migration
 * itself, at most once per process, before serving requests.
 *
 * The SQL is inlined verbatim (no fs reads) so it bundles cleanly into
 * the Vercel serverless output. It is fully idempotent (CREATE TABLE /
 * ADD COLUMN / CREATE INDEX … IF NOT EXISTS), so racing processes are
 * safe. It contains no `$n` placeholders, so `pool.query(sql)` runs it
 * through pg's simple query protocol (multi-statement, one round-trip).
 */

const MIGRATION_NAME = "0007_phase6_sms_geo_fraud";

const PHASE6_MIGRATION_SQL = `-- ============================================================================
-- 0007_phase6_sms_geo_fraud.sql
-- AttendX Phase 6 — SMS delivery lifecycle, geofenced gates, fraud engine
-- Date: 2026-11-09
--
-- Covers the uncommitted Phase 6 schema changes (see lib/db/src/schema/*.ts):
--   1. gates          — NEW table: physical school gate registry + geofence
--   2. fraud_signals  — NEW table: inline proxy-fraud engine output
--   3. sms_logs       — 4 new columns (provider_sid, error_code, channel,
--                       status_updated_at), status DEFAULT 'sent' → 'queued',
--                       2 new indexes
--   4. qr_scan_logs   — 8 new columns (gate_id, scanned_at, latitude,
--                       longitude, accuracy, nonce, fraud_score,
--                       fraud_signals), 3 new indexes (incl. unique nonce)
--
-- Fully idempotent: CREATE TABLE/INDEX IF NOT EXISTS + ADD COLUMN IF NOT
-- EXISTS + SET DEFAULT are all safe to re-run.
--
-- Apply with: psql $DATABASE_URL -f lib/db/migrations/0007_phase6_sms_geo_fraud.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. gates (NEW TABLE) — lib/db/src/schema/gates.ts
--    Physical school gates for Phase 6 geofenced QR scanning.
--    NOTE: schema \`updatedAt\` uses Drizzle \`$onUpdate\`; that is application
--    logic, not a DB trigger. DEFAULT now() only covers INSERT — application
--    code MUST set updated_at on every UPDATE.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gates (
  gate_id           TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  -- geofence center (WGS-84 decimal degrees); NULL = geofence disabled
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  -- allowed radius in meters from the center (scan GPS accuracy adds buffer)
  geofence_radius_m INTEGER NOT NULL DEFAULT 150,
  -- terminals known to belong to this gate, e.g. {"door-1","door-2"}
  terminal_ids      TEXT[] NOT NULL DEFAULT '{}'::text[],
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Mirror of schema index("gates_gate_idx").on(t.gateId)
-- (redundant with the PK, but kept to match the Drizzle schema exactly).
CREATE INDEX IF NOT EXISTS gates_gate_idx ON gates (gate_id);

-- ----------------------------------------------------------------------------
-- 2. fraud_signals (NEW TABLE) — lib/db/src/schema/fraud_signals.ts
--    Output of the inline proxy-fraud engine. NOTE: related_scan_ids is
--    INTEGER[] (a concurrent task is changing it from TEXT[]; final type is
--    INTEGER[]).
--    The (kind, dedupe_key) unique constraint lives INSIDE the CREATE TABLE
--    so it is created atomically with IF NOT EXISTS. Drizzle would generate
--    this as uniqueIndex("fraud_signals_dedupe_uidx"); here it is a named
--    table constraint per the migration spec.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fraud_signals (
  id                  SERIAL PRIMARY KEY,
  kind                TEXT NOT NULL,
  severity            TEXT NOT NULL DEFAULT 'medium',
  score               INTEGER NOT NULL DEFAULT 50,
  student_id          INTEGER,
  terminal_id         TEXT,
  gate_id             TEXT,
  primary_scan_id     INTEGER,
  related_scan_ids    INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  detail              TEXT,
  -- structured evidence (JSON string): speedKmh, distanceKm, count, windowSec…
  evidence            TEXT,
  status              TEXT NOT NULL DEFAULT 'open',
  -- kind + subject + 30-min window — uniquely constrained to suppress dupes
  dedupe_key          TEXT,
  resolved_by_admin_id INTEGER,
  resolved_at         TIMESTAMP WITH TIME ZONE,
  resolve_note        TEXT,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT fraud_signals_kind_dedupe_key_unique UNIQUE (kind, dedupe_key)
);

-- Mirror of schema index("fraud_signals_status_idx").on(t.status, t.createdAt)
CREATE INDEX IF NOT EXISTS fraud_signals_status_idx ON fraud_signals (status, created_at);

-- ----------------------------------------------------------------------------
-- 3. sms_logs (ALTER) — lib/db/src/schema/sms_logs.ts
--    Phase 6 delivery lifecycle: queued → sent → delivered | undelivered |
--    failed | simulated. New columns support the Twilio status webhook and
--    reconciliation sweep.
-- ----------------------------------------------------------------------------
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS provider_sid      TEXT;
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS error_code        TEXT;
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS channel           TEXT;
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP WITH TIME ZONE;

-- status default changed 'sent' → 'queued' in the schema; safe to run repeatedly
ALTER TABLE sms_logs ALTER COLUMN status SET DEFAULT 'queued';

-- Mirror of schema index("sms_logs_provider_sid_idx").on(t.providerSid)
CREATE INDEX IF NOT EXISTS sms_logs_provider_sid_idx ON sms_logs (provider_sid);
-- Mirror of schema index("sms_logs_status_sent_idx").on(t.status, t.sentAt)
CREATE INDEX IF NOT EXISTS sms_logs_status_sent_idx  ON sms_logs (status, sent_at);

-- ----------------------------------------------------------------------------
-- 4. qr_scan_logs (ALTER) — lib/db/src/schema/qr_scan_logs.ts
--    Phase 6 offline-kiosk + geofence + fraud columns. Existing rows keep
--    NULL for all new columns (all nullable except fraud_signals, which gets
--    a NOT NULL DEFAULT — Postgres 11+ fast default, no table rewrite).
-- ----------------------------------------------------------------------------
ALTER TABLE qr_scan_logs ADD COLUMN IF NOT EXISTS gate_id       TEXT;
ALTER TABLE qr_scan_logs ADD COLUMN IF NOT EXISTS scanned_at    TIMESTAMP WITH TIME ZONE;
ALTER TABLE qr_scan_logs ADD COLUMN IF NOT EXISTS latitude      REAL;
ALTER TABLE qr_scan_logs ADD COLUMN IF NOT EXISTS longitude     REAL;
ALTER TABLE qr_scan_logs ADD COLUMN IF NOT EXISTS accuracy      REAL;
ALTER TABLE qr_scan_logs ADD COLUMN IF NOT EXISTS nonce         TEXT;
ALTER TABLE qr_scan_logs ADD COLUMN IF NOT EXISTS fraud_score   INTEGER;
ALTER TABLE qr_scan_logs ADD COLUMN IF NOT EXISTS fraud_signals JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Mirror of schema uniqueIndex("qr_scan_logs_nonce_uidx").on(t.nonce).
-- Safe on legacy data: nonce is a new column (all existing rows NULL, and
-- Postgres unique indexes treat NULLs as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS qr_scan_logs_nonce_uidx ON qr_scan_logs (nonce);
-- Mirror of schema index("qr_scan_logs_student_time_idx").on(t.studentId, t.createdAt)
CREATE INDEX IF NOT EXISTS qr_scan_logs_student_time_idx ON qr_scan_logs (student_id, created_at);
-- Mirror of schema index("qr_scan_logs_terminal_time_idx").on(t.terminalId, t.createdAt)
CREATE INDEX IF NOT EXISTS qr_scan_logs_terminal_time_idx ON qr_scan_logs (terminal_id, created_at);
`;

export interface EnsureSchemaResult {
  /** true when the migration was applied by this call, false when already present / skipped */
  applied: boolean;
  durationMs: number;
}

// Memoized at module level so the migration runs at most once per process
// (per serverless instance). Reset on failure so a transient DB hiccup
// doesn't permanently wedge the process in degraded mode.
let ensureSchemaPromise: Promise<EnsureSchemaResult> | null = null;

async function runEnsureSchema(): Promise<EnsureSchemaResult> {
  const startedAt = Date.now();

  if (process.env.DISABLE_SCHEMA_BOOTSTRAP === "1") {
    console.log("[schema-bootstrap] disabled via DISABLE_SCHEMA_BOOTSTRAP=1 — skipping");
    return { applied: false, durationMs: 0 };
  }

  console.log(`[schema-bootstrap] applying migration ${MIGRATION_NAME}...`);

  // (i) migration ledger (idempotent)
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );

  // (ii) already applied?
  const existing = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations WHERE name = $1",
    [MIGRATION_NAME],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    console.log("[schema-bootstrap] schema verified (already applied)");
    return { applied: false, durationMs: Date.now() - startedAt };
  }

  try {
    // (iii) apply the Phase 6 migration — no $n placeholders, so the simple
    // query protocol executes every statement in one round-trip.
    await pool.query(PHASE6_MIGRATION_SQL);

    // (iv) record it so subsequent boots/instances skip the work
    await pool.query(
      "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
      [MIGRATION_NAME],
    );
  } catch (err) {
    // Self-healing must never take the whole app down: log loudly and let
    // the caller decide (middleware → next(), boot → keep serving).
    console.error(`[schema-bootstrap] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  console.log(`[schema-bootstrap] migration ${MIGRATION_NAME} applied in ${durationMs}ms`);
  return { applied: true, durationMs };
}

export function ensureSchema(): Promise<EnsureSchemaResult> {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = runEnsureSchema().catch((err) => {
      ensureSchemaPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return ensureSchemaPromise;
}

/**
 * Express middleware that guarantees the schema before any request reaches
 * the API. Memoization makes this a no-op after the first call, so Vercel
 * serverless invocations self-heal too. Never blocks the request pipeline:
 * on failure it logs and continues (degraded), matching boot behavior.
 */
export function ensureSchemaMiddleware(): RequestHandler {
  return (_req, _res, next) => {
    void ensureSchema()
      .catch((err) => {
        console.error(
          "[schema-bootstrap] request continuing without verified schema (degraded)",
          err instanceof Error ? err.message : err,
        );
      })
      .then(() => next());
  };
}
