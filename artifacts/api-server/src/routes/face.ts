import { Router } from "express";
import { db, studentsTable, faceEncodingsTable, attendanceLogsTable, matchReviewsTable, classroomSeatsTable } from "@workspace/db";
import { eq, and, gte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAuth, requireStaff } from "../lib/auth";
import { enqueueAttendanceSms } from "../lib/jobs";
import { writeAudit } from "../lib/audit";
import { findClosestFaceMatch, findClosestFaceMatchAll } from "../lib/face-matching";
import { getSystemSettings } from "../lib/system-settings";
import { arrivalRulesFromSettings, resolveArrivalStatus, localDayBounds } from "../lib/attendance-rules";
import { publishEvent } from "../lib/events";

const router = Router();

router.post("/face/encode", requireStaff, async (req, res): Promise<void> => {
  const { studentId, faceDescriptor } = req.body;
  if (!studentId) { res.status(400).json({ error: "studentId required" }); return; }
  const parsedDescriptor = z.array(z.number().finite()).length(128).safeParse(faceDescriptor);
  if (!parsedDescriptor.success) { res.status(400).json({ error: "A valid 128-value face descriptor is required" }); return; }

  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, Number(studentId)));
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }

  const descriptor = parsedDescriptor.data;

  const encodingJson = JSON.stringify(descriptor);

  const existing = await db.select().from(faceEncodingsTable).where(eq(faceEncodingsTable.studentId, Number(studentId)));
  if (existing.length > 0) {
    await db.update(faceEncodingsTable).set({ encoding: encodingJson }).where(eq(faceEncodingsTable.studentId, Number(studentId)));
  } else {
    await db.insert(faceEncodingsTable).values({ studentId: Number(studentId), encoding: encodingJson });
  }

  res.json({ success: true, message: `Face data saved for ${student.name}` });
});

router.post("/face/recognize", requireStaff, async (req, res): Promise<void> => {
  const { faceDescriptor, classroomId } = req.body;
  const parsedDescriptor = z.array(z.number().finite()).length(128).safeParse(faceDescriptor);
  if (!parsedDescriptor.success) {
    res.status(400).json({ error: "A valid 128-value face descriptor is required" });
    return;
  }

  const settings = await getSystemSettings();
  const rules = arrivalRulesFromSettings(settings);

  const allEncodings = await db
    .select({ studentId: faceEncodingsTable.studentId, encoding: faceEncodingsTable.encoding })
    .from(faceEncodingsTable);

  if (!allEncodings.length) {
    res.status(404).json({ error: "No face encodings registered in the system" });
    return;
  }

  const bestMatch = findClosestFaceMatch(parsedDescriptor.data, allEncodings);

  // Hard floor: below this distance confidence is meaningless
  const ABSOLUTE_FLOOR = 0.30;
  // Accept threshold from system settings (default 0.72)
  const ACCEPT_THRESHOLD = settings.confidenceThreshold;

  if (!bestMatch || bestMatch.confidence < ABSOLUTE_FLOOR) {
    res.status(404).json({ error: "No matching student found" });
    return;
  }

  const confidence = bestMatch.confidence;

  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, bestMatch.studentId));
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }

  // Expected seat tie-breaker hint (never auto-applied)
  const [seat] = await db
    .select({ seatLabel: classroomSeatsTable.seatLabel })
    .from(classroomSeatsTable)
    .where(eq(classroomSeatsTable.studentId, student.id))
    .limit(1);
  const expectedSeat = seat?.seatLabel ?? null;

  // "Today" means the school's local day in the configured timezone (Phase 4)
  const { startUtc: todayStart } = localDayBounds(new Date(), rules.timezone);
  const existing = await db
    .select()
    .from(attendanceLogsTable)
    .where(and(eq(attendanceLogsTable.studentId, student.id), gte(attendanceLogsTable.markedAt, todayStart)));

  if (existing.length > 0) {
    res.json({
      studentId: student.id,
      studentName: student.name,
      confidence,
      expectedSeat,
      attendanceId: existing[0].id,
      alreadyMarked: true,
      status: existing[0].status,
    });
    return;
  }

  // ── Ambiguous match: below accept threshold → send to review queue ──
  if (confidence < ACCEPT_THRESHOLD) {
    const now = new Date();
    const [review] = await db.insert(matchReviewsTable).values({
      studentId: student.id,
      classroomId: classroomId ? Number(classroomId) : student.classroomId,
      descriptor: parsedDescriptor.data,
      confidence,
      source: "webcam",
      status: "pending",
      purgeAt: new Date(now.getTime() + settings.reviewRetentionDays * 24 * 60 * 60 * 1000),
    }).returning();

    const candidates = findClosestFaceMatchAll(parsedDescriptor.data, allEncodings, 3);
    publishEvent("review.created", {
      reviewId: review.id,
      studentId: student.id,
      studentName: student.name,
      confidence,
      expectedSeat,
    });

    res.status(202).json({
      sentToReview: true,
      reviewId: review.id,
      studentId: student.id,
      studentName: student.name,
      confidence,
      expectedSeat,
      candidates,
      message: `Ambiguous match (${(confidence * 100).toFixed(0)}%) — ${student.name} sent to review queue.`,
    });
    return;
  }

  // ── Confident match: commit attendance ──
  const now = new Date();
  const status = resolveArrivalStatus(now, rules);

  const [log] = await db.insert(attendanceLogsTable).values({
    studentId: student.id,
    classroomId: classroomId ? Number(classroomId) : student.classroomId,
    status,
    method: "face",
    source: "webcam",
    confidence,
  }).returning();

  await enqueueAttendanceSms(student.id, status, log.markedAt);
  const actor = (req as typeof req & { admin?: { adminId?: number } }).admin;
  await writeAudit({
    actorAdminId: actor?.adminId,
    action: "attendance.face.committed",
    targetType: "attendance",
    targetId: log.id,
    payload: { studentId: student.id, source: "webcam", confidence, status },
  });

  publishEvent("attendance.created", {
    studentId: student.id,
    studentName: student.name,
    status,
    method: "face",
    source: "webcam",
    confidence,
    classroomId: log.classroomId,
    markedAt: log.markedAt.toISOString(),
  });

  res.json({
    studentId: student.id,
    studentName: student.name,
    confidence,
    expectedSeat,
    attendanceId: log.id,
    alreadyMarked: false,
    status,
  });
});

export default router;
