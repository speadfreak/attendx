/**
 * Phase 7 — on-device camera health self-checks.
 *
 * Every detection tick downsamples the live frame into a 16x12 canvas:
 *   - average brightness < 14/255 for 3 consecutive ticks  → "obstructed"
 *     (camera covered / lens capped / lights out)
 *   - identical downsample hash held for ≥ 15s             → "frozen"
 *     (driver wedged, encoder stalled — the picture literally stopped)
 *   - otherwise "ok". Feed into every heartbeat as healthStatus.
 */

import type { NodeHealthStatus } from "./device-api";

const SAMPLE_W = 16;
const SAMPLE_H = 12;
/** average brightness (0-255) below which a frame counts as "near black" */
const DARK_THRESHOLD = 14;
/** consecutive dark ticks before we call it obstructed */
const DARK_TICKS_TO_ALARM = 3;
/** identical-hash duration before we call the stream frozen */
const FROZEN_AFTER_MS = 15_000;

export class HealthMonitor {
  private canvas: HTMLCanvasElement | null = null;
  private darkTicks = 0;
  private lastHash: string | null = null;
  private firstIdenticalAt: number | null = null;
  private lastReported: NodeHealthStatus = "unknown";

  /** Sample one video frame. Returns the current health verdict. */
  sample(video: HTMLVideoElement, now: number = Date.now()): NodeHealthStatus {
    if (!video.videoWidth || !video.videoHeight) {
      this.lastReported = "unknown";
      return this.lastReported;
    }
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.width = SAMPLE_W;
      this.canvas.height = SAMPLE_H;
    }
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      this.lastReported = "unknown";
      return this.lastReported;
    }

    let data: Uint8ClampedArray;
    try {
      ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
      data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    } catch {
      // cross-origin / detached frame — don't flip health on sampling failure
      return this.lastReported;
    }

    let sum = 0;
    const parts: string[] = [];
    for (let i = 0; i < data.length; i += 4) {
      // quick luminance
      const l = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      sum += l;
      // 4-level quantization per pixel → freeze hash
      parts.push(String.fromCharCode(48 + (l >> 6))); // 0..3
    }
    const avg = sum / (data.length / 4);
    const hash = parts.join("");

    // ── obstructed: near-black for N consecutive samples ──
    if (avg < DARK_THRESHOLD) {
      this.darkTicks += 1;
    } else {
      this.darkTicks = 0;
    }

    // ── frozen: identical hash held for FROZEN_AFTER_MS ──
    if (this.lastHash !== null && hash === this.lastHash) {
      if (this.firstIdenticalAt === null) this.firstIdenticalAt = now;
    } else {
      this.firstIdenticalAt = null;
      this.lastHash = hash;
    }

    if (this.darkTicks >= DARK_TICKS_TO_ALARM) {
      this.lastReported = "obstructed";
    } else if (this.firstIdenticalAt !== null && now - this.firstIdenticalAt >= FROZEN_AFTER_MS) {
      this.lastReported = "frozen";
    } else {
      this.lastReported = "ok";
    }
    return this.lastReported;
  }

  /** Call when the camera stops / restarts so stale state never alarms. */
  reset(): void {
    this.darkTicks = 0;
    this.lastHash = null;
    this.firstIdenticalAt = null;
    this.lastReported = "unknown";
  }

  get current(): NodeHealthStatus {
    return this.lastReported;
  }
}
