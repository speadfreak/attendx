import { Router } from "express";
import { db, studentsTable, classroomsTable } from "@workspace/db";
import { eq, ilike, or } from "drizzle-orm";
import { requireStaff } from "../lib/auth";

/**
 * Global search for the command palette (Cmd+K): students, classrooms.
 * Actions are composed client-side.
 */
const router = Router();

router.get("/search", requireStaff, async (req, res): Promise<void> => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 1) {
    res.json({ students: [], classrooms: [] });
    return;
  }
  const students = await db
    .select({
      id: studentsTable.id,
      name: studentsTable.name,
      studentId: studentsTable.studentId,
      classroomName: classroomsTable.name,
    })
    .from(studentsTable)
    .leftJoin(classroomsTable, eq(studentsTable.classroomId, classroomsTable.id))
    .where(or(ilike(studentsTable.name, `%${q}%`), ilike(studentsTable.studentId, `%${q}%`)))
    .limit(6);

  const classrooms = await db
    .select({ id: classroomsTable.id, name: classroomsTable.name, teacherName: classroomsTable.teacherName })
    .from(classroomsTable)
    .where(ilike(classroomsTable.name, `%${q}%`))
    .limit(4);

  res.json({ students, classrooms });
});

export default router;
