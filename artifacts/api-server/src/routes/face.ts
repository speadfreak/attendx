import { Router } from "express";
import { db, studentsTable, faceEncodingsTable, attendanceLogsTable } from "@workspace/db";
import { eq, and, gte } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { sendSms, buildPresentMessage, buildLateMessage } from "../lib/sms";

const router = Router();

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

function descriptorToConfidence(distance: number): number {
  return Math.max(0, 1 - distance / 1.2);
}

router.post("/face/encode", requireAuth, async (req, res): Promise<void> => {
  const { studentId, imageBase64, faceDescriptor } = req.body;
  if (!studentId) { res.status(400).json({ error: "studentId required" }); return; }
  if (!imageBase64 && !faceDescriptor) { res.status(400).json({ error: "imageBase64 or faceDescriptor required" }); return; }

  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, Number(studentId)));
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }

  const descriptor: number[] = faceDescriptor
    ? Array.from(faceDescriptor)
    : extractFallbackEncoding(imageBase64);

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
  const { imageBase64, faceDescriptor, classroomId } = req.body;

  const allEncodings = await db
    .select({ studentId: faceEncodingsTable.studentId, encoding: faceEncodingsTable.encoding })
    .from(faceEncodingsTable);

  if (!allEncodings.length) {
    res.status(404).json({ error: "No face encodings registered in the system" });
    return;
  }

  const queryDescriptor: number[] = faceDescriptor
    ? Array.from(faceDescriptor)
    : imageBase64 ? extractFallbackEncoding(imageBase64) : [];

  if (!queryDescriptor.length) {
    res.status(400).json({ error: "No face data provided" });
    return;
  }

  let bestMatch: { studentId: number; distance: number } | null = null;

  for (const row of allEncodings) {
    const stored: number[] = JSON.parse(row.encoding);
    const dist = euclideanDistance(queryDescriptor, stored);
    if (!bestMatch || dist < bestMatch.distance) {
      bestMatch = { studentId: row.studentId, distance: dist };
    }
  }

  const THRESHOLD = faceDescriptor ? 0.55 : 0.05;

  if (!bestMatch || bestMatch.distance > THRESHOLD) {
    res.status(404).json({ error: "No matching student found" });
    return;
  }

  const confidence = descriptorToConfidence(bestMatch.distance);

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
  }).returning();

  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const message = isLate
    ? buildLateMessage(student.name, timeStr)
    : buildPresentMessage(student.name, timeStr);

  sendSms({ studentId: student.id, parentPhone: student.parentPhone, message }).catch(() => {});

  res.json({ studentId: student.id, studentName: student.name, confidence, attendanceId: log.id, alreadyMarked: false, status });
});

function extractFallbackEncoding(base64Image: string): number[] {
  const bytes = Buffer.from(base64Image.replace(/^data:image\/[^;]+;base64,/, ""), "base64");
  const encoding: number[] = [];
  const step = Math.floor(bytes.length / 128);
  for (let i = 0; i < 128; i++) {
    encoding.push(bytes[i * step] / 255.0);
  }
  return encoding;
}

export default router;
