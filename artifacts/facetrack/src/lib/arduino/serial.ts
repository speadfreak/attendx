/**
 * AttendX Gate Controller Studio — Web Serial layer.
 *
 * Browser support contract: Web Serial (`navigator.serial`) exists in
 * Chromium desktop browsers over HTTPS or localhost. Safari/Firefox/mobile
 * cannot talk to USB serial — the page renders a clear banner instead of
 * pretending otherwise.
 *
 * TypeScript's DOM lib does not ship Web Serial typings yet, so this module
 * declares the minimal subset we use (port, filters, signals, events) and
 * augments `Navigator`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Minimal Web Serial API typings (subset of https://wicg.github.io/serial/)
// ─────────────────────────────────────────────────────────────────────────────

export interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialPortRequestOptions {
  filters?: SerialPortFilter[];
}

export interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

export interface SerialOpenOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd";
  bufferSize?: number;
  flowControl?: "none" | "hardware";
}

export interface SerialPort extends EventTarget {
  open(options: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
  getSignals(): SerialSignals;
  setSignals(signals: SerialSignals): Promise<void>;
  forget?(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}

/** `connect`/`disconnect` events carry the port that changed. */
export interface SerialConnectionEvent extends Event {
  readonly port: SerialPort;
}

export interface Serial extends EventTarget {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}

