import { db, fraudSignalsTable, qrScanLogsTable, gatesTable } from "@workspace/db";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { haversineM, isPlausibleGeo, type GeoPoint } from "./gates";
import { logger } from "./logger";

/**
 * Proxy-fraud AI (Phase 6) — inline behavioral analysis on every committed
 * QR scan. Deterministic, explainable heuristics with a 0-100 confidence
 * score; every signal lands in the Review Queue → Fraud Radar where staff
 * dismiss or confirm it. Designed to catch the three ways students cheat
 * QR attendance:
 *
 *  1. IMPOSSIBLE TRAVEL — one badge at two far-apart gates within a window
 *     that implies >walking speed (friend carries the badge to the other
 *     campus while the student sleeps in).
 *  2. BURST SCAN — one terminal scanning faster than any human queue
 *     (a pile of badges on the reader / scripted replay).
 *  3. BADGE SHARING — one badge used at multiple terminals minutes apart
 *     (badge handed over the fence), plus proxy-farm detection (one
 *     terminal sweeping many students unrealistically fast).
 *  4. GEOFENCE VIOLATION — GPS-signed scan outside the gate radius (scanned
 *     from home; killed by the geofence engine but recorded here too).
 */

export type FraudKind = "impossible_travel" | "burst_scan" | "badge_sharing" | "geofence_violation";

export interface FraudAnalysisContext {
  scanLogId: number;
  studentId: number;
  terminalId: string;
  gateId: string | null;
  /** gate geofence center (or the scan GPS when the gate has none) */
  scanGeo: (GeoPoint & { accuracy?: number | null }) | null;
  scannedAt: Date;
}

export interface FraudAnalysisResult {
  score: number;
  kinds: FraudKind[];
}

const HUMAN_WALK_SPEED_KMH = 9; // brisk jog + margin
const CAR_SPEED_KMH = 120; // beyond this is flatly impossible between gates
const BURST_WINDOW_SEC = 60;
const BURST_THRESHOLD = 12;
const BADGE_SHARE_WINDOW_MIN = 10;
const PROXY_FARM_WINDOW_SEC = 180;
const PROXY_FARM_UNIQUE_STUDENTS = 25;
const DEDUPE_WINDOW_MIN = 30;

interface NewSignal {
  kind: FraudKind;
  severity: "low" | "medium" | "high";
  score: number;
  studentId: number | null;
  terminalId: string | null;
  gateId: string | null;
  primaryScanId: number | null;
  relatedScanIds: number[];
  detail: string;
  evidence: Record<string, unknown>;
  dedupeKey: string;
}

function bucket(date: Date): string {
  // 30-minute dedupe bucket (UTC)
  const ms = date.getTime();
  const b = Math.floor(ms / (30 * 60 * 1000));
  return String(b);
}

async function insertSignal(sig: NewSignal): Promise<boolean> {
  try {
    await db.insert(fraudSignalsTable).values({
      kind: sig.kind,
      severity: sig.severity,
      score: Math.max(0, Math.min(100, Math.round(sig.score))),
      studentId: sig.studentId,
      terminalId: sig.terminalId,
      gateId: sig.gateId,
      primaryScanId: sig.primaryScanId,
      relatedScanIds: sig.relatedScanIds,
      detail: sig.detail,
      evidence: JSON.stringify(sig.evidence),
      dedupeKey: sig.dedupeKey,
      status: "open",
    });
    return true;
  } catch (err) {
    // Unique dedupe index → signal for this window already exists. Fine.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("fraud_signals_dedupe_uidx") || msg.includes("duplicate key")) return false;
    logger.warn({ err, kind: sig.kind }, "fraud signal insert failed");
    return false;
  }
}

/** Prior valid/duplicate scan of the same student with usable geo info. */
interface PriorScan {
  id: number;
  terminalId: string;
  gateId: string | null;
  latitude: number | null;
  longitude: number | null;
  scannedAt: Date | null;
  createdAt: Date;
  gateLat: number | null;
  gateLng: number | null;
}

