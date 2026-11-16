/**
 * Phase 7 — QR decode engines for the phone camera node.
 *
 * 1. BarcodeDetectorEngine — the native BarcodeDetector API (Chromium /
 *    Android), driven over OUR OWN getUserMedia video element so the whole
 *    kiosk HUD, torch, flip and quality control stay unified.
 *
 * 2. Html5QrcodeEngine — fallback for browsers without BarcodeDetector
 *    (iOS Safari): html5-qrcode owns the camera inside a region element
 *    and runs its own decode loop (same pattern as QrTerminalPage).
 *    The engine exposes the underlying video element + track so health
 *    sampling, thumbnails and torch keep working.
 */

import { Html5Qrcode } from "html5-qrcode";

export type QrEngineKind = "barcodedetector" | "html5qrcode";

export function qrEngineKind(): QrEngineKind {
  if (typeof window !== "undefined" && "BarcodeDetector" in window) return "barcodedetector";
  return "html5qrcode";
}

export function qrEngineLabel(kind: QrEngineKind): string {
  return kind === "barcodedetector" ? "BarcodeDetector" : "html5-qrcode";
}

// ── engine 1: native BarcodeDetector over our own <video> ────────────

interface DetectedBarcodeLike {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource | Blob | ImageData): Promise<DetectedBarcodeLike[]>;
}

interface BarcodeDetectorCtorLike {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

function getBarcodeDetectorCtor(): BarcodeDetectorCtorLike | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtorLike }).BarcodeDetector;
  return ctor ?? null;
}

export class BarcodeDetectorEngine {
  private detector: BarcodeDetectorLike | null = null;
  readonly kind: QrEngineKind = "barcodedetector";

  private ensureDetector(): BarcodeDetectorLike | null {
    if (this.detector) return this.detector;
    const ctor = getBarcodeDetectorCtor();
    if (!ctor) return null;
    try {
      this.detector = new ctor({ formats: ["qr_code"] });
      return this.detector;
    } catch {
      return null;
    }
  }

  /** Decode one video frame; resolves null when no QR is visible. */
  async decode(video: HTMLVideoElement): Promise<string | null> {
    const detector = this.ensureDetector();
    if (!detector || !video.videoWidth) return null;
    try {
      const codes = await detector.detect(video);
      const first = codes.find((c) => c.rawValue && c.rawValue.length > 0);
      return first?.rawValue ?? null;
    } catch {
      // malformed frame / detector hiccup — just miss this tick
      return null;
    }
  }
}

// ── engine 2: html5-qrcode owning the camera (no BarcodeDetector) ────

export interface Html5QrcodeEngineOptions {
  /** region element id — must exist in the DOM before start() */
  regionId: string;
  /** called for every decoded QR payload */
  onDecode: (token: string) => void;
  /** called on every scan frame (decode OR miss) — fps accounting */
  onTick?: () => void;
  /** called when the underlying camera track ends (unplug / revoke) */
  onTrackEnded?: () => void;
}

export class Html5QrcodeEngine {
  private scanner: Html5Qrcode | null = null;
  private readonly regionId: string;
  private readonly onDecode: (token: string) => void;
  private readonly onTick?: () => void;
  private readonly onTrackEnded?: () => void;
  private boundTrack: MediaStreamTrack | null = null;
  private trackEndedHandler: (() => void) | null = null;
  readonly kind: QrEngineKind = "html5qrcode";

  constructor(opts: Html5QrcodeEngineOptions) {
    this.regionId = opts.regionId;
    this.onDecode = opts.onDecode;
    this.onTick = opts.onTick;
    this.onTrackEnded = opts.onTrackEnded;
  }

  /**
   * Start (or restart) the scanner. constraints is a full
   * MediaTrackConstraints (deviceId/facingMode + size) passed through
   * videoConstraints so the profile's resolution applies here too.
   */
  async start(constraints: MediaTrackConstraints): Promise<void> {
    await this.stop();
    const scanner = new Html5Qrcode(this.regionId, { verbose: false, useBarCodeDetectorIfSupported: true });
    this.scanner = scanner;
    await scanner.start(
      constraints,
      // videoConstraints carries the full profile sizing; the first arg is
      // then only a fallback the library ignores (it must still be a valid
      // camera selector shape, so it mirrors the constraints).
      { fps: 8, qrbox: undefined, disableFlip: false, videoConstraints: constraints },
      (decodedText) => {
        this.onTick?.();
        this.onDecode(decodedText);
      },
      () => {
        // per-frame no-decode — still counts as a scan frame for fps
        this.onTick?.();
      },
    );
    this.bindTrackLifecycle();
  }

  async stop(): Promise<void> {
    this.unbindTrackLifecycle();
    const scanner = this.scanner;
    this.scanner = null;
    if (scanner) {
      try {
        await scanner.stop();
        scanner.clear();
      } catch {
        /* already stopped */
      }
    }
  }

  /** The live <video> html5-qrcode rendered inside the region. */
  getVideo(): HTMLVideoElement | null {
    return document.querySelector<HTMLVideoElement>(`#${this.regionId} video`);
  }

  getTrack(): MediaStreamTrack | null {
    const video = this.getVideo();
    const stream = video?.srcObject;
    return stream instanceof MediaStream ? stream.getVideoTracks()[0] ?? null : null;
  }

  getCapabilities(): MediaTrackCapabilities | null {
    if (!this.scanner) return null;
    try {
      return this.scanner.getRunningTrackCapabilities();
    } catch {
      return null;
    }
  }

  private bindTrackLifecycle(): void {
    const track = this.getTrack();
    if (!track || !this.onTrackEnded) return;
    this.boundTrack = track;
    this.trackEndedHandler = () => this.onTrackEnded?.();
    track.addEventListener("ended", this.trackEndedHandler);
  }

  private unbindTrackLifecycle(): void {
    if (this.boundTrack && this.trackEndedHandler) {
      this.boundTrack.removeEventListener("ended", this.trackEndedHandler);
    }
    this.boundTrack = null;
    this.trackEndedHandler = null;
  }
}
