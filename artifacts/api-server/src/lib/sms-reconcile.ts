import { and, eq, inArray, isNotNull, like, lt, sql } from "drizzle-orm";
import { db, smsLogsTable } from "@workspace/db";
import { mapTwilioStatus, mapTextbeeStatus, normalizePhone, getSmsSenderConfig, textbeeEnabled } from "./sms";
import { logger } from "./logger";
import { publishEvent } from "./events";

/**
 * SMS delivery reconciliation (Phase 6 honesty engine).
 *
 * Gateways accept message submissions asynchronously: a message can be
 * "accepted" at send time and STILL fail seconds later at the radio/carrier
 * (classic cases: Twilio 21612 geo-permission block, or the school gateway
 * phone losing signal mid-send). The status webhooks keep rows fresh when
 * PUBLIC_BASE_URL is reachable, but webhooks can be missed (deployments,
 * restarts, proxy filtering) — this sweep is the safety net: it asks the
 * provider directly for the verdict of every message that is still pending
 * confirmation.
 */

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/** Rows still needing a verdict: queued for >45s, or sent-but-unconfirmed >2min. */
const PENDING_STATUSES = ["queued", "sent"] as const;
const MIN_AGE_SECONDS = 45;

/** TextBee sweep window — recent outgoing messages are fetched in one call. */
const TEXTBEE_LOOKBACK_MS = 30 * 60_000;
const TEXTBEE_FETCH_LIMIT = 50;

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

async function reconcileTwilioRows(summary: ReconcileSummary, cutoff: Date, limit: number): Promise<void> {
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
      // AfroMessage rows (provider "afromessage") have no status-polling REST
      // API — their verdicts arrive exclusively via the DLR callback. Asking
      // Twilio about them would only burn errors, so reconcile is restricted
      // to Twilio-carried rows ("twilio", "twilio:whatsapp").
      like(smsLogsTable.provider, "twilio%"),
    ))
    .orderBy(smsLogsTable.sentAt)
    .limit(limit);

  if (!pending.length) return;
  summary.checked += pending.length;

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
}

// ── TextBee branch ──────────────────────────────────────────────────────

interface TextbeeMessageView {
  _id: string;
  smsBatch?: string | { _id?: string } | null;
  message?: string;
  recipient?: string;
  status?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorName?: string | null;
  createdAt?: string;
}

interface TextbeeIndex {
  /** by textbee message id */
  bySmsId: Map<string, TextbeeMessageView>;
  /** batchId → messages of that batch */
  byBatch: Map<string, TextbeeMessageView[]>;
  /** "recipient|message" → messages (newest first) */
  byRecipientMessage: Map<string, TextbeeMessageView[]>;
}

function batchIdOf(msg: TextbeeMessageView): string | null {
  if (!msg.smsBatch) return null;
  if (typeof msg.smsBatch === "string") return msg.smsBatch;
  return msg.smsBatch._id ?? null;
}

function indexTextbeeMessages(messages: TextbeeMessageView[]): TextbeeIndex {
  const index: TextbeeIndex = { bySmsId: new Map(), byBatch: new Map(), byRecipientMessage: new Map() };
  for (const msg of messages) {
    index.bySmsId.set(msg._id, msg);
    const batch = batchIdOf(msg);
    if (batch) {
      const bucket = index.byBatch.get(batch) ?? [];
      bucket.push(msg);
      index.byBatch.set(batch, bucket);
    }
    const key = `${msg.recipient ?? ""}|${msg.message ?? ""}`;
    const rmBucket = index.byRecipientMessage.get(key) ?? [];
    rmBucket.push(msg);
    index.byRecipientMessage.set(key, rmBucket);
  }
  return index;
}

