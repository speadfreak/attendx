import { Router } from "express";
import { db, studentsTable, classroomsTable, faceEncodingsTable, attendanceLogsTable, smsLogsTable, qrIssuesTable, classroomSeatsTable } from "@workspace/db";
import { and, desc, eq, gte, ilike, isNull, isNotNull, or, sql } from "drizzle-orm";
import {
  ListStudentsQueryParams,
  CreateStudentBody,
  GetStudentParams,
  UpdateStudentParams,
  UpdateStudentBody,
  DeleteStudentParams,
} from "@workspace/api-zod";
import { z } from "zod/v4";
import { requireAuth, requireStaff } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { publishEvent } from "../lib/events";
import { issueForStudents } from "../lib/qr-issue";

const router = Router();

// ── Bulk enrollment: CSV rows + client-extracted face descriptors ─
const bulkRow = z.object({
  name: z.string().min(1).max(120),
  studentId: z.string().min(1).max(60),
  parentPhone: z.string().min(4).max(30),
  classroomId: z.number().int().positive().nullable().optional(),
  faceDescriptor: z.array(z.number().finite()).length(128).nullable().optional(),
  photoDataUrl: z.string().max(3_000_000).nullable().optional(),
});
const bulkInput = z.object({
  rows: z.array(bulkRow).min(1).max(300),
  issueQr: z.boolean().optional(),
});

