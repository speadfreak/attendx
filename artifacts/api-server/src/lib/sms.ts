import { randomBytes } from "node:crypto";
import { db, smsLogsTable } from "@workspace/db";
import { logger } from "./logger";
import { getSystemSettings } from "./system-settings";

// ── Twilio credentials — env only, never stored in the database ──
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_ENV = process.env.TWILIO_FROM_NUMBER;
const TWILIO_MESSAGING_SERVICE_ENV = process.env.TWILIO_MESSAGING_SERVICE_SID;

// ── TextBee credentials (Android-SIM SMS gateway, textbee.dev) — env only ──
// TextBee turns the school's own Android phone into the gateway: messages go
// out over the LOCAL SIM (ethio tel / Safaricom), so there is no international
// corridor to be geo-blocked — this is what finally fixes Ethiopia delivery.
export const TEXTBEE_API_KEY = process.env.TEXTBEE_API_KEY ?? null;
export const TEXTBEE_DEVICE_ID = process.env.TEXTBEE_DEVICE_ID ?? null;
/** Optional SIM pick (subscriptionId from the textbee app's SIM Cards view). */
const TEXTBEE_SIM_SUBSCRIPTION_ID = process.env.TEXTBEE_SIM_SUBSCRIPTION_ID
  ? Number(process.env.TEXTBEE_SIM_SUBSCRIPTION_ID)
  : null;
export const TEXTBEE_BASE_URL = (process.env.TEXTBEE_BASE_URL ?? "https://api.textbee.dev/api/v1").replace(/\/$/, "");
/** Webhook signing secret (≥20 chars). When set, it is (re)used when AttendX
 *  auto-registers its delivery subscription; overrides the DB-stored secret
 *  when verifying incoming webhook signatures. */
export const TEXTBEE_WEBHOOK_SECRET = process.env.TEXTBEE_WEBHOOK_SECRET ?? null;

// ── AfroMessage credentials (Ethiopia-native SMS gateway) — env only ──
// The API token is the JWT issued by api.afromessage.com → Tokens. Its
// payload carries the account `identifier` (system short-code id), which we
// decode automatically — no second env var needed unless the account has
// multiple identifiers (then set AFROMESSAGE_IDENTIFIER_ID explicitly).
const AFROMESSAGE_TOKEN = process.env.AFROMESSAGE_TOKEN ?? null;
const AFROMESSAGE_SENDER_ENV =
  process.env.AFROMESSAGE_SENDER_NAME ??
  process.env.AFROMESSAGE_SENDER_NAMES ?? // official SDK's env name
  null;
const AFROMESSAGE_IDENTIFIER_ENV =
  process.env.AFROMESSAGE_IDENTIFIER_ID ??
  process.env.AFRO_IDENTIFIER_ID ??
  null;
const AFROMESSAGE_BASE_URL = (process.env.AFROMESSAGE_BASE_URL ?? "https://api.afromessage.com/api").replace(/\/$/, "");
/** Optional shared secret appended to the DLR callback URL (?token=…) and
 *  required as a query param by the webhook when configured. */
export const AFROMESSAGE_CALLBACK_SECRET = process.env.AFROMESSAGE_CALLBACK_SECRET ?? null;

/** Decode a JWT payload claim without verifying the signature (the token is
 *  already a credential; we only need the identifier it was issued for). */
function jwtPayloadClaim(token: string | null, claim: string): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const value = payload[claim];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function afroMessageEnabled(): boolean {
  return !!AFROMESSAGE_TOKEN;
}

/** Identifier ID (system short-code) — env override wins, else the JWT claim. */
export function afroIdentifierId(): string | null {
  return AFROMESSAGE_IDENTIFIER_ENV ?? jwtPayloadClaim(AFROMESSAGE_TOKEN, "identifier");
}

export type SmsProviderName = "textbee" | "afromessage" | "twilio" | "simulation";

export function textbeeEnabled(): boolean {
  return !!TEXTBEE_API_KEY;
}

/**
 * The provider that will actually carry outbound SMS.
 * Precedence: explicit SMS_PROVIDER env override → TextBee (own Android phone
 * + local SIM — no international corridor, nothing for Ethio Telecom or any
 * other carrier to block) → AfroMessage → Twilio → simulation.
 */
