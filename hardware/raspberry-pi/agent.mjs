import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Database from "better-sqlite3";
import canvas from "canvas";
import * as faceapi from "@vladmandic/face-api";
import "@tensorflow/tfjs-node";
import { SerialPort } from "serialport";

const API_BASE = process.env.ATTENDX_API_BASE?.replace(/\/+$/, "");
const TOKEN_FILE = process.env.ATTENDX_TOKEN_FILE ?? "/var/lib/attendx/pi-token";
const MODEL_URL = process.env.ATTENDX_MODEL_URL ?? "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model";
const SPOOL_FILE = process.env.ATTENDX_SPOOL_FILE ?? "/var/lib/attendx/spool.sqlite";
const ARDUINO_PORT = process.env.ATTENDX_ARDUINO_PORT ?? "/dev/ttyACM0";
// Phase 4 — Gate Integrity Validator: dedicated Arduino running
// AttendXGateValidator.ino on its OWN USB serial port (the fan controller
// keeps ARDUINO_PORT). Set ATTENDX_GATE_PORT=none to disable the link.
const GATE_PORT = process.env.ATTENDX_GATE_PORT ?? "/dev/ttyACM1";
const GATE_BAUD = Number(process.env.ATTENDX_GATE_BAUD ?? 9600);
const GATE_ID = process.env.ATTENDX_GATE_ID ?? "gate-1";
const GATE_FLUSH_MS = Number(process.env.ATTENDX_GATE_FLUSH_MS ?? 10_000);
const GATE_BUFFER_CAP = 500;
const CLASSROOM_ID = process.env.ATTENDX_CLASSROOM_ID ? Number(process.env.ATTENDX_CLASSROOM_ID) : null;
const CAPTURE_EVERY_MS = 900;
const FRAMES_PER_BATCH = 3;
const MAX_SPOOL_ITEMS = 256;
const SPOOL_TTL_SECONDS = 2 * 24 * 60 * 60;
const RESTART_SERVICE = "attendx-pi-agent";
const LOG_FILE = process.env.ATTENDX_LOG_FILE ?? "/var/lib/attendx/agent.log";
const { Canvas, Image, ImageData, loadImage } = canvas;

if (!API_BASE) throw new Error("ATTENDX_API_BASE is required (include the /api path).");
if (CLASSROOM_ID !== null && (!Number.isInteger(CLASSROOM_ID) || CLASSROOM_ID <= 0)) {
  throw new Error("ATTENDX_CLASSROOM_ID must be a positive integer.");
}

faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

fs.mkdirSync(path.dirname(SPOOL_FILE), { recursive: true, mode: 0o700 });
const spool = new Database(SPOOL_FILE);
fs.chmodSync(SPOOL_FILE, 0o600);
spool.exec(`
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    job_id INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS outbox_created_idx ON outbox(created_at);
`);

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    throw new Error(`Pi token missing. Pair in AttendX and install the one-time token at ${TOKEN_FILE}.`);
  }
}

function saveToken(token) {
  const temp = `${TOKEN_FILE}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(temp, TOKEN_FILE);
  fs.chmodSync(TOKEN_FILE, 0o600);
}

async function apiRequest(endpoint, { method = "GET", body } = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: {
      "X-Pi-Token": readToken(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: "Invalid JSON response" }; }
  if (!response.ok) throw new Error(`AttendX ${endpoint}: HTTP ${response.status} ${data.error ?? ""}`.trim());
  return data;
}

function localIp() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}

function cpuTempC() {
  try {
    return Number(fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim()) / 1000;
  } catch {
    return null;
  }
}

function queuedCount() {
  return Number(spool.prepare("SELECT COUNT(*) AS total FROM outbox").get().total);
}

function writeLog(level, message) {
  const line = `${new Date().toISOString()} ${level} ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
    fs.chmodSync(LOG_FILE, 0o600);
  } catch {}
  if (level === "ERROR") console.error(line.trim());
  else console.log(line.trim());
}

function enqueueOffline(kind, payload, jobId = null) {
  spool.prepare("INSERT INTO outbox (kind, payload, job_id, created_at) VALUES (?, ?, ?, ?)")
    .run(kind, JSON.stringify(payload), jobId, Math.floor(Date.now() / 1000));
  spool.prepare("DELETE FROM outbox WHERE created_at < ?")
    .run(Math.floor(Date.now() / 1000) - SPOOL_TTL_SECONDS);
  spool.prepare(`
    DELETE FROM outbox WHERE id IN (
      SELECT id FROM outbox ORDER BY id DESC LIMIT -1 OFFSET ?
    )
  `).run(MAX_SPOOL_ITEMS);
}

// ── Gate Integrity Validator serial link (Phase 4) ──────────────
// The gate Arduino pushes JSON pass-event lines asynchronously, so unlike
// the fan controller (request/response), this port stays OPEN and the
// agent listens continuously. Events are buffered in memory, flushed to
// /api/gate/sensor-events in batches, and spooled to SQLite when offline.
const gateBuffer = [];
let gateListenerActive = false;
let gateRetryTimer = null;

