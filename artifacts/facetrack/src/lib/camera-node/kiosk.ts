/**
 * Phase 7 — kiosk behavior helpers for the phone camera node:
 * wake lock, fullscreen, PWA install prompt and the shared service worker.
 */

// ── wake lock ────────────────────────────────────────────────────────

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: string, fn: () => void) => void;
}

type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
};

/**
 * Request a screen wake lock. Best-effort: resolves null when unsupported,
 * denied, or the page is hidden (browsers refuse while hidden).
 */
export async function requestWakeLock(): Promise<WakeLockSentinelLike | null> {
  const nav = navigator as WakeLockNavigator;
  if (!nav.wakeLock || document.visibilityState !== "visible") return null;
  try {
    return await nav.wakeLock.request("screen");
  } catch {
    return null;
  }
}

/**
 * Hold a wake lock across tab switches: re-acquires on visibilitychange
 * (the sentinel is auto-released when the page hides).
 */
export function keepAwake(): () => void {
  let sentinel: WakeLockSentinelLike | null = null;
  let disposed = false;

  const acquire = () => {
    void requestWakeLock().then((s) => {
      if (disposed) {
        void s?.release().catch(() => {});
        return;
      }
      sentinel = s;
    });
  };

  acquire();
  const onVisible = () => {
    if (document.visibilityState === "visible" && (!sentinel || sentinel.released)) acquire();
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    disposed = true;
    document.removeEventListener("visibilitychange", onVisible);
    if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
    sentinel = null;
  };
}

// ── fullscreen ───────────────────────────────────────────────────────

export async function toggleFullscreen(): Promise<boolean> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    }
    await document.documentElement.requestFullscreen();
    return true;
  } catch {
    return Boolean(document.fullscreenElement);
  }
}

// ── PWA install prompt ───────────────────────────────────────────────

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// ── service worker ───────────────────────────────────────────────────

/**
 * Ensure the SAME kiosk service worker main.tsx registers (public/sw.js)
 * is active for this page. Production-only — dev stays SW-free, mirroring
 * main.tsx. Idempotent: an existing registration short-circuits.
 */
export async function ensureServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD) return;
  try {
    if (!("serviceWorker" in navigator)) return;
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) return;
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* best-effort — kiosk works without it */
    });
  } catch {
    /* service workers unavailable */
  }
}
