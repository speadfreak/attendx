import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { db, smsLogsTable } from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import { mapAfroStatus, mapTwilioStatus, AFROMESSAGE_CALLBACK_SECRET } from "../lib/sms";
import { logger } from "../lib/logger";
import { publishEvent } from "../lib/events";

/**
 * Twilio status callback webhook (Phase 6 delivery honesty engine).
 *
 * When PUBLIC_BASE_URL is configured, every outbound message carries
 * StatusCallback = {PUBLIC_BASE_URL}/api/webhooks/twilio/status. Twilio then
 * POSTs (application/x-www-form-urlencoded) the real carrier verdict here:
 *
 *   MessageSid=SM…  MessageStatus=delivered|sent|undelivered|failed
 *   ErrorCode=21612 (only on failure)  ErrorMessage="…" (only on failure)
 *
 * This is what upgrades sms_logs from "queued" to the truth — including the
 * async 21612 geo-permission failures that made the old UI claim "sent" for
 * messages that never reached a phone.
 *
 * Security: when TWILIO_AUTH_TOKEN is configured, the X-Twilio-Signature
 * header (HMAC-SHA1 over URL + sorted form params, signed with the Auth
 * Token) is mandatory — requests without a valid signature are rejected
 * with 403. When no token is configured (dev / simulated mode) unsigned
 * calls are accepted and logged, so local flows keep working.
 */

const router = Router();

function validTwilioSignature(req: Request): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.header("x-twilio-signature");
  if (!token) return false;
  if (!signature) return false; // header absent → caller rejects with 403 when enforcing

  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const params = Object.keys(req.body ?? {}).sort();
  const data = url + params.map((k) => `${k}${req.body[k]}`).join("");
  const expected = createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Status transitions that are allowed to move forward (never regress). */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 3,
  undelivered: 2,
  failed: 2,
};

