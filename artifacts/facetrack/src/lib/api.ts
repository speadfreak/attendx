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
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
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

export interface QrScanResponse {
  ok: boolean;
  result: "valid" | "duplicate" | "expired" | "revoked" | "unknown-badge" | "stale-version" | "bad-signature" | "not-attendx-qr" | "malformed" | string;
  alreadyMarked?: boolean;
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
}

// ── Endpoint wrappers ───────────────────────────────────────────

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
  qrScan: (token: string, terminalId: string, classroomId?: number) =>
    post<QrScanResponse>("/qr/scan", { token, terminalId, classroomId }),
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
};
