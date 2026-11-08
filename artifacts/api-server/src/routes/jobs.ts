import { Router, type Request } from "express";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { db, jobsTable, piDevicesTable } from "@workspace/db";
import { z } from "zod/v4";
import { requireAuth } from "../lib/auth";
import { requirePiToken, type PiAuthenticatedRequest } from "../lib/pi-auth";
import { writeAudit } from "../lib/audit";
import { processVercelJob } from "../lib/jobs";

const router = Router();
const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId;
const completionSchema = z.object({
  status: z.enum(["done", "failed"]),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().max(2000).nullable().optional(),
});

router.get("/jobs", requireAuth, async (_req, res): Promise<void> => {
  const [recentJobs, grouped] = await Promise.all([
    db.select().from(jobsTable).orderBy(desc(jobsTable.createdAt), desc(jobsTable.id)).limit(50),
    db.select({ status: jobsTable.status, total: count() }).from(jobsTable).groupBy(jobsTable.status),
  ]);
  const counts = { pending: 0, running: 0, failed: 0, done: 0 };
  for (const row of grouped) {
    if (row.status in counts) counts[row.status as keyof typeof counts] = Number(row.total);
  }
  res.json({ counts, jobs: recentJobs });
});

router.get("/jobs/next", requirePiToken, async (_req, res): Promise<void> => {
  const job = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(jobsTable)
      .where(and(eq(jobsTable.worker, "pi"), eq(jobsTable.status, "pending")))
      .orderBy(asc(jobsTable.createdAt), asc(jobsTable.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await tx
      .update(jobsTable)
      .set({
        status: "running",
        attempts: candidate.attempts + 1,
        startedAt: new Date(),
        error: null,
      })
      .where(eq(jobsTable.id, candidate.id))
      .returning();
    return claimed ?? null;
  });
  res.json({ job });
});

router.post("/jobs/:id/complete", requirePiToken, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }
  const parsed = completionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const piReq = req as PiAuthenticatedRequest;
  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, id)).limit(1);
  if (!existing || existing.worker !== "pi") {
    res.status(404).json({ error: "Pi job not found" });
    return;
  }
  if (existing.status !== "running") {
    if (existing.status === parsed.data.status) {
      res.json(existing);
      return;
    }
    res.status(409).json({ error: "Job is not currently running" });
    return;
  }

  const [job] = await db.update(jobsTable).set({
    status: parsed.data.status,
    result: parsed.data.result ?? null,
    error: parsed.data.status === "failed" ? (parsed.data.error ?? "Pi worker reported failure") : null,
    completedAt: new Date(),
  }).where(eq(jobsTable.id, id)).returning();

  const result = parsed.data.result ?? {};
  if (existing.type === "fan_telemetry") {
    const temp = typeof result.tempC === "number" && Number.isFinite(result.tempC) ? result.tempC : null;
    const fanState = ["on", "off", "auto", "unknown"].includes(String(result.fanState)) ? String(result.fanState) : "unknown";
    if (piReq.piDeviceId) {
      await db.update(piDevicesTable).set({ fanTempC: temp, fanState }).where(eq(piDevicesTable.id, piReq.piDeviceId));
    }
  }
  if (existing.type === "pi_action") {
    await writeAudit({
      action: "pi.action.completed",
      targetType: "job",
      targetId: id,
      payload: {
        action: typeof existing.payload.action === "string" ? existing.payload.action : "unknown",
        success: parsed.data.status === "done",
      },
    });
  }
  res.json(job);
});

router.post("/jobs/:id/retry", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }
  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (existing.status !== "failed") {
    res.status(409).json({ error: "Only failed jobs can be retried" });
    return;
  }
  const [job] = await db.update(jobsTable).set({
    status: "pending",
    startedAt: null,
    completedAt: null,
    error: null,
  }).where(eq(jobsTable.id, id)).returning();

  if (job.worker === "api" && process.env.VERCEL) {
    await processVercelJob(job.id);
  }

  await writeAudit({
    actorAdminId: adminId(req),
    action: "job.retried",
    targetType: "job",
    targetId: id,
    payload: { type: existing.type, worker: existing.worker },
  });
  res.json(job);
});

export default router;
