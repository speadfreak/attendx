import { useCallback, useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { api, type QrScanResponse } from "@/lib/api";
import { enqueueScan, newNonce, useOfflineSync } from "@/lib/offline-queue";
import { GlowCard, SectionTitle, StatusBadge, StatusDot, MeshBackground, GlowEmpty } from "@/components/gx/Primitives";
import { GlowSkeleton } from "@/components/gx/Skeletons";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import {
  DoorOpen, QrCode, Camera, CheckCircle2, XCircle, Clock,
  ScanLine, Terminal, Volume2, VolumeX, RefreshCw, Keyboard, AlertTriangle,
  SwitchCamera, Zap, MapPin, ShieldAlert, CloudUpload, Info,
} from "lucide-react";

/**
 * QR DOOR TERMINAL — the kiosk students tap at the door.
 *  - Camera scanning (html5-qrcode) + USB scanner keyboard-wedge capture
 *  - Manual token entry fallback
 *  - Terminal identity binding (localStorage), distinct from web scans
 *  - Instant full-screen verdict: green WELCOME / amber DUPLICATE / red BLOCKED
 *  - Sound feedback, live counters, anomaly log visibility
 */

type Verdict = "valid" | "duplicate" | "blocked" | "replayed" | "geofence" | "queued" | null;

interface FeedEntry {
  id: number;
  name: string;
  message: string;
  verdict: Exclude<Verdict, null>;
  at: Date;
  serial?: string;
}

const SCANNER_REGION_ID = "gx-qr-reader";
const CAMERA_ID_KEY = "gx_terminal_camera_id";

interface CameraDevice { id: string; label: string; }

/** Best-effort GPS fix attached to every scan (server geofence + fraud AI). */
interface GeoFix { latitude: number; longitude: number; accuracy: number | null }

/** Fresh-fix window: a fix younger than this is reused without re-querying GPS. */
const GEO_CACHE_MS = 30_000; // mirrors maximumAge below

/**
 * Capture geolocation for one scan. Best-effort: resolves null on denial /
 * timeout (8s per spec) / unsupported — the scan proceeds without geo.
 */
function requestGeoFix(): Promise<GeoFix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (fix: GeoFix | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(fix);
    };
    // hard stop just past the 8s API timeout so a wedged GPS never blocks a scan
    const timer = window.setTimeout(() => finish(null), 8_500);
    navigator.geolocation.getCurrentPosition(
      (pos) => finish({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
      }),
      () => finish(null),
      { timeout: 8_000, maximumAge: 30_000, enableHighAccuracy: true },
    );
  });
}

/** Feed row tint per verdict. */
const FEED_STYLES: Record<Exclude<Verdict, null>, { border: string; bg: string }> = {
  valid: { border: "rgba(34,197,94,0.18)", bg: "rgba(34,197,94,0.05)" },
  duplicate: { border: "rgba(245,158,11,0.18)", bg: "rgba(245,158,11,0.05)" },
  blocked: { border: "rgba(239,68,68,0.18)", bg: "rgba(239,68,68,0.05)" },
  geofence: { border: "rgba(239,68,68,0.30)", bg: "rgba(239,68,68,0.09)" },
  replayed: { border: "rgba(148,163,184,0.25)", bg: "rgba(148,163,184,0.07)" },
  queued: { border: "rgba(148,163,184,0.25)", bg: "rgba(148,163,184,0.07)" },
};

function feedDotTone(v: Exclude<Verdict, null>): "green" | "amber" | "red" | "slate" {
  if (v === "valid") return "green";
  if (v === "duplicate") return "amber";
  if (v === "replayed" || v === "queued") return "slate";
  return "red";
}

/** Live video track of the running scanner (torch constraints apply here). */
function getScannerVideoTrack(): MediaStreamTrack | undefined {
  const video = document.querySelector<HTMLVideoElement>(`#${SCANNER_REGION_ID} video`);
  const stream = video?.srcObject;
  return stream instanceof MediaStream ? stream.getVideoTracks()[0] : undefined;
}

