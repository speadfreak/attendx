import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";

/**
 * Every QR tap on a door terminal is logged here — valid scans become attendance,
 * everything else (expired, revoked, duplicate, forged, unknown) becomes an
 * auditable anomaly so admins can see tampering attempts at a glance.
 */
export const qrScanLogsTable = pgTable("qr_scan_logs", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
  issueId: integer("issue_id"),
  /** identifier of the door terminal / kiosk that produced the scan */
  terminalId: text("terminal_id").notNull().default("web"),
  result: text("result").notNull(),
  /** attendance status when result=valid: present | late */
  status: text("status"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type QrScanLog = typeof qrScanLogsTable.$inferSelect;
