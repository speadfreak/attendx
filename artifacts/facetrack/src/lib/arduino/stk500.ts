/**
 * AttendX Gate Controller Studio — hand-rolled STK500v1 programmer over Web
 * Serial. This is the dialect the Arduino Uno/Nano bootloaders (optiboot and
 * the ATmega16U2-era bootloader) actually speak, i.e. exactly what avrdude's
 * `stk500.c` implements. NO external flashing libraries — they do not bundle
 * cleanly under Vite, and the protocol is small enough to implement precisely.
 *
 * ── Wire format (VERIFIED against avrdude/src/stk500.c and optiboot) ─────────
 * A request frame is `[cmd, ...params, EOP]` where EOP = Sync_CRC_EOP = 0x20.
 * A response is `[...payload, Resp_STK_INSYNC = 0x14, Resp_STK_OK = 0x10]`
 * (except GET_PARAMETER which answers `[value, Resp_STK_OK]`).
 *
 * ── Checksum algorithm (task brief asked us to verify) ───────────────────────
 * The brief hypothesized `checksum = two's complement of the low byte of the
 * sum`. We checked the STK500 protocol sources carefully and that claim is
 * FALSE for STK500v1 bootloader frames: the sum-based two's-complement
 * checksum belongs to **Intel HEX records** (implemented in lib/arduino/hex.ts)
 * and the XOR-of-frame checksum belongs to STK500v2 (AVR069). STK500v1-over-
 * UART has **no arithmetic checksum at all** — frame integrity is enforced by
 * the fixed EOP terminator 0x20 plus the INSYNC(0x14)/OK(0x10) echo handshake:
 * if the bootloader reads a frame whose last byte is not 0x20 it discards it
 * and never answers, which surfaces here as a sync timeout rather than silent
 * corruption. Implementing a sum-checksum frame would make EVERY transaction
 * fail against real hardware, so this module implements the real EOP framing
 * and validates every response's INSYNC/OK markers instead.
 *
 * ── Self-check: expected byte sequences (verified by hand against avrdude) ──
 *
 *   GET_SYNC          TX  30 20
 *                     RX  14 10                          (INSYNC, OK)
 *   GET_PARAMETER 0x81 TX  41 81 20
 *                     RX  04 10                          (value, OK)
 *   READ_SIGN         TX  75 20
 *                     RX  1E 95 0F 14 10                 (sig bytes, INSYNC, OK)
 *   ENTER_PROGMODE    TX  50 20
 *                     RX  14 10
 *   LOAD_ADDRESS 0    TX  55 00 00 20                    (word-address, big-endian)
 *                     RX  14 10
 *   LOAD_ADDRESS byte 0x400 (word 0x200) TX 55 02 00 20
 *   PROG_PAGE 128 B   TX  64 00 80 46 <128 data bytes> 20   ('F' = flash memory)
 *                     RX  14 10
 *   LEAVE_PROGMODE    TX  51 20                          ('Q' — optiboot then
 *                     RX  14 10 (may not arrive)          jumps to the app)
 *   EXIT (legacy 'L') TX  4C 20                          (no response expected)
 *
 * Example: flashing byte address 0x0100 (page 2 of a 128-byte-page part) —
 *   word address = 0x0100 / 2 = 0x80 → TX 55 00 80 20, then
 *   TX 64 00 80 46 <128 bytes> 20.
 */

import {
  chipForSignature,
  closePortQuietly,
  dtrAutoReset,
  raceWithTimeout,
  signatureHex,
  sleep,
  type SerialPort,
} from "./serial";

// ── Protocol constants ───────────────────────────────────────────────────────
const STK_EOP = 0x20; // Sync_CRC_EOP — frame terminator (the "checksum" slot)
const RESP_INSYNC = 0x14;
const RESP_OK = 0x10;

const Cmnd_STK_GET_SYNC = 0x30;
const Cmnd_STK_GET_PARAMETER = 0x41;
const Cmnd_STK_ENTER_PROGMODE = 0x50;
const Cmnd_STK_LEAVE_PROGMODE = 0x51;
const Cmnd_STK_LOAD_ADDRESS = 0x55;
const Cmnd_STK_PROG_PAGE = 0x64;
const Cmnd_STK_READ_SIGN = 0x75;
/** Legacy "leave programming mode" ('L') — optiboot treats it like 'Q'. */
const Cmnd_STK_EXIT = 0x4c;

const PARAM_SW_MAJOR = 0x81;
const PARAM_SW_MINOR = 0x82;

const FLOW_FLAG_FLASH = 0x46; // 'F'

