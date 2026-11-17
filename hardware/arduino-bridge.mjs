#!/usr/bin/env node
/**
 * AttendX Arduino compile + SERIAL RELAY bridge — one file, no dependencies.
 *
 * Two jobs, both about putting YOUR machine in the loop:
 *
 * 1. COMPILE — the browser cannot run avr-gcc, and the managed AttendX server
 *    may not have arduino-cli installed. This bridge shells out to a local
 *    arduino-cli and hands the compiled .hex back to the Sketch Lab so the
 *    Web Serial flasher can burn it — write in the browser, compile locally,
 *    flash locally.
 *
 * 2. SERIAL RELAY — Web Serial only exists in Chromium desktop browsers, so
 *    Firefox/Safari/mobile could never even see the board. The relay opens
 *    the Arduino's serial port HERE (on the machine whose USB ports hold the
 *    board) and streams its bytes to any browser as Server-Sent Events, with
 *    writes going back over POST. Monitor, control terminal and AttendX
 *    ingestion all work through it — from any browser, including one on a
 *    different device on the network. (Flashing still wants direct Web
 *    Serial: STK500v1 timing over two network hops is asking for trouble.)
 *    Linux/macOS: the port is configured with stty(1); Windows users should
 *    use Chrome + Web Serial.
 *
 * Chromium treats http://127.0.0.1 as a trustworthy origin, so the HTTPS app
 * page may call this HTTP endpoint directly (mixed-content exempt).
 *
 * Usage:
 *   1. Install arduino-cli (compile only): https://arduino.github.io/arduino-cli
 *      brew install arduino-cli            (macOS)
 *      curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh
 *      arduino-cli core install arduino:avr
 *   2. Start the bridge:
 *      node hardware/arduino-bridge.mjs            (port 8791, default)
 *      node hardware/arduino-bridge.mjs 9000       (custom port)
 *      bun hardware/arduino-bridge.mjs             (works with bun too)
 *   3. AttendX → Arduino Lab:
 *      Sketch Lab → Compiler host = "Local bridge" → Compile
 *      Connection → Remote Serial Bridge → List ports → Open
 *
 * Endpoints:
 *   POST /probe           {}                          → { available, version, detail? }
 *   POST /compile         { source, name?, fqbn? }    → { hexText, fqbn, logTail } | 422/501
 *   GET  /serial/ports                                 → { ports: [{path, board_name, fqbn}] }
 *   GET  /serial/status                                → { open, path, baud }
 *   POST /serial/open     { path, baud }              → { open: true, path, baud }
 *   POST /serial/write    { text? } | { data(b64) }   → { written }
 *   POST /serial/close    {}                          → { closed: true }
 *   GET  /serial/rx       (SSE)                       → event: rx {data(b64)} | err | closed
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile, open as fsOpen } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || process.env.BRIDGE_PORT || 8791);
const COMPILE_TIMEOUT_MS = 180_000;
const LOG_TAIL_CHARS = 8_000;

// ── helpers ──────────────────────────────────────────────────────────────────

function findArduinoCli() {
  return new Promise((resolve) => {
    const candidate = process.env.ARDUINO_CLI_PATH || "arduino-cli";
    const child = spawn(candidate, ["version"], { stdio: "ignore" });
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? candidate : null));
    setTimeout(() => {
      child.kill();
      done(null);
    }, 5000).unref();
  });
}

function runCommand(file, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? COMPILE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ code: -1, stdout, stderr: `${stderr}\n[bridge] killed after ${timeoutMs} ms timeout` });
      }
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (c) => {
      stdout += c.toString("utf-8");
      if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000);
    });
    child.stderr?.on("data", (c) => {
      stderr += c.toString("utf-8");
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: `${stderr}\n[bridge] spawn error: ${error.message}` });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
  });
}

const tail = (text, chars) => {
  const clean = text.trim();
  return clean.length <= chars ? clean : `…${clean.slice(-chars)}`;
};

async function findHexFile(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findHexFile(full);
      if (nested) return nested;
    } else if (entry.name.toLowerCase().endsWith(".hex")) {
      return full;
    }
  }
  return null;
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleProbe(res) {
  const cli = await findArduinoCli();
  if (!cli) {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        available: false,
        detail: "arduino-cli not found — install it, then run `arduino-cli core install arduino:avr`",
      }),
    );
    return;
  }
  const result = await runCommand(cli, ["version"]);
  const versionMatch = /Version:\s*([0-9][^\s]*)/.exec(result.stdout);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ available: result.code === 0, version: versionMatch?.[1] ?? "unknown" }));
}

async function handleCompile(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `bad request body: ${error.message}` }));
    return;
  }

  const rawName = typeof body.name === "string" ? body.name : "attendx_sketch";
  const name = rawName.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "attendx_sketch";
  if (!/^[A-Za-z]/.test(name)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "sketch name must start with a letter" }));
    return;
  }
  const fqbn = typeof body.fqbn === "string" && /^[A-Za-z0-9_.:-]{3,80}$/.test(body.fqbn) ? body.fqbn : "arduino:avr:uno";
  const source = typeof body.source === "string" ? body.source : "";
  if (source.length < 16 || source.length > 80_000) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "source must be 16..80000 chars" }));
    return;
  }

  const cli = await findArduinoCli();
  if (!cli) {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "arduino-cli not found", detail: "install arduino-cli, then `arduino-cli core install arduino:avr`" }));
    return;
  }

  const started = Date.now();
  const workDir = await mkdtemp(join(tmpdir(), "atx-bridge-"));
  try {
    const sketchDir = join(workDir, name);
    await writeFile(join(sketchDir, `${name}.ino`), source, { flag: "wx" });
    const outDir = join(workDir, "build");

    console.log(`[bridge] compiling ${name} (${source.length} chars) → ${fqbn}`);
    const result = await runCommand(cli, ["compile", "--fqbn", fqbn, "--output-dir", outDir, "--no-color", join(sketchDir, `${name}.ino`)]);
    const logTail = await tail(`${result.stdout}\n${result.stderr}`, LOG_TAIL_CHARS);

    if (result.code !== 0) {
      console.log("[bridge] compile FAILED");
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Compilation failed", logTail }));
      return;
    }

    const hexPath = await findHexFile(outDir);
    if (!hexPath) {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `no .hex produced for ${fqbn}`, logTail }));
      return;
    }
    const hexText = await readFile(hexPath, "utf-8");
    console.log(`[bridge] compiled in ${((Date.now() - started) / 1000).toFixed(1)}s → ${hexPath}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ fqbn, hexText, hexBytes: hexText.length, elapsedMs: Date.now() - started, logTail }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message ?? "bridge error" }));
  } finally {
    rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── serial relay (Linux/macOS; Windows → use Web Serial) ───────────────────

const SERIAL_BAUDS = new Set([
  300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 115200,
  230400, 250000, 500000, 1000000,
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serialHandle = null; // FileHandle | null
let serialPath = null;
let serialBaud = null;
let serialStopping = false;
const sseClients = new Set();

function serialBroadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function serialReadLoop() {
  const buffer = Buffer.alloc(4096);
  while (serialHandle && !serialStopping) {
    try {
      const { bytesRead } = await serialHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        serialBroadcast("rx", { data: buffer.subarray(0, bytesRead).toString("base64"), path: serialPath });
      } else {
        await sleep(10); // zero-byte read — brief pause before polling again
      }
    } catch (error) {
      if (error?.code === "EAGAIN") {
        await sleep(20); // non-blocking fd with nothing to read — poll again
        continue;
      }
      serialBroadcast("err", { message: error?.message ?? "serial read failed", path: serialPath });
      break;
    }
  }
  if (!serialStopping) {
    // Unexpected loop exit — tear the session down so state stays honest.
    const closedPath = serialPath;
    await closeSerialQuietly();
    serialBroadcast("closed", { path: closedPath });
  }
}

async function closeSerialQuietly() {
  const handle = serialHandle;
  serialHandle = null;
  serialPath = null;
  serialBaud = null;
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    /* the port was already gone */
  }
}

