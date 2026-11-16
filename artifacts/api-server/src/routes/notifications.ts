import { Router } from "express";
import { db, matchReviewsTable, gateDevicesTable, jobsTable, qrScanLogsTable, studentsTable, gateIntegrityAlertsTable, fraudSignalsTable } from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";

/**
 * Central notification feed. Aggregates the events that used to be buried in
 * separate pages: pending review queue, Pi devices gone quiet, failed jobs,
 * QR anomalies. Computed live on each request — no read-state needed.
 */
const router = Router();

export interface NotificationItem {
  id: string;
  severity: "critical" | "warning" | "info";
  category: "review" | "device" | "job" | "qr" | "gate" | "system";
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

  // 2. Gate devices offline / unhealthy — Pi kiosks AND phone cameras (Phase 7).
  // A phone camera that goes dark mid-session is a blind spot: the alert says
  // so explicitly and points the operator at the manual/QR fallback.
  const devices = await db.select().from(gateDevicesTable);
  for (const d of devices) {
    const isPhone = d.deviceType === "phone";
    const paired = Boolean(d.currentTokenHash || d.tokenExpiresAt);
    const quiet = !d.lastSeenAt || now - d.lastSeenAt.getTime() > 3 * 60 * 1000;
    if (quiet && paired && d.status !== "never-seen") {
      items.push({
        id: `device-offline-${d.id}`,
        severity: "critical",
        category: "device",
        title: isPhone && d.assignedGateId
          ? `Gate camera down — "${d.name}" (${d.assignedGateId})`
          : `${isPhone ? "Phone camera" : "Pi"} "${d.name}" went offline`,
        detail: isPhone && d.assignedGateId
          ? `No heartbeat for ${d.lastSeenAt ? Math.round((now - d.lastSeenAt.getTime()) / 60000) : "?"} min — switch this gate to manual/QR fallback until the camera is back.`
          : d.lastSeenAt
            ? `Last heartbeat ${Math.round((now - d.lastSeenAt.getTime()) / 60000)} min ago · CPU ${d.cpuTempC?.toFixed(0) ?? "?"}°C`
            : "Device has never sent a heartbeat",
        at: (d.lastSeenAt ?? d.createdAt).toISOString(),
        link: "/operations",
      });
    }
    if (
      isPhone &&
      (d.healthStatus === "obstructed" || d.healthStatus === "frozen") &&
      d.lastSeenAt &&
      now - d.lastSeenAt.getTime() < 24 * 3600 * 1000
    ) {
      items.push({
        id: `device-health-${d.id}`,
        severity: "warning",
        category: "device",
        title: `Camera ${d.healthStatus} — "${d.name}"${d.assignedGateId ? ` (${d.assignedGateId})` : ""}`,
        detail: d.healthStatus === "obstructed"
          ? "The lens reports a near-black frame — covered, pocketed, or no light at the gate."
          : "The camera frame is frozen — the app is backgrounded or the sensor stalled.",
        at: (d.thumbnailAt ?? d.lastSeenAt ?? d.createdAt).toISOString(),
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

  // 5. Gate integrity alerts (unresolved, last 24h) — Phase 4
  const gateAlerts = await db
    .select({
      id: gateIntegrityAlertsTable.id,
      alertType: gateIntegrityAlertsTable.alertType,
      windowStart: gateIntegrityAlertsTable.windowStart,
      cameraCount: gateIntegrityAlertsTable.cameraCount,
      ultrasonicCount: gateIntegrityAlertsTable.ultrasonicCount,
      irCount: gateIntegrityAlertsTable.irCount,
      simulated: gateIntegrityAlertsTable.simulated,
    })
    .from(gateIntegrityAlertsTable)
    .where(and(
      eq(gateIntegrityAlertsTable.resolved, false),
      gte(gateIntegrityAlertsTable.createdAt, new Date(now - 24 * 3600 * 1000)),
    ))
    .orderBy(desc(gateIntegrityAlertsTable.windowStart))
    .limit(6);
  for (const a of gateAlerts) {
    const label = a.alertType === "missed_detections" ? "Possible missed detections" : "Sensor conflict";
    items.push({
      id: `gate-${a.id}`,
      severity: a.alertType === "missed_detections" ? "critical" : "warning",
      category: "gate",
      title: a.simulated ? `[DEMO] Gate: ${label}` : `Gate integrity: ${label}`,
      detail: `Window ${a.windowStart.toISOString().slice(11, 16)} UTC · camera ${a.cameraCount} · ultrasonic ${a.ultrasonicCount} · IR ${a.irCount}`,
      at: a.windowStart.toISOString(),
      link: "/operations",
    });
  }

  // 6. Open proxy-fraud signals (last 24h) — Phase 6. The fraud_signals
  // table comes from migration 0007; if it is missing (bootstrap failed /
  // disabled), degrade to a feed without fraud entries instead of 500-ing
  // the whole notifications response. Reviews/jobs/QR sections above must
  // survive a missing Phase 6 table.
  try {
    const fraudSignals = await db
      .select({
        id: fraudSignalsTable.id,
        kind: fraudSignalsTable.kind,
        severity: fraudSignalsTable.severity,
        score: fraudSignalsTable.score,
        studentName: studentsTable.name,
        createdAt: fraudSignalsTable.createdAt,
      })
      .from(fraudSignalsTable)
      .leftJoin(studentsTable, eq(fraudSignalsTable.studentId, studentsTable.id))
      .where(and(eq(fraudSignalsTable.status, "open"), gte(fraudSignalsTable.createdAt, new Date(now - 24 * 3600 * 1000))))
      .orderBy(desc(fraudSignalsTable.createdAt))
      .limit(6);
    for (const s of fraudSignals) {
      items.push({
        id: `fraud-${s.id}`,
        severity: s.severity === "critical" || s.severity === "high" ? "critical" : s.severity === "medium" ? "warning" : "info",
        category: "review",
        title: `Proxy-fraud signal: ${s.kind}`,
        detail: `${s.studentName ?? "Unknown student"} · score ${s.score}/100 · severity ${s.severity}`,
        at: s.createdAt.toISOString(),
        link: "/review-queue",
      });
    }
  } catch (err) {
    logger.warn({ err }, "notifications: fraud_signals section unavailable — skipping (is migration 0007 applied?)");
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
