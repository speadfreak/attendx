import { Router, type Request } from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import {
  db,
  adminsTable,
  auditLogsTable,
  attendanceLogsTable,
  classroomsTable,
  faceEncodingsTable,
  matchReviewsTable,
  studentsTable,
  classroomSeatsTable,
} from "@workspace/db";
import { z } from "zod/v4";
import { requireAuth, requireStaff, requireAdminLevel } from "../lib/auth";
import { enqueueAttendanceSms, enqueueJob } from "../lib/jobs";
import { writeAudit } from "../lib/audit";
import { getSystemSettings, setSettings, setSystemSetting, hhmmToMinutes, isValidTimezone } from "../lib/system-settings";
import { invalidateSmsSettingsCache } from "../lib/sms";
import { arrivalRulesFromSettings, resolveArrivalStatus, isPastAbsenceCutoff, localDayBounds } from "../lib/attendance-rules";
import { findClosestFaceMatchAll } from "../lib/face-matching";
import { publishEvent } from "../lib/events";
import { getSmsTemplates } from "../lib/sms-templates";

const router = Router();
const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId;
const timeField = z.string().regex(/^([01]?\d|2[0-3]):([0-5]\d)$/, "Expected HH:mm (24h), e.g. 08:15");
const settingsInput = z.object({
  confidenceThreshold: z.number().min(0.1).max(0.99).optional(),
  reviewRetentionDays: z.number().int().min(1).max(365).optional(),
  // ── Phase 4 attendance time rules ──
  entranceTime: timeField.optional(),
  lateCutoffTime: timeField.optional(),
  absenceCutoffTime: timeField.optional(),
  attendanceTimezone: z.string().trim().min(2).max(64).optional(),
  // ── Phase 4 gate integrity ──
  gateDiscrepancyPct: z.number().min(1).max(100).optional(),
  gateWindowSeconds: z.number().int().min(15).max(300).optional(),
  gateActiveFrom: timeField.optional(),
  gateActiveTo: timeField.optional(),
  // ── Phase 5 SMS delivery (Operations → SMS Health) ──
  smsChannelMode: z.enum(["sms", "whatsapp", "auto"]).optional(),
  // Empty string clears the stored value; MG… must be a full Twilio service SID
  smsMessagingServiceSid: z.union([z.literal(""), z.string().trim().regex(/^MG[0-9a-fA-F]{32}$/, "Expected a Twilio Messaging Service SID (MG…)")]).optional(),
  smsFromNumber: z.union([z.literal(""), z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Expected E.164, e.g. +18312826811")]).optional(),
  smsDefaultCountry: z.string().trim().regex(/^\+[1-9]\d{0,2}$/, "Expected country code, e.g. +251").optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one setting is required");
const fanInput = z.object({ mode: z.enum(["auto", "on", "off"]) });
const decisionInput = z.object({
  decision: z.enum(["approve", "reject", "reassign"]),
  studentId: z.number().int().positive().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

router.get("/audit-logs", requireAdminLevel, async (req, res): Promise<void> => {
  const rawLimit = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 100;
  const rows = await db.select({
    id: auditLogsTable.id,
    actorAdminId: auditLogsTable.actorAdminId,
    actorName: adminsTable.name,
    action: auditLogsTable.action,
    targetType: auditLogsTable.targetType,
    targetId: auditLogsTable.targetId,
    payload: auditLogsTable.payload,
    createdAt: auditLogsTable.createdAt,
  }).from(auditLogsTable)
    .leftJoin(adminsTable, eq(auditLogsTable.actorAdminId, adminsTable.id))
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limit);
  res.json(rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })));
});

router.get("/system/settings", requireAuth, async (_req, res): Promise<void> => {
  res.json(await getSystemSettings());
});

router.patch("/system/settings", requireAdminLevel, async (req, res): Promise<void> => {
  const parsed = settingsInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.attendanceTimezone && !isValidTimezone(parsed.data.attendanceTimezone)) {
    res.status(400).json({ error: `Unknown IANA timezone: ${parsed.data.attendanceTimezone}` });
    return;
  }
  // Sensible ordering: entrance → late → absence must move forward together
  const current = await getSystemSettings();
  const minutes = {
    entranceTime: parsed.data.entranceTime ?? current.entranceTime,
    lateCutoffTime: parsed.data.lateCutoffTime ?? current.lateCutoffTime,
    absenceCutoffTime: parsed.data.absenceCutoffTime ?? current.absenceCutoffTime,
  };
  const entrance = hhmmToMinutes(minutes.entranceTime) ?? 0;
  const late = hhmmToMinutes(minutes.lateCutoffTime) ?? 0;
  const absence = hhmmToMinutes(minutes.absenceCutoffTime) ?? 0;
  if (entrance > late) {
    res.status(400).json({ error: "entranceTime must be at or before lateCutoffTime" });
    return;
  }
  if (late > absence) {
    res.status(400).json({ error: "lateCutoffTime must be at or before absenceCutoffTime" });
    return;
  }
  await setSettings(parsed.data);
  invalidateSmsSettingsCache();
  await writeAudit({
    actorAdminId: adminId(req),
    action: "system.settings.updated",
    targetType: "system_settings",
    payload: parsed.data,
  });
  publishEvent("settings.updated", { keys: Object.keys(parsed.data) });
  res.json(await getSystemSettings());
});

router.post("/system/fan-override", requireAdminLevel, async (req, res): Promise<void> => {
  const parsed = fanInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setSystemSetting("fanMode", parsed.data.mode);
  const job = await enqueueJob({
    type: "fan_override",
    worker: "pi",
    payload: { mode: parsed.data.mode },
  });
  await writeAudit({
    actorAdminId: adminId(req),
    action: "fan.override.queued",
    targetType: "job",
    targetId: job.id,
    payload: { mode: parsed.data.mode },
  });
  res.status(201).json(job);
});

router.get("/reviews", requireStaff, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: matchReviewsTable.id,
      studentId: matchReviewsTable.studentId,
      studentName: studentsTable.name,
      studentRef: studentsTable.studentId,
      classroomId: matchReviewsTable.classroomId,
      classroomName: classroomsTable.name,
      confidence: matchReviewsTable.confidence,
      source: matchReviewsTable.source,
      status: matchReviewsTable.status,
      createdAt: matchReviewsTable.createdAt,
    })
    .from(matchReviewsTable)
    .leftJoin(studentsTable, eq(matchReviewsTable.studentId, studentsTable.id))
    .leftJoin(classroomsTable, eq(matchReviewsTable.classroomId, classroomsTable.id))
    .where(eq(matchReviewsTable.status, "pending"))
    .orderBy(matchReviewsTable.createdAt)
    .limit(100);

  // Seat-position tie-breaker hint: expected seat of the suggested student
  const seatRows = await db
    .select({ studentId: classroomSeatsTable.studentId, seatLabel: classroomSeatsTable.seatLabel, classroomId: classroomSeatsTable.classroomId })
    .from(classroomSeatsTable);
  const seatFor = (studentId: number | null, classroomId: number | null) =>
    seatRows.find((s) => s.studentId === studentId && (!classroomId || s.classroomId === classroomId))?.seatLabel ?? null;

  res.json(rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    expectedSeat: seatFor(row.studentId, row.classroomId),
    hasFaceData: true,
  })));
});