export function activeSmsProvider(): SmsProviderName {
  const forced = (process.env.SMS_PROVIDER ?? "").toLowerCase();
  if (forced === "textbee" && textbeeEnabled()) return "textbee";
  if (forced === "afromessage" && afroMessageEnabled()) return "afromessage";
  if (forced === "twilio" && twilioEnabled()) return "twilio";
  if (forced === "simulation") return "simulation";
  if (textbeeEnabled()) return "textbee";
  if (afroMessageEnabled()) return "afromessage";
  if (twilioEnabled()) return "twilio";
  return "simulation";
}
/**
 * WhatsApp is OPT-IN: the fallback attempt over `whatsapp:` only happens when
 * an explicit WhatsApp sender is configured via TWILIO_WHATSAPP_FROM (or the
 * admin pins channel mode to 'whatsapp' in Operations → SMS Health). Without
 * it, `auto` mode sends SMS only — unregistered WhatsApp senders otherwise
 * produce a burst of Twilio 63007 failures on accounts with no WA sender.
 */
export const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM ?? null;

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
  /** AfroMessage Sender Name (shown as FROM to parents) — DB setting wins,
   *  else AFROMESSAGE_SENDER_NAME(S) env; null → the identifier's default
   *  short code is used. */
  afroSenderName: string | null;
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
  let afroSenderName: string | null = AFROMESSAGE_SENDER_ENV;
  try {
    const settings = await getSystemSettings();
    const storedMode: unknown = settings.smsChannelMode;
    if (storedMode === "sms" || storedMode === "whatsapp") channelMode = storedMode;
    if (settings.smsMessagingServiceSid) messagingServiceSid = settings.smsMessagingServiceSid;
    if (settings.smsFromNumber) fromNumber = settings.smsFromNumber;
    if (settings.smsDefaultCountry) defaultCountry = settings.smsDefaultCountry;
    if (settings.smsAfroSenderName) afroSenderName = settings.smsAfroSenderName;
  } catch (err) {
    logger.warn({ err }, "SMS settings unavailable — falling back to env defaults");
  }
  const value: SmsSenderConfig = {
    channelMode,
    messagingServiceSid: messagingServiceSid ?? null,
    fromNumber: fromNumber ?? null,
    defaultCountry,
    afroSenderName: afroSenderName ?? null,
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
  /** sms_logs row id recording this failure, when one was written — lets the
   *  retry endpoints point the admin at the exact attempt row. Mutable:
   *  the failure row is persisted AFTER the error object is constructed. */
  logId: number | null;

  constructor(
    message: string,
    options: {
      provider?: string;
      code?: string | null;
      retryable?: boolean;
      channelSwitchable?: boolean;
      fix?: string | null;
      logId?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "SmsDeliveryError";
    this.provider = options.provider ?? "twilio";
    this.code = options.code ?? null;
    this.retryable = options.retryable ?? false;
    this.channelSwitchable = options.channelSwitchable ?? false;
    this.fix = options.fix ?? null;
    this.logId = options.logId ?? null;
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
        title: "Twilio sender/recipient restriction (21612)",
        fix: "Twilio 21612 means this To/From pairing is not allowed; it does not by itself prove the number format, trial status, or geographic permissions are wrong. For Ethiopia, Twilio says Ethio Telecom blocks unregistered Sender IDs from October 8, 2026 and does not support international long codes. Register an Alphanumeric Sender ID for Ethiopia, add it to the configured Messaging Service's Sender Pool (Add Senders → Alpha Sender), and confirm AttendX is using that service SID. A geo-permission toggle or US number alone will not fix this; check the destination country's Twilio sender rules for other destinations.",
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
        title: "WhatsApp sender not registered (63007)",
        fix: "No WhatsApp-capable sender on the account — register one in Twilio Console or force the SMS channel.",
        retryable: false,
        channelSwitchable: false,
      };
    // ── TextBee gateway codes (device-carried, human-readable) ──
    case "tb-auth":
      return {
        title: "TextBee authentication failed",
        fix: "TEXTBEE_API_KEY is missing or wrong. Copy the API key again from textbee.dev → Dashboard → API Keys and set it in Vercel → Environment Variables.",
        retryable: false,
        channelSwitchable: false,
      };
    case "tb-device":
      return {
        title: "TextBee gateway phone is not ready",
        fix: "No enabled device answered the send request. Open the textbee app on the school Android phone, make sure it is signed in, 'Enabled' is on, and the phone is online (heartbeats keep it live).",
        retryable: true,
        channelSwitchable: false,
      };
    case "tb-limit":
      return {
        title: "TextBee plan limit reached",
        fix: "The free hosted plan's daily/monthly message limit is used up. AttendX requeues these automatically — or upgrade the plan / self-host textbee for unlimited sends.",
        retryable: true,
        channelSwitchable: false,
      };
    case "112":
      return {
        title: "SIM network error on the gateway phone (112)",
        fix: "The SIM's radio rejected the send. Check signal bars on the gateway phone, confirm the SIM has SMS credit/bundle, and that SMS sending is not barred on the line. Retrying usually works once the network is stable.",
        retryable: true,
        channelSwitchable: false,
      };
    case "SMS_PERMISSION_MISSING":
      return {
        title: "textbee app lost the SMS permission",
        fix: "On the gateway phone: Settings → Apps → textbee → Permissions → allow SMS. Then resend.",
        retryable: true,
        channelSwitchable: false,
      };
    default:
      return null;
  }
}

