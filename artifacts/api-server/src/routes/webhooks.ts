import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { db, smsLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { mapTwilioStatus } from "../lib/sms";
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

export default router;
