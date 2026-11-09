import { Router, type Request } from "express";
import { db, studentsTable, classroomsTable, qrIssuesTable, qrScanLogsTable, attendanceLogsTable, faceEncodingsTable } from "@workspace/db";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAuth, requireStaff, requireAdminLevel } from "../lib/auth";
import { verifyQrToken, hashQrToken } from "../lib/qr";
import { issueForStudents } from "../lib/qr-issue";
import { writeAudit } from "../lib/audit";
import { publishEvent } from "../lib/events";
import { getArrivalRules, resolveArrivalStatus, localDayBounds } from "../lib/attendance-rules";
import { evaluateGeofence, gateForTerminal } from "../lib/gates";
import { analyzeScanForFraud, recordGeofenceViolation } from "../lib/fraud";

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

function attendanceStatusForNow(now: Date, rules: Awaited<ReturnType<typeof getArrivalRules>>): "present" | "late" {
  return resolveArrivalStatus(now, rules);
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
      // ── Phase 6: geofence + fraud analysis columns (additive) ──
      gateId: qrScanLogsTable.gateId,
      scannedAt: qrScanLogsTable.scannedAt,
      latitude: qrScanLogsTable.latitude,
      longitude: qrScanLogsTable.longitude,
      accuracy: qrScanLogsTable.accuracy,
      nonce: qrScanLogsTable.nonce,
      fraudScore: qrScanLogsTable.fraudScore,
      fraudSignals: qrScanLogsTable.fraudSignals,
    })
    .from(qrScanLogsTable)
    .leftJoin(studentsTable, eq(qrScanLogsTable.studentId, studentsTable.id))
    .orderBy(desc(qrScanLogsTable.createdAt))
    .limit(limit);
  res.json(rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    scannedAt: r.scannedAt ? r.scannedAt.toISOString() : null,
  })));
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
  // ── Phase 6: offline kiosk + geofence + idempotency ──
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  accuracy: z.number().min(0).max(100_000).nullable().optional(),
  /** client-generated idempotency key — replays return the original result */
  nonce: z.string().min(8).max(80).optional(),
  /** when the scan actually happened (ISO) — offline spool syncs may be late */
  scannedAt: z.string().datetime({ offset: true }).optional(),
});

const MAX_SCAN_AGE_MS = 48 * 3600 * 1000; // offline spool hard cap
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

interface ScanCoreInput {
  token: string;
  terminalId: string;
  classroomId?: number;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  nonce?: string;
  scannedAt: Date;
  /** true when this scan arrives from the offline spool flush */
  spooled?: boolean;
  /** admin/staff identity for the audit trail */
  actorAdminId?: number | null;
}

interface ScanCoreOutput {
  httpCode: number;
  payload: Record<string, unknown>;
}

/**
 * Single source of truth for processing one QR scan — shared by the live
 * terminal endpoint (/qr/scan) and the offline spool flush (/qr/scan/batch).
 * Phase 6 hardening, in order:
 *   0. nonce idempotency (offline replays never double-count)
 *   1. scannedAt sanity (48h back / 5min forward cap — no history injection)
 *   2. GEOFENCE: gate-registered terminals with a GPS signature are verified
 *      server-side; outside-radius scans are rejected AND raised as
 *      high-severity fraud signals (kills QR proxying from home).
 *   3. signature/expiry → badge lookup → revoked/version → duplicate → commit
 *   4. proxy-fraud AI runs inline on every committed scan (valid/duplicate).
 */
