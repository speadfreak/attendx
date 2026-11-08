import { Router, type Request } from "express";
import { db, gateIntegrityAlertsTable, gateSensorEventsTable } from "@workspace/db";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod/v4";
import { requirePiToken, type PiAuthenticatedRequest } from "../lib/pi-auth";
import { requireStaff, requireAdminLevel } from "../lib/auth";
import { runGateValidation, currentWindowSnapshot, windowSeries, injectSimulatedDiscrepancy } from "../lib/gate-integrity";
import { writeAudit } from "../lib/audit";
import { publishEvent } from "../lib/events";

const router = Router();
const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId;

/**
 * Phase 4 — Gate Integrity Validator.
 *
 * Ingestion  POST /gate/sensor-events   (Pi token auth — same session as heartbeat)
 * Live tile  GET  /gate/integrity/current
 * Chart      GET  /gate/integrity/windows?minutes=60
 * Alerts     GET  /gate/integrity/alerts[?resolved=false]
 * Detail     GET  /gate/integrity/alerts/:id  (per-sensor event timeline)
 * Resolve    POST /gate/integrity/alerts/:id/resolve
 * Manual run POST /gate/integrity/run
 * Demo       POST /gate/integrity/simulate { mode? }
 */

const ingestionSchema = z.object({
  gateId: z.string().trim().min(1).max(40).optional(),
  events: z
    .array(
      z.object({
        sensor: z.enum(["ultrasonic", "ir_beam"]),
        ts: z.union([z.iso.datetime({ offset: true }), z.iso.datetime(), z.number().int().positive(), z.string().regex(/^\d{10,16}$/)]),
      }),
    )
    .min(1)
    .max(500),
});

function parseEventTs(ts: string | number): Date | null {
  if (typeof ts === "number") {
    const ms = ts < 1e12 ? ts * 1000 : ts; // seconds or millis
    return new Date(ms);
  }
  if (/^\d{10,16}$/.test(ts)) {
    const n = Number(ts);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

router.post("/gate/sensor-events", requirePiToken, async (req, res): Promise<void> => {
  const parsed = ingestionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const piReq = req as PiAuthenticatedRequest;
  const gateId = parsed.data.gateId?.trim() || "gate-1";
  const now = Date.now();

  const rows = [];
  let skipped = 0;
  for (const event of parsed.data.events) {
    const at = parseEventTs(event.ts);
    // Reject timestamps older than 6h (stale spool replay) or > 5min in the future
    if (!at || at.getTime() < now - 6 * 3600_000 || at.getTime() > now + 5 * 60_000) {
      skipped += 1;
      continue;
    }
    rows.push({
      gateId,
      sensor: event.sensor,
      occurredAt: at,
      piDeviceId: piReq.piDeviceId ?? null,
      simulated: false,
    });
  }

  if (!rows.length) {
    res.status(400).json({ error: "No valid event timestamps in batch", skipped });
    return;
  }

  await db.insert(gateSensorEventsTable).values(rows);
  publishEvent("gate.integrity", { type: "ingested", gateId, count: rows.length, skipped });

  // Validate immediately — this is what makes alerts appear within seconds.
  const validation = await runGateValidation();
  res.status(201).json({ accepted: rows.length, skipped, validation });
});

router.get("/gate/integrity/current", requireStaff, async (_req, res): Promise<void> => {
  res.json(await currentWindowSnapshot());
});

router.get("/gate/integrity/windows", requireStaff, async (req, res): Promise<void> => {
  const minutes = Math.max(5, Math.min(240, Number(req.query.minutes ?? 60) || 60));
  res.json(await windowSeries(minutes));
});

router.get("/gate/integrity/alerts", requireStaff, async (req, res): Promise<void> => {
  const resolvedFilter = req.query.resolved;
  const conditions = [];
  if (resolvedFilter === "false") conditions.push(eq(gateIntegrityAlertsTable.resolved, false));
  if (resolvedFilter === "true") conditions.push(eq(gateIntegrityAlertsTable.resolved, true));
  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  conditions.push(gte(gateIntegrityAlertsTable.createdAt, since));

  const rows = await db
    .select()
    .from(gateIntegrityAlertsTable)
    .where(and(...conditions))
    .orderBy(desc(gateIntegrityAlertsTable.windowStart))
    .limit(150);

  res.json(rows.map((r) => ({
    id: r.id,
    gateId: r.gateId,
    windowStart: r.windowStart.toISOString(),
    windowEnd: r.windowEnd.toISOString(),
    cameraCount: r.cameraCount,
    ultrasonicCount: r.ultrasonicCount,
    irCount: r.irCount,
    alertType: r.alertType,
    resolved: r.resolved,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolveNote: r.resolveNote,
    simulated: r.simulated,
    createdAt: r.createdAt.toISOString(),
  })));
});

router.get("/gate/integrity/alerts/:id", requireStaff, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [alert] = await db.select().from(gateIntegrityAlertsTable).where(eq(gateIntegrityAlertsTable.id, id)).limit(1);
  if (!alert) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }

  // Exact pass-event timestamps for the window — the "whoa" timeline view.
  const events = await db
    .select({
      id: gateSensorEventsTable.id,
      sensor: gateSensorEventsTable.sensor,
      occurredAt: gateSensorEventsTable.occurredAt,
      simulated: gateSensorEventsTable.simulated,
      piDeviceId: gateSensorEventsTable.piDeviceId,
    })
    .from(gateSensorEventsTable)
    .where(and(
      eq(gateSensorEventsTable.gateId, alert.gateId),
      gte(gateSensorEventsTable.occurredAt, alert.windowStart),
      lte(gateSensorEventsTable.occurredAt, alert.windowEnd),
    ))
    .orderBy(gateSensorEventsTable.occurredAt);

  res.json({
    id: alert.id,
    gateId: alert.gateId,
    windowStart: alert.windowStart.toISOString(),
    windowEnd: alert.windowEnd.toISOString(),
    cameraCount: alert.cameraCount,
    ultrasonicCount: alert.ultrasonicCount,
    irCount: alert.irCount,
    alertType: alert.alertType,
    resolved: alert.resolved,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    resolveNote: alert.resolveNote,
    simulated: alert.simulated,
    detail: alert.detail ?? {},
    createdAt: alert.createdAt.toISOString(),
    sensorEvents: events.map((e) => ({
      id: e.id,
      sensor: e.sensor,
      occurredAt: e.occurredAt.toISOString(),
      simulated: e.simulated,
      piDeviceId: e.piDeviceId,
    })),
  });
});

