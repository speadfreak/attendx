import { Router, type Request } from "express";
import { db, studentsTable, classroomsTable, qrIssuesTable, qrScanLogsTable, attendanceLogsTable, faceEncodingsTable } from "@workspace/db";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAuth, requireStaff, requireAdminLevel } from "../lib/auth";
import { verifyQrToken, hashQrToken } from "../lib/qr";
import { issueForStudents } from "../lib/qr-issue";
import { writeAudit } from "../lib/audit";
import { publishEvent } from "../lib/events";

/**
 * QR attendance system.
 *
 * Lifecycle controlled by admins / homeroom teachers:
 *   issue → print / share → student scans at the door terminal →
 *   rotate (old badge dies instantly) → revoke (lost card) → reprint.
 *
 * Anti-spoof: server-signed HMAC tokens, per-student version pinning
 * (issuing v2 kills v1 badges immediately), expiry windows, duplicate
 * window (a badge can't be replayed within the same day), and a full
 * anomaly log (expired / revoked / forged / duplicate / unknown).
 */

const router = Router();

const adminId = (req: Request) => (req as Request & { admin?: { adminId: number; role: string } }).admin;

const issueInput = z.object({
  studentIds: z.array(z.number().int().positive()).min(1).max(500),
  expiresInDays: z.number().min(0).max(365).nullable().optional(),
  label: z.enum(["id-card", "temporary-pass", "replacement"]).optional(),
  note: z.string().max(300).optional(),
});

function attendanceStatusForNow(now = new Date()): "present" | "late" {
  return now.getHours() > 8 || (now.getHours() === 8 && now.getMinutes() > 15) ? "late" : "present";
}

// ── Issue / rotate QR badges ────────────────────────────────────
router.post("/qr/issue", requireStaff, async (req, res): Promise<void> => {
  const parsed = issueInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const actor = adminId(req);
  const result = await issueForStudents({
    studentIds: parsed.data.studentIds,
    expiresInDays: parsed.data.expiresInDays ?? null,
    label: parsed.data.label ?? "id-card",
    note: parsed.data.note,
    actorAdminId: actor?.adminId ?? null,
  });
  res.status(201).json(result);
});

// ── List badge inventory (admin console) ────────────────────────
router.get("/qr/issues", requireStaff, async (req, res): Promise<void> => {
  const studentId = req.query.studentId ? Number(req.query.studentId) : null;
  const classroomId = req.query.classroomId ? Number(req.query.classroomId) : null;
  const conditions = [];
  if (studentId) conditions.push(eq(qrIssuesTable.studentId, studentId));
  if (classroomId) conditions.push(eq(qrIssuesTable.classroomId, classroomId));

  const rows = await db
    .select({
      id: qrIssuesTable.id,
      studentId: qrIssuesTable.studentId,
      studentName: studentsTable.name,
      studentRef: studentsTable.studentId,
      classroomId: qrIssuesTable.classroomId,
      classroomName: classroomsTable.name,
      version: qrIssuesTable.version,
      serial: qrIssuesTable.serial,
      label: qrIssuesTable.label,
      expiresAt: qrIssuesTable.expiresAt,
      revoked: qrIssuesTable.revoked,
      revokedAt: qrIssuesTable.revokedAt,
      revokeReason: qrIssuesTable.revokeReason,
      scans: qrIssuesTable.scans,
      lastScanAt: qrIssuesTable.lastScanAt,
      createdAt: qrIssuesTable.createdAt,
    })
    .from(qrIssuesTable)
    .leftJoin(studentsTable, eq(qrIssuesTable.studentId, studentsTable.id))
    .leftJoin(classroomsTable, eq(qrIssuesTable.classroomId, classroomsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(qrIssuesTable.createdAt))
    .limit(300);

  const now = Date.now();
  res.json(rows.map((r) => ({
    ...r,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    lastScanAt: r.lastScanAt ? r.lastScanAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    state: r.revoked ? "revoked" : r.expiresAt && r.expiresAt.getTime() < now ? "expired" : "active",
  })));
});

// ── Revoke a badge (lost card / compromise) ─────────────────────
router.post("/qr/issues/:id/revoke", requireStaff, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : "revoked-by-admin";
  const [issue] = await db.update(qrIssuesTable)
    .set({ revoked: true, revokedAt: new Date(), revokeReason: reason })
    .where(eq(qrIssuesTable.id, id))
    .returning();
  if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }
  await writeAudit({
    actorAdminId: adminId(req)?.adminId ?? null,
    action: "qr.revoked",
    targetType: "qr_issue",
    targetId: issue.serial,
    payload: { reason, studentId: issue.studentId },
  });
  res.json({ ok: true });
});

// ── Re-issue for one student (reprint / replace) ────────────────
router.post("/qr/students/:studentId/rotate", requireStaff, async (req, res): Promise<void> => {
  const studentId = Number(req.params.studentId);
  const actor = adminId(req);
  const result = await issueForStudents({
    studentIds: [studentId],
    expiresInDays: req.body?.expiresInDays ?? null,
    label: req.body?.label ?? "replacement",
    note: "rotated",
    actorAdminId: actor?.adminId ?? null,
  });
  if (!result.issued.length) { res.status(404).json({ error: result.skipped[0]?.reason ?? "Student not found" }); return; }
  res.status(201).json(result.issued[0]);
});

