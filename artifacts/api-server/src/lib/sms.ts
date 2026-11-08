import { db, smsLogsTable } from "@workspace/db";
import { logger } from "./logger";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

function twilioEnabled(): boolean {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM);
}

/**
 * Delivery failure with provider detail. `retryable` distinguishes transient
 * problems (network, 5xx, rate limits) from configuration faults (20003 bad
 * auth token, 21211 invalid From, 21608 unverified destination) so the job
 * runner never burns retries on a misconfigured account.
 */
export class SmsDeliveryError extends Error {
  readonly provider: string;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, options: { provider: string; code?: string | null; retryable?: boolean } = { provider: "twilio" }) {
    super(message);
    this.name = "SmsDeliveryError";
    this.provider = options.provider;
    this.code = options.code ?? null;
    this.retryable = options.retryable ?? false;
  }
}

interface TwilioErrorBody {
  code?: number;
  message?: string;
  more_info?: string;
  status?: number;
}

async function sendViaTwilio(to: string, body: string): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: TWILIO_FROM!, Body: body });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (err) {
    // Network-level failure (DNS, timeout, reset) — worth retrying.
    throw new SmsDeliveryError(`Twilio unreachable: ${err instanceof Error ? err.message : String(err)}`, { provider: "twilio", retryable: true });
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
    const retryable = res.status >= 500 || code === "429" || code === "20429";
    throw new SmsDeliveryError(
      `Twilio ${code ?? res.status}: ${message}${parsed?.more_info ? ` (${parsed.more_info})` : ""}`,
      { provider: "twilio", code, retryable },
    );
  }
}

export async function sendSms(params: {
  studentId: number;
  parentPhone: string;
  message: string;
}): Promise<"sent"> {
  const { studentId, parentPhone, message } = params;

  const provider = twilioEnabled() ? "twilio" : "simulation";

  try {
    if (twilioEnabled()) {
      logger.info({ studentId }, "Sending Twilio SMS");
      await sendViaTwilio(parentPhone, message);
      logger.info({ studentId }, "Twilio SMS sent successfully");
    } else {
      logger.info({ studentId }, "[SIMULATED] SMS notification logged");
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error({ err, studentId }, "Failed to send SMS");
    await db.insert(smsLogsTable).values({
      studentId,
      parentPhone,
      message,
      status: "failed",
      provider,
      errorMessage: detail,
    });
    if (err instanceof SmsDeliveryError) throw err;
    throw new SmsDeliveryError(detail, { provider, retryable: true });
  }

  await db.insert(smsLogsTable).values({
    studentId,
    parentPhone,
    message,
    status: "sent",
    provider,
    errorMessage: null,
  });
  return "sent";
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
