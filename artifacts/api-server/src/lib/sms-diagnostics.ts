import { db, studentsTable } from "@workspace/db";
import { twilioEnabled, getSmsSenderConfig, normalizePhone, activeSmsProvider, afroMessageEnabled, afroIdentifierId, textbeeEnabled, textbeeListDevices, textbeeWebhookUrl, ensureTextbeeWebhook, getTextbeeSigningSecret, type SmsSenderConfig } from "./sms";
import { logger } from "./logger";

/**
 * Live Twilio account diagnostics for the Operations → SMS Health card.
 * Uses the Twilio REST API (read-only) to verify credentials, inspect the
 * sender configuration and produce prioritized, actionable recommendations.
 * Ethiopia needs destination-specific checks: a Messaging Service SID alone
 * does not satisfy the Ethio Telecom registered Alphanumeric Sender ID rule.
 */

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

function authHeader(): string {
  return `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`;
}

async function twilioGet<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: authHeader() },
      signal: controller.signal,
    });
    if (!res.ok) {
      const raw = await res.text();
      throw new Error(`Twilio API ${res.status}: ${raw.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface TwilioIncomingNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  capabilities: { sms: boolean; mms: boolean; voice: boolean };
}

interface TwilioMessagingService {
  sid: string;
  friendly_name: string;
  usecase: string | null;
}

interface TwilioServicePhoneNumber {
  sid: string;
  phone_number: string;
}

interface TwilioAlphaSender {
  sid: string;
  alpha_sender: string;
}

/**
 * Carrier-level account facts used by the SMS Health UI to explain WHY
 * sends fail (trial limitation vs geo permissions vs WhatsApp sender).
 * Calls `GET /2010-04-01/Accounts/{sid}.json` with a tight 4s timeout and
 * caches the result in-module for 5 minutes; ANY failure resolves to nulls
 * so callers can never be thrown off by a Twilio hiccup.
 *
 * Auth reuses the same Basic auth helper as the rest of the diagnostics.
 */
export interface TwilioCarrierStatus {
  /** "Trial" | "Full" | "Starter" … from Twilio, lowercased; null when unknown */
  accountType: "trial" | "paid" | null;
  /** Convenience flag — true ONLY when Twilio confirms a trial account */
  trial: boolean;
  /** Whether a Messaging Service SID is configured for sending (local truth) */
  messagingServiceConfigured: boolean;
  /** Sender fallback number currently configured (local truth) */
  fromNumber: string | null;
}

interface TwilioAccountView {
  type?: string;
  status?: string;
}

let carrierCache: { value: TwilioCarrierStatus; at: number } | null = null;
const CARRIER_CACHE_TTL_MS = 5 * 60_000;

export async function getTwilioCarrierStatus(messagingServiceConfigured: boolean, fromNumber: string | null): Promise<TwilioCarrierStatus> {
  const local: TwilioCarrierStatus = {
    accountType: null,
    trial: false,
    messagingServiceConfigured,
    fromNumber,
  };
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return local;
  if (carrierCache && Date.now() - carrierCache.at < CARRIER_CACHE_TTL_MS) {
    return { ...carrierCache.value, messagingServiceConfigured, fromNumber };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}.json`, {
      headers: { Authorization: authHeader() },
      signal: controller.signal,
    });
    if (!res.ok) return local;
    const account = (await res.json()) as TwilioAccountView;
    const rawType = (account.type ?? "").toLowerCase();
    const value: TwilioCarrierStatus = {
      accountType: rawType === "trial" ? "trial" : rawType ? "paid" : null,
      trial: rawType === "trial",
      messagingServiceConfigured,
      fromNumber,
    };
    carrierCache = { value, at: Date.now() };
    return value;
  } catch {
    return local; // timeout / network / parse failure — nulls, never throw
  } finally {
    clearTimeout(timer);
  }
}

