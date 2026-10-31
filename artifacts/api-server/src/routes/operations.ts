import { Router, type Request } from "express";
import { and, desc, eq, gte } from "drizzle-orm";
import {
  db,
  adminsTable,
  auditLogsTable,
  attendanceLogsTable,
  classroomsTable,
  matchReviewsTable,
  studentsTable,
} from "@workspace/db";
import { z } from "zod/v4";
import { requireAuth } from "../lib/auth";
import { enqueueJob } from "../lib/jobs";
import { writeAudit } from "../lib/audit";
import { getSystemSettings, setSettings, setSystemSetting } from "../lib/system-settings";

const router = Router();
const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId;
const settingsInput = z.object({
  confidenceThreshold: z.number().min(0.1).max(0.99).optional(),
  reviewRetentionDays: z.number().int().min(1).max(365).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one setting is required");
const fanInput = z.object({ mode: z.enum(["auto", "on", "off"]) });
const decisionInput = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).nullable().optional(),
});

router.get("/audit-logs", requireAuth, async (req, res): Promise<void> => {
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

router.patch("/system/settings", requireAuth, async (req, res): Promise<void> => {
  const parsed = settingsInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setSettings(parsed.data);
  await writeAudit({
    actorAdminId: adminId(req),
    action: "system.settings.updated",
    targetType: "system_settings",
    payload: parsed.data,
  });
  res.json(await getSystemSettings());
});

router.post("/system/fan-override", requireAuth, async (req, res): Promise<void> => {
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

router.get("/reviews", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
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
    .where(eq(matchReviewsTable.status, "pending"))
    .orderBy(matchReviewsTable.createdAt)
    .limit(100);
  res.json(rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })));
});

router.post("/reviews/:id/decision", requireAuth, async (req, res): Promise<void> => {
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
  const purgeAt = new Date(reviewedAt.getTime() + settings.reviewRetentionDays * 24 * 60 * 60 * 1000);

  if (parsed.data.decision === "approve") {
    if (!review.studentId) {
      res.status(400).json({ error: "This match has no suggested student and cannot be approved" });
      return;
    }
    const startOfDay = new Date(reviewedAt);
    startOfDay.setHours(0, 0, 0, 0);
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
      const status = reviewedAt.getHours() > 8 || (reviewedAt.getHours() === 8 && reviewedAt.getMinutes() > 15)
        ? "late"
        : "present";
      const [created] = await db.insert(attendanceLogsTable).values({
        studentId: review.studentId,
        classroomId: review.classroomId,
        status,
        method: "face",
        source: "gate-camera",
        confidence: review.confidence,
      }).returning();
      attendance = { id: created.id, status, alreadyMarked: false };
      if (status === "late") {
        await enqueueJob({ type: "send_sms", worker: "api", payload: { studentId: review.studentId, status } });
      }
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
    status: parsed.data.decision === "approve" ? "approved" : "rejected",
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

router.get("/dashboard/confidence-heatmap", requireAuth, async (_req, res): Promise<void> => {
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

export default router;
