import { Router } from "express";
import { db, smsLogsTable, studentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { ListSmsLogsQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";

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
  })));
});

export default router;
