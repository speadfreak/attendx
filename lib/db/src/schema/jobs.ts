import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  worker: text("worker").notNull().default("pi"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  result: jsonb("result").$type<Record<string, unknown> | null>(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type Job = typeof jobsTable.$inferSelect;