async function lastGeoScanOfStudent(studentId: number, before: Date): Promise<PriorScan | null> {
  const rows = await db
    .select({
      id: qrScanLogsTable.id,
      terminalId: qrScanLogsTable.terminalId,
      gateId: qrScanLogsTable.gateId,
      latitude: qrScanLogsTable.latitude,
      longitude: qrScanLogsTable.longitude,
      scannedAt: qrScanLogsTable.scannedAt,
      createdAt: qrScanLogsTable.createdAt,
      gateLat: gatesTable.latitude,
      gateLng: gatesTable.longitude,
    })
    .from(qrScanLogsTable)
    .leftJoin(gatesTable, eq(qrScanLogsTable.gateId, gatesTable.gateId))
    .where(and(
      eq(qrScanLogsTable.studentId, studentId),
      inArray(qrScanLogsTable.result, ["valid", "duplicate"]),
      gte(qrScanLogsTable.createdAt, new Date(before.getTime() - 24 * 3600 * 1000)),
      ne(qrScanLogsTable.id, -1),
    ))
    .orderBy(desc(qrScanLogsTable.createdAt))
    .limit(5);

  for (const r of rows) {
    // Rows without a usable scan GPS fix can't participate in geo checks —
    // but they can still be returned via their gate's registered coordinates.
    if (r.latitude != null && r.longitude != null
      && isPlausibleGeo({ latitude: r.latitude, longitude: r.longitude })) return r;
    if (r.gateLat != null && r.gateLng != null) return r;
  }
  return null;
}

function scanPoint(s: PriorScan): GeoPoint | null {
  if (s.latitude != null && s.longitude != null
    && isPlausibleGeo({ latitude: s.latitude, longitude: s.longitude })) {
    return { latitude: s.latitude, longitude: s.longitude };
  }
  if (s.gateLat != null && s.gateLng != null) return { latitude: s.gateLat, longitude: s.gateLng };
  return null;
}

function scanTime(s: PriorScan): Date {
  return s.scannedAt ?? s.createdAt;
}

/**
 * Run the full inline analysis for one committed scan.
 * Never throws — attendance commit must not fail because of the radar.
 */
