/**
 * Phase 7 — capture quality profiles + adaptive selection for the phone
 * camera node. The heartbeat response `targetQuality` (operator override)
 * always wins over the local adaptive choice; the kiosk operator can also
 * pick a profile manually in the action bar.
 */

import type { TargetQuality } from "./device-api";

export type QualityProfile = TargetQuality;

export interface QualitySpec {
  /** getUserMedia ideal width/height for the profile. */
  width: number;
  height: number;
  /** Target detection/decode cadence (analyses per second). */
  detectFps: number;
  /** Seconds between opportunistic thumbnail uploads. */
  thumbnailSec: number;
  label: string;
}

/**
 * Tracking is now a two-stage pipeline: the FAST stage runs the bare tiny
 * detector (no landmarks/descriptors — 5-10x cheaper), and the identity-grade
 * full pipeline samples at ~0.8 Hz for the server match batch. That lets
 * every profile run a much higher tracking Hz at the same CPU budget.
 *
 * low      → 320x240 @ ~4 fps tracking, thumbnail every 60s (cellular / data saver)
 * balanced → 640x480 @ ~8 fps tracking, thumbnail every 20s (default on Wi-Fi)
 * hd       → 1280x720 @ ~15 fps tracking, thumbnail every 20s
 */
export const QUALITY_SPECS: Record<QualityProfile, QualitySpec> = {
  low: { width: 320, height: 240, detectFps: 4, thumbnailSec: 60, label: "Low 320p" },
  balanced: { width: 640, height: 480, detectFps: 8, thumbnailSec: 20, label: "Balanced 480p" },
  hd: { width: 1280, height: 720, detectFps: 15, thumbnailSec: 20, label: "HD 720p" },
};

export const QUALITY_ORDER: QualityProfile[] = ["low", "balanced", "hd"];

// ── network info (NetworkInformation API, still untyped in lib.dom) ──

interface NetworkInformationLike {
  effectiveType?: string;
  saveData?: boolean;
  type?: string;
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
}

function networkInfo(): NetworkInformationLike | null {
  if (typeof navigator === "undefined") return null;
  const conn = (navigator as unknown as { connection?: NetworkInformationLike }).connection;
  return conn ?? null;
}

/** "4g" / "3g" / "cellular-2g" … — reported in every heartbeat. */
export function connectionLabel(): string | null {
  const conn = networkInfo();
  if (!conn || !conn.effectiveType) return null;
  return conn.effectiveType;
}

export function isSaveData(): boolean {
  return networkInfo()?.saveData === true;
}

function isCellular(): boolean {
  const t = networkInfo()?.effectiveType ?? "";
  return t.startsWith("cellular") || t === "2g" || t === "slow-2g" || t === "3g";
}

/**
 * Adaptive starting profile: cellular or SaveData → low + dataSaver on.
 * Wi-Fi / ethernet → balanced with dataSaver off. The operator's
 * `targetQuality` override from the heartbeat response always wins later.
 */
export function pickInitialQuality(): { quality: QualityProfile; dataSaver: boolean } {
  if (isSaveData() || isCellular()) return { quality: "low", dataSaver: true };
  return { quality: "balanced", dataSaver: false };
}

export function qualitySpec(profile: QualityProfile): QualitySpec {
  return QUALITY_SPECS[profile];
}

/** MediaTrackConstraints for the given profile (+ camera selection). */
export function videoConstraintsFor(
  profile: QualityProfile,
  opts: { deviceId?: string | null; facing?: "user" | "environment" },
): MediaTrackConstraints {
  const spec = QUALITY_SPECS[profile];
  const size: MediaTrackConstraints = { width: { ideal: spec.width }, height: { ideal: spec.height } };
  if (opts.deviceId) {
    return { ...size, deviceId: { exact: opts.deviceId } };
  }
  return { ...size, facingMode: { ideal: opts.facing ?? "environment" } };
}
