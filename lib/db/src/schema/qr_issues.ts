import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";
import { classroomsTable } from "./classrooms";
import { adminsTable } from "./admins";

/**
 * QR issue records. Every printed / shared student QR code is tracked here so
 * admins can rotate, revoke, reprint and audit exactly which badge is in the wild.
 * The raw QR payload is a signed token (HMAC); only its SHA-256 hash is stored.
 */
export const qrIssuesTable = pgTable("qr_issues", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
  classroomId: integer("classroom_id").references(() => classroomsTable.id, { onDelete: "set null" }),
  /** HMAC-signed token payload: AXQR1.<b64payload>.<b64sig> — hash stored, never the token itself */
  tokenHash: text("token_hash").notNull(),
  /** Monotonic per-student version — issuing a new QR invalidates all older versions */
  version: integer("version").notNull().default(1),
  /** Human friendly serial printed on the card, e.g. AX-S-000123 */
  serial: text("serial").notNull(),
  issuedByAdminId: integer("issued_by_admin_id").references(() => adminsTable.id, { onDelete: "set null" }),
  /** null = valid until revoked */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revoked: boolean("revoked").notNull().default(false),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokeReason: text("revoke_reason"),
  /** free-form: "id-card-back", "temporary-pass", "replacement" */
  label: text("label").notNull().default("id-card"),
  scans: integer("scans").notNull().default(0),
  lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type QrIssue = typeof qrIssuesTable.$inferSelect;
