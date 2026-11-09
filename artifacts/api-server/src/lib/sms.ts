import { db, smsLogsTable } from "@workspace/db";
import { logger } from "./logger";
import { getSystemSettings } from "./system-settings";

// ── Twilio credentials — env only, never stored in the database ──
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_ENV = process.env.TWILIO_FROM_NUMBER;
const TWILIO_MESSAGING_SERVICE_ENV = process.env.TWILIO_MESSAGING_SERVICE_SID;

/**
 * Public base URL of this deployment (e.g. https://attendx.vercel.app).
 * When set, every send carries a StatusCallback so Twilio pushes the real
 * carrier verdict (sent/delivered/undelivered/failed + error code) back to
 * /api/webhooks/twilio/status — this is what keeps sms_logs honest after
 * the async submission accepts a message that later fails (the 21612 trap).
 */
export const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ??
  process.env.TWILIO_STATUS_CALLBACK_BASE ??
  ""
).replace(/\/$/, "");

export type SmsChannelMode = "sms" | "whatsapp" | "auto";
export type SmsChannel = "sms" | "whatsapp";

export function twilioEnabled(): boolean {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
}

/**
 * Resolve the sender configuration for outgoing notifications.
 * Priority: DB settings (admin-editable in Operations) → env vars.
 * A Messaging Service SID is strongly preferred over a raw From number:
 * US/CA long codes used as a direct `From` get Twilio 21612 on many
 * international destinations (e.g. Ethiopia), while the Messaging
 * Service handles international routing and sender selection.
 */
export interface SmsSenderConfig {
  channelMode: SmsChannelMode;
  messagingServiceSid: string | null;
  fromNumber: string | null;
  defaultCountry: string;
}

let settingsCache: { value: SmsSenderConfig; at: number } | null = null;
const SETTINGS_TTL_MS = 30_000;

export function invalidateSmsSettingsCache(): void {
  settingsCache = null;
}

export async function getSmsSenderConfig(forceFresh = false): Promise<SmsSenderConfig> {
  if (!forceFresh && settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
    return settingsCache.value;
  }
  let channelMode: SmsChannelMode = "auto";
  let messagingServiceSid: string | null = TWILIO_MESSAGING_SERVICE_ENV ?? null;
  let fromNumber: string | null = TWILIO_FROM_ENV ?? null;
  let defaultCountry = "+251";
  try {
    const settings = await getSystemSettings();
    const storedMode: unknown = settings.smsChannelMode;
    if (storedMode === "sms" || storedMode === "whatsapp") channelMode = storedMode;
    if (settings.smsMessagingServiceSid) messagingServiceSid = settings.smsMessagingServiceSid;
    if (settings.smsFromNumber) fromNumber = settings.smsFromNumber;
    if (settings.smsDefaultCountry) defaultCountry = settings.smsDefaultCountry;
  } catch (err) {
    logger.warn({ err }, "SMS settings unavailable — falling back to env defaults");
  }
  const value: SmsSenderConfig = {
    channelMode,
    messagingServiceSid: messagingServiceSid ?? null,
    fromNumber: fromNumber ?? null,
    defaultCountry,
  };
  settingsCache = { value, at: Date.now() };
  return value;
}

/**
 * Normalize any reasonable phone input into strict E.164.
 * Handles: spaces/dashes/parentheses, `00` international prefix, local
 * Ethiopian formats (`09…` / `9…` / `07…` / `7…`) against a configurable
 * default country code, and already-international `+…` numbers.
 * Returns null when the result can't be a valid E.164 number.
 */
export function normalizePhone(raw: string, defaultCountry = "+251"): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/[\s\-().]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (digits.startsWith("+")) {
    const rest = digits.slice(1);
    return /^\d{7,15}$/.test(rest) ? digits : null;
  }
  const cc = defaultCountry.startsWith("+") ? defaultCountry : `+${defaultCountry}`;
  // Local trunk formats: leading 0 (0912… / 0712…) or bare national number (912…)
  const national = digits.startsWith("0") ? digits.slice(1) : digits;
  if (!/^\d{7,14}$/.test(national)) return null;
  return `${cc}${national}`;
}

