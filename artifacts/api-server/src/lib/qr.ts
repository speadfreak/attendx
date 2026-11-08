import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AttendX QR tokens.
 *
 * Format: AXQR1.<base64url(payload json)>.<base64url(hmac-sha256 sig)>
 * Payload: { sid: studentId, v: version, n: nonce, exp?: epochSeconds }
 *
 * The signature secret is derived from SESSION_SECRET so no extra env var is
 * needed and tokens can only be minted by the server — a photographed QR from
 * another school (or a self-generated one) will fail signature verification.
 */

const TOKEN_PREFIX = "AXQR1";

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required for QR token signing");
  return `attendx-qr::${s}`;
}

function b64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export interface QrTokenPayload {
  sid: number;
  v: number;
  n: string;
  exp?: number | null;
}

export function signQrToken(payload: QrTokenPayload): string {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${TOKEN_PREFIX}.${body}.${sig}`;
}

export function verifyQrToken(token: string): { ok: true; payload: QrTokenPayload } | { ok: false; reason: string } {
  const raw = (token || "").trim();
  if (!raw.startsWith(`${TOKEN_PREFIX}.`)) return { ok: false, reason: "not-attendx-qr" };
  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [, body, sig] = parts;
  const expected = createHmac("sha256", secret()).update(body).digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad-signature" };
  }
  let payload: QrTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8")) as QrTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!Number.isInteger(payload.sid) || !Number.isInteger(payload.v)) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp && Date.now() > payload.exp * 1000) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

export function hashQrToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

export function newNonce(): string {
  return randomBytes(8).toString("hex");
}

export function serialFor(studentRef: string, seq: number): string {
  const rand = randomBytes(2).toString("hex").toUpperCase();
  return `AX-${studentRef.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase()}-${String(seq).padStart(4, "0")}-${rand}`;
}
