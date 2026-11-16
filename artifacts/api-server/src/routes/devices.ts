import { Router } from "express";
import { randomBytes } from "node:crypto";
import { and, eq, gte, sql, desc } from "drizzle-orm";
import { db, gateDevicesTable, gatesTable, deviceUptimeDaysTable } from "@workspace/db";
import { z } from "zod/v4";
import { requireAuth } from "../lib/auth";
import { hashPiToken, requireDeviceToken, type PiAuthenticatedRequest } from "../lib/pi-auth";
import { pairDevice, deviceOnline, recordDeviceUptime, TOKEN_LIFETIME_MS } from "../lib/devices";
import { writeAudit } from "../lib/audit";
import { publishEvent } from "../lib/events";
import type { Request } from "express";

/**
 * Phase 7 — unified gate-device network (Pi kiosks + phone PWA cameras).
 * Pairing / heartbeat / commands reuse the exact token-rotation pattern the
 * Pi flow introduced; phones are just another device_type.
 */
const router = Router();

const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId ?? null;

export const pairingSchema = z.object({
  name: z.string().trim().min(1).max(80),
  deviceType: z.enum(["pi", "phone"]).default("phone"),
  // gateId semantics (owned by lib/devices.ts pairDevice):
  //   absent / null → keep the current assignment (re-pair) or no gate (new)
  //   ""            → explicitly UNASSIGN the gate
  //   "gate_x"      → assign that gate
  // Zod v4 `.optional()` alone REJECTS an explicit null in the JSON body —
  // which is exactly the 400 the phone "Connect" flow hit (the ops dialog
  // sends null for its "No gate" option). `.nullish()` accepts both.
  gateId: z.string().trim().max(80).nullish(),
  mode: z.enum(["face", "qr"]).optional(),
});

const commandSchema = z.object({
  command: z.enum([
    "switch_mode",
    "request_snapshot",
    "disconnect",
    "flashlight_toggle",
    "set_quality",
    "set_data_saver",
  ]),
  value: z.union([z.string().max(40), z.number(), z.boolean(), z.null()]).optional().default(null),
});

const heartbeatSchema = z.object({
  status: z.enum(["connected", "running_task", "degraded"]).default("connected"),
  mode: z.enum(["face", "qr"]).optional(),
  fps: z.number().finite().min(0).max(120).nullable().optional(),
  resolution: z.string().max(24).optional(),
  healthStatus: z.enum(["ok", "obstructed", "frozen", "unknown"]).optional(),
  batteryLevel: z.number().min(0).max(100).nullable().optional(),
  connection: z.string().max(32).optional(),
  dataSaver: z.boolean().optional(),
  uptimeSeconds: z.number().int().min(0).optional(),
  localIp: z.string().max(64).optional(),
  queueDepth: z.number().int().min(0).optional(),
});

const COMMAND_TTL_MS = 10 * 60 * 1000;

/** Strip token material before a device row leaves the API. */
function publicDevice(row: typeof gateDevicesTable.$inferSelect, gateName: string | null) {
  const online = deviceOnline(row.lastSeenAt);
  const healthy = row.deviceType === "phone" && row.healthStatus !== "ok";
  return {
    id: row.id,
    name: row.name,
    deviceType: row.deviceType,
    mode: row.mode,
    status: online ? (healthy ? "degraded" : row.status) : "offline",
    online,
    healthStatus: row.healthStatus,
    assignedGateId: row.assignedGateId,
    gateName,
    resolution: row.resolution,
    fps: row.fps,
    batteryLevel: row.batteryLevel,
    connection: row.connection,
    dataSaver: row.dataSaver,
    targetQuality: row.targetQuality,
    cpuTempC: row.cpuTempC,
    queueDepth: row.queueDepth,
    fanState: row.fanState,
    uptimeSeconds: row.uptimeSeconds,
    thumbnail: row.thumbnail,
    thumbnailAt: row.thumbnailAt ? row.thumbnailAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    paired: Boolean(row.currentTokenHash || row.tokenExpiresAt),
  };
}

// ── pairing ────────────────────────────────────────────────────────────

