import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, gatesTable } from "@workspace/db";
import { requireStaff, requireAdminLevel } from "../lib/auth";
import { listGates, upsertGate, type Gate } from "../lib/gates";
import { writeAudit } from "../lib/audit";

/**
 * Phase 6 — Gate registry management (geofenced QR).
 *
 * Gates map physical school entrances to kiosk terminals and carry the
 * geofence center/radius used by the scan-path GPS check (lib/gates.ts).
 * Read is staff-level; create/update/delete are admin-level.
 */
const router = Router();
const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId;

const gateInput = z.object({
  name: z.string().trim().min(1).max(120),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  geofenceRadiusM: z.number().int().min(20).max(5000).optional(), // default 150 (upsertGate)
  terminalIds: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
});

function parseGateId(req: Request): string | null {
  const gateId = String(req.params.gateId ?? "").trim();
  if (!gateId || gateId.length > 80) return null;
  return gateId;
}

function serializeGate(g: Gate) {
  return {
    gateId: g.gateId,
    name: g.name,
    latitude: g.latitude,
    longitude: g.longitude,
    geofenceRadiusM: g.geofenceRadiusM,
    terminalIds: g.terminalIds,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

// ── List registered gates ───────────────────────────────────────
router.get("/gates", requireStaff, async (_req, res): Promise<void> => {
  const gates = await listGates();
  res.json(gates.map(serializeGate));
});

// ── Create / update a gate (Operations console) ─────────────────
router.put("/gates/:gateId", requireAdminLevel, async (req, res): Promise<void> => {
  const gateId = parseGateId(req);
  if (!gateId) {
    res.status(400).json({ error: "Invalid gate id" });
    return;
  }
  const parsed = gateInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const gate = await upsertGate({
    gateId,
    name: parsed.data.name,
    latitude: parsed.data.latitude ?? null,
    longitude: parsed.data.longitude ?? null,
    geofenceRadiusM: parsed.data.geofenceRadiusM,
    terminalIds: parsed.data.terminalIds,
  });
  // Note: updatedAt is stamped on update by the schema's $onUpdate hook,
  // which drizzle applies inside onConflictDoUpdate's set clause.

  await writeAudit({
    actorAdminId: adminId(req) ?? null,
    action: "gate.upserted",
    targetType: "gate",
    targetId: gateId,
    payload: { name: parsed.data.name, terminalIds: parsed.data.terminalIds ?? [] },
  });

  res.json(serializeGate(gate));
});

// ── Remove a gate ───────────────────────────────────────────────
router.delete("/gates/:gateId", requireAdminLevel, async (req, res): Promise<void> => {
  const gateId = parseGateId(req);
  if (!gateId) {
    res.status(400).json({ error: "Invalid gate id" });
    return;
  }

  const deleted = await db
    .delete(gatesTable)
    .where(eq(gatesTable.gateId, gateId))
    .returning({ gateId: gatesTable.gateId });
  if (!deleted.length) {
    res.status(404).json({ error: "Gate not found" });
    return;
  }

  await writeAudit({
    actorAdminId: adminId(req) ?? null,
    action: "gate.deleted",
    targetType: "gate",
    targetId: gateId,
    payload: {},
  });

  res.json({ ok: true });
});

export default router;
