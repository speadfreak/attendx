/**
 * Real-time multi-face tracker — the missing piece between the detector
 * (which samples at 5–15 Hz) and the HUD (which paints at 60 Hz).
 *
 * Without it, the drawn box only jumps once per detection: move your head and
 * the brackets trail a full second behind. With it, every render frame gets a
 * predicted box that GLIDES with the face:
 *
 *  - IoU-based data association keeps a stable identity per face (labels no
 *    longer swap between people when two faces cross).
 *  - Per-track velocity estimation (px/ms, EMA-smoothed) feeds linear
 *    extrapolation with exponential damping, so motion between detections is
 *    predicted instead of frozen — but never flies away on a missed sample.
 *  - A critically-damped display smoother (per-rAF lerp toward the predicted
 *    box) removes detector jitter while keeping ~60ms of responsiveness.
 *
 * All coordinates are in SOURCE video pixels; the HUD renderer maps them
 * through the object-cover transform as before.
 */

export interface TrackerBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrackerDetection {
  box: TrackerBox;
  score?: number;
}

export interface TrackedFace extends TrackerBox {
  /** Stable id for the lifetime of this physical face in frame. */
  id: number;
  score: number;
  /** ms since this track last saw a raw detection. */
  age: number;
}

/** Association threshold: detection↔track pair when IoU exceeds this. */
const IOU_MATCH_THRESHOLD = 0.2;
/** Drop a track after this long without any detection confirming it. */
const TRACK_TTL_MS = 700;
/** Never extrapolate further than this (motion model uncertainty grows fast). */
const MAX_LOOKAHEAD_MS = 240;
/** Velocity memory decay τ — older velocity estimates matter less. */
const VELOCITY_TAU_MS = 380;
/** Display smoother time constant (per-render-frame lerp). */
const DISPLAY_TAU_MS = 60;
/** Velocity blend on each new sample (higher = snappier direction changes). */
const VELOCITY_ALPHA = 0.55;
/** Position EMA on new detections (higher = snappier, more jitter). */
const SAMPLE_ALPHA = 0.6;

interface Track {
  id: number;
  /** Last raw detection (center of the motion model). */
  raw: TrackerBox;
  score: number;
  /** Estimated velocity in px/ms. */
  vx: number;
  vy: number;
  lastRawAt: number;
  /** Smoothed display box — what the renderer actually draws. */
  display: TrackerBox;
  lastDisplayAt: number;
}

function iou(a: TrackerBox, b: TrackerBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

export class FaceTracker {
  private tracks: Track[] = [];
  private nextId = 1;

  /** Feed raw detections (any Hz — irregular cadence is fine). */
  update(detections: TrackerDetection[], now: number): void {
    const unmatchedDets = new Set(detections.map((_, i) => i));

    // Greedy association, largest faces first (they matter most).
    const pairs: Array<{ ti: number; di: number; score: number }> = [];
    this.tracks.forEach((t, ti) => {
      detections.forEach((d, di) => {
        const s = iou(t.raw, d.box);
        if (s > IOU_MATCH_THRESHOLD) pairs.push({ ti, di, score: s });
      });
    });
    pairs.sort((a, b) => b.score - a.score);
    const takenTracks = new Set<number>();
    for (const p of pairs) {
      if (takenTracks.has(p.ti) || !unmatchedDets.has(p.di)) continue;
      takenTracks.add(p.ti);
      unmatchedDets.delete(p.di);
      const t = this.tracks[p.ti];
      const det = detections[p.di];
      const dt = Math.min(1000, Math.max(20, now - t.lastRawAt));
      const cOld = { x: t.raw.x + t.raw.width / 2, y: t.raw.y + t.raw.height / 2 };
      const cNew = { x: det.box.x + det.box.width / 2, y: det.box.y + det.box.height / 2 };
      const instVx = (cNew.x - cOld.x) / dt;
      const instVy = (cNew.y - cOld.y) / dt;
      t.vx = lerp(t.vx, instVx, VELOCITY_ALPHA);
      t.vy = lerp(t.vy, instVy, VELOCITY_ALPHA);
      // Size changes smoothly (people approaching/receding), position snaps
      // partially through the display smoother below.
      t.raw = det.box;
      t.score = det.score ?? t.score;
      t.lastRawAt = now;
    }

    // New tracks for unmatched detections.
    for (const di of unmatchedDets) {
      const det = detections[di];
      this.tracks.push({
        id: this.nextId++,
        raw: det.box,
        score: det.score ?? 0,
        vx: 0,
        vy: 0,
        lastRawAt: now,
        display: { ...det.box },
        lastDisplayAt: now,
      });
    }

    // Expire stale tracks.
    this.tracks = this.tracks.filter((t) => now - t.lastRawAt <= TRACK_TTL_MS);
  }

  /**
   * Current best box per track, motion-predicted to `now` and smoothed.
   * Call once per animation frame — it advances the display smoother.
   */
  predict(now: number): TrackedFace[] {
    const out: TrackedFace[] = [];
    for (const t of this.tracks) {
      const age = Math.max(0, now - t.lastRawAt);

      // Motion model: linear extrapolation, exponentially damped with age.
      const lookahead = Math.min(age, MAX_LOOKAHEAD_MS) * Math.exp(-age / VELOCITY_TAU_MS);
      const px = t.raw.x + t.vx * lookahead;
      const py = t.raw.y + t.vy * lookahead;

      // Critically-damped display smoother — glides toward the predicted box.
      const dtMs = Math.max(1, now - t.lastDisplayAt);
      const alpha = 1 - Math.exp(-dtMs / DISPLAY_TAU_MS);
      t.display = {
        x: lerp(t.display.x, px, alpha),
        y: lerp(t.display.y, py, alpha),
        width: lerp(t.display.width, t.raw.width, alpha),
        height: lerp(t.display.height, t.raw.height, alpha),
      };
      t.lastDisplayAt = now;

      out.push({ id: t.id, ...t.display, score: t.score, age });
    }
    // Largest (closest) face first — deterministic primary ordering.
    out.sort((a, b) => b.width * b.height - a.width * a.height);
    return out;
  }

  /** Largest visible face (canonical match target) or null when empty. */
  primary(): TrackedFace | null {
    if (this.tracks.length === 0) return null;
    const sorted = [...this.tracks].sort((a, b) => b.raw.width * b.raw.height - a.raw.width * a.raw.height);
    const t = sorted[0];
    return { id: t.id, ...t.raw, score: t.score, age: Date.now() - t.lastRawAt };
  }

  get count(): number {
    return this.tracks.length;
  }

  reset(): void {
    this.tracks = [];
  }
}

/**
 * Attach a verdict label to the right moving face: the track that best
 * overlaps the box the verdict was made on — never blind "primary", or the
 * label would jump to whoever walked closest after the match.
 */
export function pickTrackForLabel(tracked: TrackedFace[], anchor: TrackerBox | null | undefined): TrackedFace | null {
  if (!anchor) return null;
  let best: TrackedFace | null = null;
  let bestIou = 0.12;
  for (const t of tracked) {
    const s = iou(t, anchor);
    if (s > bestIou) {
      bestIou = s;
      best = t;
    }
  }
  return best;
}