router.post("/devices/pair", requireAuth, async (req, res): Promise<void> => {
  const parsed = pairingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await pairDevice(
      {
        name: parsed.data.name,
        deviceType: parsed.data.deviceType,
        gateId: parsed.data.gateId ?? null,
        mode: parsed.data.mode,
      },
      adminId(req),
    );
    await writeAudit({
      actorAdminId: adminId(req),
      action: "device.paired",
      targetType: "gate_device",
      targetId: result.deviceId,
      payload: { deviceType: parsed.data.deviceType, gateId: result.gateId, tokenExpiresAt: result.expiresAt.toISOString() },
    });
    res.status(201).json({
      deviceId: result.deviceId,
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      gateId: result.gateId,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Pairing failed" });
  }
});

/** Re-pair an existing device (Regenerate token — "Connect" from Ops). */
router.post("/devices/:id/pair", requireAuth, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const parsed = pairingSchema.safeParse({ ...req.body, deviceType: (req.body as { deviceType?: string } | undefined)?.deviceType ?? "phone" });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await pairDevice(
      { name: parsed.data.name, deviceType: parsed.data.deviceType, gateId: parsed.data.gateId ?? null, mode: parsed.data.mode, deviceId: id },
      adminId(req),
    );
    await writeAudit({
      actorAdminId: adminId(req),
      action: "device.repaired",
      targetType: "gate_device",
      targetId: result.deviceId,
      payload: { tokenExpiresAt: result.expiresAt.toISOString() },
    });
    res.json({ deviceId: result.deviceId, token: result.token, expiresAt: result.expiresAt.toISOString(), gateId: result.gateId });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : "Re-pairing failed" });
  }
});

// ── fleet view ─────────────────────────────────────────────────────────

router.get("/devices", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({ device: gateDevicesTable, gateName: gatesTable.name })
    .from(gateDevicesTable)
    .leftJoin(gatesTable, eq(gateDevicesTable.assignedGateId, gatesTable.gateId))
    .orderBy(gateDevicesTable.deviceType, gateDevicesTable.createdAt);
  res.json(rows.map((r) => publicDevice(r.device, r.gateName ?? null)));
});

// ── uptime report ──────────────────────────────────────────────────────

router.get("/devices/uptime", requireAuth, async (req, res): Promise<void> => {
  const days = Math.max(1, Math.min(Number(req.query.days ?? 7) || 7, 60));
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      deviceId: deviceUptimeDaysTable.deviceId,
      deviceName: gateDevicesTable.name,
      deviceType: gateDevicesTable.deviceType,
      assignedGateId: gateDevicesTable.assignedGateId,
      day: deviceUptimeDaysTable.day,
      onlineSeconds: deviceUptimeDaysTable.onlineSeconds,
      heartbeats: deviceUptimeDaysTable.heartbeats,
    })
    .from(deviceUptimeDaysTable)
    .leftJoin(gateDevicesTable, eq(deviceUptimeDaysTable.deviceId, gateDevicesTable.id))
    .where(gte(deviceUptimeDaysTable.day, since))
    .orderBy(deviceUptimeDaysTable.deviceId, deviceUptimeDaysTable.day);

  const perDevice = new Map<string, { deviceId: string; deviceName: string; deviceType: string; assignedGateId: string | null; days: Array<{ day: string; onlineSeconds: number; heartbeats: number }>; totalSeconds: number }>();
  for (const r of rows) {
    const entry = perDevice.get(r.deviceId) ?? {
      deviceId: r.deviceId,
      deviceName: r.deviceName ?? r.deviceId,
      deviceType: r.deviceType ?? "phone",
      assignedGateId: r.assignedGateId ?? null,
      days: [],
      totalSeconds: 0,
    };
    entry.days.push({ day: r.day, onlineSeconds: r.onlineSeconds, heartbeats: r.heartbeats });
    entry.totalSeconds += r.onlineSeconds;
    perDevice.set(r.deviceId, entry);
  }
  const expectedSeconds = days * 86400;
  res.json(
    [...perDevice.values()].map((e) => ({
      deviceId: e.deviceId,
      deviceName: e.deviceName,
      deviceType: e.deviceType,
      assignedGateId: e.assignedGateId,
      days: e.days,
      onlinePct: Math.round((e.totalSeconds / expectedSeconds) * 1000) / 10,
    })),
  );
});

// ── operator remote commands (SSE push + heartbeat mailbox) ────────────

