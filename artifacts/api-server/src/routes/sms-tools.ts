import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod/v4";
import { requireAuth, requireAdminLevel } from "../lib/auth";
import { getSmsSenderConfig, normalizePhone, twilioEnabled, twilioSend, SmsDeliveryError, describeSmsProviderCode, invalidateSmsSettingsCache } from "../lib/sms";
import { runSmsDiagnostics, type SmsDiagnostics } from "../lib/sms-diagnostics";
import { writeAudit } from "../lib/audit";

const router = Router();
const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId;

/** Lightweight status for any signed-in admin/teacher — powers header badges. */
router.get("/sms/config-status", requireAuth, async (_req, res): Promise<void> => {
  const config = await getSmsSenderConfig();
  res.json({
    twilioEnabled: twilioEnabled(),
    channelMode: config.channelMode,
    hasMessagingService: !!config.messagingServiceSid,
    hasFromNumber: !!config.fromNumber,
    messagingServiceSid: config.messagingServiceSid,
    fromNumber: config.fromNumber,
  });
});

/** Full live diagnostics against the Twilio API (super_admin/admin only). */
router.get("/sms/diagnostics", requireAdminLevel, async (_req, res): Promise<void> => {
  const diagnostics: SmsDiagnostics = await runSmsDiagnostics();
  res.json(diagnostics);
});

const testSendInput = z.object({
  to: z.string().trim().min(6).max(24),
  body: z.string().trim().min(1).max(320).optional(),
  channel: z.enum(["sms", "whatsapp"]).optional(),
});

/**
 * Fire a real test notification. Runs the exact production send path
 * (normalization → sender resolution → channel strategy) and returns the
 * full provider error + actionable fix when it fails. Does not touch
 * sms_logs (no student is involved); the attempt is audit-logged instead.
 */
router.post("/sms/test-send", requireAdminLevel, async (req, res): Promise<void> => {
  const parsed = testSendInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { to: rawTo, body, channel } = parsed.data;
  const config = await getSmsSenderConfig(true); // bypass cache: admin may have just saved settings
  const to = normalizePhone(rawTo, config.defaultCountry);
  if (!to) {
    res.status(400).json({
      ok: false,
      error: `"${rawTo}" is not a valid phone number (with default country ${config.defaultCountry}).`,
    });
    return;
  }
  const message = body ?? "AttendX test notification — SMS delivery is working. 🎉";
  const channels: Array<"sms" | "whatsapp"> = channel ? [channel] : config.channelMode === "auto" ? ["sms", "whatsapp"] : [config.channelMode];

  const attempts: Array<{ channel: string; ok: boolean; error: { message: string; code: string | null; fix: string | null } | null }> = [];
  let lastError: SmsDeliveryError | null = null;

  for (const ch of channels) {
    try {
      await twilioSend({
        to,
        body: message,
        channel: ch,
        messagingServiceSid: config.messagingServiceSid,
        fromNumber: config.fromNumber,
      });
      attempts.push({ channel: ch, ok: true, error: null });
      lastError = null;
      break;
    } catch (err) {
      const delivery = err instanceof SmsDeliveryError ? err : new SmsDeliveryError(err instanceof Error ? err.message : String(err));
      const hint = describeSmsProviderCode(delivery.code);
      attempts.push({
        channel: ch,
        ok: false,
        error: { message: delivery.message, code: delivery.code, fix: delivery.fix ?? hint?.fix ?? null },
      });
      lastError = delivery;
    }
  }

  await writeAudit({
    actorAdminId: adminId(req),
    action: "sms.test_send",
    targetType: "sms",
    targetId: null,
    payload: { to, channels: attempts.map((a) => a.channel), success: attempts.some((a) => a.ok) },
  });

  const succeeded = attempts.some((a) => a.ok);
  res.status(succeeded ? 200 : 502).json({
    ok: succeeded,
    normalizedTo: to,
    sender: {
      via: config.messagingServiceSid ? "messaging-service" : "from-number",
      messagingServiceSid: config.messagingServiceSid,
      fromNumber: config.fromNumber,
    },
    attempts,
    error: lastError && !succeeded
      ? { message: lastError.message, code: lastError.code, fix: lastError.fix }
      : null,
  });
});

/** Force-refresh the cached sender config after settings changes. */
router.post("/sms/refresh-config", requireAdminLevel, async (_req, res): Promise<void> => {
  invalidateSmsSettingsCache();
  res.json({ ok: true, ...(await getSmsSenderConfig(true)) });
});

export default router;
