/**
 * AttendX Arduino Lab — compiler pipeline client.
 *
 * A browser cannot run avr-gcc, so compilation is delegated to one of two
 * arduino-cli hosts and the resulting Intel HEX comes back as text that the
 * flasher panel burns over Web Serial:
 *
 *   mode "server" — POST /api/arduino/compile on the AttendX API itself.
 *                   Works where the API is self-hosted WITH arduino-cli in
 *                   PATH; the managed deployment answers 501 honestly.
 *
 *   mode "bridge" — POST http://127.0.0.1:8791/compile against
 *                   hardware/arduino-bridge.mjs running on the operator's own
 *                   machine (the same machine whose USB ports hold the
 *                   Arduino). Chromium treats http://127.0.0.1 as
 *                   trustworthy, so an HTTPS app page may call it directly.
 *
 * Same fetch conventions as lib/arduino/api.ts: Bearer JWT from
 * localStorage["ft_token"], VITE_API_ORIGIN override honored.
 */

const env = import.meta.env as Record<string, string | undefined>;
const ORIGIN = env.VITE_API_ORIGIN ?? env.BASE_URL ?? "/";

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8791";
export const BRIDGE_URL_STORAGE_KEY = "atx_arduino_bridge_url";

export type CompilerMode = "server" | "bridge";

export interface CompilerProbe {
  mode: CompilerMode;
  available: boolean;
  version?: string;
  /** Human explanation when unavailable (setup hint). */
  detail?: string;
}

export class CompileUnavailableError extends Error {
  readonly probe: CompilerProbe;
  constructor(message: string, probe: CompilerProbe) {
    super(message);
    this.name = "CompileUnavailableError";
    this.probe = probe;
  }
}

export class CompileFailedError extends Error {
  readonly log: string;
  constructor(message: string, log: string) {
    super(message);
    this.name = "CompileFailedError";
    this.log = log;
  }
}

export interface CompileRequest {
  source: string;
  /** Sketch/basename — must be a valid C identifier-ish name; sanitized server-side too. */
  name: string;
  /** Fully-qualified board name, e.g. arduino:avr:uno. */
  fqbn: string;
  mode: CompilerMode;
  bridgeUrl?: string;
}

export interface CompileResult {
  hexText: string;
  fqbn: string;
  logTail: string;
  elapsedMs: number;
  via: CompilerMode;
}

export function loadBridgeUrl(): string {
  try {
    const stored = localStorage.getItem(BRIDGE_URL_STORAGE_KEY);
    if (stored && /^https?:\/\/.+/.test(stored.trim())) return stored.trim().replace(/\/+$/, "");
  } catch {
    /* storage blocked — default stands */
  }
  return DEFAULT_BRIDGE_URL;
}

export function saveBridgeUrl(url: string): void {
  try {
    localStorage.setItem(BRIDGE_URL_STORAGE_KEY, url.trim().replace(/\/+$/, ""));
  } catch {
    /* storage blocked — session-only */
  }
}