router.post("/devices/:id/command", requireAuth, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const parsed = commandSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { command, value } = parsed.data;
  // Per-command value validation.
  if (command === "switch_mode" && value !== "face" && value !== "qr") {
    res.status(400).json({ error: "switch_mode requires value 'face' or 'qr'." });
    return;
  }
  if (command === "set_quality" && value !== null && value !== "low" && value !== "balanced" && value !== "hd") {
    res.status(400).json({ error: "set_quality requires 'low' | 'balanced' | 'hd' | null (auto)." });
    return;
  }
  if (command === "set_data_saver" && typeof value !== "boolean") {
    res.status(400).json({ error: "set_data_saver requires a boolean value." });
    return;
  }

  const [device] = await db.select({ id: gateDevicesTable.id, mode: gateDevicesTable.mode, targetQuality: gateDevicesTable.targetQuality }).from(gateDevicesTable).where(eq(gateDevicesTable.id, id)).limit(1);
  if (!device) {
    res.status(404).json({ error: `Device ${id} not found.` });
    return;
  }

  const at = new Date();
  // Mailbox write: the device drains this on its next heartbeat even when
  // the SSE push never reaches it (serverless restart, network blip).
  await db
    .update(gateDevicesTable)
    .set({ pendingCommand: JSON.stringify({ command, value }), pendingCommandAt: at })
    .where(eq(gateDevicesTable.id, id));
  // Quality/data-saver overrides are persisted server-side too, so a
  // re-paired phone inherits the operator's intent.
  if (command === "set_quality") {
    await db.update(gateDevicesTable).set({ targetQuality: value === null ? null : String(value) }).where(eq(gateDevicesTable.id, id));
  }
  if (command === "switch_mode" && (value === "face" || value === "qr")) {
    await db.update(gateDevicesTable).set({ mode: value }).where(eq(gateDevicesTable.id, id));
  }

  // Live push for near-instant delivery.
  publishEvent("device.command", { deviceId: id, command, value, at: at.toISOString() });
  await writeAudit({
    actorAdminId: adminId(req),
    action: "device.command",
    targetType: "gate_device",
    targetId: id,
    payload: { command, value },
  });
  res.json({ ok: true, delivered: "sse+mailbox", command, value: value ?? null });
});

// ── device heartbeat (Pi + phone; rotates the session token) ───────────

router.post("/devices/heartbeat", requireDeviceToken, async (req, res): Promise<void> => {
  const parsed = heartbeatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const devReq = req as PiAuthenticatedRequest;
  if (!devReq.piDeviceId || !devReq.piPresentedTokenHash) {
    res.status(401).json({ error: "Device session is missing" });
    return;
  }
  const deviceId = devReq.piDeviceId;
  const [row] = await db.select().from(gateDevicesTable).where(eq(gateDevicesTable.id, deviceId)).limit(1);
  if (!row) {
    res.status(401).json({ error: "Unknown device; pair again" });
    return;
  }

  const nextToken = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_MS);
  const data = parsed.data;

  await db
    .update(gateDevicesTable)
    .set({
      status: data.status,
      mode: data.mode ?? row.mode,
      fps: data.fps ?? row.fps,
      resolution: data.resolution ?? row.resolution,
      healthStatus: data.healthStatus ?? row.healthStatus,
      batteryLevel: data.batteryLevel !== undefined ? data.batteryLevel : row.batteryLevel,
      connection: data.connection ?? row.connection,
      dataSaver: data.dataSaver ?? row.dataSaver,
      uptimeSeconds: data.uptimeSeconds ?? row.uptimeSeconds,
      localIp: data.localIp ?? row.localIp,
      queueDepth: data.queueDepth ?? row.queueDepth,
      lastSeenAt: now,
      currentTokenHash: hashPiToken(nextToken),
      previousTokenHash: devReq.piPresentedTokenHash,
      previousTokenValidUntil: new Date(now.getTime() + 60 * 1000),
      tokenExpiresAt: expiresAt,
    })
    .where(eq(gateDevicesTable.id, deviceId));

  recordDeviceUptime(deviceId, row.lastSeenAt, now);

  const unhealthy = data.healthStatus && data.healthStatus !== "ok" && data.healthStatus !== "unknown";
  publishEvent("device.heartbeat", {
    deviceId,
    deviceType: row.deviceType,
    status: data.status,
    mode: data.mode ?? row.mode,
    healthStatus: data.healthStatus ?? row.healthStatus,
    batteryLevel: data.batteryLevel ?? row.batteryLevel,
    fps: data.fps ?? row.fps,
    at: now.toISOString(),
  });
  if (unhealthy) {
    publishEvent("device.health", {
      deviceId,
      healthStatus: data.healthStatus,
      assignedGateId: row.assignedGateId,
      at: now.toISOString(),
    });
  }

  // Drain the command mailbox (works even when SSE was unreachable).
  let command: { command: string; value: unknown } | null = null;
  if (row.pendingCommand && row.pendingCommandAt && Date.now() - row.pendingCommandAt.getTime() <= COMMAND_TTL_MS) {
    try {
      command = JSON.parse(row.pendingCommand) as { command: string; value: unknown };
    } catch {
      command = null;
    }
  }
  if (row.pendingCommand) {
    await db
      .update(gateDevicesTable)
      .set({ pendingCommand: null, pendingCommandAt: null })
      .where(eq(gateDevicesTable.id, deviceId));
  }

  res.json({
    accepted: true,
    deviceId,
    // Identity so a token-only pairing (QR contains just the token) tells
    // the phone what it is without a second authenticated endpoint.
    device: {
      id: deviceId,
      name: row.name,
      deviceType: row.deviceType,
      mode: row.mode,
      assignedGateId: row.assignedGateId,
      healthStatus: row.healthStatus,
    },
    nextToken,
    expiresAt: expiresAt.toISOString(),
    serverTime: now.toISOString(),
    command,
    targetQuality: row.targetQuality,
  });
});