export interface SmsDiagnostics {
  checkedAt: string;
  /** Phase 6.3: which gateway actually carries outbound SMS. */
  provider: string;
  twilio: {
    enabled: boolean;
    error: string | null;
    accountStatus: string | null;
    balance: string | null;
    currency: string | null;
  };
  /** Phase 6.3: AfroMessage gateway facts (Ethiopia-native SMS corridor). */
  afro: {
    enabled: boolean;
    /** Masked identifier ID (system short-code) derived from the token JWT */
    identifierId: string | null;
    senderName: string | null;
    callbackConfigured: boolean;
  };
  /** Phase 6.4: TextBee gateway facts (school Android phone + local SIM). */
  textbee: {
    enabled: boolean;
    error: string | null;
    device: {
      id: string | null;
      name: string | null;
      model: string | null;
      enabled: boolean | null;
      lastHeartbeat: string | null;
      heartbeatAgeSeconds: number | null;
      batteryPct: number | null;
      batteryCharging: boolean | null;
      networkType: string | null;
      sentCount: number | null;
      sims: Array<{ subscriptionId: number | null; carrier: string | null; serviceState: string | null }>;
    } | null;
    webhook: {
      url: string | null;
      secretConfigured: boolean;
      registration: string | null;
    };
  };
  sender: {
    messagingServiceSid: string | null;
    messagingServiceName: string | null;
    fromNumber: string | null;
    channelMode: string;
    defaultCountry: string;
    numberInServicePool: boolean | null;
    alphaSender: string | null;
  };
  numbers: Array<{ phone: string; friendlyName: string; sms: boolean }>;
  messagingServices: Array<{ sid: string; friendlyName: string; usecase: string | null; poolSize: number }>;
  destinations: Array<{ prefix: string; country: string; reachable: boolean; pricePerSms: string | null; parents: number }>;
  recommendations: Array<{ severity: "critical" | "warning" | "info"; title: string; detail: string }>;
}

const COUNTRY_PREFIXES: Array<{ prefix: string; country: string; iso: string }> = [
  { prefix: "+251", country: "Ethiopia", iso: "ET" },
  { prefix: "+254", country: "Kenya", iso: "KE" },
  { prefix: "+255", country: "Tanzania", iso: "TZ" },
  { prefix: "+256", country: "Uganda", iso: "UG" },
  { prefix: "+250", country: "Rwanda", iso: "RW" },
  { prefix: "+252", country: "Somalia", iso: "SO" },
  { prefix: "+253", country: "Djibouti", iso: "DJ" },
  { prefix: "+249", country: "Sudan", iso: "SD" },
  { prefix: "+243", country: "DR Congo", iso: "CD" },
  { prefix: "+234", country: "Nigeria", iso: "NG" },
  { prefix: "+233", country: "Ghana", iso: "GH" },
  { prefix: "+20", country: "Egypt", iso: "EG" },
  { prefix: "+27", country: "South Africa", iso: "ZA" },
  { prefix: "+1", country: "United States / Canada", iso: "US" },
  { prefix: "+44", country: "United Kingdom", iso: "GB" },
  { prefix: "+971", country: "UAE", iso: "AE" },
  { prefix: "+966", country: "Saudi Arabia", iso: "SA" },
];

interface PricingCountry {
  country: string;
  iso_country: string;
  outbound_sms_prices: Array<{
    carrier: string;
    prices: Array<{ base_price: string; current_price: string }>;
  }>;
}

