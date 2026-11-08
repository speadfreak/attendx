/**
 * Phase 4 — Gate Integrity cross-validation engine.
 *
 * For each rolling window (default 60s, epoch-aligned) compare three counts:
 *   camera      — attendance rows committed with source = "gate-camera"
 *   ultrasonic  — gate_sensor_events rows (sensor = "ultrasonic")
 *   ir_beam     — gate_sensor_events rows (sensor = "ir_beam")
 *
 * Alerts:
 *   missed_detections — camera LOWER than BOTH physical sensors by more than
 *                       the configured threshold → students probably walked
 *                       through without a face match (lighting / angle / crowd).
 *   sensor_conflict   — the two physical sensors disagree with each other
 *                       beyond the threshold → hardware fault, NOT an
 *                       attendance problem.
 *
 * Windows are epoch-aligned (floor(timestamp / windowSeconds)) so repeated
 * validation runs over the same range are idempotent, and the unique index
 * on (gate_id, window_start, alert_type) guarantees no duplicate alerts.
 */
import { db, attendanceLogsTable, gateSensorEventsTable, gateIntegrityAlertsTable } from "@workspace/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { getSystemSettings, hhmmToMinutes } from "./system-settings";
import { minutesSinceMidnight } from "./attendance-rules";
import { publishEvent } from "./events";
import { logger } from "./logger";

export type GateAlertType = "missed_detections" | "sensor_conflict";
export type WindowVerdict = "ok" | GateAlertType;

export interface WindowCounts {
  windowStart: Date;
  windowEnd: Date;
  camera: number;
  ultrasonic: number;
  ir: number;
  simulatedEvents: number;
}

const MAX_DETAIL_TIMESTAMPS = 60;

function floorWindow(t: Date, windowMs: number): number {
  return Math.floor(t.getTime() / windowMs);
}

/** Fetch camera + sensor rows once for the whole range, bucket per window. */
export async function collectWindowCounts(params: {
  gateId: string;
  rangeStart: Date;
  rangeEnd: Date;
  windowMs: number;
}): Promise<Map<number, WindowCounts>> {
  const { gateId, rangeStart, rangeEnd, windowMs } = params;
  const windows = new Map<number, WindowCounts>();

  const ensure = (idx: number): WindowCounts => {
    let w = windows.get(idx);
    if (!w) {
      w = {
        windowStart: new Date(idx * windowMs),
        windowEnd: new Date((idx + 1) * windowMs),
        camera: 0,
        ultrasonic: 0,
        ir: 0,
        simulatedEvents: 0,
      };
      windows.set(idx, w);
    }
    return w;
  };

  const cameraRows = await db
    .select({ markedAt: attendanceLogsTable.markedAt })
    .from(attendanceLogsTable)
    .where(and(
      eq(attendanceLogsTable.source, "gate-camera"),
      gte(attendanceLogsTable.markedAt, rangeStart),
      lt(attendanceLogsTable.markedAt, rangeEnd),
    ));
  for (const row of cameraRows) ensure(floorWindow(row.markedAt, windowMs)).camera += 1;

  const sensorRows = await db
    .select({ sensor: gateSensorEventsTable.sensor, occurredAt: gateSensorEventsTable.occurredAt, simulated: gateSensorEventsTable.simulated })
    .from(gateSensorEventsTable)
    .where(and(
      eq(gateSensorEventsTable.gateId, gateId),
      gte(gateSensorEventsTable.occurredAt, rangeStart),
      lt(gateSensorEventsTable.occurredAt, rangeEnd),
    ));
  for (const row of sensorRows) {
    const w = ensure(floorWindow(row.occurredAt, windowMs));
    if (row.sensor === "ultrasonic") w.ultrasonic += 1;
    else if (row.sensor === "ir_beam") w.ir += 1;
    if (row.simulated) w.simulatedEvents += 1;
  }

  return windows;
}

export function evaluateWindow(w: WindowCounts, discrepancyPct: number): GateAlertType[] {
  const alerts: GateAlertType[] = [];
  const p = discrepancyPct / 100;

  // missed_detections: camera below BOTH physical sensors by more than the threshold
  const belowThreshold = (physical: number) =>
    physical >= 1 && (physical - w.camera) / physical > p && w.camera < physical;
  if (belowThreshold(w.ultrasonic) && belowThreshold(w.ir)) {
    alerts.push("missed_detections");
  }

  // sensor_conflict: the two physical sensors disagree with each other
  const spread = Math.abs(w.ultrasonic - w.ir);
  const largest = Math.max(w.ultrasonic, w.ir, 1);
  if (spread >= 1 && spread / largest > p) {
    alerts.push("sensor_conflict");
  }

  return alerts;
}

