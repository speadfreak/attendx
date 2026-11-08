import { Router } from "express";
import { db, attendanceLogsTable, studentsTable, classroomsTable, faceEncodingsTable, matchReviewsTable } from "@workspace/db";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth";

/**
 * Reports & analytics endpoints powering the heatmap sub-page, PDF export
 * summaries and drill-downs.
 */
const router = Router();

function dayBounds(dateStr: string): { start: Date; end: Date } {
  const start = new Date(dateStr);
  start.setHours(0, 0, 0, 0);
  const end = new Date(dateStr);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// ── Attendance confidence heatmap: per-day × per-student matrix ─
router.get("/reports/heatmap", requireAuth, async (req, res): Promise<void> => {
  const classroomId = req.query.classroomId ? Number(req.query.classroomId) : null;
  const days = Math.min(120, Math.max(14, Number(req.query.days ?? 42)));

  const start = new Date();
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const conditions = [gte(attendanceLogsTable.markedAt, start), lte(attendanceLogsTable.markedAt, end)];
  if (classroomId) conditions.push(eq(attendanceLogsTable.classroomId, classroomId));

  const logs = await db
    .select({
      studentId: attendanceLogsTable.studentId,
      studentName: studentsTable.name,
      classroomId: attendanceLogsTable.classroomId,
      classroomName: classroomsTable.name,
      status: attendanceLogsTable.status,
      method: attendanceLogsTable.method,
      source: attendanceLogsTable.source,
      confidence: attendanceLogsTable.confidence,
      markedAt: attendanceLogsTable.markedAt,
    })
    .from(attendanceLogsTable)
    .leftJoin(studentsTable, eq(attendanceLogsTable.studentId, studentsTable.id))
    .leftJoin(classroomsTable, eq(attendanceLogsTable.classroomId, classroomsTable.id))
    .where(and(...conditions))
    .orderBy(asc(attendanceLogsTable.markedAt));

  // also include students with zero records for coverage completeness
  const studentConditions = classroomId ? [eq(studentsTable.classroomId, classroomId)] : [];
  const allStudents = await db
    .select({ id: studentsTable.id, name: studentsTable.name, classroomId: studentsTable.classroomId })
    .from(studentsTable)
    .where(studentConditions.length ? and(...studentConditions) : undefined)
    .orderBy(asc(studentsTable.name));

  const days_grid: string[] = [];
  for (let i = days; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days_grid.push(d.toISOString().slice(0, 10));
  }

  // map: studentId -> { day -> {status, confidence} }
  const byStudent = new Map<number, { name: string; classroomId: number | null; days: Record<string, { status: string; confidence: number | null; method: string }> }>();
  for (const s of allStudents) {
    byStudent.set(s.id, { name: s.name, classroomId: s.classroomId, days: {} });
  }
  const confidenceTally = new Map<number, { sum: number; n: number }>();
  for (const log of logs) {
    const entry = byStudent.get(log.studentId);
    if (!entry) continue;
    const day = log.markedAt.toISOString().slice(0, 10);
    if (!entry.days[day]) {
      entry.days[day] = { status: log.status, confidence: log.confidence, method: log.method };
    }
    if (log.confidence != null) {
      const t = confidenceTally.get(log.studentId) ?? { sum: 0, n: 0 };
      t.sum += log.confidence;
      t.n += 1;
      confidenceTally.set(log.studentId, t);
    }
  }

  const rows = Array.from(byStudent.entries()).map(([studentId, entry]) => {
    const conf = confidenceTally.get(studentId);
    const presentCount = Object.values(entry.days).filter((d) => d.status === "present").length;
    const lateCount = Object.values(entry.days).filter((d) => d.status === "late").length;
    const absentCount = Object.values(entry.days).filter((d) => d.status === "absent").length;
    const marked = presentCount + lateCount;
    return {
      studentId,
      studentName: entry.name,
      classroomId: entry.classroomId,
      presentCount,
      lateCount,
      absentCount,
      markedDays: presentCount + lateCount + absentCount,
      attendanceRate: marked > 0 ? presentCount / marked : null,
      avgConfidence: conf && conf.n > 0 ? conf.sum / conf.n : null,
      days: entry.days,
    };
  });

  res.json({ days: days_grid, rows });
});

// ── Report summary (PDF export data): school-wide + per-classroom ─
router.get("/reports/summary", requireAuth, async (req, res): Promise<void> => {
  const from = String(req.query.from ?? new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const to = String(req.query.to ?? new Date().toISOString().slice(0, 10));
  const { start, end } = dayBounds(from);
  const endBound = dayBounds(to).end;

  const conditions = [gte(attendanceLogsTable.markedAt, start), lte(attendanceLogsTable.markedAt, endBound)];
  const logs = await db
    .select({
      classroomId: attendanceLogsTable.classroomId,
      classroomName: classroomsTable.name,
      status: attendanceLogsTable.status,
      method: attendanceLogsTable.method,
      studentId: attendanceLogsTable.studentId,
      markedAt: attendanceLogsTable.markedAt,
    })
    .from(attendanceLogsTable)
    .leftJoin(classroomsTable, eq(attendanceLogsTable.classroomId, classroomsTable.id))
    .where(and(...conditions));

  const perClassroom = new Map<number | null, { name: string; present: number; late: number; absent: number; methods: Record<string, number> }>();
  const methodsTotal: Record<string, number> = {};
  let totals = { present: 0, late: 0, absent: 0 };
  const uniqueStudents = new Set<number>();

  for (const log of logs) {
    const key = log.classroomId ?? null;
    const bucket = perClassroom.get(key) ?? {
      name: log.classroomName ?? "Unassigned",
      present: 0, late: 0, absent: 0,
      methods: {} as Record<string, number>,
    };
    if (log.status === "present") { bucket.present++; totals.present++; }
    else if (log.status === "late") { bucket.late++; totals.late++; }
    else if (log.status === "absent") { bucket.absent++; totals.absent++; }
    bucket.methods[log.method] = (bucket.methods[log.method] ?? 0) + 1;
    methodsTotal[log.method] = (methodsTotal[log.method] ?? 0) + 1;
    perClassroom.set(key, bucket);
    uniqueStudents.add(log.studentId);
  }

  const [studentCount] = await db.select({ total: sql<number>`count(*)` }).from(studentsTable);

  const classroomRows = Array.from(perClassroom.entries()).map(([id, b]) => {
    const marked = b.present + b.late + b.absent;
    return {
      classroomId: id,
      classroomName: b.name,
      present: b.present,
      late: b.late,
      absent: b.absent,
      marked,
      rate: marked > 0 ? (b.present + b.late) / marked : 0,
      methods: b.methods,
    };
  }).sort((a, b) => a.classroomName.localeCompare(b.classroomName));

  res.json({
    from,
    to,
    generatedAt: new Date().toISOString(),
    totals: { ...totals, marked: totals.present + totals.late + totals.absent },
    methodBreakdown: methodsTotal,
    uniqueStudents: uniqueStudents.size,
    totalStudents: Number(studentCount.total),
    classrooms: classroomRows,
    daily: await (async () => {
      const byDay = new Map<string, { present: number; late: number; absent: number }>();
      for (const log of logs) {
        const day = log.markedAt.toISOString().slice(0, 10);
        const b = byDay.get(day) ?? { present: 0, late: 0, absent: 0 };
        if (log.status === "present") b.present++;
        else if (log.status === "late") b.late++;
        else if (log.status === "absent") b.absent++;
        byDay.set(day, b);
      }
      return Array.from(byDay.entries()).map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day));
    })(),
  });
});

export default router;
