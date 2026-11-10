import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod/v4";
import { requireAuth, requireAdminLevel } from "../lib/auth";
import { getSmsSenderConfig, normalizePhone, twilioEnabled, twilioSend, afroMessageEnabled, afroIdentifierId, afroSend, textbeeEnabled, textbeeSend, textbeeListDevices, textbeeWebhookUrl, ensureTextbeeWebhook, getTextbeeSigningSecret, activeSmsProvider, SmsDeliveryError, describeSmsProviderCode, invalidateSmsSettingsCache, TWILIO_WHATSAPP_FROM, PUBLIC_BASE_URL } from "../lib/sms";
import { runSmsDiagnostics, getTwilioCarrierStatus, type TwilioCarrierStatus } from "../lib/sms-diagnostics";
import { reconcilePendingSms, pendingDeliveryCount } from "../lib/sms-reconcile";
import { writeAudit } from "../lib/audit";

const router = Router();
const adminId = (req: Request) => (req as Request & { admin?: { adminId: number } }).admin?.adminId;

/** Identifier IDs are semi-sensitive — mask the middle for display. */
function maskIdentifier(id: string | null): string | null {
  if (!id) return null;
  return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/** Lightweight status for any signed-in admin/teacher — powers header badges. */
router.get("/sms/config-status", requireAuth, async (_req, res): Promise<void> => {
  const config = await getSmsSenderConfig();
  // Carrier facts (trial detection) ride along — cached 5 min server-side,
  // failures degrade to nulls so this endpoint never breaks the header.
  const carrier: TwilioCarrierStatus = await getTwilioCarrierStatus(
    !!config.messagingServiceSid,
    config.fromNumber,
  );
  res.json({
    // Phase 6.4: which gateway actually carries outbound SMS now.
    provider: activeSmsProvider(),
    twilioEnabled: twilioEnabled(),
    afroEnabled: afroMessageEnabled(),
    textbeeEnabled: textbeeEnabled(),
    afro: {
      enabled: afroMessageEnabled(),
      identifierId: maskIdentifier(afroIdentifierId()),
      senderName: config.afroSenderName,
      callbackConfigured: !!PUBLIC_BASE_URL,
    },
    textbee: {
      enabled: textbeeEnabled(),
      webhookUrl: textbeeWebhookUrl(),
      webhookSecretConfigured: !!(await getTextbeeSigningSecret()),
      // Device facts come from the live API when diagnostics run; keep this
      // endpoint dependency-free (it powers the header badge on every page).
    },
    channelMode: config.channelMode,
    hasMessagingService: !!config.messagingServiceSid,
    hasFromNumber: !!config.fromNumber,
    messagingServiceSid: config.messagingServiceSid,
    fromNumber: config.fromNumber,
    whatsappOptIn: !!TWILIO_WHATSAPP_FROM,
    carrier,
  });
});

/** Full live diagnostics against the Twilio API (super_admin/admin only). */
router.get("/sms/diagnostics", requireAdminLevel, async (_req, res): Promise<void> => {
  const diagnostics = await runSmsDiagnostics();
  // Phase 6: pending-delivery count rides along so the SMS Health card and
  // admin tooling see local queue truth next to the live Twilio probe.
  // `carrier` explains WHY sends fail (trial account vs geo permissions vs
  // messaging service) — cached 5 min, nulls on any Twilio failure.
  const carrier = await getTwilioCarrierStatus(
    !!diagnostics.sender.messagingServiceSid,
    diagnostics.sender.fromNumber,
  );
  res.json({ ...diagnostics, pendingDelivery: await pendingDeliveryCount(), carrier });
});

/**
 * On-demand "check with carrier now" — runs the same reconcile sweep as the
 * throttled background middleware and returns its summary, so the SMS Logs
 * page can force-refresh statuses without waiting for the next request
 * cycle. Same auth as GET /sms-logs (any staff member can read logs).
 */
router.post("/sms/reconcile", requireAuth, async (req, res): Promise<void> => {
  const summary = await reconcilePendingSms();
  await writeAudit({
    actorAdminId: adminId(req),
    action: "sms.reconcile",
    targetType: "sms",
    targetId: null,
    payload: { checked: summary.checked, upgraded: summary.upgraded, errors: summary.errors },
  });
  res.json(summary);
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
  const provider = activeSmsProvider();

  const attempts: Array<{ channel: string; ok: boolean; error: { message: string; code: string | null; fix: string | null } | null }> = [];
  let lastError: SmsDeliveryError | null = null;
  let senderBlock: Record<string, unknown>;

  if (provider === "textbee") {
    // Android-SIM gateway: single SMS attempt; verdicts arrive async.
    const devices = await textbeeListDevices().catch(() => null);
    const device = devices?.find((d) => d.enabled) ?? devices?.[0] ?? null;
    senderBlock = {
      via: "textbee",
      messagingServiceSid: null,
      fromNumber: null,
      device: device ? { id: device._id, name: device.name, model: device.model, enabled: device.enabled } : null,
    };
    if (!device) {
      attempts.push({
        channel: "sms",
        ok: false,
        error: {
          message: "No textbee gateway phone is reachable.",
          code: "tb-device",
          fix: "Open the textbee app on the school Android phone, sign in, keep it online and Enabled — then retry.",
        },
      });
      lastError = new SmsDeliveryError("No enabled textbee device found", { provider: "textbee", code: "tb-device", retryable: true });
    } else {
      try {
        await textbeeSend({ to, body: message });
        attempts.push({ channel: "sms", ok: true, error: null });
        // The subscription may not exist yet on a fresh deployment — kick it
        // (repair/create) so delivery verdicts start flowing to this URL.
        void ensureTextbeeWebhook().catch(() => {});
      } catch (err) {
        const delivery = err instanceof SmsDeliveryError ? err : new SmsDeliveryError(err instanceof Error ? err.message : String(err), { provider: "textbee" });
        attempts.push({
          channel: "sms",
          ok: false,
          error: { message: delivery.message, code: delivery.code, fix: delivery.fix },
        });
        lastError = delivery;
      }
    }
  } else if (provider === "afromessage") {
    // Ethiopia-native gateway: single SMS attempt, synchronous ack.
    senderBlock = {
      via: "afromessage",
      messagingServiceSid: null,
      fromNumber: null,
      afroSenderName: config.afroSenderName,
      identifierId: maskIdentifier(afroIdentifierId()),
    };
    try {
      await afroSend({ to, body: message, senderName: config.afroSenderName, identifierId: afroIdentifierId() });
      attempts.push({ channel: "sms", ok: true, error: null });
    } catch (err) {
      const delivery = err instanceof SmsDeliveryError ? err : new SmsDeliveryError(err instanceof Error ? err.message : String(err), { provider: "afromessage" });
      attempts.push({
        channel: "sms",
        ok: false,
        error: { message: delivery.message, code: delivery.code, fix: delivery.fix },
      });
      lastError = delivery;
    }
  } else if (provider === "simulation") {
    senderBlock = { via: "simulation", messagingServiceSid: null, fromNumber: null };
    attempts.push({ channel: "sms", ok: true, error: null });
  } else {
    // Twilio: mirror the production channel gate — WhatsApp only on opt-in.
    const channels: Array<"sms" | "whatsapp"> = channel
      ? [channel]
      : config.channelMode === "whatsapp"
        ? ["whatsapp"]
        : config.channelMode === "auto" && TWILIO_WHATSAPP_FROM
          ? ["sms", "whatsapp"]
          : ["sms"];
    senderBlock = {
      via: config.messagingServiceSid ? "messaging-service" : "from-number",
      messagingServiceSid: config.messagingServiceSid,
      fromNumber: config.fromNumber,
    };

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
    provider,
    normalizedTo: to,
    sender: senderBlock,
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