router.post("/students/bulk", requireStaff, async (req, res): Promise<void> => {
  const parsed = bulkInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const actor = (req as typeof req & { admin?: { adminId?: number } }).admin;
  const created: number[] = [];
  const updated: number[] = [];
  const failed: Array<{ studentId: string; reason: string }> = [];

  for (const row of parsed.data.rows) {
    try {
      const [existing] = await db.select().from(studentsTable).where(eq(studentsTable.studentId, row.studentId)).limit(1);
      let studentRow = existing;
      if (existing) {
        const [u] = await db.update(studentsTable)
          .set({ name: row.name, parentPhone: row.parentPhone, classroomId: row.classroomId ?? existing.classroomId })
          .where(eq(studentsTable.id, existing.id))
          .returning();
        studentRow = u;
        updated.push(u.id);
      } else {
        const qrCode = `QR-${row.studentId}-${Date.now()}`;
        const [ins] = await db.insert(studentsTable).values({
          name: row.name,
          studentId: row.studentId,
          parentPhone: row.parentPhone,
          classroomId: row.classroomId ?? null,
          qrCode,
        }).returning();
        studentRow = ins;
        created.push(ins.id);
      }
      if (!studentRow) throw new Error("upsert failed");

      if (row.faceDescriptor && row.faceDescriptor.length === 128) {
        const encodingJson = JSON.stringify(row.faceDescriptor);
        const enc = await db.select().from(faceEncodingsTable).where(eq(faceEncodingsTable.studentId, studentRow.id)).limit(1);
        if (enc.length) {
          await db.update(faceEncodingsTable).set({ encoding: encodingJson }).where(eq(faceEncodingsTable.studentId, studentRow.id));
        } else {
          await db.insert(faceEncodingsTable).values({ studentId: studentRow.id, encoding: encodingJson });
        }
      }
    } catch (err) {
      failed.push({ studentId: row.studentId, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // Optionally auto-issue a fresh QR badge for every newly created student
  let qrIssued = 0;
  if (parsed.data.issueQr && created.length) {
    const result = await issueForStudents({
      studentIds: created,
      expiresInDays: null,
      label: "id-card",
      note: "bulk-enrollment",
      actorAdminId: actor?.adminId ?? null,
    });
    qrIssued = result.issued.length;
  }

  await writeAudit({
    actorAdminId: actor?.adminId ?? null,
    action: "students.bulk_enrolled",
    targetType: "student",
    payload: { created: created.length, updated: updated.length, failed: failed.length, qrIssued },
  });
  publishEvent("settings.updated", { bulkEnrollment: { created: created.length, updated: updated.length } });

  res.status(201).json({ created, updated, failed, qrIssued });
});

// ── Per-student detail drawer payload: heatmap + streaks + confidence + SMS + QR ─
router.get("/students/:id/summary", requireAuth, async (req, res): Promise<void> => {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId)).limit(1);
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }

  const since = new Date();
  since.setDate(since.getDate() - 90);
  since.setHours(0, 0, 0, 0);

  const logs = await db
    .select({
      id: attendanceLogsTable.id,
      status: attendanceLogsTable.status,
      method: attendanceLogsTable.method,
      source: attendanceLogsTable.source,
      confidence: attendanceLogsTable.confidence,
      markedAt: attendanceLogsTable.markedAt,
      checkedOutAt: attendanceLogsTable.checkedOutAt,
      notes: attendanceLogsTable.notes,
    })
    .from(attendanceLogsTable)
    .where(and(eq(attendanceLogsTable.studentId, studentId), gte(attendanceLogsTable.markedAt, since)))
    .orderBy(attendanceLogsTable.markedAt);

  // ── day map + streak computation (ordered oldest → newest) ──
  const dayMap = new Map<string, { status: string; method: string; confidence: number | null }>();
  for (const log of logs) {
    const day = log.markedAt.toISOString().slice(0, 10);
    dayMap.set(day, { status: log.status, method: log.method, confidence: log.confidence });
  }

  // streaks: walk day sequence (only days with any record count)
  const sortedDays = Array.from(dayMap.keys()).sort();
  let currentStreak = 0;
  let longestStreak = 0;
  let run = 0;
  // current streak: count consecutive good days ending today/yesterday
  const todayKey = new Date().toISOString().slice(0, 10);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);
  for (let i = sortedDays.length - 1; i >= 0; i--) {
    const day = sortedDays[i];
    const status = dayMap.get(day)!.status;
    const good = status === "present" || status === "late";
    if (!good) break;
    if (day === todayKey || day === yesterdayKey || currentStreak > 0) currentStreak++;
    else break;
  }
  for (const day of sortedDays) {
    const status = dayMap.get(day)!.status;
    if (status === "present" || status === "late") {
      run++;
      longestStreak = Math.max(longestStreak, run);
    } else {
      run = 0;
    }
  }

  // ── confidence trend for face matches ──
  const confidenceTrend = logs
    .filter((l) => l.confidence != null && (l.source === "gate-camera" || l.source === "webcam"))
    .slice(-30)
    .map((l) => ({ at: l.markedAt.toISOString(), confidence: l.confidence as number, source: l.source }));

  // ── SMS history for this student ──
  const sms = await db
    .select({
      id: smsLogsTable.id,
      message: smsLogsTable.message,
      status: smsLogsTable.status,
      provider: smsLogsTable.provider,
      sentAt: smsLogsTable.sentAt,
    })
    .from(smsLogsTable)
    .where(eq(smsLogsTable.studentId, studentId))
    .orderBy(desc(smsLogsTable.sentAt))
    .limit(15);

  // ── QR identity state ──
  const [activeBadge] = await db
    .select({ id: qrIssuesTable.id, serial: qrIssuesTable.serial, expiresAt: qrIssuesTable.expiresAt, version: qrIssuesTable.version, lastScanAt: qrIssuesTable.lastScanAt, scans: qrIssuesTable.scans })
    .from(qrIssuesTable)
    .where(and(eq(qrIssuesTable.studentId, studentId), eq(qrIssuesTable.revoked, false)))
    .orderBy(desc(qrIssuesTable.version))
    .limit(1);

  // ── seat ──
  const [seat] = await db
    .select({ seatLabel: classroomSeatsTable.seatLabel, rowIdx: classroomSeatsTable.rowIdx, colIdx: classroomSeatsTable.colIdx })
    .from(classroomSeatsTable)
    .where(eq(classroomSeatsTable.studentId, studentId))
    .limit(1);

  const hasFace = (await db.select({ id: faceEncodingsTable.id }).from(faceEncodingsTable).where(eq(faceEncodingsTable.studentId, studentId)).limit(1)).length > 0;

  const presentCount = sortedDays.filter((d) => dayMap.get(d)!.status === "present").length;
  const lateCount = sortedDays.filter((d) => dayMap.get(d)!.status === "late").length;
  const absentCount = sortedDays.filter((d) => dayMap.get(d)!.status === "absent").length;
  const marked = presentCount + lateCount + absentCount;

  res.json({
    student: {
      id: student.id,
      name: student.name,
      studentId: student.studentId,
      parentPhone: student.parentPhone,
      classroomId: student.classroomId,
      photoUrl: student.photoUrl,
      hasFaceEncoding: hasFace,
    },
    heatmap: sortedDays.map((day) => ({ day, ...dayMap.get(day)! })),
    streaks: { current: currentStreak, longest: longestStreak },
    stats: { present: presentCount, late: lateCount, absent: absentCount, marked, rate: marked ? (presentCount + lateCount) / marked : null },
    confidenceTrend,
    sms: sms.map((s) => ({ ...s, sentAt: s.sentAt.toISOString() })),
    qr: activeBadge
      ? { active: true, serial: activeBadge.serial, expiresAt: activeBadge.expiresAt?.toISOString() ?? null, version: activeBadge.version, lastScanAt: activeBadge.lastScanAt?.toISOString() ?? null, scans: activeBadge.scans }
      : { active: false },
    seat: seat ?? null,
  });
});

