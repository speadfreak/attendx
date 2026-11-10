import { Router } from "express";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import {
  db,
  attendanceLogsTable,
  faceEncodingsTable,
  jobsTable,
  matchReviewsTable,
  studentsTable,
} from "@workspace/db";
import { z } from "zod/v4";
import { requirePiToken, type PiAuthenticatedRequest } from "../lib/pi-auth";
import { findClosestFaceMatch } from "../lib/face-matching";
import { getSystemSettings } from "../lib/system-settings";
import { arrivalRulesFromSettings, resolveArrivalStatus, localDayBounds } from "../lib/attendance-rules";
import { enqueueAttendanceSms, enqueueJob } from "../lib/jobs";
import { publishEvent } from "../lib/events";
import { writeAudit } from "../lib/audit";

const router = Router();
const descriptorSchema = z.array(z.number().finite()).length(128);
const bulkMatchSchema = z.object({
  batchId: z.uuid(),
  classroomId: z.number().int().positive().nullable().optional(),
  frames: z.array(z.object({
    descriptors: z.array(descriptorSchema).max(20),
  })).min(1).max(120),
});
const REVIEW_CONFIDENCE_FLOOR = 0.35;

router.post("/attendance/bulk-match", requirePiToken, async (req, res): Promise<void> => {
  const parsed = bulkMatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const settings = await getSystemSettings();
  const rules = arrivalRulesFromSettings(settings);
  const allEncodings = await db
    .select({
      studentId: faceEncodingsTable.studentId,
      encoding: faceEncodingsTable.encoding,
    })
    .from(faceEncodingsTable);
  const allStudents = await db.select().from(studentsTable);
  const studentById = new Map(allStudents.map((student) => [student.id, student]));
  const allowedIds = new Set(allStudents
    .filter((student) => !parsed.data.classroomId || student.classroomId === parsed.data.classroomId)
    .map((student) => student.id));
  const encodings = allEncodings.filter((row) => allowedIds.has(row.studentId));

  if (encodings.length === 0) {
    res.status(404).json({ error: "No enrolled face descriptors are available for this classroom" });
    return;
  }

  const requestor = req as PiAuthenticatedRequest;
  const recentBatches = await db.select().from(jobsTable).where(and(
    eq(jobsTable.type, "gate_camera_batch"),
    eq(jobsTable.worker, "gate-camera"),
  )).orderBy(desc(jobsTable.createdAt)).limit(500);
  const priorBatch = recentBatches.find((job) => job.payload.batchId === parsed.data.batchId);
  if (priorBatch?.status === "done" && priorBatch.result && typeof priorBatch.result === "object") {
    res.json(priorBatch.result);
    return;
  }
  const batchJob = await enqueueJob({
    type: "gate_camera_batch",
    worker: "gate-camera",
    payload: {
      deviceId: requestor.piDeviceId ?? "unknown",
      batchId: parsed.data.batchId,
      frameCount: parsed.data.frames.length,
      descriptorCount: parsed.data.frames.reduce((sum, frame) => sum + frame.descriptors.length, 0),
    },
  });

  const streaks = new Map<number, { lastFrame: number; count: number; confidence: number }>();
  const lowCandidates = new Map<number, { descriptor: number[]; confidence: number; classroomId: number | null }>();
  let skipped = 0;

  parsed.data.frames.forEach((frame, frameIndex) => {
    const highMatchesInFrame = new Map<number, number>();
    for (const descriptor of frame.descriptors) {
      const candidate = findClosestFaceMatch(descriptor, encodings);
      if (!candidate) {
        skipped++;
        continue;
      }
      const student = studentById.get(candidate.studentId);
      if (!student) {
        skipped++;
        continue;
      }
      if (candidate.confidence >= settings.confidenceThreshold) {
        highMatchesInFrame.set(candidate.studentId, Math.max(highMatchesInFrame.get(candidate.studentId) ?? 0, candidate.confidence));
      } else if (candidate.confidence >= REVIEW_CONFIDENCE_FLOOR) {
        const prior = lowCandidates.get(candidate.studentId);
        if (!prior || candidate.confidence > prior.confidence) {
          lowCandidates.set(candidate.studentId, {
            descriptor,
            confidence: candidate.confidence,
            classroomId: parsed.data.classroomId ?? student.classroomId,
          });
        }
      } else {
        skipped++;
      }
    }

    for (const [studentId, confidence] of highMatchesInFrame) {
      const previous = streaks.get(studentId);
      const count = previous?.lastFrame === frameIndex - 1 ? previous.count + 1 : 1;
      streaks.set(studentId, {
        lastFrame: frameIndex,
        count,
        confidence: Math.max(previous?.confidence ?? 0, confidence),
      });
    }
  });

  const confirmed = Array.from(streaks.entries())
    .filter(([, value]) => value.count >= 2)
    .map(([studentId, value]) => ({ studentId, confidence: value.confidence }));
  const now = new Date();
  const { startUtc: startOfDay } = localDayBounds(now, rules.timezone);
  const result: Array<{
    studentId: number;
    studentName: string;
    attendanceId: number | null;
    status: "present" | "late" | "already_marked";
    confidence: number;
  }> = [];
  const candidateIds = Array.from(new Set([
    ...confirmed.map((item) => item.studentId),
    ...lowCandidates.keys(),
  ]));
  const existingRows = candidateIds.length
    ? await db.select({
      id: attendanceLogsTable.id,
      studentId: attendanceLogsTable.studentId,
    }).from(attendanceLogsTable).where(and(
      inArray(attendanceLogsTable.studentId, candidateIds),
      gte(attendanceLogsTable.markedAt, startOfDay),
    ))
    : [];
  const alreadyMarked = new Map(existingRows.map((row) => [row.studentId, row.id]));
  let committed = 0;

  for (const candidate of confirmed) {
    const student = studentById.get(candidate.studentId);
    if (!student) continue;
    const existingId = alreadyMarked.get(candidate.studentId);
    if (existingId) {
      result.push({
        studentId: student.id,
        studentName: student.name,
        attendanceId: existingId,
        status: "already_marked",
        confidence: candidate.confidence,
      });
      continue;
    }
    const status = resolveArrivalStatus(now, rules);
    const [attendance] = await db.insert(attendanceLogsTable).values({
      studentId: student.id,
      classroomId: parsed.data.classroomId ?? student.classroomId,
      status,
      method: "face",
      source: "gate-camera",
      confidence: candidate.confidence,
    }).returning();
    publishEvent("attendance.created", { studentId: student.id, studentName: student.name, status, method: "face", source: "gate-camera", confidence: candidate.confidence, bulk: true, markedAt: attendance.markedAt.toISOString() });
    alreadyMarked.set(student.id, attendance.id);
    committed++;
    result.push({
      studentId: student.id,
      studentName: student.name,
      attendanceId: attendance.id,
      status,
      confidence: candidate.confidence,
    });
    await writeAudit({
      action: "attendance.gate_camera.committed",
      targetType: "attendance",
      targetId: attendance.id,
      payload: {
        studentId: student.id,
        confidence: candidate.confidence,
        deviceId: requestor.piDeviceId ?? null,
        source: "gate-camera",
      },
    });
    await enqueueAttendanceSms(student.id, status, attendance.markedAt);
  }

  const retentionAt = new Date(now.getTime() + settings.reviewRetentionDays * 24 * 60 * 60 * 1000);
  let reviewQueued = 0;
  for (const [studentId, candidate] of lowCandidates) {
    if (alreadyMarked.has(studentId)) continue;
    const student = studentById.get(studentId);
    if (!student) continue;
    await db.insert(matchReviewsTable).values({
      studentId,
      classroomId: candidate.classroomId,
      descriptor: candidate.descriptor,
      confidence: candidate.confidence,
      source: "gate-camera",
      status: "pending",
      purgeAt: retentionAt,
    });
    reviewQueued++;
  }

  const responseBody = {
    matched: result,
    reviewQueued,
    skipped,
    threshold: settings.confidenceThreshold,
  };
  await db.update(jobsTable).set({
    status: "done",
    result: responseBody,
    completedAt: new Date(),
  }).where(eq(jobsTable.id, batchJob.id));

  res.json(responseBody);
});

export default router;
