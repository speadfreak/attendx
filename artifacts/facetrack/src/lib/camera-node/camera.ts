/**
 * Phase 7 — camera lifecycle primitives for the phone gate node.
 * Own-stream management (face mode + BarcodeDetector QR path), device
 * enumeration, torch control and getUserMedia error classification.
 */

import { videoConstraintsFor, type QualityProfile } from "./quality";

export type CameraFailureKind = "insecure" | "permission" | "nocamera" | "generic";

export class CameraStartError extends Error {
  readonly kind: CameraFailureKind;
  constructor(kind: CameraFailureKind, message: string) {
    super(message);
    this.name = "CameraStartError";
    this.kind = kind;
  }
}

export function isSecureForCamera(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

/** Open the rear camera (or an explicit device) with profile-based sizing. */
export async function startOwnStream(
  profile: QualityProfile,
  opts: { deviceId?: string | null; facing?: "user" | "environment" } = {},
): Promise<MediaStream> {
  if (!isSecureForCamera()) {
    throw new CameraStartError("insecure", "Camera requires HTTPS — getUserMedia is blocked on insecure origins.");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraStartError("nocamera", "This browser does not expose mediaDevices.getUserMedia.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: videoConstraintsFor(profile, opts),
      audio: false,
    });
  } catch (err: unknown) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new CameraStartError("permission", "Camera permission denied. Enable it in the browser site settings, then press Start.");
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
      throw new CameraStartError("nocamera", "No usable camera found for the selected lens/quality. Flip camera or lower the quality.");
    }
    throw new CameraStartError("generic", err instanceof Error ? err.message : "Unknown camera failure.");
  }
}

/** All video inputs (labels populated once permission has been granted). */
export async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  } catch {
    return [];
  }
}

export function activeVideoTrack(stream: MediaStream | null): MediaStreamTrack | null {
  return stream?.getVideoTracks()[0] ?? null;
}

// ── torch ────────────────────────────────────────────────────────────

interface TorchCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
}

export function trackSupportsTorch(track: MediaStreamTrack | null): boolean {
  if (!track || typeof track.getCapabilities !== "function") return false;
  try {
    const caps = track.getCapabilities() as TorchCapabilities;
    return caps.torch === true;
  } catch {
    return false;
  }
}

/** Toggle the LED torch. Returns the applied state or null if unsupported. */
export async function applyTorch(track: MediaStreamTrack | null, on: boolean): Promise<boolean | null> {
  if (!track || !trackSupportsTorch(track)) return null;
  try {
    await track.applyConstraints({
      advanced: [{ torch: on }],
    } as unknown as MediaTrackConstraints);
    return on;
  } catch {
    return null;
  }
}

// ── thumbnails ───────────────────────────────────────────────────────

const THUMB_WIDTH = 320;
const THUMB_QUALITY = 0.35;
/** Server cap is ~90 KB (z.string().max(120_000) incl. data-url prefix). */
const THUMB_MAX_CHARS = 90_000;

/** Draw one video frame into a 320px-wide JPEG data URL (≤ ~90 KB). */
export function captureThumbnail(video: HTMLVideoElement | null): string | null {
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  const scale = THUMB_WIDTH / video.videoWidth;
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  let url = canvas.toDataURL("image/jpeg", THUMB_QUALITY);
  let quality = THUMB_QUALITY;
  while (url.length > THUMB_MAX_CHARS && quality > 0.15) {
    quality -= 0.1;
    url = canvas.toDataURL("image/jpeg", quality);
  }
  return url;
}
