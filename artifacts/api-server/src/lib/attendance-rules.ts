/**
 * Phase 4 — Admin-controlled attendance time rules.
 *
 * Replaces the hardcoded "late after 08:15 server time" check (which was
 * silently wrong on Vercel: server time is UTC, so a 10:00 AM Addis Ababa
 * arrival was evaluated as 07:00 UTC → "present").
 *
 * Admins configure (Operations → System Settings):
 *   entranceTime     — arrivals at/before this local time are "present"
 *   lateCutoffTime   — distinguishes late from present; both queue an arrival SMS
 *   absenceCutoffTime — the absent sweep only marks students once local time
 *                       passes this; before it, "no record yet" ≠ absent
 *   attendanceTimezone — IANA zone the school runs on (default Africa/Addis_Ababa)
 */
import { getSystemSettings, hhmmToMinutes, isValidTimezone, type SystemSettings } from "./system-settings";

export interface ArrivalRules {
  timezone: string;
  entranceTime: string;
  lateCutoffTime: string;
  absenceCutoffTime: string;
  entranceMinutes: number;
  lateCutoffMinutes: number;
  absenceCutoffMinutes: number;
}

export function arrivalRulesFromSettings(settings: Pick<SystemSettings, "entranceTime" | "lateCutoffTime" | "absenceCutoffTime" | "attendanceTimezone">): ArrivalRules {
  const entranceMinutes = hhmmToMinutes(settings.entranceTime) ?? 480;
  const lateCutoffMinutes = hhmmToMinutes(settings.lateCutoffTime) ?? 500;
  const absenceCutoffMinutes = hhmmToMinutes(settings.absenceCutoffTime) ?? 570;
  return {
    timezone: isValidTimezone(settings.attendanceTimezone) ? settings.attendanceTimezone : "Africa/Addis_Ababa",
    entranceTime: settings.entranceTime,
    lateCutoffTime: settings.lateCutoffTime,
    absenceCutoffTime: settings.absenceCutoffTime,
    entranceMinutes,
    lateCutoffMinutes,
    absenceCutoffMinutes,
  };
}

export async function getArrivalRules(): Promise<ArrivalRules> {
  return arrivalRulesFromSettings(await getSystemSettings());
}

function tzOffsetMs(at: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - (at.getTime() - (at.getTime() % 1000));
}

/** Minutes since local midnight in the school's timezone at instant `at`. */
export function minutesSinceMidnight(at: Date, timezone: string): number {
  const shifted = new Date(at.getTime() + tzOffsetMs(at, timezone));
  return Math.floor((shifted.getTime() % 86_400_000) / 60_000);
}

/**
 * UTC instants of local midnight and next midnight for the day containing
 * `at` (in the school timezone) — use for "today's attendance" queries.
 */
export function localDayBounds(at: Date, timezone: string): { dayKey: string; startUtc: Date; endUtc: Date } {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayKey = dtf.format(at); // YYYY-MM-DD in the school timezone
  const startUtc = new Date(Date.parse(`${dayKey}T00:00:00Z`) - tzOffsetMs(at, timezone));
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { dayKey, startUtc, endUtc };
}

/** present = at/before entrance time; late = anything after (both queue SMS upstream). */
export function resolveArrivalStatus(at: Date, rules: ArrivalRules): "present" | "late" {
  return minutesSinceMidnight(at, rules.timezone) <= rules.entranceMinutes ? "present" : "late";
}

/** True once the local clock passed absenceCutoffTime — safe to mark no-shows absent. */
export function isPastAbsenceCutoff(at: Date, rules: ArrivalRules): boolean {
  return minutesSinceMidnight(at, rules.timezone) >= rules.absenceCutoffMinutes;
}

/** Human-readable local clock, e.g. "08:15" — for SMS messages and UI. */
export function formatLocalClock(at: Date, timezone: string): string {
  const minutes = minutesSinceMidnight(at, timezone);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
