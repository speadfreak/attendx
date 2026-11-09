import { db, gatesTable } from "@workspace/db";
import { arrayContains, eq } from "drizzle-orm";

/**
 * Gate registry + geofence evaluation (Phase 6 geofenced QR).
 *
 * A scan can only be trusted if it happened where the school says the gate
 * is. Kiosks sign each scan with a GPS fix; this module compares it with the
 * registered gate center using the haversine distance and tolerates GPS
 * accuracy jitter (accuracy + configurable buffer).
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface GateGeofence {
  gateId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number;
}

export type Gate = typeof gatesTable.$inferSelect;

/** Great-circle distance in meters between two WGS-84 points. */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000; // earth radius, meters
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isPlausibleGeo(p: GeoPoint | null | undefined): p is GeoPoint {
  return !!p
    && Number.isFinite(p.latitude) && p.latitude >= -90 && p.latitude <= 90
    && Number.isFinite(p.longitude) && p.longitude >= -180 && p.longitude <= 180
    && !(p.latitude === 0 && p.longitude === 0);
}

export async function getGate(gateId: string): Promise<Gate | null> {
  if (!gateId) return null;
  const [gate] = await db.select().from(gatesTable).where(eq(gatesTable.gateId, gateId)).limit(1);
  return gate ?? null;
}

export async function listGates(): Promise<Gate[]> {
  return db.select().from(gatesTable);
}

/** Resolve the gate a terminal belongs to (gates store their terminal ids). */
export async function gateForTerminal(terminalId: string): Promise<Gate | null> {
  if (!terminalId || terminalId === "web") return null;
  const gates = await db.select().from(gatesTable).where(arrayContains(gatesTable.terminalIds, [terminalId])).limit(1);
  return gates[0] ?? null;
}

export interface GeofenceVerdict {
  /** null = no geofence configured or no scan geo → enforcement skipped */
  enforced: boolean;
  allowed: boolean;
  distanceM: number | null;
  radiusM: number | null;
  /** effective radius including GPS accuracy + fixed jitter buffer */
  effectiveRadiusM: number | null;
  reason: "not-configured" | "no-scan-geo" | "outside-radius" | "inside-radius" | null;
}

const FIXED_JITTER_M = 30; // consumer GPS can drift even with good accuracy

export function evaluateGeofence(
  gate: Gate | null,
  scanGeo: (GeoPoint & { accuracy?: number | null }) | null,
): GeofenceVerdict {
  if (!gate || gate.latitude == null || gate.longitude == null) {
    return { enforced: false, allowed: true, distanceM: null, radiusM: null, effectiveRadiusM: null, reason: "not-configured" };
  }
  if (!scanGeo || !isPlausibleGeo(scanGeo)) {
    return { enforced: false, allowed: true, distanceM: null, radiusM: gate.geofenceRadiusM, effectiveRadiusM: null, reason: "no-scan-geo" };
  }
  const distanceM = haversineM(
    { latitude: gate.latitude, longitude: gate.longitude },
    { latitude: scanGeo.latitude, longitude: scanGeo.longitude },
  );
  const effectiveRadiusM = gate.geofenceRadiusM + FIXED_JITTER_M + (scanGeo.accuracy ?? 0);
  const allowed = distanceM <= effectiveRadiusM;
  return {
    enforced: true,
    allowed,
    distanceM: Math.round(distanceM),
    radiusM: gate.geofenceRadiusM,
    effectiveRadiusM: Math.round(effectiveRadiusM),
    reason: allowed ? "inside-radius" : "outside-radius",
  };
}

/** Upsert gate config from the Operations console. */
export async function upsertGate(input: {
  gateId: string;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusM?: number;
  terminalIds?: string[];
}): Promise<Gate> {
  const [gate] = await db
    .insert(gatesTable)
    .values({
      gateId: input.gateId,
      name: input.name,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      geofenceRadiusM: input.geofenceRadiusM ?? 150,
      terminalIds: input.terminalIds ?? [],
    })
    .onConflictDoUpdate({
      target: gatesTable.gateId,
      set: {
        name: input.name,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        geofenceRadiusM: input.geofenceRadiusM ?? 150,
        terminalIds: input.terminalIds ?? [],
      },
    })
    .returning();
  return gate;
}
