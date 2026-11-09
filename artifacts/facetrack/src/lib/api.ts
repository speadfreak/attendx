/**
 * AttendX Phase 3 API layer — hand-typed endpoints for the new feature
 * surfaces (QR system, reviews, notifications, reports, seats, live events).
 * Uses the same auth token as the generated client.
 */

const BASE = import.meta.env.BASE_URL ?? "/";

export function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
  const token = localStorage.getItem("ft_token");
  return fetch(`${BASE}api${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token ?? ""}`,
      ...(opts?.headers ?? {}),
    },
  });
}

async function j<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await apiFetch(path, opts);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let body: unknown = null;
    try {
      body = await res.json();
      if ((body as { error?: string } | null)?.error) message = (body as { error: string }).error;
    } catch {
      /* ignore */
    }
    // Attach the parsed body + status so callers can recover server verdicts
    // from non-2xx scan responses (e.g. geofence-violation carries its own
    // result + distance message in the body, not in `error`).
    throw Object.assign(new Error(message), { status: res.status, body });
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return j<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}
export function put<T>(path: string, body?: unknown): Promise<T> {
  return j<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) });
}
export function patch<T>(path: string, body?: unknown): Promise<T> {
  return j<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });
}
export function get<T>(path: string): Promise<T> {
  return j<T>(path, { method: "GET" });
}
export function del<T>(path: string, body?: unknown): Promise<T> {
  return j<T>(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) });
}

// ── Types ───────────────────────────────────────────────────────

export interface StudentSummary {
  student: {
    id: number;
    name: string;
    studentId: string;
    parentPhone: string;
    classroomId: number | null;
    photoUrl: string | null;
    hasFaceEncoding: boolean;
  };
  heatmap: Array<{ day: string; status: string; method: string; confidence: number | null }>;
  streaks: { current: number; longest: number };
  stats: { present: number; late: number; absent: number; marked: number; rate: number | null };
  confidenceTrend: Array<{ at: string; confidence: number; source: string }>;
  sms: Array<{ id: number; message: string; status: string; provider: string; sentAt: string }>;
  qr: { active: boolean; serial?: string; expiresAt?: string | null; version?: number; lastScanAt?: string | null; scans?: number };
  seat: { seatLabel: string; rowIdx: number; colIdx: number } | null;
}

export interface QrIssueRow {
  id: number;
  studentId: number;
  studentName: string | null;
  studentRef: string | null;
  classroomId: number | null;
  classroomName: string | null;
  version: number;
  serial: string;
  label: string;
  expiresAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
  revokeReason: string | null;
  scans: number;
  lastScanAt: string | null;
  createdAt: string;
  state: "active" | "expired" | "revoked";
}

export interface QrIssueResult {
  studentId: number;
  name: string;
  token: string;
  serial: string;
  expiresAt: string | null;
  version: number;
}

/**
 * Extra terminal-scan fields (Phase 6 offline kiosk + geofence).
 * Field names mirror the server `scanInput` zod schema in
 * artifacts/api-server/src/routes/qr.ts — note the server field is
 * `accuracy` (GPS accuracy in meters).
 */
export interface QrScanExtras {
  /** Client idempotency key — one nonce = one outcome ever (replays are safe). */
  nonce?: string;
  /** ISO timestamp of the scan moment (offline spool replays count at door time). */
  scannedAt?: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
}

/** One item of the offline spool flush body (`{ scans: [...] }`). */
export interface QrScanBatchItem extends QrScanExtras {
  token: string;
  terminalId?: string;
  classroomId?: number;
}

/** Per-scan outcome inside a batch response (`ok === httpCode < 400`). */
export interface QrScanBatchResultItem {
  nonce: string | null;
  ok: boolean;
  result: string | null;
  httpCode: number;
  message: string | null;
  studentName?: string | null;
  attendanceId?: number | null;
}

export interface QrScanBatchResponse {
  ok: boolean;
  accepted: number;
  total: number;
  rejected: number;
  results: QrScanBatchResultItem[];
}