async function handleSerialOpen(req, res) {
  if (process.platform === "win32") {
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "The serial relay is Linux/macOS only — on Windows open the board directly with Web Serial (Chrome/Edge).",
    }));
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `bad request body: ${error.message}` }));
    return;
  }
  const path = typeof body.path === "string" ? body.path.trim() : "";
  const baud = Number(body.baud);
  if (!/^\/(dev\/)?[A-Za-z0-9._/:-]+$/.test(path) || path.includes("..")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `invalid serial path "${path.slice(0, 80)}"` }));
    return;
  }
  if (!SERIAL_BAUDS.has(baud)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `unsupported baud ${body.baud} — use one of ${[...SERIAL_BAUDS].join(", ")}` }));
    return;
  }

  const devicePath = path.startsWith("/dev/") ? path : `/dev/${path}`;

  // Configure line discipline first: raw 8N1 at the requested baud, no echo,
  // no flow control. stty is the only zero-dependency way to set termios.
  const sttyFlag = process.platform === "darwin" ? "-f" : "-F";
  const stty = await runCommand(
    "stty",
    [sttyFlag, devicePath, String(baud), "raw", "-echo", "-echoe", "-echok", "-echoctl", "-echoke", "cs8", "clocal", "-crtscts", "-ixany", "-ixon", "-ixoff"],
    { timeoutMs: 5000 },
  );
  if (stty.code !== 0) {
    res.writeHead(422, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: `could not configure ${devicePath} at ${baud} baud`,
      detail: tail(`${stty.stderr}\n${stty.stdout}`, 400) || "is the device present, and does this user have permission? (dialout group / sudo udev rule)",
    }));
    return;
  }

  await closeSerialQuietly();
  let handle;
  try {
    handle = await fsOpen(devicePath, fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
  } catch (error) {
    res.writeHead(422, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: `could not open ${devicePath}: ${error.message}`,
      detail: "another program may hold the port (Arduino IDE / Arduino Lab / modemmanager) — close it and retry",
    }));
    return;
  }

  serialHandle = handle;
  serialPath = devicePath;
  serialBaud = baud;
  serialStopping = false;
  console.log(`[bridge] serial open ${devicePath} @ ${baud} 8N1 (raw)`);
  void serialReadLoop();

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ open: true, path: devicePath, baud }));
}

