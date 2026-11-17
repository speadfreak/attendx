import { and, gte, lte } from "drizzle-orm";
import { db, studentsTable, attendanceLogsTable } from "@workspace/db";
import { logger } from "./logger";
import { writeAudit } from "./audit";
import { enqueueAttendanceSms } from "./jobs";
import { publishEvent } from "./events";
import { getSystemSettings } from "./system-settings";
import {
  arrivalRulesFromSettings, isPastAbsenceCutoff, localDayBounds,
} from "./attendance-rules";

/**
 * End-of-day ABSENT SWEEP — the engine that guarantees parents actually get
 * the "your child has not arrived" SMS + the in-app alerts.
 *
 * Previously this logic lived only in a MANUAL route
 * (POST /operations/attendance/absent-sweep): if nobody clicked that button,
 * absent students were never marked and their parents never notified.
 *
 * Now one shared implementation runs from every trigger:
 *   - the daily Vercel cron (/api/internal/cron),
 *   - the self-hosted job worker tick (once per minute),
 *   - an opportunistic trigger on dashboard stats loads (throttled),
 *   - the manual route (unchanged API shape).
 *
 * AUTO mode (`respectOncePerDay: true`) fires only when
 *   1. local time passed absenceCutoffTime (school timezone), and
 *   2. it has not already run today (system_settings guard),
 * so calling it every minute is cheap and safe.
 */

const SWEEP_LAST_RUN_KEY = "absent_sweep_last_run";

export interface AbsentSweepResult {
  markedAbsent: number;
  smsQueued: number;
  /** Set when the sweep intentionally did not run. */
  skippedReason?: "before-cutoff" | "already-ran-today";
  students: Array<{ id: number; name: string }>;
}

async function readLastRunDayKey(): Promise<string | null> {
  const { settingValue } = await import("./system-settings");
  return settingValue<string | null>(SWEEP_LAST_RUN_KEY, null);
}

async function markRun(dayKey: string): Promise<void> {
  const { setSystemSetting } = await import("./system-settings");
  await setSystemSetting(SWEEP_LAST_RUN_KEY, dayKey);
}

export async function runAbsentSweep(opts: {
  /** Manual override — ignores the cutoff clock and the once-per-day guard. */
  force?: boolean;
  /** System (automatic) triggers set this so the same day never double-fires. */
  respectOncePerDay?: boolean;
  actorAdminId?: number | null;
} = {}): Promise<AbsentSweepResult> {
  const { force = false, respectOncePerDay = false, actorAdminId = null } = opts;
  const settings = await getSystemSettings();
  const rules = arrivalRulesFromSettings(settings);
  const now = new Date();

  if (!force && !isPastAbsenceCutoff(now, rules)) {
    return { markedAbsent: 0, smsQueued: 0, skippedReason: "before-cutoff", students: [] };
  }

  const { dayKey, startUtc: todayStart, endUtc: todayEnd } = localDayBounds(now, rules.timezone);

  if (respectOncePerDay && !force) {
    const lastRun = await readLastRunDayKey();
    if (lastRun === dayKey) {
      return { markedAbsent: 0, smsQueued: 0, skippedReason: "already-ran-today", students: [] };
    }
  }

  const allStudents = await db
    .select({ id: studentsTable.id, name: studentsTable.name, classroomId: studentsTable.classroomId })
    .from(studentsTable);
  const presentToday = await db
    .select({ studentId: attendanceLogsTable.studentId })
    .from(attendanceLogsTable)
    .where(and(gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)));
  const presentSet = new Set(presentToday.map((p) => p.studentId));
  const missing = allStudents.filter((s) => !presentSet.has(s.id));

  let smsQueued = 0;
  for (const student of missing) {
    const [log] = await db
      .insert(attendanceLogsTable)
      .values({
        studentId: student.id,
        classroomId: student.classroomId,
        status: "absent",
        method: "manual",
        source: "manual",
        notes: force ? "absent sweep (manual)" : "absent sweep (auto)",
      })
      .returning();
    // THE parent notification — absent SMS template per student.
    await enqueueAttendanceSms(student.id, "absent", log.markedAt);
    smsQueued++;
    publishEvent("attendance.created", { studentId: student.id, studentName: student.name, status: "absent", method: "manual" });
    await writeAudit({
      actorAdminId,
      action: "attendance.absent_sweep.marked",
      targetType: "attendance",
      targetId: log.id,
      payload: { studentId: student.id, auto: !force },
    });
  }

  if (respectOncePerDay) {
    await markRun(dayKey).catch((err) => logger.warn({ err }, "absent sweep last-run stamp failed"));
  }

  if (missing.length > 0) {
    publishEvent("attendance.absent_sweep", {
      markedAbsent: missing.length,
      smsQueued,
      auto: !force,
      day: dayKey,
    });
    logger.info({ markedAbsent: missing.length, smsQueued, auto: !force }, "Absent sweep completed");
  }

  return { markedAbsent: missing.length, smsQueued, students: missing.map((m) => ({ id: m.id, name: m.name })) };
}