// ── TextBee send (https://textbee.dev — Android SIM gateway) ─────────

interface TextbeeSendData {
  // Queued path
  success?: boolean;
  message?: string;
  smsBatchId?: string;
  recipientCount?: number;
  estimatedCompletionAt?: string;
  warning?: { code?: string; message?: string };
  // Immediate path (Firebase batch response)
  successCount?: number;
  failureCount?: number;
}

export interface TextbeeSendResult {
  /** `tbbatch:<id>` (queued ack) or `tbsms:<id>` when the API hands us the
   *  message id directly; null when neither is exposed (immediate path) —
   *  the reconcile sweep then matches by recipient + message and upgrades
   *  providerSid to the precise textbee sms id. */
  providerSid: string | null;
  /** AttendX status at accept time — always "queued" for textbee. */
  initialStatus: string | null;
}

/**
 * Map TextBee's message statuses onto AttendX's honest sms_logs taxonomy.
 * textbee: pending → dispatched → sent → delivered | failed
 */
export function mapTextbeeStatus(status: string): string | null {
  switch (status.toLowerCase()) {
    case "pending":
    case "dispatched":
      return "queued";
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "failed":
      return "failed";
    default: // "unknown", "received" (inbound) — keep current status
      return null;
  }
}

/** TextBee delivery webhook endpoint on this deployment. */
export function textbeeWebhookUrl(): string | null {
  if (!PUBLIC_BASE_URL) return null;
  return `${PUBLIC_BASE_URL}/api/webhooks/textbee`;
}

/**
 * TextBee REST helper — every call authenticates with the `x-api-key` header.
 * Returns { ok, status, json } without throwing so callers can shape errors.
 */
