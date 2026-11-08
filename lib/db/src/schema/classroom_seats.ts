import { pgTable, text, serial, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";
import { classroomsTable } from "./classrooms";

/**
 * Classroom seating map. Seats live on a simple row/col grid; a student holds at
 * most one seat per classroom. Used by the drag-and-drop editor and as a
 * tie-breaking hint in the low-confidence face-match review queue.
 */
export const classroomSeatsTable = pgTable(
  "classroom_seats",
  {
    id: serial("id").primaryKey(),
    classroomId: integer("classroom_id")
      .notNull()
      .references(() => classroomsTable.id, { onDelete: "cascade" }),
    studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
    seatLabel: text("seat_label").notNull(),
    rowIdx: integer("row_idx").notNull().default(0),
    colIdx: integer("col_idx").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    unique("classroom_seats_classroom_student_unique").on(t.classroomId, t.studentId),
    unique("classroom_seats_classroom_label_unique").on(t.classroomId, t.seatLabel),
  ],
);

export type ClassroomSeat = typeof classroomSeatsTable.$inferSelect;
