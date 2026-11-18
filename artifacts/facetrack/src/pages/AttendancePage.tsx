import { useState, useRef, useEffect, useCallback } from "react";
import {
  useListClassrooms,
  useGetTodayAttendance,
  useCreateAttendance,
  getGetTodayAttendanceQueryKey,
} from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { GlowCard, SectionTitle, StatusBadge, StatusDot, MeshBackground, GlowEmpty } from "@/components/gx/Primitives";
import { FeedSkeletonRow, GlowSkeleton } from "@/components/gx/Skeletons";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { motion, AnimatePresence } from "framer-motion";
import { Html5Qrcode } from "html5-qrcode";
import {
  Camera, ScanFace, QrCode, Keyboard, Loader2, CheckCircle2, XCircle, AlertTriangle,
  Clock, Brain, Activity, Gauge, Layers, RefreshCw, Zap, Video, MapPin, SwitchCamera,
  Radio, Smartphone, Wifi, WifiOff, BatteryMedium, MessageSquare,
} from "lucide-react";
import { format } from "date-fns";
import {
  loadModels, onLoadStatusChange, pickPrimaryFace,
  detectFacesDetailed, detectFacesFast, getBackendName, type FaceDetectionDetail, type LoadStatus,
} from "@/lib/faceApi";
import { drawFaceHud, type HudLabel } from "@/lib/face/hud";
import { FaceTracker, pickTrackForLabel, type TrackedFace } from "@/lib/face/tracker";
import { playMarked, playDuplicate, playUnknown, playPing, primeAudio, isMuted, setMuted } from "@/lib/audio/feedback";

const BASE = import.meta.env.BASE_URL ?? "/";
/** Identity-grade match cadence (full pipeline + server round-trip). */
const MATCH_INTERVAL_MS = 750;
/** While a verdict is fresh, skip re-matching — no duplicate-cue spam. */
const MATCH_COOLDOWN_MS = 4500;
/** Gap between fast detector-only tracking passes (back-to-back otherwise). */
const FAST_LOOP_GAP_MS = 30;
/** A server verdict stays painted on the HUD for this long. */
const RESULT_TTL_MS = 5000;
/** Rolling window used to compute the REAL detector Hz readout. */
const FPS_WINDOW_MS = 3000;
/** How often the tile pushes measured perf to the parent grid stats. */
const PERF_PUSH_MS = 1000;

interface FaceMatchResponse {
  studentId?: number;
  studentName?: string;
  confidence?: number;
  expectedSeat?: string | null;
  attendanceId?: number;
  alreadyMarked?: boolean;
  status?: string;
  sentToReview?: boolean;
  message?: string;
  error?: string;
  candidates?: Array<{ studentId: number; name: string; confidence: number }>;
}

interface NodeRowLite {
  id: string;
  name: string;
  deviceType: string;
  mode: string;
  online: boolean;
  status: string;
  healthStatus: string;
  assignedGateId: string | null;
  fps: number | null;
  batteryLevel: number | null;
}

/** Live perf measured by the tile — every number here is REAL, never estimated. */
export interface TilePerf {
  fps: number;
  frames: number;
  detectMs: number;
  backend: string | null;
}