async function textbeeRequest<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; status: number; json: T | null; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${TEXTBEE_BASE_URL}${path}`, {
      method,
      headers: {
        "x-api-key": TEXTBEE_API_KEY ?? "",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const raw = await res.text();
    let json: T | null = null;
    try {
      json = JSON.parse(raw) as T;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, raw };
  } finally {
    clearTimeout(timer);
  }
}

export interface TextbeeDeviceView {
  _id: string;
  name: string | null;
  model: string | null;
  brand: string | null;
  enabled: boolean;
  isDefault: boolean;
  lastHeartbeat: string | null;
  batteryInfo?: { percentage?: number; isCharging?: boolean } | null;
  networkInfo?: { networkType?: string } | null;
  simInfo?: {
    sims?: Array<{ subscriptionId?: number; carrierName?: string; serviceState?: string; simState?: string }> | null;
  } | null;
  sentSMSCount?: number;
}

/** List the gateway phones registered on the TextBee account (read-only). */
export async function textbeeListDevices(): Promise<TextbeeDeviceView[] | null> {
  if (!TEXTBEE_API_KEY) return null;
  const res = await textbeeRequest<{ data?: TextbeeDeviceView[] }>("GET", "/gateway/devices", undefined, 8_000);
  return res.ok && res.json?.data ? res.json.data : null;
}

/**
 * Send one SMS through TextBee (POST /gateway/send-sms, x-api-key).
 * The API pushes the message to the school's Android phone over FCM; the
 * phone radios it out over the local SIM. Status truth arrives later via
 * the delivery webhook (SMS_STATUS_UPDATED / MESSAGE_DELIVERED / FAILED) or
 * the reconcile sweep polling GET /gateway/messages.
 */
export async function textbeeSend(params: { to: string; body: string }): Promise<TextbeeSendResult> {
  if (!TEXTBEE_API_KEY) {
    throw new SmsDeliveryError("TextBee is not configured: TEXTBEE_API_KEY is missing.", {
      provider: "textbee",
      code: "tb-auth",
      fix: "Add TEXTBEE_API_KEY in Vercel → Settings → Environment Variables (textbee.dev → Dashboard → API Keys).",
    });
  }

  const payload: Record<string, unknown> = { recipients: [params.to], message: params.body };
  if (TEXTBEE_DEVICE_ID) payload.deviceId = TEXTBEE_DEVICE_ID;
  if (TEXTBEE_SIM_SUBSCRIPTION_ID != null) payload.simSubscriptionId = TEXTBEE_SIM_SUBSCRIPTION_ID;

  let res: Awaited<ReturnType<typeof textbeeRequest<TextbeeSendData>>>;
  try {
    // A pinned device routes through /devices/:id/send-sms; otherwise textbee
    // resolves the default (or freshest-heartbeat enabled) device itself.
    const path = TEXTBEE_DEVICE_ID
      ? `/gateway/devices/${encodeURIComponent(TEXTBEE_DEVICE_ID)}/send-sms`
      : "/gateway/send-sms";
    res = await textbeeRequest<TextbeeSendData>("POST", path, payload);
  } catch (err) {
    throw new SmsDeliveryError(`TextBee unreachable: ${err instanceof Error ? err.message : String(err)}`, {
      provider: "textbee",
      retryable: true,
    });
  }

  if (!res.ok) {
    const detail = (res.json && typeof res.json === "object" && "message" in res.json && typeof (res.json as { message?: unknown }).message === "string"
      ? (res.json as { message: string }).message
      : null) ?? res.raw.slice(0, 300);
    const authFail = res.status === 401 || res.status === 403;
    const rateLimited = res.status === 429;
    throw new SmsDeliveryError(`TextBee ${res.status}: ${detail}`, {
      provider: "textbee",
      code: authFail ? "tb-auth" : rateLimited ? "tb-limit" : null,
      retryable: rateLimited || res.status >= 500,
      fix: authFail
        ? "TEXTBEE_API_KEY is invalid or revoked — copy the API key again from textbee.dev → Dashboard → API Keys and redeploy."
        : rateLimited
          ? null
          : "The gateway phone may be offline/disabled. Open the textbee app on the school phone and confirm it shows 'Connected' and Enabled.",
    });
  }

  const envelope = res.json as TextbeeSendData | { data?: TextbeeSendData } | null;
  // TextBee wraps EVERY response in a `{ data: { … } }` envelope, e.g.
  //   {"data":{"success":true,"message":"SMS added to queue for processing",
  //           "smsBatchId":"6af3117d…","recipientCount":1}}
  // Older/alternate deployments returned the fields at the top level —
  // accept both shapes (regression fix: the wrapped success used to fall
  // through to "did not accept" even though the SMS went out fine).
  const data: TextbeeSendData | null =
    envelope && typeof envelope === "object" && "data" in envelope &&
    envelope.data && typeof envelope.data === "object"
      ? (envelope as { data: TextbeeSendData }).data
      : (envelope as TextbeeSendData | null);
  // The send-response shape depends on the hosted queue:
  //  - queued:  { success, smsBatchId, recipientCount, … }
  //  - immediate (FCM direct): { successCount, failureCount, … } — no ids.
  const batchId = data?.smsBatchId ?? null;
  const immediateOk = (data?.successCount ?? 0) > 0;
  // Some queue responses omit smsBatchId but still say success — accept, and
  // let the reconcile sweep match the row by recipient + message.
  const plainOk = data?.success === true;
  const accepted = batchId != null || immediateOk || plainOk;
  if (batchId) {
    return { providerSid: `tbbatch:${batchId}`, initialStatus: "queued" };
  }
  if (!accepted) {
    throw new SmsDeliveryError(`TextBee did not accept the message: ${res.raw.slice(0, 200)}`, {
      provider: "textbee",
      retryable: true,
    });
  }
  // Immediate path — the sms id is not exposed at send time; the reconcile
  // sweep matches this row by recipient + message and stamps the precise id.
  return { providerSid: null, initialStatus: "queued" };
}

// ── TextBee webhook subscription auto-registration ───────────────────

/** system_settings key holding the TextBee webhook signing secret. */
export const TEXTBEE_WEBHOOK_SECRET_KEY = "textbeeWebhookSecret";

let webhookEnsure: Promise<{ ok: boolean; detail: string }> | null = null;
let webhookEnsureAt = 0;
const WEBHOOK_ENSURE_TTL_MS = 10 * 60_000;

/**
 * The signing secret used to verify TextBee webhook calls: env override
 * wins, else the value AttendX stored when it auto-registered the
 * subscription (system_settings.textbeeWebhookSecret).
 */
export async function getTextbeeSigningSecret(): Promise<string | null> {
  if (TEXTBEE_WEBHOOK_SECRET) return TEXTBEE_WEBHOOK_SECRET;
  try {
    const { settingValue } = await import("./system-settings");
    const stored = await settingValue<string | null>(TEXTBEE_WEBHOOK_SECRET_KEY, null);
    return typeof stored === "string" && stored.length >= 20 ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Make sure textbee pushes delivery events to THIS deployment:
 *  1. list subscriptions (GET /webhooks — includes the signingSecret),
 *  2. if one already targets our webhook URL and is active → snapshot its
 *     secret into system_settings (env override wins) and we are done,
 *  3. otherwise repair the closest "AttendX" subscription (PATCH deliveryUrl
 *     + events) or create a fresh one (POST) with a generated secret,
 *     persisting that secret for verification.
 * Fired-and-forgotten from the send path; cached ~10 min. Failures never
 * throw — the reconcile sweep + diagnostics carry the visibility.
 */
export async function ensureTextbeeWebhook(): Promise<{ ok: boolean; detail: string }> {
  if (!TEXTBEE_API_KEY || !PUBLIC_BASE_URL) {
    return { ok: false, detail: "TEXTBEE_API_KEY or PUBLIC_BASE_URL missing" };
  }
  if (webhookEnsure && Date.now() - webhookEnsureAt < WEBHOOK_ENSURE_TTL_MS) return webhookEnsure;

  webhookEnsure = (async () => {
    const targetUrl = textbeeWebhookUrl();
    if (!targetUrl) return { ok: false, detail: "no webhook URL" };
    try {
      const list = await textbeeRequest<{ data?: Array<{
        _id: string;
        name?: string;
        deliveryUrl?: string;
        isActive?: boolean;
        signingSecret?: string;
        events?: string[];
      }> }>("GET", "/webhooks", undefined, 8_000);
      const subs = list.ok && list.json?.data ? list.json.data : [];

      // 1. Already pointing at us?
      const exact = subs.find((s) => s.deliveryUrl === targetUrl && s.isActive !== false);
      if (exact) {
        if (exact.signingSecret) {
          const { setSystemSetting } = await import("./system-settings");
          await setSystemSetting(TEXTBEE_WEBHOOK_SECRET_KEY, exact.signingSecret);
        }
        return { ok: true, detail: "subscription already registered" };
      }

      const events = ["MESSAGE_SENT", "MESSAGE_DELIVERED", "MESSAGE_FAILED", "SMS_STATUS_UPDATED"];
      // 2. Repair a mis-pointed AttendX subscription (e.g. saved with the
      //    site root URL — pushes 404 and textbee pauses it).
      const repairable = subs.find((s) => (s.name ?? "").toLowerCase().includes("attendx")) ?? subs[0];
      if (repairable?._id) {
        const secret = TEXTBEE_WEBHOOK_SECRET ?? repairable.signingSecret ?? generateSigningSecret();
        const patch = await textbeeRequest<{ data?: { signingSecret?: string } }>(
          "PATCH",
          `/webhooks/${encodeURIComponent(repairable._id)}`,
          { deliveryUrl: targetUrl, events, signingSecret: secret, isActive: true },
          8_000,
        );
        if (patch.ok) {
          const { setSystemSetting } = await import("./system-settings");
          await setSystemSetting(TEXTBEE_WEBHOOK_SECRET_KEY, secret);
          return { ok: true, detail: `repaired subscription ${repairable._id}` };
        }
      }

      // 3. Create a fresh subscription.
      const secret = TEXTBEE_WEBHOOK_SECRET ?? generateSigningSecret();
      const created = await textbeeRequest<{ data?: { signingSecret?: string } }>(
        "POST",
        "/webhooks",
        { name: "AttendX", deliveryUrl: targetUrl, events, signingSecret: secret },
        8_000,
      );
      if (created.ok) {
        const { setSystemSetting } = await import("./system-settings");
        await setSystemSetting(TEXTBEE_WEBHOOK_SECRET_KEY, secret);
        return { ok: true, detail: "subscription created" };
      }
      return { ok: false, detail: `registration failed: HTTP ${created.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  })();
  webhookEnsureAt = Date.now();
  return webhookEnsure;
}

