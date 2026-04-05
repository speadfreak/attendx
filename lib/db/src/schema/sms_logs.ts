import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";

export const smsLogsTable = pgTable("sms_logs", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
  parentPhone: text("parent_phone").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("sent"),
  provider: text("provider").notNull().default("simulation"),
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SmsLog = typeof smsLogsTable.$inferSelect;