// ── Top-3 candidate matches for an ambiguous face capture ───────
router.get("/reviews/:id/candidates", requireStaff, async (req, res): Promise<void> => {
  const reviewId = Number(req.params.id);
  if (!Number.isInteger(reviewId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [review] = await db.select().from(matchReviewsTable).where(eq(matchReviewsTable.id, reviewId)).limit(1);
  if (!review) { res.status(404).json({ error: "Review not found" }); return; }

  let descriptor: number[] | null = null;
  if (Array.isArray(review.descriptor)) descriptor = review.descriptor as number[];

  const encodings = await db
    .select({ studentId: faceEncodingsTable.studentId, encoding: faceEncodingsTable.encoding })
    .from(faceEncodingsTable);

  let candidates: Array<{ studentId: number; name: string; studentRef: string; distance: number; confidence: number }> = [];
  if (descriptor) {
    const matches = findClosestFaceMatchAll(descriptor, encodings);
    const studentsById = new Map<number, { name: string; studentRef: string }>();
    if (matches.length) {
      const rows = await db
        .select({ id: studentsTable.id, name: studentsTable.name, studentRef: studentsTable.studentId })
        .from(studentsTable);
      for (const r of rows) studentsById.set(r.id, { name: r.name, studentRef: r.studentRef });
    }
    candidates = matches.map((m) => ({
      studentId: m.studentId,
      name: studentsById.get(m.studentId)?.name ?? "Unknown",
      studentRef: studentsById.get(m.studentId)?.studentRef ?? String(m.studentId),
      distance: Math.round(m.distance * 1000) / 1000,
      confidence: Math.round(m.confidence * 1000) / 1000,
    }));
  }

  // expected seat of the suggested student (tie-breaker hint only)
  const [seat] = review.studentId
    ? await db
        .select({ seatLabel: classroomSeatsTable.seatLabel })
        .from(classroomSeatsTable)
        .where(eq(classroomSeatsTable.studentId, review.studentId))
        .limit(1)
    : [];

  res.json({
    reviewId,
    expectedSeat: seat?.seatLabel ?? null,
    candidates,
    hasDescriptor: !!descriptor,
  });
});

router.post("/reviews/:id/decision", requireStaff, async (req, res): Promise<void> => {
  const reviewId = Number(req.params.id);
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    res.status(400).json({ error: "Invalid review id" });
    return;
  }
  const parsed = decisionInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [review] = await db.select().from(matchReviewsTable).where(eq(matchReviewsTable.id, reviewId)).limit(1);
  if (!review) {
    res.status(404).json({ error: "Review not found" });
    return;
  }
  if (review.status !== "pending") {
    res.status(409).json({ error: "This review has already been decided" });
    return;
  }

  let attendance: Record<string, unknown> | null = null;
  const reviewedAt = new Date();
  const settings = await getSystemSettings();
  const rules = arrivalRulesFromSettings(settings);
  const purgeAt = new Date(reviewedAt.getTime() + settings.reviewRetentionDays * 24 * 60 * 60 * 1000);

  if (parsed.data.decision === "reassign") {
    if (!parsed.data.studentId) {
      res.status(400).json({ error: "studentId is required when reassigning" });
      return;
    }
    const [target] = await db.select().from(studentsTable).where(eq(studentsTable.id, parsed.data.studentId)).limit(1);
    if (!target) { res.status(404).json({ error: "Reassign target student not found" }); return; }
    const { startUtc: startOfDay } = localDayBounds(reviewedAt, rules.timezone);
    const [existingAttendance] = await db
      .select({ id: attendanceLogsTable.id, status: attendanceLogsTable.status })
      .from(attendanceLogsTable)
      .where(and(eq(attendanceLogsTable.studentId, target.id), gte(attendanceLogsTable.markedAt, startOfDay)))
      .limit(1);
    if (existingAttendance) {
      attendance = { id: existingAttendance.id, status: existingAttendance.status, alreadyMarked: true, studentId: target.id };
    } else {
      const status = resolveArrivalStatus(reviewedAt, rules);
      const [created] = await db.insert(attendanceLogsTable).values({
        studentId: target.id,
        classroomId: target.classroomId,
        status,
        method: "face",
        source: "gate-camera",
        confidence: review.confidence,
        notes: `reassigned from review #${reviewId}`,
      }).returning();
      attendance = { id: created.id, status, alreadyMarked: false, studentId: target.id };
      await enqueueAttendanceSms(target.id, status, created.markedAt);
    }
    await db.update(matchReviewsTable).set({ studentId: target.id }).where(eq(matchReviewsTable.id, reviewId));
    await writeAudit({
      actorAdminId: adminId(req),
      action: "face_match.reassigned",
      targetType: "match_review",
      targetId: reviewId,
      payload: { from: review.studentId, to: target.id, confidence: review.confidence },
    });
  }

  if (parsed.data.decision === "approve") {
    if (!review.studentId) {
      res.status(400).json({ error: "This match has no suggested student and cannot be approved" });
      return;
    }
    const { startUtc: startOfDay } = localDayBounds(reviewedAt, rules.timezone);
    const [existingAttendance] = await db
      .select({ id: attendanceLogsTable.id, status: attendanceLogsTable.status })
      .from(attendanceLogsTable)
      .where(and(
        eq(attendanceLogsTable.studentId, review.studentId),
        gte(attendanceLogsTable.markedAt, startOfDay),
      ))
      .limit(1);
    if (existingAttendance) {
      attendance = { id: existingAttendance.id, status: existingAttendance.status, alreadyMarked: true };
    } else {
      const status = resolveArrivalStatus(reviewedAt, rules);
      const [created] = await db.insert(attendanceLogsTable).values({
        studentId: review.studentId,
        classroomId: review.classroomId,
        status,
        method: "face",
        source: "gate-camera",
        confidence: review.confidence,
      }).returning();
      attendance = { id: created.id, status, alreadyMarked: false };
      await enqueueAttendanceSms(review.studentId, status, created.markedAt);
      await writeAudit({
        actorAdminId: adminId(req),
        action: "attendance.gate_camera.approved",
        targetType: "attendance",
        targetId: created.id,
        payload: { reviewId, studentId: review.studentId, confidence: review.confidence },
      });
    }
  }

  await db.update(matchReviewsTable).set({
    status: parsed.data.decision === "approve" ? "approved" : parsed.data.decision === "reassign" ? "reassigned" : "rejected",
    descriptor: null,
    reviewedByAdminId: adminId(req) ?? null,
    reviewNote: parsed.data.note ?? null,
    reviewedAt,
    purgeAt,
  }).where(eq(matchReviewsTable.id, reviewId));

  await writeAudit({
    actorAdminId: adminId(req),
    action: parsed.data.decision === "approve" ? "face_match.low_confidence.approved" : "face_match.low_confidence.rejected",
    targetType: "match_review",
    targetId: reviewId,
    payload: { studentId: review.studentId, confidence: review.confidence },
  });

  publishEvent("review.decided", { reviewId, decision: parsed.data.decision, studentId: review.studentId });

  const [updatedReview] = await db
    .select({
      id: matchReviewsTable.id,
      studentId: matchReviewsTable.studentId,
      studentName: studentsTable.name,
      classroomId: matchReviewsTable.classroomId,
      classroomName: classroomsTable.name,
      confidence: matchReviewsTable.confidence,
      source: matchReviewsTable.source,
      status: matchReviewsTable.status,
      createdAt: matchReviewsTable.createdAt,
    })
    .from(matchReviewsTable)
    .leftJoin(studentsTable, eq(matchReviewsTable.studentId, studentsTable.id))
    .leftJoin(classroomsTable, eq(matchReviewsTable.classroomId, classroomsTable.id))
    .where(eq(matchReviewsTable.id, reviewId))
    .limit(1);

  res.json({
    review: { ...updatedReview, createdAt: updatedReview.createdAt.toISOString() },
    attendance,
  });
});

router.get("/dashboard/confidence-heatmap", requireAdminLevel, async (_req, res): Promise<void> => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [lowConfidenceRows, committedRows] = await Promise.all([
    db.select({
      studentId: matchReviewsTable.studentId,
      classroomId: matchReviewsTable.classroomId,
      createdAt: matchReviewsTable.createdAt,
      classroomName: classroomsTable.name,
      studentName: studentsTable.name,
    })
      .from(matchReviewsTable)
      .leftJoin(studentsTable, eq(matchReviewsTable.studentId, studentsTable.id))
      .leftJoin(classroomsTable, eq(matchReviewsTable.classroomId, classroomsTable.id))
      .where(gte(matchReviewsTable.createdAt, cutoff)),
    db.select({
      studentId: attendanceLogsTable.studentId,
      classroomId: attendanceLogsTable.classroomId,
      markedAt: attendanceLogsTable.markedAt,
      classroomName: classroomsTable.name,
      studentName: studentsTable.name,
    })
      .from(attendanceLogsTable)
      .leftJoin(studentsTable, eq(attendanceLogsTable.studentId, studentsTable.id))
      .leftJoin(classroomsTable, eq(attendanceLogsTable.classroomId, classroomsTable.id))
      .where(and(
        eq(attendanceLogsTable.source, "gate-camera"),
        gte(attendanceLogsTable.markedAt, cutoff),
      )),
  ]);

  const buckets = new Map<string, {
    day: string;
    studentId: number | null;
    studentName: string | null;
    classroomId: number | null;
    classroomName: string | null;
    lowConfidenceMatches: number;
    totalMatches: number;
  }>();
  const keyFor = (day: string, studentId: number | null, classroomId: number | null) => `${day}:${studentId ?? "none"}:${classroomId ?? "none"}`;
  for (const row of committedRows) {
    const day = row.markedAt.toISOString().slice(0, 10);
    const key = keyFor(day, row.studentId, row.classroomId);
    const bucket = buckets.get(key) ?? {
      day,
      studentId: row.studentId,
      studentName: row.studentName,
      classroomId: row.classroomId,
      classroomName: row.classroomName,
      lowConfidenceMatches: 0,
      totalMatches: 0,
    };
    bucket.totalMatches++;
    buckets.set(key, bucket);
  }
  for (const row of lowConfidenceRows) {
    const day = row.createdAt.toISOString().slice(0, 10);
    const key = keyFor(day, row.studentId, row.classroomId);
    const bucket = buckets.get(key) ?? {
      day,
      studentId: row.studentId,
      studentName: row.studentName,
      classroomId: row.classroomId,
      classroomName: row.classroomName,
      lowConfidenceMatches: 0,
      totalMatches: 0,
    };
    bucket.lowConfidenceMatches++;
    bucket.totalMatches++;
    buckets.set(key, bucket);
  }

  res.json(Array.from(buckets.values()).map((row) => ({
    ...row,
    lowConfidenceRate: row.totalMatches ? row.lowConfidenceMatches / row.totalMatches : 0,
  })).sort((a, b) => b.day.localeCompare(a.day)));
});