/** ATmega328P optiboot programs flash in 128-byte pages. */
export const DEFAULT_PAGE_SIZE = 128;

// ── Errors ───────────────────────────────────────────────────────────────────
export class StkTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StkTimeoutError";
  }
}

export class StkProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StkProtocolError";
  }
}

const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, "0");
const hexDump = (bytes: ArrayLike<number>): string =>
  Array.from(bytes)
    .map((b) => hex2(b))
    .join(" ");

type LogFn = (line: string) => void;

// ── Session link ─────────────────────────────────────────────────────────────
/**
 * Holds the reader/writer locks for the duration of one bootloader session so
 * every command shares a single ordered byte stream. `readBytes` keeps a
 * *pending* read across timeouts: a timed-out read is NOT abandoned (losing
 * bytes would desync the stream), it is re-awaited on the next attempt.
 */
class Stk500Link {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  private leftover: number[] = [];

  private constructor(port: SerialPort) {
    const readable = port.readable;
    const writable = port.writable;
    if (!readable || !writable) {
      throw new StkProtocolError("Serial port streams are not open (open() the port first)");
    }
    this.reader = readable.getReader();
    this.writer = writable.getWriter();
  }

  static acquire(port: SerialPort): Stk500Link {
    return new Stk500Link(port);
  }

  async write(bytes: ArrayLike<number>): Promise<void> {
    await this.writer.write(Uint8Array.from(bytes as ArrayLike<number>));
  }