router.post("/webhooks/twilio/status", (req: Request, res: Response): void => {
  const signatureEnforced = Boolean(process.env.TWILIO_AUTH_TOKEN);

  // Fail-closed when the auth token is configured; fail-open (dev/simulated
  // mode) only when it is not. The payload itself stays unguessable either
  // way (MessageSid lookup + monotonic status flow).
  if (signatureEnforced && !validTwilioSignature(req)) {
    logger.warn(
      { hasSignatureHeader: !!req.header("x-twilio-signature") },
      "twilio status webhook: rejected (missing/invalid X-Twilio-Signature)",
    );
    res.status(403).json({ ok: false, error: "invalid signature" });
    return;
  }
  if (!signatureEnforced) {
    logger.warn("twilio status webhook: TWILIO_AUTH_TOKEN not configured — accepting unsigned call (dev/simulated mode)");
  }

  const body = (req.body ?? {}) as Record<string, string | undefined>;
  const messageSid = body.MessageSid ?? body.SmsSid ?? null;
  const messageStatus = body.MessageStatus ?? body.SmsStatus ?? null;
  const errorCode = body.ErrorCode != null ? String(body.ErrorCode) : null;
  const errorMessage = body.ErrorMessage ?? null;

  if (!messageSid || !messageStatus) {
    // Twilio retries on non-2xx; acknowledge malformed pings politely.
    logger.warn({ hasSid: !!messageSid }, "twilio status webhook: missing fields");
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  // Past this point the call is either signature-verified (token configured)
  // or accepted in dev/simulated mode (no token configured).

  void (async () => {
    try {
      const [row] = await db
        .select({ id: smsLogsTable.id, status: smsLogsTable.status })
        .from(smsLogsTable)
        .where(eq(smsLogsTable.providerSid, messageSid))
        .limit(1);

      const mapped = mapTwilioStatus(messageStatus);
      if (!row || !mapped) {
        logger.info({ messageSid, messageStatus, known: !!row }, "twilio status webhook: nothing to update");
        return;
      }

      const currentRank = STATUS_RANK[row.status] ?? 0;
      const nextRank = STATUS_RANK[mapped] ?? 0;
      if (nextRank < currentRank) {
        logger.info({ logId: row.id, from: row.status, to: mapped }, "twilio status webhook: ignored regressive status");
        return;
      }

      await db
        .update(smsLogsTable)
        .set({
          status: mapped,
          errorCode,
          errorMessage,
          statusUpdatedAt: new Date(),
        })
        .where(eq(smsLogsTable.id, row.id));

      publishEvent("sms.status", {
        logId: row.id,
        providerSid: messageSid,
        from: row.status,
        to: mapped,
        errorCode,
      });
      logger.info({ logId: row.id, messageSid, from: row.status, to: mapped, errorCode }, "SMS status updated via webhook");
    } catch (err) {
      logger.error({ err, messageSid }, "twilio status webhook: update failed");
    }
  })();

  // Respond immediately — Twilio expects a fast 2xx and retries otherwise.
  res.status(200).json({ ok: true });
});

/**
 * AfroMessage delivery-status callback (Phase 6.3 Ethiopia gateway).
 *
 * When PUBLIC_BASE_URL is configured, every AfroMessage send carries
 * callback = {PUBLIC_BASE_URL}/api/webhooks/afromessage/status — a GET
 * endpoint per AfroMessage's docs ("The callback URL to receive SMS send
 * progress. Should be a GET endpoint"). A POST twin is registered too so
 * alternate callback configurations still land.
 *
 * AfroMessage does not document the exact query/body field names, so the
 * handler tolerantly probes the usual suspects:
 *   message id:  message_id | messageId | id | sid
 *   status:      status | state | delivery_status | messageStatus | message_status
 * Unrecognized payloads are acknowledged with 200 (no retry storms) and
 * logged for diagnosis. When AFROMESSAGE_CALLBACK_SECRET is set, every call
 * must carry the matching ?token=… (the same secret the send path appends).
 */
function validAfroCallbackToken(req: Request): boolean {
  if (!AFROMESSAGE_CALLBACK_SECRET) return true; // no secret configured → accept (dev mode)
  const provided = req.query.token ?? req.query.secret ?? (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>).token : undefined);
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(AFROMESSAGE_CALLBACK_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

const AFRO_ID_KEYS = ["message_id", "messageId", "messageID", "id", "sid"] as const;
const AFRO_STATUS_KEYS = ["status", "state", "delivery_status", "deliveryStatus", "messageStatus", "message_status", "MessageStatus"] as const;

async function handleAfroStatus(req: Request, res: Response): Promise<void> {
  if (!validAfroCallbackToken(req)) {
    logger.warn("afromessage status webhook: rejected (missing/invalid token param)");
    res.status(403).json({ ok: false, error: "invalid token" });
    return;
  }

  // Merge query params and JSON body — the callback may arrive either way.
  const fields: Record<string, unknown> = {
    ...(req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {}),
    ...req.query,
  };

  const messageId = AFRO_ID_KEYS.map((k) => fields[k]).find((v) => typeof v === "string" && v.length > 0) as string | undefined;
  const statusRaw = AFRO_STATUS_KEYS.map((k) => fields[k]).find((v) => typeof v === "string" && v.length > 0) as string | undefined;

  if (!messageId || !statusRaw) {
    logger.info({ keys: Object.keys(fields) }, "afromessage status webhook: unrecognized payload (acknowledged)");
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  const mapped = mapAfroStatus(statusRaw);
  if (!mapped) {
    logger.info({ messageId, statusRaw }, "afromessage status webhook: unknown status (acknowledged)");
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  try {
    const [row] = await db
      .select({ id: smsLogsTable.id, status: smsLogsTable.status })
      .from(smsLogsTable)
      .where(and(eq(smsLogsTable.providerSid, messageId), like(smsLogsTable.provider, "afromessage%")))
      .limit(1);

    if (!row) {
      logger.info({ messageId, mapped }, "afromessage status webhook: no matching AfroMessage log row");
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const currentRank = STATUS_RANK[row.status] ?? 0;
    const nextRank = STATUS_RANK[mapped] ?? 0;
    if (nextRank < currentRank) {
      logger.info({ logId: row.id, from: row.status, to: mapped }, "afromessage status webhook: ignored regressive status");
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    await db
      .update(smsLogsTable)
      .set({ status: mapped, statusUpdatedAt: new Date() })
      .where(eq(smsLogsTable.id, row.id));

    publishEvent("sms.status", {
      logId: row.id,
      providerSid: messageId,
      from: row.status,
      to: mapped,
      errorCode: null,
    });
    logger.info({ logId: row.id, messageId, from: row.status, to: mapped }, "SMS status updated via AfroMessage callback");
  } catch (err) {
    logger.error({ err, messageId }, "afromessage status webhook: update failed");
  }

  res.status(200).json({ ok: true });
}

router.get("/webhooks/afromessage/status", (req: Request, res: Response): void => {
  void handleAfroStatus(req, res);
});
router.post("/webhooks/afromessage/status", (req: Request, res: Response): void => {
  void handleAfroStatus(req, res);
});

export default router;
