/**
 * Arduino Lab compiler host — runs arduino-cli on the AttendX API server.
 *
 * The browser cannot run avr-gcc, so the Sketch Lab delegates compilation to
 * a host that has the toolchain. This router is the "AttendX server" host:
 *
 *   POST /api/arduino/probe    { }                         → { available, version }
 *   POST /api/arduino/compile  { source, name?, fqbn? }    → { hexText, fqbn, logTail }
 *
 * Design rules:
 * - arduino-cli is optional infrastructure. When it is missing the endpoints
 *   answer 501 with an honest setup hint instead of pretending; the UI then
 *   offers the local bridge (hardware/arduino-bridge.mjs) instead.
 * - No shell interpolation anywhere: inputs are validated (name → strict C
 *   identifier, fqbn → whitelist regex) and everything is spawned as argv.
 * - Each compile writes a fresh temp dir `<tmp>/<name>/<name>.ino`, compiles
 *   with a hard timeout, harvests the produced .hex, and always cleans up.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireAdminLevel } from "../lib/auth";

const router = Router();

const COMPILE_TIMEOUT_MS = 180_000;
const MAX_SOURCE_CHARS = 80_000;
const LOG_TAIL_CHARS = 8_000;

const SETUP_HINT =
  "arduino-cli is not installed on this server. Install it (https://arduino.github.io/arduino-cli) and run " +
  "`arduino-cli core install arduino:avr`, or start the one-file bridge on your own machine: " +
  "node hardware/arduino-bridge.mjs";

const compileSchema = z.object({
  source: z.string().min(16).max(MAX_SOURCE_CHARS),
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "sketch name must be a C identifier")
    .optional(),
  fqbn: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.:-]{3,80}$/, "invalid FQBN")
    .optional(),
});

/** Locator for the CLI: explicit env override wins, then PATH lookup. */
async function findArduinoCli(): Promise<string | null> {
  const candidates = [process.env.ARDUINO_CLI_PATH, "arduino-cli"].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  for (const candidate of candidates) {
    const found = await new Promise<string | null>((resolve) => {
      try {
        const child = spawn(candidate, ["version"], { stdio: "ignore" });
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code === 0 ? candidate : null));
        // Safety net if neither event fires (e.g. PATH weirdness).
        setTimeout(() => {
          child.kill();
          resolve(null);
        }, 5000).unref();
      } catch {
        resolve(null);
      }
    });
    if (found) return found;
  }
  return null;
}

/** Run a command, capturing stdout/stderr with a hard timeout. */
function runCommand(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        resolve({ code: -1, stdout, stderr: `${stderr}\n[attendx] killed after ${opts.timeoutMs} ms timeout` });
      }
    }, opts.timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: `${stderr}\n[attendx] spawn error: ${error.message}` });
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

async function tail(text: string, chars: number): Promise<string> {
  const clean = text.trim();
  return clean.length <= chars ? clean : `…${clean.slice(-chars)}`;
}

/** Depth-first scan of the output dir for a compiled .hex image. */
async function findHexFile(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return null;
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

router.post("/arduino/probe", (async (_req, res) => {
  const cli = await findArduinoCli();
  if (!cli) {
    res.status(501).json({ available: false, hint: SETUP_HINT });
    return;
  }
  const result = await runCommand(cli, ["version"], { timeoutMs: 10_000 });
  const versionMatch = /Version:\s*([0-9][^\s]*)/.exec(result.stdout);
  res.json({
    available: result.code === 0,
    version: versionMatch?.[1] ?? "unknown",
    detail: result.code === 0 ? undefined : "arduino-cli found but `arduino-cli version` failed.",
  });
}) as RequestHandler);

router.post("/arduino/compile", requireAdminLevel, (async (req, res) => {
  const parsed = compileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const name = (parsed.data.name ?? "attendx_sketch").replace(/[^A-Za-z0-9_-]/g, "");
  const fqbn = parsed.data.fqbn ?? "arduino:avr:uno";
  const source = parsed.data.source;

  const cli = await findArduinoCli();
  if (!cli) {
    res.status(501).json({ error: "arduino-cli not found", hint: SETUP_HINT });
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), `atx-arduino-${randomUUID().slice(0, 8)}-`));
  const started = Date.now();
  try {
    const sketchDir = join(workDir, name);
    await writeFile(join(sketchDir, `${name}.ino`), source, { flag: "wx" });
    const outDir = join(workDir, "build");

    const result = await runCommand(
      cli,
      ["compile", "--fqbn", fqbn, "--output-dir", outDir, "--no-color", join(sketchDir, `${name}.ino`)],
      { timeoutMs: COMPILE_TIMEOUT_MS },
    );

    const logTail = await tail(`${result.stdout}\n${result.stderr}`, LOG_TAIL_CHARS);
    if (result.code !== 0) {
      res.status(422).json({ error: "Compilation failed", logTail });
      return;
    }

    const hexPath = await findHexFile(outDir);
    if (!hexPath) {
      res.status(422).json({
        error: `Compiler exited 0 but produced no .hex under the output dir (fqbn ${fqbn} may target a non-flashable format)`,
        logTail,
      });
      return;
    }
    const hexText = await readFile(hexPath, "utf-8");

    res.json({
      fqbn,
      hexText,
      hexBytes: hexText.length,
      elapsedMs: Date.now() - started,
      logTail,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Compile host error",
    });
  } finally {
    void rm(workDir, { recursive: true, force: true }).catch(() => {
      /* temp cleanup best effort */
    });
  }
}) as RequestHandler);

export default router;
