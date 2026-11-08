/**
 * In-process pub/sub event bus powering the Server-Sent Events live stream.
 * All state mutations (attendance, Pi heartbeats, jobs, reviews, QR scans,
 * SMS) publish here; /api/events/stream fans them out to connected dashboards.
 *
 * Chosen over raw WebSockets so the identical code runs unchanged on Vercel
 * serverless functions — clients transparently fall back to polling if the
 * stream drops.
 */

export interface LiveEvent {
  type:
    | "attendance.created"
    | "attendance.updated"
    | "attendance.checkout"
    | "pi.heartbeat"
    | "job.updated"
    | "review.created"
    | "review.decided"
    | "qr.scan"
    | "sms.sent"
    | "settings.updated"
    | "gate.alert"
    | "gate.integrity"
    | "heartbeat";
  payload: Record<string, unknown>;
  at: string;
}

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
const recent: LiveEvent[] = [];

export function publishEvent(type: LiveEvent["type"], payload: Record<string, unknown>): void {
  const event: LiveEvent = { type, payload, at: new Date().toISOString() };
  recent.push(event);
  if (recent.length > 200) recent.shift();
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      listeners.delete(fn);
    }
  }
}

export function subscribeEvents(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recentEvents(limit = 50): LiveEvent[] {
  return recent.slice(-limit);
}
