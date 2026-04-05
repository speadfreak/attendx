import { Router } from "express";
import { db, studentsTable, classroomsTable, attendanceLogsTable, smsLogsTable } from "@workspace/db";
import { eq, count, sql, gte, lte, and } from "drizzle-orm";
import { requireAuth } from "../lib/auth";

const router = Router();

router.get("/dashboard/stats", requireAuth, async (_req, res): Promise<void> => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const [{ total: totalStudents }] = await db.select({ total: count() }).from(studentsTable);
  const [{ total: totalClassrooms }] = await db.select({ total: count() }).from(classroomsTable);
  const [{ total: presentToday }] = await db.select({ total: count() }).from(attendanceLogsTable)
    .where(and(eq(attendanceLogsTable.status, "present"), gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)));
  const [{ total: absentToday }] = await db.select({ total: count() }).from(attendanceLogsTable)
    .where(and(eq(attendanceLogsTable.status, "absent"), gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)));
  const [{ total: lateToday }] = await db.select({ total: count() }).from(attendanceLogsTable)
    .where(and(eq(attendanceLogsTable.status, "late"), gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)));
  const [{ total: smsSentToday }] = await db.select({ total: count() }).from(smsLogsTable)
    .where(and(gte(smsLogsTable.sentAt, todayStart), lte(smsLogsTable.sentAt, todayEnd)));

  const totalStudentsNum = Number(totalStudents);
  const presentNum = Number(presentToday);
  const attendanceRate = totalStudentsNum > 0 ? Math.round((presentNum / totalStudentsNum) * 100) : 0;

  res.json({
    totalStudents: totalStudentsNum,
    totalClassrooms: Number(totalClassrooms),
    presentToday: presentNum,
    absentToday: Number(absentToday),
    lateToday: Number(lateToday),
    attendanceRate,
    smsSentToday: Number(smsSentToday),
  });
});

router.get("/dashboard/recent-activity", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
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
    .orderBy(sql`${attendanceLogsTable.markedAt} DESC`)
    .limit(20);

  res.json(rows.map((r) => ({
    id: r.id,
    studentId: r.studentId,
    studentName: r.studentName ?? "Unknown",
    classroomId: r.classroomId ?? null,
    classroomName: r.classroomName ?? null,
    status: r.status,
    method: r.method,
    markedAt: r.markedAt.toISOString(),
    notes: r.notes ?? null,
  })));
});

router.get("/dashboard/attendance-trend", requireAuth, async (_req, res): Promise<void> => {
  const days = 7;
  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const start = new Date(d);
    start.setHours(0, 0, 0, 0);
    const end = new Date(d);
    end.setHours(23, 59, 59, 999);

    const [{ p }] = await db.select({ p: count() }).from(attendanceLogsTable)
      .where(and(eq(attendanceLogsTable.status, "present"), gte(attendanceLogsTable.markedAt, start), lte(attendanceLogsTable.markedAt, end)));
    const [{ a }] = await db.select({ a: count() }).from(attendanceLogsTable)
      .where(and(eq(attendanceLogsTable.status, "absent"), gte(attendanceLogsTable.markedAt, start), lte(attendanceLogsTable.markedAt, end)));
    const [{ l }] = await db.select({ l: count() }).from(attendanceLogsTable)
      .where(and(eq(attendanceLogsTable.status, "late"), gte(attendanceLogsTable.markedAt, start), lte(attendanceLogsTable.markedAt, end)));

    trend.push({
      date: start.toISOString().split("T")[0],
      present: Number(p),
      absent: Number(a),
      late: Number(l),
    });
  }
  res.json(trend);
});

router.get("/dashboard/classroom-summary", requireAuth, async (_req, res): Promise<void> => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const classrooms = await db
    .select({ id: classroomsTable.id, name: classroomsTable.name, studentCount: count(studentsTable.id) })
    .from(classroomsTable)
    .leftJoin(studentsTable, eq(classroomsTable.id, studentsTable.classroomId))
    .groupBy(classroomsTable.id);

  const summary = await Promise.all(classrooms.map(async (c) => {
    const [{ present }] = await db.select({ present: count() }).from(attendanceLogsTable)
      .where(and(
        eq(attendanceLogsTable.classroomId, c.id),
        eq(attendanceLogsTable.status, "present"),
        gte(attendanceLogsTable.markedAt, todayStart),
        lte(attendanceLogsTable.markedAt, todayEnd),
      ));
    const [{ absent }] = await db.select({ absent: count() }).from(attendanceLogsTable)
      .where(and(
        eq(attendanceLogsTable.classroomId, c.id),
        eq(attendanceLogsTable.status, "absent"),
        gte(attendanceLogsTable.markedAt, todayStart),
        lte(attendanceLogsTable.markedAt, todayEnd),
      ));
    const totalStudents = Number(c.studentCount);
    const presentCount = Number(present);
    const absentCount = Number(absent);
    const rate = totalStudents > 0 ? Math.round((presentCount / totalStudents) * 100) : 0;
    return {
      classroomId: c.id,
      classroomName: c.name,
      totalStudents,
      presentCount,
      absentCount,
      attendanceRate: rate,
    };
  }));

  res.json(summary);
});

export default router;
