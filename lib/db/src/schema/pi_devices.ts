import { integer, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";

export const piDevicesTable = pgTable("pi_devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("offline"),
  localIp: text("local_ip"),
  uptimeSeconds: integer("uptime_seconds"),
  cpuTempC: real("cpu_temp_c"),
  queueDepth: integer("queue_depth").notNull().default(0),
  fanTempC: real("fan_temp_c"),
  fanState: text("fan_state").notNull().default("unknown"),
  currentTokenHash: text("current_token_hash"),
  previousTokenHash: text("previous_token_hash"),
  previousTokenValidUntil: timestamp("previous_token_valid_until", { withTimezone: true }),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type PiDevice = typeof piDevicesTable.$inferSelect;
