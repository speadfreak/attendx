/**
 * AttendX Kiosk service worker — hand-rolled, zero dependencies.
 *
 * Strategy:
 *  - install: precache the navigation fallback (the app shell at the SW root)
 *  - activate: delete caches from older versions, take control immediately
 *  - fetch:
 *      · non-GET ............ ignored (never touch POST /qr/scan etc.)
 *      · /api/* ............. ignored (auth + scans must always hit network)
 *      · cross-origin ....... ignored (Google Fonts CDN keeps its own behavior)
 *      · navigations ........ network-first, fallback to the cached shell "/"
 *      · /assets/* (hashed) . cache-first with runtime caching
 *      · other same-origin GETs (manifest, icons, favicon) — cache-first runtime
 *
 * Paths are resolved against `self.registration.scope`, so this also works if
 * the app is deployed under a non-root Vite `BASE_PATH`.
 */

/* eslint-disable no-restricted-globals */
const VERSION = "attendx-kiosk-v1";
const PRECACHE = `${VERSION}-precache`;
const RUNTIME = `${VERSION}-runtime`;

const scopeUrl = () => new URL(self.registration.scope);
/** App-shell document used as the offline navigation fallback. */
const shellUrl = () => new URL("./", scopeUrl()).toString();
/** Vite emits hashed bundles into `assets/` next to the SW root. */
const assetsPrefix = () => new URL("assets/", scopeUrl()).pathname;
const isApiPath = (pathname) => {
  const scopePath = scopeUrl().pathname;
  const rel = pathname.startsWith(scopePath) ? pathname.slice(scopePath.length) : pathname.replace(/^\//, "");
  return rel === "api" || rel.startsWith("api/");
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(PRECACHE);
        // Precache the shell ("/"). A failure here (e.g. first run while
        // offline) must not block install — the SW just starts empty.
        await cache.add(new Request(shellUrl(), { cache: "reload" })).catch(() => {});
      } catch (_) {
        /* best-effort precache */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== PRECACHE && n !== RUNTIME)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const fresh = await fetch(req);
    // Only cache basic same-origin 200s; redirects/opaque responses are skipped.
    if (fresh && fresh.ok && fresh.type === "basic" && !fresh.redirected) {
      await cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (_) {
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

async function networkFirstNavigation(req) {
  const cache = await caches.open(PRECACHE);
  try {
    const fresh = await fetch(req);
    // Keep the shell warm under whichever URL the app was last loaded from.
    if (fresh && fresh.ok && fresh.type === "basic" && !fresh.redirected) {
      await cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (_) {
    const cachedShell = (await cache.match(shellUrl())) || (await cache.match(req));
    if (cachedShell) return cachedShell;
    return new Response(
      "<!doctype html><meta charset=\"utf-8\"><title>AttendX Kiosk — offline</title><body style=\"background:#0b0906;color:#e2e8f0;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0\"><p>AttendX Kiosk is offline and has no cached shell yet. Reconnect once to finish setup.</p></body>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept scan POSTs

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  if (url.origin !== self.location.origin) return; // CDN / cross-origin → network
  if (isApiPath(url.pathname)) return; // /api is always network

  if (req.mode === "navigate") {
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  if (url.pathname.startsWith(assetsPrefix())) {
    // Hashed Vite bundles are immutable → cache-first, runtime-cached.
    event.respondWith(cacheFirst(req, RUNTIME));
    return;
  }

  // Other same-origin GETs (manifest.webmanifest, icons, favicon, images).
  if (["font", "image", "style", "script"].includes(req.destination) || url.pathname.endsWith(".webmanifest") || url.pathname.endsWith(".svg") || url.pathname.endsWith(".png") || url.pathname.endsWith(".jpg")) {
    event.respondWith(cacheFirst(req, RUNTIME));
  }
});