async function processScanCore(input: ScanCoreInput): Promise<ScanCoreOutput> {
  const now = input.scannedAt;
  const rules = await getArrivalRules();
  const token = input.token.trim();
  const terminalId = input.terminalId || "web";

  const logScan = (
    result: string,
    studentId: number | null,
    issueId: number | null,
    status: string | null,
    detail: Record<string, unknown> = {},
    extra: { latitude?: number | null; longitude?: number | null; accuracy?: number | null; nonce?: string; gateId?: string | null; fraudScore?: number; fraudSignals?: string[] } = {},
  ) =>
    db.insert(qrScanLogsTable).values({
      studentId,
      issueId,
      terminalId,
      gateId: extra.gateId ?? null,
      result,
      status,
      scannedAt: now,
      latitude: extra.latitude ?? null,
      longitude: extra.longitude ?? null,
      accuracy: extra.accuracy ?? null,
      nonce: extra.nonce ?? null,
      fraudScore: extra.fraudScore ?? null,
      fraudSignals: extra.fraudSignals ?? [],
      detail: { ...detail, at: now.toISOString(), spooled: input.spooled ?? false },
    }).returning();

  // 0. Nonce idempotency — the offline kiosk may flush the same scan twice
  //    (crash between commit and local ack). One nonce = one outcome ever.
  if (input.nonce) {
    const [existing] = await db.select()
      .from(qrScanLogsTable)
      .where(eq(qrScanLogsTable.nonce, input.nonce))
      .limit(1);
    if (existing) {
      return {
        httpCode: 200,
        payload: {
          ok: true,
          result: existing.result,
          replayed: true,
          message: `Scan already processed earlier (result: ${existing.result}).`,
        },
      };
    }
  }

  // 1. scannedAt sanity — history injection guard
  const serverNow = Date.now();
  if (now.getTime() < serverNow - MAX_SCAN_AGE_MS) {
    return {
      httpCode: 410,
      payload: {
        ok: false,
        result: "too-old",
        message: "Scan is older than 48h — the offline spool only accepts two days of history.",
      },
    };
  }
  if (now.getTime() > serverNow + FUTURE_TOLERANCE_MS) {
    return {
      httpCode: 400,
      payload: {
        ok: false,
        result: "clock-skew",
        message: "Scan timestamp is in the future — check the terminal clock.",
      },
    };
  }

  // 2. GEOFENCE — resolve the gate this terminal belongs to, then verify GPS
  const gate = await gateForTerminal(terminalId);
  const scanGeo = input.latitude != null && input.longitude != null
    ? { latitude: input.latitude, longitude: input.longitude, accuracy: input.accuracy ?? null }
    : null;
  const geoVerdict = evaluateGeofence(gate, scanGeo);
  if (geoVerdict.enforced && !geoVerdict.allowed && gate) {
    const [logged] = await logScan("geofence-violation", null, null, null, {
      distanceM: geoVerdict.distanceM,
      radiusM: geoVerdict.radiusM,
      tokenPrefix: token.slice(0, 12),
    }, { gateId: gate.gateId, latitude: input.latitude ?? null, longitude: input.longitude ?? null, accuracy: input.accuracy ?? null, nonce: input.nonce });
    await recordGeofenceViolation({
      scanLogId: logged.id,
      studentId: null,
      terminalId,
      gateId: gate.gateId,
      distanceM: geoVerdict.distanceM ?? 0,
      radiusM: geoVerdict.radiusM ?? 0,
      at: now,
    });
    publishEvent("qr.scan", { result: "geofence-violation", terminalId, gateId: gate.gateId, distanceM: geoVerdict.distanceM });
    return {
      httpCode: 403,
      payload: {
        ok: false,
        result: "geofence-violation",
        message: `Scan rejected: you are ${Math.round(geoVerdict.distanceM ?? 0)} m from ${gate.name} (allowed ${geoVerdict.radiusM} m). Attendance only counts at the gate.`,
      },
    };
  }

  // 3. Signature + expiry
  const verdict = verifyQrToken(token);
  if (!verdict.ok) {
    await logScan(verdict.reason, null, null, null, { tokenPrefix: token.slice(0, 12) }, { gateId: gate?.gateId ?? null, latitude: input.latitude ?? null, longitude: input.longitude ?? null, accuracy: input.accuracy ?? null, nonce: input.nonce });
    publishEvent("qr.scan", { result: verdict.reason, terminalId });
    return {
      httpCode: verdict.reason === "expired" ? 410 : 400,
      payload: {
        ok: false,
        result: verdict.reason,
        message: verdict.reason === "expired"
          ? "This QR badge has expired. Ask your homeroom teacher for a new one."
          : verdict.reason === "bad-signature" || verdict.reason === "not-attendx-qr"
            ? "Unrecognized badge — this QR was not issued by AttendX."
            : "Malformed QR payload.",
      },
    };
  }

  const { sid, v } = verdict.payload;

  // 4. Locate the matching issue record by hash
  const tokenHash = hashQrToken(token);
  const [issue] = await db.select().from(qrIssuesTable)
    .where(and(eq(qrIssuesTable.tokenHash, tokenHash), eq(qrIssuesTable.studentId, sid)))
    .limit(1);

  if (!issue) {
    await logScan("unknown-badge", sid, null, null, {}, { gateId: gate?.gateId ?? null, latitude: input.latitude ?? null, longitude: input.longitude ?? null, accuracy: input.accuracy ?? null, nonce: input.nonce });
    publishEvent("qr.scan", { result: "unknown-badge", terminalId, studentId: sid });
    return { httpCode: 404, payload: { ok: false, result: "unknown-badge", message: "Badge not recognized in the system." } };
  }

  if (issue.revoked) {
    await logScan("revoked", sid, issue.id, null, { reason: issue.revokeReason }, { gateId: gate?.gateId ?? null, latitude: input.latitude ?? null, longitude: input.longitude ?? null, accuracy: input.accuracy ?? null, nonce: input.nonce });
    publishEvent("qr.scan", { result: "revoked", terminalId, studentId: sid });
    return { httpCode: 403, payload: { ok: false, result: "revoked", message: "This badge has been revoked. Contact the school office." } };
  }

  if (issue.version !== v) {
    await logScan("stale-version", sid, issue.id, null, { badgeVersion: v, currentVersion: issue.version }, { gateId: gate?.gateId ?? null, latitude: input.latitude ?? null, longitude: input.longitude ?? null, accuracy: input.accuracy ?? null, nonce: input.nonce });
    publishEvent("qr.scan", { result: "stale-version", terminalId, studentId: sid });
    return { httpCode: 409, payload: { ok: false, result: "stale-version", message: "A newer badge was issued — this print is outdated." } };
  }

  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, sid)).limit(1);
  if (!student) {
    await logScan("student-gone", sid, issue.id, null, {}, { gateId: gate?.gateId ?? null, latitude: input.latitude ?? null, longitude: input.longitude ?? null, accuracy: input.accuracy ?? null, nonce: input.nonce });
    return { httpCode: 404, payload: { ok: false, result: "student-gone", message: "Student record missing." } };
  }

  // 5. Duplicate protection — one attendance per badge per SCHOOL day
  //    (day boundaries follow the configured attendance timezone, applied at
  //    the ORIGINAL scan time for offline spool replays)
  const { startUtc: dayStart } = localDayBounds(now, rules.timezone);
  const [existing] = await db.select().from(attendanceLogsTable)
    .where(and(eq(attendanceLogsTable.studentId, sid), gte(attendanceLogsTable.markedAt, dayStart)))
    .limit(1);

  if (existing) {
    await db.update(qrIssuesTable).set({ scans: sql`${qrIssuesTable.scans} + 1`, lastScanAt: now }).where(eq(qrIssuesTable.id, issue.id));
    const [scanLog] = await logScan("duplicate", sid, issue.id, existing.status, { attendanceId: existing.id }, { gateId: gate?.gateId ?? null, latitude: input.latitude ?? null, longitude: input.longitude ?? null, accuracy: input.accuracy ?? null, nonce: input.nonce });
    publishEvent("qr.scan", { result: "duplicate", terminalId, studentId: sid, studentName: student.name });
    // Badge-sharing patterns often surface as duplicates at another terminal.
    const fraud = await analyzeScanForFraud({
      scanLogId: scanLog.id,
      studentId: sid,
      terminalId,
      gateId: gate?.gateId ?? null,
      scanGeo,
      scannedAt: now,
    });
    if (fraud.kinds.length) {
      await db.update(qrScanLogsTable).set({ fraudScore: fraud.score, fraudSignals: fraud.kinds }).where(eq(qrScanLogsTable.id, scanLog.id));
    }
    return {
      httpCode: 200,
      payload: {
        ok: true,
        result: "duplicate",
        alreadyMarked: true,
        student: { id: student.id, name: student.name, studentId: student.studentId, classroomId: student.classroomId },
        attendance: { id: existing.id, status: existing.status, checkedOutAt: existing.checkedOutAt?.toISOString() ?? null },
        message: `${student.name} already checked in today (${existing.status}).`,
        fraudScore: fraud.score,
      },
    };
  }

  // 6. Commit attendance — present/late decided by the admin's entrance rules
  //    evaluated at the original scan time
  const status = attendanceStatusForNow(now, rules);
  const [log] = await db.insert(attendanceLogsTable).values({
    studentId: sid,
    classroomId: input.classroomId ?? student.classroomId,
    status,
    method: "qr",
    source: terminalId !== "web" ? "qr-terminal" : "qr-web",
    confidence: null,
    notes: `QR ${issue.serial}${input.spooled ? " · offline-sync" : ""}`,
    markedAt: now,
  }).returning();

  await db.update(qrIssuesTable).set({ scans: sql`${qrIssuesTable.scans} + 1`, lastScanAt: now }).where(eq(qrIssuesTable.id, issue.id));
  const [scanLog] = await logScan("valid", sid, issue.id, status, { attendanceId: log.id, serial: issue.serial }, { gateId: gate?.gateId ?? null, latitude: input.latitude ?? null, longitude: input.longitude ?? null, accuracy: input.accuracy ?? null, nonce: input.nonce });
  publishEvent("qr.scan", { result: "valid", terminalId, studentId: sid, studentName: student.name, status, serial: issue.serial });
  publishEvent("attendance.created", {
    studentId: sid,
    studentName: student.name,
    status,
    method: "qr",
    source: terminalId !== "web" ? "qr-terminal" : "qr-web",
    classroomId: log.classroomId,
    markedAt: log.markedAt.toISOString(),
  });

  // 7. Proxy-fraud AI — inline, non-blocking for correctness (errors swallowed)
  const fraud = await analyzeScanForFraud({
    scanLogId: scanLog.id,
    studentId: sid,
    terminalId,
    gateId: gate?.gateId ?? null,
    scanGeo,
    scannedAt: now,
  });
  if (fraud.kinds.length) {
    await db.update(qrScanLogsTable).set({ fraudScore: fraud.score, fraudSignals: fraud.kinds }).where(eq(qrScanLogsTable.id, scanLog.id));
  }

  // 8. Audit trail + late-arrival parent SMS (unchanged Phase 3/4 behavior)
  await writeAudit({
    actorAdminId: input.actorAdminId ?? null,
    action: "attendance.qr.committed",
    targetType: "attendance",
    targetId: log.id,
    payload: { studentId: sid, serial: issue.serial, terminalId, status, spooled: input.spooled ?? false },
  });

  if (status === "late") {
    const { enqueueJob } = await import("../lib/jobs");
    await enqueueJob({ type: "send_sms", worker: "api", payload: { studentId: sid, status } });
  }

  return {
    httpCode: 201,
    payload: {
      ok: true,
      result: "valid",
      alreadyMarked: false,
      student: { id: student.id, name: student.name, studentId: student.studentId, classroomId: student.classroomId },
      attendance: { id: log.id, status, markedAt: log.markedAt.toISOString() },
      message: status === "late" ? `Late check-in recorded for ${student.name}.` : `Welcome, ${student.name}! Attendance marked.`,
      fraudScore: fraud.score,
      fraudSignals: fraud.kinds,
    },
  };
}

