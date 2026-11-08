import { Router } from "express";
import { db, matchReviewsTable, piDevicesTable, jobsTable, qrScanLogsTable, studentsTable } from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth";

/**
 * Central notification feed. Aggregates the events that used to be buried in
 * separate pages: pending review queue, Pi devices gone quiet, failed jobs,
 * QR anomalies. Computed live on each request — no read-state needed.
 */
const router = Router();

export interface NotificationItem {
  id: string;
  severity: "critical" | "warning" | "info";
  category: "review" | "device" | "job" | "qr" | "system";
  title: string;
  detail: string;
  at: string;
  link: string;
}

router.get("/notifications", requireAuth, async (_req, res): Promise<void> => {
  const now = Date.now();
  const items: NotificationItem[] = [];

  // 1. Pending low-confidence matches
  const pendingReviews = await db
    .select({
      id: matchReviewsTable.id,
      studentName: studentsTable.name,
      confidence: matchReviewsTable.confidence,
      createdAt: matchReviewsTable.createdAt,
    })
    .from(matchReviewsTable)
    .leftJoin(studentsTable, eq(matchReviewsTable.studentId, studentsTable.id))
    .where(eq(matchReviewsTable.status, "pending"))
    .orderBy(desc(matchReviewsTable.createdAt))
    .limit(8);
  for (const r of pendingReviews) {
    items.push({
      id: `review-${r.id}`,
      severity: "warning",
      category: "review",
      title: "Low-confidence match needs review",
      detail: `${r.studentName ?? "Unknown student"} matched at ${(r.confidence * 100).toFixed(0)}% confidence`,
      at: r.createdAt.toISOString(),
      link: "/review-queue",
    });
  }

  // 2. Pi devices offline (no heartbeat for > 3 min)
  const devices = await db.select().from(piDevicesTable);
  for (const d of devices) {
    const quiet = !d.lastSeenAt || now - d.lastSeenAt.getTime() > 3 * 60 * 1000;
    if (quiet && d.status !== "never-seen") {
      items.push({
        id: `pi-${d.id}`,
        severity: "critical",
        category: "device",
        title: `Pi "${d.name}" went offline`,
        detail: d.lastSeenAt
          ? `Last heartbeat ${Math.round((now - d.lastSeenAt.getTime()) / 60000)} min ago · CPU ${d.cpuTempC?.toFixed(0) ?? "?"}°C`
          : "Device has never sent a heartbeat",
        at: (d.lastSeenAt ?? d.createdAt).toISOString(),
        link: "/operations",
      });
    }
  }

  // 3. Failed jobs in the last 24h
  const failedJobs = await db
    .select({ id: jobsTable.id, type: jobsTable.type, error: jobsTable.error, completedAt: jobsTable.completedAt })
    .from(jobsTable)
    .where(and(eq(jobsTable.status, "failed"), gte(jobsTable.createdAt, new Date(now - 24 * 3600 * 1000))))
    .orderBy(desc(jobsTable.createdAt))
    .limit(6);
  for (const j of failedJobs) {
    items.push({
      id: `job-${j.id}`,
      severity: "critical",
      category: "job",
      title: j.type === "send_sms" ? "SMS job failed" : `Job "${j.type}" failed`,
      detail: j.error?.slice(0, 140) ?? "No error detail recorded",
      at: (j.completedAt ?? new Date(now)).toISOString(),
      link: "/operations",
    });
  }

  // 4. QR anomalies in the last 24h
  const anomalies = await db
    .select({ id: qrScanLogsTable.id, result: qrScanLogsTable.result, terminalId: qrScanLogsTable.terminalId, createdAt: qrScanLogsTable.createdAt })
    .from(qrScanLogsTable)
    .where(and(sql`${qrScanLogsTable.result} <> 'valid' and ${qrScanLogsTable.result} <> 'duplicate'`, gte(qrScanLogsTable.createdAt, new Date(now - 24 * 3600 * 1000))))
    .orderBy(desc(qrScanLogsTable.createdAt))
    .limit(6);
  for (const a of anomalies) {
    items.push({
      id: `qr-${a.id}`,
      severity: a.result === "bad-signature" || a.result === "not-attendx-qr" ? "critical" : "warning",
      category: "qr",
      title: `QR anomaly: ${a.result}`,
      detail: `Terminal "${a.terminalId}" rejected a badge scan`,
      at: a.createdAt.toISOString(),
      link: "/qr-manager",
    });
  }

  items.sort((a, b) => b.at.localeCompare(a.at));

  res.json({
    items,
    counts: {
      total: items.length,
      critical: items.filter((i) => i.severity === "critical").length,
      warning: items.filter((i) => i.severity === "warning").length,
      pendingReviews: pendingReviews.length,
    },
  });
});

export default router;
