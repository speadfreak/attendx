/**
 * Local API helper for the Arduino Gate Controller Studio.
 *
 * NOTE: this intentionally duplicates (does not import) the apiFetch pattern
 * from src/lib/api.ts — that module is owned by another surface, and the
 * studio only needs two endpoints. Same conventions: Bearer JWT from
 * localStorage["ft_token"], JSON bodies, optional VITE_API_ORIGIN override
 * (falls back to the Vite BASE_URL so BASE_PATH deployments keep working).
 */

const env = import.meta.env as Record<string, string | undefined>;
const ORIGIN = env.VITE_API_ORIGIN ?? env.BASE_URL ?? "/";

export function arduinoApiFetch(path: string, opts?: RequestInit): Promise<Response> {
  const token = localStorage.getItem("ft_token");
  return fetch(`${ORIGIN}api${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token ?? ""}`,
      ...(opts?.headers ?? {}),
    },
  });
}

/** Subset of GET /api/gates (routes/gates.ts serializeGate) the studio needs. */
export interface GateLite {
  gateId: string;
  name: string;
  geofenceRadiusM?: number;
}

export interface GateSensorEvent {
  sensor: "ultrasonic" | "ir_beam";
  /** ISO 8601 timestamp (server accepts ISO, epoch seconds/millis or digit strings). */
  ts: string;
}

/** GET /api/gates → [{ gateId, name, latitude, longitude, geofenceRadiusM, … }] */
export async function fetchGates(): Promise<GateLite[]> {
  const res = await arduinoApiFetch("/gates");
  if (!res.ok) {
    throw new Error(`GET /gates failed (${res.status})`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) return [];
  return body
    .filter((g): g is { gateId: string; name: string; geofenceRadiusM?: number } => {
      if (typeof g !== "object" || g === null) return false;
      const candidate = g as Record<string, unknown>;
      return typeof candidate["gateId"] === "string" && typeof candidate["name"] === "string";
    })
    .map((g) => ({
      gateId: g.gateId,
      name: g.name,
      geofenceRadiusM: typeof (g as Record<string, unknown>)["geofenceRadiusM"] === "number"
        ? (g as { geofenceRadiusM: number }).geofenceRadiusM
        : undefined,
    }));
}

/** POST /api/gate/sensor-events → 201 { accepted, skipped, validation } */
export async function postGateSensorEvents(
  gateId: string,
  events: GateSensorEvent[],
): Promise<{ accepted: number; skipped: number }> {
  const res = await arduinoApiFetch("/gate/sensor-events", {
    method: "POST",
    body: JSON.stringify({ gateId, events }),
  });
  if (!res.ok) {
    let message = `POST /gate/sensor-events failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; skipped?: number };
      if (body?.error) message = body.error;
      else if (body?.skipped) message = `all ${body.skipped} events skipped (timestamps out of range)`;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  const body = (await res.json()) as { accepted?: number; skipped?: number };
  return { accepted: body.accepted ?? 0, skipped: body.skipped ?? 0 };
}
