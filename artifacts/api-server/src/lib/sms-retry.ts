import { db, smsLogsTable, type SmsLog } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { sendSms, SmsDeliveryError } from "./sms";
import { logger } from "./logger";

/**
 * SMS retry engine — re-sends failed log rows through the ACTIVE provider.
 *
 * Design (honest-history model):
 *  - A retry NEVER rewrites the original failed row. It creates a NEW
 *    sms_logs row with retry_of_id pointing at the original, so the failure
 *    history stays intact and the new attempt runs its own honest lifecycle
 *    (queued → sent/delivered/failed via the webhook + reconcile sweep).
 *  - "Retry failed" (bulk) skips rows that already have a newer attempt
 *    (NOT EXISTS on retry_of_id) so parents never get duplicate spam when
 *    the button is hit twice.
 *  - An in-process in-flight guard makes double-clicks a no-op.
 */

/** Only these statuses may be retried — in-flight or finished messages must not. */
export const RETRYABLE_STATUSES = ["failed", "undelivered"] as const;

/** Hard cap for one bulk retry call — keeps the endpoint well inside
 *  serverless timeouts (each send is a ≤12s gateway call, concurrency 8). */
export const RETRY_ALL_MAX = 40;

export interface SmsRetryOutcome {
  /** id of the NEW attempt row (null when no row could be written) */
  retryLogId: number | null;
  /** status the new attempt row was created with (queued/sent/failed/simulated) */
  status: string | null;
  /** human-readable failure, when the attempt did not reach the gateway */
  error: string | null;
}

export interface SmsRetryAllResult {
  /** rows a retry was attempted for */
  attempted: number;
  /** attempts the gateway accepted (row created as queued/sent) */
  accepted: number;
  /** attempts that failed before the gateway accepted (row created as failed) */
  failed: number;
  /** rows skipped (concurrent retry in flight) */
  skipped: number;
  results: Array<{ originalLogId: number } & SmsRetryOutcome>;
}

// ── in-process double-click guard ──────────────────────────────────────
const inFlight = new Map<number, number>();
const IN_FLIGHT_TTL_MS = 30_000;

function notRetryableError(row: SmsLog): SmsDeliveryError {
  return new SmsDeliveryError(
    `Log #${row.id} is "${row.status}" — only failed/undelivered messages can be retried.`,
    { provider: "retry", code: "retry-not-retryable" },
  );
}

/** Core attempt: re-send a fetched row. Does NOT re-check status/guards. */
async function attemptRetry(row: SmsLog): Promise<SmsRetryOutcome> {
  try {
    const result = await sendSms({
      studentId: row.studentId,
      parentPhone: row.parentPhone,
      message: row.message,
      retryOfId: row.id,
    });
    logger.info(
      { originalLogId: row.id, retryLogId: result.logId, status: result.initialStatus, provider: result.provider },
      "SMS retry accepted by gateway",
    );
    return { retryLogId: result.logId, status: result.initialStatus, error: null };
  } catch (err) {
    if (err instanceof SmsDeliveryError) {
      logger.warn({ originalLogId: row.id, retryLogId: err.logId, err: err.message }, "SMS retry failed");
      // A failed attempt row was persisted (err.logId) — surface it so the
      // UI can jump to it; status "failed" when the row exists.
      return { retryLogId: err.logId ?? null, status: err.logId != null ? "failed" : null, error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ originalLogId: row.id, err: message }, "SMS retry crashed");
    return { retryLogId: null, status: null, error: message };
  }
}

/**
 * Retry ONE sms_logs row (double-click guarded, status-validated).
 * Throws SmsDeliveryError with codes:
 *   retry-not-found       — no such row
 *   retry-not-retryable   — row is queued/sent/delivered/canceled/simulated
 *   retry-in-flight       — a retry for this row started <30s ago
 */
export async function retrySmsLogRow(logId: number): Promise<SmsRetryOutcome> {
  const now = Date.now();
  const startedAt = inFlight.get(logId);
  if (startedAt && now - startedAt < IN_FLIGHT_TTL_MS) {
    throw new SmsDeliveryError("A retry for this message is already in flight — give it a few seconds.", {
      provider: "retry",
      code: "retry-in-flight",
    });
  }
  inFlight.set(logId, now);
  try {
    const [row] = await db.select().from(smsLogsTable).where(eq(smsLogsTable.id, logId)).limit(1);
    if (!row) {
      throw new SmsDeliveryError(`SMS log #${logId} not found.`, { provider: "retry", code: "retry-not-found" });
    }
    if (!(RETRYABLE_STATUSES as readonly string[]).includes(row.status)) {
      throw notRetryableError(row);
    }
    return await attemptRetry(row);
  } finally {
    inFlight.delete(logId);
  }
}

/**
 * Retry every failed/undelivered row that has NO newer retry attempt yet,
 * newest failures first, bounded concurrency. Rows the admin already
 * retried (their message may already be on a parent's phone) are skipped
 * automatically by the retry_of_id lineage.
 */
export async function retryFailedSmsRows(max = RETRY_ALL_MAX): Promise<SmsRetryAllResult> {
  const cap = Math.max(1, Math.min(max, RETRY_ALL_MAX));
  const rows = await db
    .select()
    .from(smsLogsTable)
    .where(and(
      inArray(smsLogsTable.status, [...RETRYABLE_STATUSES]),
      // Skip rows that already have a newer retry attempt — no duplicates.
      sql`NOT EXISTS (SELECT 1 FROM sms_logs r2 WHERE r2.retry_of_id = ${smsLogsTable.id})`,
    ))
    .orderBy(desc(smsLogsTable.sentAt))
    .limit(cap);

  const result: SmsRetryAllResult = { attempted: 0, accepted: 0, failed: 0, skipped: 0, results: [] };
  if (!rows.length) return result;

  // Bounded concurrency: waves of 8 gateway calls.
  const CONCURRENCY = 8;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const wave = rows.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(wave.map(async (row) => {
      const now = Date.now();
      const startedAt = inFlight.get(row.id);
      if (startedAt && now - startedAt < IN_FLIGHT_TTL_MS) return null; // skip, already retrying
      inFlight.set(row.id, now);
      try {
        return { originalLogId: row.id, ...(await attemptRetry(row)) };
      } finally {
        inFlight.delete(row.id);
      }
    }));
    for (const outcome of outcomes) {
      if (!outcome) {
        result.skipped += 1;
        continue;
      }
      result.attempted += 1;
      if (outcome.error == null && outcome.status != null && outcome.status !== "failed") {
        result.accepted += 1;
      } else {
        result.failed += 1;
      }
      result.results.push(outcome);
    }
  }
  logger.info(
    { attempted: result.attempted, accepted: result.accepted, failed: result.failed, skipped: result.skipped },
    "Bulk SMS retry finished",
  );
  return result;
}

/** How many failed/undelivered rows are waiting for a first retry (UI badge). */
export async function retryableFailedCount(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(smsLogsTable)
    .where(and(
      inArray(smsLogsTable.status, [...RETRYABLE_STATUSES]),
      sql`NOT EXISTS (SELECT 1 FROM sms_logs r2 WHERE r2.retry_of_id = ${smsLogsTable.id})`,
    ));
  return Number(row?.total ?? 0);
}