function playTone(kind: "success" | "duplicate" | "error") {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    if (kind === "success") {
      o.type = "sine";
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.15);
      g.gain.setValueAtTime(0.3, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      o.start(); o.stop(ctx.currentTime + 0.5);
    } else if (kind === "duplicate") {
      o.type = "triangle";
      o.frequency.setValueAtTime(520, ctx.currentTime);
      g.gain.setValueAtTime(0.18, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      o.start(); o.stop(ctx.currentTime + 0.3);
    } else {
      o.type = "sawtooth";
      o.frequency.setValueAtTime(280, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(90, ctx.currentTime + 0.4);
      g.gain.setValueAtTime(0.25, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      o.start(); o.stop(ctx.currentTime + 0.45);
    }
    setTimeout(() => ctx.close(), 800);
  } catch { /* audio blocked */ }
}

export default function QrTerminalPage() {
  const { toast } = useToast();
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const processingRef = useRef(false);
  const wedgeRef = useRef<HTMLInputElement>(null);
  const wedgeBuffer = useRef("");

  const [cameraState, setCameraState] = useState<"starting" | "ready" | "error" | "denied">("starting");
  const [cameraLabel, setCameraLabel] = useState<string>("");
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string>("");
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const [muted, setMuted] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [scanResult, setScanResult] = useState<QrScanResponse | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [counter, setCounter] = useState({ valid: 0, duplicate: 0, anomalies: 0 });
  const [terminalId, setTerminalId] = useState<string>("door-1");
  const [editingTerminal, setEditingTerminal] = useState(false);
  const [geo, setGeo] = useState<GeoFix | null>(null);
  const geoCacheRef = useRef<{ fix: GeoFix; at: number } | null>(null);

  // Offline spool state (IndexedDB queue + auto-sync)
  const { pending, syncing, lastSyncAt, online, flushNow } = useOfflineSync();

  const feedIdRef = useRef(0);

  useEffect(() => {
    const saved = localStorage.getItem("gx_terminal_id");
    if (saved) setTerminalId(saved);
  }, []);

  const saveTerminal = (value: string) => {
    const clean = value.trim().slice(0, 60) || "door-1";
    setTerminalId(clean);
    localStorage.setItem("gx_terminal_id", clean);
    setEditingTerminal(false);
  };

  const pushFeed = (entry: Omit<FeedEntry, "id" | "at">) => {
    feedIdRef.current += 1;
    setFeed((prev) => [{ ...entry, id: feedIdRef.current, at: new Date() }, ...prev].slice(0, 30));
  };

  const handleScanResponse = useCallback((data: QrScanResponse, serial?: string) => {
    setScanResult(data);
    const kind: Exclude<Verdict, null> =
      data.replayed ? "replayed"
      : data.result === "valid" ? "valid"
      : data.result === "duplicate" ? "duplicate"
      : data.result === "geofence-violation" ? "geofence"
      : data.result === "queued-offline" ? "queued"
      : "blocked";
    setVerdict(kind);
    // replayed/queued are neutral outcomes — no alarm tone
    if (!muted && (kind === "valid" || kind === "duplicate" || kind === "blocked" || kind === "geofence")) {
      playTone(kind === "valid" ? "success" : kind === "duplicate" ? "duplicate" : "error");
    }

    pushFeed({
      name: data.student?.name
        ?? (kind === "queued" ? "Offline queue"
        : kind === "replayed" ? "Already recorded"
        : data.result === "valid" ? data.message : "Unknown badge"),
      message: data.message,
      verdict: kind,
      serial,
    });

    setCounter((c) => ({
      valid: c.valid + (kind === "valid" ? 1 : 0),
      duplicate: c.duplicate + (kind === "duplicate" ? 1 : 0),
      anomalies: c.anomalies + (kind === "blocked" || kind === "geofence" ? 1 : 0),
    }));

    setTimeout(() => setVerdict(null), kind === "queued" ? 5000 : 3500);
    if (kind === "blocked") {
      toast({ title: "Badge rejected", description: data.message, variant: "destructive" });
    }
  }, [muted, toast]);

  /**
   * GPS for one scan: reuse a fix younger than 30s (matches maximumAge) so
   * rapid badge taps don't each wait on the GPS radio; otherwise request a
   * fresh fix (8s timeout, best-effort). Also feeds the GPS indicator chip.
   */
  const getGeoForScan = useCallback(async (): Promise<GeoFix | null> => {
    const cached = geoCacheRef.current;
    if (cached && Date.now() - cached.at < GEO_CACHE_MS) {
      setGeo(cached.fix);
      return cached.fix;
    }
    const fix = await requestGeoFix();
    if (fix) geoCacheRef.current = { fix, at: Date.now() };
    setGeo(fix);
    return fix;
  }, []);

  const submitToken = useCallback(async (rawToken: string) => {
    const token = rawToken.trim();
    if (!token || processingRef.current) return;
    processingRef.current = true;
    const scannedAt = new Date().toISOString(); // captured at the scan moment
    const nonce = newNonce();                    // client idempotency key
    let geoFix: GeoFix | null = null;
    try {
      geoFix = await getGeoForScan(); // best-effort, ≤8s — null on failure
      const data = await api.qrScan(token, terminalId, undefined, {
        nonce,
        scannedAt,
        latitude: geoFix?.latitude ?? null,
        longitude: geoFix?.longitude ?? null,
        accuracy: geoFix?.accuracy ?? null,
      });
      handleScanResponse(data);
    } catch (err) {
      // Non-2xx scan responses carry their verdict in the body — the fetch
      // helper attaches it (see api.ts j()).
      const httpErr = err as { status?: number; body?: (QrScanResponse & { error?: string }) | null; message?: string };
      const body = httpErr.body;
      if (body && (body.result || body.error)) {
        // Definitive server verdict (4xx: geofence-violation, expired, revoked,
        // …) — spooling these can never succeed, so surface them directly.
        handleScanResponse(
          body.result
            ? body
            : { ok: false, result: "malformed", message: body.error ?? "Malformed scan payload." },
        );
      } else {
        // Network failure / offline / 5xx → buffer in the IndexedDB spool.
        try {
          await enqueueScan({
            token,
            terminalId,
            scannedAt,
            nonce,
            latitude: geoFix?.latitude ?? null,
            longitude: geoFix?.longitude ?? null,
            accuracy: geoFix?.accuracy ?? null,
          });
          handleScanResponse({
            ok: false,
            result: "queued-offline",
            message: "Queued offline — will sync automatically.",
          });
        } catch {
          handleScanResponse({
            ok: false,
            result: "blocked",
            message: "Scan failed and offline storage is unavailable — scan again.",
          });
        }
      }
    } finally {
      processingRef.current = false;
    }
  }, [terminalId, handleScanResponse, getGeoForScan]);

  // Warm the GPS cache at terminal start so the first badge tap isn't slowed
  // by a cold location fix (best-effort — permission prompts are expected).
  useEffect(() => {
    void getGeoForScan();
  }, [getGeoForScan]);

  // torch is a non-standard Chromium capability — probe it off the typed capability set
  const detectTorch = useCallback(() => {
    setTorchSupported(false);
    setTorchOn(false);
    const probe = () => {
      const track = getScannerVideoTrack();
      const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      if (caps?.torch === true) setTorchSupported(true);
    };
    probe();
    window.setTimeout(probe, 500);
  }, []);

  // Best-effort LED kill (stream release also clears it, this is just explicit)
  const forceTorchOff = useCallback(() => {
    setTorchOn(false);
    setTorchSupported(false);
    const track = getScannerVideoTrack();
    track?.applyConstraints({ advanced: [{ torch: false }] } as unknown as MediaTrackConstraints)?.catch(() => {});
  }, []);

  // ── Camera scanner loop ────────────────────────────────
  const startScanner = useCallback(async (deviceId?: string) => {
    setCameraState("starting");
    try {
      const scanners = await Html5Qrcode.getCameras();
      if (!scanners.length) {
        setCameraState("denied");
        return;
      }
      setDevices(scanners.map((c) => ({ id: c.id, label: c.label })));
      // Resolution order: explicit pick → saved preference → back camera → first
      const back = scanners.find((c) => /back|rear|environment/i.test(c.label));
      const savedId = localStorage.getItem(CAMERA_ID_KEY);
      const saved = savedId ? scanners.find((c) => c.id === savedId) : undefined;
      const chosen = (deviceId ? scanners.find((c) => c.id === deviceId) : undefined) ?? saved ?? back ?? scanners[0];
      setActiveDeviceId(chosen.id);
      localStorage.setItem(CAMERA_ID_KEY, chosen.id);
      setCameraLabel(chosen.label || "camera");
      const scanner = new Html5Qrcode(SCANNER_REGION_ID, { verbose: false });
      scannerRef.current = scanner;
      await scanner.start(
        chosen.id,
        { fps: 8, qrbox: { width: 260, height: 260 }, aspectRatio: 1.2 },
        (decodedText) => {
          void submitToken(decodedText);
        },
        () => { /* per-frame no-decode; ignore */ },
      );
      setCameraState("ready");
      detectTorch();
    } catch (err: any) {
      setCameraState(/permission/i.test(String(err)) ? "denied" : "error");
    }
  }, [submitToken, detectTorch]);

  const stopScanner = useCallback(() => {
    forceTorchOff();
    const s = scannerRef.current;
    if (s) {
      s.stop().then(() => s.clear()).catch(() => {});
      scannerRef.current = null;
    }
  }, [forceTorchOff]);

  // Stop current scanner, then start with the selected device (guard: rapid toggles)
  const switchCamera = useCallback(async (deviceId: string) => {
    if (switchingRef.current || !deviceId || deviceId === activeDeviceId) return;
    switchingRef.current = true;
    setSwitching(true);
    try {
      forceTorchOff();
      const s = scannerRef.current;
      if (s) {
        await s.stop().catch(() => {});
        s.clear();
        scannerRef.current = null;
      }
      await startScanner(deviceId);
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, [activeDeviceId, startScanner, forceTorchOff]);

  const flipCamera = useCallback(() => {
    if (switchingRef.current || devices.length < 2) return;
    const current = devices.find((d) => d.id === activeDeviceId);
    const currentIsBack = current ? /back|rear|environment/i.test(current.label) : false;
    // Pick the opposite facing if labels reveal it; otherwise cycle the list
    const target = devices.find((d) => d.id !== activeDeviceId && /back|rear|environment/i.test(d.label) === !currentIsBack);
    if (target) {
      void switchCamera(target.id);
      return;
    }
    const idx = devices.findIndex((d) => d.id === activeDeviceId);
    const next = devices[(idx + 1) % devices.length];
    if (next && next.id !== activeDeviceId) void switchCamera(next.id);
  }, [devices, activeDeviceId, switchCamera]);

  const toggleTorch = useCallback(async () => {
    const track = getScannerVideoTrack();
    if (!track) {
      toast({ title: "Torch unavailable", description: "No active camera track.", variant: "destructive" });
      return;
    }
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      toast({ title: "Torch failed", description: "This camera does not support LED torch control.", variant: "destructive" });
    }
  }, [torchOn, toast]);

  useEffect(() => {
    void startScanner();
    return () => stopScanner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep focus on wedge input for USB QR scanners (keyboard emulation)
  useEffect(() => {
    wedgeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        if (wedgeBuffer.current.length > 8) {
          const token = wedgeBuffer.current;
          wedgeBuffer.current = "";
          if (!document.activeElement || document.activeElement !== wedgeRef.current) {
            void submitToken(token);
          }
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [submitToken]);

  // Load today's terminal stats
  useEffect(() => {
    api.qrTerminalStats(terminalId).then(setCounter).catch(() => {});
  }, [terminalId]);

  const activeDevice = devices.find((d) => d.id === activeDeviceId);
  const activeLabel = activeDevice
    ? (activeDevice.label || `Camera ${devices.indexOf(activeDevice) + 1}`)
    : (cameraLabel || "camera");

  // GPS indicator: good ≤20m (emerald) / poor >20m (amber) / unavailable (slate)
  const geoAccuracy = geo?.accuracy ?? null;
  const geoLabel = geo ? `GPS ±${Math.round(geoAccuracy ?? 0)}m` : "GPS off";
  const geoToneCls = !geo ? "text-slate-400" : (geoAccuracy ?? 0) <= 20 ? "text-emerald-400" : "text-amber-400";
  const geoTitle = !geo
    ? "Location unavailable — scans still work; geofence checks may be limited"
    : `Location accuracy ±${Math.round(geoAccuracy ?? 0)} m (${(geoAccuracy ?? 0) <= 20 ? "good" : "poor"})`;

  const verdictStyles: Record<Exclude<Verdict, null>, { bg: string; ring: string; label: string; cls: string }> = {
    valid: { bg: "rgba(34,197,94,0.14)", ring: "rgba(34,197,94,0.55)", label: "WELCOME", cls: "text-emerald-400" },
    duplicate: { bg: "rgba(245,158,11,0.12)", ring: "rgba(245,158,11,0.5)", label: "ALREADY IN", cls: "text-amber-400" },
    blocked: { bg: "rgba(239,68,68,0.12)", ring: "rgba(239,68,68,0.5)", label: "DENIED", cls: "text-red-400" },
    geofence: { bg: "rgba(239,68,68,0.18)", ring: "rgba(239,68,68,0.7)", label: "OUT OF BOUNDS", cls: "text-red-400" },
    replayed: { bg: "rgba(148,163,184,0.12)", ring: "rgba(148,163,184,0.45)", label: "ALREADY RECORDED", cls: "text-slate-300" },
    queued: { bg: "rgba(148,163,184,0.10)", ring: "rgba(148,163,184,0.4)", label: "QUEUED OFFLINE", cls: "text-slate-300" },
  };

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5">
        {/* ── Offline spool banner (Phase 6: dead-WiFi kiosk) ── */}
        {(pending > 0 || !online) && (
          <div className="sticky top-0 z-30">
            <div
              className="flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 shadow-lg"
              style={{
                background: "rgba(2,6,23,0.92)",
                borderColor: online ? "rgba(148,163,184,0.35)" : "rgba(239,68,68,0.5)",
                backdropFilter: "blur(8px)",
              }}
            >
              <span
                className="flex items-center gap-1.5"
                title={online ? "Connected to the server" : "Offline — scans are spooled locally"}
              >
                <span className={`inline-block h-2 w-2 rounded-full ${online ? "bg-emerald-400" : "bg-red-400"}`} />
                <span className="text-[10px] font-mono uppercase tracking-widest text-white/50">
                  {online ? "online" : "offline"}
                </span>
              </span>
              <CloudUpload size={16} className={online ? "text-emerald-400" : "text-slate-400"} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-white/85">
                  {pending > 0
                    ? `${pending} scan${pending === 1 ? "" : "s"} queued — will sync automatically`
                    : "Offline — new scans will be queued automatically"}
                </p>
                <p className="font-mono text-[10px] text-white/40">
                  {syncing
                    ? "syncing…"
                    : lastSyncAt
                      ? `last sync ${format(lastSyncAt, "HH:mm:ss")}`
                      : "waiting for connectivity"}
                </p>
              </div>
              {syncing && <RefreshCw size={16} className="animate-spin text-emerald-400" />}
              {pending > 0 && (
                <button
                  onClick={() => void flushNow()}
                  disabled={syncing}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-4 text-sm font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
                >
                  <RefreshCw size={14} className={syncing ? "animate-spin" : ""} /> Sync now
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <SectionTitle sub="DOOR TERMINAL · TAP BADGE TO CHECK IN">
            QR TERMINAL
          </SectionTitle>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditingTerminal(!editingTerminal)}
              className="st-badge st-badge-cyan font-mono"
              title="Terminal identity"
            >
              <Terminal size={11} /> {terminalId}
            </button>
            <button
              onClick={() => setMuted(!muted)}
              className="st-badge st-badge-slate"
              title={muted ? "Unmute feedback" : "Mute feedback"}
            >
              {muted ? <VolumeX size={11} /> : <Volume2 size={11} />} sound
            </button>
          </div>
        </div>

        {editingTerminal && (
          <GlowCard className="p-4 flex flex-col sm:flex-row gap-2 items-start sm:items-center">
            <label className="text-xs text-white/50 flex items-center gap-2">
              <Terminal size={13} className="text-cyan-400" /> Terminal ID (this door):
            </label>
            <input
              autoFocus
              defaultValue={terminalId}
              onKeyDown={(e) => { if (e.key === "Enter") saveTerminal((e.target as HTMLInputElement).value); }}
              className="bg-black/40 border border-purple-500/20 rounded-lg px-3 py-1.5 text-sm text-white/80 focus:outline-none focus:border-purple-500/50"
              placeholder="e.g. main-gate"
            />
            <button className="st-badge st-badge-green" onClick={() => saveTerminal((document.activeElement as HTMLInputElement)?.value ?? terminalId)}>
              save
            </button>
          </GlowCard>
        )}

        {/* hidden wedge input for USB scanners */}
        <input
          ref={wedgeRef}
          value={manualToken}
          onChange={(e) => setManualToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && manualToken.trim()) {
              void submitToken(manualToken);
              setManualToken("");
            }
          }}
          className="absolute opacity-0 pointer-events-none w-1 h-1"
          aria-hidden="true"
          tabIndex={-1}
        />

        {/* ── Verdict banner ── */}
        <AnimatePresence>
          {verdict && scanResult && (
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10 }}
              className="rounded-2xl p-6 text-center gx-kiosk-glow"
              style={{
                background: verdictStyles[verdict].bg,
                border: `1px solid ${verdictStyles[verdict].ring}`,
              }}
            >
              <div className="flex items-center justify-center gap-3">
                {verdict === "valid" && <CheckCircle2 className="w-9 h-9 text-emerald-400" />}
                {verdict === "duplicate" && <Clock className="w-9 h-9 text-amber-400" />}
                {verdict === "geofence" && <ShieldAlert className="w-9 h-9 text-red-400" />}
                {verdict === "blocked" && <XCircle className="w-9 h-9 text-red-400" />}
                {verdict === "replayed" && <Info className="w-9 h-9 text-slate-300" />}
                {verdict === "queued" && <CloudUpload className="w-9 h-9 text-slate-300" />}
                <div className="text-left">
                  <p className={`text-2xl font-black tracking-widest ${verdictStyles[verdict].cls}`} style={{ fontFamily: "'Orbitron', monospace" }}>
                    {verdictStyles[verdict].label}
                  </p>
                  <p className="text-sm text-white/70 mt-1">{scanResult.student?.name ?? scanResult.message}</p>
                  {scanResult.student && (
                    <p className="text-xs text-white/40 mt-0.5 font-mono">
                      {scanResult.student.studentId}{scanResult.attendance?.status ? ` · ${scanResult.attendance.status.toUpperCase()}` : ""}
                      {scanResult.attendance?.markedAt ? ` · ${format(new Date(scanResult.attendance.markedAt), "HH:mm:ss")}` : ""}
                    </p>
                  )}
                  {scanResult.replayed && (
                    <p className="mt-1 flex items-center justify-center gap-1.5 text-[11px] text-slate-300/80">
                      <Info size={11} /> Already recorded (synced from offline)
                    </p>
                  )}
                </div>
              </div>
              {scanResult.fraudScore != null && scanResult.fraudScore > 0 && (
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                    <AlertTriangle size={11} /> Flagged for review · score {scanResult.fraudScore}
                  </span>
                  {scanResult.fraudSignals && scanResult.fraudSignals.length > 0 && (
                    <span className="font-mono text-[10px] text-amber-200/70">{scanResult.fraudSignals.join(" · ")}</span>
                  )}
                </div>
              )}
              {scanResult.spooled && (
                <p className="mt-2 font-mono text-[11px] text-white/40">recorded from offline spool</p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* ── Scanner ── */}
          <div className="lg:col-span-5 space-y-4">
            <GlowCard accent className="overflow-hidden">
              <div className="relative bg-black" style={{ aspectRatio: "4/3" }}>
                <div id={SCANNER_REGION_ID} className="w-full h-full [&>video]:w-full [&>video]:h-full [&>video]:object-cover" />
                {cameraState !== "ready" && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90">
                    {cameraState === "starting" && (
                      <>
                        <RefreshCw className={`w-8 h-8 text-purple-400 ${switching ? "" : "animate-spin"}`} />
                        <p className="text-xs text-white/50">{switching ? "Switching camera…" : "Starting door camera…"}</p>
                      </>
                    )}
                    {cameraState === "denied" && (
                      <>
                        <Camera className="w-10 h-10 text-red-400/60" />
                        <p className="text-xs text-white/50 px-8 text-center">Camera permission denied. Grant access or use manual entry below.</p>
                      </>
                    )}
                    {cameraState === "error" && (
                      <>
                        <AlertTriangle className="w-10 h-10 text-amber-400/60" />
                        <p className="text-xs text-white/50">Camera unavailable on this device.</p>
                        <button className="st-badge st-badge-purple" onClick={() => void startScanner()}>
                          <RefreshCw size={11} /> retry
                        </button>
                      </>
                    )}
                  </div>
                )}
                {cameraState === "ready" && (
                  <>
                    <div className="absolute top-3 left-3 w-8 h-8 border-t-2 border-l-2 border-purple-400 rounded-tl" />
                    <div className="absolute top-3 right-3 w-8 h-8 border-t-2 border-r-2 border-purple-400 rounded-tr" />
                    <div className="absolute bottom-3 left-3 w-8 h-8 border-b-2 border-l-2 border-purple-400 rounded-bl" />
                    <div className="absolute bottom-3 right-3 w-8 h-8 border-b-2 border-r-2 border-purple-400 rounded-br" />
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="w-56 h-56 rounded-3xl border-2 border-purple-500/30" style={{ boxShadow: "0 0 24px rgba(155,91,255,0.15)" }} />
                    </div>
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/70 px-3 py-1 rounded-full">
                      <ScanLine size={11} className="text-purple-400" />
                      <span className="text-[10px] text-white/60 font-mono">SCANNING · {cameraLabel.slice(0, 24)}</span>
                    </div>
                  </>
                )}
              </div>

              {/* camera controls: picker · flip · torch */}
              <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-t border-purple-500/10">
                {devices.length > 0 && (
                  <select
                    value={activeDeviceId}
                    onChange={(e) => void switchCamera(e.target.value)}
                    disabled={switching}
                    aria-label="Select camera"
                    className="bg-black/40 border border-purple-500/20 rounded-lg px-2.5 py-1.5 text-sm text-white/80 focus:outline-none focus:border-purple-500/50 disabled:opacity-50 max-w-[200px] sm:max-w-[260px]"
                  >
                    {devices.map((d, i) => (
                      <option key={d.id} value={d.id} className="bg-black text-white">
                        {d.label || `Camera ${i + 1}`}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  onClick={flipCamera}
                  disabled={switching || devices.length < 2}
                  className="st-badge st-badge-cyan disabled:opacity-50"
                  title="Flip front / back camera"
                >
                  <SwitchCamera size={11} /> flip
                </button>
                {torchSupported && (
                  <button
                    onClick={() => void toggleTorch()}
                    disabled={switching || cameraState !== "ready"}
                    aria-pressed={torchOn}
                    className={`st-badge ${torchOn ? "st-badge-amber" : "st-badge-slate"} disabled:opacity-50`}
                    title={torchOn ? "Turn torch off" : "Turn torch on"}
                  >
                    <Zap size={11} /> torch
                  </button>
                )}
                {switching && <span className="text-[11px] text-white/40 font-mono">switching…</span>}
                <span
                  className="flex items-center gap-1 rounded-full border border-white/10 bg-black/40 px-2 py-0.5"
                  title={geoTitle}
                >
                  <MapPin size={11} className={geoToneCls} />
                  <span className="font-mono text-[10px] text-white/50">{geoLabel}</span>
                </span>
                <span className="ml-auto text-[11px] text-white/40 font-mono truncate max-w-[45%]" title={activeLabel}>
                  camera: {activeLabel}
                </span>
              </div>
            </GlowCard>

            {/* Manual entry + counters */}
            <GlowCard className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Keyboard size={13} className="text-purple-400" />
                <p className="text-[10px] uppercase tracking-widest text-white/40">Manual / USB scanner entry</p>
              </div>
              <form
                onSubmit={(e) => { e.preventDefault(); void submitToken(manualToken); setManualToken(""); }}
                className="flex gap-2"
              >
                <input
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  placeholder="AXQR1.… token"
                  className="flex-1 bg-black/40 border border-purple-500/20 rounded-lg px-3 py-2 text-xs font-mono text-white/80 focus:outline-none focus:border-purple-500/50"
                />
                <button type="submit" className="st-badge st-badge-purple px-4">submit</button>
              </form>
              <div className="grid grid-cols-3 gap-2 mt-4">
                <div className="rounded-lg bg-emerald-500/8 border border-emerald-500/15 p-2.5 text-center">
                  <p className="counter-num text-lg text-emerald-400">{counter.valid}</p>
                  <p className="text-[8px] uppercase tracking-widest text-white/30">valid today</p>
                </div>
                <div className="rounded-lg bg-amber-500/8 border border-amber-500/15 p-2.5 text-center">
                  <p className="counter-num text-lg text-amber-400">{counter.duplicate}</p>
                  <p className="text-[8px] uppercase tracking-widest text-white/30">duplicates</p>
                </div>
                <div className="rounded-lg bg-red-500/8 border border-red-500/15 p-2.5 text-center">
                  <p className="counter-num text-lg text-red-400">{counter.anomalies}</p>
                  <p className="text-[8px] uppercase tracking-widest text-white/30">blocked</p>
                </div>
              </div>
            </GlowCard>
          </div>

          {/* ── Live door feed ── */}
          <div className="lg:col-span-7">
            <GlowCard className="p-5 h-full">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <StatusDot tone="green" pulse />
                  <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">DOOR FEED</h3>
                </div>
                <StatusBadge value="valid" label="LIVE" tone="green" />
              </div>
              {feed.length === 0 ? (
                <GlowEmpty icon={<QrCode size={22} />} title="Waiting for the first tap" hint="Students scan their badge QR at this terminal to check in." />
              ) : (
                <div className="max-h-[420px] overflow-y-auto pr-1 space-y-1.5">
                  <AnimatePresence initial={false}>
                    {feed.map((entry) => (
                      <motion.div
                        key={entry.id}
                        initial={{ opacity: 0, y: -10, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex items-center gap-3 p-3 rounded-xl border"
                        style={{
                          borderColor: FEED_STYLES[entry.verdict].border,
                          background: FEED_STYLES[entry.verdict].bg,
                        }}
                      >
                        <StatusDot tone={feedDotTone(entry.verdict)} pulse={entry.verdict === "valid"} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-white/85 truncate">{entry.name}</p>
                            {entry.serial && <span className="text-[9px] font-mono text-white/25">{entry.serial}</span>}
                          </div>
                          <p className="text-[11px] text-white/40 truncate">{entry.message}</p>
                        </div>
                        <span className="text-[10px] font-mono text-white/30 shrink-0">{format(entry.at, "HH:mm:ss")}</span>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </GlowCard>
          </div>
        </div>
      </div>
    </div>
  );
}
