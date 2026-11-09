import { Router } from "express";
import { db, smsLogsTable, studentsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { ListSmsLogsQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { describeSmsProviderCode } from "../lib/sms";
import { pendingDeliveryCount } from "../lib/sms-reconcile";

const router = Router();

router.get("/sms-logs", requireAuth, async (req, res): Promise<void> => {
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
    errorHint: describeSmsProviderCode(r.errorCode),
  })));
});

/**
 * Phase 6: lightweight delivery stats for the SMS Health card — sends still
 * awaiting a carrier verdict plus a per-status breakdown. Cheap (two local
 * queries, no Twilio calls); same auth as GET /sms-logs.
 */
router.get("/sms-logs/health", requireAuth, async (_req, res): Promise<void> => {
  const statusRows = await db
    .select({ status: smsLogsTable.status, total: sql<number>`count(*)` })
    .from(smsLogsTable)
    .groupBy(smsLogsTable.status);
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.status] = Number(row.total);
  res.json({ pendingDelivery: await pendingDeliveryCount(), byStatus });
});

export default router;