/** Verdict for the live three-way comparison tile. */
export function verdictForCounts(camera: number, ultrasonic: number, ir: number, discrepancyPct: number): WindowVerdict {
  const alerts = evaluateWindow(
    {
      windowStart: new Date(0),
      windowEnd: new Date(0),
      camera,
      ultrasonic,
      ir,
      simulatedEvents: 0,
    },
    discrepancyPct,
  );
  if (alerts.includes("sensor_conflict")) return "sensor_conflict";
  if (alerts.includes("missed_detections")) return "missed_detections";
  return "ok";
}

function isWithinGateHours(now: Date, activeFrom: string, activeTo: string, timezone: string): boolean {
  const from = hhmmToMinutes(activeFrom) ?? 360;
  const to = hhmmToMinutes(activeTo) ?? 600;
  const m = minutesSinceMidnight(now, timezone);
  return m >= from && m <= to;
}

export interface ValidationRunResult {
  ran: boolean;
  skippedReason?: string;
  windowsEvaluated: number;
  alertsCreated: Array<{ id: number; alertType: GateAlertType; windowStart: string; simulated: boolean }>;
}

/**
 * Validate the last hour of completed windows. Inline after each sensor
 * ingestion, via the daily cron, and from the manual "Run validation" button.
 */
export async function runGateValidation(options: { force?: boolean; now?: Date } = {}): Promise<ValidationRunResult> {
  const settings = await getSystemSettings();
  const now = options.now ?? new Date();
  const timezone = settings.attendanceTimezone;

  if (!options.force && !isWithinGateHours(now, settings.gateActiveFrom, settings.gateActiveTo, timezone)) {
    return { ran: false, skippedReason: "outside-gate-hours", windowsEvaluated: 0, alertsCreated: [] };
  }

  const windowMs = settings.gateWindowSeconds * 1000;
  const currentIdx = floorWindow(now, windowMs);
  const lookbackWindows = 60;
  const rangeStart = new Date((currentIdx - lookbackWindows) * windowMs);
  const rangeEnd = new Date(currentIdx * windowMs); // only COMPLETED windows are judged

  const windows = await collectWindowCounts({ gateId: "gate-1", rangeStart, rangeEnd, windowMs });

  let evaluated = 0;
  const alertsCreated: ValidationRunResult["alertsCreated"] = [];

  for (const [idx, w] of windows) {
    if (idx >= currentIdx) continue; // window still open
    evaluated += 1;
    const alertTypes = evaluateWindow(w, settings.gateDiscrepancyPct);
    if (!alertTypes.length) continue;

    for (const alertType of alertTypes) {
      const [inserted] = await db
        .insert(gateIntegrityAlertsTable)
        .values({
          gateId: "gate-1",
          windowStart: w.windowStart,
          windowEnd: w.windowEnd,
          cameraCount: w.camera,
          ultrasonicCount: w.ultrasonic,
          irCount: w.ir,
          alertType,
          simulated: w.simulatedEvents > 0,
          detail: {
            gateId: "gate-1",
            discrepancyPct: settings.gateDiscrepancyPct,
            windowSeconds: settings.gateWindowSeconds,
            simulatedEvents: w.simulatedEvents,
            thresholds: {
              missed_detections: "camera lower than BOTH sensors by more than the configured %",
              sensor_conflict: "|ultrasonic − ir| larger than the configured % of the larger count",
            },
          },
        })
        // unique (gate_id, window_start, alert_type) — safe to re-run
        .onConflictDoNothing({ target: [gateIntegrityAlertsTable.gateId, gateIntegrityAlertsTable.windowStart, gateIntegrityAlertsTable.alertType] })
        .returning({ id: gateIntegrityAlertsTable.id });

      if (inserted) {
        alertsCreated.push({ id: inserted.id, alertType, windowStart: w.windowStart.toISOString(), simulated: w.simulatedEvents > 0 });
        publishEvent("gate.alert", {
          alertId: inserted.id,
          alertType,
          gateId: "gate-1",
          windowStart: w.windowStart.toISOString(),
          camera: w.camera,
          ultrasonic: w.ultrasonic,
          ir: w.ir,
          simulated: w.simulatedEvents > 0,
        });
        logger.info({ alertId: inserted.id, alertType, windowStart: w.windowStart.toISOString() }, "Gate integrity alert raised");
      }
    }
  }

  return { ran: true, windowsEvaluated: evaluated, alertsCreated };
}