// ── Manual check-out (occupancy tracking) ───────────────────────
const checkoutInput = z.object({ studentId: z.number().int().positive() });

router.post("/students/check-out", requireAuth, async (req, res): Promise<void> => {
  const parsed = checkoutInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const studentId = parsed.data.studentId;
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date();
  dayEnd.setHours(23, 59, 59, 999);

  const [log] = await db
    .update(attendanceLogsTable)
    .set({ checkedOutAt: new Date() })
    .where(and(
      eq(attendanceLogsTable.studentId, studentId),
      gte(attendanceLogsTable.markedAt, dayStart),
      sql`${attendanceLogsTable.markedAt} <= ${dayEnd}`,
      isNull(attendanceLogsTable.checkedOutAt),
    ))
    .returning();
  if (!log) {
    res.status(404).json({ error: "No open attendance record found today for this student" });
    return;
  }
  const [student] = await db.select({ name: studentsTable.name }).from(studentsTable).where(eq(studentsTable.id, studentId)).limit(1);
  publishEvent("attendance.checkout", { studentId, studentName: student?.name, at: new Date().toISOString() });
  const actor = (req as typeof req & { admin?: { adminId?: number } }).admin;
  await writeAudit({
    actorAdminId: actor?.adminId ?? null,
    action: "attendance.checked_out",
    targetType: "attendance",
    targetId: log.id,
    payload: { studentId },
  });
  res.json({ ok: true, checkedOutAt: log.checkedOutAt?.toISOString() });
});


