import { pgTable, text, timestamp, integer, serial, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * fraud_signals — output of the inline proxy-fraud engine (Phase 6).
 *
 * kind:
 *   impossible_travel   — same badge, two far-apart gates, physically impossible speed
 *   burst_scan          — one terminal scanning faster than any human queue
 *   badge_sharing       — one badge hit at multiple terminals within minutes (friend proxying)
 *   geofence_violation  — scan GPS outside the gate's allowed radius (home proxy attempt)
 *
 * status: open → dismissed | confirmed   (reviewed in the Review Queue → Fraud Radar)
 *
 * dedupeKey prevents duplicate signals while a pattern persists: the engine
 * buckets it (kind + subject + 30-minute window), enforced by a unique index.
 */
export const fraudSignalsTable = pgTable(
  "fraud_signals",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    severity: text("severity").notNull().default("medium"), // low | medium | high
    score: integer("score").notNull().default(50), // 0-100 confidence
    studentId: integer("student_id"),
    terminalId: text("terminal_id"),
    gateId: text("gate_id"),
    primaryScanId: integer("primary_scan_id"),
    relatedScanIds: integer("related_scan_ids").array().notNull().default([]),
    detail: text("detail"),
    /** structured evidence (JSON string): speedKmh, distanceKm, count, windowSec… */
    evidence: text("evidence"),
    status: text("status").notNull().default("open"),
    /** kind + subject + 30-min window — unique-indexed to suppress duplicates */
    dedupeKey: text("dedupe_key"),
    resolvedByAdminId: integer("resolved_by_admin_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolveNote: text("resolve_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("fraud_signals_dedupe_uidx").on(t.kind, t.dedupeKey),
    index("fraud_signals_status_idx").on(t.status, t.createdAt),
  ],
);

export type FraudSignal = typeof fraudSignalsTable.$inferSelect;