router.post("/qr/scan", requireStaff, async (req, res): Promise<void> => {
  const parsed = scanInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const outcome = await processScanCore({
    token: parsed.data.token,
    terminalId: parsed.data.terminalId || "web",
    classroomId: parsed.data.classroomId,
    latitude: parsed.data.latitude ?? null,
    longitude: parsed.data.longitude ?? null,
    accuracy: parsed.data.accuracy ?? null,
    nonce: parsed.data.nonce,
    scannedAt: parsed.data.scannedAt ? new Date(parsed.data.scannedAt) : new Date(),
    spooled: false,
    actorAdminId: adminId(req)?.adminId ?? null,
  });
  res.status(outcome.httpCode).json(outcome.payload);
});

// ── Offline spool flush (dead-WiFi kiosks sync here) ───────────
const batchInput = z.object({
  scans: z.array(scanInput).min(1).max(200),
});

/**
 * POST /qr/scan/batch — the offline kiosk flushes its IndexedDB spool here
 * when WiFi returns. Each scan carries its nonce (server dedupes) and the
 * ORIGINAL scan timestamp (attendance counts at the door time, capped at
 * 48h). Per-scan failures never abort the batch — the kiosk marks each
 * entry resolved/failed from the per-item result.
 */
router.post("/qr/scan/batch", requireStaff, async (req, res): Promise<void> => {
  const parsed = batchInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const results: Array<Record<string, unknown>> = [];
  for (const scan of parsed.data.scans) {
    try {
      const outcome = await processScanCore({
        token: scan.token,
        terminalId: scan.terminalId || "web",
        classroomId: scan.classroomId,
        latitude: scan.latitude ?? null,
        longitude: scan.longitude ?? null,
        accuracy: scan.accuracy ?? null,
        nonce: scan.nonce,
        scannedAt: scan.scannedAt ? new Date(scan.scannedAt) : new Date(),
        spooled: true,
        actorAdminId: adminId(req)?.adminId ?? null,
      });
      results.push({
        nonce: scan.nonce ?? null,
        ok: outcome.httpCode < 400,
        result: outcome.payload.result ?? null,
        httpCode: outcome.httpCode,
        message: outcome.payload.message ?? null,
        studentName: (outcome.payload.student as { name?: string } | undefined)?.name ?? null,
        attendanceId: (outcome.payload.attendance as { id?: number } | undefined)?.id ?? null,
      });
    } catch (err) {
      results.push({
        nonce: scan.nonce ?? null,
        ok: false,
        result: "server-error",
        httpCode: 500,
        message: err instanceof Error ? err.message.slice(0, 160) : "scan processing failed",
      });
    }
  }

  const accepted = results.filter((r) => r.ok).length;
  res.status(200).json({
    ok: true,
    accepted,
    total: results.length,
    rejected: results.length - accepted,
    results,
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