router.get("/students", requireAuth, async (req, res): Promise<void> => {
  const params = ListStudentsQueryParams.safeParse(req.query);
  const classroomId = params.success ? params.data.classroomId : null;
  const search = params.success ? params.data.search : null;

  const rows = await db
    .select({
      id: studentsTable.id,
      name: studentsTable.name,
      studentId: studentsTable.studentId,
      classroomId: studentsTable.classroomId,
      classroomName: classroomsTable.name,
      parentPhone: studentsTable.parentPhone,
      photoUrl: studentsTable.photoUrl,
      qrCode: studentsTable.qrCode,
      hasEncoding: faceEncodingsTable.id,
      createdAt: studentsTable.createdAt,
    })
    .from(studentsTable)
    .leftJoin(classroomsTable, eq(studentsTable.classroomId, classroomsTable.id))
    .leftJoin(faceEncodingsTable, eq(studentsTable.id, faceEncodingsTable.studentId))
    .where(
      and(
        classroomId ? eq(studentsTable.classroomId, classroomId) : undefined,
        search ? ilike(studentsTable.name, `%${search}%`) : undefined,
      )
    )
    .orderBy(studentsTable.name);

  const activeBadges = await db
    .select({ studentId: qrIssuesTable.studentId, serial: qrIssuesTable.serial })
    .from(qrIssuesTable)
    .where(eq(qrIssuesTable.revoked, false));
  const badgeByStudent = new Map<number, string>();
  for (const b of activeBadges) {
    if (!badgeByStudent.has(b.studentId)) badgeByStudent.set(b.studentId, b.serial);
  }

  const students = rows.map((r) => ({
    id: r.id,
    name: r.name,
    studentId: r.studentId,
    classroomId: r.classroomId ?? null,
    classroomName: r.classroomName ?? null,
    parentPhone: r.parentPhone,
    photoUrl: r.photoUrl ?? null,
    qrCode: r.qrCode ?? null,
    hasActiveQr: badgeByStudent.has(r.id),
    hasFaceEncoding: r.hasEncoding != null,
    createdAt: r.createdAt.toISOString(),
  }));

  res.json(students);
});

router.post("/students", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateStudentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const qrCode = `QR-${parsed.data.studentId}-${Date.now()}`;
  const [student] = await db
    .insert(studentsTable)
    .values({ ...parsed.data, qrCode })
    .returning();

  res.status(201).json({
    id: student.id,
    name: student.name,
    studentId: student.studentId,
    classroomId: student.classroomId ?? null,
    classroomName: null,
    parentPhone: student.parentPhone,
    photoUrl: student.photoUrl ?? null,
    qrCode: student.qrCode ?? null,
    hasFaceEncoding: false,
    createdAt: student.createdAt.toISOString(),
  });
});

router.get("/students/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetStudentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select({
      id: studentsTable.id,
      name: studentsTable.name,
      studentId: studentsTable.studentId,
      classroomId: studentsTable.classroomId,
      classroomName: classroomsTable.name,
      parentPhone: studentsTable.parentPhone,
      photoUrl: studentsTable.photoUrl,
      qrCode: studentsTable.qrCode,
      hasEncoding: faceEncodingsTable.id,
      createdAt: studentsTable.createdAt,
    })
    .from(studentsTable)
    .leftJoin(classroomsTable, eq(studentsTable.classroomId, classroomsTable.id))
    .leftJoin(faceEncodingsTable, eq(studentsTable.id, faceEncodingsTable.studentId))
    .where(eq(studentsTable.id, params.data.id));

  if (!rows.length) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const r = rows[0];
  res.json({
    id: r.id,
    name: r.name,
    studentId: r.studentId,
    classroomId: r.classroomId ?? null,
    classroomName: r.classroomName ?? null,
    parentPhone: r.parentPhone,
    photoUrl: r.photoUrl ?? null,
    qrCode: r.qrCode ?? null,
    hasFaceEncoding: r.hasEncoding != null,
    createdAt: r.createdAt.toISOString(),
  });
});

router.patch("/students/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateStudentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateStudentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [student] = await db
    .update(studentsTable)
    .set(body.data)
    .where(eq(studentsTable.id, params.data.id))
    .returning();
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  res.json({
    id: student.id,
    name: student.name,
    studentId: student.studentId,
    classroomId: student.classroomId ?? null,
    classroomName: null,
    parentPhone: student.parentPhone,
    photoUrl: student.photoUrl ?? null,
    qrCode: student.qrCode ?? null,
    hasFaceEncoding: false,
    createdAt: student.createdAt.toISOString(),
  });
});

router.delete("/students/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteStudentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [student] = await db.delete(studentsTable).where(eq(studentsTable.id, params.data.id)).returning();
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
