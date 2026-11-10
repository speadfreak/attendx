import { Router } from "express";
import { db, smsLogsTable, studentsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { ListSmsLogsQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { describeSmsProviderCode, SmsDeliveryError } from "../lib/sms";
import { pendingDeliveryCount } from "../lib/sms-reconcile";
import { reconcileForResponse } from "../lib/reconcile-middleware";
import { retrySmsLogRow, retryFailedSmsRows, RETRY_ALL_MAX } from "../lib/sms-retry";

const router = Router();

router.get("/sms-logs", requireAuth, async (req, res): Promise<void> => {
  // Phase 6.2 fresh-status guarantee: when the admin OPENS this page we pull
  // the real carrier verdicts inline (throttled to 30s, hard-budgeted to 4s
  // so Twilio latency can never hang the response). Rows younger than ~8s
  // are checked too — this is what flips "Queued" to its honest verdict the
  // moment someone actually looks at the log.
  try {
    await reconcileForResponse();
  } catch {
    // Never let a reconcile hiccup break the page.
  }

  const params = ListSmsLogsQueryParams.safeParse(req.query);
  const { status, studentId } = params.success ? params.data : {};

  const conditions = [];
  if (status) conditions.push(eq(smsLogsTable.status, status));
  if (studentId) conditions.push(eq(smsLogsTable.studentId, studentId));

  const rows = await db
    .select({
      id: smsLogsTable.id,
      studentId: smsLogsTable.studentId,
      studentName: studentsTable.name,
      parentPhone: smsLogsTable.parentPhone,
      message: smsLogsTable.message,
      status: smsLogsTable.status,
      provider: smsLogsTable.provider,
      sentAt: smsLogsTable.sentAt,
      errorMessage: smsLogsTable.errorMessage,
      // Phase 6: honest delivery lifecycle — additive fields
      providerSid: smsLogsTable.providerSid,
      errorCode: smsLogsTable.errorCode,
      channel: smsLogsTable.channel,
      statusUpdatedAt: smsLogsTable.statusUpdatedAt,
      // Retry lineage — hasRetry flags rows the admin already re-sent.
      retryOfId: smsLogsTable.retryOfId,
      hasRetry: sql<boolean>`EXISTS (SELECT 1 FROM sms_logs r2 WHERE r2.retry_of_id = ${smsLogsTable.id})`,
    })
    .from(smsLogsTable)
    .leftJoin(studentsTable, eq(smsLogsTable.studentId, studentsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(smsLogsTable.sentAt);

  res.json(rows.map((r) => ({
    id: r.id,
    studentId: r.studentId,
    studentName: r.studentName ?? "Unknown",
    parentPhone: r.parentPhone,
    message: r.message,
    status: r.status,
    provider: r.provider,
    sentAt: r.sentAt.toISOString(),
    errorMessage: r.errorMessage ?? null,
    // Phase 6: honest delivery lifecycle — additive fields
    channel: r.channel ?? null,
    errorCode: r.errorCode ?? null,
    providerSid: r.providerSid ?? null,
    statusUpdatedAt: r.statusUpdatedAt ? r.statusUpdatedAt.toISOString() : null,
    // Retry lineage
    retryOfId: r.retryOfId ?? null,
    hasRetry: Boolean(r.hasRetry),
    errorHint: describeSmsProviderCode(r.errorCode),
  })));
});

/**
 * Retry ONE failed/undelivered SMS: re-sends the exact message through the
 * active provider and returns the outcome. The original failed row is never
 * rewritten — the retry is a NEW log row with retry_of_id lineage, and the
 * page refreshes to show both.
 */
router.post("/sms-logs/:id/retry", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid SMS log id." });
    return;
  }
  try {
    const outcome = await retrySmsLogRow(id);
    res.json({ originalLogId: id, ...outcome });
  } catch (err) {
    if (err instanceof SmsDeliveryError) {
      const status = err.code === "retry-not-found" ? 404 : err.code === "retry-in-flight" ? 409 : err.code === "retry-not-retryable" ? 409 : 502;
      res.status(status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * Retry ALL failed/undelivered SMS logs that don't have a newer retry yet
 * (newest first, capped, concurrency-limited). Rows already re-sent once
 * are skipped automatically — hit it again after fixing a real cause (e.g.
 * the gateway phone back online) and only fresh failures are re-attempted.
 */
router.post("/sms-logs/retry-failed", requireAuth, async (req, res): Promise<void> => {
  const limitRaw = typeof (req.body as { limit?: unknown } | undefined)?.limit === "number"
    ? (req.body as { limit?: number }).limit
    : undefined;
  const limit = limitRaw != null ? Math.max(1, Math.min(Math.floor(limitRaw), RETRY_ALL_MAX)) : RETRY_ALL_MAX;
  const summary = await retryFailedSmsRows(limit);
  res.json(summary);
});

/**
 * Phase 6: lightweight delivery stats for the SMS Health card — sends still
 * awaiting a carrier verdict plus a per-status breakdown. Cheap (two local
 * queries, no Twilio calls); same auth as GET /sms-logs.
 */
router.get("/sms-logs/health", requireAuth, async (_req, res): Promise<void> => {
  // Same fresh-status guarantee as GET /sms-logs (shared throttle + budget).
  try {
    await reconcileForResponse();
  } catch {
    // Never let a reconcile hiccup break the page.
  }

  const statusRows = await db
    .select({ status: smsLogsTable.status, total: sql<number>`count(*)` })
    .from(smsLogsTable)
    .groupBy(smsLogsTable.status);
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.status] = Number(row.total);
  res.json({ pendingDelivery: await pendingDeliveryCount(), byStatus });
});

export default router;
