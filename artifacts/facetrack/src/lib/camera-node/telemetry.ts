/**
 * Phase 7 — device telemetry helpers: battery, uptime, GPS fixes.
 * All best-effort: every helper degrades to null instead of throwing so
 * a missing browser API never blocks the kiosk loop.
 */

import { newNonce } from "@/lib/offline-queue";

// ── battery ──────────────────────────────────────────────────────────

interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
}

/** navigator.getBattery() → 0-100 rounded level, or null when unsupported. */
export function readBattery(): Promise<{ level: number | null; charging: boolean | null; manager: BatteryManagerLike | null }> {
  return new Promise((resolve) => {
    const nav = navigator as unknown as {
      getBattery?: () => Promise<BatteryManagerLike>;
    };
    if (typeof nav.getBattery !== "function") {
      resolve({ level: null, charging: null, manager: null });
      return;
    }
    nav
      .getBattery()
      .then((b) => {
        const level = Number.isFinite(b.level) ? Math.round(Math.min(100, Math.max(0, b.level * 100))) : null;
        resolve({ level, charging: typeof b.charging === "boolean" ? b.charging : null, manager: b });
      })
      .catch(() => resolve({ level: null, charging: null, manager: null }));
  });
}

// ── uptime ───────────────────────────────────────────────────────────

const BOOTED_AT = Date.now();

/** Seconds since this page instance took over the camera node. */
export function nodeUptimeSeconds(): number {
  return Math.floor((Date.now() - BOOTED_AT) / 1000);
}

// ── ids ──────────────────────────────────────────────────────────────

/**
 * crypto.randomUUID() with a v4 fallback (non-secure origins lack it).
 * Used for bulk-match batchIds (server validates uuid) and QR nonces.
 */
export const uuid = newNonce;

// ── geolocation ──────────────────────────────────────────────────────

export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  at: number;
}

const GEO_CACHE_MS = 30_000; // reuse a fresh fix for 30s (mirrors maximumAge)
let geoCache: GeoFix | null = null;

/** Best-effort GPS fix (8s hard timeout); resolves null on denial/timeout. */
export function requestGeoFix(): Promise<GeoFix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (fix: GeoFix | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(fix);
    };
    const timer = window.setTimeout(() => finish(null), 8_500);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!Number.isFinite(pos.coords.latitude) || !Number.isFinite(pos.coords.longitude)) {
          finish(null);
          return;
        }
        finish({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          at: Date.now(),
        });
      },
      () => finish(null),
      { timeout: 8_000, maximumAge: 30_000, enableHighAccuracy: true },
    );
  });
}

/** Cached geo for scan submission — fresh fixes are reused for 30s. */
export async function geoForScan(): Promise<GeoFix | null> {
  if (geoCache && Date.now() - geoCache.at < GEO_CACHE_MS) return geoCache;
  const fix = await requestGeoFix();
  if (fix) geoCache = fix;
  return fix;
}