/** Live three-way comparison for the window currently in progress. */
export async function currentWindowSnapshot() {
  const settings = await getSystemSettings();
  const windowMs = settings.gateWindowSeconds * 1000;
  const now = new Date();
  const idx = floorWindow(now, windowMs);
  const windowStart = new Date(idx * windowMs);
  const windowEnd = new Date((idx + 1) * windowMs);

  const windows = await collectWindowCounts({ gateId: "gate-1", rangeStart: windowStart, rangeEnd: now, windowMs });
  const w = windows.get(idx) ?? { windowStart, windowEnd, camera: 0, ultrasonic: 0, ir: 0, simulatedEvents: 0 };
  const verdict = verdictForCounts(w.camera, w.ultrasonic, w.ir, settings.gateDiscrepancyPct);

  return {
    gateId: "gate-1",
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    partialSecondsLeft: Math.max(0, Math.round((windowEnd.getTime() - now.getTime()) / 1000)),
    camera: w.camera,
    ultrasonic: w.ultrasonic,
    ir: w.ir,
    verdict,
    discrepancyPct: settings.gateDiscrepancyPct,
    windowSeconds: settings.gateWindowSeconds,
    withinGateHours: isWithinGateHours(now, settings.gateActiveFrom, settings.gateActiveTo, settings.attendanceTimezone),
    timezone: settings.attendanceTimezone,
    gateActiveFrom: settings.gateActiveFrom,
    gateActiveTo: settings.gateActiveTo,
  };
}

/** Rolling series for the Operations chart: last N minutes of completed windows. */
export async function windowSeries(minutes = 60) {
  const settings = await getSystemSettings();
  const windowMs = settings.gateWindowSeconds * 1000;
  const now = new Date();
  const currentIdx = floorWindow(now, windowMs);
  const span = Math.max(5, Math.min(240, minutes));
  const spanWindows = Math.ceil((span * 60_000) / windowMs);
  const rangeStart = new Date((currentIdx - spanWindows) * windowMs);

  const windows = await collectWindowCounts({ gateId: "gate-1", rangeStart, rangeEnd: now, windowMs });
  const alertRows = await db
    .select({ windowStart: gateIntegrityAlertsTable.windowStart, alertType: gateIntegrityAlertsTable.alertType })
    .from(gateIntegrityAlertsTable)
    .where(and(gte(gateIntegrityAlertsTable.windowStart, rangeStart), lt(gateIntegrityAlertsTable.windowStart, now)));
  const alertsByWindow = new Map<number, string[]>();
  for (const a of alertRows) {
    const idx = floorWindow(a.windowStart, windowMs);
    const list = alertsByWindow.get(idx) ?? [];
    list.push(a.alertType);
    alertsByWindow.set(idx, list);
  }

  const series: Array<{
    windowStart: string;
    windowEnd: string;
    camera: number;
    ultrasonic: number;
    ir: number;
    alerts: string[];
  }> = [];
  for (let i = 1; i <= spanWindows; i++) {
    const idx = currentIdx - spanWindows + i;
    const w = windows.get(idx);
    series.push({
      windowStart: new Date(idx * windowMs).toISOString(),
      windowEnd: new Date((idx + 1) * windowMs).toISOString(),
      camera: w?.camera ?? 0,
      ultrasonic: w?.ultrasonic ?? 0,
      ir: w?.ir ?? 0,
      alerts: alertsByWindow.get(idx) ?? [],
    });
  }
  return { windowSeconds: settings.gateWindowSeconds, discrepancyPct: settings.gateDiscrepancyPct, series };
}

/** Demo mode: inject a clearly-tagged synthetic mismatch for the last COMPLETED window. */
export async function injectSimulatedDiscrepancy(mode: "missed_detections" | "sensor_conflict" = "missed_detections") {
  const now = new Date();
  const gateId = "gate-1";
  const settings = await getSystemSettings();
  const windowMs = settings.gateWindowSeconds * 1000;

  // Target the last completed window so the validator (which only judges
  // closed windows) can raise the alert immediately during a live demo.
  const targetIdx = Math.floor(now.getTime() / windowMs) - 1;
  const targetStartMs = targetIdx * windowMs;
  const at = (offsetMs: number) => new Date(targetStartMs + Math.min(offsetMs, windowMs - 1000));
  const rows: Array<{ gateId: string; sensor: string; occurredAt: Date; simulated: boolean }> = [];

  if (mode === "sensor_conflict") {
    // 4 ultrasonic vs 1 IR → the two sensors disagree with each other
    for (let i = 0; i < 4; i++) rows.push({ gateId, sensor: "ultrasonic", occurredAt: at(i * 1500), simulated: true });
    rows.push({ gateId, sensor: "ir_beam", occurredAt: at(5000), simulated: true });
  } else {
    // 3 ultrasonic + 3 IR while the camera matched nobody extra
    for (let i = 0; i < 3; i++) rows.push({ gateId, sensor: "ultrasonic", occurredAt: at(i * 1500), simulated: true });
    for (let i = 0; i < 3; i++) rows.push({ gateId, sensor: "ir_beam", occurredAt: at(i * 2000), simulated: true });
  }

  await db.insert(gateSensorEventsTable).values(rows);

  // Validate with "now" pinned to the target window's end so it counts as completed.
  const validation = await runGateValidation({ force: true, now: new Date(targetStartMs + windowMs) });
  const alertIds = validation.alertsCreated.map((a) => a.id);
  return { mode, injected: rows.length, windowStart: new Date(targetStartMs).toISOString(), validation, alertIds };
}
