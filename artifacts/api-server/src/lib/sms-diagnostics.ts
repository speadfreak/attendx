import { db, studentsTable } from "@workspace/db";
import { twilioEnabled, getSmsSenderConfig, normalizePhone, type SmsSenderConfig } from "./sms";
import { logger } from "./logger";

/**
 * Live Twilio account diagnostics for the Operations → SMS Health card.
 * Uses the Twilio REST API (read-only) to verify credentials, inspect the
 * sender configuration and produce prioritized, actionable recommendations —
 * most importantly: detecting when a Messaging Service exists and should be
 * used instead of a raw US long code `From` (the classic Twilio 21612 trap
 * when notifying Ethiopian parents).
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

export interface SmsDiagnostics {
  checkedAt: string;
  twilio: {
    enabled: boolean;
    error: string | null;
    accountStatus: string | null;
    balance: string | null;
    currency: string | null;
  };
  sender: {
    messagingServiceSid: string | null;
    messagingServiceName: string | null;
    fromNumber: string | null;
    channelMode: string;
    defaultCountry: string;
    numberInServicePool: boolean | null;
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

export async function runSmsDiagnostics(): Promise<SmsDiagnostics> {
  const config: SmsSenderConfig = await getSmsSenderConfig(true);
  const diagnostics: SmsDiagnostics = {
    checkedAt: new Date().toISOString(),
    twilio: { enabled: twilioEnabled(), error: null, accountStatus: null, balance: null, currency: null },
    sender: {
      messagingServiceSid: config.messagingServiceSid,
      messagingServiceName: null,
      fromNumber: config.fromNumber,
      channelMode: config.channelMode,
      defaultCountry: config.defaultCountry,
      numberInServicePool: null,
    },
    numbers: [],
    messagingServices: [],
    destinations: [],
    recommendations: [],
  };

  if (!twilioEnabled()) {
    diagnostics.recommendations.push({
      severity: "critical",
      title: "Twilio is not configured",
      detail: "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables to enable live delivery. Without them, notifications are simulated only.",
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
      }
    }
  } catch (err) {
    logger.warn({ err }, "diagnostics: messaging services fetch failed");
  }

  // 3. Destination reachability from the actual parent phone numbers on file
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

  // 4. The 21612-class recommendation — the whole reason this card exists
  if (!config.messagingServiceSid && diagnostics.messagingServices.length > 0) {
    const first = diagnostics.messagingServices[0];
    diagnostics.recommendations.push({
      severity: "critical",
      title: "Sending with a raw From number — international SMS will fail (Twilio 21612)",
      detail: `US/CA long codes direct-dialing destinations like Ethiopia are rejected. Your account has Messaging Service "${first.friendlyName}" (${first.sid}${first.poolSize ? `, ${first.poolSize} number(s) in pool` : ""}). FIX: paste that SID into Operations → SMS Health → Messaging Service SID (or set TWILIO_MESSAGING_SERVICE_SID). This is the single change that makes Ethiopian delivery work.`,
    });
  } else if (config.messagingServiceSid && diagnostics.sender.numberInServicePool === false) {
    diagnostics.recommendations.push({
      severity: "warning",
      title: "Configured Messaging Service has no numbers in its pool",
      detail: `Service ${config.messagingServiceSid} is set, but no sender number is in its pool. Add your Twilio number to the service in the Twilio console → Messaging → Services → Sender Pool.`,
    });
  } else if (config.messagingServiceSid) {
    diagnostics.recommendations.push({
      severity: "info",
      title: "Messaging Service routing is active",
      detail: `Sender: ${diagnostics.sender.messagingServiceName ?? config.messagingServiceSid}. International routing (incl. Ethiopia) is handled by Twilio's copilot.`,
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