// ── End-of-day absent sweep: wire the absent SMS template in ────
router.post("/attendance/absent-sweep", requireAdminLevel, async (req, res): Promise<void> => {
  const rules = arrivalRulesFromSettings(await getSystemSettings());
  const now = new Date();

  // Phase 4: the sweep only fires once local time passes absenceCutoffTime —
  // "no record yet" before that point is NOT an absence. force bypasses the
  // guard for end-of-day manual runs.
  const force = req.body?.force === true;
  if (!force && !isPastAbsenceCutoff(now, rules)) {
    res.status(409).json({
      error: `Absence sweep is locked until ${rules.absenceCutoffTime} (${rules.timezone}) — students may still be arriving. Send {"force": true} to override.`,
      absenceCutoffTime: rules.absenceCutoffTime,
      timezone: rules.timezone,
    });
    return;
  }

  const { startUtc: todayStart, endUtc: todayEnd } = localDayBounds(now, rules.timezone);

  const allStudents = await db.select({ id: studentsTable.id, name: studentsTable.name, classroomId: studentsTable.classroomId }).from(studentsTable);
  const presentToday = await db
    .select({ studentId: attendanceLogsTable.studentId })
    .from(attendanceLogsTable)
    .where(and(gte(attendanceLogsTable.markedAt, todayStart), lte(attendanceLogsTable.markedAt, todayEnd)));
  const presentSet = new Set(presentToday.map((p) => p.studentId));
  const missing = allStudents.filter((s) => !presentSet.has(s.id));

  let smsQueued = 0;
  for (const student of missing) {
    const [log] = await db.insert(attendanceLogsTable).values({
      studentId: student.id,
      classroomId: student.classroomId,
      status: "absent",
      method: "manual",
      source: "manual",
      notes: "absent sweep",
    }).returning();
    await enqueueAttendanceSms(student.id, "absent", log.markedAt);
    smsQueued++;
    publishEvent("attendance.created", { studentId: student.id, studentName: student.name, status: "absent", method: "manual" });
    await writeAudit({
      actorAdminId: adminId(req),
      action: "attendance.absent_sweep.marked",
      targetType: "attendance",
      targetId: log.id,
      payload: { studentId: student.id },
    });
  }

  res.json({ markedAbsent: missing.length, smsQueued, students: missing.map((m) => ({ id: m.id, name: m.name })) });
});

// ── SMS template management ─────────────────────────────────────
router.get("/sms-templates", requireAuth, async (_req, res): Promise<void> => {
  res.json(await getSmsTemplates());
});

router.put("/sms-templates", requireAdminLevel, async (req, res): Promise<void> => {
  const parsed = z.object({
    present: z.string().min(1).max(400).optional(),
    late: z.string().min(1).max(400).optional(),
    absent: z.string().min(1).max(400).optional(),
  }).refine((v) => Object.keys(v).length > 0, "At least one template is required").safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  for (const [key, value] of Object.entries(parsed.data)) {
    await setSystemSetting(`sms_template_${key}`, value);
  }
  await writeAudit({
    actorAdminId: adminId(req),
    action: "sms.templates.updated",
    targetType: "system_settings",
    payload: { keys: Object.keys(parsed.data) },
  });
  publishEvent("settings.updated", { smsTemplates: Object.keys(parsed.data) });
  res.json(await getSmsTemplates());
});

export default router;
