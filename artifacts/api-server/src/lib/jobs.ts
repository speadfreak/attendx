import { and, asc, eq, sql } from "drizzle-orm";
import { db, jobsTable, studentsTable, classroomsTable } from "@workspace/db";
import { logger } from "./logger";
import { writeAudit } from "./audit";
import { sendSms } from "./sms";
import { buildStatusMessage } from "./sms-templates";
import { publishEvent } from "./events";

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
    if (!Number.isInteger(studentId) || !["late", "absent"].includes(status)) {
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

    const message = await buildStatusMessage(
      status as "late" | "absent",
      student.name,
      classroomName,
    );
    const deliveryStatus = await sendSms({
      studentId: student.id,
      parentPhone: student.parentPhone,
      message,
    });

    await db
      .update(jobsTable)
      .set({
        status: deliveryStatus === "sent" ? "done" : "failed",
        result: { deliveryStatus },
        error: deliveryStatus === "failed" ? "SMS provider reported a delivery failure" : null,
        completedAt: new Date(),
      })
      .where(eq(jobsTable.id, job.id));

    publishEvent("job.updated", { jobId: job.id, type: job.type, status: deliveryStatus === "sent" ? "done" : "failed", worker: "api" });
    publishEvent("sms.sent", { studentId: student.id, status: deliveryStatus, smsStatus: status });

    await writeAudit({
      action: "sms.job.processed",
      targetType: "job",
      targetId: job.id,
      payload: { deliveryStatus, studentId: student.id },
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
  const timer = setInterval(() => {
    void processOneServerJob();
  }, 1500);
  timer.unref?.();
  void processOneServerJob();
}
