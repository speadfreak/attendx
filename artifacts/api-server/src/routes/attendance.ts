import { Router } from "express";
import { db, attendanceLogsTable, studentsTable, classroomsTable } from "@workspace/db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import {
  ListAttendanceQueryParams,
  CreateAttendanceBody,
  UpdateAttendanceParams,
  UpdateAttendanceBody,
  GetTodayAttendanceQueryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { sendSms, buildPresentMessage, buildLateMessage } from "../lib/sms";

const router = Router();

function formatLog(r: {
  id: number;
  studentId: number;
  studentName: string;
  classroomId: number | null;
  classroomName: string | null;
  status: string;
  method: string;
  markedAt: Date;
  notes: string | null;
}) {
  return {
    id: r.id,
    studentId: r.studentId,
    studentName: r.studentName,
    classroomId: r.classroomId ?? null,
    classroomName: r.classroomName ?? null,
    status: r.status,
    method: r.method,
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

router.post("/attendance", requireAuth, async (req, res): Promise<void> => {
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

  const [log] = await db.insert(attendanceLogsTable).values(parsed.data).returning();

  const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  let message = "";
  if (log.status === "present") {
    message = buildPresentMessage(student.name, now);
  } else if (log.status === "late") {
    message = buildLateMessage(student.name, now);
  }

  if (message) {
    sendSms({ studentId: student.id, parentPhone: student.parentPhone, message }).catch(() => {});
  }

  const rows = await getAttendanceRows({ studentId: log.studentId });
  const r = rows[0];
  res.status(201).json(formatLog(r));
});

router.patch("/attendance/:id", requireAuth, async (req, res): Promise<void> => {
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
