import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as faceapi from "@vladmandic/face-api";
import { Html5Qrcode } from "html5-qrcode";
import {
  Activity, AlertTriangle, BatteryLow, BatteryMedium, BatteryCharging, CameraOff,
  CheckCircle2, Download, EyeOff, Flashlight, FlashlightOff, Gauge, HeartPulse, Leaf,
  Loader2, LogOut, MapPin, Maximize, Minimize, Monitor, QrCode, RefreshCw, ScanFace,
  ShieldCheck, ShieldOff, Signal, Snowflake, SwitchCamera, Video, VideoOff, Wifi, WifiOff, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { loadModels, onLoadStatusChange, type LoadStatus } from "@/lib/faceApi";
import { newNonce } from "@/lib/offline-queue";
import {
  ApiError, bulkMatch, clearStoredIdentity, getStoredDeviceId, getStoredToken,
  qrScan, qrScanBatch, sendHeartbeat, setStoredDeviceId, setStoredToken, sseUrl,
  toSpoolEntry, uploadThumbnail,
  type BulkMatchResultRow, type DeviceIdentityPayload, type HeartbeatBody,
  type NodeHealthStatus, type NodeMode, type QrScanInput, type QrSpoolEntry, type TargetQuality,
} from "@/lib/camera-node/device-api";
import {
  QUALITY_ORDER, QUALITY_SPECS, connectionLabel, pickInitialQuality,
  videoConstraintsFor, type QualityProfile,
} from "@/lib/camera-node/quality";
import { HealthMonitor } from "@/lib/camera-node/health";
import { geoForScan, nodeUptimeSeconds, readBattery, uuid } from "@/lib/camera-node/telemetry";
import {
  CameraStartError, activeVideoTrack, applyTorch, captureThumbnail,
  isSecureForCamera, listVideoInputs, startOwnStream, trackSupportsTorch,
  type CameraFailureKind,
} from "@/lib/camera-node/camera";
import {
  BarcodeDetectorEngine, Html5QrcodeEngine, qrEngineKind, qrEngineLabel,
  type QrEngineKind,
} from "@/lib/camera-node/qr-decoder";
import { playTone } from "@/lib/camera-node/sounds";
import {
  ensureServiceWorker, keepAwake, toggleFullscreen, type BeforeInstallPromptEvent,
} from "@/lib/camera-node/kiosk";

// ── constants ────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 8_000;
const FACE_FLUSH_INTERVAL_MS = 3_500;
const MAX_FRAMES_PER_BATCH = 120;
const QR_DEBOUNCE_MS = 5_000;
const VERDICT_VISIBLE_MS = 4_000;
const HERO_VISIBLE_MS = 4_000;
const COMMAND_PING_MS = 2_600;
const FPS_WINDOW_MS = 6_000;
const MAX_SPOOL = 60;
const PAIR_REGION_ID = "atx-pair-region";
const QR_REGION_ID = "atx-qr-region";

/**
 * Detector options MIRRORED exactly from src/lib/faceApi.ts /
 * AttendancePage: TinyFaceDetector, inputSize 224, scoreThreshold 0.4,
 * tiny landmark68 net, recognition net — same jsdelivr model weights.
 */
const DETECTOR_INPUT_SIZE = 224;
const DETECTOR_SCORE_THRESHOLD = 0.4;

// ── local types ──────────────────────────────────────────────────────

type Phase = "pairing" | "validating" | "ready";
type CameraState = "off" | "starting" | "on" | "error";

interface CameraError {
  kind: CameraFailureKind;
  message: string;
}

interface FaceFeedItem {
  id: number;
  name: string;
  confidence: number;
  status: BulkMatchResultRow["status"];
  committed: boolean;
  at: number;
}

type QrVerdictKind = "valid" | "duplicate" | "blocked" | "queued";

interface QrVerdict {
  kind: QrVerdictKind;
  title: string;
  message: string;
  at: number;
}

type HeroOverlay =
  | { kind: "qr"; verdict: Omit<QrVerdict, "at">; at: number }
  | { kind: "face"; name: string; confidence: number; status: BulkMatchResultRow["status"]; committed: boolean; at: number }
  | null;

function useIntervalFlag() {
  return useRef<number | null>(null);
}

const RESULT_TITLES: Record<string, string> = {
  revoked: "BADGE REVOKED",
  "unknown-badge": "UNKNOWN BADGE",
  "stale-version": "OUTDATED BADGE",
  "geofence-violation": "OUT OF GEOFENCE",
  "too-old": "SCAN TOO OLD",
  "clock-skew": "DEVICE CLOCK SKEW",
  "student-gone": "STUDENT RECORD MISSING",
};

const SCROLLBAR_CLASSES =
  "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15 [&::-webkit-scrollbar-track]:bg-transparent";

// ═════════════════════════════════════════════════════════════════════
// CameraNodePage — public /camera-node route (device-token identity)
// ═════════════════════════════════════════════════════════════════════

/**
 * html5-qrcode stamps inline pixel styles onto its rendered <video>; these
 * scoped rules force full-bleed kiosk rendering without touching index.css.
 */
const REGION_CSS = `
#${PAIR_REGION_ID} video, #${QR_REGION_ID} video {
  width: 100% !important;
  height: 100% !important;
  object-fit: cover !important;
}
`;

export default function CameraNodePage() {
  const { toast } = useToast();

  // ── identity / session state ──
  const [phase, setPhase] = useState<Phase>("pairing");
  const [identity, setIdentity] = useState<DeviceIdentityPayload | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingMessage, setPairingMessage] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [pairScanning, setPairScanning] = useState(false);
  const [unpairOpen, setUnpairOpen] = useState(false);

  // ── runtime state ──
  const [mode, setMode] = useState<NodeMode>("face");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraState, setCameraState] = useState<CameraState>("off");
  const [cameraError, setCameraError] = useState<CameraError | null>(null);
  const [cameraDeviceId, setCameraDeviceId] = useState<string | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  const initialQuality = useRef(pickInitialQuality());
  const [autoQuality, setAutoQuality] = useState<QualityProfile>(initialQuality.current.quality);
  const [localQuality, setLocalQuality] = useState<QualityProfile | null>(null);
  const [operatorQuality, setOperatorQuality] = useState<TargetQuality | null>(null);
  const [dataSaver, setDataSaver] = useState(initialQuality.current.dataSaver);
  const effectiveQuality: QualityProfile = operatorQuality ?? localQuality ?? autoQuality;
  const engineKind: QrEngineKind = qrEngineKind();

  // ── telemetry state (rendered) ──
  const [healthStatus, setHealthStatus] = useState<NodeHealthStatus>("unknown");
  const [battery, setBattery] = useState<{ level: number | null; charging: boolean | null }>({ level: null, charging: null });
  const [connection, setConnection] = useState<string | null>(connectionLabel());
  const [fps, setFps] = useState<number | null>(null);
  const [resolution, setResolution] = useState<string | null>(null);
  const [hbOk, setHbOk] = useState(true);
  const [hbFailures, setHbFailures] = useState(0);
  const [facesInView, setFacesInView] = useState<number | null>(null);
  const [faceFeed, setFaceFeed] = useState<FaceFeedItem[]>([]);
  const [committedCount, setCommittedCount] = useState(0);
  const [faceSyncError, setFaceSyncError] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<LoadStatus>("idle");
  const [verdict, setVerdict] = useState<QrVerdict | null>(null);
  const [hero, setHero] = useState<HeroOverlay>(null);
  const [commandPing, setCommandPing] = useState<{ label: string; at: number } | null>(null);
  const [spoolCount, setSpoolCount] = useState(0);

  // ── refs (mutable, no re-render) ──
  const tokenRef = useRef<string>("");
  const deviceIdRef = useRef<string>("");
  const modeAdoptedRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fallbackEngineRef = useRef<Html5QrcodeEngine | null>(null);
  const endedHandlerRef = useRef<(() => void) | null>(null);
  const healthRef = useRef(new HealthMonitor());
  const barcodeEngineRef = useRef(new BarcodeDetectorEngine());
  const framesRef = useRef<number[][][]>([]);
  const flushingRef = useRef(false);
  const lastFlushAtRef = useRef(0);
  const feedIdRef = useRef(0);
  const tickTimesRef = useRef<number[]>([]);
  const lastQrRef = useRef<{ token: string; at: number }>({ token: "", at: 0 });
  /** command dedupe: key = command|value → last execution ts (SSE + mailbox both fire) */
  const executedCommandsRef = useRef<Map<string, number>>(new Map());
  const spoolRef = useRef<QrSpoolEntry[]>([]);
  const verdictTimerRef = useIntervalFlag();
  const heroTimerRef = useIntervalFlag();
  const pingTimerRef = useIntervalFlag();
  const pairingScannerRef = useRef<Html5Qrcode | null>(null);
  const autoRetryRef = useRef(false);
  const cameraRunRef = useRef(0);
  const submitQrRef = useRef<(token: string) => void>(() => {});
  const trackEndedRef = useRef<() => void>(() => {});
  const activeVideoRef = useRef<() => HTMLVideoElement | null>(() => null);

  /**
   * Single always-fresh snapshot of render-state for interval/async
   * callbacks (heartbeat builder, commands, camera teardowns).
   */
  const liveRef = useRef({
    phase, mode, cameraOn, cameraState, engineKind, effectiveQuality, dataSaver,
    healthStatus, battery, connection, fps, resolution, hbFailures,
  });
  useEffect(() => {
    liveRef.current = {
      phase, mode, cameraOn, cameraState, engineKind, effectiveQuality, dataSaver,
      healthStatus, battery, connection, fps, resolution, hbFailures,
    };
  });

  // ── helpers ──

  const activeVideo = useCallback((): HTMLVideoElement | null => {
    const live = liveRef.current;
    if (live.mode === "qr" && live.engineKind === "html5qrcode") {
      return fallbackEngineRef.current?.getVideo() ?? null;
    }
    return videoRef.current;
  }, []);
  useEffect(() => {
    activeVideoRef.current = activeVideo;
  }, [activeVideo]);

  const clearVerdictTimer = useCallback(() => {
    if (verdictTimerRef.current !== null) {
      window.clearTimeout(verdictTimerRef.current);
      verdictTimerRef.current = null;
    }
  }, [verdictTimerRef]);

  const showVerdict = useCallback((v: Omit<QrVerdict, "at">) => {
    clearVerdictTimer();
    setVerdict({ ...v, at: Date.now() });
    verdictTimerRef.current = window.setTimeout(() => setVerdict(null), VERDICT_VISIBLE_MS);
  }, [clearVerdictTimer, verdictTimerRef]);

  const showHero = useCallback((h: HeroOverlay) => {
    if (heroTimerRef.current !== null) window.clearTimeout(heroTimerRef.current);
    setHero(h);
    heroTimerRef.current = window.setTimeout(() => setHero(null), HERO_VISIBLE_MS);
  }, [heroTimerRef]);

  // ── torch ──

  const torchOnRef = useRef(false);

  const toggleTorch = useCallback(async () => {
    const live = liveRef.current;
    const track =
      live.mode === "qr" && live.engineKind === "html5qrcode"
        ? fallbackEngineRef.current?.getTrack() ?? null
        : activeVideoTrack(streamRef.current);
    const applied = await applyTorch(track, !torchOnRef.current);
    if (applied === null) {
      toast({ title: "Torch unavailable", description: "This camera does not support LED control.", variant: "destructive" });
      return;
    }
    torchOnRef.current = applied;
    setTorchOn(applied);
    playTone("ping");
  }, [toast]);

  // ── thumbnails ──

  const captureAndUpload = useCallback(async (force = false) => {
    if (!deviceIdRef.current) return;
    if (!force && document.hidden) return; // never wake the radio for a hidden tab
    const video = activeVideoRef.current();
    const image = captureThumbnail(video);
    if (!image) return;
    try {
      await uploadThumbnail(tokenRef.current, deviceIdRef.current, image);
    } catch {
      /* thumbnail is best-effort telemetry */
    }
  }, []);

  // ── QR submission (decode → debounce → POST → verdict) ──

  const verdictFor = useCallback((result: string, message: string, studentName: string | null): Omit<QrVerdict, "at"> => {
    if (result === "valid") {
      return {
        kind: "valid",
        title: studentName ? `WELCOME, ${studentName.toUpperCase()}!` : "VALID",
        message: message || "Attendance recorded.",
      };
    }
    if (result === "duplicate") {
      return { kind: "duplicate", title: "DUPLICATE", message: message || "Already checked in today." };
    }
    if (result === "queued-offline") {
      return { kind: "queued", title: "SPOOLED", message: message || "Queued for sync." };
    }
    return {
      kind: "blocked",
      title: RESULT_TITLES[result] ?? "SCAN REJECTED",
      message: message || `Server verdict: ${result}`,
    };
  }, []);

  const submitQrToken = useCallback(async (rawToken: string) => {
    if (!rawToken || liveRef.current.phase !== "ready") return;
    const now = Date.now();
    if (lastQrRef.current.token === rawToken && now - lastQrRef.current.at < QR_DEBOUNCE_MS) return;
    lastQrRef.current = { token: rawToken, at: now };

    const deviceId = deviceIdRef.current || "phone-node";
    const nonce = newNonce();
    const scannedAt = new Date().toISOString();
    const input: QrScanInput = { token: rawToken.slice(0, 2000), terminalId: deviceId, nonce, scannedAt };
    const geo = await geoForScan();
    if (geo) {
      input.latitude = geo.latitude;
      input.longitude = geo.longitude;
      if (geo.accuracy !== null) input.accuracy = geo.accuracy;
    }
    try {
      const res = await qrScan(tokenRef.current, input);
      const v = verdictFor(res.result, res.message ?? "", res.student?.name ?? null);
      showVerdict(v);
      showHero({ kind: "qr", verdict: v, at: Date.now() });
      playTone(res.result === "valid" ? "success" : res.result === "duplicate" ? "duplicate" : "error");
    } catch (err) {
      if (err instanceof ApiError && err.isNetworkError) {
        // offline → spool for the next successful-heartbeat batch flush
        const spool = spoolRef.current;
        spool.push(toSpoolEntry(input, nonce));
        if (spool.length > MAX_SPOOL) spool.shift();
        setSpoolCount(spool.length);
        const queued: Omit<QrVerdict, "at"> = {
          kind: "queued",
          title: "OFFLINE — SPOOLED",
          message: "Stored on device. Syncs automatically when the network returns.",
        };
        showVerdict(queued);
        showHero({ kind: "qr", verdict: queued, at: Date.now() });
        return;
      }
      const result = err instanceof ApiError ? err.bodyResult ?? "error" : "error";
      const message = err instanceof ApiError ? err.bodyMessage ?? err.message : "Unexpected failure";
      const v = verdictFor(result, message, null);
      showVerdict(v);
      showHero({ kind: "qr", verdict: v, at: Date.now() });
      playTone("error");
    }
  }, [showHero, showVerdict, verdictFor]);
  useEffect(() => {
    submitQrRef.current = (t: string) => void submitQrToken(t);
  }, [submitQrToken]);

  // ── face flush (bulk-match batches) ──

  const flushFaces = useCallback(async () => {
    if (flushingRef.current || framesRef.current.length === 0) return;
    flushingRef.current = true;
    const frames = framesRef.current;
    framesRef.current = [];
    lastFlushAtRef.current = Date.now();
    try {
      const res = await bulkMatch(tokenRef.current, uuid(), frames.map((descriptors) => ({ descriptors })));
      setFaceSyncError(null);
      if (res.matched.length > 0) {
        const rows = [...res.matched].sort((a, b) => b.confidence - a.confidence);
        const items: FaceFeedItem[] = rows.map((row) => ({
          id: ++feedIdRef.current,
          name: row.studentName,
          confidence: row.confidence,
          status: row.status,
          committed: row.status === "present" || row.status === "late",
          at: Date.now(),
        }));
        setFaceFeed((prev) => [...items, ...prev].slice(0, 8));
        const committed = items.filter((i) => i.committed);
        if (committed.length > 0) {
          setCommittedCount((c) => c + committed.length);
          const top = committed[0];
          showHero({ kind: "face", name: top.name, confidence: top.confidence, status: top.status, committed: true, at: Date.now() });
          playTone("success");
        }
      }
    } catch (err) {
      // 4xx (e.g. no enrolled encodings) → frames are unusable, drop them;
      // network / 5xx → put the frames back for the next window
      if (err instanceof ApiError && err.status !== null && err.status < 500) {
        setFaceSyncError(err.bodyMessage ?? err.message);
      } else {
        framesRef.current = [...frames, ...framesRef.current].slice(0, MAX_FRAMES_PER_BATCH);
      }
    } finally {
      flushingRef.current = false;
    }
  }, [showHero]);

  // ── spool flush (offline QR scans → /qr/scan/batch) ──

  const flushSpool = useCallback(async () => {
    const spool = spoolRef.current;
    if (spool.length === 0) return;
    const batch = [...spool];
    try {
      const res = await qrScanBatch(tokenRef.current, batch);
      const retryable = new Set(
        res.results
          .filter((r) => r.httpCode >= 500)
          .map((r) => r.nonce)
          .filter((n): n is string => Boolean(n)),
      );
      spoolRef.current = spool.filter((entry) => retryable.has(entry.nonce));
      setSpoolCount(spoolRef.current.length);
      if (res.accepted > 0) {
        toast({
          title: "Offline scans synced",
          description: `${res.accepted}/${res.total} spooled scan${res.total === 1 ? "" : "s"} committed.`,
        });
      }
    } catch {
      /* keep spool for next beat */
    }
  }, [toast]);

  // ── unpair (local revoke — the phone cannot revoke server sessions) ──

  const unpairLocal = useCallback((message?: string) => {
    clearStoredIdentity();
    tokenRef.current = "";
    deviceIdRef.current = "";
    modeAdoptedRef.current = false;
    framesRef.current = [];
    spoolRef.current = [];
    torchOnRef.current = false;
    setSpoolCount(0);
    setCameraOn(false);
    setIdentity(null);
    setFaceFeed([]);
    setCommittedCount(0);
    setFaceSyncError(null);
    setOperatorQuality(null);
    setLocalQuality(null);
    setMode("face");
    setPairScanning(false);
    setPairingMessage(message ?? "Unpaired from this device. Paste a fresh token to reconnect.");
    setPhase("pairing");
  }, []);

  // ── remote command execution (SSE + heartbeat mailbox, deduped) ──

  /**
   * The same command legitimately arrives TWICE: once via the SSE push and
   * once via the heartbeat mailbox (≤8s later, no `at` in the mailbox
   * payload). Dedupe on command+value within a 9s window — long enough to
   * bridge one heartbeat, short enough to allow real operator repeats.
   */
  const executeCommand = useCallback((command: string, value: unknown) => {
    const seen = executedCommandsRef.current;
    const key = `${command}|${JSON.stringify(value ?? null)}`;
    const now = Date.now();
    const last = seen.get(key);
    if (last !== undefined && now - last < 9_000) return;
    seen.set(key, now);
    if (seen.size > 100) {
      for (const [k, ts] of seen) {
        if (now - ts > 9_000) seen.delete(k);
      }
      while (seen.size > 100) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    }
    let label = command;
    switch (command) {
      case "switch_mode":
        if (value === "face" || value === "qr") {
          setMode(value);
          label = `Mode switched → ${value.toUpperCase()}`;
        }
        break;
      case "request_snapshot":
        void captureAndUpload(true);
        label = "Snapshot captured for the ops console";
        break;
      case "flashlight_toggle":
        void toggleTorch();
        label = "Flashlight toggled";
        break;
      case "disconnect":
        unpairLocal("Operator disconnected this camera node.");
        label = "Disconnected by operator";
        break;
      case "set_quality":
        if (value === null || value === "low" || value === "balanced" || value === "hd") {
          setOperatorQuality(value);
          label = value ? `Quality override → ${value}` : "Quality override cleared (auto)";
        }
        break;
      case "set_data_saver":
        if (typeof value === "boolean") {
          setDataSaver(value);
          label = `Data saver ${value ? "enabled" : "disabled"}`;
        }
        break;
      default:
        label = `Unknown command: ${command}`;
        break;
    }
    playTone("ping");
    setCommandPing({ label, at: Date.now() });
    if (pingTimerRef.current !== null) window.clearTimeout(pingTimerRef.current);
    pingTimerRef.current = window.setTimeout(() => setCommandPing(null), COMMAND_PING_MS);
    toast({ title: "Remote command", description: label });
  }, [captureAndUpload, pingTimerRef, toast, toggleTorch, unpairLocal]);

  // ── pairing ──

  const adoptSession = useCallback((res: {
    deviceId: string;
    nextToken: string;
    device: DeviceIdentityPayload;
    targetQuality: TargetQuality | null;
  }) => {
    tokenRef.current = res.nextToken;
    setStoredToken(res.nextToken);
    deviceIdRef.current = res.deviceId;
    setStoredDeviceId(res.deviceId);
    setIdentity(res.device);
    setOperatorQuality(res.targetQuality);
    if (!modeAdoptedRef.current) {
      setMode(res.device.mode === "qr" ? "qr" : "face");
      modeAdoptedRef.current = true;
    }
    setPairingError(null);
  }, []);

  const pairWithToken = useCallback(async (rawToken: string) => {
    const token = rawToken.trim();
    if (!token || pairingBusy) return;
    setPairingBusy(true);
    setPairingError(null);
    try {
      // minimal heartbeat = the pairing handshake; identity comes back here
      const res = await sendHeartbeat(token, {});
      adoptSession(res);
      setPairingMessage(null);
      setTokenInput("");
      setPhase("ready");
      playTone("success");
      toast({
        title: `Paired as ${res.device.name}`,
        description: res.device.assignedGateId
          ? `Assigned gate: ${res.device.assignedGateId}`
          : "No gate assigned yet — set one on the Operations console.",
      });
    } catch (err) {
      clearStoredIdentity();
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setPairingError("Token rejected — copy the pairing token again from Operations → Gate devices.");
      } else if (err instanceof ApiError && err.isNetworkError) {
        setPairingError("Network unreachable — check Wi-Fi and retry.");
      } else {
        setPairingError(err instanceof Error ? err.message : "Pairing failed.");
      }
      setPhase("pairing");
    } finally {
      setPairingBusy(false);
    }
  }, [adoptSession, pairingBusy, toast]);

  // ── pairing QR scanner (ops QR contains the RAW token string) ──

  const stopPairScan = useCallback(async () => {
    const scanner = pairingScannerRef.current;
    pairingScannerRef.current = null;
    setPairScanning(false);
    if (scanner) {
      try {
        await scanner.stop();
        scanner.clear();
      } catch {
        /* already stopped */
      }
    }
  }, []);

  const startPairScan = useCallback(async () => {
    if (pairingScannerRef.current || pairScanning) return;
    setPairScanning(true);
    setPairingError(null);
    // let React mount the visible region before the library measures it
    window.setTimeout(() => {
      const scanner = new Html5Qrcode(PAIR_REGION_ID, { verbose: false, useBarCodeDetectorIfSupported: true });
      pairingScannerRef.current = scanner;
      scanner
        .start(
          { facingMode: { ideal: "environment" } },
          { fps: 8, qrbox: undefined },
          (decodedText) => {
            void stopPairScan().then(() => pairWithToken(decodedText));
          },
          () => {
            /* no-decode frames — ignore */
          },
        )
        .catch((err: unknown) => {
          void stopPairScan();
          const name = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          setPairingError(/permission/i.test(name)
            ? "Camera permission denied — enable it in site settings to scan the pairing QR."
            : `Scanner failed to start: ${name}`);
        });
    }, 60);
  }, [pairScanning, pairWithToken, stopPairScan]);

  useEffect(() => {
    return () => {
      const scanner = pairingScannerRef.current;
      if (scanner) {
        void scanner.stop().then(() => scanner.clear()).catch(() => {});
        pairingScannerRef.current = null;
      }
    };
  }, []);

  // ── boot: stored token validation + kiosk setup ──

  useEffect(() => {
    void ensureServiceWorker();
    const stored = getStoredToken();
    if (!stored) {
      setPhase("pairing");
      return;
    }
    tokenRef.current = stored;
    deviceIdRef.current = getStoredDeviceId() ?? "";
    setPhase("validating");
    let alive = true;
    void (async () => {
      try {
        const res = await sendHeartbeat(stored, {});
        if (!alive) return;
        adoptSession(res);
        setPairingMessage(null);
        setPhase("ready");
      } catch {
        if (!alive) return;
        clearStoredIdentity();
        setPhase("pairing");
        setPairingMessage("Stored session expired or was revoked — pair this camera again.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [adoptSession]);

  // face models preload + status
  useEffect(() => {
    const unsub = onLoadStatusChange(setModelStatus);
    if (phase === "ready" && mode === "face") void loadModels().catch(() => {});
    return unsub;
  }, [phase, mode]);

  // battery telemetry
  useEffect(() => {
    let manager: EventTarget | null = null;
    const onLevel = () => {
      void readBattery().then((b) => setBattery({ level: b.level, charging: b.charging }));
    };
    void readBattery().then((b) => {
      setBattery({ level: b.level, charging: b.charging });
      manager = b.manager;
      manager?.addEventListener("levelchange", onLevel);
    });
    return () => manager?.removeEventListener("levelchange", onLevel);
  }, []);

  // connection telemetry
  useEffect(() => {
    const conn = (navigator as unknown as { connection?: EventTarget & { effectiveType?: string } }).connection;
    if (!conn) return;
    const onChange = () => setConnection(conn.effectiveType ?? null);
    conn.addEventListener("change", onChange);
    return () => conn.removeEventListener("change", onChange);
  }, []);

  // kiosk: install prompt + fullscreen mirror
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstallEvent(null);
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      document.removeEventListener("fullscreenchange", onFsChange);
    };
  }, []);

  // ── camera lifecycle (own stream OR html5-qrcode fallback) ──

  const handleTrackEnded = useCallback(() => {
    if (!liveRef.current.cameraOn) return;
    if (autoRetryRef.current) return; // already tried once
    autoRetryRef.current = true;
    toast({
      title: "Camera disconnected",
      description: "The camera stream ended — retrying once automatically.",
      variant: "destructive",
    });
    window.setTimeout(() => setRestartNonce((n) => n + 1), 1_500);
  }, [toast]);
  useEffect(() => {
    trackEndedRef.current = handleTrackEnded;
  }, [handleTrackEnded]);

  useEffect(() => {
    if (!cameraOn) {
      cameraRunRef.current += 1;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      const engine = fallbackEngineRef.current;
      fallbackEngineRef.current = null;
      if (engine) void engine.stop();
      healthRef.current.reset();
      setCameraState("off");
      setCameraError(null);
      setTorchOn(false);
      setTorchSupported(false);
      setFps(null);
      setResolution(null);
      setFacesInView(null);
      setHealthStatus("unknown");
      tickTimesRef.current = [];
      return;
    }

    const run = ++cameraRunRef.current;
    setCameraState("starting");
    setCameraError(null);
    healthRef.current.reset();
    autoRetryRef.current = false;

    const stopOwnStream = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    const useFallback = liveRef.current.mode === "qr" && liveRef.current.engineKind === "html5qrcode";

    void (async () => {
      try {
        if (useFallback) {
          stopOwnStream();
          const engine = new Html5QrcodeEngine({
            regionId: QR_REGION_ID,
            onDecode: (token) => submitQrRef.current(token),
            onTick: () => tickTimesRef.current.push(Date.now()),
            onTrackEnded: () => trackEndedRef.current(),
          });
          fallbackEngineRef.current = engine;
          await engine.start(videoConstraintsFor(effectiveQuality, { deviceId: cameraDeviceId }));
          if (run !== cameraRunRef.current) {
            await engine.stop();
            return;
          }
          setTorchSupported(trackSupportsTorch(engine.getTrack()));
          setCameraState("on");
        } else {
          const oldEngine = fallbackEngineRef.current;
          fallbackEngineRef.current = null;
          if (oldEngine) await oldEngine.stop();
          const stream = await startOwnStream(effectiveQuality, { deviceId: cameraDeviceId, facing: "environment" });
          if (run !== cameraRunRef.current) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = stream;
          const video = videoRef.current;
          if (video) {
            video.srcObject = stream;
            await video.play().catch(() => {
              /* autoplay policy — user gesture already happened via Start */
            });
          }
          const track = activeVideoTrack(stream);
          if (track) {
            endedHandlerRef.current = () => trackEndedRef.current();
            track.addEventListener("ended", endedHandlerRef.current);
            setTorchSupported(trackSupportsTorch(track));
          }
          setCameraState("on");
        }
      } catch (err) {
        if (run !== cameraRunRef.current) return;
        const kind = err instanceof CameraStartError ? err.kind : "generic";
        setCameraError({ kind, message: err instanceof Error ? err.message : "Camera failed to start." });
        setCameraState("error");
      }
    })();

    return () => {
      if (endedHandlerRef.current) {
        activeVideoTrack(streamRef.current)?.removeEventListener("ended", endedHandlerRef.current);
        endedHandlerRef.current = null;
      }
      stopOwnStream();
      const engine = fallbackEngineRef.current;
      fallbackEngineRef.current = null;
      if (engine) void engine.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn, mode, engineKind, effectiveQuality, cameraDeviceId, restartNonce]);

  const startCamera = useCallback(() => {
    autoRetryRef.current = false;
    setCameraOn(true);
  }, []);

  const stopCamera = useCallback(() => {
    setCameraOn(false);
    setCameraError(null);
  }, []);

  const retryCamera = useCallback(() => {
    autoRetryRef.current = false;
    setCameraError(null);
    setCameraState("starting");
    setRestartNonce((n) => n + 1);
  }, []);

  const flipCamera = useCallback(async () => {
    const devices = await listVideoInputs();
    if (devices.length < 2) {
      toast({ title: "Flip unavailable", description: "Only one camera was found on this device.", variant: "destructive" });
      return;
    }
    const idx = devices.findIndex((d) => d.deviceId === cameraDeviceId);
    const next = devices[(idx + 1) % devices.length];
    setCameraDeviceId(next.deviceId || null);
    toast({ title: "Switching lens", description: next.label || "Another camera" });
  }, [cameraDeviceId, toast]);

  // ── fps / resolution sampler ──

  useEffect(() => {
    if (!cameraOn) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      tickTimesRef.current = tickTimesRef.current.filter((t) => now - t <= FPS_WINDOW_MS);
      setFps(Math.round((tickTimesRef.current.length / (FPS_WINDOW_MS / 1000)) * 10) / 10);
      const video = activeVideoRef.current();
      if (video?.videoWidth) setResolution(`${video.videoWidth}x${video.videoHeight}`);
    }, 2_000);
    return () => window.clearInterval(id);
  }, [cameraOn]);

  // ── FACE detection loop (own stream only) ──

  useEffect(() => {
    const ownStreamMode = mode === "face" || (mode === "qr" && engineKind === "barcodedetector");
    const faceActive = cameraOn && cameraState === "on" && mode === "face" && ownStreamMode && modelStatus === "ready";
    if (!faceActive) return;

    let stopped = false;
    let busy = false;
    let timer: number | null = null;
    const interval = 1000 / QUALITY_SPECS[effectiveQuality].detectFps;

    const tick = async () => {
      if (stopped) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && !document.hidden && !busy) {
        busy = true;
        tickTimesRef.current.push(Date.now());
        try {
          setHealthStatus(healthRef.current.sample(video));
          const detections = await faceapi
            .detectAllFaces(
              video,
              new faceapi.TinyFaceDetectorOptions({ inputSize: DETECTOR_INPUT_SIZE, scoreThreshold: DETECTOR_SCORE_THRESHOLD }),
            )
            .withFaceLandmarks(true)
            .withFaceDescriptors();
          setFacesInView(detections.length);
          if (detections.length > 0) {
            framesRef.current.push(
              detections.slice(0, 20).map((d) => Array.from(d.descriptor)),
            );
            while (framesRef.current.length > MAX_FRAMES_PER_BATCH) framesRef.current.shift();
            if (Date.now() - lastFlushAtRef.current >= FACE_FLUSH_INTERVAL_MS) {
              void flushFaces();
            }
          }
        } catch {
          /* detector hiccup — skip this frame */
        }
        busy = false;
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), Math.max(interval, 40));
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [cameraOn, cameraState, mode, engineKind, modelStatus, effectiveQuality, flushFaces]);

  // ── QR decode loop (native BarcodeDetector over our own stream) ──

  useEffect(() => {
    const nativeActive = cameraOn && cameraState === "on" && mode === "qr" && engineKind === "barcodedetector";
    if (!nativeActive) return;

    let stopped = false;
    let busy = false;
    let timer: number | null = null;
    const interval = 1000 / Math.max(QUALITY_SPECS[effectiveQuality].detectFps, 2);

    const tick = async () => {
      if (stopped) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && !document.hidden && !busy) {
        busy = true;
        tickTimesRef.current.push(Date.now());
        try {
          setHealthStatus(healthRef.current.sample(video));
          const token = await barcodeEngineRef.current.decode(video);
          if (token) void submitQrToken(token);
        } catch {
          /* skip this frame */
        }
        busy = false;
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), Math.max(interval, 40));
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [cameraOn, cameraState, mode, engineKind, effectiveQuality, submitQrToken]);

  // health sampling for the html5-qrcode fallback (its own video element)
  useEffect(() => {
    const fallbackActive = cameraOn && cameraState === "on" && mode === "qr" && engineKind === "html5qrcode";
    if (!fallbackActive) return;
    const id = window.setInterval(() => {
      const video = fallbackEngineRef.current?.getVideo();
      if (video && video.readyState >= 2 && !document.hidden) {
        setHealthStatus(healthRef.current.sample(video));
      }
    }, 1_500);
    return () => window.clearInterval(id);
  }, [cameraOn, cameraState, mode, engineKind]);

  // ── thumbnail interval (per quality profile) ──

  useEffect(() => {
    if (phase !== "ready" || !cameraOn) return;
    const id = window.setInterval(() => void captureAndUpload(false), QUALITY_SPECS[effectiveQuality].thumbnailSec * 1_000);
    // an early frame for the ops console right after start
    const warm = window.setTimeout(() => void captureAndUpload(false), 2_500);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(warm);
    };
  }, [phase, cameraOn, effectiveQuality, captureAndUpload]);

  // ── heartbeat loop (token rotation + command mailbox) ──

  useEffect(() => {
    if (phase !== "ready") return;
    let stopped = false;

    const beat = async () => {
      if (stopped) return;
      const live = liveRef.current;
      const cameraRunning = live.cameraOn && live.cameraState === "on";
      const unhealthy = live.healthStatus === "obstructed" || live.healthStatus === "frozen";
      const body: HeartbeatBody = {
        status: !cameraRunning
          ? "connected"
          : unhealthy || live.hbFailures > 0
            ? "degraded"
            : "running_task",
        mode: live.mode,
        fps: cameraRunning ? live.fps : null,
        resolution: cameraRunning && live.resolution ? live.resolution : undefined,
        healthStatus: cameraRunning ? live.healthStatus : "unknown",
        batteryLevel: live.battery.level,
        connection: live.connection ?? "unknown",
        dataSaver: live.dataSaver,
        uptimeSeconds: nodeUptimeSeconds(),
      };
      try {
        const res = await sendHeartbeat(tokenRef.current, body);
        // rotate the token IMMEDIATELY — the presented token dies in 60s
        tokenRef.current = res.nextToken;
        setStoredToken(res.nextToken);
        deviceIdRef.current = res.deviceId;
        setStoredDeviceId(res.deviceId);
        setIdentity(res.device);
        setOperatorQuality(res.targetQuality);
        setHbOk(true);
        setHbFailures(0);
        if (res.command && typeof res.command.command === "string") {
          executeCommand(res.command.command, res.command.value);
        }
        void flushSpool();
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          unpairLocal("Session expired or revoked by the operator — pair this camera again.");
          return;
        }
        setHbOk(false);
        setHbFailures((f) => f + 1);
      }
    };

    void beat();
    const id = window.setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [phase, executeCommand, flushSpool, unpairLocal]);

  // ── SSE push channel (best-effort on top of the mailbox) ──

  useEffect(() => {
    if (phase !== "ready") return;
    let closed = false;
    let source: EventSource | null = null;
    let retry: number | null = null;

    const connect = () => {
      if (closed) return;
      source = new EventSource(sseUrl(tokenRef.current));
      source.addEventListener("live", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent<string>).data) as { type?: string; payload?: unknown; at?: string };
          if (data.type !== "device.command" || !data.payload || typeof data.payload !== "object") return;
          const payload = data.payload as { deviceId?: string; command?: unknown; value?: unknown; at?: string };
          if (payload.deviceId !== deviceIdRef.current || typeof payload.command !== "string") return;
          executeCommand(payload.command, payload.value);
        } catch {
          /* malformed event — ignore */
        }
      });
      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        // reconnect with the CURRENT (rotated) token — the URL token ages out
        retry = window.setTimeout(connect, 2_500);
      };
    };
    connect();

    return () => {
      closed = true;
      if (retry !== null) window.clearTimeout(retry);
      source?.close();
      source = null;
    };
  }, [phase, executeCommand]);

  // ── wake lock while the camera runs ──

  useEffect(() => {
    if (!cameraOn) return;
    return keepAwake();
  }, [cameraOn]);

  // ── derived chips ──

  const gateLabel = identity?.assignedGateId ?? null;
  const spec = QUALITY_SPECS[effectiveQuality];
  const cameraRunning = cameraState === "on";
  const hbDegraded = hbFailures > 0;

  const healthChip = (() => {
    if (!cameraRunning) return { icon: HeartPulse, text: "camera off", tone: "text-white/40 border-white/10" };
    if (healthStatus === "ok") return { icon: HeartPulse, text: "health ok", tone: "text-emerald-300 border-emerald-400/25 bg-emerald-400/10" };
    if (healthStatus === "obstructed") return { icon: EyeOff, text: "lens obstructed", tone: "text-amber-300 border-amber-400/25 bg-amber-400/10" };
    if (healthStatus === "frozen") return { icon: Snowflake, text: "stream frozen", tone: "text-red-300 border-red-400/25 bg-red-400/10" };
    return { icon: HeartPulse, text: "health ?", tone: "text-white/50 border-white/10" };
  })();

  const batteryChip = (() => {
    if (battery.level === null) return { icon: Activity, text: "battery n/a", tone: "text-white/40 border-white/10" };
    const icon = battery.charging ? BatteryCharging : battery.level <= 20 ? BatteryLow : BatteryMedium;
    const tone = battery.level <= 20 && !battery.charging
      ? "text-red-300 border-red-400/25 bg-red-400/10"
      : "text-white/70 border-white/10";
    return { icon, text: `${battery.level}%${battery.charging ? " ⚡" : ""}`, tone };
  })();

  // ──────────────────────────────────────────────────────────────────
  // render
  // ──────────────────────────────────────────────────────────────────

  if (phase !== "ready") {
    return (
      <div className="fixed inset-0 flex items-start justify-center overflow-y-auto bg-slate-950 px-5 py-10 text-white sm:items-center">
        <style>{REGION_CSS}</style>
        <div className="w-full max-w-md">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="rounded-3xl border border-white/10 bg-slate-900/80 p-6 shadow-2xl shadow-emerald-500/5 backdrop-blur"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-400/10">
                <ShieldCheck className="h-6 w-6 text-emerald-300" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight">AttendX Gate Camera</h1>
                <p className="text-sm text-white/45">Phone as gate camera node · Phase 7</p>
              </div>
            </div>

            {phase === "validating" ? (
              <div className="mt-8 flex flex-col items-center gap-3 py-10 text-center">
                <Loader2 className="h-7 w-7 animate-spin text-emerald-300" />
                <p className="text-sm text-white/60">Validating stored device session…</p>
              </div>
            ) : (
              <>
                {pairingMessage && (
                  <div className="mt-5 flex items-start gap-2 rounded-xl border border-violet-400/25 bg-violet-400/10 px-3 py-2.5 text-sm text-violet-200">
                    <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{pairingMessage}</span>
                  </div>
                )}
                {!isSecureForCamera() && (
                  <div className="mt-5 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-sm text-amber-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Camera needs HTTPS — this page is not a secure context, so the browser will block the camera even after pairing.</span>
                  </div>
                )}

                <div className="mt-6">
                  <label htmlFor="atx-pair-token" className="text-xs font-semibold uppercase tracking-wider text-white/40">
                    Pairing token
                  </label>
                  <Input
                    id="atx-pair-token"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Paste the token from Operations → Gate devices"
                    className="mt-2 h-12 border-white/15 bg-slate-950/60 font-mono text-sm text-white placeholder:text-white/25"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button
                    onClick={() => void pairWithToken(tokenInput)}
                    disabled={pairingBusy || tokenInput.trim().length === 0}
                    className="mt-3 h-12 w-full bg-emerald-500 text-base font-semibold text-slate-950 hover:bg-emerald-400"
                  >
                    {pairingBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShieldCheck className="h-5 w-5" />}
                    {pairingBusy ? "Pairing…" : "Pair device"}
                  </Button>
                </div>

                <div className="my-5 flex items-center gap-3 text-xs text-white/30">
                  <span className="h-px flex-1 bg-white/10" />
                  or scan the pairing QR
                  <span className="h-px flex-1 bg-white/10" />
                </div>

                {!pairScanning ? (
                  <Button
                    onClick={() => void startPairScan()}
                    variant="outline"
                    className="h-12 w-full border-white/15 bg-transparent text-base text-white hover:bg-white/5"
                  >
                    <QrCode className="h-5 w-5 text-emerald-300" />
                    Scan pairing QR
                  </Button>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black">
                    <div id={PAIR_REGION_ID} className="aspect-square w-full [&_video]:h-full [&_video]:w-full [&_video]:object-cover" />
                    <div className="flex items-center justify-between px-3 py-2">
                      <span className="text-xs text-white/45">Point at the QR on the Operations console</span>
                      <Button onClick={() => void stopPairScan()} size="sm" variant="ghost" className="h-9 text-white/70 hover:text-white">
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {pairingError && (
                  <p className="mt-4 flex items-start gap-2 rounded-xl border border-red-400/25 bg-red-400/10 px-3 py-2.5 text-sm text-red-200">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{pairingError}</span>
                  </p>
                )}

                <p className="mt-6 text-center text-xs leading-relaxed text-white/30">
                  The token rotates on every heartbeat — this device keeps itself
                  logged in automatically once paired. Unpair from the action bar
                  or remotely via the Operations console.
                </p>
              </>
            )}
          </motion.div>
        </div>
      </div>
    );
  }

  // ── READY — full-screen kiosk ──

  const fallbackEngineActive = mode === "qr" && engineKind === "html5qrcode";

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-slate-950 text-white">
      <style>{REGION_CSS}</style>
      {/* camera surface */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${cameraRunning && !fallbackEngineActive ? "opacity-100" : "opacity-0"}`}
        aria-label="Gate camera live feed"
      />
      {/* html5-qrcode owns its own video when BarcodeDetector is missing;
          visible while cameraOn so the library can measure the region */}
      <div
        id={QR_REGION_ID}
        className={`absolute inset-0 [&_video]:h-full [&_video]:w-full [&_video]:object-cover ${cameraOn && fallbackEngineActive ? "block" : "pointer-events-none hidden"}`}
      />

      {/* readability vignette */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-slate-950/85 via-transparent to-slate-950/90" />

      {/* camera-off / error state */}
      {!cameraRunning && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/95 px-6">
          {cameraState === "starting" ? (
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-9 w-9 animate-spin text-emerald-300" />
              <p className="text-base text-white/60">Starting camera…</p>
            </div>
          ) : cameraState === "error" && cameraError ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full max-w-md rounded-3xl border border-red-400/25 bg-red-500/10 p-6 text-center"
            >
              {cameraError.kind === "insecure" ? (
                <AlertTriangle className="mx-auto h-10 w-10 text-amber-300" />
              ) : (
                <CameraOff className="mx-auto h-10 w-10 text-red-300" />
              )}
              <h2 className="mt-3 text-xl font-bold">
                {cameraError.kind === "permission"
                  ? "Camera permission denied"
                  : cameraError.kind === "insecure"
                    ? "Camera needs HTTPS"
                    : cameraError.kind === "nocamera"
                      ? "No camera available"
                      : "Camera failed"}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-white/60">{cameraError.message}</p>
              <div className="mt-5 flex flex-col gap-2">
                <Button onClick={retryCamera} className="h-12 bg-emerald-500 text-base font-semibold text-slate-950 hover:bg-emerald-400">
                  <RefreshCw className="h-5 w-5" />
                  Try again
                </Button>
                {cameraError.kind === "permission" && (
                  <p className="text-xs text-white/40">
                    iOS: Settings → Safari → Camera. Android: lock icon in the address bar → Permissions.
                  </p>
                )}
              </div>
            </motion.div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-center">
              <VideoOff className="h-9 w-9 text-white/30" />
              <p className="text-lg font-medium text-white/60">Camera is off</p>
              <p className="max-w-xs text-sm text-white/35">
                Heartbeats keep flowing so the node stays visible on the Operations console.
                Start the camera to begin {mode === "face" ? "face matching" : "QR scanning"}.
              </p>
            </div>
          )}
        </div>
      )}

      {/* top bar */}
      <div className="absolute inset-x-0 top-0 z-20 flex flex-col gap-2 p-3">
        <motion.div
          initial={{ y: -24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/45 px-4 py-2.5 backdrop-blur-md"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`relative flex h-2.5 w-2.5 shrink-0 rounded-full ${hbOk && !hbDegraded ? "bg-emerald-400" : "bg-red-400"}`}
                aria-hidden
              >
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${hbOk && !hbDegraded ? "bg-emerald-400" : "bg-red-400"}`}
                />
              </span>
              <span className="truncate text-base font-bold tracking-tight">
                {identity?.name ?? "Camera node"}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-white/45">
              <MapPin className="h-3 w-3" />
              {gateLabel ? `Gate ${gateLabel}` : "No gate assigned"}
              <span className="mx-1 text-white/20">·</span>
              <span className="truncate font-mono text-[10px]">{deviceIdRef.current || "unregistered"}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${mode === "face" ? "border-violet-400/30 bg-violet-400/10 text-violet-200" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"}`}
            >
              {mode === "face" ? <ScanFace className="h-3.5 w-3.5" /> : <QrCode className="h-3.5 w-3.5" />}
              {mode.toUpperCase()}
            </span>
          </div>
        </motion.div>

        {/* status chips */}
        <div className="flex flex-wrap gap-1.5">
          <Chip className={`backdrop-blur-md ${healthChip.tone}`} icon={healthChip.icon} label={healthChip.text} />
          <Chip className={`border-white/10 bg-black/45 backdrop-blur-md ${batteryChip.tone}`} icon={batteryChip.icon} label={batteryChip.text} />
          <Chip className="border-white/10 bg-black/45 text-white/70 backdrop-blur-md" icon={Gauge} label={cameraRunning ? `${fps?.toFixed(1) ?? "0.0"} fps` : "— fps"} />
          <Chip className="border-white/10 bg-black/45 text-white/70 backdrop-blur-md" icon={Monitor} label={resolution ?? "—"} />
          <Chip
            className={`border-white/10 bg-black/45 backdrop-blur-md ${connection ? "text-white/70" : "text-amber-300"}`}
            icon={connection ? Wifi : WifiOff}
            label={connection ?? "offline?"}
          />
          <Chip className="border-white/10 bg-black/45 text-white/70 backdrop-blur-md" icon={Signal} label={spec.label} />
          {dataSaver && <Chip className="border-emerald-400/25 bg-emerald-400/10 text-emerald-200 backdrop-blur-md" icon={Leaf} label="data saver" />}
          {mode === "face" && facesInView !== null && (
            <Chip className="border-violet-400/25 bg-violet-400/10 text-violet-200 backdrop-blur-md" icon={ScanFace} label={`${facesInView} in view`} />
          )}
          {mode === "face" && faceSyncError && (
            <Chip className="border-red-400/25 bg-red-400/10 text-red-200 backdrop-blur-md" icon={AlertTriangle} label="match sync error" />
          )}
          {mode === "qr" && (
            <Chip className="border-white/10 bg-black/45 text-white/50 backdrop-blur-md" icon={QrCode} label={qrEngineLabel(engineKind)} />
          )}
          {spoolCount > 0 && (
            <Chip className="border-amber-400/25 bg-amber-400/10 text-amber-200 backdrop-blur-md" icon={RefreshCw} label={`${spoolCount} spooled`} />
          )}
        </div>

        {/* reconnecting banner */}
        <AnimatePresence>
          {hbDegraded && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 self-start rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-sm text-amber-200 backdrop-blur-md"
            >
              <WifiOff className="h-4 w-4" />
              Reconnecting… {hbFailures} heartbeat{hbFailures === 1 ? "" : "s"} failed. Scans are spooled locally.
            </motion.div>
          )}
        </AnimatePresence>

        {/* health warning */}
        <AnimatePresence>
          {cameraRunning && (healthStatus === "obstructed" || healthStatus === "frozen") && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`flex items-center gap-2 self-start rounded-xl border px-3 py-2 text-sm backdrop-blur-md ${healthStatus === "obstructed" ? "border-amber-400/25 bg-amber-400/10 text-amber-200" : "border-red-400/25 bg-red-400/10 text-red-200"}`}
            >
              {healthStatus === "obstructed" ? <EyeOff className="h-4 w-4" /> : <Snowflake className="h-4 w-4" />}
              {healthStatus === "obstructed"
                ? "Lens looks covered — clear the camera or reposition the phone."
                : "Frame has not changed for ~15s — the camera stream appears frozen."}
            </motion.div>
          )}
        </AnimatePresence>

        {/* remote command ping */}
        <AnimatePresence>
          {commandPing && (
            <motion.div
              key={commandPing.at}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="self-start rounded-xl border border-violet-400/30 bg-violet-500/15 px-3 py-2 text-sm font-medium text-violet-100 backdrop-blur-md"
            >
              Remote command executed — {commandPing.label}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* hero verdict / match overlay */}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
        <AnimatePresence mode="wait">
          {hero && (
            <motion.div
              key={hero.kind === "qr" ? `qr-${hero.at}` : `face-${hero.name}-${hero.at}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.02 }}
              transition={{ type: "spring", stiffness: 320, damping: 24 }}
              className={`w-full max-w-lg rounded-3xl border-2 px-6 py-8 text-center backdrop-blur-xl ${
                hero.kind === "qr"
                  ? hero.verdict.kind === "valid"
                    ? "border-emerald-400/60 bg-emerald-500/20 shadow-2xl shadow-emerald-500/25"
                    : hero.verdict.kind === "duplicate"
                      ? "border-amber-400/60 bg-amber-500/20 shadow-2xl shadow-amber-500/25"
                      : hero.verdict.kind === "queued"
                        ? "border-white/25 bg-slate-900/70"
                        : "border-red-400/60 bg-red-500/20 shadow-2xl shadow-red-500/25"
                  : hero.committed
                    ? "border-emerald-400/60 bg-emerald-500/20 shadow-2xl shadow-emerald-500/25"
                    : "border-amber-400/60 bg-amber-500/20 shadow-2xl shadow-amber-500/25"
              }`}
            >
              {hero.kind === "qr" ? (
                <>
                  {hero.verdict.kind === "valid" ? (
                    <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-300" />
                  ) : hero.verdict.kind === "duplicate" ? (
                    <AlertTriangle className="mx-auto h-14 w-14 text-amber-300" />
                  ) : hero.verdict.kind === "queued" ? (
                    <RefreshCw className="mx-auto h-14 w-14 text-white/60" />
                  ) : (
                    <XCircle className="mx-auto h-14 w-14 text-red-300" />
                  )}
                  <p className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">{hero.verdict.title}</p>
                  <p className="mt-2 text-base text-white/75">{hero.verdict.message}</p>
                </>
              ) : (
                <>
                  <ScanFace className={`mx-auto h-14 w-14 ${hero.committed ? "text-emerald-300" : "text-amber-300"}`} />
                  <p className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">{hero.name}</p>
                  <p className="mt-1 text-lg font-semibold text-white/80">
                    {(hero.confidence * 100).toFixed(0)}% confidence
                  </p>
                  <p className={`mt-2 inline-block rounded-full px-3 py-1 text-sm font-semibold ${hero.committed ? "bg-emerald-400/20 text-emerald-200" : "bg-amber-400/20 text-amber-200"}`}>
                    {hero.status === "present" ? "Present — committed" : hero.status === "late" ? "Late — committed" : "Already marked today"}
                  </p>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* face model progress */}
      <AnimatePresence>
        {mode === "face" && modelStatus !== "ready" && cameraRunning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute bottom-40 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-black/60 px-4 py-2 text-sm text-white/70 backdrop-blur-md"
          >
            {modelStatus === "loading" ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-300" />
                Loading face models…
              </span>
            ) : (
              <span className="flex items-center gap-2 text-amber-200">
                <AlertTriangle className="h-4 w-4" />
                Face models failed to load — check network, retry by switching mode.
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* recent matches feed */}
      {mode === "face" && faceFeed.length > 0 && (
        <div className="absolute bottom-44 left-3 z-20 w-64 sm:w-72">
          <div className={`max-h-40 overflow-y-auto rounded-2xl border border-white/10 bg-black/50 backdrop-blur-md ${SCROLLBAR_CLASSES}`}>
            <p className="sticky top-0 bg-black/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/40 backdrop-blur">
              Recent matches · {committedCount} committed today
            </p>
            <ul className="divide-y divide-white/5">
              {faceFeed.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="truncate text-sm font-medium">{item.name}</span>
                  <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
                    <span className={item.committed ? "text-emerald-300" : "text-amber-300"}>
                      {(item.confidence * 100).toFixed(0)}%
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${item.committed ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"}`}>
                      {item.status === "already_marked" ? "dup" : item.status}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* bottom action bar */}
      <div className="absolute inset-x-0 bottom-0 z-30 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <motion.div
          initial={{ y: 32, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-2 rounded-3xl border border-white/10 bg-black/55 p-3 backdrop-blur-xl"
        >
          {cameraOn ? (
            <Button
              onClick={stopCamera}
              className="h-14 min-w-[10rem] flex-1 rounded-2xl bg-red-500/90 text-base font-bold text-white hover:bg-red-500 sm:flex-none sm:px-8"
            >
              <VideoOff className="h-5 w-5" />
              Stop camera
            </Button>
          ) : (
            <Button
              onClick={startCamera}
              disabled={cameraState === "starting"}
              className="h-14 min-w-[10rem] flex-1 rounded-2xl bg-emerald-500 text-base font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-60 sm:flex-none sm:px-8"
            >
              {cameraState === "starting" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Video className="h-5 w-5" />}
              Start camera
            </Button>
          )}

          <Button
            onClick={() => void flipCamera()}
            variant="outline"
            aria-label="Flip camera"
            className="h-12 border-white/15 bg-transparent px-4 text-white hover:bg-white/5"
          >
            <SwitchCamera className="h-5 w-5" />
            <span className="hidden sm:inline">Flip</span>
          </Button>

          {torchSupported && (
            <Button
              onClick={() => void toggleTorch()}
              variant="outline"
              aria-label="Toggle flashlight"
              className={`h-12 border-white/15 px-4 hover:bg-white/5 ${torchOn ? "bg-amber-400/20 text-amber-200" : "bg-transparent text-white"}`}
            >
              {torchOn ? <FlashlightOff className="h-5 w-5" /> : <Flashlight className="h-5 w-5" />}
              <span className="hidden sm:inline">Torch</span>
            </Button>
          )}

          {/* mode segmented control */}
          <div className="flex h-12 items-center rounded-2xl border border-white/15 bg-slate-950/60 p-1" role="group" aria-label="Detection mode">
            {(["face", "qr"] as NodeMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`flex h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-semibold transition-colors ${
                  mode === m
                    ? m === "face"
                      ? "bg-violet-500/25 text-violet-100"
                      : "bg-emerald-500/25 text-emerald-100"
                    : "text-white/45 hover:text-white/80"
                }`}
              >
                {m === "face" ? <ScanFace className="h-4 w-4" /> : <QrCode className="h-4 w-4" />}
                {m.toUpperCase()}
              </button>
            ))}
          </div>

          <Select
            value={effectiveQuality}
            onValueChange={(v) => {
              if (v === "low" || v === "balanced" || v === "hd") setLocalQuality(v);
            }}
          >
            <SelectTrigger aria-label="Capture quality" className="h-12 w-[8.5rem] border-white/15 bg-slate-950/60 text-sm text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-white/10 bg-slate-900 text-white">
              {QUALITY_ORDER.map((q) => (
                <SelectItem key={q} value={q}>
                  {QUALITY_SPECS[q].label}
                  {operatorQuality === q ? " (ops)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            onClick={() => void toggleFullscreen()}
            variant="outline"
            aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            className="h-12 border-white/15 bg-transparent px-4 text-white hover:bg-white/5"
          >
            {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
          </Button>

          {installEvent && (
            <Button
              onClick={() => {
                void installEvent.prompt();
                setInstallEvent(null);
              }}
              variant="outline"
              className="h-12 border-emerald-400/30 bg-emerald-400/10 px-4 text-emerald-200 hover:bg-emerald-400/20"
            >
              <Download className="h-5 w-5" />
              <span className="hidden sm:inline">Install</span>
            </Button>
          )}

          <Button
            onClick={() => setUnpairOpen(true)}
            variant="outline"
            aria-label="Unpair device"
            className="h-12 border-red-400/25 bg-transparent px-4 text-red-300 hover:bg-red-400/10"
          >
            <LogOut className="h-5 w-5" />
            <span className="hidden sm:inline">Unpair</span>
          </Button>
        </motion.div>
      </div>

      {/* unpair confirm */}
      <AlertDialog open={unpairOpen} onOpenChange={setUnpairOpen}>
        <AlertDialogContent className="border-white/10 bg-slate-900 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Unpair this camera node?</AlertDialogTitle>
            <AlertDialogDescription className="text-white/55">
              The stored token is erased and the phone returns to the pairing screen.
              The operator can revoke the session remotely at any time from the
              Operations console.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/15 bg-transparent text-white hover:bg-white/5">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => unpairLocal()}
              className="bg-red-500 text-white hover:bg-red-400"
            >
              Unpair
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── tiny status chip ─────────────────────────────────────────────────

function Chip({
  icon: Icon,
  label,
  className = "",
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  className?: string;
}) {
  return (
    <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}