  /**
   * Read exactly `count` bytes or throw StkTimeoutError. Extra bytes in a
   * chunk are buffered in `leftover` for the next command (resync noise).
   */
  async readBytes(count: number, timeoutMs: number): Promise<Uint8Array> {
    const out = new Uint8Array(count);
    let have = 0;
    const deadline = Date.now() + timeoutMs;

    while (have < count) {
      while (this.leftover.length > 0 && have < count) {
        out[have++] = this.leftover.shift()!;
      }
      if (have >= count) break;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new StkTimeoutError(`timeout waiting for bootloader response (got ${have}/${count} bytes)`);
      }
      if (!this.pendingRead) this.pendingRead = this.reader.read();

      try {
        const result = await raceWithTimeout(this.pendingRead, remaining, "serial read timed out");
        this.pendingRead = null;
        if (result.done) {
          throw new StkTimeoutError("serial stream closed while waiting for bootloader response");
        }
        const chunk = result.value;
        if (chunk) {
          for (let i = 0; i < chunk.length; i++) {
            if (have < count) out[have++] = chunk[i]!;
            else this.leftover.push(chunk[i]!);
          }
          if (this.leftover.length > 64) this.leftover.length = 0; // garbage guard
        }
      } catch (error) {
        if (error instanceof Error && error.message === "serial read timed out") {
          // Timeout: deliberately keep this.pendingRead — the SAME read is
          // awaited again on the next attempt, so no bytes are dropped.
          throw new StkTimeoutError(`timeout waiting for bootloader response (got ${have}/${count} bytes)`);
        }
        throw error;
      }
    }
    return out;
  }

  /** Send a frame and read a fixed-size response (label decorates timeouts). */
  async transact(
    frame: ArrayLike<number>,
    responseBytes: number,
    timeoutMs: number,
    label: string,
  ): Promise<Uint8Array> {
    await this.write(frame);
    try {
      return await this.readBytes(responseBytes, timeoutMs);
    } catch (error) {
      if (error instanceof StkTimeoutError) {
        throw new StkTimeoutError(`${label}: ${error.message}`);
      }
      throw error;
    }
  }

  /** Assert a standard `[INSYNC, OK]` response. */
  assertInsyncOk(response: Uint8Array, label: string): void {
    if (response.length !== 2 || response[0] !== RESP_INSYNC || response[1] !== RESP_OK) {
      throw new StkProtocolError(
        `${label}: unexpected response [${hexDump(response)}] — expected [${hex2(RESP_INSYNC)} ${hex2(RESP_OK)}]`,
      );
    }
  }

  /**
   * End the session normally: release both locks WITHOUT cancel, so the port
   * stays open (e.g. for a follow-up read or the monitor).
   */
  async close(): Promise<void> {
    await this.drainPending();
    try {
      this.writer.releaseLock();
    } catch {
      /* already released */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  /**
   * End the session after a protocol failure. The stream may be in a weird
   * state, so we cancel it — the caller closes/reopens the port afterwards.
   */
  async abort(): Promise<void> {
    await this.drainPending();
    try {
      await this.reader.cancel();
    } catch {
      /* already dead */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* already released */
    }
    try {
      this.writer.releaseLock();
    } catch {
      /* already released */
    }
  }

  /** Give an abandoned read a moment to settle so it does not swallow bytes. */
  private async drainPending(): Promise<void> {
    const pending = this.pendingRead;
    if (!pending) return;
    this.pendingRead = null;
    try {
      await raceWithTimeout(pending, 80, "drain timeout");
    } catch {
      /* nothing arrived in time — the read dies with the stream */
    }
  }
}

// ── Core bootloader operations ───────────────────────────────────────────────

/** GET_SYNC handshake — the bootloader answers [INSYNC, OK]. */
async function syncOnce(link: Stk500Link, timeoutMs: number): Promise<void> {
  const response = await link.transact([Cmnd_STK_GET_SYNC, STK_EOP], 2, timeoutMs, "GET_SYNC");
  link.assertInsyncOk(response, "GET_SYNC");
}

/** READ_SIGN → [sig0, sig1, sig2, INSYNC, OK]. */
async function readSignature(link: Stk500Link): Promise<[number, number, number]> {
  const response = await link.transact([Cmnd_STK_READ_SIGN, STK_EOP], 5, 1000, "READ_SIGN");
  if (response[3] !== RESP_INSYNC || response[4] !== RESP_OK) {
    throw new StkProtocolError(
      `READ_SIGN: bad trailer [${hex2(response[3] ?? 0)} ${hex2(response[4] ?? 0)}] — expected [${hex2(RESP_INSYNC)} ${hex2(RESP_OK)}]`,
    );
  }
  return [response[0]!, response[1]!, response[2]!];
}

/** GET_PARAMETER → [value, OK]. Best-effort: older bootloaders may reject. */
async function readParameter(link: Stk500Link, param: number): Promise<number | null> {
  try {
    const response = await link.transact([Cmnd_STK_GET_PARAMETER, param, STK_EOP], 2, 800, "GET_PARAMETER");
    if (response[1] !== RESP_OK) return null;
    return response[0]!;
  } catch {
    return null;
  }
}

/**
 * Enter programming mode with tolerance: optiboot actually enters prog mode on
 * the first flash command, and some clones answer without the INSYNC marker.
 */
async function enterProgMode(link: Stk500Link): Promise<void> {
  await link.write([Cmnd_STK_ENTER_PROGMODE, STK_EOP]);
  try {
    const response = await link.readBytes(2, 1000);
    link.assertInsyncOk(response, "ENTER_PROGMODE");
  } catch (error) {
    if (error instanceof StkTimeoutError) return; // proceed — pages will tell the truth
    throw error;
  }
}

/** SET_ADDRESS (word-addressed = byteAddress/2, big-endian) + PROG_PAGE. */
async function programPage(link: Stk500Link, byteAddress: number, page: Uint8Array, log: LogFn): Promise<void> {
  if (page.length % 2 !== 0) throw new StkProtocolError("page size must be even (word addressing)");
  const wordAddress = byteAddress >> 1;

  // LOAD_ADDRESS: 'U' + hi + lo + EOP → [INSYNC, OK]
  const addrResponse = await link.transact(
    [Cmnd_STK_LOAD_ADDRESS, (wordAddress >> 8) & 0xff, wordAddress & 0xff, STK_EOP],
    2,
    1000,
    "LOAD_ADDRESS",
  );
  link.assertInsyncOk(addrResponse, "LOAD_ADDRESS");

  // PROG_PAGE: 'd' + sizeHi + sizeLo + 'F' + data + EOP → [INSYNC, OK]
  const size = page.length;
  const frame = new Uint8Array(4 + size + 1);
  frame[0] = Cmnd_STK_PROG_PAGE;
  frame[1] = (size >> 8) & 0xff;
  frame[2] = size & 0xff;
  frame[3] = FLOW_FLAG_FLASH;
  frame.set(page, 4);
  frame[4 + size] = STK_EOP;
  const pageResponse = await link.transact(frame, 2, 2000, "PROG_PAGE");
  link.assertInsyncOk(pageResponse, "PROG_PAGE");
  log(`page 0x${byteAddress.toString(16).padStart(4, "0")} programmed (${size} bytes)`);
}

/**
 * Baud used by the current open() in the sync loop. Set right before every
 * sync sequence by the public entry points.
 */
let activeBaud = 115200;

/**
 * Run the full sync handshake with DTR auto-reset.
 * - `rounds`: outer retries (each performs a fresh DTR reset edge).
 * - `attempts`: GET_SYNC tries per round, 500 ms pauses between.
 * On failure the caller should tell the user to press the RESET button right
 * as flashing starts — that is exactly what rounds 2..N give them a window for.
 * Leaves the port OPEN with the link returned (caller owns it).
 */
async function syncWithReset(
  port: SerialPort,
  options: { rounds: number; attempts: number; timeoutMs: number; log: LogFn },
): Promise<Stk500Link> {
  const { rounds, attempts, timeoutMs, log } = options;
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) {
      log(`sync round ${round}/${rounds} — press the RESET button on the board right now if this keeps failing`);
    }
    await dtrAutoReset(port);
    const link = Stk500Link.acquire(port);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await syncOnce(link, timeoutMs);
        log(`bootloader synced (GET_SYNC ok — round ${round}, attempt ${attempt})`);
        return link;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(`sync attempt ${attempt}/${attempts} failed (${reason}) — retrying in 500 ms`);
        await sleep(500);
      }
    }
    // Round failed: tear the stream down and reopen so the next round starts
    // from a clean port (abort() may have cancelled the readable).
    await link.abort();
    await closePortQuietly(port);
    if (round < rounds) await port.open({ baudRate: activeBaud });
  }
  throw new StkTimeoutError(
    `bootloader did not sync after ${rounds} rounds × ${attempts} attempts — press the board RESET button right as flashing starts, then try again`,
  );
}