function bridgeFetch(path: string, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(`${loadBridgeUrl()}${path}`, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export async function probeServerCompiler(): Promise<CompilerProbe> {
  try {
    const token = localStorage.getItem("ft_token");
    const res = await fetch(`${ORIGIN}api/arduino/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
      body: JSON.stringify({}),
    });
    if (res.status === 501) {
      const body = (await res.json().catch(() => ({}))) as { hint?: string };
      return {
        mode: "server",
        available: false,
        detail: body.hint ?? "arduino-cli is not installed on the AttendX server.",
      };
    }
    if (!res.ok) {
      return { mode: "server", available: false, detail: `Probe failed with HTTP ${res.status}.` };
    }
    const body = (await res.json()) as { available?: boolean; version?: string };
    return {
      mode: "server",
      available: body.available === true,
      version: body.version,
      detail: body.available ? undefined : "arduino-cli not found in the server PATH.",
    };
  } catch (error) {
    return {
      mode: "server",
      available: false,
      detail: error instanceof Error ? error.message : "Server probe request failed.",
    };
  }
}

export async function probeBridgeCompiler(): Promise<CompilerProbe> {
  try {
    const res = await bridgeFetch("/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 4000);
    if (!res.ok) {
      return { mode: "bridge", available: false, detail: `Bridge answered HTTP ${res.status}.` };
    }
    const body = (await res.json()) as { available?: boolean; version?: string };
    return {
      mode: "bridge",
      available: body.available === true,
      version: body.version,
      detail: body.available ? undefined : "Bridge is up but arduino-cli is not on its PATH.",
    };
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "AbortError"
        ? "no response in 4 s"
        : error instanceof Error
          ? error.message
          : "request failed";
    return {
      mode: "bridge",
      available: false,
      detail: `No bridge at ${loadBridgeUrl()} (${reason}). Start hardware/arduino-bridge.mjs on this computer.`,
    };
  }
}

/** Probe both hosts; used to paint the compiler status pill on load. */
export async function probeCompilers(): Promise<CompilerProbe[]> {
  const [server, bridge] = await Promise.all([probeServerCompiler(), probeBridgeCompiler()]);
  return [server, bridge];
}

export async function compileSketch(request: CompileRequest): Promise<CompileResult> {
  const started = Date.now();
  if (request.mode === "bridge") {
    return compileViaBridge(request, started);
  }
  return compileViaServer(request, started);
}

async function compileViaServer(request: CompileRequest, started: number): Promise<CompileResult> {
  const token = localStorage.getItem("ft_token");
  let res: Response;
  try {
    res = await fetch(`${ORIGIN}api/arduino/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
      body: JSON.stringify({ source: request.source, name: request.name, fqbn: request.fqbn }),
    });
  } catch (error) {
    throw new CompileUnavailableError(
      error instanceof Error ? error.message : "Server compile request failed",
      { mode: "server", available: false, detail: "Network error while contacting the API." },
    );
  }
  if (res.status === 501) {
    const body = (await res.json().catch(() => ({}))) as { hint?: string };
    throw new CompileUnavailableError(body.hint ?? "arduino-cli is not installed on the server.", {
      mode: "server",
      available: false,
      detail: body.hint,
    });
  }
  if (res.status === 422) {
    const body = (await res.json()) as { error?: string; logTail?: string };
    throw new CompileFailedError(body.error ?? "Compilation failed", body.logTail ?? "");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CompileFailedError(body.error ?? `Server compile failed (HTTP ${res.status})`, "");
  }
  const body = (await res.json()) as { hexText?: string; fqbn?: string; logTail?: string };
  if (!body.hexText) {
    throw new CompileFailedError("The server compiled but returned no hex image.", body.logTail ?? "");
  }
  return {
    hexText: body.hexText,
    fqbn: body.fqbn ?? request.fqbn,
    logTail: body.logTail ?? "",
    elapsedMs: Date.now() - started,
    via: "server",
  };
}

async function compileViaBridge(request: CompileRequest, started: number): Promise<CompileResult> {
  let res: Response;
  try {
    res = await bridgeFetch(
      "/compile",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: request.source, name: request.name, fqbn: request.fqbn }),
      },
      // Compilation legitimately takes a while (toolchain cold start ~30 s).
      240_000,
    );
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "AbortError"
        ? "timed out after 240 s"
        : error instanceof Error
          ? error.message
          : "request failed";
    throw new CompileUnavailableError(`Bridge unreachable: ${reason}`, {
      mode: "bridge",
      available: false,
      detail: `Start it with: node hardware/arduino-bridge.mjs (default ${DEFAULT_BRIDGE_URL})`,
    });
  }
  if (res.status === 501) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new CompileUnavailableError(body.detail ?? "Bridge has no arduino-cli.", {
      mode: "bridge",
      available: false,
      detail: body.detail,
    });
  }
  if (res.status === 422) {
    const body = (await res.json()) as { error?: string; logTail?: string };
    throw new CompileFailedError(body.error ?? "Compilation failed", body.logTail ?? "");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CompileFailedError(body.error ?? `Bridge compile failed (HTTP ${res.status})`, "");
  }
  const body = (await res.json()) as { hexText?: string; fqbn?: string; logTail?: string };
  if (!body.hexText) {
    throw new CompileFailedError("The bridge compiled but returned no hex image.", body.logTail ?? "");
  }
  return {
    hexText: body.hexText,
    fqbn: body.fqbn ?? request.fqbn,
    logTail: body.logTail ?? "",
    elapsedMs: Date.now() - started,
    via: "bridge",
  };
}

/** FQBN presets keyed by the STK500 chip the flasher identified. */
export const FQBN_PRESETS = [
  { fqbn: "arduino:avr:uno", label: "Arduino Uno", chip: "ATmega328P" },
  { fqbn: "arduino:avr:nano", label: "Arduino Nano", chip: "ATmega328P" },
  { fqbn: "arduino:avr:leonardo", label: "Arduino Leonardo", chip: "ATmega32U4" },
  { fqbn: "arduino:avr:mega", label: "Arduino Mega 2560", chip: "ATmega2560" },
] as const;

export const DEFAULT_FQBN = "arduino:avr:uno";

/** Chip name (from STK500 identify) → suggested FQBN. */
export function fqbnForChip(chip: string | null | undefined): string {
  if (!chip) return DEFAULT_FQBN;
  if (chip.includes("328P")) return "arduino:avr:uno";
  if (chip.includes("32U4")) return "arduino:avr:leonardo";
  if (chip.includes("2560")) return "arduino:avr:mega";
  return DEFAULT_FQBN;
}