/**
 * Delivery failure with provider detail + an actionable fix hint.
 * `retryable` distinguishes transient problems (network, 5xx, rate limits)
 * from configuration faults (20003 bad auth token, 21612 To/From combination)
 * so the job runner never burns retries on a misconfigured account.
 * `channelSwitchable` marks failures a WhatsApp fallback could plausibly beat.
 */
export class SmsDeliveryError extends Error {
  readonly provider: string;
  readonly code: string | null;
  readonly retryable: boolean;
  readonly channelSwitchable: boolean;
  readonly fix: string | null;

  constructor(
    message: string,
    options: {
      provider?: string;
      code?: string | null;
      retryable?: boolean;
      channelSwitchable?: boolean;
      fix?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "SmsDeliveryError";
    this.provider = options.provider ?? "twilio";
    this.code = options.code ?? null;
    this.retryable = options.retryable ?? false;
    this.channelSwitchable = options.channelSwitchable ?? false;
    this.fix = options.fix ?? null;
  }
}

interface TwilioErrorBody {
  code?: number;
  message?: string;
  more_info?: string;
  status?: number;
}

interface SmsErrorHint {
  title: string;
  fix: string;
  retryable: boolean;
  channelSwitchable: boolean;
}

/**
 * Actionable, human-readable guidance for the Twilio error codes AttendX
 * actually sees in production. Shown verbatim in job errors, the SMS Health
 * card and test-send results so admins can self-serve the fix.
 */
export function describeSmsProviderCode(code: string | null): SmsErrorHint | null {
  switch (code) {
    case "20003":
      return {
        title: "Twilio authentication failed",
        fix: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN env vars are wrong. Copy them again from the Twilio console → Account Info.",
        retryable: false,
        channelSwitchable: false,
      };
    case "20429":
    case "429":
      return {
        title: "Twilio rate limit hit",
        fix: "Too many requests too fast. AttendX requeues these automatically — no action needed.",
        retryable: true,
        channelSwitchable: false,
      };
    case "21211":
      return {
        title: "Invalid 'To' phone number",
        fix: "The parent phone is not a valid E.164 number. AttendX normalizes local formats — check the stored value (e.g. +251912345678).",
        retryable: false,
        channelSwitchable: false,
      };
    case "21212":
      return {
        title: "Invalid 'From' phone number",
        fix: "The configured sender number is malformed. Set TWILIO_FROM_NUMBER or the smsFromNumber setting in E.164 format.",
        retryable: false,
        channelSwitchable: false,
      };
    case "21408":
      return {
        title: "Sending not permitted from this region",
        fix: "Your Twilio account/number lacks permission for this destination. Use a Messaging Service (recommended) or contact Twilio support to unlock the corridor.",
        retryable: false,
        channelSwitchable: true,
      };
    case "21606":
      return {
        title: "Sender ('From') not valid for this message",
        fix: "The From number can't send this message type. Prefer a Messaging Service so Twilio picks a capable sender.",
        retryable: false,
        channelSwitchable: true,
      };
    case "21608":
      return {
        title: "Unverified destination (trial account)",
        fix: "On a Twilio trial you can only send to verified numbers. Verify the parent number in the Twilio console or upgrade the account.",
        retryable: false,
        channelSwitchable: true,
      };
    case "21610":
      return {
        title: "Recipient replied STOP (unsubscribed)",
        fix: "The parent opted out. Remove/fix the number or have the parent text START to the sender to re-subscribe.",
        retryable: false,
        channelSwitchable: false,
      };
    case "21612":
      return {
        title: "Geo-permission block: this corridor is disabled on your Twilio account",
        fix: "VERIFIED LIVE: even a Messaging Service does NOT bypass this. One-time 30-second fix: Twilio Console → Messaging → Settings → Geo Permissions → enable Ethiopia (ET) — https://console.twilio.com/us1/develop/sms/settings/geo-permissions . Also confirm the destination number is a verified caller ID while on a trial account. No code change is needed — AttendX retries nothing here because Twilio rejects the route itself.",
        retryable: false,
        channelSwitchable: true,
      };
    case "21614":
      return {
        title: "Invalid destination number for channel",
        fix: "The 'To' number is not valid on this channel (e.g. not a mobile / not WhatsApp-registered). Check the parent phone value.",
        retryable: false,
        channelSwitchable: true,
      };
    case "63016":
      return {
        title: "WhatsApp requires an approved template",
        fix: "Business-initiated WhatsApp messages outside a 24h session must use a pre-approved template. Create one in the Twilio console (WhatsApp templates) and set its SID, or have parents message the WhatsApp number first.",
        retryable: false,
        channelSwitchable: false,
      };
    case "63003":
      return {
        title: "WhatsApp channel rate limit",
        fix: "WhatsApp throughput exceeded. AttendX requeues automatically — no action needed.",
        retryable: true,
        channelSwitchable: false,
      };
    case "63007":
      return {
        title: "Number not enabled for WhatsApp",
        fix: "The sender is not a WhatsApp-enabled Twilio sender. Enable WhatsApp on your number/Messaging Service in the Twilio console, or keep channel mode on 'sms'.",
        retryable: false,
        channelSwitchable: false,
      };
    default:
      return null;
  }
}

export interface TwilioSendResult {
  /** Twilio MessageSid (SM… / MM… for media) */
  providerSid: string | null;
  /** Twilio's initial status: queued | accepted | scheduled | … */
  initialStatus: string | null;
}

export async function twilioSend(params: {
  to: string;
  body: string;
  channel: SmsChannel;
  messagingServiceSid: string | null;
  fromNumber: string | null;
}): Promise<TwilioSendResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const toAddr = params.channel === "whatsapp" ? `whatsapp:${params.to}` : params.to;
  const form = new URLSearchParams({ To: toAddr, Body: params.body });
  if (params.messagingServiceSid) {
    form.set("MessagingServiceSid", params.messagingServiceSid);
  } else if (params.fromNumber) {
    form.set("From", params.channel === "whatsapp" ? `whatsapp:${params.fromNumber}` : params.fromNumber);
  } else {
    throw new SmsDeliveryError("No sender configured: set a Messaging Service SID or From number in Operations → SMS Health, or TWILIO_FROM_NUMBER.", {
      provider: "twilio",
      code: null,
      fix: "Configure a sender in Operations → SMS Health.",
    });
  }
  if (PUBLIC_BASE_URL) {
    form.set("StatusCallback", `${PUBLIC_BASE_URL}/api/webhooks/twilio/status`);
  }

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (err) {
    // Network-level failure (DNS, timeout, reset) — worth retrying.
    throw new SmsDeliveryError(`Twilio unreachable: ${err instanceof Error ? err.message : String(err)}`, {
      provider: "twilio",
      retryable: true,
    });
  }