function generateSigningSecret(): string {
  return `atx_${randomBytes(24).toString("hex")}`;
}

// ── AfroMessage send (https://afromessage.com/developers) ─────────────

interface AfroSendBody {
  acknowledge?: string;
  error?: string;
  message_id?: string;
  status?: string;
  message?: unknown;
  to?: unknown;
  // Some deployments nest the payload under `response`:
  response?: { message_id?: string; status?: string; message?: unknown; to?: unknown; error?: string } | string;
}

export interface AfroSendResult {
  /** AfroMessage message_id — stored in sms_logs.provider_sid for DLR matching */
  providerSid: string | null;
  /** Mapped initial AttendX status when the API reported one; null otherwise */
  initialStatus: string | null;
}

/**
 * Map AfroMessage's send-progress states onto AttendX's honest sms_logs
 * taxonomy. Unknown states return null (row keeps its current status).
 */
export function mapAfroStatus(status: string): string | null {
  switch (status.toLowerCase()) {
    case "queued":
    case "accepted":
    case "scheduled":
    case "init":
    case "initiated":
    case "pending":
      return "queued";
    case "sent":
    case "submitted":
      return "sent";
    case "delivered":
      return "delivered";
    case "undelivered":
    case "not_delivered":
    case "not delivered":
      return "undelivered";
    case "failed":
    case "rejected":
    case "expired":
    case "error":
      return "failed";
    default:
      return null;
  }
}

