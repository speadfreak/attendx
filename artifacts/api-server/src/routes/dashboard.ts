import { Router } from "express";
import { db, studentsTable, classroomsTable, attendanceLogsTable, smsLogsTable, jobsTable, gateDevicesTable, matchReviewsTable } from "@workspace/db";
import { eq, count, sql, gte, lte, and, desc } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { absenceRiskSummary } from "../lib/risk";
import { getArrivalRules, minutesSinceMidnight } from "../lib/attendance-rules";
import { runAbsentSweep } from "../lib/absent-sweep";
import { logger } from "../lib/logger";

/**
 * Opportunistic absent-sweep trigger — dashboard loads are the natural
 * "is anyone watching" signal, so a throttled fire-and-forget sweep runs
 * here too. All real guards (cutoff clock, once-per-day) live in the lib.
 */
let lastOpportunisticSweep = 0;
function maybeOpportunisticSweep(): void {
  const now = Date.now();
  if (now - lastOpportunisticSweep < 5 * 60_000) return;
  lastOpportunisticSweep = now;
  void runAbsentSweep({ respectOncePerDay: true }).catch((err) =>
    logger.warn({ err }, "opportunistic absent sweep failed"),
  );
}

const router = Router();

router.get("/dashboard/stats", requireAuth, async (_req, res): Promise<void> => {
  maybeOpportunisticSweep();
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

/**
 * CAMPUS COMMAND CENTER — one snapshot powering the whole dashboard:
 * school-tz daily stats, hourly arrival pulse, live occupancy, gate camera
 * node fleet health, pending reviews, SMS pipeline state.
 */
router.get("/dashboard/command-center", requireAuth, async (_req, res): Promise<void> => {
  maybeOpportunisticSweep();
  let rules = null;
  try {
    rules = await getArrivalRules();
  } catch {
    rules = null;
  }
  const timezone = rules?.timezone ?? "Africa/Addis_Ababa";
  const now = new Date();
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
  const [{ total: smsFailedToday }] = await db.select({ total: count() }).from(smsLogsTable)
    .where(and(eq(smsLogsTable.status, "failed"), gte(smsLogsTable.sentAt, todayStart), lte(smsLogsTable.sentAt, todayEnd)));
  const [{ total: smsQueued }] = await db.select({ total: count() }).from(jobsTable)
    .where(and(eq(jobsTable.type, "send_sms"), eq(jobsTable.status, "pending")));
  const [{ total: reviewsPending }] = await db.select({ total: count() }).from(matchReviewsTable)
    .where(eq(matchReviewsTable.status, "pending"));

  // hourly arrival pulse (present + late, school-tz buckets)
  const arrivalRows = await db
    .select({ status: attendanceLogsTable.status, markedAt: attendanceLogsTable.markedAt })
    .from(attendanceLogsTable)
    .where(and(gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd),
      sql`${attendanceLogsTable.status} IN ('present', 'late')`));
  const arrivals = Array.from({ length: 24 }, (_, h) => ({
    hour: `${String(h).padStart(2, "0")}:00`,
    present: 0,
    late: 0,
  }));
  for (const row of arrivalRows) {
    const minutes = minutesSinceMidnight(row.markedAt, timezone);
    const hour = Math.min(23, Math.max(0, Math.floor(minutes / 60)));
    if (row.status === "late") arrivals[hour].late += 1;
    else arrivals[hour].present += 1;
  }

  // gate camera node fleet
  const devices = await db.select().from(gateDevicesTable);
  const onlineCutoff = now.getTime() - 3 * 60_000;
  const devicesSummary = {
    total: devices.length,
    online: devices.filter((d) => d.lastSeenAt && d.lastSeenAt.getTime() >= onlineCutoff).length,
    phones: devices.filter((d) => d.deviceType === "phone").length,
    phonesOnline: devices.filter((d) => d.deviceType === "phone" && d.lastSeenAt && d.lastSeenAt.getTime() >= onlineCutoff).length,
    pi: devices.filter((d) => d.deviceType === "pi").length,
    degraded: devices.filter((d) => d.healthStatus === "obstructed" || d.healthStatus === "frozen").length,
  };

  // inside-the-building occupancy
  const occupancyRows = await db
    .select({ status: attendanceLogsTable.status, checkedOutAt: attendanceLogsTable.checkedOutAt })
    .from(attendanceLogsTable)
    .where(and(gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)));
  const inside = occupancyRows.filter((r) => (r.status === "present" || r.status === "late") && !r.checkedOutAt).length;
  const checkedOut = occupancyRows.filter((r) => r.checkedOutAt).length;

  // per-classroom rates for the command grid
  const classrooms = await db
    .select({ id: classroomsTable.id, name: classroomsTable.name, studentCount: count(studentsTable.id) })
    .from(classroomsTable)
    .leftJoin(studentsTable, eq(classroomsTable.id, studentsTable.classroomId))
    .groupBy(classroomsTable.id)
    .orderBy(classroomsTable.name);
  const classroomSummary = await Promise.all(classrooms.map(async (c) => {
    const [{ present }] = await db.select({ present: count() }).from(attendanceLogsTable)
      .where(and(eq(attendanceLogsTable.classroomId, c.id), eq(attendanceLogsTable.status, "present"), gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)));
    const [{ absent }] = await db.select({ absent: count() }).from(attendanceLogsTable)
      .where(and(eq(attendanceLogsTable.classroomId, c.id), eq(attendanceLogsTable.status, "absent"), gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)));
    const [{ late }] = await db.select({ late: count() }).from(attendanceLogsTable)
      .where(and(eq(attendanceLogsTable.classroomId, c.id), eq(attendanceLogsTable.status, "late"), gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)));
    const totalStudentsIn = Number(c.studentCount);
    const presentCount = Number(present);
    return {
      classroomId: c.id,
      classroomName: c.name,
      totalStudents: totalStudentsIn,
      presentCount,
      absentCount: Number(absent),
      lateCount: Number(late),
      attendanceRate: totalStudentsIn > 0 ? Math.round((presentCount / totalStudentsIn) * 100) : 0,
    };
  }));

  // latest absent sweep audit (for the "parents alerted" chip)
  const lastSweepRows = await db
    .select({ markedAt: attendanceLogsTable.markedAt, studentId: attendanceLogsTable.studentId })
    .from(attendanceLogsTable)
    .where(and(eq(attendanceLogsTable.status, "absent"), gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)))
    .orderBy(desc(attendanceLogsTable.markedAt))
    .limit(1);

  const totalStudentsNum = Number(totalStudents);
  const presentNum = Number(presentToday);
  const attendanceRate = totalStudentsNum > 0 ? Math.round((presentNum / totalStudentsNum) * 100) : 0;

  res.json({
    stats: {
      totalStudents: totalStudentsNum,
      totalClassrooms: Number(totalClassrooms),
      presentToday: presentNum,
      absentToday: Number(absentToday),
      lateToday: Number(lateToday),
      attendanceRate,
      smsSentToday: Number(smsSentToday),
    },
    occupancy: { inside, checkedOut },
    arrivals,
    devices: devicesSummary,
    reviewsPending: Number(reviewsPending),
    sms: { sentToday: Number(smsSentToday), failedToday: Number(smsFailedToday), queued: Number(smsQueued) },
    classrooms: classroomSummary,
    lastAbsentMark: lastSweepRows[0]?.markedAt?.toISOString() ?? null,
    timezone,
    serverTime: now.toISOString(),
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

router.get("/dashboard/attendance-trend", requireAuth, async (req, res): Promise<void> => {
  const range = String(req.query.range ?? "week");
  let days = 7;
  if (range === "month") days = 30;
  else if (range === "week") days = 7;
  else if (range === "today") days = 1;
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

// ── "Who's in the building right now" occupancy ─────────────────
router.get("/dashboard/occupancy", requireAuth, async (_req, res): Promise<void> => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

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
      checkedOutAt: attendanceLogsTable.checkedOutAt,
    })
    .from(attendanceLogsTable)
    .leftJoin(studentsTable, eq(attendanceLogsTable.studentId, studentsTable.id))
    .leftJoin(classroomsTable, eq(attendanceLogsTable.classroomId, classroomsTable.id))
    .where(and(gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)));

  const inside = rows
    .filter((r) => (r.status === "present" || r.status === "late") && !r.checkedOutAt)
    .map((r) => ({
      studentId: r.studentId,
      studentName: r.studentName ?? "Unknown",
      classroomName: r.classroomName,
      status: r.status,
      method: r.method,
      since: r.markedAt.toISOString(),
    }));
  const checkedOut = rows.filter((r) => r.checkedOutAt).length;

  res.json({
    count: inside.length,
    checkedOut,
    capacity: Number(rows.length + checkedOut),
    people: inside,
  });
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

/**
 * ABSENCE RISK RADAR — predictive early-warning list.
 * Explainable per-student risk scores over a rolling window.
 * Query: ?classroomId=&limit= (defaults: whole school, top 8).
 */
router.get("/analytics/absence-risk", requireAuth, async (req, res): Promise<void> => {
  const rawLimit = Number(req.query.limit ?? 8);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit))) : 8;
  const rawClassroom = Number(req.query.classroomId);
  const classroomId = Number.isInteger(rawClassroom) && rawClassroom > 0 ? rawClassroom : null;
  const summary = await absenceRiskSummary(classroomId, limit);
  res.json(summary);
});

export default router;
