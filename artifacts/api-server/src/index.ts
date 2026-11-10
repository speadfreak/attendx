import app from "./app";
import { logger } from "./lib/logger";
import { ensureSchema } from "./lib/schema-bootstrap";
import { startServerJobWorker } from "./lib/jobs";
import { startReviewRetentionWorker } from "./lib/retention";
import { reconcilePendingSms } from "./lib/sms-reconcile";

// Default export — the entry consumed by the Vercel Express runtime
// (see vercel.json → services.api-server.entrypoint). In serverless handler
// mode requests are served through the exported app; nothing listens.
export default app;

/**
 * Dual-mode entrypoint.
 *  - `PORT` set          → standalone HTTP server (Replit, local dev, `vercel dev`).
 *                          In-process job + retention workers run alongside it.
 *  - `PORT` unset, Vercel → handler mode: no listener, no interval workers.
 *                          Server-queued jobs are processed inline by the request
 *                          that created them and by the daily `/api/internal/cron`
 *                          schedule; Pi jobs stay poll-driven via `/api/jobs/next`.
 *                          (See VERCEL_DEPLOYMENT.md → "Serverless behavior".)
 */
const rawPort = process.env["PORT"];

if (rawPort) {
  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  // Boot-time schema bootstrap (Phase 6 self-healing). The request-path
  // middleware in app.ts covers serverless invocations; this warms it for
  // the long-lived server. Failures are logged loudly inside ensureSchema
  // and swallowed here so the app still boots in degraded mode.
  ensureSchema().catch((err) => {
    logger.error({ err }, "Boot-time schema bootstrap failed — continuing in degraded mode");
  });

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    startServerJobWorker();
    startReviewRetentionWorker();

    // Phase 6: periodic SMS delivery reconciliation. The Twilio status
    // webhook is the primary freshness source; this 60s sweep is the
    // safety net for missed callbacks. Long-lived mode only — never on
    // Vercel serverless (the /api/internal/cron schedule covers that).
    if (!process.env.VERCEL) {
      setInterval(() => {
        reconcilePendingSms().catch(() => {});
      }, 60_000).unref();
    }
  });
} else if (!process.env["VERCEL"]) {
  // Human-friendly failure for local runs that forgot PORT. On Vercel the
  // VERCEL env var is always present, so handler mode never throws here.
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}