/** One camera tile: video + HUD overlay canvas + live face state. */
function CameraTile({
  deviceLabel, deviceId, scanning, onDetect, onPerf, frameStat, facing = "user",
}: {
  deviceLabel: string;
  deviceId: string;
  scanning: boolean;
  /** Parent runs the server match; returns the verdict for HUD painting. */
  onDetect: (video: HTMLVideoElement, faces: FaceDetectionDetail[], key: string) => Promise<FaceMatchResponse | null>;
  /** Tile reports REAL measured perf (detector Hz, frame count, backend). */
  onPerf: (key: string, perf: TilePerf) => void;
  frameStat: { fps: number; frames: number; detectMs?: number | null; last: FaceMatchResponse | null; backend?: string | null };
  facing?: "user" | "environment";
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hudRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef(new FaceTracker());
  const resultRef = useRef<{ res: FaceMatchResponse | null; at: number; box: { x: number; y: number; width: number; height: number } | null } | null>(null);
  const onDetectRef = useRef(onDetect);
  const onPerfRef = useRef(onPerf);
  const tickTimesRef = useRef<number[]>([]);
  const detectMsRef = useRef(0);
  const framesTotalRef = useRef(0);
  const lastPerfPushRef = useRef(0);
  const matchBusyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [liveState, setLiveState] = useState<"no-face" | "scanning" | "matched">("no-face");
  const [facesInView, setFacesInView] = useState(0);

  useEffect(() => { onDetectRef.current = onDetect; }, [onDetect]);
  useEffect(() => { onPerfRef.current = onPerf; }, [onPerf]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: deviceId === "default"
            ? { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { deviceId: { exact: deviceId } },
        });
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setReady(true);
      } catch {
        setReady(false);
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId, facing]);

  // ── FAST loop: detector-only boxes at maximum sustainable Hz ──
  // No landmarks, no descriptors, no server — pure tracking input for the
  // HUD. Back-to-back passes with a tiny gap; the FaceTracker extrapolates
  // motion between passes so the drawn brackets glide with the face.
  useEffect(() => {
    if (!scanning || !ready) {
      trackerRef.current.reset();
      resultRef.current = null;
      setLiveState("no-face");
      setFacesInView(0);
      return;
    }
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      if (stopped) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && !document.hidden) {
        const t0 = performance.now();
        try {
          const dets = await detectFacesFast(video);
          detectMsRef.current = detectMsRef.current * 0.7 + (performance.now() - t0) * 0.3;
          framesTotalRef.current += 1;
          tickTimesRef.current.push(Date.now());
          trackerRef.current.update(dets, Date.now());
          setFacesInView((n) => (n === trackerRef.current.count ? n : trackerRef.current.count));
          const now = Date.now();
          if (now - lastPerfPushRef.current >= PERF_PUSH_MS) {
            lastPerfPushRef.current = now;
            tickTimesRef.current = tickTimesRef.current.filter((t) => now - t <= FPS_WINDOW_MS);
            const fps = tickTimesRef.current.length / (FPS_WINDOW_MS / 1000);
            onPerfRef.current(deviceId, {
              fps: Math.round(fps * 10) / 10,
              frames: framesTotalRef.current,
              detectMs: Math.round(detectMsRef.current),
              backend: getBackendName(),
            });
          }
        } catch {
          /* detector hiccup — skip this pass */
        }
      } else if (!video || video.readyState < 2) {
        trackerRef.current.reset();
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), FAST_LOOP_GAP_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      trackerRef.current.reset();
    };
  }, [scanning, ready, deviceId]);

  // ── MATCH loop: identity-grade pipeline + server verdict, throttled ──
  // Runs independently of tracking: a slow server round-trip can never slow
  // the brackets down, and a fresh verdict suppresses redundant re-matches.
  useEffect(() => {
    if (!scanning || !ready) return;
    let stopped = false;
    let timer: number | null = null;
    const key = deviceId;
    const tick = async () => {
      if (stopped) return;
      const video = videoRef.current;
      const now = Date.now();
      const fresh = resultRef.current && now - resultRef.current.at < MATCH_COOLDOWN_MS;
      if (video && video.readyState >= 2 && !document.hidden && !matchBusyRef.current && !fresh && trackerRef.current.count > 0) {
        matchBusyRef.current = true;
        try {
          const faces = await detectFacesDetailed(video);
          if (faces.length > 0) {
            // Full-pipeline boxes refine the tracker's motion model too.
            trackerRef.current.update(faces, now);
            const anchor = pickPrimaryFace(faces)?.box ?? null;
            const res = await onDetectRef.current(video, faces, key);
            const stale = !resultRef.current || Date.now() - resultRef.current.at > RESULT_TTL_MS;
            if (res || stale) {
              resultRef.current = { res, at: Date.now(), box: anchor };
            }
          }
        } catch {
          /* match hiccup — retry on next cadence */
        } finally {
          matchBusyRef.current = false;
        }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), MATCH_INTERVAL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [scanning, ready, deviceId]);

  // ── HUD render loop — tracker-predicted boxes at display refresh rate ──
  useEffect(() => {
    if (!scanning || !ready) return;
    let raf = 0;
    const render = () => {
      const canvas = hudRef.current;
      const video = videoRef.current;
      if (canvas && video) {
        const now = Date.now();
        const tracked: TrackedFace[] = trackerRef.current.predict(now);
        const fresh = resultRef.current && now - resultRef.current.at < RESULT_TTL_MS ? resultRef.current : null;
        const labels: HudLabel[] = [];
        // Label rides the track the verdict was made on (IoU-anchored) — it
        // glides with that face and never jumps onto a different person.
        const labeled = pickTrackForLabel(tracked, fresh?.box);
        if (fresh?.res && labeled) {
          const r = fresh.res;
          if (r.studentId) {
            const tone = r.sentToReview || r.alreadyMarked ? "amber" : (r.confidence ?? 0) >= 0.72 ? "green" : "amber";
            labels.push({
              box: labeled,
              title: r.studentName ?? "MATCH",
              sub: `${((r.confidence ?? 0) * 100).toFixed(0)}%${r.expectedSeat ? ` · seat ${r.expectedSeat}` : ""}${r.alreadyMarked ? " · ALREADY IN" : r.sentToReview ? " · REVIEW" : ""}`,
              tone,
            });
          } else {
            labels.push({ box: labeled, title: "UNRECOGNIZED", sub: "no DB match", tone: "red" });
          }
        }
        const state: "no-face" | "scanning" | "matched" = tracked.length === 0 ? "no-face" : labels.length > 0 ? "matched" : "scanning";
        drawFaceHud(canvas, {
          videoW: video.videoWidth,
          videoH: video.videoHeight,
          faces: tracked,
          labels,
          noFace: tracked.length === 0,
          scanning: tracked.length > 0 && labels.length === 0,
          now,
        });
        // throttle React state churn — HUD itself is canvas-driven
        setLiveState((s) => (s === state ? s : state));
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [scanning, ready]);

  return (
    <div className="gx-card overflow-hidden">
      <div className="relative bg-black" style={{ aspectRatio: "16/9" }}>
        <video
          ref={videoRef}
          autoPlay playsInline muted
          className="w-full h-full object-cover"
          onCanPlay={() => setReady(true)}
        />
        <canvas ref={hudRef} className="absolute inset-0 w-full h-full pointer-events-none" />
        {!ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/90">
            <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
            <p className="text-[10px] text-white/40">{deviceLabel} · starting…</p>
          </div>
        )}
        {ready && (
          <div className="absolute top-2 left-2 flex flex-col gap-1">
            <div className="bg-black/70 rounded-full px-2 py-0.5 flex items-center gap-1.5">
              <Video size={10} className="text-purple-400" />
              <span className="text-[9px] font-mono text-white/70 truncate max-w-[140px]">{deviceLabel}</span>
            </div>
            <div className="bg-black/70 rounded-full px-2 py-0.5 flex items-center gap-1.5">
              <Gauge size={10} className="text-emerald-400" />
              <span className="text-[9px] font-mono text-emerald-300">{frameStat.fps.toFixed(1)} fps</span>
              <span className="text-[9px] font-mono text-white/35">· {frameStat.frames} frames</span>
              {frameStat.detectMs != null && frameStat.detectMs > 0 && (
                <span className="text-[9px] font-mono text-white/35">· {frameStat.detectMs}ms</span>
              )}
              {frameStat.backend && (
                <span
                  className={`text-[8px] font-bold px-1 rounded ${frameStat.backend === "webgl" ? "bg-emerald-500/25 text-emerald-300" : "bg-white/10 text-white/50"}`}
                  title={`tfjs backend: ${frameStat.backend}`}
                >
                  {frameStat.backend === "webgl" ? "GPU" : frameStat.backend.toUpperCase()}
                </span>
              )}
            </div>
            {scanning && (
              <div
                className={`rounded-full px-2 py-0.5 flex items-center gap-1.5 border ${
                  liveState === "matched"
                    ? "border-emerald-400/40 bg-emerald-500/20"
                    : liveState === "scanning"
                      ? "border-violet-400/40 bg-violet-500/20"
                      : "border-white/20 bg-black/70"
                }`}
                aria-live="polite"
              >
                {liveState === "matched" ? (
                  <><ScanFace size={10} className="text-emerald-300" /><span className="text-[9px] font-mono text-emerald-200">FACE LOCKED · {facesInView} in view</span></>
                ) : liveState === "scanning" ? (
                  <><Activity size={10} className="text-violet-300 animate-pulse" /><span className="text-[9px] font-mono text-violet-200">SCANNING · {facesInView} in view</span></>
                ) : (
                  <><XCircle size={10} className="text-white/50" /><span className="text-[9px] font-mono text-white/60">NO FACE DETECTED</span></>
                )}
              </div>
            )}
          </div>
        )}
        {frameStat.last && (
          <div className="absolute bottom-2 left-2 right-2">
            <div
              className="rounded-lg px-2.5 py-1.5 text-[10px] font-medium backdrop-blur-sm"
              style={{
                background: frameStat.last.sentToReview ? "rgba(245,158,11,0.15)" : (frameStat.last.confidence ?? 0) >= 0.72 ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <span className="text-white/85">{frameStat.last.studentName ?? "—"} </span>
              {frameStat.last.confidence != null && (
                <span className="font-mono" style={{ color: frameStat.last.confidence >= 0.72 ? "rgb(74,222,128)" : "rgb(251,191,36)" }}>
                  {(frameStat.last.confidence * 100).toFixed(0)}%
                </span>
              )}
              {frameStat.last.sentToReview && <span className="st-badge st-badge-amber ml-2">review queue</span>}
              {frameStat.last.alreadyMarked && <span className="st-badge st-badge-amber ml-2">already in</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Live strip of paired gate camera nodes — proves the Active Scan console and
 *  the phone camera-node fleet are one live system. */
function GateNodesStrip() {
  const { status: liveStatus } = useLiveEvents();
  const { data: devices } = useQuery({
    queryKey: ["camera-network"],
    queryFn: api.devices,
    refetchInterval: 15000,
  });
  const nodes: NodeRowLite[] = (devices ?? [])
    .filter((d) => d.deviceType === "phone" || d.deviceType === "pi")
    .slice(0, 6);
  const onlineCount = nodes.filter((n) => n.online).length;

  if (nodes.length === 0) return null;

  return (
    <GlowCard variant="gradient" className="p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <StatusDot tone={onlineCount > 0 ? "green" : "red"} pulse={onlineCount > 0} />
          <span className="text-[10px] uppercase tracking-widest text-foreground/40">
            gate camera nodes · <span className="text-emerald-400">{onlineCount}/{nodes.length} live</span>
          </span>
        </div>
        <span
          className={`st-badge ${liveStatus === "live" ? "st-badge-green" : "st-badge-amber"}`}
          title={liveStatus === "live" ? "SSE push connected — scans stream in instantly" : "Fallback polling mode"}
        >
          <Radio size={9} /> {liveStatus === "live" ? "REALTIME PUSH" : liveStatus === "polling" ? "POLL SYNC" : "CONNECTING"}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {nodes.map((n) => (
          <div
            key={n.id}
            className={`rounded-lg border px-2.5 py-2 flex flex-col gap-1 transition-colors ${
              n.online ? "border-emerald-400/25 bg-emerald-500/5" : "border-foreground/10 bg-foreground/5"
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <Smartphone size={11} className={n.online ? "text-emerald-400 shrink-0" : "text-foreground/30 shrink-0"} />
              <span className="text-[11px] font-medium text-foreground/75 truncate">{n.name}</span>
              <span
                className={`ml-auto w-1.5 h-1.5 rounded-full shrink-0 ${n.online ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`}
                aria-label={n.online ? "online" : "offline"}
              />
            </div>
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-foreground/40 flex-wrap">
              <span className={n.mode === "face" ? "text-violet-300" : "text-emerald-300"}>{n.mode.toUpperCase()}</span>
              {n.assignedGateId && <span>· gate {n.assignedGateId}</span>}
              {n.online && n.fps != null && <span>· {n.fps.toFixed(1)}fps</span>}
              {n.batteryLevel != null && (
                <span className="flex items-center gap-0.5"><BatteryMedium size={9} />{n.batteryLevel}%</span>
              )}
              {n.online ? (
                n.healthStatus === "ok" ? <Wifi size={9} className="text-emerald-400" /> : <AlertTriangle size={9} className="text-amber-400" />
              ) : (
                <WifiOff size={9} className="text-red-400" />
              )}
            </div>
          </div>
        ))}
      </div>
    </GlowCard>
  );
}

/** Live event ticker — every scan/SMS/command event, pushed via SSE. */
function LiveEventTicker() {
  const { events } = useLiveEvents();
  const recent = events.slice(0, 6);
  if (recent.length === 0) return null;
  return (
    <div className="space-y-1">
      <AnimatePresence initial={false}>
        {recent.map((ev, i) => {
          const icon =
            ev.type === "attendance.created" ? <CheckCircle2 size={10} className="text-emerald-400" /> :
            ev.type === "sms.sent" ? <MessageSquare size={10} className="text-amber-400" /> :
            ev.type === "device.heartbeat" ? <Radio size={10} className="text-violet-400" /> :
            ev.type === "qr.scan" ? <Camera size={10} className="text-cyan-400" /> :
            <Zap size={10} className="text-foreground/40" />;
          const name = typeof ev.payload?.studentName === "string" ? ev.payload.studentName : "";
          const status = typeof ev.payload?.status === "string" ? ev.payload.status : "";
          return (
            <motion.div
              key={`${ev.at}-${ev.type}-${i}`}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: i === 0 ? 1 : 0.55, x: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 px-2 py-1 rounded-md bg-foreground/5 border border-foreground/10 text-[10px]"
            >
              {icon}
              <span className="font-mono text-foreground/40">{format(new Date(ev.at), "HH:mm:ss")}</span>
              <span className="text-foreground/60 truncate">{ev.type}{name ? ` · ${name}` : ""}{status ? ` (${status})` : ""}</span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export default function AttendancePage() {
  const { toast } = useToast();
  const { lastEvent } = useLiveEvents();

  const [tab, setTab] = useState<"face" | "qr" | "manual">("face");
  const [autoMode, setAutoMode] = useState(true);
  const [modelStatus, setModelStatus] = useState<LoadStatus>("idle");
  const [cameras, setCameras] = useState<Array<{ label: string; deviceId: string }>>([]);
  const [activeCams, setActiveCams] = useState<string[]>(["default"]);
  const [primaryFacing, setPrimaryFacing] = useState<"user" | "environment">("user");
  const [selectedClassroomId, setSelectedClassroomId] = useState<string>("all");
  const [gridStat, setGridStat] = useState<Record<string, { fps: number; frames: number; detectMs?: number; backend?: string | null; last: FaceMatchResponse | null }>>({});
  const [scanResult, setScanResult] = useState<FaceMatchResponse | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [qrScanning, setQrScanning] = useState(false);
  const [manualStudentId, setManualStudentId] = useState("");
  const [manualStatus, setManualStatus] = useState("present");
  const [muted, setMutedState] = useState(isMuted());

  const processingRef = useRef<Record<string, boolean>>({});
  const qrScannerRef = useRef<Html5Qrcode | null>(null);

  const { data: classrooms, isError: classroomsError, error: classroomsErr, refetch: refetchClassrooms } = useListClassrooms();
  const { data: todayAttendance, isLoading: attendanceLoading, isError: attendanceError, error: attendanceErr, refetch: refetchAttendance } = useGetTodayAttendance(
    { classroomId: selectedClassroomId === "all" ? undefined : Number(selectedClassroomId) },
    { query: { queryKey: getGetTodayAttendanceQueryKey({ classroomId: selectedClassroomId === "all" ? undefined : Number(selectedClassroomId) }), refetchInterval: 5000 } }
  );
  const createAttendance = useCreateAttendance();

  useEffect(() => {
    const unsub = onLoadStatusChange(setModelStatus);
    loadModels().catch(() => {});
    return unsub;
  }, []);

  // ── Multi-camera enumeration ──
  const enumerateCameras = useCallback(async () => {
    try {
      // Request permission first so labels are populated
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      tmp.getTracks().forEach((t) => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({ label: d.label || `Camera ${i + 1}`, deviceId: d.deviceId }));
      setCameras(cams);
    } catch {
      setCameras([]);
    }
  }, []);

  useEffect(() => { void enumerateCameras(); }, [enumerateCameras]);

  const toggleCam = (deviceId: string) => {
    setActiveCams((prev) => {
      if (prev.includes(deviceId)) {
        if (prev.length === 1) return prev;
        return prev.filter((d) => d !== deviceId);
      }
      return prev.length >= 4 ? prev : [...prev, deviceId];
    });
  };

  // ── Core match handler: real descriptors in, server verdict out, loud cue out ──
  const handleDetection = useCallback(async (
    video: HTMLVideoElement,
    faces: FaceDetectionDetail[],
    key: string,
  ): Promise<FaceMatchResponse | null> => {
    if (faces.length === 0) return null;
    if (processingRef.current[key]) return null;
    processingRef.current[key] = true;

    try {
      const primary = pickPrimaryFace(faces);
      if (!primary) return null;
      const classId = selectedClassroomId === "all" ? undefined : Number(selectedClassroomId);
      const body: Record<string, unknown> = { faceDescriptor: Array.from(primary.descriptor) };
      if (classId) body.classroomId = classId;

      const res = await fetch(`${BASE}api/face/recognize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("ft_token")}` },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as FaceMatchResponse;

      const result: FaceMatchResponse = res.ok
        ? data
        : { error: data.error, studentName: "No match", confidence: 0, message: data.error };

      setGridStat((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? { fps: 0, frames: 0 }), last: result },
      }));

      if (!res.ok) {
        playUnknown();
        return result;
      }

      setScanResult(result);

      if (data.sentToReview) {
        playDuplicate();
        toast({ title: "Sent to review queue", description: data.message, variant: "destructive" });
      } else if (data.alreadyMarked) {
        playDuplicate();
      } else if (data.studentId) {
        playMarked();
        void refetchAttendance();
        void enumerateCameras();
      } else {
        playUnknown();
      }
      return result;
    } catch {
      return null;
    } finally {
      processingRef.current[key] = false;
    }
  }, [selectedClassroomId, refetchAttendance, toast, enumerateCameras]);

  // Tile perf → grid stats. Numbers arrive measured from the tile itself.
  const handlePerf = useCallback((key: string, perf: TilePerf) => {
    setGridStat((prev) => ({
      ...prev,
      [key]: {
        fps: perf.fps,
        frames: perf.frames,
        detectMs: perf.detectMs,
        backend: perf.backend,
        last: prev[key]?.last ?? null,
      },
    }));
  }, []);

  // Auto reset scan result banner
  useEffect(() => {
    if (!scanResult) return;
    const t = setTimeout(() => setScanResult(null), 4000);
    return () => clearTimeout(t);
  }, [scanResult]);

  // ── QR scanner ──
  const startQr = useCallback(async () => {
    setQrScanning(true);
    primeAudio();
    try {
      const scanner = new Html5Qrcode("qr-live-region", { verbose: false });
      qrScannerRef.current = scanner;
      const cams = await Html5Qrcode.getCameras();
      const back = cams.find((c) => /back|rear|environment/i.test(c.label));
      await scanner.start(
        (back ?? cams[0]).id,
        { fps: 8, qrbox: { width: 220, height: 220 } },
        async (decoded) => {
          await scanner.stop().catch(() => {});
          qrScannerRef.current = null;
          setQrScanning(false);
          try {
            const data = await api.qrScan(decoded, "web");
            if (data.result === "valid" && !data.alreadyMarked) {
              playMarked();
              toast({ title: "QR check-in", description: data.message });
            } else if (data.alreadyMarked) {
              playDuplicate();
              toast({ title: "Already checked in", description: data.message });
            } else {
              playUnknown();
              toast({ title: "Badge rejected", description: data.message, variant: "destructive" });
            }
            void refetchAttendance();
          } catch (e: any) {
            playUnknown();
            toast({ title: "Badge rejected", description: e.message, variant: "destructive" });
          }
        },
        () => {},
      );
    } catch {
      setQrScanning(false);
      toast({ title: "QR camera unavailable", description: "Use manual token entry instead.", variant: "destructive" });
    }
  }, [toast, refetchAttendance]);

  useEffect(() => {
    if (tab !== "qr") {
      qrScannerRef.current?.stop().catch(() => {});
      qrScannerRef.current = null;
      setQrScanning(false);
    }
    return () => {
      qrScannerRef.current?.stop().catch(() => {});
    };
  }, [tab]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualStudentId) return;
    createAttendance.mutate(
      { data: { studentId: Number(manualStudentId), classroomId: selectedClassroomId === "all" ? undefined : Number(selectedClassroomId), status: manualStatus, method: "manual" } },
      {
        onSuccess: () => { refetchAttendance(); playMarked(); toast({ title: "Attendance marked" }); setManualStudentId(""); },
        onError: (e: any) => { playUnknown(); toast({ title: "Failed", description: e.message, variant: "destructive" }); },
      }
    );
  };

  const totalFps = Object.values(gridStat).reduce((acc, s) => acc + s.fps, 0);
  const totalFrames = Object.values(gridStat).reduce((acc, s) => acc + s.frames, 0);

  const modelStatusBadge = () => {
    if (modelStatus === "ready") return <span className="text-[10px] st-green flex items-center gap-1"><Brain className="w-3 h-3" /> AI READY</span>;
    if (modelStatus === "loading") return <span className="text-[10px] st-amber flex items-center gap-1 animate-pulse"><Loader2 className="w-3 h-3 animate-spin" /> LOADING AI…</span>;
    if (modelStatus === "error") return <span className="text-[10px] st-red flex items-center gap-1"><XCircle className="w-3 h-3" /> AI ERROR</span>;
    return <span className="text-[10px] text-foreground/40 flex items-center gap-1"><Brain className="w-3 h-3" /> AI IDLE</span>;
  };

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-4">
        <div className="gx-page-header flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <SectionTitle className="gx-title-gradient" sub="REALTIME AI FACE + QR ATTENDANCE · LIVE NODE SYNC">
            ACTIVE SCAN
          </SectionTitle>
          <div className="flex items-center gap-2 w-full sm:w-56">
            <select
              value={selectedClassroomId}
              onChange={(e) => setSelectedClassroomId(e.target.value)}
              className="flex-1 bg-muted border border-purple-500/15 rounded-lg px-3 py-2 text-sm text-foreground/70 focus:outline-none focus:border-purple-500/45"
            >
              <option value="all">All Classrooms</option>
              {classrooms?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button
              onClick={() => { const next = !muted; setMuted(next); setMutedState(next); if (!next) playPing(); }}
              className={`st-badge shrink-0 ${muted ? "st-badge-red" : "st-badge-green"}`}
              title={muted ? "Unmute scan feedback" : "Mute scan feedback"}
            >
              {muted ? "MUTED" : "SOUND ON"}
            </button>
          </div>
          {classroomsError && (
            <p className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-destructive" role="alert">
              <span className="inline-flex min-w-0 items-center gap-1">
                <AlertTriangle size={11} className="shrink-0" />
                <span className="truncate">Failed to load classrooms — {classroomsErr instanceof Error ? classroomsErr.message : "Unknown error"}</span>
              </span>
              <button type="button" className="shrink-0 font-semibold underline underline-offset-2" onClick={() => void refetchClassrooms()}>
                Retry
              </button>
            </p>
          )}
        </div>

        <GateNodesStrip />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* LEFT: tabs + camera grid */}
          <div className="lg:col-span-8 flex flex-col gap-3">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-foreground/5 border border-foreground/10 w-fit">
              {([
                { id: "face", label: "Face", icon: ScanFace },
                { id: "qr", label: "QR", icon: QrCode },
                { id: "manual", label: "Manual", icon: Keyboard },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                    tab === t.id ? "gx-nav-pill text-purple-200" : "text-foreground/40 hover:text-foreground/70"
                  }`}
                >
                  <t.icon size={13} /> {t.label}
                </button>
              ))}
              <div className="ml-2 px-3 py-1.5 rounded-lg bg-muted border border-foreground/10 flex items-center gap-2">
                <Activity size={11} className="text-emerald-400" />
                <span className="text-[10px] font-mono text-emerald-300">{totalFps.toFixed(1)} FPS</span>
                <span className="text-[10px] font-mono text-foreground/30">· {totalFrames} frames</span>
              </div>
            </div>

            {/* ── FACE TAB ── */}
            {tab === "face" && (
              <div className="space-y-3">
                {/* camera controls */}
                <GlowCard variant="gradient" className="p-3 flex flex-wrap items-center gap-2">
                  <Layers size={13} className="text-purple-400" />
                  <span className="text-[10px] uppercase tracking-widest text-foreground/35">cameras</span>
                  <button
                    onClick={() => { primeAudio(); toggleCam("default"); }}
                    className={`st-badge ${activeCams.includes("default") ? "st-badge-purple" : "st-badge-slate"}`}
                  >
                    primary
                  </button>
                  {activeCams.includes("default") && (
                    <button
                      onClick={() => setPrimaryFacing((f) => (f === "user" ? "environment" : "user"))}
                      className="st-badge st-badge-cyan"
                      title={primaryFacing === "user" ? "Flip primary camera to back" : "Flip primary camera to front"}
                    >
                      <SwitchCamera size={10} /> {primaryFacing === "user" ? "front" : "back"}
                    </button>
                  )}
                  {cameras.filter((c) => c.deviceId && c.deviceId !== "default").slice(0, 3).map((c) => (
                    <button
                      key={c.deviceId}
                      onClick={() => { primeAudio(); toggleCam(c.deviceId); }}
                      className={`st-badge ${activeCams.includes(c.deviceId) ? "st-badge-purple" : "st-badge-slate"}`}
                      title={c.label}
                    >
                      {c.label.slice(0, 18)}
                    </button>
                  ))}
                  <button onClick={() => void enumerateCameras()} className="st-badge st-badge-slate" title="Rescan devices">
                    <RefreshCw size={10} />
                  </button>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={() => { primeAudio(); setAutoMode(true); }}
                      className={`st-badge ${autoMode ? "st-badge-green" : "st-badge-slate"}`}
                    >
                      <Zap size={10} /> AUTO
                    </button>
                    <button
                      onClick={() => setAutoMode(false)}
                      className={`st-badge ${!autoMode ? "st-badge-purple" : "st-badge-slate"}`}
                    >
                      MANUAL
                    </button>
                  </div>
                </GlowCard>

                {/* camera grid */}
                <div className={`grid gap-3 ${activeCams.length > 1 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"}`}>
                  {activeCams.map((deviceId) => {
                    const cam = cameras.find((c) => c.deviceId === deviceId);
                    const stat = gridStat[(deviceId === "default" ? "default" : deviceId)] ?? { fps: 0, frames: 0, last: null };
                    return (
                      <CameraTile
                        key={deviceId}
                        deviceId={deviceId}
                        deviceLabel={cam?.label ?? "Primary camera"}
                        scanning={autoMode || modelStatus === "ready"}
                        onDetect={handleDetection}
                        onPerf={handlePerf}
                        frameStat={stat}
                        facing={primaryFacing}
                      />
                    );
                  })}
                </div>

                {/* manual scan button */}
                {!autoMode && (
                  <button
                    className="gx-btn-accent gx-gradient-pan py-3 rounded-xl text-sm font-semibold text-white transition-all"
                    onClick={() => { primeAudio(); setAutoMode(true); }}
                    disabled={modelStatus !== "ready"}
                  >
                    <ScanFace size={14} className="inline mr-2" /> Enable live auto-scan
                  </button>
                )}

                {modelStatus === "loading" && (
                  <GlowCard className="gx-empty-tint px-4 py-3">
                    <div className="w-full bg-muted rounded-full h-1 overflow-hidden">
                      <div className="h-full bg-purple-500 animate-pulse rounded-full w-3/4" />
                    </div>
                    <p className="text-[10px] text-foreground/40 mt-2 text-center">Loading AI face recognition models…</p>
                  </GlowCard>
                )}

                <AnimatePresence mode="wait">
                  {scanResult && (
                    <motion.div
                      key={String(scanResult.attendanceId ?? scanResult.message)}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="flex items-start gap-2 p-3 rounded-xl border text-sm"
                      style={{
                        background: scanResult.sentToReview ? "rgba(245,158,11,0.08)" : (scanResult.confidence ?? 0) >= 0.72 ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
                        borderColor: scanResult.sentToReview ? "rgba(245,158,11,0.25)" : (scanResult.confidence ?? 0) >= 0.72 ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)",
                      }}
                    >
                      {scanResult.alreadyMarked || scanResult.sentToReview ? <Clock className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" /> : scanResult.studentId ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" /> : <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />}
                      <div>
                        <p className="font-semibold leading-tight text-foreground/85">{scanResult.studentName ?? (scanResult.error ?? "Not recognized")}</p>
                        <p className="text-xs text-foreground/50 mt-0.5">
                          {scanResult.sentToReview ? "Ambiguous match — awaiting admin review." : scanResult.message ?? (scanResult.alreadyMarked ? "Already marked today." : "")}
                        </p>
                        {scanResult.confidence != null && (
                          <div className="flex items-center gap-2 mt-1">
                            <StatusBadge value={scanResult.confidence >= 0.72 ? "valid" : "review"} label={`${(scanResult.confidence * 100).toFixed(1)}%`} tone={scanResult.confidence >= 0.72 ? "green" : "amber"} />
                            {scanResult.expectedSeat && (
                              <span className="st-badge st-badge-cyan"><MapPin size={9} /> seat {scanResult.expectedSeat}</span>
                            )}
                          </div>
                        )}
                        {scanResult.candidates && scanResult.candidates.length > 0 && (
                          <p className="text-[10px] text-foreground/35 mt-1">
                            top candidates: {scanResult.candidates.map((c) => `${c.name} (${(c.confidence * 100).toFixed(0)}%)`).join(" · ")}
                          </p>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* ── QR TAB ── */}
            {tab === "qr" && (
              <GlowCard variant="gradient" className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-foreground/70 flex items-center gap-2">
                    <QrCode size={15} className="text-cyan-400" /> Live QR scanning
                  </span>
                  {!qrScanning && (
                    <button className="st-badge st-badge-cyan px-4 py-2" onClick={() => void startQr()}>
                      <Camera size={11} /> Start camera
                    </button>
                  )}
                </div>
                <div id="qr-live-region" className="rounded-xl overflow-hidden bg-black min-h-[220px] [&>video]:w-full [&>video]:object-cover" />
                {!qrScanning && (
                  <div className="mt-3 flex gap-2">
                    <input
                      value={qrCode}
                      onChange={(e) => setQrCode(e.target.value)}
                      placeholder="…or paste badge token (AXQR1.…)"
                      className="flex-1 bg-muted border border-cyan-500/15 rounded-lg px-3 py-2 text-xs font-mono text-foreground/80 focus:outline-none focus:border-cyan-500/45"
                    />
                    <button
                      className="st-badge st-badge-purple px-4"
                      onClick={async () => {
                        if (!qrCode.trim()) return;
                        try {
                          const data = await api.qrScan(qrCode.trim(), "web");
                          if (data.result === "valid" && !data.alreadyMarked) playMarked();
                          else if (data.alreadyMarked) playDuplicate();
                          else playUnknown();
                          toast({
                            title: data.alreadyMarked ? "Already checked in" : data.result === "valid" ? "QR check-in" : "Badge rejected",
                            description: data.message,
                            variant: data.result === "valid" && !data.alreadyMarked ? "default" : "destructive",
                          });
                          setQrCode("");
                          void refetchAttendance();
                        } catch (e: any) {
                          playUnknown();
                          toast({ title: "Scan failed", description: e.message, variant: "destructive" });
                        }
                      }}
                    >
                      submit
                    </button>
                  </div>
                )}
              </GlowCard>
            )}

            {/* ── MANUAL TAB ── */}
            {tab === "manual" && (
              <GlowCard variant="gradient" className="p-5">
                <span className="text-sm text-foreground/70 flex items-center gap-2 mb-4">
                  <Keyboard size={15} className="text-purple-400" /> Manual entry
                </span>
                <form onSubmit={handleManualSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs text-foreground/50">Student system ID</label>
                    <Input
                      placeholder="e.g. 1"
                      value={manualStudentId}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setManualStudentId(e.target.value)}
                      className="bg-muted border-purple-500/15 text-foreground/80"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-foreground/50">Status</label>
                    <div className="flex gap-2">
                      {(["present", "late", "absent"] as const).map((s) => (
                        <button
                          type="button"
                          key={s}
                          onClick={() => setManualStatus(s)}
                          className={`st-badge flex-1 justify-center py-2 ${manualStatus === s ? (s === "present" ? "st-badge-green" : s === "late" ? "st-badge-amber" : "st-badge-red") : "st-badge-slate"}`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="gx-btn-accent gx-gradient-pan w-full py-2.5 rounded-xl text-sm font-semibold text-white"
                    disabled={createAttendance.isPending || !manualStudentId}
                  >
                    {createAttendance.isPending && <Loader2 className="w-4 h-4 mr-2 inline animate-spin" />}
                    Submit Record
                  </button>
                </form>
              </GlowCard>
            )}
          </div>

          {/* RIGHT: Live Stream */}
          <div className="lg:col-span-4">
            <GlowCard variant="gradient" className="p-5 h-full flex flex-col" style={{ minHeight: 420 }}>
              <div className="flex items-center justify-between mb-4 shrink-0">
                <div className="flex items-center gap-2">
                  <StatusDot tone="green" pulse />
                  <span className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">TODAY'S STREAM</span>
                </div>
                <Badge variant="outline" className="font-mono text-xs text-foreground/40 border-foreground/10">
                  {todayAttendance?.length ?? 0} REC
                </Badge>
              </div>
              <div className="flex-1 overflow-hidden flex flex-col gap-2">
                <LiveEventTicker />
                {attendanceLoading ? (
                  <FeedSkeletonRow rows={6} />
                ) : attendanceError ? (
                  <div
                    className="gx-empty-tint flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-8 text-center"
                    role="alert"
                  >
                    <AlertTriangle className="w-7 h-7 text-destructive shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-destructive">Failed to load today's records</p>
                      <p className="mt-1 text-xs text-muted-foreground">{attendanceErr instanceof Error ? attendanceErr.message : "Unknown error"}</p>
                    </div>
                    <button type="button" onClick={() => void refetchAttendance()} className="st-badge st-badge-slate px-4 py-2">
                      Retry
                    </button>
                  </div>
                ) : !todayAttendance?.length ? (
                  <GlowEmpty icon={<Clock size={22} />} title="No records yet" hint="Start scanning to populate the feed." />
                ) : (
                  <div className="overflow-y-auto h-full pr-1 space-y-1.5">
                    {todayAttendance.map((log) => (
                      <motion.div
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        key={log.id}
                        className="flex items-center justify-between p-2.5 rounded-lg border border-foreground/10 bg-foreground/5 hover:bg-purple-500/5 transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-xs font-bold text-purple-300 shrink-0">
                            {log.studentName.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-xs text-foreground/80 truncate">{log.studentName}</p>
                            <p className="text-[10px] text-foreground/30 truncate">{log.classroomName || "Unassigned"}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-1">
                          <div className="flex flex-col items-end gap-0.5">
                            <StatusBadge value={log.status} />
                            <p className="text-[9px] text-foreground/30 font-mono">{format(new Date(log.markedAt), "HH:mm:ss")}</p>
                          </div>
                          <StatusBadge value={log.method} />
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </div>
              {lastEvent?.type === "attendance.created" && (
                <p className="text-[9px] text-emerald-400/70 mt-2 flex items-center gap-1">
                  <StatusDot tone="green" pulse /> streaming live from gate nodes + web
                </p>
              )}
            </GlowCard>
          </div>
        </div>
      </div>
    </div>
  );
}
