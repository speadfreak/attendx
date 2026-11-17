import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Cable,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  Cpu,
  Eraser,
  FileDown,
  FileUp,
  Hammer,
  History,
  Info,
  Loader2,
  RefreshCw,
  Save,
  ScanSearch,
  Server,
  Terminal,
  Trash2,
  TriangleAlert,
  Unplug,
  Upload,
  Usb,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { SectionTitle, GlowCard, MeshBackground } from "@/components/gx/Primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { CodeEditor } from "@/components/arduino/CodeEditor";
import { Hint } from "@/components/arduino/Hint";
import { Plotter, extractPlotValues, mergePlot, MAX_PLOT_POINTS, MAX_PLOT_SERIES, type PlotState } from "@/components/arduino/Plotter";
import { SerialTerminal } from "@/components/arduino/SerialTerminal";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  SerialMonitor,
  closePortQuietly,
  describeUsbDevice,
  formatUsbIds,
  isSerialSupported,
  listAuthorizedPorts,
  parseMonitorLine,
  requestSerialPort,
  type MonitorLine,
  type SerialConnectionEvent,
  type SerialPort,
  type SerialPortInfo,
} from "@/lib/arduino/serial";
import { BridgeSerialClient, type BridgePortInfo } from "@/lib/arduino/bridge-serial";
import { validateIntelHexForUno } from "@/lib/arduino/hex";
import { stk500Flash, stk500Identify } from "@/lib/arduino/stk500";
import { SKETCHES } from "@/lib/arduino/sketches";
import {
  CompileFailedError,
  CompileUnavailableError,
  DEFAULT_FQBN,
  FQBN_PRESETS,
  compileSketch,
  fqbnForChip,
  loadBridgeUrl,
  probeCompilers,
  saveBridgeUrl,
  type CompilerMode,
  type CompilerProbe,
} from "@/lib/arduino/compile";
import {
  fetchGates,
  postGateSensorEvents,
  type GateSensorEvent,
} from "@/lib/arduino/api";
import { cn } from "@/lib/utils";

