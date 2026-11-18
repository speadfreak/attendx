import { and, asc, eq, sql } from "drizzle-orm";
import { db, jobsTable, studentsTable, classroomsTable } from "@workspace/db";
import { logger } from "./logger";
import { writeAudit } from "./audit";
import { sendSms, SmsDeliveryError } from "./sms";
import { buildStatusMessage } from "./sms-templates";
import { publishEvent } from "./events";
import { getArrivalRules } from "./attendance-rules";

export type AttendanceSmsStatus = "present" | "late" | "absent";

function isAttendanceSmsStatus(value: string): value is AttendanceSmsStatus {
  return value === "present" || value === "late" || value === "absent";
}

export async function enqueueJob(params: {
  type: string;
  payload: Record<string, unknown>;
  worker?: string;
}) {
  const worker = params.worker ?? "pi";
  const [job] = await db
    .insert(jobsTable)
    .values({
      type: params.type,
      payload: params.payload,
      worker,
      status: "pending",
    })
    .returning();

  publishEvent("job.updated", { jobId: job.id, type: job.type, status: job.status, worker: job.worker });

  if (worker === "api" && process.env.VERCEL) {
    await processVercelJob(job.id);
  }

  return job;
}

/**
 * Queue a parent notification for a newly recorded attendance event.
 * Keep the event timestamp with the job so delayed retries still report the
 * actual check-in time, not when a worker happened to process the job.
 */
export async function enqueueAttendanceSms(
  studentId: number,
  status: string,
  markedAt: Date,
) {
  if (!isAttendanceSmsStatus(status)) {
    logger.warn({ studentId, status }, "Skipping parent SMS for unsupported attendance status");
    return null;
  }
  return enqueueJob({
    type: "send_sms",
    worker: "api",
    payload: { studentId, status, markedAt: markedAt.toISOString() },
  });
}

async function claimServerJob(jobId?: number) {
  return db.transaction(async (tx) => {
    const conditions = [
      eq(jobsTable.worker, "api"),
      eq(jobsTable.status, "pending"),
    ];
    if (jobId !== undefined) conditions.push(eq(jobsTable.id, jobId));

    const [candidate] = await tx
      .select()
      .from(jobsTable)
      .where(and(...conditions))
      .orderBy(asc(jobsTable.createdAt), asc(jobsTable.id))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!candidate) return null;

    const [claimed] = await tx
      .update(jobsTable)
      .set({
        status: "running",
        attempts: sql`${jobsTable.attempts} + 1`,
        startedAt: new Date(),
        error: null,
      })
      .where(eq(jobsTable.id, candidate.id))
      .returning();
    return claimed ?? null;
  });
}

let processing = false;

type ClaimedServerJob = NonNullable<Awaited<ReturnType<typeof claimServerJob>>>;

