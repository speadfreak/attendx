import { db, attendanceLogsTable, studentsTable, classroomsTable } from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import { getSystemSettings } from "./system-settings";
import { logger } from "./logger";

/**
 * ABSENCE RISK RADAR — predictive early-warning engine (Phase 5).
 *
 * Statistical, explainable scoring over a rolling attendance window:
 *   - absence rate across school days in the window
 *   - consecutive absences ending today (the strongest disengagement signal)
 *   - lateness frequency
 *   - trend: is absence accelerating vs the earlier part of the window?
 *   - ghost signal: students with zero activity in the window
 * No black boxes — every score ships with human-readable reasons.
 */

export type RiskLevel = "low" | "watch" | "elevated" | "critical";

export interface StudentRisk {
  studentId: number;
  name: string;
  studentCode: string;
  classroomId: number | null;
  classroomName: string | null;
  score: number;
  level: RiskLevel;
  windowDays: number;
  schoolDays: number;
  absentDays: number;
  lateDays: number;
  absenceRate: number;
  lateRate: number;
  consecutiveAbsences: number;
  trend: number;
  lastPresentAt: string | null;
  reasons: string[];
}

interface RiskInputRow {
  studentId: number;
  status: string;
  markedAt: Date;
}

export function riskLevelFor(score: number): RiskLevel {
  if (score >= 75) return "critical";
  if (score >= 50) return "elevated";
  if (score >= 25) return "watch";
  return "low";
}

/** Local (timezone-correct) YYYY-MM-DD key for a timestamp. */
function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
}

export function computeRiskScore(input: {
  absenceRate: number;
  consecutiveAbsences: number;
  lateRate: number;
  trend: number;
}): number {
  const absencePart = 50 * Math.min(1, Math.max(0, input.absenceRate));
  const consecutivePart = 20 * (Math.min(3, Math.max(0, input.consecutiveAbsences)) / 3);
  const latePart = 15 * Math.min(1, Math.max(0, input.lateRate));
  const trendPart = 15 * Math.min(1, Math.max(0, input.trend));
  return Math.round(absencePart + consecutivePart + latePart + trendPart);
}

