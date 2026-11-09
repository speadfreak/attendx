import { Router, type Request } from "express";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import { db, fraudSignalsTable, studentsTable } from "@workspace/db";
import { requireStaff } from "../lib/auth";
import { writeAudit } from "../lib/audit";

/**
 * Phase 6 — Proxy-fraud radar read surface.
 *
 * Signals are produced by the inline engine (lib/fraud.ts) on every committed
 * QR scan. Staff triage them here: list (with filters), summarize, decide.
 * Row mapping + student-name join follow the /reviews conventions in
 * operations.ts; the decide endpoint mirrors the review decision endpoint
 * (status + note + resolvedByAdminId/resolvedAt stamped from the JWT admin).
 */
const router = Router();
const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId;

const SIGNAL_STATUSES = ["open", "acknowledged", "resolved", "dismissed"] as const;
const SIGNAL_SEVERITIES = ["low", "medium", "high", "critical"] as const;
const SIGNAL_KINDS = ["impossible_travel", "burst_scan", "badge_sharing", "proxy_farm", "geofence_violation"] as const;

const listQuery = z.object({
  status: z.enum(SIGNAL_STATUSES).optional(),
  kind: z.string().trim().min(1).max(60).optional(),
  severity: z.enum(SIGNAL_SEVERITIES).optional(),
  studentId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const decideInput = z.object({
  status: z.enum(["acknowledged", "resolved", "dismissed"]),
  note: z.string().trim().max(500).optional(),
});

const signalColumns = {
  id: fraudSignalsTable.id,
  kind: fraudSignalsTable.kind,
  severity: fraudSignalsTable.severity,
  score: fraudSignalsTable.score,
  studentId: fraudSignalsTable.studentId,
  studentName: studentsTable.name,
  terminalId: fraudSignalsTable.terminalId,
  gateId: fraudSignalsTable.gateId,
  primaryScanId: fraudSignalsTable.primaryScanId,
  relatedScanIds: fraudSignalsTable.relatedScanIds,
  detail: fraudSignalsTable.detail,
  evidence: fraudSignalsTable.evidence,
  status: fraudSignalsTable.status,
  dedupeKey: fraudSignalsTable.dedupeKey,
  resolvedByAdminId: fraudSignalsTable.resolvedByAdminId,
  resolvedAt: fraudSignalsTable.resolvedAt,
  resolveNote: fraudSignalsTable.resolveNote,
  createdAt: fraudSignalsTable.createdAt,
};

interface SignalRow {
  id: number;
  kind: string;
  severity: string;
  score: number;
  studentId: number | null;
  studentName: string | null;
  terminalId: string | null;
  gateId: string | null;
  primaryScanId: number | null;
  relatedScanIds: number[];
  detail: string | null;
  evidence: string | null;
  status: string;
  dedupeKey: string | null;
  resolvedByAdminId: number | null;
  resolvedAt: Date | null;
  resolveNote: string | null;
  createdAt: Date;
}

function serializeSignal(row: SignalRow) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

// ── Signal list (Fraud Radar table) ─────────────────────────────
router.get("/fraud-signals", requireStaff, async (req, res): Promise<void> => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const q = parsed.data;

  const conditions: SQL[] = [];
  if (q.status) conditions.push(eq(fraudSignalsTable.status, q.status));
  if (q.kind) conditions.push(eq(fraudSignalsTable.kind, q.kind));
  if (q.severity) conditions.push(eq(fraudSignalsTable.severity, q.severity));
  if (q.studentId) conditions.push(eq(fraudSignalsTable.studentId, q.studentId));

  const rows = await db
    .select(signalColumns)
    .from(fraudSignalsTable)
    .leftJoin(studentsTable, eq(fraudSignalsTable.studentId, studentsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(fraudSignalsTable.createdAt))
    .limit(q.limit)
    .offset(q.offset);

  res.json(rows.map(serializeSignal));
});

// ── Counts for the radar header tiles ───────────────────────────
router.get("/fraud-signals/summary", requireStaff, async (_req, res): Promise<void> => {
  const [statusRows, kindRows, openCriticalRows] = await Promise.all([
    db
      .select({ status: fraudSignalsTable.status, total: sql<number>`count(*)` })
      .from(fraudSignalsTable)
      .groupBy(fraudSignalsTable.status),
    db
      .select({ kind: fraudSignalsTable.kind, total: sql<number>`count(*)` })
      .from(fraudSignalsTable)
      .groupBy(fraudSignalsTable.kind),
    db
      .select({ total: sql<number>`count(*)` })
      .from(fraudSignalsTable)
      .where(and(eq(fraudSignalsTable.status, "open"), eq(fraudSignalsTable.severity, "critical"))),
  ]);

  const byStatus: Record<(typeof SIGNAL_STATUSES)[number], number> = { open: 0, acknowledged: 0, resolved: 0, dismissed: 0 };
  for (const r of statusRows) {
    if ((SIGNAL_STATUSES as readonly string[]).includes(r.status)) {
      byStatus[r.status as (typeof SIGNAL_STATUSES)[number]] = Number(r.total);
    }
  }

  const byKind: Record<string, number> = Object.fromEntries(SIGNAL_KINDS.map((k) => [k, 0]));
  for (const r of kindRows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + Number(r.total);
  }

  res.json({
    byStatus,
    byKind,
    openCritical: Number(openCriticalRows[0]?.total ?? 0),
  });
});

// ── Triage decision (acknowledge / resolve / dismiss) ───────────
router.post("/fraud-signals/:id/decide", requireStaff, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid signal id" });
    return;
  }
  const parsed = decideInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [signal] = await db.select().from(fraudSignalsTable).where(eq(fraudSignalsTable.id, id)).limit(1);
  if (!signal) {
    res.status(404).json({ error: "Fraud signal not found" });
    return;
  }

  await db.update(fraudSignalsTable).set({
    status: parsed.data.status,
    resolveNote: parsed.data.note ?? null,
    resolvedAt: new Date(),
    resolvedByAdminId: adminId(req) ?? null,
  }).where(eq(fraudSignalsTable.id, id));

  await writeAudit({
    actorAdminId: adminId(req) ?? null,
    action: "fraud_signal.decided",
    targetType: "fraud_signal",
    targetId: id,
    payload: { status: parsed.data.status, kind: signal.kind, severity: signal.severity },
  });

  const [updated] = await db
    .select(signalColumns)
    .from(fraudSignalsTable)
    .leftJoin(studentsTable, eq(fraudSignalsTable.studentId, studentsTable.id))
    .where(eq(fraudSignalsTable.id, id))
    .limit(1);

  res.json(serializeSignal(updated));
});

export default router;
