import { Router } from "express";
import { db, attendanceLogsTable, studentsTable, classroomsTable, auditLogsTable } from "@workspace/db";
import { and, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { enqueueAttendanceSms } from "../lib/jobs";
import { writeAudit } from "../lib/audit";
import {
  ListAttendanceQueryParams,
  CreateAttendanceBody,
  UpdateAttendanceParams,
  UpdateAttendanceBody,
  GetTodayAttendanceQueryParams,
} from "@workspace/api-zod";
import { publishEvent } from "../lib/events";
import { requireAuth, requireStaff, requireAdminLevel } from "../lib/auth";

const router = Router();

router.get("/attendance/records/clear-preview", requireAdminLevel, async (req, res): Promise<void> => {
  const source = req.query.source;
  if (source !== "manual" && source !== "automated") {
    res.status(400).json({ error: "source must be manual or automated" });
    return;
  }
  const condition = source === "manual"
    ? eq(attendanceLogsTable.source, "manual")
    : inArray(attendanceLogsTable.source, ["webcam", "gate-camera"]);
  const [result] = await db.select({ total: count() }).from(attendanceLogsTable).where(condition);
  res.json({ source, count: Number(result.total) });
});

router.delete("/attendance/records", requireAdminLevel, async (req, res): Promise<void> => {
  const source = req.body?.source;
  const expectedCount = Number(req.body?.expectedCount);
  if ((source !== "manual" && source !== "automated") || !Number.isInteger(expectedCount) || expectedCount < 0) {
    res.status(400).json({ error: "source and a non-negative expectedCount are required" });
    return;
  }
  const condition = source === "manual"
    ? eq(attendanceLogsTable.source, "manual")
    : inArray(attendanceLogsTable.source, ["webcam", "gate-camera"]);
  const actor = (req as typeof req & { admin?: { adminId?: number } }).admin;

  try {
    const deletedCount = await db.transaction(async (tx) => {
      const [current] = await tx.select({ total: count() }).from(attendanceLogsTable).where(condition);
      if (Number(current.total) !== expectedCount) throw new Error("ATTENDANCE_CLEAR_COUNT_CHANGED");
      const removed = await tx.delete(attendanceLogsTable).where(condition).returning({ id: attendanceLogsTable.id });
      await tx.insert(auditLogsTable).values({
        actorAdminId: actor?.adminId ?? null,
        action: "attendance.records.cleared",
        targetType: "attendance",
        targetId: source,
        payload: { source, deletedCount: removed.length },
      });
      return removed.length;
    });
    res.json({ source, deletedCount });
  } catch (error) {
    if (error instanceof Error && error.message === "ATTENDANCE_CLEAR_COUNT_CHANGED") {
      const [current] = await db.select({ total: count() }).from(attendanceLogsTable).where(condition);
      res.status(409).json({ error: "Attendance records changed after the preview", currentCount: Number(current.total) });
      return;
    }
    throw error;
  }
});

function formatLog(r: {
  id: number;
  studentId: number;
  studentName: string | null;
  classroomId: number | null;
  classroomName: string | null;
  status: string;
  method: string;
  source: string;
  confidence: number | null;
  markedAt: Date;
  notes: string | null;
}) {
  return {
    id: r.id,
    studentId: r.studentId,
    studentName: r.studentName ?? "Unknown student",
    classroomId: r.classroomId ?? null,
    classroomName: r.classroomName ?? null,
    status: r.status,
    method: r.method,
    source: r.source,
    confidence: r.confidence,
    markedAt: r.markedAt.toISOString(),
    notes: r.notes ?? null,
  };
}

async function getAttendanceRows(params: {
  classroomId?: number | null;
  studentId?: number | null;
  date?: string | null;
  status?: string | null;
}) {
  const conditions: ReturnType<typeof eq>[] = [];

  if (params.classroomId) {
    conditions.push(eq(attendanceLogsTable.classroomId, params.classroomId));
  }
  if (params.studentId) {
    conditions.push(eq(attendanceLogsTable.studentId, params.studentId));
  }
  if (params.status) {
    conditions.push(eq(attendanceLogsTable.status, params.status));
  }
  if (params.date) {
    const start = new Date(params.date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(params.date);
    end.setHours(23, 59, 59, 999);
    conditions.push(gte(attendanceLogsTable.markedAt, start));
    conditions.push(lte(attendanceLogsTable.markedAt, end));
  }

  return db
    .select({
      id: attendanceLogsTable.id,
      studentId: attendanceLogsTable.studentId,
      studentName: studentsTable.name,
      classroomId: attendanceLogsTable.classroomId,
      classroomName: classroomsTable.name,
      status: attendanceLogsTable.status,
      method: attendanceLogsTable.method,
      source: attendanceLogsTable.source,
      confidence: attendanceLogsTable.confidence,
      markedAt: attendanceLogsTable.markedAt,
      notes: attendanceLogsTable.notes,
    })
    .from(attendanceLogsTable)
    .leftJoin(studentsTable, eq(attendanceLogsTable.studentId, studentsTable.id))
    .leftJoin(classroomsTable, eq(attendanceLogsTable.classroomId, classroomsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${attendanceLogsTable.markedAt} DESC`);
}

router.get("/attendance", requireAuth, async (req, res): Promise<void> => {
  const params = ListAttendanceQueryParams.safeParse(req.query);
  const rows = await getAttendanceRows(params.success ? params.data : {});
  res.json(rows.map(formatLog));
});

router.get("/attendance/today", requireAuth, async (req, res): Promise<void> => {
  const params = GetTodayAttendanceQueryParams.safeParse(req.query);
  const today = new Date().toISOString().split("T")[0];
  const rows = await getAttendanceRows({
    date: today,
    classroomId: params.success ? params.data.classroomId : null,
  });
  res.json(rows.map(formatLog));
});

router.post("/attendance", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateAttendanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, parsed.data.studentId));
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  const [log] = await db.insert(attendanceLogsTable).values({
    ...parsed.data,
    source: "manual",
    confidence: null,
  }).returning();
  publishEvent("attendance.created", { studentId: log.studentId, studentName: student.name, status: log.status, method: "manual", source: "manual", markedAt: log.markedAt.toISOString() });

  await enqueueAttendanceSms(student.id, log.status, log.markedAt);
  const actor = (req as typeof req & { admin?: { adminId?: number } }).admin;
  await writeAudit({
    actorAdminId: actor?.adminId,
    action: "attendance.manual.created",
    targetType: "attendance",
    targetId: log.id,
    payload: { studentId: student.id, status: log.status, source: "manual" },
  });

  const rows = await getAttendanceRows({ studentId: log.studentId });
  const r = rows[0];
  res.status(201).json(formatLog(r));
});

router.patch("/attendance/:id", requireStaff, async (req, res): Promise<void> => {
  const params = UpdateAttendanceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateAttendanceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [log] = await db
    .update(attendanceLogsTable)
    .set(body.data)
    .where(eq(attendanceLogsTable.id, params.data.id))
    .returning();
  if (!log) {
    res.status(404).json({ error: "Attendance record not found" });
    return;
  }
  const rows = await getAttendanceRows({ studentId: log.studentId });
  const r = rows[0];
  res.json(formatLog(r));
});

export default router;
