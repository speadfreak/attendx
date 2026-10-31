import { createHash, timingSafeEqual } from "node:crypto";
import { db, piDevicesTable } from "@workspace/db";
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

export async function requirePiToken(
  req: PiAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.header("X-Pi-Token");
  if (!token || token.length > 256) {
    res.status(401).json({ error: "Pi session token required" });
    return;
  }

  const hash = hashPiToken(token);
  const now = new Date();
  const devices = await db
    .select({
      id: piDevicesTable.id,
      currentTokenHash: piDevicesTable.currentTokenHash,
      previousTokenHash: piDevicesTable.previousTokenHash,
      previousTokenValidUntil: piDevicesTable.previousTokenValidUntil,
      tokenExpiresAt: piDevicesTable.tokenExpiresAt,
    })
    .from(piDevicesTable)
    .where(
      or(
        and(eq(piDevicesTable.currentTokenHash, hash), isNotNull(piDevicesTable.currentTokenHash)),
        and(
          eq(piDevicesTable.previousTokenHash, hash),
          isNotNull(piDevicesTable.previousTokenHash),
          gt(piDevicesTable.previousTokenValidUntil, now),
        ),
      ),
    )
    .limit(1);

  const device = devices[0];
  if (!device || (device.tokenExpiresAt && device.tokenExpiresAt <= now)) {
    res.status(401).json({ error: "Pi session expired; pair the device again" });
    return;
  }

  // The database lookup scopes the token. Compare in constant time as a
  // defense-in-depth check before allowing machine-to-machine operations.
  if (
    !(
      (device.currentTokenHash && equalHash(hash, device.currentTokenHash)) ||
      (device.previousTokenHash && equalHash(hash, device.previousTokenHash))
    )
  ) {
    res.status(401).json({ error: "Invalid Pi session token" });
    return;
  }

  req.piDeviceId = device.id;
  req.piPresentedTokenHash = hash;
  next();
}