router.post("/gate/integrity/alerts/:id/resolve", requireAdminLevel, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : null;
  const [updated] = await db
    .update(gateIntegrityAlertsTable)
    .set({ resolved: true, resolvedAt: new Date(), resolvedByAdminId: adminId(req) ?? null, resolveNote: note })
    .where(eq(gateIntegrityAlertsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  await writeAudit({
    actorAdminId: adminId(req),
    action: "gate.integrity.resolved",
    targetType: "gate_alert",
    targetId: id,
    payload: { alertType: updated.alertType, note, windowStart: updated.windowStart.toISOString() },
  });
  publishEvent("gate.integrity", { type: "resolved", alertId: id });
  res.json({ ok: true });
});

router.post("/gate/integrity/run", requireAdminLevel, async (req, res): Promise<void> => {
  const validation = await runGateValidation({ force: true });
  await writeAudit({
    actorAdminId: adminId(req),
    action: "gate.integrity.manual_run",
    targetType: "gate_alert",
    payload: { ...validation, alertsCreated: validation.alertsCreated.length },
  });
  res.json(validation);
});

const simulateSchema = z.object({
  mode: z.enum(["missed_detections", "sensor_conflict"]).optional(),
});

router.post("/gate/integrity/simulate", requireAdminLevel, async (req, res): Promise<void> => {
  const parsed = simulateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const mode = parsed.data.mode ?? "missed_detections";
  const result = await injectSimulatedDiscrepancy(mode);
  await writeAudit({
    actorAdminId: adminId(req),
    action: "gate.integrity.simulated",
    targetType: "gate_alert",
    targetId: result.alertIds.join(",") || null,
    payload: { mode, injectedEvents: result.injected, simulated: true, alertIds: result.alertIds },
  });
  res.status(201).json({ simulated: true, ...result });
});

export default router;
