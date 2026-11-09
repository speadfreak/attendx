import { db, systemSettingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export const DEFAULT_SYSTEM_SETTINGS = {
  confidenceThreshold: 0.72,
  reviewRetentionDays: 30,
  fanMode: "auto" as const,
  // ── Phase 4: attendance time rules (admin-controlled) ──────────
  // Arrivals at/before entranceTime (local) → "present".
  // After entranceTime → "late" (a late SMS is queued).
  // Students with NO record once local time passes absenceCutoffTime
  // are marked absent by the sweep.
  entranceTime: "08:00",
  lateCutoffTime: "08:20",
  absenceCutoffTime: "09:30",
  attendanceTimezone: "Africa/Addis_Ababa",
  // ── Phase 4: gate integrity engine ─────────────────────────────
  gateDiscrepancyPct: 10,
  gateWindowSeconds: 60,
  gateActiveFrom: "06:00",
  gateActiveTo: "10:00",
  // ── Phase 5: notification delivery (SMS Health) ─────────────────
  // 'auto' = SMS first, WhatsApp fallback on channel-capable failures
  // (e.g. Twilio 21612 international To/From rejection).
  smsChannelMode: "auto" as const,
  // Preferred sender: a Twilio Messaging Service SID (MG…) beats a raw
  // From number — US long codes direct-dialing Ethiopia get 21612.
  smsMessagingServiceSid: null as string | null,
  smsFromNumber: null as string | null,
  smsDefaultCountry: "+251",
};

export type FanMode = "auto" | "on" | "off";

export function hhmmToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const MESSAGING_SERVICE_SID_RE = /^MG[0-9a-fA-F]{32}$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const COUNTRY_CODE_RE = /^\+[1-9]\d{0,2}$/;

function normalizedTime(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const minutes = hhmmToMinutes(value);
  if (minutes === null) return fallback;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function normalizedPct(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

export async function getSystemSettings() {
  const rows = await db.select().from(systemSettingsTable);
  const values = new Map(rows.map((row) => [row.key, String(row.value)]));
  const confidenceThreshold = Number(values.get("confidenceThreshold") ?? DEFAULT_SYSTEM_SETTINGS.confidenceThreshold);
  const reviewRetentionDays = Number(values.get("reviewRetentionDays") ?? DEFAULT_SYSTEM_SETTINGS.reviewRetentionDays);
  const rawFanMode = values.get("fanMode");
  const fanMode: FanMode = rawFanMode === "on" || rawFanMode === "off" ? rawFanMode : "auto";
  const rawTimezone = values.get("attendanceTimezone") ?? DEFAULT_SYSTEM_SETTINGS.attendanceTimezone;
  const attendanceTimezone = isValidTimezone(rawTimezone) ? rawTimezone : DEFAULT_SYSTEM_SETTINGS.attendanceTimezone;
  // ── SMS delivery settings (Phase 5) ──
  const rawChannelMode = values.get("smsChannelMode");
  const smsChannelMode = rawChannelMode === "whatsapp" || rawChannelMode === "sms" ? rawChannelMode : "auto";
  const rawServiceSid = values.get("smsMessagingServiceSid");
  const smsMessagingServiceSid = rawServiceSid && MESSAGING_SERVICE_SID_RE.test(rawServiceSid) ? rawServiceSid : null;
  const rawFrom = values.get("smsFromNumber");
  const smsFromNumber = rawFrom && E164_RE.test(rawFrom) ? rawFrom : null;
  const rawDefaultCountry = values.get("smsDefaultCountry");
  const smsDefaultCountry = rawDefaultCountry && COUNTRY_CODE_RE.test(rawDefaultCountry) ? rawDefaultCountry : DEFAULT_SYSTEM_SETTINGS.smsDefaultCountry;
  const latestUpdate = rows.reduce<Date | null>(
    (latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest),
    null,
  );

  return {
    confidenceThreshold: Number.isFinite(confidenceThreshold) ? confidenceThreshold : DEFAULT_SYSTEM_SETTINGS.confidenceThreshold,
    reviewRetentionDays: Number.isFinite(reviewRetentionDays) ? reviewRetentionDays : DEFAULT_SYSTEM_SETTINGS.reviewRetentionDays,
    fanMode,
    entranceTime: normalizedTime(values.get("entranceTime"), DEFAULT_SYSTEM_SETTINGS.entranceTime),
    lateCutoffTime: normalizedTime(values.get("lateCutoffTime"), DEFAULT_SYSTEM_SETTINGS.lateCutoffTime),
    absenceCutoffTime: normalizedTime(values.get("absenceCutoffTime"), DEFAULT_SYSTEM_SETTINGS.absenceCutoffTime),
    attendanceTimezone,
    gateDiscrepancyPct: normalizedPct(values.get("gateDiscrepancyPct"), DEFAULT_SYSTEM_SETTINGS.gateDiscrepancyPct, 1, 100),
    gateWindowSeconds: normalizedPct(values.get("gateWindowSeconds"), DEFAULT_SYSTEM_SETTINGS.gateWindowSeconds, 15, 300),
    gateActiveFrom: normalizedTime(values.get("gateActiveFrom"), DEFAULT_SYSTEM_SETTINGS.gateActiveFrom),
    gateActiveTo: normalizedTime(values.get("gateActiveTo"), DEFAULT_SYSTEM_SETTINGS.gateActiveTo),
    smsChannelMode,
    smsMessagingServiceSid,
    smsFromNumber,
    smsDefaultCountry,
    updatedAt: latestUpdate?.toISOString() ?? null,
  };
}

export type SystemSettings = Awaited<ReturnType<typeof getSystemSettings>>;

export async function setSystemSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(systemSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({
      target: systemSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function setSettings(values: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await setSystemSetting(key, value);
  }

  if (values.reviewRetentionDays !== undefined) {
    const days = Number(values.reviewRetentionDays);
    await db.execute(
      sql`
        UPDATE match_reviews
        SET purge_at = reviewed_at + (${days} * INTERVAL '1 day')
        WHERE status = 'rejected' AND reviewed_at IS NOT NULL
      `,
    );
  }
}

export async function settingValue<T>(key: string, fallback: T): Promise<T> {
  const [row] = await db.select({ value: systemSettingsTable.value }).from(systemSettingsTable).where(eq(systemSettingsTable.key, key)).limit(1);
  return (row?.value as T | undefined) ?? fallback;
}
