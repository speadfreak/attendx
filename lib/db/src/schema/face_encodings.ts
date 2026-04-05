import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";

export const faceEncodingsTable = pgTable("face_encodings", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }).unique(),
  encoding: text("encoding").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type FaceEncoding = typeof faceEncodingsTable.$inferSelect;