function scheduleGateRetry(reason) {
  gateListenerActive = false;
  if (gateRetryTimer) return;
  gateRetryTimer = setTimeout(() => {
    gateRetryTimer = null;
    openGateListener();
  }, 15_000);
  if (reason) writeLog("ERROR", reason);
}

function handleGateLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!event || event.event !== "pass") return;
  if (event.sensor !== "ultrasonic" && event.sensor !== "ir_beam") return;
  gateBuffer.push({
    sensor: event.sensor,
    ts: new Date().toISOString(),
    deviceTs: Number.isFinite(event.ts) ? event.ts : null,
  });
  if (gateBuffer.length > GATE_BUFFER_CAP) gateBuffer.splice(0, gateBuffer.length - GATE_BUFFER_CAP);
  writeLog("INFO", `Gate pass event buffered (${event.sensor}, queue=${gateBuffer.length})`);
}

function openGateListener() {
  if (GATE_PORT === "none" || gateListenerActive) return;
  const port = new SerialPort({ path: GATE_PORT, baudRate: GATE_BAUD, autoOpen: false });
  let pending = "";
  port.on("open", () => {
    gateListenerActive = true;
    writeLog("INFO", `Gate validator serial link open on ${GATE_PORT}`);
  });
  port.on("data", (buffer) => {
    pending += buffer.toString("utf8");
    let newlineAt;
    while ((newlineAt = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newlineAt);
      pending = pending.slice(newlineAt + 1);
      handleGateLine(line);
    }
    if (pending.length > 512) pending = "";
  });
  port.on("error", (error) => {
    scheduleGateRetry(`Gate serial error: ${error.message}`);
    try { port.close(() => {}); } catch {}
  });
  port.on("close", () => {
    if (gateRetryTimer === null) scheduleGateRetry("Gate serial link closed — retrying");
  });
  port.open((error) => {
    if (error) {
      scheduleGateRetry(
        `Gate validator unavailable on ${GATE_PORT}: ${error.message} (set ATTENDX_GATE_PORT=none to disable)`
      );
    }
  });
}

async function flushGateEvents() {
  if (!gateBuffer.length) return;
  const events = gateBuffer.splice(0, 200);
  const payload = { gateId: GATE_ID, events };
  try {
    await apiRequest("/gate/sensor-events", { method: "POST", body: payload });
    writeLog("INFO", `Gate events delivered: ${events.length}`);
  } catch (error) {
    enqueueOffline("gate-events", payload);
    writeLog("ERROR", `Gate events buffered locally: ${error.message}`);
  }
}

async function heartbeat(status = "connected") {
  const response = await apiRequest("/pi/heartbeat", {
    method: "POST",
    body: {
      status,
      localIp: localIp(),
      uptimeSeconds: Math.floor(os.uptime()),
      cpuTempC: cpuTempC(),
      queueDepth: queuedCount() + gateBuffer.length,
    },
  });
  if (typeof response.nextToken === "string") saveToken(response.nextToken);
}

function runFixedCommand(command, args, timeout = 5000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 32 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || `${command} exited with ${result.status}`).trim());
  return (result.stdout || "").trim();
}

function findCameraCommand() {
  for (const candidate of ["rpicam-still", "libcamera-still"]) {
    const result = spawnSync("which", [candidate], { encoding: "utf8", timeout: 1000 });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error("Install rpicam-apps or libcamera-apps to use the gate camera.");
}

async function captureFrame() {
  const tempFile = path.join(os.tmpdir(), `attendx-${process.pid}-${Date.now()}.jpg`);
  try {
    const command = findCameraCommand();
    const args = ["--nopreview", "--timeout", "250", "--width", "640", "--height", "480", "--output", tempFile];
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 8000, maxBuffer: 16 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || "Camera capture failed").trim());

    const image = await loadImage(tempFile);
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 });
    const detections = await faceapi
      .detectAllFaces(image, options)
      .withFaceLandmarks(true)
      .withFaceDescriptors();
    return detections.map((detection) => Array.from(detection.descriptor));
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

async function sendBatch(frames) {
  const payload = {
    batchId: randomUUID(),
    ...(CLASSROOM_ID === null ? {} : { classroomId: CLASSROOM_ID }),
    frames,
  };
  try {
    await apiRequest("/attendance/bulk-match", { method: "POST", body: payload });
  } catch (error) {
    enqueueOffline("bulk-match", payload);
    writeLog("ERROR", `Bulk attendance buffered locally: ${error.message}`);
  }
}

