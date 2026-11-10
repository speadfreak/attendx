import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { studentsTable } from "./students";

/**
 * sms_logs — every parent notification attempt.
 *
 * Phase 6 delivery lifecycle (honest statuses — never say "sent" when the
 * carrier hasn't accepted the message):
 *   queued      → accepted by Twilio, awaiting carrier result
 *   sent        → carrier accepted (Twilio "sent")
 *   delivered   → handset confirmed delivery (Twilio status callback)
 *   undelivered → carrier gave up / handset unreachable
 *   failed      → rejected at API level (21612 geo-block, auth, invalid number…)
 *   simulated   → Twilio not configured, logged for demo purposes
 *
 * `providerSid` (Twilio MessageSid) links the row to Twilio's own record so
 * the status webhook (/api/webhooks/twilio/status) and the reconciliation
 * sweep can keep the local status truthful.
 */
export const smsLogsTable = pgTable(
  "sms_logs",
  {
    id: serial("id").primaryKey(),
    studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
    parentPhone: text("parent_phone").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull().default("queued"),
    provider: text("provider").notNull().default("simulation"),
    errorMessage: text("error_message"),
    /** Twilio MessageSid (SM… / null for simulated sends) */
    providerSid: text("provider_sid"),
    /** Provider failure code, e.g. "21612" (geo-block) — drives UI guidance */
    errorCode: text("error_code"),
    /** sms | whatsapp — explicit channel used for this row */
    channel: text("channel"),
    /** Last time the status was confirmed by a callback / reconciliation */
    statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
    /** When this row is a retry attempt, the id of the earlier failed row
     *  it re-sends. Null = original send. Lets "Retry failed" skip rows
     *  that already have a newer attempt (no duplicate spam). */
    retryOfId: integer("retry_of_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sms_logs_provider_sid_idx").on(t.providerSid),
    index("sms_logs_status_sent_idx").on(t.status, t.sentAt),
    index("sms_logs_retry_of_idx").on(t.retryOfId),
  ],
);

export type SmsLog = typeof smsLogsTable.$inferSelect;
