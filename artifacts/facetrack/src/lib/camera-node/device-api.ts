/**
 * Phase 7 — device-channel API for the phone-as-gate-camera PWA node.
 *
 * The camera node has NO admin login: it authenticates with its paired
 * gate-device session token carried in the `X-Pi-Token` header (the legacy
 * Pi header name, now shared with phone devices). The server rotates the
 * token on EVERY heartbeat — the response `nextToken` must replace the
 * stored token immediately or the following request 401s.
 *
 * Contract mirrored from artifacts/api-server/src/routes/devices.ts,
 * bulk-attendance.ts and qr.ts.
 */

const BASE = import.meta.env.BASE_URL ?? "/";

export const DEVICE_TOKEN_KEY = "atx_device_token";
export const DEVICE_ID_KEY = "atx_device_id";

// ── token / identity storage ─────────────────────────────────────────

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    localStorage.setItem(DEVICE_TOKEN_KEY, token);
  } catch {
    /* private mode — session lives in memory only */
  }
}

export function getStoredDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

export function setStoredDeviceId(deviceId: string): void {
  try {
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  } catch {
    /* ignore */
  }
}

export function clearStoredIdentity(): void {
  try {
    localStorage.removeItem(DEVICE_TOKEN_KEY);
    localStorage.removeItem(DEVICE_ID_KEY);
  } catch {
    /* ignore */
  }
}

// ── errors ───────────────────────────────────────────────────────────

/** Fetch error that carries the HTTP status + parsed body (server verdicts). */
export class ApiError extends Error {
  readonly status: number | null;
  readonly body: unknown;

  constructor(message: string, status: number | null, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** Server-provided verdict field for scan endpoints (e.g. "revoked"). */
  get bodyResult(): string | null {
    if (this.body && typeof this.body === "object" && "result" in this.body) {
      const r = (this.body as { result?: unknown }).result;
      return typeof r === "string" ? r : null;
    }
    return null;
  }

  get bodyMessage(): string | null {
    if (this.body && typeof this.body === "object" && "message" in this.body) {
      const m = (this.body as { message?: unknown }).message;
      return typeof m === "string" ? m : null;
    }
    return null;
  }

  /** true when the request never reached the server (offline / DNS / CORS). */
  get isNetworkError(): boolean {
    return this.status === null;
  }
}

// ── transport ────────────────────────────────────────────────────────

async function devicePost<T>(path: string, token: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}api${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pi-Token": token,
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError("Network unreachable", null, null);
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error?: unknown }).error ?? `Request failed (${res.status})`)
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status, parsed);
  }
  return parsed as T;
}

// ── heartbeat ────────────────────────────────────────────────────────

export type NodeHealthStatus = "ok" | "obstructed" | "frozen" | "unknown";
export type NodeMode = "face" | "qr";
export type TargetQuality = "low" | "balanced" | "hd";

export interface HeartbeatBody {
  status?: "connected" | "running_task" | "degraded";
  mode?: NodeMode;
  fps?: number | null;
  resolution?: string;
  healthStatus?: NodeHealthStatus;
  batteryLevel?: number | null;
  connection?: string;
  dataSaver?: boolean;
  uptimeSeconds?: number;
  localIp?: string;
}

export interface DeviceIdentityPayload {
  id: string;
  name: string;
  deviceType: "pi" | "phone";
  mode: NodeMode;
  assignedGateId: string | null;
  healthStatus: string;
}

export interface DeviceCommand {
  command: string;
  value: unknown;
}

export interface HeartbeatResponse {
  accepted: boolean;
  deviceId: string;
  device: DeviceIdentityPayload;
  nextToken: string;
  expiresAt: string;
  serverTime: string;
  command: DeviceCommand | null;
  targetQuality: TargetQuality | null;
}

export function sendHeartbeat(token: string, body: HeartbeatBody): Promise<HeartbeatResponse> {
  return devicePost<HeartbeatResponse>("/devices/heartbeat", token, body);
}

// ── thumbnail ────────────────────────────────────────────────────────

export function uploadThumbnail(token: string, deviceId: string, image: string): Promise<{ ok: boolean }> {
  return devicePost<{ ok: boolean }>(`/devices/${encodeURIComponent(deviceId)}/thumbnail`, token, { image });
}

// ── face bulk match (POST /api/attendance/bulk-match) ────────────────

export interface BulkMatchResultRow {
  studentId: number;
  studentName: string;
  attendanceId: number | null;
  status: "present" | "late" | "already_marked";
  confidence: number;
}

export interface BulkMatchResponse {
  matched: BulkMatchResultRow[];
  reviewQueued: number;
  skipped: number;
  threshold: number;
}

export interface BulkMatchFrame {
  descriptors: number[][];
}

export function bulkMatch(
  token: string,
  batchId: string,
  frames: BulkMatchFrame[],
): Promise<BulkMatchResponse> {
  return devicePost<BulkMatchResponse>("/attendance/bulk-match", token, { batchId, frames });
}

// ── QR scan (POST /api/qr/scan + batch spool) ────────────────────────

export interface QrScanInput {
  token: string;
  terminalId: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  nonce?: string;
  scannedAt?: string;
}

export interface QrScanStudent {
  id: number;
  name: string;
  studentId: string;
  classroomId: number | null;
}

export interface QrScanResponse {
  ok: boolean;
  result: string; // "valid" | "duplicate" | "revoked" | "unknown-badge" | ...
  alreadyMarked?: boolean;
  student?: QrScanStudent;
  attendance?: { id: number; status: string; markedAt?: string | null; checkedOutAt?: string | null };
  message?: string;
  fraudScore?: number;
}

export function qrScan(token: string, input: QrScanInput): Promise<QrScanResponse> {
  return devicePost<QrScanResponse>("/qr/scan", token, input);
}

export interface QrSpoolEntry {
  token: string;
  terminalId: string;
  nonce: string;
  scannedAt: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

export interface QrBatchResultItem {
  nonce: string | null;
  ok: boolean;
  result: string | null;
  httpCode: number;
  message: string | null;
  studentName: string | null;
  attendanceId: number | null;
}

export interface QrBatchResponse {
  ok: boolean;
  accepted: number;
  total: number;
  rejected: number;
  results: QrBatchResultItem[];
}

export function qrScanBatch(token: string, scans: QrSpoolEntry[]): Promise<QrBatchResponse> {
  return devicePost<QrBatchResponse>("/qr/scan/batch", token, { scans });
}

// ── SSE push channel ─────────────────────────────────────────────────

/**
 * EventSource cannot set headers, so the device token travels as ?token=
 * (accepted by /api/events/stream — see artifacts/api-server/src/routes/events.ts).
 * The connection is opened with the CURRENT token; on error the caller must
 * close and reconnect with the freshly rotated token.
 */
export function sseUrl(token: string): string {
  return `${BASE}api/events/stream?token=${encodeURIComponent(token)}`;
}

/** One spooled QR scan line for the batch flush. */
export function toSpoolEntry(input: QrScanInput, nonce: string): QrSpoolEntry {
  return {
    token: input.token,
    terminalId: input.terminalId,
    nonce,
    scannedAt: input.scannedAt ?? new Date().toISOString(),
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy: input.accuracy,
  };
}
