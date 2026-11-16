import { randomBytes } from "node:crypto";
import { db, gateDevicesTable, gatesTable, deviceUptimeDaysTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { hashPiToken } from "./pi-auth";
import { publishEvent } from "./events";

/**
 * Shared gate-device pairing + telemetry helpers (Phase 7).
 * ONE mechanism for Pi kiosks and phone camera nodes: short-lived token
 * shown once, stored only as a SHA-256 hash, rotated on every heartbeat
 * with a 60s grace window for the previous token.
 */

export const TOKEN_LIFETIME_MS = 15 * 60 * 1000;
export const PREVIOUS_TOKEN_GRACE_MS = 60 * 1000;
/** A device is "online" while its last heartbeat is younger than this. */
export const ONLINE_WINDOW_MS = 30_000;

export type DeviceType = "pi" | "phone";

export function deviceOnline(lastSeenAt: Date | null): boolean {
  return Boolean(lastSeenAt && Date.now() - lastSeenAt.getTime() <= ONLINE_WINDOW_MS);
}

export interface PairDeviceInput {
  name: string;
  /** Omitted/null on re-pair = keep the device's existing type. */
  deviceType?: DeviceType | null;
  gateId?: string | null;
  mode?: "face" | "qr";
  /** Re-pair an existing device (regenerate its token, keep its config). */
  deviceId?: string | null;
}

export interface PairDeviceResult {
  deviceId: string;
  token: string;
  expiresAt: Date;
  gateId: string | null;
}

/**
 * Issue (or re-issue) a device session: creates the gate_devices row for a
 * new device, or rotates the token of an existing one. When a gate is
 * assigned, the device id is appended to gates.terminal_ids so the existing
 * geofence resolution (gateForTerminal) works for phone QR scans unchanged.
 */
export async function pairDevice(
  input: PairDeviceInput,
  actorAdminId: number | null,
): Promise<PairDeviceResult> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
  const tokenHash = hashPiToken(token);

  let deviceId = input.deviceId ?? null;
  let publishedType: DeviceType = "phone";
  // "" never lands in the DB — new pairs treat it the same as "no gate".
  // (Re-pair reads input.gateId directly below; "" there means explicit clear.)
  let gateId = input.gateId === "" ? null : (input.gateId ?? null);

  if (deviceId) {
    // Re-pair: keep identity + config, mint a fresh session.
    const [existing] = await db
      .select({
        id: gateDevicesTable.id,
        assignedGateId: gateDevicesTable.assignedGateId,
        deviceType: gateDevicesTable.deviceType,
      })
      .from(gateDevicesTable)
      .where(eq(gateDevicesTable.id, deviceId))
      .limit(1);
    if (!existing) throw new Error(`Device ${deviceId} not found`);
    // "" is an explicit "unassign" from the ops dialog; null/absent keeps the
    // current gate; a real id reassigns (and rewires terminal_ids below).
    gateId = input.gateId === "" ? null : (input.gateId ?? existing.assignedGateId ?? null);
    // A bare repair call omits deviceType — preserve whatever the device is
    // (a Pi must never silently flip into a phone).
    const resolvedType: DeviceType =
      input.deviceType === "pi" || input.deviceType === "phone" ? input.deviceType : (existing.deviceType as DeviceType);
    await db
      .update(gateDevicesTable)
      .set({
        name: input.name,
        deviceType: resolvedType,
        mode: input.mode ?? undefined,
        status: "discovered",
        assignedGateId: gateId,
        currentTokenHash: tokenHash,
        previousTokenHash: null,
        previousTokenValidUntil: null,
        tokenExpiresAt: expiresAt,
      })
      .where(eq(gateDevicesTable.id, deviceId));
    // Detach from the previous gate's terminal list on reassign/clear, so
    // gateForTerminal() can no longer resolve the stale gate for QR scans.
    if (existing.assignedGateId && existing.assignedGateId !== gateId) {
      await db
        .update(gatesTable)
        .set({
          terminalIds: sql`array_remove(${gatesTable.terminalIds}, ${deviceId})`,
          updatedAt: new Date(),
        })
        .where(eq(gatesTable.gateId, existing.assignedGateId));
    }
    publishedType = resolvedType;
  } else {
    const prefix = input.deviceType === "pi" ? "pi" : "ph";
    publishedType = input.deviceType === "pi" ? "pi" : "phone";
    deviceId = `${prefix}_${randomBytes(4).toString("hex")}`;
    await db.insert(gateDevicesTable).values({
      id: deviceId,
      name: input.name,
      deviceType: publishedType,
      mode: input.mode ?? "face",
      status: "discovered",
      assignedGateId: gateId,
      currentTokenHash: tokenHash,
      tokenExpiresAt: expiresAt,
    });
  }

  // Wire the device into the gate's terminal list so geofenced QR scanning
  // resolves the gate for scans whose terminalId === deviceId.
  if (gateId) {
    const [gate] = await db
      .select({ gateId: gatesTable.gateId })
      .from(gatesTable)
      .where(eq(gatesTable.gateId, gateId))
      .limit(1);
    if (!gate) throw new Error(`Gate ${gateId} not found`);
    await db
      .update(gatesTable)
      .set({
        terminalIds: sql`CASE WHEN ${gatesTable.terminalIds} @> ARRAY[${deviceId}]::text[]
          THEN ${gatesTable.terminalIds}
          ELSE array_append(${gatesTable.terminalIds}, ${deviceId}) END`,
        updatedAt: new Date(),
      })
      .where(eq(gatesTable.gateId, gateId));
  }

  publishEvent("device.updated", { deviceId, action: input.deviceId ? "repaired" : "paired", deviceType: publishedType });
  void actorAdminId; // audit written by the route layer (keeps this lib pure)
  return { deviceId, token, expiresAt, gateId: gateId ?? null };
}

const MAX_HEARTBEAT_GAP_SECONDS = 600;

/**
 * Credit the online time since the previous heartbeat to today's (UTC)
 * uptime rollup. Gaps longer than 10 minutes are capped — a phone that
 * reconnects hours later must not be credited for the outage window.
 * Day-boundary gaps are credited to the current day (acceptable drift).
 */
export async function recordDeviceUptime(deviceId: string, previousLastSeenAt: Date | null, now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const deltaSeconds = previousLastSeenAt
    ? Math.min(Math.max((now.getTime() - previousLastSeenAt.getTime()) / 1000, 0), MAX_HEARTBEAT_GAP_SECONDS)
    : 0;
  try {
    await db
      .insert(deviceUptimeDaysTable)
      .values({
        deviceId,
        day,
        onlineSeconds: Math.round(deltaSeconds),
        heartbeats: 1,
        firstSeenAt: previousLastSeenAt ?? now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [deviceUptimeDaysTable.deviceId, deviceUptimeDaysTable.day],
        set: {
          onlineSeconds: sql`LEAST(${deviceUptimeDaysTable.onlineSeconds} + ${Math.round(deltaSeconds)}, 86400)`,
          heartbeats: sql`${deviceUptimeDaysTable.heartbeats} + 1`,
          lastSeenAt: now,
        },
      });
  } catch {
    // Uptime bookkeeping must never fail a heartbeat.
  }
}
