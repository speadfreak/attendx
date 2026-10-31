import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db, jobsTable, piDevicesTable } from "@workspace/db";
import { z } from "zod/v4";
import { requireAuth } from "../lib/auth";
import { hashPiToken, requirePiToken, type PiAuthenticatedRequest } from "../lib/pi-auth";
import { enqueueJob } from "../lib/jobs";
import { writeAudit } from "../lib/audit";

const router = Router();
const DEVICE_ID = "attendx-pi";
const TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const PREVIOUS_TOKEN_GRACE_MS = 60 * 1000;
const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId;

const pairingSchema = z.object({ name: z.string().trim().min(1).max(80) });
const heartbeatSchema = z.object({
  status: z.enum(["connected", "running_task"]),
  localIp: z.string().max(64).optional(),
  uptimeSeconds: z.number().int().min(0),
  cpuTempC: z.number().finite().nullable().optional(),
  queueDepth: z.number().int().min(0),
  fanTempC: z.number().finite().nullable().optional(),
  fanState: z.enum(["on", "off", "auto", "unknown"]).optional(),
});
const actionSchema = z.object({
  action: z.enum(["worker-status", "restart-worker", "camera-status", "recent-logs"]),
});

router.post("/pi/pair", requireAuth, async (req, res): Promise<void> => {
  const parsed = pairingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
  const existing = await db.select({ id: piDevicesTable.id }).from(piDevicesTable).where(eq(piDevicesTable.id, DEVICE_ID)).limit(1);
  if (existing[0]) {
    await db.update(piDevicesTable).set({
      name: parsed.data.name,
      status: "discovered",
      currentTokenHash: hashPiToken(token),
      previousTokenHash: null,
      previousTokenValidUntil: null,
      tokenExpiresAt: expiresAt,
    }).where(eq(piDevicesTable.id, DEVICE_ID));
  } else {
    await db.insert(piDevicesTable).values({
      id: DEVICE_ID,
      name: parsed.data.name,
      status: "discovered",
      currentTokenHash: hashPiToken(token),
      tokenExpiresAt: expiresAt,
    });
  }

  await writeAudit({
    actorAdminId: adminId(req),
    action: "pi.paired",
    targetType: "pi_device",
    targetId: DEVICE_ID,
    payload: { tokenExpiresAt: expiresAt.toISOString() },
  });
  res.json({ deviceId: DEVICE_ID, token, expiresAt: expiresAt.toISOString() });
});

router.get("/pi/status", requireAuth, async (_req, res): Promise<void> => {
  const [device] = await db.select().from(piDevicesTable).where(eq(piDevicesTable.id, DEVICE_ID)).limit(1);
  if (!device) {
    res.json({ device: null, online: false, staleAfterSeconds: 30 });
    return;
  }
  const online = Boolean(device.lastSeenAt && Date.now() - device.lastSeenAt.getTime() <= 30_000);
  if (!online && device.status !== "offline") {
    await db.update(piDevicesTable).set({ status: "offline" }).where(eq(piDevicesTable.id, DEVICE_ID));
  }
  res.json({
    device: {
      id: device.id,
      name: device.name,
      status: online ? device.status : "offline",
      localIp: device.localIp,
      uptimeSeconds: device.uptimeSeconds,
      cpuTempC: device.cpuTempC,
      queueDepth: device.queueDepth,
      fanTempC: device.fanTempC,
      fanState: device.fanState,
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    },
    online,
    staleAfterSeconds: 30,
  });
});

router.post("/pi/heartbeat", requirePiToken, async (req, res): Promise<void> => {
  const parsed = heartbeatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const piReq = req as PiAuthenticatedRequest;
  if (!piReq.piDeviceId || !piReq.piPresentedTokenHash) {
    res.status(401).json({ error: "Pi device session is missing" });
    return;
  }

  const nextToken = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_MS);
  await db.update(piDevicesTable).set({
    status: parsed.data.status,
    localIp: parsed.data.localIp ?? null,
    uptimeSeconds: parsed.data.uptimeSeconds,
    cpuTempC: parsed.data.cpuTempC ?? null,
    queueDepth: parsed.data.queueDepth,
    fanTempC: parsed.data.fanTempC ?? null,
    fanState: parsed.data.fanState ?? "unknown",
    lastSeenAt: now,
    currentTokenHash: hashPiToken(nextToken),
    previousTokenHash: piReq.piPresentedTokenHash,
    previousTokenValidUntil: new Date(now.getTime() + PREVIOUS_TOKEN_GRACE_MS),
    tokenExpiresAt: expiresAt,
  }).where(eq(piDevicesTable.id, piReq.piDeviceId));

  const recentTelemetry = await db.select({ id: jobsTable.id }).from(jobsTable).where(and(
    eq(jobsTable.type, "fan_telemetry"),
    eq(jobsTable.worker, "pi"),
    gte(jobsTable.createdAt, new Date(now.getTime() - 25_000)),
  )).limit(1);
  if (!recentTelemetry[0]) {
    await enqueueJob({ type: "fan_telemetry", worker: "pi", payload: {} });
  }

  res.json({
    accepted: true,
    nextToken,
    expiresAt: expiresAt.toISOString(),
    serverTime: now.toISOString(),
  });
});

router.post("/pi/actions", requireAuth, async (req, res): Promise<void> => {
  const parsed = actionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const job = await enqueueJob({ type: "pi_action", payload: { action: parsed.data.action }, worker: "pi" });
  await writeAudit({
    actorAdminId: adminId(req),
    action: "pi.action.queued",
    targetType: "job",
    targetId: job.id,
    payload: { action: parsed.data.action },
  });
  res.status(201).json(job);
});

router.post("/pi/sessions/kill", requireAuth, async (req, res): Promise<void> => {
  await db.update(piDevicesTable).set({
    status: "offline",
    currentTokenHash: null,
    previousTokenHash: null,
    previousTokenValidUntil: null,
    tokenExpiresAt: null,
  }).where(eq(piDevicesTable.id, DEVICE_ID));

  const cancelled = await db.update(jobsTable)
    .set({ status: "cancelled", completedAt: new Date(), error: "Cancelled by administrator" })
    .where(and(eq(jobsTable.worker, "pi"), inArray(jobsTable.status, ["pending", "running"])))
    .returning({ id: jobsTable.id });
  await writeAudit({
    actorAdminId: adminId(req),
    action: "pi.sessions.revoked",
    targetType: "pi_device",
    targetId: DEVICE_ID,
    payload: { cancelledJobs: cancelled.length },
  });
  res.json({ revoked: true, cancelledJobs: cancelled.length });
});

export default router;
