import { reconcilePendingSms } from "./sms-reconcile";
import { logger } from "./logger";

/**
 * Throttled SMS reconcile middleware — the serverless-safe replacement for
 * the setInterval sweep in src/index.ts (which never runs on Vercel, where
 * there is no long-lived process).
 *
 * On every request it checks a module-level timestamp; at most once per
 * 60 seconds it fire-and-forgets a `reconcilePendingSms()` sweep that
 * upgrades sms_logs rows (`queued`/`sent`) to the real carrier verdict.
 * The request path NEVER awaits the reconcile — `next()` is always called
 * immediately, so this is ~free (one Date.now() comparison per request).
 *
 * Because any active page (SMS Logs, dashboards, polls) keeps issuing
 * requests, statuses stay fresh in serverless mode without a cron.
 */
let lastRun = 0;
let inFlight = false;
const THROTTLE_MS = 60_000;

export function smsReconcileMiddleware(): (req: unknown, res: unknown, next: () => void) => void {
  return (_req, _res, next) => {
    const now = Date.now();
    if (now - lastRun > THROTTLE_MS && !inFlight) {
      // Reserve the slot immediately so N concurrent requests don't fan out
      // N sweeps; the flag is cleared when the sweep settles.
      lastRun = now;
      inFlight = true;
      void reconcilePendingSms()
        .catch((err) => logger.warn({ err }, "sms reconcile middleware: sweep failed"))
        .finally(() => {
          inFlight = false;
        });
    }
    next();
  };
}