// ── Bulk issue for a whole classroom (homeroom flow) ────────────
router.post("/qr/classrooms/:classroomId/issue-all", requireStaff, async (req, res): Promise<void> => {
  const classroomId = Number(req.params.classroomId);
  const students = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(eq(studentsTable.classroomId, classroomId));
  if (!students.length) { res.status(404).json({ error: "No students in this classroom" }); return; }
  const actor = adminId(req);
  const result = await issueForStudents({
    studentIds: students.map((s) => s.id),
    expiresInDays: req.body?.expiresInDays ?? null,
    label: "id-card",
    note: "classroom-batch",
    actorAdminId: actor?.adminId ?? null,
  });
  res.status(201).json(result);
});

// ── Scan log feed (anomalies + valid taps) ──────────────────────
router.get("/qr/scan-logs", requireStaff, async (req, res): Promise<void> => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 60)));
  const rows = await db
    .select({
      id: qrScanLogsTable.id,
      studentId: qrScanLogsTable.studentId,
      studentName: studentsTable.name,
      terminalId: qrScanLogsTable.terminalId,
      result: qrScanLogsTable.result,
      status: qrScanLogsTable.status,
      detail: qrScanLogsTable.detail,
      createdAt: qrScanLogsTable.createdAt,
    })
    .from(qrScanLogsTable)
    .leftJoin(studentsTable, eq(qrScanLogsTable.studentId, studentsTable.id))
    .orderBy(desc(qrScanLogsTable.createdAt))
    .limit(limit);
  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

// ── Stats for the QR console ────────────────────────────────────
router.get("/qr/stats", requireStaff, async (_req, res): Promise<void> => {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const [active] = await db.select({ total: sql<number>`count(*)` }).from(qrIssuesTable)
    .where(and(eq(qrIssuesTable.revoked, false), sql`(${qrIssuesTable.expiresAt} is null or ${qrIssuesTable.expiresAt} > now())`));
  const [revoked] = await db.select({ total: sql<number>`count(*)` }).from(qrIssuesTable)
    .where(eq(qrIssuesTable.revoked, true));
  const [scansToday] = await db.select({ total: sql<number>`count(*)` }).from(qrScanLogsTable)
    .where(and(eq(qrScanLogsTable.result, "valid"), gte(qrScanLogsTable.createdAt, dayStart)));
  const [anomaliesToday] = await db.select({ total: sql<number>`count(*)` }).from(qrScanLogsTable)
    .where(and(sql`${qrScanLogsTable.result} <> 'valid'`, gte(qrScanLogsTable.createdAt, dayStart)));
  const [studentsWithoutQr] = await db.select({ total: sql<number>`count(*)` }).from(studentsTable)
    .where(sql`not exists (select 1 from qr_issues qi where qi.student_id = ${studentsTable.id} and qi.revoked = false and (qi.expires_at is null or qi.expires_at > now()))`);

  res.json({
    activeBadges: Number(active.total),
    revokedBadges: Number(revoked.total),
    validScansToday: Number(scansToday.total),
    anomaliesToday: Number(anomaliesToday.total),
    studentsWithoutActiveBadge: Number(studentsWithoutQr.total),
  });
});

// ── THE DOOR: terminal scan endpoint ────────────────────────────
const scanInput = z.object({
  token: z.string().min(6).max(2000),
  terminalId: z.string().max(80).optional(),
  classroomId: z.number().int().positive().optional(),
});