function serialCommand(command) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path: ARDUINO_PORT, baudRate: 9600, autoOpen: false });
    let pending = "";
    const timeout = setTimeout(() => {
      port.close(() => reject(new Error("Arduino response timed out")));
    }, 3500);
    port.on("data", (buffer) => {
      pending += buffer.toString("utf8");
      const lineBreak = pending.indexOf("\n");
      if (lineBreak < 0) return;
      const line = pending.slice(0, lineBreak).trim();
      try {
        const result = JSON.parse(line);
        clearTimeout(timeout);
        port.close(() => resolve(result));
      } catch {
        pending = pending.slice(lineBreak + 1);
      }
    });
    port.open((error) => {
      if (error) {
        clearTimeout(timeout);
        reject(error);
        return;
      }
      setTimeout(() => port.write(`${command}\n`), 1200);
    });
  });
}

function runAction(action) {
  switch (action) {
    case "worker-status":
      return { status: runFixedCommand("systemctl", ["is-active", RESTART_SERVICE]) };
    case "restart-worker":
      return { accepted: true, restartAfterReport: true };
    case "camera-status":
      return { cameraDevice: fs.existsSync("/dev/video0") ? "/dev/video0" : "not found" };
    case "recent-logs":
      return {
        lines: fs.existsSync(LOG_FILE)
          ? fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-30).join("\n")
          : "No local agent log is available yet.",
      };
    default:
      throw new Error("Unsupported fixed Pi action");
  }
}

async function processJob(job) {
  let result;
  let status = "done";
  let error = null;
  let restartAfterReport = false;
  try { await heartbeat("running_task"); } catch {}
  try {
    if (job.type === "pi_action") {
      result = runAction(job.payload.action);
      restartAfterReport = Boolean(result.restartAfterReport);
    } else if (job.type === "fan_override") {
      const mode = String(job.payload.mode).toUpperCase();
      if (!["AUTO", "ON", "OFF"].includes(mode)) throw new Error("Invalid fan mode");
      result = await serialCommand(`MODE ${mode}`);
    } else if (job.type === "fan_telemetry") {
      result = await serialCommand("STATUS");
    } else {
      throw new Error(`Unsupported Pi job type: ${job.type}`);
    }
  } catch (cause) {
    status = "failed";
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const completion = { status, result: result ?? null, error };
  try {
    await apiRequest(`/jobs/${job.id}/complete`, { method: "POST", body: completion });
  } catch (cause) {
    enqueueOffline("job-complete", completion, job.id);
    writeLog("ERROR", `Job ${job.id} result buffered locally: ${cause.message}`);
  }

  return restartAfterReport && status === "done";
}

async function drainOutbox() {
  const records = spool.prepare("SELECT * FROM outbox ORDER BY id LIMIT 10").all();
  for (const record of records) {
    const payload = JSON.parse(record.payload);
    try {
      if (record.kind === "bulk-match") {
        await apiRequest("/attendance/bulk-match", { method: "POST", body: payload });
      } else if (record.kind === "gate-events") {
        await apiRequest("/gate/sensor-events", { method: "POST", body: payload });
      } else if (record.kind === "job-complete") {
        await apiRequest(`/jobs/${record.job_id}/complete`, { method: "POST", body: payload });
      } else {
        throw new Error(`Unsupported local outbox item: ${record.kind}`);
      }
      spool.prepare("DELETE FROM outbox WHERE id = ?").run(record.id);
    } catch (error) {
      console.error("Offline queue is waiting for the server:", error.message);
      break;
    }
  }
}

async function main() {
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  writeLog("INFO", "AttendX Pi agent ready; raw frames remain on the device.");

  if (GATE_PORT !== "none") openGateListener();

  let nextHeartbeat = 0;
  let nextCapture = 0;
  let nextGateFlush = 0;
  let frames = [];
  while (true) {
    const now = Date.now();
    if (now >= nextHeartbeat) {
      try {
        await heartbeat();
        await drainOutbox();
      } catch (error) {
        writeLog("ERROR", `Heartbeat unavailable; retaining buffered work: ${error.message}`);
      }
      nextHeartbeat = now + 10_000;
    }

    try {
      const response = await apiRequest("/jobs/next");
      if (response.job && await processJob(response.job)) process.exit(0);
    } catch (error) {
      if (!String(error.message).includes("401")) writeLog("ERROR", `Pi job polling failed: ${error.message}`);
    }

    if (Date.now() >= nextGateFlush) {
      nextGateFlush = Date.now() + GATE_FLUSH_MS;
      try {
        await flushGateEvents();
      } catch (error) {
        writeLog("ERROR", `Gate event flush failed: ${error.message}`);
      }
    }

    if (Date.now() >= nextCapture) {
      nextCapture = Date.now() + CAPTURE_EVERY_MS;
      try {
        frames.push({ descriptors: await captureFrame() });
        if (frames.length >= FRAMES_PER_BATCH) {
          const batch = frames;
          frames = [];
          await sendBatch(batch);
        }
      } catch (error) {
        writeLog("ERROR", `Gate-camera capture failed: ${error.message}`);
      }
    }
    await sleep(250);
  }
}

main().catch((error) => {
  writeLog("ERROR", error.message);
  process.exitCode = 1;
});
