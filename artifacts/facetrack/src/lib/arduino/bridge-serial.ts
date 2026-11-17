/**
 * AttendX Arduino Lab — Remote Serial Bridge client.
 *
 * Web Serial only exists in Chromium desktop browsers, and it only talks to
 * USB ports physically attached to THAT browser's machine. The bridge relay
 * (hardware/arduino-bridge.mjs) removes both limits: the board's serial port
 * is opened on the machine holding it and relayed to this browser as
 * Server-Sent Events, with writes going back over POST. Any browser —
 * Firefox, Safari, an iPad — can now drive the monitor, the control terminal
 * and AttendX ingestion, even from a different device on the network.
 *
 * The pipeline is intentionally identical to SerialMonitor: same LineBuffer
 * splitting, same parseMonitorLine classification, same MonitorLine shape —
 * so the page's monitor view, terminal REPL, plotter and ingestion queue all
 * work unchanged whichever transport is live.
 *
 * Protocol (see hardware/arduino-bridge.mjs):
 *   GET  /serial/ports  → { ports: [{ path, board_name, fqbn }], via }
 *   GET  /serial/status → { open, path, baud }
 *   POST /serial/open   { path, baud } → { open: true, path, baud }
 *   POST /serial/write  { text } | { data(b64) } → { written }
 *   POST /serial/close  {} → { closed: true }
 *   GET  /serial/rx     (SSE) → event: rx { data(b64), path } | err | closed
 */

import { LineBuffer, parseMonitorLine, type MonitorLine } from "./serial";

export interface BridgePortInfo {
  path: string;
  boardName: string | null;
  fqbn: string | null;
}

export interface BridgeSerialStatus {
  open: boolean;
  path: string | null;
  baud: number | null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class BridgeSerialClient {
  running = false;
  private es: EventSource | null = null;
  private readonly lineBuffer = new LineBuffer();
  private onLine: ((line: MonitorLine) => void) | null = null;
  private nextId = 1;
  private lastError: string | null = null;

  constructor(private readonly baseUrl: string) {}

  /** Normalized base URL without trailing slash. */
  get url(): string {
    return this.baseUrl.replace(/\/+$/, "");
  }

  private async request(path: string, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.url}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Boards/ports visible on the bridge machine (arduino-cli or /dev scan). */
  async listPorts(): Promise<BridgePortInfo[]> {
    const res = await this.request("/serial/ports", { method: "GET" }, 20_000);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `bridge answered HTTP ${res.status} for /serial/ports`);
    }
    const body = (await res.json()) as { ports?: BridgePortInfo[] };
    return (body.ports ?? []).filter((p) => typeof p.path === "string" && p.path.length > 0);
  }

  async status(): Promise<BridgeSerialStatus> {
    const res = await this.request("/serial/status", { method: "GET" }, 4000);
    if (!res.ok) throw new Error(`bridge answered HTTP ${res.status} for /serial/status`);
    return (await res.json()) as BridgeSerialStatus;
  }

  /**
   * Open the port on the bridge machine and start streaming lines. The SSE
   * subscription starts only after the open call succeeds, so failures land
   * here as a throw instead of silent dead streams.
   */
  async open(path: string, baud: number, onLine: (line: MonitorLine) => void): Promise<void> {
    await this.closeStream();
    const res = await this.request(
      "/serial/open",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, baud }) },
      12_000,
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      throw new Error([body.error, body.detail].filter(Boolean).join(" — ") || `bridge open failed (HTTP ${res.status})`);
    }
    this.onLine = onLine;
    this.running = true;
    this.lastError = null;
    this.connectStream();
  }

  private connectStream(): void {
    const es = new EventSource(`${this.url}/serial/rx`);
    this.es = es;
    es.addEventListener("rx", (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as { data?: string };
        if (!msg.data) return;
        for (const raw of this.lineBuffer.push(base64ToBytes(msg.data))) {
          const clean = raw.replace(/\r$/, "");
          this.onLine?.({ id: this.nextId++, at: new Date(), text: clean, kind: parseMonitorLine(clean).kind });
        }
      } catch {
        /* malformed frame — skip it, the stream stays healthy */
      }
    });
    es.addEventListener("err", (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as { message?: string };
        this.lastError = msg.message ?? "serial stream error";
      } catch {
        this.lastError = "serial stream error";
      }
    });
    es.addEventListener("closed", () => {
      // The port vanished on the bridge machine (unplugged) or was closed by
      // another client — mark the transport dead so the page can react.
      this.running = false;
      this.lastError = this.lastError ?? "port closed on the bridge machine";
    });
    es.onerror = () => {
      // EventSource auto-reconnects; only surface an error when the session
      // is supposed to be live and the port is gone server-side.
      if (this.running) this.lastError = "bridge stream interrupted — reconnecting…";
    };
  }

  /** Send a line to the board (Control Terminal REPL). */
  async writeText(text: string, opts?: { newline?: boolean }): Promise<void> {
    if (!this.running) throw new Error("Bridge transport is not running — open a port first");
    const res = await this.request(
      "/serial/write",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: opts?.newline === false ? text : `${text}\n` }),
      },
      6000,
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `bridge write failed (HTTP ${res.status})`);
    }
  }

  /** Stop the browser-side stream (port stays open on the bridge machine). */
  async closeStream(): Promise<void> {
    this.running = false;
    this.onLine = null;
    const es = this.es;
    this.es = null;
    if (es) es.close();
  }

  /** Stop the stream AND release the port on the bridge machine. */
  async closePort(): Promise<void> {
    await this.closeStream();
    try {
      await this.request("/serial/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 4000);
    } catch {
      /* bridge may already be gone — nothing to release locally either */
    }
  }

  /** Last stream-level problem reported by the bridge (err/closed events). */
  consumeError(): string | null {
    const err = this.lastError;
    this.lastError = null;
    return err;
  }
}
