import { Router } from "express";
import { db, classroomsTable, studentsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import {
  CreateClassroomBody,
  GetClassroomParams,
  UpdateClassroomParams,
  UpdateClassroomBody,
  DeleteClassroomParams,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";

const router = Router();

router.get("/classrooms", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: classroomsTable.id,
      name: classroomsTable.name,
      description: classroomsTable.description,
      teacherName: classroomsTable.teacherName,
      createdAt: classroomsTable.createdAt,
      studentCount: count(studentsTable.id),
    })
    .from(classroomsTable)
    .leftJoin(studentsTable, eq(classroomsTable.id, studentsTable.classroomId))
    .groupBy(classroomsTable.id)
    .orderBy(classroomsTable.name);

  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    teacherName: r.teacherName ?? null,
    studentCount: Number(r.studentCount),
    createdAt: r.createdAt.toISOString(),
  })));
});

router.post("/classrooms", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateClassroomBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [classroom] = await db.insert(classroomsTable).values(parsed.data).returning();
  res.status(201).json({
    id: classroom.id,
    name: classroom.name,
    description: classroom.description ?? null,
    teacherName: classroom.teacherName ?? null,
    studentCount: 0,
    createdAt: classroom.createdAt.toISOString(),
  });
});

router.get("/classrooms/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetClassroomParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await db
    .select({
      id: classroomsTable.id,
      name: classroomsTable.name,
      description: classroomsTable.description,
      teacherName: classroomsTable.teacherName,
      createdAt: classroomsTable.createdAt,
      studentCount: count(studentsTable.id),
    })
    .from(classroomsTable)
    .leftJoin(studentsTable, eq(classroomsTable.id, studentsTable.classroomId))
    .where(eq(classroomsTable.id, params.data.id))
    .groupBy(classroomsTable.id);

  if (!rows.length) {
    res.status(404).json({ error: "Classroom not found" });
    return;
  }
  const r = rows[0];
  res.json({
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    teacherName: r.teacherName ?? null,
    studentCount: Number(r.studentCount),
    createdAt: r.createdAt.toISOString(),
  });
});

router.patch("/classrooms/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateClassroomParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateClassroomBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [classroom] = await db
    .update(classroomsTable)
    .set(body.data)
    .where(eq(classroomsTable.id, params.data.id))
    .returning();
  if (!classroom) {
    res.status(404).json({ error: "Classroom not found" });
    return;
  }
  res.json({
    id: classroom.id,
    name: classroom.name,
    description: classroom.description ?? null,
    teacherName: classroom.teacherName ?? null,
    studentCount: 0,
    createdAt: classroom.createdAt.toISOString(),
  });
});

router.delete("/classrooms/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteClassroomParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [classroom] = await db.delete(classroomsTable).where(eq(classroomsTable.id, params.data.id)).returning();
  if (!classroom) {
    res.status(404).json({ error: "Classroom not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
