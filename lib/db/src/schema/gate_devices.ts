import { boolean, date, integer, pgTable, primaryKey, real, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * gate_devices — ONE unified registry for every camera-class device at the
 * gates (Phase 7). Generalizes the former `pi_devices` table (renamed in
 * migration 0009, data preserved) so Pi kiosks and phone PWA camera nodes
 * share the same pairing, token-rotation, heartbeat and command surface:
 *
 *   device_type: "pi" | "phone"
 *   mode:        "face" | "qr"            (what the camera is doing now)
 *   status:      discovered | connected | running_task | degraded | offline
 *   health_status: "ok" | "obstructed" | "frozen" | "unknown"
 *                  (phone on-device self-check: lens covered / frozen frame)
 *
 * Token model (unchanged from the Pi flow): the plaintext token is shown
 * once at pairing and at every heartbeat rotation; only SHA-256 hashes are
 * stored — current_token_hash is the active key, previous_token_hash gives
 * a 60s grace window so a token rotation race never locks a device out.
 *
 * Operator remote control: pending_command(+_at) is a tiny one-slot command
 * mailbox — Operations writes a command, the device drains it on its next
 * heartbeat (works even when the SSE push channel is unreachable), and the
 * same command is fanned out live over SSE for near-instant delivery.
 */
export const gateDevicesTable = pgTable(
  "gate_devices",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** pi | phone */
    deviceType: text("device_type").notNull().default("pi"),
    /** face | qr — remote-switchable detection mode */
    mode: text("mode").notNull().default("face"),
    status: text("status").notNull().default("offline"),
    /** FK by value to gates.gate_id (no FK constraint: gates may be recreated) */
    assignedGateId: text("assigned_gate_id"),
    // ── Pi telemetry (phones leave these null) ──
    localIp: text("local_ip"),
    uptimeSeconds: integer("uptime_seconds"),
    cpuTempC: real("cpu_temp_c"),
    queueDepth: integer("queue_depth").notNull().default(0),
    fanTempC: real("fan_temp_c"),
    fanState: text("fan_state").notNull().default("unknown"),
    // ── Phone camera telemetry ──
    /** e.g. "640x480" */
    resolution: text("resolution"),
    /** measured detection FPS */
    fps: real("fps"),
    /** ok | obstructed | frozen | unknown */
    healthStatus: text("health_status").notNull().default("ok"),
    /** Battery Status API percentage (null for Pi / unsupported) */
    batteryLevel: real("battery_level"),
    /** navigator.connection.effectiveType ("wifi", "cellular-3g", …) */
    connection: text("connection"),
    /** phone-side data-saver mode (low fps + compressed thumbnails) */
    dataSaver: boolean("data_saver").notNull().default(false),
    /** operator quality override: low | balanced | hd (null = adaptive) */
    targetQuality: text("target_quality"),
    /** most recent still frame (JPEG data URL, ≤60 KB) for the Ops grid */
    thumbnail: text("thumbnail"),
    thumbnailAt: timestamp("thumbnail_at", { withTimezone: true }),
    // ── command mailbox (drained on heartbeat) ──
    pendingCommand: text("pending_command"),
    pendingCommandAt: timestamp("pending_command_at", { withTimezone: true }),
    // ── rotating device token (hashes only, never plaintext) ──
    currentTokenHash: text("current_token_hash"),
    previousTokenHash: text("previous_token_hash"),
    previousTokenValidUntil: timestamp("previous_token_valid_until", { withTimezone: true }),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index("idx_gate_devices_token").on(t.currentTokenHash),
    index("idx_gate_devices_type").on(t.deviceType),
    index("idx_gate_devices_gate").on(t.assignedGateId),
    index("idx_gate_devices_seen").on(t.lastSeenAt),
  ],
);

export type GateDevice = typeof gateDevicesTable.$inferSelect;

/**
 * device_uptime_days — daily online-time rollup per device (Phase 7 uptime
 * report). Each heartbeat adds the seconds since the previous heartbeat
 * (capped at 10 min so a device that came back hours later doesn't get
 * credited for the gap). Powers "this camera was online 97% of school days
 * but keeps dying before 8am" style reliability insight.
 */
export const deviceUptimeDaysTable = pgTable(
  "device_uptime_days",
  {
    deviceId: text("device_id").notNull(),
    /** school-day bucket (YYYY-MM-DD, UTC) */
    day: date("day").notNull(),
    onlineSeconds: integer("online_seconds").notNull().default(0),
    heartbeats: integer("heartbeats").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.day] })],
);

export type DeviceUptimeDay = typeof deviceUptimeDaysTable.$inferSelect;
