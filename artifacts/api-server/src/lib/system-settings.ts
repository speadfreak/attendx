import { db, systemSettingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export const DEFAULT_SYSTEM_SETTINGS = {
  confidenceThreshold: 0.72,
  reviewRetentionDays: 30,
  fanMode: "auto" as const,
};

export type FanMode = "auto" | "on" | "off";

export async function getSystemSettings() {
  const rows = await db.select().from(systemSettingsTable);
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const confidenceThreshold = Number(values.get("confidenceThreshold") ?? DEFAULT_SYSTEM_SETTINGS.confidenceThreshold);
  const reviewRetentionDays = Number(values.get("reviewRetentionDays") ?? DEFAULT_SYSTEM_SETTINGS.reviewRetentionDays);
  const rawFanMode = values.get("fanMode");
  const fanMode: FanMode = rawFanMode === "on" || rawFanMode === "off" ? rawFanMode : "auto";
  const latestUpdate = rows.reduce<Date | null>(
    (latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest),
    null,
  );

  return {
    confidenceThreshold: Number.isFinite(confidenceThreshold) ? confidenceThreshold : DEFAULT_SYSTEM_SETTINGS.confidenceThreshold,
    reviewRetentionDays: Number.isFinite(reviewRetentionDays) ? reviewRetentionDays : DEFAULT_SYSTEM_SETTINGS.reviewRetentionDays,
    fanMode,
    updatedAt: latestUpdate?.toISOString() ?? null,
  };
}

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
