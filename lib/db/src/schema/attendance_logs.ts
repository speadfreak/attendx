import { pgTable, pgEnum, text, serial, timestamp, integer, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { studentsTable } from "./students";
import { classroomsTable } from "./classrooms";

export const attendanceSourceEnum = pgEnum("attendance_source", [
  "manual",
  "webcam",
  "gate-camera",
  "qr-terminal",
  "qr-web",
]);

export const attendanceLogsTable = pgTable("attendance_logs", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
  classroomId: integer("classroom_id").references(() => classroomsTable.id, { onDelete: "set null" }),
  status: text("status").notNull().default("present"),
  method: text("method").notNull().default("manual"),
  source: attendanceSourceEnum("source").notNull().default("manual"),
  confidence: real("confidence"),
  notes: text("notes"),
  checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
  markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Phase 7 audit sweep: dashboards/reports/QR/face hot paths all filter on
  // these columns — previously the table had NO secondary indexes at all.
  index("idx_attendance_marked_at").on(t.markedAt),
  index("idx_attendance_classroom_marked").on(t.classroomId, t.markedAt),
  index("idx_attendance_student_marked").on(t.studentId, t.markedAt),
  index("idx_attendance_status_marked").on(t.status, t.markedAt),
]);

export const insertAttendanceSchema = createInsertSchema(attendanceLogsTable).omit({ id: true, createdAt: true });
export type InsertAttendance = z.infer<typeof insertAttendanceSchema>;
export type AttendanceLog = typeof attendanceLogsTable.$inferSelect;
