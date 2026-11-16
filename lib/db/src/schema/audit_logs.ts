import { integer, jsonb, pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";
import { adminsTable } from "./admins";

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  actorAdminId: integer("actor_admin_id").references(() => adminsTable.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Phase 7 audit sweep: the audit feed orders by created_at (20s polling).
  index("idx_audit_created").on(t.createdAt),
]);

export type AuditLog = typeof auditLogsTable.$inferSelect;
