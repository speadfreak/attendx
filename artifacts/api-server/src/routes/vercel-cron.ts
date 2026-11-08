import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { processOneServerJob } from "../lib/jobs";
import { purgeExpiredRejectedReviews } from "../lib/retention";
import { runGateValidation } from "../lib/gate-integrity";

const router = Router();

function hasValidCronAuthorization(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const authorization = req.header("authorization") ?? "";
  if (!expected || !authorization.startsWith("Bearer ")) return false;

  const provided = Buffer.from(authorization.slice("Bearer ".length));
  const expectedBuffer = Buffer.from(expected);
  return (
    provided.length === expectedBuffer.length &&
    timingSafeEqual(provided, expectedBuffer)
  );
}

router.get("/internal/cron", async (req: Request, res: Response): Promise<void> => {
  if (!process.env.CRON_SECRET) {
    res.status(503).json({ error: "Scheduled processing is not configured" });
    return;
  }
  if (!hasValidCronAuthorization(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let processedJobs = 0;
  while (processedJobs < 10 && await processOneServerJob()) {
    processedJobs += 1;
  }

  const purgedReviews = await purgeExpiredRejectedReviews();

  // Phase 4: recovery pass for gate-integrity windows that may have been
  // missed if no sensor batches arrived during active gate hours.
  const gateValidation = await runGateValidation();

  res.json({ ok: true, processedJobs, purgedReviews, gateValidation });
});

export default router;