function randomToken(): string {
  // same entropy/format as the Pi pairing flow
  return randomBytes(32).toString("base64url");
}

// ── thumbnail upload (operator visual confirmation, one still frame) ───

router.post("/devices/:id/thumbnail", requireDeviceToken, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const devReq = req as PiAuthenticatedRequest;
  // A device may only write its OWN thumbnail.
  if (devReq.piDeviceId !== id) {
    res.status(403).json({ error: "Devices can only upload their own thumbnail" });
    return;
  }
  const bodySchema = z.object({ image: z.string().max(120_000) });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "image (JPEG data URL, ≤ ~90 KB) required" });
    return;
  }
  if (!parsed.data.image.startsWith("data:image/")) {
    res.status(400).json({ error: "image must be a data:image/* URL" });
    return;
  }
  await db
    .update(gateDevicesTable)
    .set({ thumbnail: parsed.data.image, thumbnailAt: new Date() })
    .where(eq(gateDevicesTable.id, id));
  res.json({ ok: true });
});

// ── disconnect (revoke session; device must re-pair) ───────────────────

router.post("/devices/:id/disconnect", requireAuth, async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const [device] = await db.select({ id: gateDevicesTable.id }).from(gateDevicesTable).where(eq(gateDevicesTable.id, id)).limit(1);
  if (!device) {
    res.status(404).json({ error: `Device ${id} not found.` });
    return;
  }
  // Tell the live phone to stand down first (SSE), then revoke its tokens.
  publishEvent("device.command", { deviceId: id, command: "disconnect", value: null, at: new Date().toISOString() });
  await db
    .update(gateDevicesTable)
    .set({
      status: "offline",
      healthStatus: "unknown",
      currentTokenHash: null,
      previousTokenHash: null,
      previousTokenValidUntil: null,
      tokenExpiresAt: null,
      pendingCommand: null,
      pendingCommandAt: null,
    })
    .where(eq(gateDevicesTable.id, id));
  await writeAudit({
    actorAdminId: adminId(req),
    action: "device.disconnected",
    targetType: "gate_device",
    targetId: id,
    payload: {},
  });
  res.json({ ok: true, revoked: true });
});

/** Devices that reported heartbeats recently — used by the ops pages. */
router.get("/devices/recent", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({ id: gateDevicesTable.id, name: gateDevicesTable.name, lastSeenAt: gateDevicesTable.lastSeenAt })
    .from(gateDevicesTable)
    .where(and(sql`${gateDevicesTable.lastSeenAt} IS NOT NULL`, gte(gateDevicesTable.lastSeenAt, new Date(Date.now() - 24 * 3600 * 1000))))
    .orderBy(desc(gateDevicesTable.lastSeenAt))
    .limit(50);
  res.json(rows.map((r) => ({ ...r, lastSeenAt: r.lastSeenAt?.toISOString() ?? null })));
});

export default router;
