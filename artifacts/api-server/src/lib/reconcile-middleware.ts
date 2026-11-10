import { reconcilePendingSms, type ReconcileSummary } from "./sms-reconcile";
import { logger } from "./logger";

/**
 * Serverless-safe SMS reconcile orchestration (the replacement for the
 * setInterval sweep in src/index.ts, which never runs on Vercel where there
 * is no long-lived process).
 *
 * Two entry points share ONE in-flight sweep promise (so a background sweep
 * and an awaited page-load sweep never fan out into duplicate Twilio calls):
 *
 * 1. `smsReconcileMiddleware()` — fire-and-forget sweep throttled to once per
 *    60s, mounted globally in app.ts. The request path NEVER awaits it, so
 *    this is ~free (one Date.now() comparison per request). Any active page
 *    (SMS Logs, dashboards, polls) keeps issuing requests, so statuses stay
 *    fresh without a cron.
 *
 * 2. `reconcileForResponse()` — AWAITED sweep for endpoints where the admin
 *    is actively looking at delivery statuses (SMS Logs page, SMS Health).
 *    Throttled separately (30s), hard-budgeted (4s) so a slow/unreachable
 *    Twilio API can never hang the page, and joined with any in-flight
 *    background sweep instead of starting a duplicate one.
 *
 * On Vercel Fluid compute the Node.js function keeps running briefly after
 * the response is sent, so background sweeps spawned by either path still
 * complete; the daily /api/internal/cron remains the deep recovery path.
 */

const BACKGROUND_THROTTLE_MS = 60_000;
const INLINE_THROTTLE_MS = 30_000;
const INLINE_BUDGET_MS = 4_000;

let lastBackgroundRun = 0;
let lastInlineRun = 0;
let inFlight: Promise<ReconcileSummary> | null = null;

function emptySummary(): ReconcileSummary {
  return { checked: 0, upgraded: 0, byStatus: {}, errors: 0, geoBlocked: 0 };
}

/** Start a sweep (or join the one already running) — never rejects. */
function startSweep(limit: number, minAgeSeconds: number): Promise<ReconcileSummary> {
  if (inFlight) return inFlight;
  inFlight = reconcilePendingSms(limit, minAgeSeconds)
    .catch((err) => {
      logger.warn({ err }, "sms reconcile sweep failed");
      return emptySummary();
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function smsReconcileMiddleware(): (req: unknown, res: unknown, next: () => void) => void {
  return (_req, _res, next) => {
    const now = Date.now();
    if (now - lastBackgroundRun > BACKGROUND_THROTTLE_MS) {
      // Reserve the slot immediately so N concurrent requests don't fan out
      // N sweeps (startSweep additionally joins any in-flight run).
      lastBackgroundRun = now;
      void startSweep(25, 45);
    }
    next();
  };
}

/**
 * Awaited reconcile for endpoints where the USER is actively reading
 * delivery statuses (GET /sms-logs, GET /sms-logs/health). Returns the
 * sweep summary, or null when throttled/budget-expired — in both cases the
 * caller just proceeds with current DB rows; the sweep keeps finishing in
 * the background and the next request picks up the upgraded statuses.
 *
 * `minAgeSeconds` defaults to 8 (vs the background sweep's 45) so rows sent
 * seconds ago are checked right away when the page is opened — this is what
 * makes "Queued" statuses flip to their real carrier verdict as soon as the
 * admin actually looks at them.
 */
export async function reconcileForResponse(
  options: { limit?: number; minAgeSeconds?: number } = {},
): Promise<ReconcileSummary | null> {
  const now = Date.now();
  if (now - lastInlineRun < INLINE_THROTTLE_MS) return null;
  lastInlineRun = now;
  const sweep = startSweep(options.limit ?? 12, options.minAgeSeconds ?? 8);
  // Hard budget: never let the page hang on Twilio. Unref'd so a serverless
  // freeze never keeps the instance alive just for this timer.
  const budget = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), INLINE_BUDGET_MS);
    timer.unref?.();
  });
  return Promise.race([sweep, budget]);
}