  if (!res.ok) {
    const raw = await res.text();
    let parsed: TwilioErrorBody | null = null;
    try {
      parsed = JSON.parse(raw) as TwilioErrorBody;
    } catch {
      parsed = null;
    }
    const code = parsed?.code != null ? String(parsed.code) : null;
    const message = parsed?.message ?? raw.slice(0, 300);
    const hint = describeSmsProviderCode(code);
    const retryable = hint?.retryable ?? res.status >= 500;
    throw new SmsDeliveryError(
      `Twilio ${code ?? res.status}: ${message}${parsed?.more_info ? ` (${parsed.more_info})` : ""}`,
      {
        provider: "twilio",
        code,
        retryable,
        channelSwitchable: hint?.channelSwitchable ?? false,
        fix: hint?.fix ?? null,
      },
    );
  }

  const body = (await res.json()) as { sid?: string; status?: string };
  return { providerSid: body.sid ?? null, initialStatus: body.status ?? null };
}

/**
 * Map Twilio's async MessageStatus values onto AttendX's honest sms_logs taxonomy.
 */
export function mapTwilioStatus(twilioStatus: string): string | null {
  switch (twilioStatus) {
    case "queued":
    case "accepted":
    case "scheduled":
      return "queued";
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "delivered"; // WhatsApp read receipt — delivery confirmed
    case "undelivered":
      return "undelivered";
    case "failed":
      return "failed";
    case "canceled":
      return "failed";
    default:
      return null;
  }
}

export interface SendSmsResult {
  channel: SmsChannel;
  provider: "twilio" | "simulation";
  /** Twilio MessageSid when the send reached Twilio */
  providerSid: string | null;
}

/**
 * Send a parent notification through the configured channel strategy:
 *  - `sms`      → SMS only
 *  - `whatsapp` → WhatsApp only
 *  - `auto`     → SMS first; on channel-capable failures (21612, 21408, …)
 *                 transparently retry over WhatsApp and report which won.
 * Every attempt outcome is persisted to sms_logs with the effective channel
 * encoded in `provider` ("twilio" | "twilio:whatsapp" | "simulation[:…]").
 */
