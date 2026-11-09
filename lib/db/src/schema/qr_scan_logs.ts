import { pgTable, text, serial, timestamp, integer, real, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";

/**
 * Every QR tap on a door terminal is logged here — valid scans become attendance,
 * everything else (expired, revoked, duplicate, forged, unknown, geofence)
 * becomes an auditable anomaly so admins can see tampering attempts at a glance.
 *
 * Phase 6 additions (offline kiosk + geofence + fraud AI):
 *   nonce       — client-generated idempotency key; offline spool replays are
 *                 deduplicated server-side on this column (unique index).
 *   scannedAt   — when the scan ACTUALLY happened (offline spool may sync
 *                 hours later); attendance + late rules use this, not the
 *                 server receive time (createdAt).
 *   latitude / longitude / accuracy — GPS signature of the scan (kiosk).
 *   gateId      — gate registry key (see schema/gates.ts).
 *   fraudScore / fraudSignals — inline proxy-fraud analysis result.
 */
export const qrScanLogsTable = pgTable(
  "qr_scan_logs",
  {
    id: serial("id").primaryKey(),
    studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
    issueId: integer("issue_id"),
    /** identifier of the door terminal / kiosk that produced the scan */
    terminalId: text("terminal_id").notNull().default("web"),
    /** registered gate this terminal belongs to (null = unregistered) */
    gateId: text("gate_id"),
    result: text("result").notNull(),
    /** attendance status when result=valid: present | late */
    status: text("status"),
    /** when the scan happened at the door (null = legacy rows / live scans) */
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    latitude: real("latitude"),
    longitude: real("longitude"),
    /** GPS accuracy radius in meters (as reported by the device) */
    accuracy: real("accuracy"),
    /** idempotency key for offline spool replay */
    nonce: text("nonce"),
    /** 0-100 risk from the inline fraud engine */
    fraudScore: integer("fraud_score"),
    /** signal kinds attached to this scan, e.g. ["impossible_travel"] */
    fraudSignals: jsonb("fraud_signals").$type<string[]>().notNull().default([]),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("qr_scan_logs_nonce_uidx").on(t.nonce),
    index("qr_scan_logs_student_time_idx").on(t.studentId, t.createdAt),
    index("qr_scan_logs_terminal_time_idx").on(t.terminalId, t.createdAt),
  ],
);

export type QrScanLog = typeof qrScanLogsTable.$inferSelect;
