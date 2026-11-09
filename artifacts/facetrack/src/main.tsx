import { createRoot } from "react-dom/client";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

const apiOrigin = import.meta.env.VITE_API_ORIGIN?.trim();
if (apiOrigin) {
  const parsedApiOrigin = new URL(apiOrigin);
  if (
    !["http:", "https:"].includes(parsedApiOrigin.protocol) ||
    parsedApiOrigin.pathname !== "/" ||
    parsedApiOrigin.search ||
    parsedApiOrigin.hash
  ) {
    throw new Error(
      "VITE_API_ORIGIN must be an HTTP(S) origin without a path, query, or fragment.",
    );
  }
  setBaseUrl(parsedApiOrigin.origin);
} else {
  setBaseUrl(null);
}

setAuthTokenGetter(() => localStorage.getItem("ft_token"));

createRoot(document.getElementById("root")!).render(<App />);

// ── Offline kiosk service worker (Phase 6) ──────────────────────
// Registered only in production builds, after mount, and fully guarded —
// a failed/unsupported SW never breaks the app (dev stays SW-free).
if (import.meta.env.PROD) {
  const registerSw = () => {
    try {
      if ("serviceWorker" in navigator) {
        // BASE_URL ends with "/" so this resolves to /sw.js (or a base-path sw).
        void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
          /* SW registration is best-effort — kiosk works without it */
        });
      }
    } catch {
      /* service workers unavailable */
    }
  };
  if (document.readyState === "complete") {
    registerSw();
  } else {
    window.addEventListener("load", registerSw, { once: true });
  }
}