export async function sendSms(params: {
  studentId: number;
  parentPhone: string;
  message: string;
}): Promise<SendSmsResult> {
  const { studentId, message } = params;
  const config = await getSmsSenderConfig();
  const to = normalizePhone(params.parentPhone, config.defaultCountry);
  const providerBase = twilioEnabled() ? "twilio" : "simulation";

  const logFailure = async (provider: string, detail: string, code: string | null = null, channel: SmsChannel | null = null) => {
    await db.insert(smsLogsTable).values({
      studentId,
      parentPhone: params.parentPhone,
      message,
      status: "failed",
      provider,
      errorMessage: detail,
      errorCode: code,
      channel,
      statusUpdatedAt: new Date(),
    });
  };

  if (!to) {
    const detail = `Parent phone "${params.parentPhone}" is not a valid phone number (could not normalize with default country ${config.defaultCountry}).`;
    logger.error({ studentId }, "SMS skipped: invalid parent phone");
    await logFailure(providerBase, detail);
    throw new SmsDeliveryError(detail, { provider: providerBase, code: "21211", fix: "Fix the parent phone value on the student record (E.164 or local 09… format)." });
  }

  const attempts: SmsChannel[] =
    config.channelMode === "auto" ? ["sms", "whatsapp"] : [config.channelMode];

  let lastError: SmsDeliveryError | null = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const channel = attempts[i];
    const provider = channel === "whatsapp" ? `${providerBase}:whatsapp` : providerBase;
    try {
      let providerSid: string | null = null;
      if (twilioEnabled()) {
        logger.info({ studentId, channel }, "Sending notification via Twilio");
        const result = await twilioSend({
          to,
          body: message,
          channel,
          messagingServiceSid: config.messagingServiceSid,
          fromNumber: config.fromNumber,
        });
        providerSid = result.providerSid;
        logger.info({ studentId, channel, providerSid, initialStatus: result.initialStatus }, "Twilio notification accepted");
      } else {
        logger.info({ studentId, channel }, "[SIMULATED] notification logged");
      }
      // Honest status: Twilio has only SUBMITTED the message at this point.
      // It can still fail at the carrier (async 21612 and friends) — the
      // status webhook + reconciliation sweep upgrade this row to the real
      // sent/delivered/undelivered/failed verdict.
      await db.insert(smsLogsTable).values({
        studentId,
        parentPhone: params.parentPhone,
        message,
        status: twilioEnabled() ? "queued" : "simulated",
        provider,
        errorMessage: null,
        providerSid,
        channel,
        statusUpdatedAt: twilioEnabled() ? new Date() : null,
      });
      return { channel, provider: providerBase, providerSid };
    } catch (err) {
      const delivery = err instanceof SmsDeliveryError
        ? err
        : new SmsDeliveryError(err instanceof Error ? err.message : String(err), { provider, retryable: true });
      logger.error({ err: delivery, studentId, channel }, "Notification channel failed");
      lastError = delivery;
      // Only try the next channel when the failure is plausibly channel-related
      // and another attempt remains. Auth/config faults never fall through.
      const canFallback = i + 1 < attempts.length && (delivery.channelSwitchable || delivery.code === "63007");
      if (!canFallback) {
        await logFailure(provider, delivery.message + (delivery.fix ? ` → FIX: ${delivery.fix}` : ""), delivery.code, channel);
        throw delivery;
      }
    }
  }

  // Unreachable (loop always returns or throws) — kept for exhaustiveness.
  const detail = lastError?.message ?? "Notification failed";
  await logFailure(providerBase, detail, lastError?.code ?? null);
  throw lastError ?? new SmsDeliveryError(detail, { provider: providerBase });
}

export function buildPresentMessage(studentName: string, time: string): string {
  return `AttendX: ${studentName} arrived in class at ${time}. All is well.`;
}

export function buildAbsentMessage(studentName: string): string {
  return `AttendX alert: ${studentName} has not arrived in class. Please check immediately.`;
}

export function buildLateMessage(studentName: string, time: string): string {
  return `AttendX: ${studentName} arrived late to class at ${time}.`;
}