export async function analyzeScanForFraud(ctx: FraudAnalysisContext): Promise<FraudAnalysisResult> {
  const kinds: FraudKind[] = [];
  let score = 0;
  try {
    // ── 1. Impossible travel ────────────────────────────────────
    const prior = await lastGeoScanOfStudent(ctx.studentId, ctx.scannedAt);
    if (prior) {
      const from = scanPoint(prior);
      if (from && ctx.scanGeo && isPlausibleGeo(ctx.scanGeo)) {
        const distanceKm = haversineM(from, ctx.scanGeo) / 1000;
        const dtMin = Math.max(0.5, (ctx.scannedAt.getTime() - scanTime(prior).getTime()) / 60000);
        const speedKmh = (distanceKm / dtMin) * 60;
        if (distanceKm > 1.2 && speedKmh > HUMAN_WALK_SPEED_KMH) {
          const severity = speedKmh > CAR_SPEED_KMH ? "high" : speedKmh > 60 ? "medium" : "low";
          const created = await insertSignal({
            kind: "impossible_travel",
            severity,
            score: Math.min(100, Math.round(speedKmh)),
            studentId: ctx.studentId,
            terminalId: ctx.terminalId,
            gateId: ctx.gateId,
            primaryScanId: ctx.scanLogId,
            relatedScanIds: [prior.id],
            detail: `Badge moved ${distanceKm.toFixed(1)} km in ${dtMin.toFixed(0)} min (${Math.round(speedKmh)} km/h) — physically impossible for a student.`,
            evidence: {
              distanceKm: Number(distanceKm.toFixed(2)),
              minutes: Number(dtMin.toFixed(1)),
              speedKmh: Math.round(speedKmh),
              priorScanId: prior.id,
              priorTerminal: prior.terminalId,
              priorAt: scanTime(prior).toISOString(),
              currentAt: ctx.scannedAt.toISOString(),
            },
            dedupeKey: `st:${ctx.studentId}:${bucket(ctx.scannedAt)}`,
          });
          if (created) {
            kinds.push("impossible_travel");
            score = Math.max(score, Math.min(100, Math.round(speedKmh)));
          }
        }
      }

      // ── 3a. Badge sharing: same badge, different terminal, minutes apart ──
      const dtShareMin = (ctx.scannedAt.getTime() - scanTime(prior).getTime()) / 60000;
      if (
        prior.terminalId !== ctx.terminalId &&
        dtShareMin <= BADGE_SHARE_WINDOW_MIN &&
        dtShareMin >= 0
      ) {
        const created = await insertSignal({
          kind: "badge_sharing",
          severity: "high",
          score: 72,
          studentId: ctx.studentId,
          terminalId: ctx.terminalId,
          gateId: ctx.gateId,
          primaryScanId: ctx.scanLogId,
          relatedScanIds: [prior.id],
          detail: `Same badge scanned at "${prior.terminalId}" and "${ctx.terminalId}" ${dtShareMin.toFixed(1)} min apart — likely badge hand-off.`,
          evidence: {
            priorTerminal: prior.terminalId,
            currentTerminal: ctx.terminalId,
            minutes: Number(dtShareMin.toFixed(1)),
            priorScanId: prior.id,
          },
          dedupeKey: `st:${ctx.studentId}:${bucket(ctx.scannedAt)}`,
        });
        if (created) {
          kinds.push("badge_sharing");
          score = Math.max(score, 72);
        }
      }
    }

    // ── 2. Burst scan: terminal scanning faster than any human queue ──
    if (ctx.terminalId && ctx.terminalId !== "web") {
      const windowStart = new Date(ctx.scannedAt.getTime() - BURST_WINDOW_SEC * 1000);
      const [burst] = await db
        .select({ total: sql<number>`count(*)` })
        .from(qrScanLogsTable)
        .where(and(
          eq(qrScanLogsTable.terminalId, ctx.terminalId),
          inArray(qrScanLogsTable.result, ["valid", "duplicate"]),
          gte(qrScanLogsTable.createdAt, new Date(windowStart.getTime())),
        ));
      const count = Number(burst?.total ?? 0);
      if (count >= BURST_THRESHOLD) {
        const created = await insertSignal({
          kind: "burst_scan",
          severity: count >= BURST_THRESHOLD * 2 ? "high" : "medium",
          score: Math.min(100, count * 6),
          studentId: null,
          terminalId: ctx.terminalId,
          gateId: ctx.gateId,
          primaryScanId: ctx.scanLogId,
          relatedScanIds: [],
          detail: `Terminal "${ctx.terminalId}" committed ${count} scans in ${BURST_WINDOW_SEC}s — faster than any human queue. Badge pile or scripted replay.`,
          evidence: { count, windowSec: BURST_WINDOW_SEC, threshold: BURST_THRESHOLD },
          dedupeKey: `tm:${ctx.terminalId}:${bucket(ctx.scannedAt)}`,
        });
        if (created) {
          kinds.push("burst_scan");
          score = Math.max(score, Math.min(100, count * 6));
        }
      }

      // ── 3b. Proxy farm: one terminal sweeping many unique students ──
      const farmStart = new Date(ctx.scannedAt.getTime() - PROXY_FARM_WINDOW_SEC * 1000);
      const [farm] = await db
        .select({ total: sql<number>`count(distinct ${qrScanLogsTable.studentId})` })
        .from(qrScanLogsTable)
        .where(and(
          eq(qrScanLogsTable.terminalId, ctx.terminalId),
          eq(qrScanLogsTable.result, "valid"),
          gte(qrScanLogsTable.createdAt, farmStart),
        ));
      const unique = Number(farm?.total ?? 0);
      if (unique >= PROXY_FARM_UNIQUE_STUDENTS) {
        const created = await insertSignal({
          kind: "badge_sharing",
          severity: "high",
          score: 80,
          studentId: null,
          terminalId: ctx.terminalId,
          gateId: ctx.gateId,
          primaryScanId: ctx.scanLogId,
          relatedScanIds: [],
          detail: `Terminal "${ctx.terminalId}" scanned ${unique} distinct students in ${PROXY_FARM_WINDOW_SEC / 60} min — organized proxy-farm pattern.`,
          evidence: { uniqueStudents: unique, windowSec: PROXY_FARM_WINDOW_SEC },
          dedupeKey: `farm:${ctx.terminalId}:${bucket(ctx.scannedAt)}`,
        });
        if (created) {
          kinds.push("badge_sharing");
          score = Math.max(score, 80);
        }
      }
    }

    return { score, kinds };
  } catch (err) {
    logger.warn({ err }, "fraud analysis failed (scan already committed)");
    return { score: 0, kinds };
  }
}

/**
 * Record a geofence rejection as a high-severity fraud signal.
 * Called from the scan path when the GPS check fails.
 */
export async function recordGeofenceViolation(params: {
  scanLogId: number | null;
  studentId: number | null;
  terminalId: string;
  gateId: string;
  distanceM: number;
  radiusM: number;
  at: Date;
}): Promise<void> {
  await insertSignal({
    kind: "geofence_violation",
    severity: "high",
    score: 90,
    studentId: params.studentId,
    terminalId: params.terminalId,
    gateId: params.gateId,
    primaryScanId: params.scanLogId,
    relatedScanIds: [],
    detail: `Scan for student #${params.studentId ?? "?"} arrived from ${Math.round(params.distanceM)} m away — gate "${params.gateId}" allows ${params.radiusM} m. QR proxying from outside the school.`,
    evidence: {
      distanceM: Math.round(params.distanceM),
      radiusM: params.radiusM,
      gateId: params.gateId,
      terminalId: params.terminalId,
    },
    dedupeKey: `st:${params.studentId ?? "x"}:${bucket(params.at)}`,
  });
}
