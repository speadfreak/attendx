import { Router } from "express";
import { db, classroomsTable, studentsTable, classroomSeatsTable } from "@workspace/db";
import { and, asc, eq, count } from "drizzle-orm";
import { z } from "zod/v4";
import {
  CreateClassroomBody,
  GetClassroomParams,
  UpdateClassroomParams,
  UpdateClassroomBody,
  DeleteClassroomParams,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { writeAudit } from "../lib/audit";

const router = Router();

// ── Seating map ─────────────────────────────────────────────────
const seatsInput = z.object({
  seats: z.array(z.object({
    seatLabel: z.string().min(1).max(12),
    rowIdx: z.number().int().min(0).max(50),
    colIdx: z.number().int().min(0).max(50),
    studentId: z.number().int().positive().nullable(),
  })).max(400),
});

router.get("/classrooms/:id/seats", requireAuth, async (req, res): Promise<void> => {
  const classroomId = Number(req.params.id);
  if (!Number.isInteger(classroomId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const seats = await db
    .select({
      id: classroomSeatsTable.id,
      seatLabel: classroomSeatsTable.seatLabel,
      rowIdx: classroomSeatsTable.rowIdx,
      colIdx: classroomSeatsTable.colIdx,
      studentId: classroomSeatsTable.studentId,
      studentName: studentsTable.name,
      studentRef: studentsTable.studentId,
    })
    .from(classroomSeatsTable)
    .leftJoin(studentsTable, eq(classroomSeatsTable.studentId, studentsTable.id))
    .where(eq(classroomSeatsTable.classroomId, classroomId))
    .orderBy(asc(classroomSeatsTable.rowIdx), asc(classroomSeatsTable.colIdx));
  res.json(seats.map((s) => ({ ...s })));
});

router.put("/classrooms/:id/seats", requireAuth, async (req, res): Promise<void> => {
  const classroomId = Number(req.params.id);
  if (!Number.isInteger(classroomId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = seatsInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Prevent a student from occupying two seats in the same classroom
  const seen = new Set<number>();
  for (const seat of parsed.data.seats) {
    if (seat.studentId != null) {
      if (seen.has(seat.studentId)) {
        res.status(400).json({ error: `Student ${seat.studentId} is assigned to more than one seat` });
        return;
      }
      seen.add(seat.studentId);
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(classroomSeatsTable).where(eq(classroomSeatsTable.classroomId, classroomId));
    const rows = parsed.data.seats
      .filter((s) => s.seatLabel)
      .map((s) => ({
        classroomId,
        seatLabel: s.seatLabel,
        rowIdx: s.rowIdx,
        colIdx: s.colIdx,
        studentId: s.studentId ?? null,
      }));
    if (rows.length) await tx.insert(classroomSeatsTable).values(rows);
  });

  await writeAudit({
    action: "classroom.seats.updated",
    targetType: "classroom",
    targetId: classroomId,
    payload: { seatCount: parsed.data.seats.length },
  });

  const seats = await db
    .select({
      id: classroomSeatsTable.id,
      seatLabel: classroomSeatsTable.seatLabel,
      rowIdx: classroomSeatsTable.rowIdx,
      colIdx: classroomSeatsTable.colIdx,
      studentId: classroomSeatsTable.studentId,
      studentName: studentsTable.name,
      studentRef: studentsTable.studentId,
    })
    .from(classroomSeatsTable)
    .leftJoin(studentsTable, eq(classroomSeatsTable.studentId, studentsTable.id))
    .where(eq(classroomSeatsTable.classroomId, classroomId))
    .orderBy(asc(classroomSeatsTable.rowIdx), asc(classroomSeatsTable.colIdx));

  res.json(seats);
});

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