router.post("/qr/scan", requireStaff, async (req, res): Promise<void> => {
  const parsed = scanInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const token = parsed.data.token.trim();
  const terminalId = parsed.data.terminalId || "web";
  const now = new Date();

  const logScan = (result: string, studentId: number | null, issueId: number | null, status: string | null, detail: Record<string, unknown> = {}) =>
    db.insert(qrScanLogsTable).values({ studentId, issueId, terminalId, result, status, detail: { ...detail, at: now.toISOString() } }).returning();

  // 1. Signature + expiry
  const verdict = verifyQrToken(token);
  if (!verdict.ok) {
    await logScan(verdict.reason, null, null, null, { tokenPrefix: token.slice(0, 12) });
    publishEvent("qr.scan", { result: verdict.reason, terminalId });
    res.status(verdict.reason === "expired" ? 410 : 400).json({
      ok: false,
      result: verdict.reason,
      message: verdict.reason === "expired"
        ? "This QR badge has expired. Ask your homeroom teacher for a new one."
        : verdict.reason === "bad-signature" || verdict.reason === "not-attendx-qr"
          ? "Unrecognized badge — this QR was not issued by AttendX."
          : "Malformed QR payload.",
    });
    return;
  }

  const { sid, v } = verdict.payload;

  // 2. Locate the matching issue record by hash
  const tokenHash = hashQrToken(token);
  const [issue] = await db.select().from(qrIssuesTable)
    .where(and(eq(qrIssuesTable.tokenHash, tokenHash), eq(qrIssuesTable.studentId, sid)))
    .limit(1);

  if (!issue) {
    await logScan("unknown-badge", sid, null, null);
    publishEvent("qr.scan", { result: "unknown-badge", terminalId, studentId: sid });
    res.status(404).json({ ok: false, result: "unknown-badge", message: "Badge not recognized in the system." });
    return;
  }

  if (issue.revoked) {
    await logScan("revoked", sid, issue.id, null, { reason: issue.revokeReason });
    publishEvent("qr.scan", { result: "revoked", terminalId, studentId: sid });
    res.status(403).json({ ok: false, result: "revoked", message: "This badge has been revoked. Contact the school office." });
    return;
  }

  if (issue.version !== v) {
    await logScan("stale-version", sid, issue.id, null, { badgeVersion: v, currentVersion: issue.version });
    publishEvent("qr.scan", { result: "stale-version", terminalId, studentId: sid });
    res.status(409).json({ ok: false, result: "stale-version", message: "A newer badge was issued — this print is outdated." });
    return;
  }

  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, sid)).limit(1);
  if (!student) {
    await logScan("student-gone", sid, issue.id, null);
    res.status(404).json({ ok: false, result: "student-gone", message: "Student record missing." });
    return;
  }

  // 3. Duplicate protection — one attendance per badge per day
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const [existing] = await db.select().from(attendanceLogsTable)
    .where(and(eq(attendanceLogsTable.studentId, sid), gte(attendanceLogsTable.markedAt, dayStart)))
    .limit(1);

  if (existing) {
    await db.update(qrIssuesTable).set({ scans: sql`${qrIssuesTable.scans} + 1`, lastScanAt: now }).where(eq(qrIssuesTable.id, issue.id));
    await logScan("duplicate", sid, issue.id, existing.status, { attendanceId: existing.id });
    publishEvent("qr.scan", { result: "duplicate", terminalId, studentId: sid, studentName: student.name });
    res.status(200).json({
      ok: true,
      result: "duplicate",
      alreadyMarked: true,
      student: { id: student.id, name: student.name, studentId: student.studentId, classroomId: student.classroomId },
      attendance: { id: existing.id, status: existing.status, checkedOutAt: existing.checkedOutAt?.toISOString() ?? null },
      message: `${student.name} already checked in today (${existing.status}).`,
    });
    return;
  }

  // 4. Commit attendance
  const status = attendanceStatusForNow(now);
  const [log] = await db.insert(attendanceLogsTable).values({
    studentId: sid,
    classroomId: parsed.data.classroomId ?? student.classroomId,
    status,
    method: "qr",
    source: parsed.data.terminalId && parsed.data.terminalId !== "web" ? "qr-terminal" : "qr-web",
    confidence: null,
    notes: `QR ${issue.serial}`,
  }).returning();

  await db.update(qrIssuesTable).set({ scans: sql`${qrIssuesTable.scans} + 1`, lastScanAt: now }).where(eq(qrIssuesTable.id, issue.id));
  await logScan("valid", sid, issue.id, status, { attendanceId: log.id, serial: issue.serial });
  publishEvent("qr.scan", { result: "valid", terminalId, studentId: sid, studentName: student.name, status, serial: issue.serial });
  publishEvent("attendance.created", {
    studentId: sid,
    studentName: student.name,
    status,
    method: "qr",
    source: "qr-terminal",
    classroomId: log.classroomId,
    markedAt: log.markedAt.toISOString(),
  });
  await writeAudit({
    actorAdminId: adminId(req)?.adminId ?? null,
    action: "attendance.qr.committed",
    targetType: "attendance",
    targetId: log.id,
    payload: { studentId: sid, serial: issue.serial, terminalId, status },
  });

  // late arrival triggers parent SMS via job queue
  if (status === "late") {
    const { enqueueJob } = await import("../lib/jobs");
    await enqueueJob({ type: "send_sms", worker: "api", payload: { studentId: sid, status } });
  }

  res.status(201).json({
    ok: true,
    result: "valid",
    alreadyMarked: false,
    student: { id: student.id, name: student.name, studentId: student.studentId, classroomId: student.classroomId },
    attendance: { id: log.id, status, markedAt: log.markedAt.toISOString() },
    message: status === "late" ? `Late check-in recorded for ${student.name}.` : `Welcome, ${student.name}! Attendance marked.`,
  });
});

// ── Terminal session stats (kiosk footer) ───────────────────────
router.get("/qr/terminal-stats", requireStaff, async (req, res): Promise<void> => {
  const terminalId = String(req.query.terminalId ?? "web");
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const rows = await db.select({ result: qrScanLogsTable.result }).from(qrScanLogsTable)
    .where(and(eq(qrScanLogsTable.terminalId, terminalId), gte(qrScanLogsTable.createdAt, dayStart)));
  const stats = { valid: 0, duplicate: 0, anomalies: 0 };
  for (const r of rows) {
    if (r.result === "valid") stats.valid++;
    else if (r.result === "duplicate") stats.duplicate++;
    else stats.anomalies++;
  }
  res.json(stats);
});

export default router;