/**
 * ARDUINO GATE CONTROLLER STUDIO — Phase 7 IDE edition.
 *
 * A six-panel, IDE-like surface for the attendance gate hardware:
 *   01 Connection       — universal Web Serial picker (NO vendor filter —
 *                         CP210x/FTDI/PL2303/ESP32/Pico all appear), quick
 *                         reconnect to already-authorized ports, a "can't
 *                         connect?" checklist, and the REMOTE SERIAL BRIDGE:
 *                         the board lives on any Linux/macOS machine and any
 *                         browser (even Firefox/iPad) drives it over SSE
 *   02 Sketch Lab       — highlighted C++ editor, compile via arduino-cli
 *                         (server endpoint or the operator's local bridge)
 *   03 Firmware flasher — Intel HEX parsing + hand-rolled STK500v1 programmer
 *                         (direct Web Serial only, by design)
 *   04 Sketch library   — gate-firmware sources with terminal command tables
 *   05 Control terminal — serial REPL (history + macros) → gate ingestion
 *   06 Serial plotter   — live strip-chart of numeric sensor fields
 *
 * Works with zero hardware: every panel renders, actions are disabled with
 * explanatory tooltips when Web Serial is missing or no port is granted.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Small presentational helpers
// ─────────────────────────────────────────────────────────────────────────────

const stamp = (d: Date): string =>
  `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;

function LedDot({ tone }: { tone: "idle" | "port" | "busy" | "on" | "flash" }) {
  const cls =
    tone === "on"
      ? "bg-emerald-400 shadow-[0_0_10px_2px_rgba(52,211,153,0.65)] animate-pulse"
      : tone === "busy"
        ? "bg-amber-400 shadow-[0_0_10px_2px_rgba(251,191,36,0.55)] animate-pulse"
        : tone === "flash"
          ? "bg-violet-400 shadow-[0_0_10px_2px_rgba(167,139,250,0.6)] animate-pulse"
          : tone === "port"
            ? "bg-slate-400"
            : "bg-slate-700";
  return <span aria-hidden="true" className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", cls)} />;
}

function PanelHead({
  step,
  title,
  sub,
  icon: Icon,
  right,
}: {
  step: string;
  title: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-foreground/10 pb-3">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 font-mono text-[11px] font-bold text-emerald-300"
        >
          {step}
        </span>
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold tracking-wide text-foreground/90">
            <Icon className="h-4 w-4 text-emerald-400" aria-hidden="true" />
            {title}
          </h2>
          {sub && <p className="mt-0.5 text-xs text-foreground/40">{sub}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

function InfoRow({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[11px] uppercase tracking-wider text-foreground/35">{label}</dt>
      <dd className={cn("text-right text-xs text-foreground/80", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

type ActivityLevel = "info" | "warn" | "error" | "ok";

interface ActivityLine {
  id: number;
  at: Date;
  text: string;
  level: ActivityLevel;
}

function levelFor(text: string): ActivityLevel {
  if (/\b(fail|error|mismatch|corrupt|unsupported|no bootloader|did not sync|aborted)\b/i.test(text)) return "error";
  if (/\b(press the reset|retry|warn|unknown|check you|not found|skip|unavailable)\b/i.test(text)) return "warn";
  if (/\b(complete|synced|signature|programmed|open at|compiled|loaded)\b/i.test(text)) return "ok";
  return "info";
}

const ACTIVITY_COLOR: Record<ActivityLevel, string> = {
  info: "text-slate-300",
  warn: "text-amber-300",
  error: "text-red-400",
  ok: "text-emerald-300",
};

const SCROLLBAR_CLASSES =
  "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-700/80 [&::-webkit-scrollbar-track]:bg-transparent";

/** Shared terminal console — timestamped, color-coded, scroll-capped. */
function Console({
  lines,
  emptyHint,
  ariaLabel,
  maxHeightClass = "max-h-64",
}: {
  lines: React.ReactNode;
  emptyHint: string;
  ariaLabel: string;
  maxHeightClass?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const isEmpty = lines === null || (Array.isArray(lines) && lines.length === 0);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label={ariaLabel}
      aria-live="polite"
      className={cn(
        "mt-3 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/90 p-3 font-mono text-[11px] leading-relaxed",
        SCROLLBAR_CLASSES,
        maxHeightClass,
      )}
    >
      {isEmpty ? <p className="text-slate-600">{emptyHint}</p> : lines}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sketch Lab persistence helpers
// ─────────────────────────────────────────────────────────────────────────────

interface MySketch {
  id: string;
  name: string;
  source: string;
  savedAt: number;
}

const MY_SKETCHES_KEY = "atx_arduino_sketches_v1";

function loadMySketches(): MySketch[] {
  try {
    const raw = localStorage.getItem(MY_SKETCHES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is MySketch => {
        return (
          typeof s === "object" &&
          s !== null &&
          typeof (s as MySketch).name === "string" &&
          typeof (s as MySketch).source === "string"
        );
      })
      .slice(0, 20);
  } catch {
    return [];
  }
}

function persistMySketches(list: MySketch[]): void {
  try {
    localStorage.setItem(MY_SKETCHES_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked — session-only life */
  }
}

/** arduino-cli requires folder name == sketch name and valid C identifiers. */
function sanitizeSketchName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (!cleaned) return "atx_sketch";
  return /^[0-9]/.test(cleaned) ? `atx_${cleaned}` : cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const MONITOR_MAX_LINES = 500;
const MONITOR_BAUDS = [9600, 57600, 115200] as const;
type HexSource = "file" | "builtin" | "compiled";

interface BoardIdentity {
  chip: string;
  boards: string | null;
  sigHex: string;
  baud: number;
  bootloader: string | null;
}

interface HexLoad {
  name: string;
  image: Uint8Array;
  dataBytes: number;
  spanBytes: number;
  source: HexSource;
}

export default function ArduinoPage() {
  const { toast } = useToast();

  // ── serial / connection state ────────────────────────────────────────────
  const [serialSupported] = useState<boolean>(() => isSerialSupported());
  const [hasPort, setHasPort] = useState(false);
  const [usbInfo, setUsbInfo] = useState<SerialPortInfo | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardIdentity | null>(null);
  const [busy, setBusy] = useState<null | "connecting" | "identifying">(null);

  const portRef = useRef<SerialPort | null>(null);
  const monitorRef = useRef<SerialMonitor | null>(null);

  // ── quick reconnect + transport-agnostic bridge state ─────────────────
  const [quickPorts, setQuickPorts] = useState<SerialPort[]>([]);
  const [showTrouble, setShowTrouble] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [bridgeMode, setBridgeMode] = useState(false); // transport = relay, not Web Serial
  const [bridgePorts, setBridgePorts] = useState<BridgePortInfo[] | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState<null | "listing" | "opening">(null);
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);
  const bridgeRef = useRef<BridgeSerialClient | null>(null);
  const bridgePathRef = useRef<string | null>(null);

  // ── monitor + ingestion state ────────────────────────────────────────────
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [monitorBaud, setMonitorBaud] = useState<number>(9600);
  const [monitorLines, setMonitorLines] = useState<MonitorLine[]>([]);
  const [ingestOn, setIngestOn] = useState(false);
  const [gateId, setGateId] = useState<string>("");
  const [ingestStats, setIngestStats] = useState<{
    lastPosted: number | null;
    lastSkipped: number | null;
    lastError: string | null;
    totalPosted: number;
    batches: number;
  }>({ lastPosted: null, lastSkipped: null, lastError: null, totalPosted: 0, batches: 0 });

  const ingestQueueRef = useRef<GateSensorEvent[]>([]);
  const clockOffsetRef = useRef<number | null>(null);
  const logSeqRef = useRef(0);
  const monitorSeqRef = useRef(0);
  const terminalSeqRef = useRef(1_000_000);

  // ── sketch lab state ─────────────────────────────────────────────────────
  const [sketchId, setSketchId] = useState<string>(SKETCHES[0]?.id ?? "");
  const [source, setSource] = useState<string>(() => SKETCHES[0]?.source ?? "");
  const [sketchName, setSketchName] = useState<string>(() => sanitizeSketchName(SKETCHES[0]?.name ?? "atx_sketch"));
  const [dirty, setDirty] = useState(false);
  const [mySketches, setMySketches] = useState<MySketch[]>(() => loadMySketches());
  const [fqbn, setFqbn] = useState<string>(DEFAULT_FQBN);
  const [compileMode, setCompileMode] = useState<CompilerMode>("server");
  const [probes, setProbes] = useState<CompilerProbe[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [compileMsg, setCompileMsg] = useState<{ tone: "ok" | "error" | "info"; text: string; log?: string } | null>(null);
  const [bridgeUrlDraft, setBridgeUrlDraft] = useState<string>(() => loadBridgeUrl());

  // ── plotter state ────────────────────────────────────────────────────────
  const [plot, setPlot] = useState<PlotState>({ names: [], data: {} });

  // ── flasher state ────────────────────────────────────────────────────────
  const [hexMeta, setHexMeta] = useState<HexLoad | null>(null);
  const [hexError, setHexError] = useState<string | null>(null);
  const [builtinState, setBuiltinState] = useState<"checking" | "available" | "missing">("checking");
  const builtinHexTextRef = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [flashProgress, setFlashProgress] = useState<{ written: number; total: number } | null>(null);
  const [flashResult, setFlashResult] = useState<{ pages: number; bytes: number; seconds: number } | null>(null);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityLine[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedSketch = useMemo(() => SKETCHES.find((s) => s.id === sketchId) ?? SKETCHES[0], [sketchId]);

  // ── gates registry (for ingestion target) ────────────────────────────────
  const gatesQuery = useQuery({
    queryKey: ["arduino-studio-gates"],
    queryFn: fetchGates,
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (!gateId && gatesQuery.data && gatesQuery.data.length > 0) {
      setGateId(gatesQuery.data[0]!.gateId);
    }
  }, [gatesQuery.data, gateId]);

  // ── activity log ─────────────────────────────────────────────────────────
  const pushLog = useCallback((text: string, level?: ActivityLevel) => {
    setActivity((prev) => {
      const next = prev.length >= 400 ? prev.slice(prev.length - 399) : prev.slice();
      next.push({ id: logSeqRef.current++, at: new Date(), text, level: level ?? levelFor(text) });
      return next;
    });
  }, []);

  // ── quick reconnect: ports already granted to this origin ────────────
  const refreshQuickPorts = useCallback(async (): Promise<void> => {
    setQuickPorts(await listAuthorizedPorts());
  }, []);

  useEffect(() => {
    void refreshQuickPorts();
  }, [refreshQuickPorts]);

  // ── compiler probe on mount ──────────────────────────────────────────────
  const runProbe = useCallback(async (): Promise<void> => {
    setProbing(true);
    try {
      const list = await probeCompilers();
      setProbes(list);
      const working = list.find((p) => p.available);
      if (working) {
        setCompileMode(working.mode);
        pushLog(`compiler found: ${working.mode} (arduino-cli ${working.version ?? ""})`, "ok");
      } else {
        pushLog("no compiler reachable — compile needs arduino-cli on the server or a local bridge", "warn");
      }
    } finally {
      setProbing(false);
    }
  }, [pushLog]);

  useEffect(() => {
    void runProbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── auto-detect: browsers fire connect/disconnect after a prior grant ────
  useEffect(() => {
    const serialApi = navigator.serial;
    if (!serialApi) return;
    const onConnect = (event: Event) => {
      const port = (event as SerialConnectionEvent).port;
      const info = port.getInfo();
      void refreshQuickPorts();
      toast({
        title: "Arduino plugged in",
        description: `${describeUsbDevice(info)} detected — hit Connect, or tap its Quick reconnect chip.`,
      });
    };
    const onDisconnect = (event: Event) => {
      const port = (event as SerialConnectionEvent).port;
      if (port === portRef.current) {
        setHasPort(false);
        setBoard(null);
        setUsbInfo(null);
        setDeviceLabel(null);
        void monitorRef.current?.stop();
        setMonitorRunning(false);
        toast({
          title: "Arduino unplugged",
          description: "The serial port vanished — reconnect the board and identify again.",
          variant: "destructive",
        });
      }
    };
    serialApi.addEventListener("connect", onConnect);
    serialApi.addEventListener("disconnect", onDisconnect);
    return () => {
      serialApi.removeEventListener("connect", onConnect);
      serialApi.removeEventListener("disconnect", onDisconnect);
    };
  }, [refreshQuickPorts, toast]);

  // ── built-in hex probe: /firmware/gate-geofence.hex (may 404) ────────────
  useEffect(() => {
    let alive = true;
    const base = (import.meta.env as Record<string, string | undefined>).BASE_URL ?? "/";
    fetch(`${base}firmware/gate-geofence.hex`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (!alive) return;
        const verdict = validateIntelHexForUno(text);
        if (verdict.ok) {
          builtinHexTextRef.current = text;
          setBuiltinState("available");
        } else {
          setBuiltinState("missing");
        }
      })
      .catch(() => {
        if (alive) setBuiltinState("missing");
      });
    return () => {
      alive = false;
    };
  }, []);

  // ── hex loading ──────────────────────────────────────────────────────────
  const loadHex = useCallback((text: string, sourceKind: HexSource, name: string) => {
    const verdict = validateIntelHexForUno(text);
    if (verdict.ok) {
      setHexMeta({
        name,
        image: verdict.summary.image,
        dataBytes: verdict.summary.dataBytes,
        spanBytes: verdict.summary.maxAddress + 1,
        source: sourceKind,
      });
      setHexError(null);
    } else {
      setHexMeta(null);
      setHexError(verdict.error);
      if (sourceKind === "builtin") setBuiltinState("missing");
    }
  }, []);

  const readHexFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".hex")) {
        toast({
          title: "Not a .hex file",
          description: "Flash images are Intel HEX (.hex) files produced by arduino-cli.",
          variant: "destructive",
        });
        return;
      }
      const text = await file.text();
      loadHex(text, "file", file.name);
    },
    [loadHex, toast],
  );

  // ── monitor ──────────────────────────────────────────────────────────────
  const handleMonitorLine = useCallback((line: MonitorLine) => {
    setMonitorLines((prev) => {
      const next = prev.length >= MONITOR_MAX_LINES ? prev.slice(prev.length - (MONITOR_MAX_LINES - 1)) : prev.slice();
      next.push(line);
      return next;
    });

    const parsed = parseMonitorLine(line.text);

    // ATX1 event lines → ingestion queue (batched, flushed every ~2 s).
    if (parsed.event) {
      // Device ts is millis() uptime; anchor it to arrival wall-clock so the
      // server's 6h-back / 5min-forward window always accepts the batch,
      // while preserving the exact inter-event spacing.
      const offset = Date.now() - parsed.event.deviceMillis;
      clockOffsetRef.current = offset;
      const epoch = new Date(parsed.event.deviceMillis + offset);
      const queue = ingestQueueRef.current;
      queue.push({ sensor: parsed.event.sensor, ts: epoch.toISOString() });
      if (queue.length > MONITOR_MAX_LINES) queue.splice(0, queue.length - MONITOR_MAX_LINES);
    }

    // Any numeric fields → the strip chart.
    const values = extractPlotValues(line.text, parsed.payload);
    if (Object.keys(values).length > 0) {
      setPlot((prev) => mergePlot(prev, values));
    }
  }, []);

  const startMonitor = useCallback(async (): Promise<void> => {
    if (bridgeMode) {
      const client = bridgeRef.current;
      const path = bridgePathRef.current;
      if (!client || !path) return;
      try {
        setMonitorLines([]);
        // The bridge client emits MonitorLine already (same LineBuffer +
        // parseMonitorLine pipeline as SerialMonitor) — feed it straight in.
        await client.open(path, monitorBaud, handleMonitorLine);
        setMonitorRunning(true);
        pushLog(`bridge stream re-attached at ${monitorBaud} baud`);
      } catch (error) {
        toast({
          title: "Bridge stream failed",
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      }
      return;
    }
    const port = portRef.current;
    if (!port) return;
    if (!monitorRef.current) monitorRef.current = new SerialMonitor();
    const monitor = monitorRef.current;
    if (monitor.running) await monitor.stop();
    try {
      setMonitorLines([]);
      await monitor.start(port, monitorBaud, handleMonitorLine, (error) => {
        setMonitorRunning(false);
        toast({
          title: "Monitor stopped",
          description: error.message || "The serial stream ended unexpectedly.",
          variant: "destructive",
        });
      });
      setMonitorRunning(true);
      pushLog(`serial monitor open at ${monitorBaud} baud`);
    } catch (error) {
      toast({
        title: "Monitor failed to start",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  }, [bridgeMode, handleMonitorLine, monitorBaud, pushLog, toast]);

  const stopMonitor = useCallback(async (): Promise<void> => {
    if (bridgeMode) {
      await bridgeRef.current?.closeStream();
      setMonitorRunning(false);
      pushLog("bridge stream stopped (port still open on the bridge machine)");
      return;
    }
    await monitorRef.current?.stop();
    setMonitorRunning(false);
    pushLog("serial monitor closed");
  }, [bridgeMode, pushLog]);

  const changeMonitorBaud = useCallback(
    async (baud: number) => {
      setMonitorBaud(baud);
      if (bridgeMode && bridgeRef.current?.running && bridgePathRef.current) {
        // The relay baud lives on the bridge machine — reconfigure it live.
        try {
          setMonitorLines([]);
          await bridgeRef.current.open(bridgePathRef.current, baud, handleMonitorLine);
          pushLog(`bridge port reconfigured to ${baud} baud`);
        } catch (error) {
          setMonitorRunning(false);
          toast({
            title: "Bridge re-open failed",
            description: error instanceof Error ? error.message : String(error),
            variant: "destructive",
          });
        }
        return;
      }
      if (monitorRef.current?.running && portRef.current) {
        await monitorRef.current.stop();
        setMonitorRunning(false);
        // restart at the new baud
        const port = portRef.current;
        const monitor = monitorRef.current;
        try {
          setMonitorLines([]);
          await monitor.start(port, baud, handleMonitorLine, (error) => {
            setMonitorRunning(false);
            toast({
              title: "Monitor stopped",
              description: error.message || "The serial stream ended unexpectedly.",
              variant: "destructive",
            });
          });
          setMonitorRunning(true);
          pushLog(`serial monitor re-opened at ${baud} baud`);
        } catch (error) {
          toast({
            title: "Monitor failed to restart",
            description: error instanceof Error ? error.message : String(error),
            variant: "destructive",
          });
        }
      }
    },
    [bridgeMode, handleMonitorLine, pushLog, toast],
  );

  // ── control terminal send ────────────────────────────────────────────────
  const handleTerminalSend = useCallback(
    (line: string): void => {
      if (bridgeMode) {
        const client = bridgeRef.current;
        if (!client?.running) {
          toast({
            title: "Bridge transport is down",
            description: "Re-open the bridge port in panel 01, or press Start monitor to re-attach the stream.",
            variant: "destructive",
          });
          return;
        }
        const echo: MonitorLine = {
          id: terminalSeqRef.current++,
          at: new Date(),
          text: `> ${line}`,
          kind: "sent",
        };
        setMonitorLines((prev) => {
          const next = prev.length >= MONITOR_MAX_LINES ? prev.slice(prev.length - (MONITOR_MAX_LINES - 1)) : prev.slice();
          next.push(echo);
          return next;
        });
        void client
          .writeText(line)
          .then(() => pushLog(`sent via bridge: ${line}`))
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            pushLog(`send failed: ${message}`, "error");
            toast({ title: "Send failed", description: message, variant: "destructive" });
          });
        return;
      }
      const monitor = monitorRef.current;
      if (!monitor?.running) {
        toast({
          title: "Monitor is not running",
          description: "Start the monitor in panel 05 — the terminal writes to the same open port.",
          variant: "destructive",
        });
        return;
      }
      const echo: MonitorLine = {
        id: terminalSeqRef.current++,
        at: new Date(),
        text: `> ${line}`,
        kind: "sent",
      };
      setMonitorLines((prev) => {
        const next = prev.length >= MONITOR_MAX_LINES ? prev.slice(prev.length - (MONITOR_MAX_LINES - 1)) : prev.slice();
        next.push(echo);
        return next;
      });
      void monitor
        .writeLine(line)
        .then(() => pushLog(`sent: ${line}`))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          pushLog(`send failed: ${message}`, "error");
          toast({ title: "Send failed", description: message, variant: "destructive" });
        });
    },
    [bridgeMode, pushLog, toast],
  );

  // ── ingestion flush (batch every ~2 s; final flush on toggle-off) ────────
  const flushIngest = useCallback(
    async (final: boolean): Promise<void> => {
      const queue = ingestQueueRef.current;
      if (queue.length === 0) return;
      if (!gateId) {
        setIngestStats((s) => ({ ...s, lastError: "no gate selected — events buffered locally" }));
        return;
      }
      const batch = queue.splice(0, Math.min(queue.length, 500));
      try {
        const result = await postGateSensorEvents(gateId, batch);
        setIngestStats((s) => ({
          lastPosted: result.accepted,
          lastSkipped: result.skipped,
          lastError: result.skipped > 0 ? `${result.skipped} event(s) skipped — timestamps outside the 6 h window` : null,
          totalPosted: s.totalPosted + result.accepted,
          batches: s.batches + 1,
        }));
        pushLog(
          `ingest: ${result.accepted} event(s) → gate "${gateId}"${result.skipped ? `, ${result.skipped} skipped` : ""}`,
          "ok",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setIngestStats((s) => ({ ...s, lastError: message }));
        pushLog(`ingest failed: ${message}`, "error");
        if (!final && batch.length > 0) {
          // requeue the tail so bursts survive a transient auth/network hiccup
          ingestQueueRef.current = [...batch.slice(-200), ...ingestQueueRef.current];
        }
      }
    },
    [gateId, pushLog],
  );

  useEffect(() => {
    if (!ingestOn) return;
    const timer = setInterval(() => void flushIngest(false), 2000);
    return () => clearInterval(timer);
  }, [ingestOn, flushIngest]);

  const handleIngestToggle = useCallback(
    (on: boolean) => {
      setIngestOn(on);
      if (on) {
        pushLog("ingest armed — ATX1 sensor events will POST to /api/gate/sensor-events");
        if (!gateId) {
          toast({
            title: "Pick a gate first",
            description: "Select the gate these sensor events belong to before arming ingestion.",
          });
        }
      } else {
        void flushIngest(true);
        pushLog("ingest disarmed — queue flushed");
      }
    },
    [flushIngest, gateId, pushLog],
  );

  // ── connection ───────────────────────────────────────────────────────────
  const runIdentify = useCallback(async (): Promise<void> => {
    const port = portRef.current;
    if (!port) return;
    setBusy("identifying");
    setBoard(null);
    pushLog("identify: probing bootloaders at 115200 → 57600 → 9600 baud");
    try {
      const result = await stk500Identify({ port, log: pushLog });
      if (result.signature && result.baud !== null) {
        setBoard({
          chip: result.chipName ?? "unknown chip",
          boards: result.boards,
          sigHex: result.signatureHex ?? "",
          baud: result.baud,
          bootloader: result.bootloaderVersion,
        });
        setHasPort(true);
        setFqbn(fqbnForChip(result.chipName));
        toast({
          title: `Identified: ${result.chipName ?? "unknown chip"}`,
          description: `${describeUsbDevice(port.getInfo())} — synced at ${result.baud} baud.`,
        });
        // Auto-open the monitor so sketch output appears right away.
        void startMonitor();
      } else {
        toast({
          title: "No bootloader response",
          description:
            "Tried 115200 / 57600 / 9600. The monitor is open anyway — sketch chatter may still flow. Press RESET on the board and identify again to enable flashing.",
          variant: "destructive",
        });
        // The port is fine even when the bootloader is silent (sketch at a
        // different baud, no bootloader boot). Open the monitor so the user
        // still sees output instead of a dead panel.
        void startMonitor();
      }
    } finally {
      setBusy(null);
    }
  }, [pushLog, startMonitor, toast]);

  const handleConnect = useCallback(
    async (): Promise<void> => {
      if (!serialSupported || busy || flashing) return;
      setBusy("connecting");
      try {
        if (bridgeMode) {
          // Switching transports — tear the relay down first.
          await bridgeRef.current?.closePort();
          bridgeRef.current = null;
          bridgePathRef.current = null;
          setBridgeMode(false);
          setBridgePorts(null);
          setMonitorRunning(false);
        }
        if (monitorRef.current?.running) await stopMonitor();
        const port = await requestSerialPort();
        portRef.current = port;
        const info = port.getInfo();
        setUsbInfo({ usbVendorId: info.usbVendorId, usbProductId: info.usbProductId });
        setDeviceLabel(describeUsbDevice(info));
        setHasPort(true);
        setFlashResult(null);
        void refreshQuickPorts();
        await runIdentify();
      } catch (error) {
        const cancelled = error instanceof DOMException && error.name === "NotFoundError";
        if (cancelled) setShowTrouble(true);
        toast({
          title: cancelled ? "Nothing picked — or nothing listed" : "Connection failed",
          description: cancelled
            ? "The picker was dismissed or showed no devices. Work the checklist below — charge-only USB cables and another program holding the port are the usual culprits."
            : error instanceof Error
              ? error.message
              : String(error),
          variant: cancelled ? undefined : "destructive",
        });
      } finally {
        setBusy(null);
      }
    },
    [bridgeMode, busy, flashing, refreshQuickPorts, runIdentify, serialSupported, stopMonitor, toast],
  );

  const handleReconnectPort = useCallback(
    async (port: SerialPort): Promise<void> => {
      if (busy || flashing) return;
      try {
        if (bridgeMode) {
          await bridgeRef.current?.closePort();
          bridgeRef.current = null;
          bridgePathRef.current = null;
          setBridgeMode(false);
          setBridgePorts(null);
          setMonitorRunning(false);
        }
        if (monitorRef.current?.running) await stopMonitor();
        portRef.current = port;
        const info = port.getInfo();
        setUsbInfo({ usbVendorId: info.usbVendorId, usbProductId: info.usbProductId });
        setDeviceLabel(describeUsbDevice(info));
        setHasPort(true);
        setFlashResult(null);
        pushLog(`reconnected to ${describeUsbDevice(info)} — already authorized, no picker needed`, "ok");
        await runIdentify();
      } catch (error) {
        toast({
          title: "Reconnect failed",
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      }
    },
    [busy, flashing, bridgeMode, pushLog, runIdentify, stopMonitor, toast],
  );

  const handleDisconnect = useCallback(async (): Promise<void> => {
    if (bridgeMode) {
      await bridgeRef.current?.closePort();
      bridgeRef.current = null;
      bridgePathRef.current = null;
      setBridgeMode(false);
      setBridgePorts(null);
      setMonitorRunning(false);
      setIngestOn(false);
      await flushIngest(true);
      setHasPort(false);
      setBoard(null);
      setUsbInfo(null);
      setDeviceLabel(null);
      pushLog("bridge port released");
      return;
    }
    await monitorRef.current?.stop();
    setMonitorRunning(false);
    setIngestOn(false);
    await flushIngest(true);
    const port = portRef.current;
    portRef.current = null;
    if (port) await closePortQuietly(port);
    setHasPort(false);
    setBoard(null);
    setUsbInfo(null);
    setDeviceLabel(null);
    pushLog("port released");
  }, [bridgeMode, flushIngest, pushLog]);

  // ── remote serial bridge (hardware/arduino-bridge.mjs relay) ──────
  const handleBridgeList = useCallback(async (): Promise<void> => {
    const client = bridgeRef.current ?? new BridgeSerialClient(bridgeUrlDraft);
    bridgeRef.current = client;
    setBridgeBusy("listing");
    try {
      const ports = await client.listPorts();
      setBridgePorts(ports);
      setBridgeNote(ports.length === 0 ? "No serial ports visible on the bridge machine — is the board plugged in there?" : null);
      pushLog(
        `bridge ${client.url}: ${ports.length} serial port${ports.length === 1 ? "" : "s"} found`,
        ports.length > 0 ? "ok" : "warn",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBridgePorts(null);
      setBridgeNote(message);
      pushLog(`bridge list failed: ${message}`, "error");
    } finally {
      setBridgeBusy(null);
    }
  }, [bridgeUrlDraft, pushLog]);

  const handleBridgeOpen = useCallback(
    async (port: BridgePortInfo): Promise<void> => {
      const client = bridgeRef.current;
      if (!client) return;
      setBridgeBusy("opening");
      try {
        if (monitorRef.current?.running) await stopMonitor();
        await client.open(port.path, monitorBaud, handleMonitorLine);
        bridgePathRef.current = port.path;
        setBridgeMode(true);
        setHasPort(true);
        setBoard(null);
        setUsbInfo(null);
        setDeviceLabel(`bridge · ${port.path} @ ${monitorBaud}`);
        setMonitorLines([]);
        setMonitorRunning(true);
        setFlashResult(null);
        pushLog(
          `bridge serial open: ${port.path} @ ${monitorBaud} — monitor, terminal and ingestion now stream through the relay`,
          "ok",
        );
        toast({
          title: "Bridge serial open",
          description: `${port.path} at ${monitorBaud} baud — relayed from ${client.url}. Any browser on the network can do this.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setBridgeNote(message);
        pushLog(`bridge open failed: ${message}`, "error");
        toast({ title: "Bridge open failed", description: message, variant: "destructive" });
      } finally {
        setBridgeBusy(null);
      }
    },
    [handleMonitorLine, monitorBaud, pushLog, stopMonitor, toast],
  );

  // ── flashing ─────────────────────────────────────────────────────────────
  const handleFlash = useCallback(async (): Promise<void> => {
    const port = portRef.current;
    const image = hexMeta;
    if (!port || !image || !board || flashing) return;
    if (monitorRef.current?.running) await stopMonitor();
    setFlashing(true);
    setFlashResult(null);
    setFlashError(null);
    setFlashProgress({ written: 0, total: 0 });
    pushLog(`flash: ${image.name} (${image.dataBytes} program bytes) at ${board.baud} baud`);
    try {
      const result = await stk500Flash({
        port,
        baud: board.baud,
        image: image.image,
        log: pushLog,
        onProgress: (written, total) => setFlashProgress({ written, total }),
      });
      setFlashResult({
        pages: result.pagesWritten,
        bytes: result.bytesWritten,
        seconds: Math.round(result.durationMs / 100) / 10,
      });
      toast({
        title: "Firmware flashed",
        description: `${result.pagesWritten} pages written — re-run identify to confirm the board boots the new sketch.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFlashError(message);
      toast({ title: "Flash failed", description: message, variant: "destructive" });
    } finally {
      setFlashing(false);
    }
  }, [board, flashing, hexMeta, pushLog, stopMonitor, toast]);

  // ── sketch lab actions ───────────────────────────────────────────────────
  const loadTemplate = useCallback(
    (id: string) => {
      const s = SKETCHES.find((x) => x.id === id);
      if (!s) return;
      setSketchId(id);
      setSource(s.source);
      setSketchName(sanitizeSketchName(s.name));
      setDirty(false);
      toast({
        title: `Loaded "${s.name}"`,
        description: dirty ? "Unsaved edits were replaced by the template." : "Edit freely — Ctrl/Cmd+Enter compiles.",
      });
    },
    [dirty, toast],
  );

  const loadMySketch = useCallback(
    (name: string) => {
      const m = mySketches.find((x) => x.name === name);
      if (!m) return;
      setSketchId("__my__");
      setSource(m.source);
      setSketchName(sanitizeSketchName(m.name));
      setDirty(false);
      toast({ title: `Loaded "${m.name}"`, description: "Saved copy restored from this browser." });
    },
    [mySketches, toast],
  );

  const saveMySketch = useCallback(() => {
    const name = sanitizeSketchName(sketchName);
    setSketchName(name);
    const entry: MySketch = {
      id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
      name,
      source,
      savedAt: Date.now(),
    };
    const next = [...mySketches.filter((m) => m.name !== name), entry];
    setMySketches(next);
    persistMySketches(next);
    setDirty(false);
    toast({
      title: "Sketch saved",
      description: `"${name}" is stored in this browser and reloads from My sketches.`,
    });
    pushLog(`sketch saved: ${name} (${source.length} chars)`, "ok");
  }, [mySketches, pushLog, sketchName, source, toast]);

  const deleteMySketch = useCallback(
    (name: string) => {
      const next = mySketches.filter((m) => m.name !== name);
      setMySketches(next);
      persistMySketches(next);
      toast({ title: `Deleted "${name}"`, description: "Removed from this browser's sketch store." });
    },
    [mySketches, toast],
  );

  const copySketch = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({
        title: "Clipboard unavailable",
        description: "Download the .ino instead — the editor text can be selected manually.",
        variant: "destructive",
      });
    }
  }, [source, toast]);

  const downloadSketch = useCallback(() => {
    const blob = new Blob([source], { type: "text/x-arduino" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sanitizeSketchName(sketchName)}.ino`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [sketchName, source]);

  // ── compile ──────────────────────────────────────────────────────────────
  const runCompile = useCallback(async (): Promise<void> => {
    if (compiling) return;
    if (!source.trim()) {
      toast({ title: "Nothing to compile", description: "The editor is empty — load a template or write a sketch." });
      return;
    }
    setCompiling(true);
    setCompileMsg(null);
    pushLog(`compile: "${sketchName}" → ${fqbn} via the ${compileMode} arduino-cli`);
    try {
      const result = await compileSketch({ source, name: sketchName, fqbn, mode: compileMode });
      loadHex(result.hexText, "compiled", `${sketchName}.ino.hex (${result.via})`);
      const seconds = (result.elapsedMs / 1000).toFixed(1);
      setCompileMsg({
        tone: "ok",
        text: `Compiled in ${seconds}s via the ${result.via} compiler — hex loaded into the flasher, ready to burn.`,
        log: result.logTail || undefined,
      });
      pushLog(`compile ok via ${result.via}: ${sketchName}.ino.hex in ${seconds}s`, "ok");
    } catch (error) {
      if (error instanceof CompileUnavailableError) {
        setCompileMsg({
          tone: "error",
          text: `No ${error.probe.mode} compiler reachable: ${error.message}`,
          log: error.probe.detail,
        });
        pushLog(`compile unavailable: ${error.message}`, "warn");
      } else if (error instanceof CompileFailedError) {
        setCompileMsg({ tone: "error", text: "Compilation failed — fix the errors below and compile again.", log: error.log || undefined });
        pushLog("compile failed — compiler errors reported in panel 02", "error");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        setCompileMsg({ tone: "error", text: message });
        pushLog(`compile failed: ${message}`, "error");
      }
    } finally {
      setCompiling(false);
    }
  }, [compileMode, compiling, fqbn, loadHex, pushLog, sketchName, source, toast]);

  const applyBridgeUrl = useCallback(() => {
    saveBridgeUrl(bridgeUrlDraft);
    toast({ title: "Bridge URL saved", description: "Re-probing compilers…" });
    void runProbe();
  }, [bridgeUrlDraft, runProbe, toast]);

  // ── derived UI state ─────────────────────────────────────────────────────
  const ledTone: "idle" | "port" | "busy" | "on" | "flash" = flashing
    ? "flash"
    : busy
      ? "busy"
      : board
        ? "on"
        : hasPort
          ? "port"
          : "idle";

  const connStateLabel = flashing
    ? "FLASHING"
    : busy
      ? busy === "connecting"
        ? "CONNECTING"
        : "IDENTIFYING"
      : board
        ? "CONNECTED"
        : hasPort
          ? "PORT READY"
          : "NO PORT";

  const flashDisabledReason = bridgeMode
    ? "Flashing needs the real USB port — the bridge relay can't run STK500v1. Reconnect over direct Web Serial (panel 01)."
    : !serialSupported
      ? "Web Serial is unavailable — flash from Chrome/Edge on desktop, or via a machine that has it."
      : !board
        ? "Identify the board first (panel 01) so the flasher knows the sync baud."
        : !hexMeta
          ? "Load a .hex image below (compile it in panel 02, drop a file, or use the built-in image)."
          : null;

  const monitorDisabledReason =
    !serialSupported && !bridgeMode
      ? "Web Serial is unavailable here — connect through the Remote Serial Bridge in panel 01 instead."
      : !hasPort
        ? "Connect a transport first (panel 01) — the monitor rides whichever one is live."
        : flashing
          ? "The flasher owns the USB port while flashing."
          : null;

  const terminalDisabledReason =
    monitorDisabledReason ??
    (!monitorRunning ? "Start the monitor above — the terminal writes to the same open port." : null);

  const flashPct =
    flashProgress && flashProgress.total > 0
      ? Math.min(100, Math.round((flashProgress.written / flashProgress.total) * 100))
      : 0;

  const monitorEventCount = monitorLines.filter((l) => l.kind === "event").length;

  const probeFor = (mode: CompilerMode): CompilerProbe | undefined => probes?.find((p) => p.mode === mode);

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 mx-auto max-w-7xl space-y-6 pb-8">
        {/* ── page header ──────────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="gx-page-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <SectionTitle
            className="gx-title-gradient"
            sub="WEB SERIAL IDE · UNIVERSAL PICKER · REMOTE BRIDGE RELAY · STK500V1 FLASHER · SENSOR PIPELINE"
          >
            ARDUINO GATE CONTROLLER LAB
          </SectionTitle>
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-2 rounded-lg border border-foreground/10 bg-card/70 px-3 py-2"
              aria-label={`Connection status: ${connStateLabel}`}
            >
              <LedDot tone={ledTone} />
              <span className="font-mono text-[11px] tracking-widest text-foreground/70">{connStateLabel}</span>
              {board && (
                <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] text-emerald-300">
                  {board.chip}
                </Badge>
              )}
            </div>
            <ThemeToggle compact />
          </div>
        </motion.div>

        {!serialSupported && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-200"
          >
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-semibold">Web Serial is not available here — you can still drive the board</p>
              <p className="mt-1 text-amber-200/80">
                Direct USB needs Chrome/Edge on desktop over HTTPS. For every other browser (and for remote boards),
                expand <span className="font-semibold">Remote Serial Bridge</span> in panel 01 and run{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-amber-300">
                  node hardware/arduino-bridge.mjs
                </code>{" "}
                on the machine holding the board — monitor, terminal and ingestion stream through it just the same.
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* ────────────────────────────────────────────────────────────
              PANEL 01 — CONNECTION
          ──────────────────────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.05 }}
            className="lg:col-span-5 xl:col-span-4"
          >
            <GlowCard hover={false} className="flex h-full flex-col gap-4 p-5">
              <PanelHead
                step="01"
                icon={Cable}
                title="CONNECTION"
                sub="universal picker · quick reconnect · bridge relay · STK500 chip verify"
                right={<LedDot tone={ledTone} />}
              />

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Hint
                  wrapperClassName="flex-1"
                  label={
                    serialSupported
                      ? "Opens the USB picker showing EVERY serial port — no vendor filter, so CP210x / FTDI / PL2303 / ESP32 / Pico boards all appear"
                      : "Direct USB needs Chrome/Edge on desktop — use the Remote Serial Bridge below instead"
                  }
                >
                  <Button
                    size="lg"
                    className="h-12 min-h-11 w-full bg-emerald-500 font-semibold text-slate-950 hover:bg-emerald-400"
                    disabled={!serialSupported || busy !== null || flashing}
                    onClick={() => void handleConnect()}
                    aria-label="Connect Arduino over USB"
                  >
                    {busy === "connecting" ? (
                      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Usb className="h-5 w-5" aria-hidden="true" />
                    )}
                    Connect Arduino
                  </Button>
                </Hint>
                <div className="flex gap-2">
                  <Hint
                    label={
                      bridgeMode
                        ? "Identify needs direct USB — the bridge relay can't run STK500"
                        : hasPort
                          ? "Re-probe 115200/57600/9600 and read the ATmega signature"
                          : "Grant a port first — identify verifies the actual chip via STK500 READ_SIGN"
                    }
                  >
                    <Button
                      variant="outline"
                      className="min-h-11 border-border"
                      disabled={!serialSupported || !hasPort || bridgeMode || busy !== null || flashing}
                      onClick={() => void runIdentify()}
                      aria-label="Identify board and read chip signature"
                    >
                      {busy === "identifying" ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <ScanSearch className="h-4 w-4" aria-hidden="true" />
                      )}
                      Identify
                    </Button>
                  </Hint>
                  <Hint
                    label={hasPort || bridgeMode ? "Release the transport (stops monitor + ingestion)" : "Nothing to release yet"}
                  >
                    <Button
                      variant="outline"
                      size="icon"
                      className="min-h-11 w-11 border-red-500/30 text-red-300 hover:bg-red-500/10"
                      disabled={!hasPort || busy !== null || flashing}
                      onClick={() => void handleDisconnect()}
                      aria-label="Disconnect and release the serial transport"
                    >
                      <Unplug className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </Hint>
                </div>
              </div>

              {quickPorts.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[11px] uppercase tracking-wider text-foreground/35">
                    Quick reconnect — already authorized, no picker
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {quickPorts.map((p, i) => (
                      <Hint key={i} label="One-click reconnect to a port you granted before">
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-11 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                          disabled={busy !== null || flashing}
                          onClick={() => void handleReconnectPort(p)}
                          aria-label={`Reconnect to ${describeUsbDevice(p.getInfo())}`}
                        >
                          <History className="h-3.5 w-3.5" aria-hidden="true" />
                          {describeUsbDevice(p.getInfo())}
                        </Button>
                      </Hint>
                    ))}
                  </div>
                </div>
              )}

              <Collapsible
                open={showTrouble}
                onOpenChange={setShowTrouble}
                className="rounded-lg border border-amber-500/25 bg-amber-500/5"
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
                    aria-expanded={showTrouble}
                  >
                    <span className="flex items-center gap-2 text-xs font-semibold text-amber-200">
                      <Wrench className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
                      No compatible device found? Work the checklist
                    </span>
                    <ChevronDown
                      className={cn("h-4 w-4 text-amber-200/60 transition-transform", showTrouble && "rotate-180")}
                      aria-hidden="true"
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="space-y-2 px-3 pb-3 text-[11px] leading-relaxed text-foreground/55">
                    <li>
                      <span className="font-semibold text-amber-200">Charge-only USB cable.</span> The #1 cause — a
                      power-only cable enumerates nothing. Swap for a data cable.
                    </li>
                    <li>
                      <span className="font-semibold text-amber-200">The picker is empty.</span> The OS itself doesn't
                      see the board: cable, board power, or the port is held exclusively by another program.
                    </li>
                    <li>
                      <span className="font-semibold text-amber-200">Close Arduino IDE / Arduino Lab.</span> Serial
                      ports are single-tenant — any open serial monitor (including theirs) blocks everyone else.
                    </li>
                    <li>
                      <span className="font-semibold text-amber-200">Browser.</span> Direct USB = Chrome/Edge on
                      desktop. Firefox/Safari/mobile: use the Remote Serial Bridge below.
                    </li>
                    <li>
                      <span className="font-semibold text-amber-200">Linux permissions.</span>{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-emerald-300">
                        sudo usermod -aG dialout $USER
                      </code>{" "}
                      (log out + in), and disable modemmanager — it loves claiming fresh serial ports.
                    </li>
                    <li>
                      <span className="font-semibold text-amber-200">Press RESET</span> on the board once, then
                      reconnect — half-open ports get stuck.
                    </li>
                    <li>
                      <span className="font-semibold text-amber-200">Clones (CP2102 / CH340).</span> Windows needs the
                      vendor driver; ChromeOS + Chrome usually works out of the box.
                    </li>
                  </ul>
                </CollapsibleContent>
              </Collapsible>

              <Collapsible
                open={bridgeOpen}
                onOpenChange={setBridgeOpen}
                className="rounded-lg border border-violet-500/25 bg-violet-500/5"
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
                    aria-expanded={bridgeOpen}
                  >
                    <span className="flex items-center gap-2 text-xs font-semibold text-violet-200">
                      <Server className="h-3.5 w-3.5 text-violet-300" aria-hidden="true" />
                      Remote Serial Bridge — any browser, any device
                      {bridgeMode && (
                        <Badge
                          variant="outline"
                          className="border-violet-500/40 bg-violet-500/10 font-mono text-[10px] text-violet-200"
                        >
                          LIVE
                        </Badge>
                      )}
                    </span>
                    <ChevronDown
                      className={cn("h-4 w-4 text-violet-300/60 transition-transform", bridgeOpen && "rotate-180")}
                      aria-hidden="true"
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="space-y-2.5 px-3 pb-3">
                    <p className="text-[11px] leading-relaxed text-foreground/50">
                      Web Serial only exists in Chrome/Edge on desktop — the relay lifts both limits. Run{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-violet-300">
                        node hardware/arduino-bridge.mjs
                      </code>{" "}
                      on the machine holding the board (Linux/macOS), then open its port from HERE — monitor, control
                      terminal and AttendX ingestion stream over SSE, even from a phone on the same network. Flashing
                      still wants direct USB.
                    </p>
                    <div className="flex gap-2">
                      <Input
                        value={bridgeUrlDraft}
                        onChange={(e) => setBridgeUrlDraft(e.target.value)}
                        aria-label="Bridge URL for the serial relay"
                        placeholder="http://127.0.0.1:8791"
                        className="h-9 min-h-11 border-border bg-muted font-mono text-[11px]"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 min-h-11 shrink-0 border-violet-500/40 text-violet-200 hover:bg-violet-500/10"
                        disabled={bridgeBusy !== null}
                        onClick={() => void handleBridgeList()}
                        aria-label="List serial ports on the bridge machine"
                      >
                        {bridgeBusy === "listing" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        List ports
                      </Button>
                    </div>
                    {bridgePorts !== null && (
                      <div className="space-y-1.5">
                        {bridgePorts.length === 0 ? (
                          <p className="text-[11px] text-amber-300/80">
                            No serial ports visible on the bridge machine — is the board plugged in there?
                          </p>
                        ) : (
                          bridgePorts.map((p) => (
                            <div
                              key={p.path}
                              className="flex items-center justify-between gap-2 rounded border border-border bg-muted/50 px-2.5 py-1.5"
                            >
                              <div className="min-w-0">
                                <p className="truncate font-mono text-[11px] text-foreground/80">{p.path}</p>
                                {p.boardName && <p className="truncate text-[10px] text-foreground/40">{p.boardName}</p>}
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                className="min-h-11 shrink-0 border-violet-500/40 text-violet-200 hover:bg-violet-500/10"
                                disabled={bridgeBusy !== null || flashing}
                                onClick={() => void handleBridgeOpen(p)}
                                aria-label={`Open ${p.path} through the bridge`}
                              >
                                {bridgeBusy === "opening" ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                ) : (
                                  <Cable className="h-3.5 w-3.5" aria-hidden="true" />
                                )}
                                Open
                              </Button>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                    {bridgeNote && (
                      <p className="text-[11px] leading-relaxed text-red-300/80" role="alert">
                        {bridgeNote}
                      </p>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>

              <dl className="rounded-lg border border-border bg-muted/50 px-3 py-2">
                <InfoRow label="Device" value={deviceLabel ?? "—"} />
                <InfoRow label="USB ids" value={usbInfo ? formatUsbIds(usbInfo) : "—"} />
                <InfoRow label="Board" value={board?.boards ?? (board ? "unknown" : "—")} />
                <InfoRow
                  label="Chip signature"
                  value={
                    board ? (
                      <span>
                        {board.sigHex} <span className="text-emerald-300">({board.chip})</span>
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
                <InfoRow
                  label="Bootloader"
                  value={board ? `${board.bootloader ?? "stk500v1"} · ${board.baud} baud` : "—"}
                />
              </dl>

              <div className="mt-auto flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-[11px] leading-relaxed text-foreground/40">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300/70" aria-hidden="true" />
                <span>
                  Permission is remembered per port: after your first Connect, the board shows up under Quick
                  reconnect (no picker) and the browser fires the{" "}
                  <span className="font-mono text-violet-300">connect</span> event the moment it's re-plugged. Boards
                  on CP210x/FTDI/PL2303/ESP32/Pico chips appear in the picker too — identify reads the actual chip
                  signature, not the USB name.
                </span>
              </div>
            </GlowCard>
          </motion.div>

          {/* ────────────────────────────────────────────────────────────
              PANEL 02 — SKETCH LAB (editor + compiler)
          ──────────────────────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.1 }}
            className="lg:col-span-7 xl:col-span-8"
          >
            <GlowCard hover={false} className="flex h-full flex-col gap-4 p-5">
              <PanelHead
                step="02"
                icon={Cpu}
                title="SKETCH LAB"
                sub="edit → compile (arduino-cli on the server or your machine) → hex lands in panel 03"
                right={
                  dirty ? (
                    <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 font-mono text-[10px] text-amber-300">
                      unsaved edits
                    </Badge>
                  ) : null
                }
              />

              {/* toolbar: template / my sketches / name / save / copy / download */}
              <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase tracking-wider text-foreground/35" htmlFor="template-select">
                    Templates
                  </label>
                  <Select value={sketchId} onValueChange={loadTemplate}>
                    <SelectTrigger id="template-select" aria-label="Load a template sketch into the editor" className="min-h-11 border-border bg-muted">
                      <SelectValue placeholder={sketchId === "__my__" ? "My sketch" : "Pick a sketch"} />
                    </SelectTrigger>
                    <SelectContent>
                      {SKETCHES.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase tracking-wider text-foreground/35" htmlFor="mysketch-select">
                    My sketches ({mySketches.length})
                  </label>
                  <div className="flex gap-2">
                    <Select
                      value={sketchId === "__my__" ? (sketchName || undefined) : undefined}
                      onValueChange={loadMySketch}
                      disabled={mySketches.length === 0}
                    >
                      <SelectTrigger id="mysketch-select" aria-label="Load one of your saved sketches" className="min-h-11 w-full border-border bg-muted">
                        <SelectValue placeholder="nothing saved yet" />
                      </SelectTrigger>
                      <SelectContent>
                        {mySketches.map((m) => (
                          <SelectItem key={m.id} value={m.name}>
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {sketchId === "__my__" && sketchName && (
                      <Hint label={`Delete "${sketchName}" from this browser`}>
                        <Button
                          variant="outline"
                          size="icon"
                          className="min-h-11 w-11 shrink-0 border-red-500/30 text-red-300 hover:bg-red-500/10"
                          onClick={() => deleteMySketch(sketchName)}
                          aria-label={`Delete sketch ${sketchName}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </Hint>
                    )}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase tracking-wider text-foreground/35" htmlFor="sketch-name">
                    Sketch name
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="sketch-name"
                      value={sketchName}
                      onChange={(e) => {
                        setSketchName(e.target.value);
                        setDirty(true);
                      }}
                      aria-label="Sketch name used when compiling and saving"
                      className="min-h-11 border-border bg-muted font-mono text-xs"
                    />
                    <Hint label="Save this source under the current name (localStorage, this browser)">
                      <Button
                        variant="outline"
                        size="icon"
                        className="min-h-11 w-11 shrink-0 border-border"
                        onClick={saveMySketch}
                        aria-label="Save sketch"
                      >
                        <Save className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </Hint>
                  </div>
                </div>
              </div>

              {/* editor */}
              <CodeEditor
                value={source}
                onChange={(next) => {
                  setSource(next);
                  setDirty(true);
                }}
                onCompile={() => void runCompile()}
                ariaLabel={`C++ source of ${sketchName}`}
                maxHeightClass="max-h-[380px]"
              />
              <p className="-mt-2 text-[10px] text-foreground/30">
                Tab indents · Ctrl/Cmd + Enter compiles · {source.split("\n").length} lines · {source.length} chars
              </p>

              {/* compiler bar */}
              <div className="grid items-end gap-2 md:grid-cols-[1fr_1fr_auto]">
                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase tracking-wider text-foreground/35" htmlFor="fqbn-select">
                    Board target
                  </label>
                  <Select value={fqbn} onValueChange={setFqbn}>
                    <SelectTrigger id="fqbn-select" aria-label="Board target for the compiler" className="min-h-11 border-border bg-muted">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FQBN_PRESETS.map((p) => (
                        <SelectItem key={p.fqbn} value={p.fqbn}>
                          {p.label} <span className="text-foreground/30">({p.fqbn})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase tracking-wider text-foreground/35" htmlFor="compiler-mode">
                    Compiler host
                  </label>
                  <Select value={compileMode} onValueChange={(v) => setCompileMode(v as CompilerMode)}>
                    <SelectTrigger id="compiler-mode" aria-label="Which arduino-cli host compiles the sketch" className="min-h-11 border-border bg-muted">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="server">
                        AttendX server {probeFor("server")?.available ? "· ready" : ""}
                      </SelectItem>
                      <SelectItem value="bridge">
                        Local bridge {probeFor("bridge")?.available ? "· ready" : ""}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Hint label="Compile the editor source into a flashable .hex (Ctrl/Cmd + Enter)">
                  <Button
                    size="lg"
                    className="h-12 min-h-11 w-full bg-amber-500 font-semibold text-slate-950 hover:bg-amber-400 md:w-40"
                    disabled={compiling}
                    onClick={() => void runCompile()}
                    aria-label="Compile the sketch with arduino-cli"
                  >
                    {compiling ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Hammer className="h-5 w-5" aria-hidden="true" />}
                    {compiling ? "Compiling…" : "Compile"}
                  </Button>
                </Hint>
              </div>

              {/* compiler probes + bridge url */}
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-foreground/35">Compiler hosts</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[10px] text-foreground/50 hover:text-foreground/80"
                    disabled={probing}
                    onClick={() => void runProbe()}
                    aria-label="Re-probe compilers"
                  >
                    {probing ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
                    re-probe
                  </Button>
                </div>
                {[
                  { mode: "server" as CompilerMode, label: "AttendX server" },
                  { mode: "bridge" as CompilerMode, label: "Local bridge" },
                ].map((row) => {
                  const probe = probeFor(row.mode);
                  const available = probe?.available === true;
                  return (
                    <div key={row.mode} className="mt-1.5 flex items-start justify-between gap-3 text-[11px]">
                      <span className="flex shrink-0 items-center gap-2 text-foreground/70">
                        <LedDot tone={available ? "on" : probing ? "busy" : "idle"} />
                        {row.label}
                      </span>
                      <span className={cn("text-right", available ? "text-emerald-300" : "text-foreground/35")}>
                        {probes === null
                          ? "probing…"
                          : available
                            ? `arduino-cli ${probe?.version ?? "ready"}`
                            : (probe?.detail ?? "not reachable")}
                      </span>
                    </div>
                  );
                })}
                <div className="mt-2 flex gap-2">
                  <Input
                    value={bridgeUrlDraft}
                    onChange={(e) => setBridgeUrlDraft(e.target.value)}
                    aria-label="Local compile bridge URL"
                    placeholder="http://127.0.0.1:8791"
                    className="h-8 border-border bg-muted font-mono text-[10px]"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 border-border text-[10px]"
                    onClick={applyBridgeUrl}
                    aria-label="Save bridge URL and re-probe"
                  >
                    save bridge url
                  </Button>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-foreground/35">
                  The browser cannot run avr-gcc. Self-hosted APIs with <span className="font-mono text-emerald-300">arduino-cli</span> in PATH compile via the
                  server; everyone else runs the one-file bridge on their own machine:{" "}
                  <span className="font-mono text-emerald-300">node hardware/arduino-bridge.mjs</span> (then flash over
                  Web Serial as usual).
                </p>
              </div>

              {/* compile result */}
              <div aria-live="polite">
                {compileMsg && (
                  <div
                    className={cn(
                      "rounded-lg border p-3 text-xs",
                      compileMsg.tone === "ok" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
                      compileMsg.tone === "error" && "border-red-500/40 bg-red-500/10 text-red-200",
                      compileMsg.tone === "info" && "border-border bg-card/60 text-muted-foreground",
                    )}
                  >
                    <p className="flex items-start gap-2">
                      {compileMsg.tone === "ok" ? (
                        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                      ) : (
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      )}
                      {compileMsg.text}
                    </p>
                    {compileMsg.log && (
                      <pre
                        className={cn(
                          "mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-foreground/10 bg-slate-950/90 p-2 font-mono text-[10px]",
                          SCROLLBAR_CLASSES,
                        )}
                      >
                        {compileMsg.log}
                      </pre>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Hint label="Copy the editor source to the clipboard">
                  <Button variant="outline" size="sm" className="min-h-11 border-border" onClick={() => void copySketch()} aria-label="Copy sketch source">
                    {copied ? <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                    {copied ? "Copied" : "Copy source"}
                  </Button>
                </Hint>
                <Hint label={`Download ${sanitizeSketchName(sketchName)}.ino`}>
                  <Button variant="outline" size="sm" className="min-h-11 border-border" onClick={downloadSketch} aria-label="Download sketch as .ino file">
                    <FileDown className="h-4 w-4" aria-hidden="true" />
                    Download .ino
                  </Button>
                </Hint>
              </div>
            </GlowCard>
          </motion.div>

          {/* ────────────────────────────────────────────────────────────
              PANEL 03 — FIRMWARE FLASHER
          ──────────────────────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.15 }}
            className="lg:col-span-7 xl:col-span-8"
          >
            <GlowCard hover={false} className="flex h-full flex-col gap-4 p-5">
              <PanelHead
                step="03"
                icon={Zap}
                title="FIRMWARE FLASHER"
                sub="hand-rolled STK500v1 over Web Serial — no external flashing libs"
                right={
                  board ? (
                    <Badge variant="outline" className="border-border font-mono text-[10px] text-muted-foreground">
                      flash baud {board.baud}
                    </Badge>
                  ) : null
                }
              />

              {/* hex input */}
              <div className="grid gap-3 md:grid-cols-2">
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) void readHexFile(file);
                  }}
                  className={cn(
                    "flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 text-center transition-colors",
                    dragOver ? "border-emerald-400 bg-emerald-500/10" : "border-border bg-muted",
                  )}
                >
                  <FileUp className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                  <p className="text-xs text-foreground/60">Drop a compiled .hex here</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".hex"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void readHexFile(file);
                      e.target.value = "";
                    }}
                    aria-label="Choose a .hex firmware file"
                    id="hex-file-input"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="min-h-11"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Open file picker for .hex firmware"
                  >
                    <Upload className="h-4 w-4" aria-hidden="true" />
                    Choose .hex file
                  </Button>
                </div>

                <div className="flex flex-col justify-between gap-2 rounded-lg border border-border bg-muted/50 p-4">
                  <div>
                    <p className="text-xs font-semibold text-foreground/70">Built-in AttendX gate firmware</p>
                    <p className="mt-1 font-mono text-[10px] text-foreground/35">/firmware/gate-geofence.hex</p>
                  </div>
                  {builtinState === "available" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                      disabled={flashing}
                      onClick={() => builtinHexTextRef.current && loadHex(builtinHexTextRef.current, "builtin", "gate-geofence.hex (built-in)")}
                      aria-label="Use the built-in gate firmware hex"
                    >
                      <Check className="h-4 w-4" aria-hidden="true" />
                      Use built-in hex
                    </Button>
                  ) : (
                    <p className="text-[11px] text-foreground/40">
                      {builtinState === "checking"
                        ? "Checking for the built-in image…"
                        : "Not deployed in this build (404) — compile the sketch in panel 02 or drop a .hex file."}
                    </p>
                  )}
                </div>
              </div>

              {/* hex status */}
              <div aria-live="polite">
                {hexMeta && (
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 font-mono text-emerald-300">
                      validated
                    </Badge>
                    <span className="font-mono text-muted-foreground">{hexMeta.name}</span>
                    <span className="text-foreground/40">
                      {hexMeta.dataBytes} program bytes · image span {(hexMeta.spanBytes / 1024).toFixed(1)} KB ·
                      gaps filled 0xFF
                    </span>
                  </div>
                )}
                {hexError && (
                  <p className="mt-1 flex items-start gap-1.5 text-[11px] text-red-400">
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {hexError}
                  </p>
                )}
              </div>

              {/* flash action + progress */}
              <div className="flex flex-col gap-3">
                <Hint label={flashDisabledReason ?? `Write ${hexMeta?.dataBytes ?? 0} program bytes via STK500v1 at ${board?.baud ?? 115200} baud`}>
                  <Button
                    size="lg"
                    className="h-12 min-h-11 w-full bg-violet-600 font-semibold text-white hover:bg-violet-500"
                    disabled={flashDisabledReason !== null}
                    onClick={() => void handleFlash()}
                    aria-label="Flash firmware to the connected board"
                  >
                    {flashing ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Zap className="h-5 w-5" aria-hidden="true" />}
                    {flashing ? "Flashing…" : "Flash firmware"}
                  </Button>
                </Hint>

                {flashing && flashProgress && (
                  <div className="space-y-1.5">
                    <Progress value={flashPct} aria-label={`Flash progress: ${flashPct}%`} className="h-2" />
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {flashProgress.written} / {flashProgress.total} pages written ({flashPct}%)
                    </p>
                  </div>
                )}

                {flashResult && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                    role="status"
                    className="flex items-start gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4"
                  >
                    <CircleCheck className="mt-0.5 h-6 w-6 shrink-0 text-emerald-400" aria-hidden="true" />
                    <div className="flex-1">
                      <p className="text-sm font-bold text-emerald-300">Flash verdict: SUCCESS</p>
                      <p className="mt-0.5 text-xs text-emerald-200/80">
                        {flashResult.pages} pages · {flashResult.bytes} bytes · {flashResult.seconds}s — the bootloader
                        jumped to the app.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2 min-h-11 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                        disabled={busy !== null || flashing || !hasPort}
                        onClick={() => void runIdentify()}
                        aria-label="Re-run identify to confirm the flash"
                      >
                        <ScanSearch className="h-4 w-4" aria-hidden="true" />
                        Re-run identify to confirm
                      </Button>
                    </div>
                  </motion.div>
                )}

                {flashError && (
                  <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 p-4">
                    <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden="true" />
                    <div className="text-xs text-red-200/90">
                      <p className="font-semibold text-red-300">Flash failed</p>
                      <p className="mt-0.5 font-mono">{flashError}</p>
                      <p className="mt-1 text-red-200/60">
                        Tip: some clones need a manual RESET press right as flashing starts — the sync loop retries for
                        you three rounds.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* activity log console */}
              <Console
                ariaLabel="Studio activity log"
                emptyHint="waiting for a connect / compile / flash run…"
                lines={
                  activity.map((l) => (
                    <div key={l.id} className="whitespace-pre-wrap break-all">
                      <span className="text-slate-600">{stamp(l.at)}</span>{" "}
                      <span className={ACTIVITY_COLOR[l.level]}>{l.text}</span>
                    </div>
                  )) ?? null
                }
              />
            </GlowCard>
          </motion.div>

          {/* ────────────────────────────────────────────────────────────
              PANEL 04 — SKETCH LIBRARY
          ──────────────────────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.2 }}
            className="lg:col-span-5 xl:col-span-4"
          >
            <GlowCard hover={false} className="flex h-full flex-col gap-4 p-5">
              <PanelHead
                step="04"
                icon={FileDown}
                title="SKETCH LIBRARY"
                sub="gate-firmware sources · 9600 8N1 · terminal commands documented"
              />
              <div className="flex max-h-[520px] flex-col gap-3 overflow-y-auto pr-1 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/20 [&::-webkit-scrollbar-track]:bg-transparent">
                {SKETCHES.map((s) => {
                  const active = s.id === sketchId;
                  return (
                    <div
                      key={s.id}
                      className={cn(
                        "rounded-lg border p-4 transition-colors",
                        active ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-muted/50",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold text-foreground/85">{s.name}</h3>
                        {active && (
                          <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 font-mono text-[10px] text-emerald-300">
                            in editor
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-foreground/45">{s.description}</p>
                      {s.commands && s.commands.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {s.commands.slice(0, 6).map((c) => (
                            <span
                              key={c.cmd}
                              title={c.hint}
                              className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9.5px] text-cyan-300/90"
                            >
                              {c.cmd}
                            </span>
                          ))}
                          {s.commands.length > 6 && (
                            <span className="font-mono text-[9.5px] text-foreground/30">+{s.commands.length - 6} more</span>
                          )}
                        </div>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[10px] text-foreground/35">{s.filename}</span>
                        <Button
                          variant={active ? "secondary" : "outline"}
                          size="sm"
                          className="ml-auto min-h-11"
                          onClick={() => loadTemplate(s.id)}
                          aria-label={`Load ${s.name} into the sketch lab editor`}
                        >
                          <Cpu className="h-4 w-4" aria-hidden="true" />
                          {active ? "In editor" : "Edit in lab"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-auto text-[11px] leading-relaxed text-foreground/35">
                Compile inside the lab (panel 02) when an arduino-cli host is reachable, or outside:{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-emerald-300">
                  arduino-cli compile --fqbn {fqbn}
                </code>{" "}
                → drop the .hex into panel 03. The flasher burns it verbatim over STK500v1 — it never invents bytes.
              </p>
            </GlowCard>
          </motion.div>

          {/* ────────────────────────────────────────────────────────────
              PANEL 05 — CONTROL TERMINAL + INGESTION
          ──────────────────────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.25 }}
            className="lg:col-span-7 xl:col-span-7"
          >
            <GlowCard hover={false} className="flex h-full flex-col gap-4 p-5">
              <PanelHead
                step="05"
                icon={Terminal}
                title="CONTROL TERMINAL & INGESTION"
                sub="serial REPL (history + macros) · ATX1 lines → batched POST /api/gate/sensor-events"
                right={
                  <div className="flex items-center gap-2">
                    <LedDot tone={monitorRunning ? "on" : "idle"} />
                    <Badge variant="outline" className="border-border font-mono text-[10px] text-muted-foreground">
                      {monitorLines.length}/{MONITOR_MAX_LINES} lines
                    </Badge>
                  </div>
                }
              />

              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase tracking-wider text-foreground/35" htmlFor="monitor-baud">
                    Monitor baud
                  </label>
                  <Select value={String(monitorBaud)} onValueChange={(v) => void changeMonitorBaud(Number(v))}>
                    <SelectTrigger id="monitor-baud" aria-label="Serial monitor baud rate" className="min-h-11 w-36 border-border bg-muted">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONITOR_BAUDS.map((b) => (
                        <SelectItem key={b} value={String(b)}>
                          {b} baud
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Hint label={monitorDisabledReason ?? `Open the port at ${monitorBaud} baud and stream lines`}>
                  <Button
                    className={cn("min-h-11", monitorRunning ? "border-red-500/30 text-red-300" : "bg-emerald-500 text-slate-950 hover:bg-emerald-400")}
                    variant={monitorRunning ? "outline" : "default"}
                    disabled={monitorDisabledReason !== null}
                    onClick={() => void (monitorRunning ? stopMonitor() : startMonitor())}
                    aria-label={monitorRunning ? "Stop the serial monitor" : "Start the serial monitor"}
                  >
                    {monitorRunning ? <Unplug className="h-4 w-4" aria-hidden="true" /> : <Terminal className="h-4 w-4" aria-hidden="true" />}
                    {monitorRunning ? "Stop monitor" : "Start monitor"}
                  </Button>
                </Hint>

                <div className="ml-auto flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2">
                  <label htmlFor="ingest-switch" className="text-xs text-foreground/60">
                    Ingest into AttendX
                  </label>
                  <Switch
                    id="ingest-switch"
                    checked={ingestOn}
                    onCheckedChange={handleIngestToggle}
                    disabled={!hasPort || !gateId}
                    aria-label="Toggle ingestion of ATX1 sensor events into AttendX"
                  />
                </div>
              </div>

              {/* ingest target + status */}
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-[11px] uppercase tracking-wider text-foreground/35" htmlFor="ingest-gate">
                    Ingest target gate
                  </label>
                  <Select value={gateId} onValueChange={setGateId}>
                    <SelectTrigger id="ingest-gate" aria-label="Gate that receives the ingested sensor events" className="min-h-11 border-border bg-muted">
                      <SelectValue placeholder={gatesQuery.isLoading ? "loading gates…" : "select a gate"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(gatesQuery.data ?? []).map((g) => (
                        <SelectItem key={g.gateId} value={g.gateId}>
                          {g.name} ({g.gateId})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {gatesQuery.isError && (
                    <p className="text-[10px] text-red-400">
                      Couldn't load gates ({gatesQuery.error instanceof Error ? gatesQuery.error.message : "error"}) —
                      sign in as staff so ingestion can resolve a gateId.
                    </p>
                  )}
                  {!gatesQuery.isError && gatesQuery.data && gatesQuery.data.length === 0 && (
                    <p className="text-[10px] text-foreground/35">No gates registered — create one in Gates & Geofence.</p>
                  )}
                </div>
                <div className="rounded-lg border border-border bg-muted/50 p-3 text-[11px]" aria-live="polite">
                  <div className="flex items-center justify-between">
                    <span className="uppercase tracking-wider text-foreground/35">Ingest status</span>
                    <span className={cn("font-mono", ingestOn ? "text-emerald-300" : "text-foreground/35")}>
                      {ingestOn ? "ARMED" : "OFF"}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-foreground/70">
                    {ingestStats.lastPosted !== null
                      ? `last batch: ${ingestStats.lastPosted} accepted${ingestStats.lastSkipped ? `, ${ingestStats.lastSkipped} skipped` : ""} · total ${ingestStats.totalPosted} across ${ingestStats.batches} batch(es)`
                      : "no batches posted yet"}
                  </p>
                  {ingestStats.lastError && <p className="mt-0.5 text-red-400">{ingestStats.lastError}</p>}
                </div>
              </div>

              {/* the REPL */}
              <SerialTerminal
                lines={monitorLines}
                canSend={monitorRunning && !flashing}
                disabledReason={terminalDisabledReason}
                onSend={handleTerminalSend}
                onClear={() => setMonitorLines([])}
                macros={selectedSketch?.commands ?? []}
              />

              <p className="flex items-center gap-2 text-[11px] text-foreground/35">
                <Activity className="h-3.5 w-3.5 text-emerald-400/60" aria-hidden="true" />
                {monitorEventCount} sensor event{monitorEventCount === 1 ? "" : "s"} captured this session · events
                emerald · errors red · heartbeats violet · your input cyan · chatter slate
              </p>
            </GlowCard>
          </motion.div>

          {/* ────────────────────────────────────────────────────────────
              PANEL 06 — SERIAL PLOTTER
          ──────────────────────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.3 }}
            className="lg:col-span-5 xl:col-span-5"
          >
            <GlowCard hover={false} className="flex h-full flex-col gap-4 p-5">
              <PanelHead
                step="06"
                icon={Activity}
                title="SERIAL PLOTTER"
                sub="numeric fields from the stream — STATUS replies, distCm, key:value chatter"
                right={
                  <Hint label="Wipe all series and start a fresh window">
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-9 border-border"
                      onClick={() => setPlot({ names: [], data: {} })}
                      aria-label="Clear the plotter"
                    >
                      <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
                      Clear
                    </Button>
                  </Hint>
                }
              />
              <Plotter plot={plot} heightClass="h-56" />
              <p className="text-[11px] leading-relaxed text-foreground/35">
                Send <span className="font-mono text-cyan-300">STATUS</span> in panel 05 (or let the geofence sketch
                emit events) and the values chart here live — up to {MAX_PLOT_SERIES} series × {MAX_PLOT_POINTS}
                points. <span className="text-foreground/50">ts/uptime fields are excluded</span> so the scale stays useful.
              </p>
            </GlowCard>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
