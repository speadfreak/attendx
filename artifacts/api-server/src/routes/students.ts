import { Router } from "express";
import { db, studentsTable, classroomsTable, faceEncodingsTable } from "@workspace/db";
import { eq, ilike, and, isNull, isNotNull, sql } from "drizzle-orm";
import {
  ListStudentsQueryParams,
  CreateStudentBody,
  GetStudentParams,
  UpdateStudentParams,
  UpdateStudentBody,
  DeleteStudentParams,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";

const router = Router();

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

  const students = rows.map((r) => ({
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