async function fetchTextbeeMessages(cutoffIso: string): Promise<TextbeeMessageView[] | null> {
  const { TEXTBEE_API_KEY, TEXTBEE_BASE_URL } = await import("./sms");
  if (!TEXTBEE_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const qs = new URLSearchParams({
      direction: "sent",
      order: "desc",
      limit: String(TEXTBEE_FETCH_LIMIT),
      from: cutoffIso,
    });
    const res = await fetch(`${TEXTBEE_BASE_URL}/gateway/messages?${qs.toString()}`, {
      headers: { "x-api-key": TEXTBEE_API_KEY, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: TextbeeMessageView[] };
    return body.data ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function reconcileTextbeeRows(summary: ReconcileSummary, cutoff: Date, limit: number): Promise<void> {
  // Unlike Twilio (exact sid → message), textbee's immediate send path does
  // not expose the sms id — so pending rows may have providerSid null and are
  // matched by recipient + message + recency. Once matched, providerSid is
  // upgraded to `tbsms:<id>` for precise webhook matching from then on.
  const pending = await db
    .select({
      id: smsLogsTable.id,
      providerSid: smsLogsTable.providerSid,
      status: smsLogsTable.status,
      parentPhone: smsLogsTable.parentPhone,
      message: smsLogsTable.message,
    })
    .from(smsLogsTable)
    .where(and(
      inArray(smsLogsTable.status, [...PENDING_STATUSES]),
      lt(smsLogsTable.sentAt, cutoff),
      like(smsLogsTable.provider, "textbee%"),
    ))
    .orderBy(smsLogsTable.sentAt)
    .limit(limit);

  if (!pending.length) return;
  summary.checked += pending.length;

  const messages = await fetchTextbeeMessages(new Date(Date.now() - TEXTBEE_LOOKBACK_MS).toISOString());
  if (!messages) {
    // Gateway API unreachable — don't count every row as an error; one sweep
    // error is enough signal for the health card.
    summary.errors += 1;
    return;
  }
  const index = indexTextbeeMessages(messages);

  const { defaultCountry } = await getSmsSenderConfig();

  await Promise.all(pending.map(async (row) => {
    let match: TextbeeMessageView | undefined;

    if (row.providerSid?.startsWith("tbsms:")) {
      match = index.bySmsId.get(row.providerSid.slice("tbsms:".length));
    } else if (row.providerSid?.startsWith("tbbatch:")) {
      const batch = row.providerSid.slice("tbbatch:".length);
      // One recipient per AttendX send — pick the batch message for this row.
      const recipients = new Set(
        [row.parentPhone, normalizePhone(row.parentPhone, defaultCountry)].filter((v): v is string => !!v),
      );
      match = (index.byBatch.get(batch) ?? []).find((m) => (m.recipient ? recipients.has(m.recipient) : false));
    } else {
      // Immediate-path row: match by recipient + exact message body.
      const recipient = normalizePhone(row.parentPhone, defaultCountry);
      if (recipient) {
        const candidates = index.byRecipientMessage.get(`${recipient}|${row.message}`);
        match = candidates?.[0];
      }
    }

    if (!match) return;
    const mapped = mapTextbeeStatus(match.status ?? "");
    const sid = `tbsms:${match._id}`;
    if (!mapped || (mapped === row.status && row.providerSid === sid)) return;

    await db
      .update(smsLogsTable)
      .set({
        status: mapped,
        errorCode: match.errorCode ?? null,
        errorMessage: match.errorMessage ?? null,
        statusUpdatedAt: new Date(),
        // Upgrade to the precise message id so webhooks match exactly.
        providerSid: sid,
      })
      .where(eq(smsLogsTable.id, row.id));

    summary.upgraded += 1;
    summary.byStatus[mapped] = (summary.byStatus[mapped] ?? 0) + 1;
    publishEvent("sms.status", {
      logId: row.id,
      providerSid: sid,
      from: row.status,
      to: mapped,
      errorCode: match.errorCode ?? null,
    });
    logger.info({ logId: row.id, smsId: match._id, from: row.status, to: mapped, errorCode: match.errorCode }, "TextBee SMS status reconciled");
  }));
}

/**
 * Ask the active gateways for the verdict of every message still pending
 * confirmation.
 * @param limit max rows fetched per sweep (default 25)
 * @param minAgeSeconds how old a pending row must be before it is checked
 *   (default 45s — lets the initial status settle; the post-send
 *   fast pass in lib/sms.ts calls this with ~10s to upgrade quicker).
 */
export async function reconcilePendingSms(limit = 25, minAgeSeconds = MIN_AGE_SECONDS): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, upgraded: 0, byStatus: {}, errors: 0, geoBlocked: 0 };
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000);

  const tasks: Array<Promise<void>> = [];
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    tasks.push(reconcileTwilioRows(summary, cutoff, limit).catch((err) => {
      logger.warn({ err }, "twilio reconcile branch failed");
      summary.errors += 1;
    }));
  }
  if (textbeeEnabled()) {
    tasks.push(reconcileTextbeeRows(summary, cutoff, limit).catch((err) => {
      logger.warn({ err }, "textbee reconcile branch failed");
      summary.errors += 1;
    }));
  }
  await Promise.all(tasks);
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