/** Identifier IDs are semi-sensitive — mask the middle for display. */
function maskIdentifier(id: string | null): string | null {
  if (!id) return null;
  return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export async function runSmsDiagnostics(): Promise<SmsDiagnostics> {
  const config: SmsSenderConfig = await getSmsSenderConfig(true);
  const provider = activeSmsProvider();
  const diagnostics: SmsDiagnostics = {
    checkedAt: new Date().toISOString(),
    provider,
    twilio: { enabled: twilioEnabled(), error: null, accountStatus: null, balance: null, currency: null },
    afro: {
      enabled: afroMessageEnabled(),
      identifierId: maskIdentifier(afroIdentifierId()),
      senderName: config.afroSenderName,
      callbackConfigured: !!(process.env.PUBLIC_BASE_URL ?? process.env.TWILIO_STATUS_CALLBACK_BASE),
    },
    textbee: {
      enabled: textbeeEnabled(),
      error: null,
      device: null,
      webhook: {
        url: textbeeWebhookUrl(),
        secretConfigured: !!(await getTextbeeSigningSecret()),
        registration: null,
      },
    },
    sender: {
      messagingServiceSid: config.messagingServiceSid,
      messagingServiceName: null,
      fromNumber: config.fromNumber,
      channelMode: config.channelMode,
      defaultCountry: config.defaultCountry,
      numberInServicePool: null,
      alphaSender: null,
    },
    numbers: [],
    messagingServices: [],
    destinations: [],
    recommendations: [],
  };

  // ── TextBee active: probe the gateway phone + webhook registration. ──
  if (provider === "textbee") {
    // Kick subscription repair/create (fire-and-forget — never blocks).
    void ensureTextbeeWebhook()
      .then((r) => {
        diagnostics.textbee.webhook.registration = r.detail;
      })
      .catch(() => {});

    try {
      const devices = await textbeeListDevices();
      const device = devices?.find((d) => d.enabled && d.isDefault) ?? devices?.find((d) => d.enabled) ?? devices?.[0] ?? null;
      if (device) {
        const heartbeatAge = device.lastHeartbeat ? Math.round((Date.now() - new Date(device.lastHeartbeat).getTime()) / 1000) : null;
        diagnostics.textbee.device = {
          id: device._id,
          name: device.name,
          model: device.model ? `${device.brand ?? ""} ${device.model}`.trim() : null,
          enabled: device.enabled,
          lastHeartbeat: device.lastHeartbeat ?? null,
          heartbeatAgeSeconds: heartbeatAge,
          batteryPct: device.batteryInfo?.percentage ?? null,
          batteryCharging: device.batteryInfo?.isCharging ?? null,
          networkType: device.networkInfo?.networkType ?? null,
          sentCount: device.sentSMSCount ?? null,
          sims: (device.simInfo?.sims ?? []).map((sim) => ({
            subscriptionId: sim.subscriptionId ?? null,
            carrier: sim.carrierName ?? null,
            serviceState: sim.serviceState ?? null,
          })),
        };

        diagnostics.recommendations.push({
          severity: "info",
          title: "TextBee is the active SMS gateway",
          detail: `Outbound notifications go out over the school's own Android phone (${diagnostics.textbee.device.model ?? "device"}) using the LOCAL SIM — no international corridor, nothing to geo-block. Carrier verdicts arrive via the textbee delivery webhook + a reconcile sweep, so sms_logs show the real sent/delivered/failed truth.`,
        });

        if (!device.enabled) {
          diagnostics.recommendations.push({
            severity: "critical",
            title: "Gateway phone is disabled",
            detail: "The textbee app on the school phone reports Enabled = off. Open the app and toggle the device back on — sends will fail until then.",
          });
        }
        if (heartbeatAge == null || heartbeatAge > 600) {
          diagnostics.recommendations.push({
            severity: "warning",
            title: "Gateway phone heartbeat is stale",
            detail: heartbeatAge == null
              ? "The phone has never reported a heartbeat. Open the textbee app, sign in, and keep it connected."
              : `Last heartbeat was ${Math.round(heartbeatAge / 60)} minutes ago. The phone may be offline/asleep — open the textbee app, plug it in, and disable battery optimization for reliable delivery.`,
          });
        }
        const sims = diagnostics.textbee.device.sims;
        if (sims.length && !sims.some((s) => (s.serviceState ?? "").toUpperCase() === "IN_SERVICE")) {
          diagnostics.recommendations.push({
            severity: "critical",
            title: "No SIM is in service on the gateway phone",
            detail: "Every SIM reports out-of-service — check the SIM slots, signal, and whether the lines have SMS credit/bundles.",
          });
        }
      } else {
        diagnostics.recommendations.push({
          severity: "critical",
          title: "No textbee gateway phone registered",
          detail: "TEXTBEE_API_KEY is set but the account has no usable device. Install the textbee Android app on the school phone (textbee.dev/download), add the device, and keep it online.",
        });
      }
    } catch (err) {
      diagnostics.textbee.error = err instanceof Error ? err.message : String(err);
      diagnostics.recommendations.push({
        severity: "warning",
        title: "TextBee device probe failed",
        detail: `${diagnostics.textbee.error} — the gateway API may be unreachable; sends still proceed but health facts are stale.`,
      });
    }
    if (!diagnostics.textbee.webhook.url) {
      diagnostics.recommendations.push({
        severity: "warning",
        title: "Delivery webhook is not configured",
        detail: "PUBLIC_BASE_URL is unset, so textbee cannot push delivery verdicts — rows wait for the reconcile sweep instead of updating instantly. Set PUBLIC_BASE_URL (e.g. https://your-app.vercel.app).",
      });
    }
    return diagnostics;
  }

  // ── AfroMessage active: no Twilio probing, report the afro corridor state. ──
  if (provider === "afromessage") {
    diagnostics.recommendations.push({
      severity: "info",
      title: "AfroMessage is the active SMS gateway",
      detail: `Outbound notifications go through api.afromessage.com — the Ethiopia-native corridor. Identifier: ${diagnostics.afro.identifierId ?? "(not detected)"}. Sender name: ${config.afroSenderName ?? "default short code"}.${diagnostics.afro.callbackConfigured ? " Delivery callbacks are enabled — carrier verdicts upgrade sms_logs automatically." : ""}`,
    });
    if (!diagnostics.afro.identifierId) {
      diagnostics.recommendations.push({
        severity: "warning",
        title: "AfroMessage identifier not detected",
        detail: "The identifier (system short-code id) could not be decoded from AFROMESSAGE_TOKEN. If sends fail with a sender error, set AFROMESSAGE_IDENTIFIER_ID explicitly (AfroMessage dashboard → your identifier's value).",
      });
    }
    if (!config.afroSenderName) {
      diagnostics.recommendations.push({
        severity: "info",
        title: "No custom Sender Name set",
        detail: "Messages arrive from your identifier's default short code. For a branded FROM (e.g. ATTENDX), register the Sender Name in the AfroMessage dashboard, then save it in the sender configuration above.",
      });
    }
    if (!diagnostics.afro.callbackConfigured) {
      diagnostics.recommendations.push({
        severity: "warning",
        title: "Delivery callbacks are not configured",
        detail: "PUBLIC_BASE_URL is unset, so AfroMessage cannot push delivery verdicts — rows stay at 'sent' forever. Set PUBLIC_BASE_URL (e.g. https://your-app.vercel.app) to receive real delivered/undelivered/failed states.",
      });
    }
    return diagnostics;
  }

  if (!twilioEnabled()) {
    diagnostics.recommendations.push({
      severity: "critical",
      title: "No live SMS gateway is configured",
      detail: "Notifications are simulated only. For Ethiopia set TEXTBEE_API_KEY (recommended — sends via the school's own Android phone and local SIM, impossible to geo-block) or AFROMESSAGE_TOKEN; alternatively set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN for Twilio delivery.",
    });
    return diagnostics;
  }

  // 1. Account + balance
  try {
    const account = await twilioGet<{ status: string }>(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}.json`,
    );
    diagnostics.twilio.accountStatus = account.status;
    const balance = await twilioGet<{ balance: string; currency: string }>(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Balance.json`,
    );
    diagnostics.twilio.balance = balance.balance;
    diagnostics.twilio.currency = balance.currency;
    if (Number(balance.balance) < 5) {
      diagnostics.recommendations.push({
        severity: "warning",
        title: `Low Twilio balance (${balance.currency} ${balance.balance})`,
        detail: "Top up to avoid delivery outages. International SMS (e.g. to Ethiopia) costs ~$0.34/message.",
      });
    }
  } catch (err) {
    diagnostics.twilio.error = err instanceof Error ? err.message : String(err);
    diagnostics.recommendations.push({
      severity: "critical",
      title: "Twilio credentials rejected",
      detail: `${diagnostics.twilio.error} — verify TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN. (Common cause: Twilio error 20003.)`,
    });
    return diagnostics;
  }

  // 2. Numbers + messaging services (+ pools) — tolerate partial failures
  try {
    const numbers = await twilioGet<{ incoming_phone_numbers: TwilioIncomingNumber[] }>(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PageSize=50`,
    );
    diagnostics.numbers = numbers.incoming_phone_numbers.map((n) => ({
      phone: n.phone_number,
      friendlyName: n.friendly_name,
      sms: n.capabilities?.sms ?? false,
    }));
  } catch (err) {
    logger.warn({ err }, "diagnostics: numbers fetch failed");
  }

  try {
    const services = await twilioGet<{ services: TwilioMessagingService[] }>(
      `https://messaging.twilio.com/v1/Services?PageSize=20`,
    );
    for (const svc of services.services) {
      let pool: TwilioServicePhoneNumber[] = [];
      try {
        const poolRes = await twilioGet<{ phone_numbers: TwilioServicePhoneNumber[] }>(
          `https://messaging.twilio.com/v1/Services/${svc.sid}/PhoneNumbers?PageSize=50`,
        );
        pool = poolRes.phone_numbers;
      } catch {
        /* pool is optional */
      }
      diagnostics.messagingServices.push({
        sid: svc.sid,
        friendlyName: svc.friendly_name,
        usecase: svc.usecase ?? null,
        poolSize: pool.length,
      });
      if (config.messagingServiceSid && svc.sid === config.messagingServiceSid) {
        diagnostics.sender.messagingServiceName = svc.friendly_name;
        diagnostics.sender.numberInServicePool =
          config.fromNumber == null ? null : pool.some((p) => p.phone_number === config.fromNumber);
        try {
          const alphaSenders = await twilioGet<{ alpha_senders: TwilioAlphaSender[] }>(
            `https://messaging.twilio.com/v1/Services/${svc.sid}/AlphaSenders?PageSize=50`,
          );
          diagnostics.sender.alphaSender = alphaSenders.alpha_senders?.[0]?.alpha_sender ?? null;
        } catch (err) {
          // Alpha Sender support may be disabled on the account; diagnostics
          // should still return the rest of the service and number-pool data.
          logger.warn({ err }, "diagnostics: configured service alpha sender fetch failed");
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "diagnostics: messaging services fetch failed");
  }

  // 3. Destination reachability from the actual parent phone numbers on file
  let ethiopiaParentCount = 0;
  try {
    const parents = await db
      .select({ phone: studentsTable.parentPhone })
      .from(studentsTable);
    const byPrefix = new Map<string, number>();
    for (const row of parents) {
      const normalized = normalizePhone(row.phone, config.defaultCountry);
      if (!normalized) continue;
      const match = COUNTRY_PREFIXES.find((c) => normalized.startsWith(c.prefix));
      if (!match) continue;
      byPrefix.set(match.prefix, (byPrefix.get(match.prefix) ?? 0) + 1);
    }
    for (const { prefix, parents: count } of [...byPrefix.entries()].map(([prefix, parents]) => ({ prefix, parents }))) {
      const meta = COUNTRY_PREFIXES.find((c) => c.prefix === prefix)!;
      if (meta.iso === "ET") ethiopiaParentCount = count;
      let reachable = false;
      let price: string | null = null;
      try {
        const pricing = await twilioGet<PricingCountry>(
          `https://pricing.twilio.com/v1/Messaging/Countries/${meta.iso}`,
        );
        const prices = pricing.outbound_sms_prices?.flatMap((c) => c.prices) ?? [];
        reachable = prices.length > 0;
        price = prices[0]?.current_price ?? null;
      } catch {
        reachable = false;
      }
      diagnostics.destinations.push({ prefix, country: meta.country, reachable, pricePerSms: price, parents: count });
      if (!reachable) {
        diagnostics.recommendations.push({
          severity: "critical",
          title: `${meta.country} (${prefix}) looks unreachable from this Twilio account`,
          detail: `${count} parent number(s) start with ${prefix} but Twilio reports no outbound SMS pricing for ${meta.country}. Try the WhatsApp channel (Operations → SMS Health → channel mode 'auto') or a registered local sender.`,
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "diagnostics: destination analysis failed");
  }

  // 4. Verify that the effective Messaging Service belongs to this account
  // and that its sender pool can meet destination-specific rules.
  const configuredService = config.messagingServiceSid
    ? diagnostics.messagingServices.find((service) => service.sid === config.messagingServiceSid)
    : undefined;

  if (config.messagingServiceSid && !configuredService) {
    diagnostics.recommendations.push({
      severity: "critical",
      title: "Configured Messaging Service was not found in this Twilio account",
      detail: `AttendX is using ${config.messagingServiceSid}, but Twilio did not return that service for the configured credentials. Confirm the SID belongs to the same account as TWILIO_ACCOUNT_SID, then correct the effective Messaging Service SID.`,
    });
  } else if (config.messagingServiceSid && configuredService && configuredService.poolSize === 0 && !diagnostics.sender.alphaSender) {
    diagnostics.recommendations.push({
      severity: "warning",
      title: "Configured Messaging Service has no detected senders",
      detail: `Service ${config.messagingServiceSid} is set, but AttendX found neither a phone number nor an Alphanumeric Sender ID in its sender pool. Add a supported sender in Twilio Console → Messaging → Services → Sender Pool.`,
    });
  } else if (config.messagingServiceSid && configuredService && config.fromNumber && diagnostics.sender.numberInServicePool === false) {
    diagnostics.recommendations.push({
      severity: "warning",
      title: "Configured fallback number is not in this service's pool",
      detail: `AttendX is using Messaging Service ${config.messagingServiceSid}, but ${config.fromNumber} is not among its phone-number senders. The service may still use an attached Alphanumeric Sender ID; verify its sender pool in Twilio Console.`,
    });
  } else if (config.messagingServiceSid && configuredService) {
    diagnostics.recommendations.push({
      severity: "info",
      title: "Messaging Service routing is active",
      detail: `Sender service: ${diagnostics.sender.messagingServiceName ?? config.messagingServiceSid}.${diagnostics.sender.alphaSender ? ` Alphanumeric Sender ID "${diagnostics.sender.alphaSender}" is attached.` : " No Alphanumeric Sender ID was found on this service."} Twilio still applies destination-specific sender rules.`,
    });
  } else if (!config.messagingServiceSid && config.fromNumber) {
    diagnostics.recommendations.push({
      severity: "warning",
      title: "AttendX is sending from a direct phone number",
      detail: `The active From number is ${config.fromNumber}. Use a Messaging Service to manage eligible senders; this does not bypass destination-specific registration or network restrictions.`,
    });
  }

  if (ethiopiaParentCount > 0) {
    const senderNote = diagnostics.sender.alphaSender
      ? `The configured service has Alpha Sender "${diagnostics.sender.alphaSender}", but this check cannot confirm that Twilio has registered it for Ethiopia.`
      : "No Alphanumeric Sender ID was found on AttendX's effective Messaging Service.";
    diagnostics.recommendations.push({
      severity: "warning",
      title: "Ethiopia: verify a registered Alphanumeric Sender ID",
      detail: `${ethiopiaParentCount} parent number(s) are in +251. Twilio's current Ethiopia guidance says unregistered Sender IDs to Ethio Telecom are blocked from October 8, 2026, and international long codes are not supported on that network. ${senderNote} Register the sender ID for Ethiopia, add it to the effective Messaging Service's Sender Pool, and verify the recipient's carrier; a service SID or geographic-permissions toggle alone is not enough.`,
    });
  }

  if (config.channelMode === "sms") {
    diagnostics.recommendations.push({
      severity: "info",
      title: "WhatsApp fallback is off",
      detail: "Channel mode is 'sms'. Switch to 'auto' so unreachable SMS destinations retry over WhatsApp automatically.",
    });
  }
  if (!config.fromNumber && !config.messagingServiceSid) {
    diagnostics.recommendations.push({
      severity: "critical",
      title: "No sender configured",
      detail: "Set a Messaging Service SID or From number in Operations → SMS Health (or TWILIO_FROM_NUMBER / TWILIO_MESSAGING_SERVICE_SID env vars).",
    });
  }

  return diagnostics;
}
