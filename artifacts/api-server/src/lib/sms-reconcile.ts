import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db, smsLogsTable } from "@workspace/db";
import { mapTwilioStatus } from "./sms";
import { logger } from "./logger";
import { publishEvent } from "./events";

/**
 * SMS delivery reconciliation (Phase 6 honesty engine).
 *
 * Twilio accepts message submissions asynchronously: a message can be
 * "accepted" at send time and STILL fail seconds later at the carrier
 * (classic case: 21612 geo-permission block on US → Ethiopia). The status
 * webhook keeps rows fresh when PUBLIC_BASE_URL is reachable, but webhooks
 * can be missed (deployments, restarts, proxy filtering) — this sweep is
 * the safety net: it asks Twilio directly for the verdict of every message
 * that is still pending confirmation.
 */

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/** Rows still needing a verdict: queued for >45s, or sent-but-unconfirmed >2min. */
const PENDING_STATUSES = ["queued", "sent"] as const;
const MIN_AGE_SECONDS = 45;

export interface ReconcileSummary {
  checked: number;
  upgraded: number;
  byStatus: Record<string, number>;
  errors: number;
  geoBlocked: number;
}

interface TwilioMessageView {
  sid: string;
  status: string;
  error_code: number | null;
  error_message: string | null;
}

async function fetchTwilioMessage(sid: string): Promise<TwilioMessageView | null> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(`${TWILIO_API_BASE}/Accounts/${TWILIO_ACCOUNT_SID}/Messages/${sid}.json`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as TwilioMessageView;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask Twilio for the verdict of every message still pending confirmation.
 * @param limit max rows fetched per sweep (default 25)
 * @param minAgeSeconds how old a pending row must be before it is checked
 *   (default 45s — lets the initial Twilio status settle; the post-send
 *   fast pass in lib/sms.ts calls this with ~10s to upgrade quicker).
 */
export async function reconcilePendingSms(limit = 25, minAgeSeconds = MIN_AGE_SECONDS): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, upgraded: 0, byStatus: {}, errors: 0, geoBlocked: 0 };
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return summary;

  const cutoff = new Date(Date.now() - minAgeSeconds * 1000);
  const pending = await db
    .select({
      id: smsLogsTable.id,
      providerSid: smsLogsTable.providerSid,
      status: smsLogsTable.status,
    })
    .from(smsLogsTable)
    .where(and(
      isNotNull(smsLogsTable.providerSid),
      inArray(smsLogsTable.status, [...PENDING_STATUSES]),
      lt(smsLogsTable.sentAt, cutoff),
    ))
    .orderBy(smsLogsTable.sentAt)
    .limit(limit);

  if (!pending.length) return summary;
  summary.checked = pending.length;

  // Parallel fetch (bounded by `limit`): every pending row's Twilio lookup is
  // in flight at once, so a sweep costs ~one call latency instead of
  // limit × latency. Each row's DB write and event publish are independent.
  await Promise.all(pending.map(async (row) => {
    if (!row.providerSid) return;
    const remote = await fetchTwilioMessage(row.providerSid);
    if (!remote) {
      summary.errors += 1;
      return;
    }
    const mapped = mapTwilioStatus(remote.status);
    if (!mapped || mapped === row.status) return;

    const errorCode = remote.error_code != null ? String(remote.error_code) : null;
    await db
      .update(smsLogsTable)
      .set({
        status: mapped,
        errorCode,
        errorMessage: remote.error_message ?? null,
        statusUpdatedAt: new Date(),
      })
      .where(eq(smsLogsTable.id, row.id));

    summary.upgraded += 1;
    summary.byStatus[mapped] = (summary.byStatus[mapped] ?? 0) + 1;
    if (errorCode === "21612") summary.geoBlocked += 1;
    publishEvent("sms.status", {
      logId: row.id,
      providerSid: row.providerSid,
      from: row.status,
      to: mapped,
      errorCode,
    });
    logger.info({ logId: row.id, sid: row.providerSid, from: row.status, to: mapped, errorCode }, "SMS status reconciled");
  }));

  return summary;
}

/** Count of sends still awaiting a carrier verdict (SMS Health card). */
export async function pendingDeliveryCount(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(smsLogsTable)
    .where(and(
      isNotNull(smsLogsTable.providerSid),
      inArray(smsLogsTable.status, ["queued"]),
    ));
  return Number(row?.total ?? 0);
}
