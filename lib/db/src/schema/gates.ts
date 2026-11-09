import { pgTable, text, timestamp, integer, doublePrecision, index } from "drizzle-orm/pg-core";

/**
 * gates — registry of physical school gates (Phase 6 geofenced QR).
 *
 * A gate is where one or more kiosk terminals live ("door-1" → "main-gate").
 * Geofence config is optional: when latitude/longitude are set, every scan
 * arriving with a GPS signature is distance-checked server-side — scans from
 * home (QR proxying) are rejected with `geofence-violation` and raise a
 * high-severity fraud signal.
 */
export const gatesTable = pgTable(
  "gates",
  {
    gateId: text("gate_id").primaryKey(),
    name: text("name").notNull(),
    /** geofence center (WGS-84 decimal degrees); null = geofence disabled */
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    /** allowed radius in meters from the center (scan GPS accuracy adds buffer) */
    geofenceRadiusM: integer("geofence_radius_m").notNull().default(150),
    /** terminals known to belong to this gate, e.g. ["door-1","door-2"] */
    terminalIds: text("terminal_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("gates_gate_idx").on(t.gateId)],
);

export type Gate = typeof gatesTable.$inferSelect;
