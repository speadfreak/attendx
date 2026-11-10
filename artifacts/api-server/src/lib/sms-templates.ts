import { settingValue } from "./system-settings";
import { formatLocalClock } from "./attendance-rules";

/**
 * Editable SMS message templates stored in system_settings.
 * Variables: {student_name} {time} {classroom} {status} {school}
 * The absent template is now actually wired into the end-of-day sweep and
 * manual absent marks (previously built but never sent).
 */

export const SMS_TEMPLATE_KEYS = {
  present: "sms_template_present",
  late: "sms_template_late",
  absent: "sms_template_absent",
} as const;

export type SmsTemplateKey = keyof typeof SMS_TEMPLATE_KEYS;

export const DEFAULT_SMS_TEMPLATES: Record<SmsTemplateKey, string> = {
  present: "AttendX: {student_name} arrived in class at {time}. All is well.",
  late: "AttendX: {student_name} arrived late to class at {time}.",
  absent: "AttendX alert: {student_name} has not arrived in class. Please check immediately.",
};

export async function getSmsTemplates(): Promise<Record<SmsTemplateKey, string>> {
  const [present, late, absent] = await Promise.all([
    settingValue<string>(SMS_TEMPLATE_KEYS.present, DEFAULT_SMS_TEMPLATES.present),
    settingValue<string>(SMS_TEMPLATE_KEYS.late, DEFAULT_SMS_TEMPLATES.late),
    settingValue<string>(SMS_TEMPLATE_KEYS.absent, DEFAULT_SMS_TEMPLATES.absent),
  ]);
  return { present, late, absent };
}

export function renderTemplate(
  template: string,
  vars: { studentName: string; time: string; classroom?: string | null; status?: string; school?: string },
): string {
  const map: Record<string, string> = {
    student_name: vars.studentName,
    time: vars.time,
    classroom: vars.classroom || "school",
    status: vars.status || "attendance",
    school: vars.school || "AttendX",
    date: new Date().toISOString().slice(0, 10),
  };
  return template.replace(/\{(student_name|time|classroom|status|school|date)\}/g, (_, key) => map[key] ?? "");
}

export async function buildStatusMessage(
  status: "present" | "late" | "absent",
  studentName: string,
  classroom?: string | null,
  at?: Date,
  timezone = "Africa/Addis_Ababa",
): Promise<string> {
  const templates = await getSmsTemplates();
  const time = formatLocalClock(at ?? new Date(), timezone);
  return renderTemplate(templates[status], { studentName, time, classroom, status });
}