async function runServerJob(job: ClaimedServerJob): Promise<void> {
  try {
    if (job.type !== "send_sms") {
      throw new Error(`Unsupported API worker job type: ${job.type}`);
    }

    const studentId = Number(job.payload.studentId);
    const status = String(job.payload.status);
    if (!Number.isInteger(studentId) || !isAttendanceSmsStatus(status)) {
      throw new Error("Invalid attendance notification job payload");
    }
    const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
    if (!student) throw new Error("Student no longer exists");

    let classroomName: string | null = null;
    if (student.classroomId) {
      const [cls] = await db
        .select({ name: classroomsTable.name })
        .from(classroomsTable)
        .where(eq(classroomsTable.id, student.classroomId))
        .limit(1);
      classroomName = cls?.name ?? null;
    }

    const rawMarkedAt = job.payload.markedAt;
    const parsedMarkedAt = typeof rawMarkedAt === "string" ? new Date(rawMarkedAt) : null;
    const markedAt = parsedMarkedAt && Number.isFinite(parsedMarkedAt.getTime())
      ? parsedMarkedAt
      : new Date();
    let timezone = "Africa/Addis_Ababa";
    try {
      timezone = (await getArrivalRules()).timezone;
    } catch (err) {
      logger.warn({ err }, "Could not load attendance timezone; using SMS fallback timezone");
    }

    // Keep the event time and format it in the school's timezone, not the
    // server timezone (UTC on Vercel).
    const message = await buildStatusMessage(
      status,
      student.name,
      classroomName,
      markedAt,
      timezone,
    );

    let delivery: Awaited<ReturnType<typeof sendSms>> | null = null;
    try {
      delivery = await sendSms({
        studentId: student.id,
        parentPhone: student.parentPhone,
        message,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof SmsDeliveryError && error.retryable && job.attempts < 3;
      if (retryable) {
        await db
          .update(jobsTable)
          .set({
            status: "pending",
            error: `Retrying SMS (attempt ${job.attempts}/3): ${detail}`,
          })
          .where(eq(jobsTable.id, job.id));
        publishEvent("job.updated", { jobId: job.id, type: job.type, status: "pending", worker: "api", error: detail });
        logger.warn({ jobId: job.id, attempt: job.attempts, err: error }, "SMS delivery retriable — requeued");
        return;
      }
      await db
        .update(jobsTable)
        .set({
          status: "failed",
          result: { deliveryStatus: "failed", provider: error instanceof SmsDeliveryError ? error.provider : "twilio", providerCode: error instanceof SmsDeliveryError ? error.code : null },
          error: `SMS delivery failed: ${detail}`,
          completedAt: new Date(),
        })
        .where(eq(jobsTable.id, job.id));
      publishEvent("job.updated", { jobId: job.id, type: job.type, status: "failed", worker: "api", error: detail });
      await writeAudit({
        action: "sms.job.failed",
        targetType: "job",
        targetId: job.id,
        payload: { studentId: student.id, providerError: detail },
      });
      logger.error({ err: error, jobId: job.id }, "API worker SMS job failed");
      return;
    }

    await db
      .update(jobsTable)
      .set({
        status: "done",
        result: { deliveryStatus: "sent", provider: delivery?.provider ?? null },
        error: null,
        completedAt: new Date(),
      })
      .where(eq(jobsTable.id, job.id));

    publishEvent("job.updated", { jobId: job.id, type: job.type, status: "done", worker: "api" });
    // NO SIMULATED DATA IN LIVE FEEDS: with no real gateway configured the
    // "simulation" provider writes an honest sms_logs row (visible, labeled,
    // zero side effects) — but it must NOT stream into the dashboards as if a
    // message actually went out. Only real-provider deliveries broadcast.
    if (delivery && delivery.provider !== "simulation") {
      publishEvent("sms.sent", { studentId: student.id, status, smsStatus: "sent", provider: delivery.provider });
    }

    await writeAudit({
      action: "sms.job.processed",
      targetType: "job",
      targetId: job.id,
      payload: { deliveryStatus: "sent", provider: delivery?.provider ?? null, simulated: delivery?.provider === "simulation", studentId: student.id },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(jobsTable)
      .set({ status: "failed", error: message, completedAt: new Date() })
      .where(eq(jobsTable.id, job.id));
    publishEvent("job.updated", { jobId: job.id, type: job.type, status: "failed", worker: "api", error: message });
    logger.error({ err: error, jobId: job.id }, "API worker job failed");
  }
}

export async function processVercelJob(jobId: number): Promise<void> {
  const job = await claimServerJob(jobId);
  if (job) await runServerJob(job);
}

export async function processOneServerJob(): Promise<boolean> {
  if (processing) return false;
  processing = true;
  try {
    const job = await claimServerJob();
    if (!job) return false;
    await runServerJob(job);
    return true;
  } finally {
    processing = false;
  }
}

export function startServerJobWorker(): void {
  // Self-hosted deployments: jobs every 1.5s AND the automatic absent sweep
  // checked once per minute (it self-guards on cutoff time + once-per-day).
  let lastSweepCheck = 0;
  const maybeSweep = () => {
    const now = Date.now();
    if (now - lastSweepCheck < 60_000) return;
    lastSweepCheck = now;
    void import("./absent-sweep")
      .then(({ runAbsentSweep }) => runAbsentSweep({ respectOncePerDay: true }))
      .catch((err) => logger.warn({ err }, "background absent sweep failed"));
  };
  const timer = setInterval(() => {
    void processOneServerJob();
    maybeSweep();
  }, 1500);
  timer.unref?.();
  void processOneServerJob();
}