export interface QrScanResponse {
  ok: boolean;
  result:
    | "valid"
    | "duplicate"
    | "expired"
    | "revoked"
    | "unknown-badge"
    | "stale-version"
    | "bad-signature"
    | "not-attendx-qr"
    | "malformed"
    | "student-gone"
    | "geofence-violation"
    | "too-old"
    | "clock-skew"
    | "server-error"
    | string;
  alreadyMarked?: boolean;
  /** True when the nonce was already processed — the original result is returned. */
  replayed?: boolean;
  /** Proxy-fraud AI score (0 = clean; > 0 = flagged for review). */
  fraudScore?: number;
  /** Anomaly kinds behind the fraud score. */
  fraudSignals?: string[];
  /** True when the scan was committed from the offline spool flush. */
  spooled?: boolean;
  student?: { id: number; name: string; studentId: string; classroomId: number | null };
  attendance?: { id: number; status: string; markedAt?: string; checkedOutAt?: string | null };
  message: string;
}

export interface QrScanLogRow {
  id: number;
  studentId: number | null;
  studentName: string | null;
  terminalId: string;
  result: string;
  status: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface QrStats {
  activeBadges: number;
  revokedBadges: number;
  validScansToday: number;
  anomaliesToday: number;
  studentsWithoutActiveBadge: number;
}

export interface ReviewRow {
  id: number;
  studentId: number | null;
  studentName: string | null;
  studentRef?: string | null;
  classroomId: number | null;
  classroomName: string | null;
  confidence: number;
  source: string;
  status: string;
  createdAt: string;
  expectedSeat?: string | null;
  hasFaceData?: boolean;
}

export interface ReviewCandidates {
  reviewId: number;
  expectedSeat: string | null;
  hasDescriptor: boolean;
  candidates: Array<{ studentId: number; name: string; studentRef: string; distance: number; confidence: number }>;
}

export interface NotificationFeed {
  items: Array<{
    id: string;
    severity: "critical" | "warning" | "info";
    category: "review" | "device" | "job" | "qr" | "system" | "gate";
    title: string;
    detail: string;
    at: string;
    link: string;
  }>;
  counts: { total: number; critical: number; warning: number; pendingReviews: number };
}

export interface Occupancy {
  count: number;
  checkedOut: number;
  capacity: number;
  people: Array<{
    studentId: number;
    studentName: string;
    classroomName: string | null;
    status: string;
    method: string;
    since: string;
  }>;
}

export interface SeatRow {
  id: number;
  seatLabel: string;
  rowIdx: number;
  colIdx: number;
  studentId: number | null;
  studentName: string | null;
  studentRef: string | null;
}

export interface HeatmapReport {
  days: string[];
  rows: Array<{
    studentId: number;
    studentName: string;
    classroomId: number | null;
    presentCount: number;
    lateCount: number;
    absentCount: number;
    markedDays: number;
    attendanceRate: number | null;
    avgConfidence: number | null;
    days: Record<string, { status: string; confidence: number | null; method: string }>;
  }>;
}

export interface ReportSummary {
  from: string;
  to: string;
  generatedAt: string;
  totals: { present: number; late: number; absent: number; marked: number };
  methodBreakdown: Record<string, number>;
  uniqueStudents: number;
  totalStudents: number;
  classrooms: Array<{
    classroomId: number | null;
    classroomName: string;
    present: number;
    late: number;
    absent: number;
    marked: number;
    rate: number;
    methods: Record<string, number>;
  }>;
  daily: Array<{ day: string; present: number; late: number; absent: number }>;
}

export interface AuditRow {
  id: number;
  actorAdminId: number | null;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SearchResults {
  students: Array<{ id: number; name: string; studentId: string; classroomName: string | null }>;
  classrooms: Array<{ id: number; name: string; teacherName: string | null }>;
}

export interface BulkEnrollResult {
  created: number[];
  updated: number[];
  failed: Array<{ studentId: string; reason: string }>;
  qrIssued: number;
}

// ── Gate integrity (Phase 4) ────────────────────────────────────

export type GateVerdict = "ok" | "missed_detections" | "sensor_conflict";
export type GateSimulateMode = "missed_detections" | "sensor_conflict";

export interface GateIntegrityCurrent {
  gateId: string;
  windowStart: string;
  windowEnd: string;
  partialSecondsLeft: number;
  camera: number;
  ultrasonic: number;
  ir: number;
  verdict: GateVerdict;
  discrepancyPct: number;
  windowSeconds: number;
  withinGateHours: boolean;
  timezone: string;
  gateActiveFrom: string;
  gateActiveTo: string;
}

export interface GateWindowPoint {
  windowStart: string;
  windowEnd: string;
  camera: number;
  ultrasonic: number;
  ir: number;
  alerts: string[];
}

export interface GateWindowSeries {
  windowSeconds: number;
  discrepancyPct: number;
  series: GateWindowPoint[];
}

export interface GateAlertRow {
  id: number;
  gateId: string;
  windowStart: string;
  windowEnd: string;
  cameraCount: number;
  ultrasonicCount: number;
  irCount: number;
  alertType: GateSimulateMode;
  resolved: boolean;
  resolvedAt: string | null;
  resolveNote: string | null;
  simulated: boolean;
  createdAt: string;
}

export interface GateSensorEvent {
  id: number;
  sensor: "ultrasonic" | "ir_beam";
  occurredAt: string;
  simulated: boolean;
  piDeviceId: string | null;
}

export interface GateAlertDetail extends GateAlertRow {
  detail: Record<string, unknown>;
  sensorEvents: GateSensorEvent[];
}

export interface GateValidationResult {
  ran: boolean;
  windowsEvaluated: number;
  alertsCreated: Array<{ id: number; alertType: string; windowStart: string; simulated: boolean }>;
}

export interface GateSimulateResult {
  simulated: boolean;
  mode: GateSimulateMode;
  injected: number;
  validation: Record<string, unknown>;
  alertIds: number[];
}

// ── System settings (attendance time rules + gate integrity) ────

export interface SystemSettingsExtended {
  confidenceThreshold: number;
  reviewRetentionDays: number;
  fanMode: "auto" | "on" | "off";
  entranceTime: string;
  lateCutoffTime: string;
  absenceCutoffTime: string;
  attendanceTimezone: string;
  gateDiscrepancyPct: number;
  gateWindowSeconds: number;
  gateActiveFrom: string;
  gateActiveTo: string;
  smsChannelMode: "sms" | "whatsapp" | "auto";
  smsMessagingServiceSid: string | null;
  smsFromNumber: string | null;
  smsDefaultCountry: string;
  updatedAt: string | null;
}

export interface SystemSettingsPatch {
  confidenceThreshold?: number;
  reviewRetentionDays?: number;
  entranceTime?: string;
  lateCutoffTime?: string;
  absenceCutoffTime?: string;
  attendanceTimezone?: string;
  gateDiscrepancyPct?: number;
  gateWindowSeconds?: number;
  gateActiveFrom?: string;
  gateActiveTo?: string;
  smsChannelMode?: "sms" | "whatsapp" | "auto";
  /** Twilio Messaging Service SID (MG…) — empty string clears */
  smsMessagingServiceSid?: string;
  /** E.164 sender — empty string clears */
  smsFromNumber?: string;
  smsDefaultCountry?: string;
}

// ── Absence Risk Radar (Phase 5) ─────────────────────────────────

export type RiskLevel = "low" | "watch" | "elevated" | "critical";

export interface StudentRisk {
  studentId: number;
  name: string;
  studentCode: string;
  classroomId: number | null;
  classroomName: string | null;
  score: number;
  level: RiskLevel;
  windowDays: number;
  schoolDays: number;
  absentDays: number;
  lateDays: number;
  absenceRate: number;
  lateRate: number;
  consecutiveAbsences: number;
  trend: number;
  lastPresentAt: string | null;
  reasons: string[];
}

export interface AbsenceRiskSummary {
  windowDays: number;
  levelCounts: Record<RiskLevel, number>;
  top: StudentRisk[];
}

// ── SMS Delivery Health (Phase 5) ─────────────────────────────

export interface SmsConfigStatus {
  twilioEnabled: boolean;
  channelMode: "sms" | "whatsapp" | "auto";
  hasMessagingService: boolean;
  hasFromNumber: boolean;
  messagingServiceSid: string | null;
  fromNumber: string | null;
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
  /** Phase 6: sends still awaiting a carrier verdict (additive, may be absent on older API). */
  pendingDelivery?: number;
}

/** GET /sms-logs/health — cheap local delivery stats powering the SMS Health card. */
export interface SmsDeliveryHealth {
  pendingDelivery: number;
  byStatus: Record<string, number>;
}

export interface SmsTestSendResult {
  ok: boolean;
  normalizedTo: string;
  sender: { via: "messaging-service" | "from-number"; messagingServiceSid: string | null; fromNumber: string | null };
  attempts: Array<{ channel: string; ok: boolean; error: { message: string; code: string | null; fix: string | null } | null }>;
  error: { message: string; code: string | null; fix: string | null } | null;
}

// ── Endpoint wrappers ───────────────────────────────────────────

/**
 * Offline kiosk spool flush — POST /qr/scan/batch with `{ scans: [...] }`
 * (server zod: `batchInput = z.object({ scans: z.array(scanInput).min(1).max(200) })`).
 * Per-item outcomes arrive in `results[]` with `ok === httpCode < 400`.
 */
export function qrScanBatch(items: QrScanBatchItem[]): Promise<QrScanBatchResponse> {
  return post<QrScanBatchResponse>("/qr/scan/batch", { scans: items });
}

export const api = {
  studentSummary: (id: number) => get<StudentSummary>(`/students/${id}/summary`),
  bulkEnroll: (rows: unknown, issueQr: boolean) =>
    post<BulkEnrollResult>("/students/bulk", { rows, issueQr }),
  checkOut: (studentId: number) => post<{ ok: boolean }>("/students/check-out", { studentId }),

  occupancy: () => get<Occupancy>("/dashboard/occupancy"),
  trend: (range: "today" | "week" | "month") =>
    get<Array<{ date: string; present: number; absent: number; late: number }>>(`/dashboard/attendance-trend?range=${range}`),

  seats: (classroomId: number) => get<SeatRow[]>(`/classrooms/${classroomId}/seats`),
  saveSeats: (classroomId: number, seats: Array<{ seatLabel: string; rowIdx: number; colIdx: number; studentId: number | null }>) =>
    put<SeatRow[]>(`/classrooms/${classroomId}/seats`, { seats }),

  qrIssue: (studentIds: number[], expiresInDays: number | null, label: string = "id-card") =>
    post<{ issued: QrIssueResult[]; skipped: Array<{ studentId: number; reason: string }> }>("/qr/issue", { studentIds, expiresInDays, label }),
  qrIssueAll: (classroomId: number, expiresInDays: number | null) =>
    post<{ issued: QrIssueResult[]; skipped: Array<{ studentId: number; reason: string }> }>(`/qr/classrooms/${classroomId}/issue-all`, { expiresInDays }),
  qrRotate: (studentId: number) =>
    post<QrIssueResult>(`/qr/students/${studentId}/rotate`, {}),
  qrRevoke: (issueId: number, reason?: string) =>
    post<{ ok: boolean }>(`/qr/issues/${issueId}/revoke`, { reason: reason ?? "revoked-by-admin" }),
  qrIssues: (params?: { studentId?: number; classroomId?: number }) => {
    const q = new URLSearchParams();
    if (params?.studentId) q.set("studentId", String(params.studentId));
    if (params?.classroomId) q.set("classroomId", String(params.classroomId));
    const qs = q.toString();
    return get<QrIssueRow[]>(`/qr/issues${qs ? `?${qs}` : ""}`);
  },
  qrScanLogs: (limit = 60) => get<QrScanLogRow[]>(`/qr/scan-logs?limit=${limit}`),
  qrStats: () => get<QrStats>("/qr/stats"),
  qrScan: (token: string, terminalId: string, classroomId?: number, extra?: QrScanExtras) =>
    post<QrScanResponse>("/qr/scan", { token, terminalId, classroomId, ...extra }),
  /** Offline kiosk spool flush (same endpoint as the standalone qrScanBatch). */
  qrScanBatch: (items: QrScanBatchItem[]) => qrScanBatch(items),
  qrTerminalStats: (terminalId: string) => get<{ valid: number; duplicate: number; anomalies: number }>(`/qr/terminal-stats?terminalId=${encodeURIComponent(terminalId)}`),

  reviews: () => get<ReviewRow[]>("/reviews"),
  reviewCandidates: (id: number) => get<ReviewCandidates>(`/reviews/${id}/candidates`),
  reviewDecision: (id: number, decision: "approve" | "reject" | "reassign", studentId?: number | null, note?: string | null) =>
    post<{ review: ReviewRow; attendance: Record<string, unknown> | null }>(`/reviews/${id}/decision`, { decision, studentId: studentId ?? null, note: note ?? null }),

  notifications: () => get<NotificationFeed>("/notifications"),

  heatmapReport: (classroomId: number | null, days = 42) =>
    get<HeatmapReport>(`/reports/heatmap?days=${days}${classroomId ? `&classroomId=${classroomId}` : ""}`),
  reportSummary: (from: string, to: string) =>
    get<ReportSummary>(`/reports/summary?from=${from}&to=${to}`),

  auditLogs: (limit = 150) => get<AuditRow[]>(`/audit-logs?limit=${limit}`),
  search: (q: string) => get<SearchResults>(`/search?q=${encodeURIComponent(q)}`),

  smsTemplates: () => get<{ present: string; late: string; absent: string }>("/sms-templates"),
  saveSmsTemplates: (templates: { present?: string; late?: string; absent?: string }) =>
    put<{ present: string; late: string; absent: string }>("/sms-templates", templates),

  absentSweep: () => post<{ markedAbsent: number; smsQueued: number }>("/attendance/absent-sweep"),

  // Gate integrity
  gateCurrent: () => get<GateIntegrityCurrent>("/gate/integrity/current"),
  gateWindows: (minutes = 60) => get<GateWindowSeries>(`/gate/integrity/windows?minutes=${minutes}`),
  gateAlerts: (resolved?: boolean) =>
    get<GateAlertRow[]>(`/gate/integrity/alerts${resolved === undefined ? "" : `?resolved=${resolved}`}`),
  gateAlertDetail: (id: number) => get<GateAlertDetail>(`/gate/integrity/alerts/${id}`),
  gateResolveAlert: (id: number, note?: string) =>
    post<{ ok: boolean }>(`/gate/integrity/alerts/${id}/resolve`, { note: note?.trim() || undefined }),
  gateRunValidation: () => post<GateValidationResult>("/gate/integrity/run", {}),
  gateSimulate: (mode?: GateSimulateMode) =>
    post<GateSimulateResult>("/gate/integrity/simulate", mode ? { mode } : {}),

  // System settings (attendance time rules + gate integrity)
  systemSettings: () => get<SystemSettingsExtended>("/system/settings"),
  updateSystemSettings: (changes: SystemSettingsPatch) => patch<SystemSettingsExtended>("/system/settings", changes),

  // ── Absence Risk Radar ──
  absenceRisk: (params?: { classroomId?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.classroomId) q.set("classroomId", String(params.classroomId));
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return get<AbsenceRiskSummary>(`/analytics/absence-risk${qs ? `?${qs}` : ""}`);
  },

  // ── SMS Delivery Health ──
  smsConfigStatus: () => get<SmsConfigStatus>("/sms/config-status"),
  smsDiagnostics: () => get<SmsDiagnostics>("/sms/diagnostics"),
  /** Phase 6: lightweight delivery stats (no Twilio calls) — same auth as the sms-logs list. */
  smsHealth: () => get<SmsDeliveryHealth>("/sms-logs/health"),
  smsTestSend: (to: string, body?: string, channel?: "sms" | "whatsapp") =>
    post<SmsTestSendResult>("/sms/test-send", { to, body, channel }),
};
