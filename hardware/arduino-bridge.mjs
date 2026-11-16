#!/usr/bin/env node
/**
 * AttendX Arduino compile bridge — one file, no dependencies.
 *
 * The browser cannot run avr-gcc, and the managed AttendX server may not have
 * arduino-cli installed. This bridge runs on YOUR machine (the same one whose
 * USB ports hold the Arduino), shells out to a local arduino-cli, and hands
 * the compiled .hex back to the Sketch Lab so the Web Serial flasher can burn
 * it — write in the browser, compile locally, flash locally.
 *
 * Chromium treats http://127.0.0.1 as a trustworthy origin, so the HTTPS app
 * page may call this HTTP endpoint directly (mixed-content exempt).
 *
 * Usage:
 *   1. Install arduino-cli:  https://arduino.github.io/arduino-cli
 *      brew install arduino-cli            (macOS)
 *      curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh
 *   2. One-time AVR toolchain fetch (~60 MB):
 *      arduino-cli core install arduino:avr
 *   3. Start the bridge:
 *      node hardware/arduino-bridge.mjs            (port 8791, default)
 *      node hardware/arduino-bridge.mjs 9000       (custom port)
 *      bun hardware/arduino-bridge.mjs             (works with bun too)
 *   4. In AttendX → Arduino Lab → Sketch Lab, set Compiler host = "Local
 *      bridge" (the default URL http://127.0.0.1:8791 is pre-filled), then
 *      hit Compile. The hex auto-loads into the Firmware Flasher.
 *
 * Endpoints:
 *   POST /probe    {}                       → { available, version, detail? }
 *   POST /compile  { source, name?, fqbn? } → { hexText, fqbn, logTail } | 422/501
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ code: -1, stdout, stderr: `${stderr}\n[bridge] killed after ${COMPILE_TIMEOUT_MS} ms timeout` });
      }
    }, COMPILE_TIMEOUT_MS);
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

// ── server ───────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found — POST /probe or POST /compile" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AttendX Arduino compile bridge on http://127.0.0.1:${PORT}`);
  console.log("Sketch Lab → Compiler host = Local bridge → Compile → Flash in panel 03.");
});
