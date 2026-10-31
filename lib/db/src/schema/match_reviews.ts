import { integer, jsonb, pgTable, real, serial, text, timestamp } from "drizzle-orm/pg-core";
import { adminsTable } from "./admins";
import { classroomsTable } from "./classrooms";
import { studentsTable } from "./students";

export const matchReviewsTable = pgTable("match_reviews", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
  classroomId: integer("classroom_id").references(() => classroomsTable.id, { onDelete: "set null" }),
  descriptor: jsonb("descriptor").$type<number[] | null>(),
  confidence: real("confidence").notNull(),
  source: text("source").notNull().default("gate-camera"),
  status: text("status").notNull().default("pending"),
  reviewedByAdminId: integer("reviewed_by_admin_id").references(() => adminsTable.id, { onDelete: "set null" }),
  reviewNote: text("review_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  purgeAt: timestamp("purge_at", { withTimezone: true }).notNull(),
});

export type MatchReview = typeof matchReviewsTable.$inferSelect;
