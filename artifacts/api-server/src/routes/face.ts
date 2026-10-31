import { Router } from "express";
import { db, studentsTable, faceEncodingsTable, attendanceLogsTable } from "@workspace/db";
import { eq, and, gte } from "drizzle-orm";
import { z } from "zod/v4";
import { requireAuth } from "../lib/auth";
import { enqueueJob } from "../lib/jobs";
import { writeAudit } from "../lib/audit";
import { findClosestFaceMatch } from "../lib/face-matching";

const router = Router();

router.post("/face/encode", requireAuth, async (req, res): Promise<void> => {
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

router.post("/face/recognize", requireAuth, async (req, res): Promise<void> => {
  const { faceDescriptor, classroomId } = req.body;
  const parsedDescriptor = z.array(z.number().finite()).length(128).safeParse(faceDescriptor);
  if (!parsedDescriptor.success) {
    res.status(400).json({ error: "A valid 128-value face descriptor is required" });
    return;
  }

  const allEncodings = await db
    .select({ studentId: faceEncodingsTable.studentId, encoding: faceEncodingsTable.encoding })
    .from(faceEncodingsTable);

  if (!allEncodings.length) {
    res.status(404).json({ error: "No face encodings registered in the system" });
    return;
  }

  const bestMatch = findClosestFaceMatch(parsedDescriptor.data, allEncodings);

  const THRESHOLD = faceDescriptor ? 0.55 : 0.05;

  if (!bestMatch || bestMatch.distance > THRESHOLD) {
    res.status(404).json({ error: "No matching student found" });
    return;
  }

  const confidence = bestMatch.confidence;

  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, bestMatch.studentId));
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const existing = await db
    .select()
    .from(attendanceLogsTable)
    .where(and(eq(attendanceLogsTable.studentId, student.id), gte(attendanceLogsTable.markedAt, todayStart)));

  if (existing.length > 0) {
    res.json({ studentId: student.id, studentName: student.name, confidence, attendanceId: existing[0].id, alreadyMarked: true, status: existing[0].status });
    return;
  }

  const now = new Date();
  const isLate = now.getHours() > 8 || (now.getHours() === 8 && now.getMinutes() > 15);
  const status = isLate ? "late" : "present";

  const [log] = await db.insert(attendanceLogsTable).values({
    studentId: student.id,
    classroomId: classroomId ? Number(classroomId) : student.classroomId,
    status,
    method: "face",
    source: "webcam",
    confidence,
  }).returning();

  if (status === "late") {
    await enqueueJob({ type: "send_sms", worker: "api", payload: { studentId: student.id, status } });
  }
  const actor = (req as typeof req & { admin?: { adminId?: number } }).admin;
  await writeAudit({
    actorAdminId: actor?.adminId,
    action: "attendance.face.committed",
    targetType: "attendance",
    targetId: log.id,
    payload: { studentId: student.id, source: "webcam", confidence, status },
  });

  res.json({ studentId: student.id, studentName: student.name, confidence, attendanceId: log.id, alreadyMarked: false, status });
});

export default router;
