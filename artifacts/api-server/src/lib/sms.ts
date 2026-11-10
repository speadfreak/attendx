import { db, smsLogsTable } from "@workspace/db";
import { logger } from "./logger";
import { getSystemSettings } from "./system-settings";

// ── Twilio credentials — env only, never stored in the database ──
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_ENV = process.env.TWILIO_FROM_NUMBER;
const TWILIO_MESSAGING_SERVICE_ENV = process.env.TWILIO_MESSAGING_SERVICE_SID;

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

export type SmsProviderName = "afromessage" | "twilio" | "simulation";

/**
 * The provider that will actually carry outbound SMS.
 * Precedence: explicit SMS_PROVIDER env override → AfroMessage (when its
 * token is configured — it is the reliable Ethiopia corridor, unlike Twilio,
 * where Ethio Telecom blocks unregistered international senders) → Twilio →
 * simulation.
 */
export function activeSmsProvider(): SmsProviderName {
  const forced = (process.env.SMS_PROVIDER ?? "").toLowerCase();
  if (forced === "afromessage" && afroMessageEnabled()) return "afromessage";
  if (forced === "twilio" && twilioEnabled()) return "twilio";
  if (forced === "simulation") return "simulation";
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
    default:
      return null;
  }
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
}

/**
 * Send a parent notification through the configured provider + channel
 * strategy:
 *  - AfroMessage (active when AFROMESSAGE_TOKEN is set): SMS only, Ethiopia-
 *    native corridor. Synchronous ack → row starts at `sent`; DLR callback
 *    upgrades delivered/undelivered/failed.
 *  - Twilio: `sms`/`whatsapp` per channel mode; `auto` retries channel-capable
 *    failures (21612, 21408, …) over WhatsApp when opted in.
 *  - No credentials → simulated rows (visible, honest, no side effects).
 * Every attempt outcome is persisted to sms_logs with the effective channel
 * encoded in `provider` ("afromessage" | "twilio" | "twilio:whatsapp" | "simulation[:…]").
 */
export async function sendSms(params: {
  studentId: number;
  parentPhone: string;
  message: string;
}): Promise<SendSmsResult> {
  const { studentId, message } = params;
  const config = await getSmsSenderConfig();
  const to = normalizePhone(params.parentPhone, config.defaultCountry);
  const providerBase = activeSmsProvider();
  if (providerBase === "afromessage" && config.channelMode === "whatsapp") {
    // AfroMessage has no WhatsApp channel — honor the admin's intent as best
    // we can by still sending SMS rather than dropping the notification.
    logger.info({ studentId }, "channelMode=whatsapp ignored: active provider AfroMessage is SMS-only");
  }

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
    // Bookkeeping-only failure must not mask the real, actionable error.
    try {
      await logFailure(providerBase, detail);
    } catch (logErr) {
      logger.error({ err: logErr, studentId }, "sms_logs failure write failed — propagating original SmsDeliveryError");
    }
    throw new SmsDeliveryError(detail, { provider: providerBase, code: "21211", fix: "Fix the parent phone value on the student record (E.164 or local 09… format)." });
  }

  // Channel attempts: AfroMessage (and simulation) are SMS-only. For Twilio,
  // `sms`/`whatsapp` are explicit admin opt-ins; `auto` sends SMS first and
  // only falls back to WhatsApp when a WhatsApp sender is explicitly
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
      if (providerBase === "afromessage") {
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
      try {
        await db.insert(smsLogsTable).values({
          studentId,
          parentPhone: params.parentPhone,
          message,
          status: initialStatus ?? "simulated",
          provider,
          errorMessage: null,
          providerSid,
          channel,
          statusUpdatedAt: initialStatus ? new Date() : null,
        });
      } catch (logErr) {
        console.error("[sms] carrier accepted message but sms_logs write failed", logErr);
      }
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
        // The failure log is bookkeeping — if it throws (missing Phase 6
        // columns, DB hiccup) we must still surface the ORIGINAL
        // SmsDeliveryError with its code + fix hint, not the raw pg error.
        try {
          await logFailure(provider, delivery.message + (delivery.fix ? ` → FIX: ${delivery.fix}` : ""), delivery.code, channel);
        } catch (logErr) {
          logger.error({ err: logErr, studentId, channel }, "sms_logs failure write failed — propagating original SmsDeliveryError");
        }
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
