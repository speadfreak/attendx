import { db, smsLogsTable } from "@workspace/db";
import { logger } from "./logger";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

function twilioEnabled(): boolean {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM);
}

async function sendViaTwilio(to: string, body: string): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: TWILIO_FROM!, Body: body });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twilio error: ${err}`);
  }
}

export async function sendSms(params: {
  studentId: number;
  parentPhone: string;
  message: string;
}): Promise<void> {
  const { studentId, parentPhone, message } = params;

  let status = "sent";
  let errorMessage: string | null = null;
  const provider = twilioEnabled() ? "twilio" : "simulation";

  try {
    if (twilioEnabled()) {
      logger.info({ studentId, parentPhone }, "Sending Twilio SMS");
      await sendViaTwilio(parentPhone, message);
      logger.info({ studentId }, "Twilio SMS sent successfully");
    } else {
      logger.info({ studentId, parentPhone }, "[SIMULATED] SMS notification logged");
    }
  } catch (err) {
    status = "failed";
    errorMessage = String(err);
    logger.error({ err, studentId }, "Failed to send SMS");
  }

  await db.insert(smsLogsTable).values({
    studentId,
    parentPhone,
    message,
    status,
    provider,
    errorMessage,
  });
}

export function buildPresentMessage(studentName: string, time: string): string {
  return `FaceTrack: ${studentName} arrived in class at ${time}. All is well.`;
}

export function buildAbsentMessage(studentName: string): string {
  return `FaceTrack Alert: ${studentName} has not arrived in class. Please check immediately.`;
}

export function buildLateMessage(studentName: string, time: string): string {
  return `FaceTrack: ${studentName} arrived late to class at ${time}.`;
}