declare global {
  interface Navigator {
    readonly serial?: Serial;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Device identity maps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * USB identity → friendly device name (port.getInfo() vendor/product ids are
 * plain numbers; we key on lowercase hex "vendor:product").
 */
const USB_DEVICE_NAMES: Record<string, string> = {
  "2341:0043": "Arduino Uno R3",
  "2341:0001": "Arduino Uno (ATmega16U2 USB)",
  "1a86:7523": "Uno clone (CH340)",
  "2341:005f": "Arduino Mega",
};

export function describeUsbDevice(info: SerialPortInfo | null): string {
  if (!info || info.usbVendorId === undefined) return "Unknown serial device";
  const key = `${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
  return USB_DEVICE_NAMES[key] ?? "Unknown serial device";
}

export function formatUsbIds(info: SerialPortInfo | null): string {
  if (!info || info.usbVendorId === undefined) return "usb id unknown";
  const vendor = `0x${info.usbVendorId.toString(16).padStart(4, "0")}`;
  const product = info.usbProductId === undefined ? "?" : `0x${info.usbProductId.toString(16).padStart(4, "0")}`;
  return `${vendor}:${product}`;
}

export interface ChipSignature {
  name: string;
  boards: string;
  signature: readonly [number, number, number];
}

/** STK500v1 READ_SIGN answers mapped to AVR part names. */
export const CHIP_SIGNATURES: readonly ChipSignature[] = [
  { signature: [0x1e, 0x95, 0x0f], name: "ATmega328P", boards: "Arduino Uno R3 / Nano" },
  { signature: [0x1e, 0x95, 0x02], name: "ATmega32U4", boards: "Arduino Leonardo / Micro" },
  { signature: [0x1e, 0x98, 0x01], name: "ATmega2560", boards: "Arduino Mega 2560" },
];

export function chipForSignature(signature: readonly [number, number, number]): ChipSignature | null {
  return (
    CHIP_SIGNATURES.find(
      (c) => c.signature[0] === signature[0] && c.signature[1] === signature[1] && c.signature[2] === signature[2],
    ) ?? null
  );
}

export const signatureHex = (signature: readonly [number, number, number]): string =>
  signature.map((b) => `0x${b.toString(16).toUpperCase().padStart(2, "0")}`).join(" ");

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

export const isSerialSupported = (): boolean => typeof navigator !== "undefined" && !!navigator.serial;

export const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Race a promise against a timeout; the loser is settled silently. */
export function raceWithTimeout<T>(promise: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Open the port-picker dialog. `showAll` skips the vendor filter (Arduino
 * 0x2341 / CH340 0x1a86) so exotic clones can be picked manually.
 */
export async function requestArduinoPort(showAll: boolean): Promise<SerialPort> {
  if (!navigator.serial) throw new Error("Web Serial is not available in this browser");
  return showAll
    ? navigator.serial.requestPort({})
    : navigator.serial.requestPort({
        filters: [{ usbVendorId: 0x2341 }, { usbVendorId: 0x1a86 }],
      });
}

/** Close a port, tolerating "already closed" states. */
export async function closePortQuietly(port: SerialPort): Promise<void> {
  try {
    await port.close();
  } catch {
    /* the port was already closed — that is the point */
  }
}

/**
 * Classic Arduino auto-reset: pulse DTR so the series capacitor couples a
 * RESET edge into the ATmega, launching the bootloader. Sequence per the
 * studio spec: false → 60 ms → true → 250 ms → false.
 */
export async function dtrAutoReset(port: SerialPort): Promise<void> {
  await port.setSignals({ dataTerminalReady: false });
  await sleep(60);
  await port.setSignals({ dataTerminalReady: true });
  await sleep(250);
  await port.setSignals({ dataTerminalReady: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitor line model + ATX1 event parsing
// ─────────────────────────────────────────────────────────────────────────────

export type MonitorLineKind = "event" | "error" | "notice" | "raw";

export interface MonitorLine {
  id: number;
  at: Date;
  text: string;
  kind: MonitorLineKind;
}

/** Sensor enum accepted by POST /api/gate/sensor-events (routes/gate.ts). */
export type GateSensor = "ultrasonic" | "ir_beam";

export interface ParsedGateEvent {
  sensor: GateSensor;
  /** millis() uptime reported by the sketch (not wall-clock). */
  deviceMillis: number;
}

const ATX1_RE = /^ATX1\s*,\s*(\{.*\})\s*$/;
const ERRORISH_RE = /\b(error|err|fail(?:ed)?|timeout|timed out|invalid|bad|denied)\b/i;

export interface ParsedMonitorLine {
  kind: MonitorLineKind;
  /** Set when the line carries an ingestable sensor event. */
  event: ParsedGateEvent | null;
  /** JSON payload of ATX1 lines (heartbeat / relay acks …), else null. */
  payload: Record<string, unknown> | null;
}

/**
 * Classify one serial line. `ATX1,{...json...}` lines from our sketches are
 * machine events; anything mentioning errors turns red; everything else is raw
 * chatter. Heartbeat-style ATX1 lines (no ingestable sensor) become "notice".
 */
export function parseMonitorLine(text: string): ParsedMonitorLine {
  const match = ATX1_RE.exec(text.trim());
  if (match) {
    try {
      const payload = JSON.parse(match[1]!) as Record<string, unknown>;
      const sensor = payload["sensor"];
      const ts = payload["ts"];
      if (
        (sensor === "ultrasonic" || sensor === "ir_beam") &&
        typeof ts === "number" &&
        Number.isFinite(ts) &&
        ts >= 0
      ) {
        return { kind: "event", event: { sensor, deviceMillis: ts }, payload };
      }
      return { kind: "notice", event: null, payload };
    } catch {
      return { kind: "error", event: null, payload: null };
    }
  }
  if (ERRORISH_RE.test(text)) return { kind: "error", event: null, payload: null };
  return { kind: "raw", event: null, payload: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// SerialMonitor — line-buffered read loop on top of the raw byte stream
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens the port at a monitor baud rate and streams *lines* to a callback.
 * Web Serial hands us raw byte chunks; we run a persistent TextDecoder with
 * `{ stream: true }` (so multi-byte UTF-8 split across chunks survives) and
 * split on \n (tolerating \r\n). Rendering is capped by the caller (500 lines).
 */
export class SerialMonitor {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private keepReading = false;
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private nextId = 1;
  running = false;

  /**
   * Start monitoring. Re-opens the given port at `baudRate` (a port previously
   * used by the STK500 flasher is always closed by the flasher first).
   */
  async start(
    port: SerialPort,
    baudRate: number,
    onLine: (line: MonitorLine) => void,
    onFatal?: (error: Error) => void,
  ): Promise<void> {
    if (this.running) await this.stop();
    await closePortQuietly(port); // deterministic base state before open()
    await port.open({ baudRate });
    this.port = port;
    this.buffer = "";
    this.keepReading = true;
    this.running = true;
    void this.loop(onLine, onFatal);
  }

  private async loop(
    onLine: (line: MonitorLine) => void,
    onFatal?: (error: Error) => void,
  ): Promise<void> {
    while (this.keepReading && this.port?.readable) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        reader = this.port.readable.getReader();
        this.reader = reader;
        while (this.keepReading) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          this.consume(value, onLine);
        }
      } catch (error) {
        // Device unplugged mid-monitor (or the OS claimed the port).
        this.keepReading = false;
        this.running = false;
        onFatal?.(error instanceof Error ? error : new Error(String(error)));
        break;
      } finally {
        this.reader = null;
        try {
          reader?.releaseLock();
        } catch {
          /* reader was already torn down */
        }
      }
    }
    this.running = false;
  }

  private consume(chunk: Uint8Array, onLine: (line: MonitorLine) => void): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let idx = this.buffer.search(/\r?\n/);
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx);
      // Skip the terminator itself (\r\n or \n).
      this.buffer = this.buffer.slice(this.buffer[idx] === "\r" && this.buffer[idx + 1] === "\n" ? idx + 2 : idx + 1);
      onLine(this.makeLine(line));
      idx = this.buffer.search(/\r?\n/);
    }
    // Pathological stream without newlines: flush it as one line so memory
    // stays bounded at ~2 KB.
    if (this.buffer.length > 2048) {
      onLine(this.makeLine(this.buffer));
      this.buffer = "";
    }
  }

  private makeLine(text: string): MonitorLine {
    const clean = text.replace(/\r$/, "");
    const { kind } = parseMonitorLine(clean);
    return { id: this.nextId++, at: new Date(), text: clean, kind };
  }

  /**
   * Stop monitoring and close the port. cancel() unblocks a pending read;
   * closing (instead of leaving the stream dangling) makes the next mode
   * switch — flasher or re-monitor — deterministic.
   */
  async stop(): Promise<void> {
    this.keepReading = false;
    this.running = false;
    try {
      await this.reader?.cancel();
    } catch {
      /* stream may already be dead */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* reader was already released */
    }
    this.reader = null;
    await sleep(50); // let the read loop unwind its finally block
    const port = this.port;
    this.port = null;
    if (port) await closePortQuietly(port);
  }
}