export async function computeAbsenceRisk(options: {
  windowDays?: number;
  classroomId?: number | null;
} = {}): Promise<StudentRisk[]> {
  const windowDays = Math.min(60, Math.max(7, options.windowDays ?? 21));
  const settings = await getSystemSettings();
  const timezone = settings.attendanceTimezone;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Roster (with classroom names), optionally scoped to one classroom
  const roster = await db
    .select({
      id: studentsTable.id,
      name: studentsTable.name,
      studentId: studentsTable.studentId,
      classroomId: studentsTable.classroomId,
      classroomName: classroomsTable.name,
    })
    .from(studentsTable)
    .leftJoin(classroomsTable, eq(studentsTable.classroomId, classroomsTable.id));

  const scoped = options.classroomId
    ? roster.filter((s) => s.classroomId === options.classroomId)
    : roster;
  const scopedIds = new Set(scoped.map((s) => s.id));

  // Attendance rows in the window for the scoped population
  const rows: RiskInputRow[] = await db
    .select({
      studentId: attendanceLogsTable.studentId,
      status: attendanceLogsTable.status,
      markedAt: attendanceLogsTable.markedAt,
    })
    .from(attendanceLogsTable)
    .where(and(gte(attendanceLogsTable.markedAt, since)))
    .orderBy(attendanceLogsTable.markedAt);

  // Day buckets per student + school-wide session days
  const byStudent = new Map<number, Map<string, { status: string; at: Date }>>();
  const schoolDays = new Set<string>();
  for (const row of rows) {
    if (!scopedIds.has(row.studentId)) continue;
    const key = dayKey(row.markedAt, timezone);
    schoolDays.add(key);
    let days = byStudent.get(row.studentId);
    if (!days) {
      days = new Map();
      byStudent.set(row.studentId, days);
    }
    const existing = days.get(key);
    // Keep the latest record per day (e.g. corrected status wins)
    if (!existing || row.markedAt >= existing.at) {
      days.set(key, { status: row.status, at: row.markedAt });
    }
  }

  const schoolDayCount = Math.max(1, schoolDays.size);
  const cutoff7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const nowMs = Date.now();

  const risks: StudentRisk[] = scoped.map((student) => {
    const days = byStudent.get(student.id);
    const reasons: string[] = [];

    if (!days || days.size === 0) {
      // Ghost signal — enrolled but invisible for the whole window
      const created = student.id; // roster has no createdAt selected; treat uniformly
      void created;
      reasons.push(`No attendance activity in the last ${windowDays} days`);
      return {
        studentId: student.id,
        name: student.name,
        studentCode: student.studentId,
        classroomId: student.classroomId,
        classroomName: student.classroomName,
        score: 55,
        level: riskLevelFor(55),
        windowDays,
        schoolDays: schoolDayCount,
        absentDays: 0,
        lateDays: 0,
        absenceRate: 0,
        lateRate: 0,
        consecutiveAbsences: 0,
        trend: 0,
        lastPresentAt: null,
        reasons,
      };
    }

    const dayKeys = [...days.keys()].sort();
    let absentDays = 0;
    let lateDays = 0;
    for (const key of dayKeys) {
      const st = days.get(key)!.status;
      if (st === "absent") absentDays += 1;
      else if (st === "late") lateDays += 1;
    }

    // Consecutive absences counting back from the most recent day
    let consecutiveAbsences = 0;
    for (let i = dayKeys.length - 1; i >= 0; i -= 1) {
      if (days.get(dayKeys[i])!.status === "absent") consecutiveAbsences += 1;
      else break;
    }

    // Trend: recent-week absence rate vs the rest of the window
    let recentDays = 0;
    let recentAbsences = 0;
    let priorDays = 0;
    let priorAbsences = 0;
    let lastPresentAt: string | null = null;
    for (const key of dayKeys) {
      const rec = days.get(key)!;
      if (rec.status !== "absent" && (!lastPresentAt || rec.at.getTime() > new Date(lastPresentAt).getTime())) {
        lastPresentAt = rec.at.toISOString();
      }
      const isRecent = rec.at.getTime() >= cutoff7.getTime();
      if (isRecent) {
        recentDays += 1;
        if (rec.status === "absent") recentAbsences += 1;
      } else {
        priorDays += 1;
        if (rec.status === "absent") priorAbsences += 1;
      }
    }
    const recentRate = recentDays ? recentAbsences / recentDays : 0;
    const priorRate = priorDays ? priorAbsences / priorDays : 0;
    const trend = Math.max(-1, Math.min(1, recentRate - priorRate));

    const absenceRate = absentDays / schoolDayCount;
    const lateRate = lateDays / schoolDayCount;
    const score = computeRiskScore({ absenceRate, consecutiveAbsences, lateRate, trend });

    if (consecutiveAbsences >= 2) {
      reasons.push(`${consecutiveAbsences} consecutive absences`);
    }
    if (absenceRate >= 0.3) {
      reasons.push(`Absent ${absentDays} of last ${schoolDayCount} school days (${Math.round(absenceRate * 100)}%)`);
    } else if (absentDays > 0) {
      reasons.push(`Absent ${absentDays}× in the window`);
    }
    if (lateRate >= 0.25) {
      reasons.push(`Chronically late (${lateDays}×, ${Math.round(lateRate * 100)}% of days)`);
    }
    if (trend >= 0.25) {
      reasons.push("Absence accelerating vs earlier in the window");
    }
    if (lastPresentAt && nowMs - new Date(lastPresentAt).getTime() > 7 * 24 * 3600 * 1000) {
      reasons.push("Last seen over a week ago");
    }
    if (reasons.length === 0) reasons.push("Attendance looks steady");

    return {
      studentId: student.id,
      name: student.name,
      studentCode: student.studentId,
      classroomId: student.classroomId,
      classroomName: student.classroomName,
      score,
      level: riskLevelFor(score),
      windowDays,
      schoolDays: schoolDayCount,
      absentDays,
      lateDays,
      absenceRate,
      lateRate,
      consecutiveAbsences,
      trend,
      lastPresentAt,
      reasons,
    };
  });

  risks.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return risks;
}

export async function absenceRiskSummary(classroomId?: number | null, limit = 8): Promise<{
  windowDays: number;
  levelCounts: Record<RiskLevel, number>;
  top: StudentRisk[];
}> {
  try {
    const all = await computeAbsenceRisk({ classroomId: classroomId ?? null });
    const levelCounts: Record<RiskLevel, number> = { low: 0, watch: 0, elevated: 0, critical: 0 };
    for (const r of all) levelCounts[r.level] += 1;
    return { windowDays: all[0]?.windowDays ?? 21, levelCounts, top: all.slice(0, Math.max(1, limit)) };
  } catch (err) {
    logger.error({ err }, "absence risk computation failed");
    return { windowDays: 21, levelCounts: { low: 0, watch: 0, elevated: 0, critical: 0 }, top: [] };
  }
}
