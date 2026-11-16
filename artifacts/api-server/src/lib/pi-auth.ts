import { createHash, timingSafeEqual } from "node:crypto";
import { db, gateDevicesTable } from "@workspace/db";
import type { NextFunction, Request, Response } from "express";
import { and, eq, gt, isNotNull, or } from "drizzle-orm";

export function hashPiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PiAuthenticatedRequest extends Request {
  piDeviceId?: string;
  piPresentedTokenHash?: string;
}

export interface DeviceTokenIdentity {
  id: string;
  name: string;
  deviceType: string;
  mode: string;
  assignedGateId: string | null;
  healthStatus: string;
}

/**
 * Look up a device by its plaintext session token. Shared by requirePiToken
 * and the SSE stream (EventSource cannot set headers, so the device token
 * arrives as ?token= there).
 */
export async function deviceForToken(token: string): Promise<DeviceTokenIdentity | null> {
  if (!token || token.length > 256) return null;
  const hash = hashPiToken(token);
  const now = new Date();
  const devices = await db
    .select({
      id: gateDevicesTable.id,
      name: gateDevicesTable.name,
      deviceType: gateDevicesTable.deviceType,
      mode: gateDevicesTable.mode,
      assignedGateId: gateDevicesTable.assignedGateId,
      healthStatus: gateDevicesTable.healthStatus,
      currentTokenHash: gateDevicesTable.currentTokenHash,
      previousTokenHash: gateDevicesTable.previousTokenHash,
      previousTokenValidUntil: gateDevicesTable.previousTokenValidUntil,
      tokenExpiresAt: gateDevicesTable.tokenExpiresAt,
    })
    .from(gateDevicesTable)
    .where(
      or(
        and(eq(gateDevicesTable.currentTokenHash, hash), isNotNull(gateDevicesTable.currentTokenHash)),
        and(
          eq(gateDevicesTable.previousTokenHash, hash),
          isNotNull(gateDevicesTable.previousTokenHash),
          gt(gateDevicesTable.previousTokenValidUntil, now),
        ),
      ),
    )
    .limit(1);

  const device = devices[0];
  if (!device || (device.tokenExpiresAt && device.tokenExpiresAt <= now)) return null;
  if (
    !(
      (device.currentTokenHash && equalHash(hash, device.currentTokenHash)) ||
      (device.previousTokenHash && equalHash(hash, device.previousTokenHash))
    )
  ) {
    return null;
  }
  return {
    id: device.id,
    name: device.name,
    deviceType: device.deviceType,
    mode: device.mode,
    assignedGateId: device.assignedGateId,
    healthStatus: device.healthStatus,
  };
}

/**
 * Device-token auth (Phase 7: one mechanism for Pi kiosks AND phone camera
 * nodes — the header name stays `X-Pi-Token` for backwards compatibility;
 * the token lookup now runs against the unified gate_devices registry).
 */
export async function requirePiToken(
  req: PiAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.header("X-Pi-Token");
  if (!token) {
    res.status(401).json({ error: "Device session token required" });
    return;
  }

  const device = await deviceForToken(token);
  if (!device) {
    res.status(401).json({ error: "Device session expired; pair the device again" });
    return;
  }

  req.piDeviceId = device.id;
  req.piPresentedTokenHash = hashPiToken(token);
  next();
}

/** Phase 7 alias — same middleware, clearer name at the phone-camera call sites. */
export const requireDeviceToken = requirePiToken;