/** DLR callback URL for outbound messages (GET endpoint, per AfroMessage docs). */
export function afroCallbackUrl(): string | null {
  if (!PUBLIC_BASE_URL) return null;
  const secret = AFROMESSAGE_CALLBACK_SECRET ? `?token=${encodeURIComponent(AFROMESSAGE_CALLBACK_SECRET)}` : "";
  return `${PUBLIC_BASE_URL}/api/webhooks/afromessage/status${secret}`;
}

/**
 * Send one SMS through AfroMessage (POST {base}/send, Bearer token).
 * The API answers SYNCHRONOUSLY: acknowledge=success means the message was
 * accepted for delivery and a message_id was assigned. Carrier verdicts only
 * arrive via the callback URL (when PUBLIC_BASE_URL is set) — the row starts
 * at `sent` and the webhook upgrades it to delivered/undelivered/failed.
 */
export async function afroSend(params: {
  to: string;
  body: string;
  senderName: string | null;
  identifierId: string | null;
}): Promise<AfroSendResult> {
  const payload: Record<string, unknown> = { to: params.to, message: params.body };
  if (params.identifierId) payload.from = params.identifierId;
  if (params.senderName) payload.sender = params.senderName;
  const callback = afroCallbackUrl();
  if (callback) payload.callback = callback;

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      res = await fetch(`${AFROMESSAGE_BASE_URL}/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AFROMESSAGE_TOKEN}`,
          "Content-Type": "application/json;charset=UTF-8",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Network-level failure (DNS, timeout, reset) — worth retrying.
    throw new SmsDeliveryError(`AfroMessage unreachable: ${err instanceof Error ? err.message : String(err)}`, {
      provider: "afromessage",
      retryable: true,
    });
  }

  const raw = await res.text();
  let parsed: AfroSendBody | null = null;
  try {
    parsed = JSON.parse(raw) as AfroSendBody;
  } catch {
    parsed = null;
  }

  // Tolerant shape handling: {acknowledge, response:{message_id,…}} is the
  // documented envelope; some deployments return the fields at the top level.
  const ack = parsed?.acknowledge ?? null;
  const inner = parsed && typeof parsed.response === "object" && parsed.response !== null ? parsed.response : parsed;
  const messageId = inner?.message_id ?? parsed?.message_id ?? null;
  const failureDetail =
    parsed?.error ??
    (typeof parsed?.response === "string" ? parsed.response : null) ??
    (typeof inner?.message === "string" ? inner.message : null) ??
    (typeof parsed?.message === "string" ? parsed.message : null);

  if (!res.ok || (ack && ack !== "success")) {
    const authFail = res.status === 401 || res.status === 403;
    throw new SmsDeliveryError(
      `AfroMessage ${res.status}: ${failureDetail ?? raw.slice(0, 300)}`,
      {
        provider: "afromessage",
        code: authFail ? "afro-auth" : null,
        retryable: res.status >= 500 || res.status === 429,
        fix: authFail
          ? "AFROMESSAGE_TOKEN is invalid or expired — copy the API token again from the AfroMessage dashboard (api.afromessage.com → Tokens) and redeploy."
          : !AFROMESSAGE_TOKEN
            ? "AFROMESSAGE_TOKEN is not configured — add it in Vercel → Settings → Environment Variables."
            : "Check the AfroMessage dashboard: the account needs SMS credit, and a custom Sender Name must be verified there before use.",
      },
    );
  }

  const initial = typeof inner?.status === "string" ? mapAfroStatus(inner.status) : null;
  return { providerSid: messageId, initialStatus: initial };
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

/**
 * After a carrier-accepted send, Twilio can STILL fail seconds later at the
 * network level (the async 21612 trap). The status webhook is the primary
 * truth source; this one-shot sweep ~12s later is the fast path that makes
 * the sms_logs row reflect reality almost immediately — even before the
 * throttled middleware/interval sweep gets around to it.
 *
 * Lazily imported to avoid the static sms.ts ⇄ sms-reconcile.ts cycle, and
 * scheduled fire-and-forget so the send path never waits on it.
 */
function schedulePostSendReconcile(): void {
  setTimeout(() => {
    void import("./sms-reconcile")
      // minAgeSeconds=10 so the just-sent row (queued ~12s ago) is included —
      // the sweep's default 45s cutoff would skip it and miss the fast path.
      .then(({ reconcilePendingSms }) => reconcilePendingSms(25, 10))
      .catch(() => {});
  }, 12_000).unref?.();
}

export interface SendSmsResult {
  channel: SmsChannel;
  /** The gateway that carried (or would have carried) this message */
  provider: SmsProviderName;
  /** Provider message id when the send reached a live gateway */
  providerSid: string | null;
  /** sms_logs row id written for this attempt (null when bookkeeping failed) */
  logId: number | null;
  /** Honest status the row was created with (queued/sent/simulated…) */
  initialStatus: string | null;
}

/**
 * Send a parent notification through the configured provider + channel
 * strategy:
 *  - TextBee (active when TEXTBEE_API_KEY is set): SMS only, carried by the
 *    school's own Android phone over the local SIM — no international
 *    corridor, immune to the geo-blocking that killed Twilio → Ethiopia.
 *    Row starts at `queued`; the delivery webhook + reconcile sweep upgrade
 *    it to sent/delivered/failed as the SIM reports reality.
 *  - AfroMessage (when AFROMESSAGE_TOKEN is set): SMS only, Ethiopia-native
 *    corridor. Synchronous ack → row starts at `sent`; DLR callback upgrades.
 *  - Twilio: `sms`/`whatsapp` per channel mode; `auto` retries channel-capable
 *    failures (21612, 21408, …) over WhatsApp when opted in.
 *  - No credentials → simulated rows (visible, honest, no side effects).
 * Every attempt outcome is persisted to sms_logs with the effective channel
 * encoded in `provider` ("textbee" | "afromessage" | "twilio" | "twilio:whatsapp" | "simulation[:…]").
 */
export async function sendSms(params: {
  studentId: number;
  parentPhone: string;
  message: string;
  /** When this attempt re-sends an earlier failed log row, that row's id —
   *  stamped on every sms_logs row this call writes (success or failure) so
   *  "Retry failed" can skip rows that already have a newer attempt. */
  retryOfId?: number;
}): Promise<SendSmsResult> {
  const { studentId, message, retryOfId } = params;
  const config = await getSmsSenderConfig();
  const to = normalizePhone(params.parentPhone, config.defaultCountry);
  const providerBase = activeSmsProvider();
  if ((providerBase === "afromessage" || providerBase === "textbee") && config.channelMode === "whatsapp") {
    // AfroMessage / TextBee have no WhatsApp channel — honor the admin's
    // intent as best we can by still sending SMS rather than dropping the
    // notification.
    logger.info({ studentId }, "channelMode=whatsapp ignored: active provider is SMS-only");
  }

  const logFailure = async (provider: string, detail: string, code: string | null = null, channel: SmsChannel | null = null): Promise<number | null> => {
    const [row] = await db.insert(smsLogsTable).values({
      studentId,
      parentPhone: params.parentPhone,
      message,
      status: "failed",
      provider,
      errorMessage: detail,
      errorCode: code,
      channel,
      retryOfId: retryOfId ?? null,
      statusUpdatedAt: new Date(),
    }).returning({ id: smsLogsTable.id });
    return row?.id ?? null;
  };

  if (!to) {
    const detail = `Parent phone "${params.parentPhone}" is not a valid phone number (could not normalize with default country ${config.defaultCountry}).`;
    logger.error({ studentId }, "SMS skipped: invalid parent phone");
    // Bookkeeping-only failure must not mask the real, actionable error.
    let invalidPhoneLogId: number | null = null;
    try {
      invalidPhoneLogId = await logFailure(providerBase, detail);
    } catch (logErr) {
      logger.error({ err: logErr, studentId }, "sms_logs failure write failed — propagating original SmsDeliveryError");
    }
    throw new SmsDeliveryError(detail, { provider: providerBase, code: "21211", logId: invalidPhoneLogId, fix: "Fix the parent phone value on the student record (E.164 or local 09… format)." });
  }

  // Channel attempts: TextBee and AfroMessage (and simulation) are SMS-only.
  // For Twilio, `sms`/`whatsapp` are explicit admin opt-ins; `auto` sends SMS
  // first and only falls back to WhatsApp when a WhatsApp sender is explicitly
  // configured (TWILIO_WHATSAPP_FROM) — see TWILIO_WHATSAPP_FROM above.
  const attempts: SmsChannel[] =
    providerBase !== "twilio"
      ? ["sms"]
      : config.channelMode === "auto"
        ? TWILIO_WHATSAPP_FROM ? ["sms", "whatsapp"] : ["sms"]
        : [config.channelMode];

  let lastError: SmsDeliveryError | null = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const channel = attempts[i];
    const provider = channel === "whatsapp" ? `${providerBase}:whatsapp` : providerBase;
    try {
      let providerSid: string | null = null;
      let initialStatus: string | null = null;
      if (providerBase === "textbee") {
        logger.info({ studentId, channel: "sms" }, "Sending notification via TextBee (Android SIM gateway)");
        const result = await textbeeSend({ to, body: message });
        providerSid = result.providerSid;
        // Honest label: textbee accepted the message — it is now between the
        // API and the phone. The delivery webhook + reconcile sweep upgrade
        // this row to sent/delivered/failed as the SIM reports reality.
        initialStatus = result.initialStatus ?? "queued";
        logger.info({ studentId, providerSid, initialStatus }, "TextBee notification accepted");
        // Delivery verdicts land fast — kick the reconcile sweep like Twilio.
        schedulePostSendReconcile();
        // Fire-and-forget: make sure textbee pushes delivery events to THIS
        // deployment (repairs a mis-pointed subscription, e.g. one saved with
        // the site root URL). Never blocks or fails the send.
        void ensureTextbeeWebhook().catch(() => {});
      } else if (providerBase === "afromessage") {
        logger.info({ studentId, channel: "sms" }, "Sending notification via AfroMessage");
        const result = await afroSend({
          to,
          body: message,
          senderName: config.afroSenderName,
          identifierId: afroIdentifierId(),
        });
        providerSid = result.providerSid;
        // Synchronous ack: the gateway accepted the message for delivery.
        // Without a reported initial state, `sent` is the honest label —
        // the DLR callback (if PUBLIC_BASE_URL is set) upgrades it later.
        initialStatus = result.initialStatus ?? "sent";
        logger.info({ studentId, providerSid, initialStatus }, "AfroMessage notification accepted");
      } else if (providerBase === "twilio") {
        logger.info({ studentId, channel }, "Sending notification via Twilio");
        const result = await twilioSend({
          to,
          body: message,
          channel,
          messagingServiceSid: config.messagingServiceSid,
          fromNumber: channel === "whatsapp" && TWILIO_WHATSAPP_FROM ? TWILIO_WHATSAPP_FROM : config.fromNumber,
        });
        providerSid = result.providerSid;
        initialStatus = "queued";
        logger.info({ studentId, channel, providerSid, initialStatus: result.initialStatus }, "Twilio notification accepted");
        // Carrier accepted — check its verdict ~12s later so the log row
        // upgrades from queued to the real status fast (async failures).
        schedulePostSendReconcile();
      } else {
        logger.info({ studentId, channel }, "[SIMULATED] notification logged");
      }
      // Honest status: a live gateway has only SUBMITTED the message at this
      // point. It can still fail at the carrier — the status webhooks +
      // reconciliation sweep upgrade this row to the real
      // sent/delivered/undelivered/failed verdict.
      // The log write is bookkeeping: if it fails (e.g. sms_logs is missing
      // the Phase 6 columns), the carrier has ALREADY accepted the message —
      // reclassifying the send as failed here would be a lie and would burn
      // retries on an already-sent message. Log loudly and return success.
      let logId: number | null = null;
      try {
        const [row] = await db.insert(smsLogsTable).values({
          studentId,
          parentPhone: params.parentPhone,
          message,
          status: initialStatus ?? "simulated",
          provider,
          errorMessage: null,
          providerSid,
          channel,
          retryOfId: retryOfId ?? null,
          statusUpdatedAt: initialStatus ? new Date() : null,
        }).returning({ id: smsLogsTable.id });
        logId = row?.id ?? null;
      } catch (logErr) {
        console.error("[sms] carrier accepted message but sms_logs write failed", logErr);
      }
      return { channel, provider: providerBase, providerSid, logId, initialStatus };
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
        // The failure log is bookkeeping — if it throws (missing Phase 6
        // columns, DB hiccup) we must still surface the ORIGINAL
        // SmsDeliveryError with its code + fix hint, not the raw pg error.
        try {
          const failureLogId = await logFailure(provider, delivery.message + (delivery.fix ? ` → FIX: ${delivery.fix}` : ""), delivery.code, channel);
          delivery.logId = failureLogId;
        } catch (logErr) {
          logger.error({ err: logErr, studentId, channel }, "sms_logs failure write failed — propagating original SmsDeliveryError");
        }
        throw delivery;
      }
    }
  }

  // Unreachable (loop always returns or throws) — kept for exhaustiveness.
  const detail = lastError?.message ?? "Notification failed";
  const fallbackFailureLogId = await logFailure(providerBase, detail, lastError?.code ?? null).catch(() => null);
  if (lastError) lastError.logId = fallbackFailureLogId;
  throw lastError ?? new SmsDeliveryError(detail, { provider: providerBase, logId: fallbackFailureLogId });
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
