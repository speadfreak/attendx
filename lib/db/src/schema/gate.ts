import { pgTable, text, serial, timestamp, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Phase 4 — Gate Integrity Validator (Arduino sensor fusion).
 *
 * gate_sensor_events: raw pass events pushed by the Pi agent from the gate
 * Arduino (ultrasonic HC-SR04 + IR break-beam). One row per body passing the
 * gate. `simulated` rows come from the demo "Simulate Discrepancy" control
 * and never mix with real attendance data.
 */
export const gateSensorEventsTable = pgTable(
  "gate_sensor_events",
  {
    id: serial("id").primaryKey(),
    gateId: text("gate_id").notNull().default("gate-1"),
    sensor: text("sensor").notNull(), // "ultrasonic" | "ir_beam"
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    piDeviceId: text("pi_device_id"),
    simulated: boolean("simulated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gate_sensor_events_time_idx").on(t.occurredAt),
    index("gate_sensor_events_gate_sensor_idx").on(t.gateId, t.sensor, t.occurredAt),
  ],
);

/**
 * gate_integrity_alerts: one row per discrepant validation window.
 * alert_type:
 *   - "missed_detections": camera matched fewer students than BOTH physical
 *     sensors counted by more than the configured threshold → students may
 *     have walked through unmatched (lighting/angle/occlusion).
 *   - "sensor_conflict": the two physical sensors disagree with each other
 *     beyond the threshold → hardware issue, not an attendance issue.
 */
export const gateIntegrityAlertsTable = pgTable(
  "gate_integrity_alerts",
  {
    id: serial("id").primaryKey(),
    gateId: text("gate_id").notNull().default("gate-1"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    cameraCount: integer("camera_count").notNull().default(0),
    ultrasonicCount: integer("ultrasonic_count").notNull().default(0),
    irCount: integer("ir_count").notNull().default(0),
    alertType: text("alert_type").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByAdminId: integer("resolved_by_admin_id"),
    resolveNote: text("resolve_note"),
    simulated: boolean("simulated").notNull().default(false),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gate_integrity_alerts_window_idx").on(t.windowStart),
    // One alert per (gate, window, type) — re-running validation never duplicates.
    uniqueIndex("gate_integrity_alerts_unique_window").on(t.gateId, t.windowStart, t.alertType),
  ],
);

export type GateSensorEvent = typeof gateSensorEventsTable.$inferSelect;
export type GateIntegrityAlert = typeof gateIntegrityAlertsTable.$inferSelect;