export interface Stk500IdentifyOptions {
  port: SerialPort;
  log: LogFn;
  /** Baud rates to probe in order (default 115200 → 57600 → 9600). */
  bauds?: number[];
  /** DTR-reset + sync rounds per baud (default 3). */
  roundsPerBaud?: number;
}

export interface Stk500IdentifyResult {
  signature: [number, number, number] | null;
  /** Pretty hex like "0x1E 0x95 0x0F". */
  signatureHex: string | null;
  chipName: string | null;
  boards: string | null;
  baud: number | null;
  /** optiboot software version, e.g. "v4.6" (best effort). */
  bootloaderVersion: string | null;
}

/**
 * Board/chip identification: probe the standard bootloader baud rates, DTR-
 * reset at each, attempt STK500 sync, then read the device signature.
 * Leaves the port CLOSED (the caller decides what mode to enter next).
 */
export async function stk500Identify(options: Stk500IdentifyOptions): Promise<Stk500IdentifyResult> {
  const { port, log } = options;
  const bauds = options.bauds ?? [115200, 57600, 9600];
  const roundsPerBaud = options.roundsPerBaud ?? 3;

  for (const baud of bauds) {
    log(`probing bootloader at ${baud} baud…`);
    activeBaud = baud;
    try {
      await closePortQuietly(port);
      await port.open({ baudRate: baud });
    } catch (error) {
      log(`could not open at ${baud} baud: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      const link = await syncWithReset(port, { rounds: roundsPerBaud, attempts: 2, timeoutMs: 450, log });
      try {
        const signature = await readSignature(link);
        const chip = chipForSignature(signature);
        const major = await readParameter(link, PARAM_SW_MAJOR);
        const minor = await readParameter(link, PARAM_SW_MINOR);
        log(
          `device signature ${signatureHex(signature)} — ${chip ? `${chip.name} (${chip.boards})` : "unknown chip"}`,
        );
        await link.close();
        return {
          signature,
          signatureHex: signatureHex(signature),
          chipName: chip?.name ?? null,
          boards: chip?.boards ?? null,
          baud,
          bootloaderVersion: major !== null && minor !== null ? `v${major}.${minor}` : null,
        };
      } catch (error) {
        log(`signature read failed: ${error instanceof Error ? error.message : String(error)}`);
        await link.abort();
      }
    } catch (error) {
      // syncWithReset already logged per-attempt details; try the next baud.
      log(error instanceof Error ? error.message : String(error));
    }
    await closePortQuietly(port);
  }

  return {
    signature: null,
    signatureHex: null,
    chipName: null,
    boards: null,
    baud: null,
    bootloaderVersion: null,
  };
}

// ── Flashing ─────────────────────────────────────────────────────────────────

export interface Stk500FlashOptions {
  port: SerialPort;
  /** Bootloader baud (use the one identify() synced at). */
  baud: number;
  /** Full flash image (gaps already filled with 0xFF by the HEX parser). */
  image: Uint8Array;
  pageSize?: number;
  log: LogFn;
  onProgress?: (pagesWritten: number, pagesTotal: number) => void;
  /** Outer DTR-reset retry rounds when sync fails (default 3). */
  syncRounds?: number;
  /** GET_SYNC attempts per round with 500 ms pauses (default 5). */
  syncAttempts?: number;
}

export interface Stk500FlashResult {
  signature: [number, number, number];
  chipName: string | null;
  pagesWritten: number;
  pagesTotal: number;
  bytesWritten: number;
  durationMs: number;
}

const isErasedPage = (page: Uint8Array): boolean => {
  for (let i = 0; i < page.length; i++) if (page[i] !== 0xff) return false;
  return true;
};

/**
 * Program `image` into the AVR flash over STK500v1:
 * sync → signature → enter progmode → per page [SET_ADDRESS + PROG_PAGE] →
 * leave progmode → exit. Skips 0xFF (erased) pages like avrdude does.
 * Closes the port before returning — the bootloader jumped to the app.
 */
export async function stk500Flash(options: Stk500FlashOptions): Promise<Stk500FlashResult> {
  const { port, baud, image, log, onProgress } = options;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const startedAt = Date.now();
  activeBaud = baud;

  await closePortQuietly(port);
  await port.open({ baudRate: baud });
  log(`port open at ${baud} baud — entering bootloader sync sequence`);

  let link: Stk500Link | null = null;
  try {
    link = await syncWithReset(port, {
      rounds: options.syncRounds ?? 3,
      attempts: options.syncAttempts ?? 5,
      timeoutMs: 480,
      log,
    });

    // Signature — verify the chip matches what we think we are flashing.
    const signature = await readSignature(link);
    const chip = chipForSignature(signature);
    log(
      `device signature ${signatureHex(signature)} — ${chip ? chip.name : "UNKNOWN CHIP"}${chip ? ` (${chip.boards})` : "; check you picked the right board"}`,
    );

    await enterProgMode(link);

    // Count pages that actually contain data (avrdude-style skip of erased
    // pages) so the progress bar denominators are honest.
    const pageCount = Math.ceil(image.length / pageSize);
    let pagesTotal = 0;
    for (let p = 0; p < pageCount; p++) {
      const page = image.subarray(p * pageSize, Math.min((p + 1) * pageSize, image.length));
      if (!isErasedPage(page)) pagesTotal += 1;
    }
    log(
      `flash image: ${image.length} bytes → ${pagesTotal} of ${pageCount} pages contain data (${pageSize}-byte pages)`,
    );

    let pagesWritten = 0;
    let bytesWritten = 0;
    for (let p = 0; p < pageCount; p++) {
      const byteAddress = p * pageSize;
      const raw = image.subarray(byteAddress, Math.min(byteAddress + pageSize, image.length));
      if (isErasedPage(raw)) continue;
      // PROG_PAGE always writes full pages — pad the tail with 0xFF.
      const page = new Uint8Array(pageSize).fill(0xff);
      page.set(raw);
      await programPage(link, byteAddress, page, log);
      pagesWritten += 1;
      bytesWritten += raw.length;
      onProgress?.(pagesWritten, pagesTotal);
    }

    // LEAVE_PROGMODE ('Q') — optiboot answers then jumps to the app; some
    // clones never answer because the app takes over instantly. Tolerate both.
    let leaveAnswered = true;
    try {
      await link.write([Cmnd_STK_LEAVE_PROGMODE, STK_EOP]);
      const response = await link.readBytes(2, 800);
      link.assertInsyncOk(response, "LEAVE_PROGMODE");
    } catch (error) {
      if (!(error instanceof StkTimeoutError)) throw error;
      leaveAnswered = false;
    }
    // Legacy EXIT ('L') — no response expected.
    try {
      await link.write([Cmnd_STK_EXIT, STK_EOP]);
    } catch {
      /* port may already be gone — fine */
    }
    log(
      leaveAnswered
        ? "bootloader left programming mode — app rebooting"
        : "bootloader jumped to the app (no LEAVE response — normal on some bootloaders)",
    );

    await link.close();
    await closePortQuietly(port);
    const durationMs = Date.now() - startedAt;
    log(`flash complete: ${pagesWritten} pages / ${bytesWritten} bytes in ${(durationMs / 1000).toFixed(1)} s`);
    return {
      signature,
      chipName: chip?.name ?? null,
      pagesWritten,
      pagesTotal,
      bytesWritten,
      durationMs,
    };
  } catch (error) {
    log(`flash failed: ${error instanceof Error ? error.message : String(error)}`);
    if (link) await link.abort();
    await closePortQuietly(port);
    throw error;
  }
}