async function handleSerialWrite(req, res) {
  if (!serialHandle) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no serial port is open — POST /serial/open first" }));
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req, 256 * 1024)) || "{}");
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `bad request body: ${error.message}` }));
    return;
  }
  let bytes = null;
  if (typeof body.data === "string") {
    bytes = Buffer.from(body.data, "base64");
  } else if (typeof body.text === "string") {
    bytes = Buffer.from(body.text, "utf-8");
  }
  if (!bytes) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "body needs a text or base64 data field" }));
    return;
  }
  try {
    await serialHandle.write(bytes);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ written: bytes.length }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error?.message ?? "write failed" }));
  }
}

async function handleSerialPorts(res) {
  // Preferred: arduino-cli enumerates ports AND identifies attached boards.
  const cli = await findArduinoCli();
  if (cli) {
    const result = await runCommand(cli, ["board", "list", "--format", "json"], { timeoutMs: 15000 });
    if (result.code === 0) {
      try {
        const parsed = JSON.parse(result.stdout);
        const ports = (Array.isArray(parsed) ? parsed : parsed?.ports ?? [])
          .map((p) => ({
            path: p.address ?? p.port ?? null,
            board_name: p.board_name ?? null,
            fqbn: p.fqbn ?? null,
          }))
          .filter((p) => typeof p.path === "string" && p.path.length > 0);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ports, via: "arduino-cli" }));
        return;
      } catch {
        /* fall through to the /dev scan */
      }
    }
  }
  // Fallback: glob /dev for the usual serial suspects (unix only).
  if (process.platform === "win32") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ports: [], via: "unavailable-on-win32" }));
    return;
  }
  try {
    const entries = await readdir("/dev");
    const rx = /(ttyUSB\d+|ttyACM\d+|tty\.usbserial-.*|tty\.usbmodem.*|cu\.usb.*)/;
    const ports = entries
      .filter((n) => rx.test(n))
      .sort()
      .map((n) => ({ path: `/dev/${n}`, board_name: null, fqbn: null }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ports, via: "dev-scan" }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error?.message ?? "dev scan failed" }));
  }
}

// ── server ───────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const path = (req.url || "/").split("?")[0];
  if (req.method === "POST" && (path === "/probe" || path === "/")) {
    handleProbe(res).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }
  if (req.method === "POST" && path === "/compile") {
    handleCompile(req, res).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }
  if (req.method === "GET" && path === "/serial/ports") {
    handleSerialPorts(res).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }
  if (req.method === "GET" && path === "/serial/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ open: serialHandle !== null, path: serialPath, baud: serialBaud }));
    return;
  }
  if (req.method === "POST" && path === "/serial/open") {
    handleSerialOpen(req, res).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }
  if (req.method === "POST" && path === "/serial/write") {
    handleSerialWrite(req, res).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }
  if (req.method === "POST" && path === "/serial/close") {
    void (async () => {
      serialStopping = true;
      const hadPort = serialHandle !== null;
      await closeSerialQuietly();
      serialStopping = false;
      serialBroadcast("closed", { path: null });
      if (hadPort) console.log("[bridge] serial closed by client");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ closed: true }));
    })();
    return;
  }
  if (req.method === "GET" && path === "/serial/rx") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ open: serialHandle !== null, path: serialPath, baud: serialBaud })}\n\n`);
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found — POST /probe, POST /compile, GET /serial/ports, POST /serial/open|write|close, GET /serial/rx" }));
});

// SSE keepalive so proxies/EventSource never time out on a quiet port.
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(": ping\n\n");
    } catch {
      sseClients.delete(res);
    }
  }
}, 15_000).unref();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AttendX Arduino bridge (compile + serial relay) on http://127.0.0.1:${PORT}`);
  console.log("Sketch Lab → Compiler host = Local bridge → Compile → Flash in panel 03.");
  console.log("Connection → Remote Serial Bridge → List ports → Open → monitor from any browser.");
});

process.on("SIGINT", () => {
  serialStopping = true;
  if (serialHandle) {
    serialHandle.close().catch(() => {});
  }
  process.exit(0);
});
