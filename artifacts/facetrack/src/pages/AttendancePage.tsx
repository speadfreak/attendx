import { useState, useRef, useEffect, useCallback } from "react";
import {
  useListClassrooms,
  useGetTodayAttendance,
  useCreateAttendance,
  getGetTodayAttendanceQueryKey,
} from "@workspace/api-client-react";
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
  Camera, ScanFace, QrCode, Keyboard, Loader2, CheckCircle2, XCircle,
  Clock, Brain, Activity, Gauge, Layers, RefreshCw, Zap, Video, MapPin, SwitchCamera,
} from "lucide-react";
import { format } from "date-fns";
import { loadModels, extractDescriptor, onLoadStatusChange, type LoadStatus } from "@/lib/faceApi";

// ── Audio ───────────────────────────────────────────────
function playSuccessSound() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = "sine";
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.15);
    g.gain.setValueAtTime(0.25, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    o.start(); o.stop(ctx.currentTime + 0.45);
    setTimeout(() => ctx.close(), 700);
  } catch (_) {}
}

function playErrorSound() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = "sawtooth";
    o.frequency.setValueAtTime(300, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.35);
    g.gain.setValueAtTime(0.2, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.start(); o.stop(ctx.currentTime + 0.4);
    setTimeout(() => ctx.close(), 600);
  } catch (_) {}
}

const BASE = import.meta.env.BASE_URL ?? "/";

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

/** One camera tile: video + overlay canvas + FPS telemetry. */
function CameraTile({
  deviceLabel, deviceId, scanning, onCapture, frameStat, facing = "user",
}: {
  deviceLabel: string;
  deviceId: string;
  scanning: boolean;
  onCapture: (video: HTMLVideoElement, canvas: HTMLCanvasElement) => void;
  frameStat: { fps: number; frames: number; last: FaceMatchResponse | null };
  facing?: "user" | "environment";
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);

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

  // Detection loop
  useEffect(() => {
    if (!scanning || !ready) return;
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      if (videoRef.current && canvasRef.current && videoRef.current.readyState >= 2) {
        onCapture(videoRef.current, canvasRef.current);
      }
      setTimeout(loop, 1500);
    };
    loop();
    return () => { stopped = true; };
  }, [scanning, ready, onCapture]);

  const drawResult = (r: FaceMatchResponse | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // clear overlay
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!r || !r.studentName) return;
    const good = (r.confidence ?? 0) >= 0.72;
    const tone = good ? "34,197,94" : (r.confidence ?? 0) >= 0.3 ? "245,158,11" : "239,68,68";
    // rounded box, centered (we don't run local detection when server matched;
    // show HUD card instead of a box since the descriptor came from the frame center)
    const w = Math.min(canvas.width * 0.42, 260);
    const h = w * 1.15;
    const x = (canvas.width - w) / 2;
    const y = (canvas.height - h) / 2 - canvas.height * 0.06;
    ctx.strokeStyle = `rgba(${tone},0.9)`;
    ctx.lineWidth = 3;
    ctx.shadowColor = `rgba(${tone},0.8)`;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    // corner brackets
    const c = 22;
    ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
    ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c);
    ctx.moveTo(x + w, y + h - c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - c, y + h);
    ctx.moveTo(x + c, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - c);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // name + confidence plate
    const plate = `${r.studentName} ${(r.confidence! * 100).toFixed(0)}%${r.expectedSeat ? ` · seat ${r.expectedSeat}` : ""}`;
    ctx.font = "600 13px 'Inter', sans-serif";
    const textW = ctx.measureText(plate).width + 16;
    const plateH = 24;
    const plateY = y + h + 8;
    ctx.fillStyle = `rgba(${tone},0.85)`;
    ctx.beginPath();
    ctx.roundRect(x + w / 2 - textW / 2, plateY, textW, plateH, 6);
    ctx.fill();
    ctx.fillStyle = "#050208";
    ctx.fillText(plate, x + w / 2 - textW / 2 + 8, plateY + 16);
  };

  useEffect(() => { drawResult(frameStat.last); }, [frameStat.last]);

  return (
    <div className="gx-card overflow-hidden">
      <div className="relative bg-black" style={{ aspectRatio: "16/9" }}>
        <video
          ref={videoRef}
          autoPlay playsInline muted
          className="w-full h-full object-cover"
          onCanPlay={() => setReady(true)}
        />
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
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
            </div>
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
  const [gridStat, setGridStat] = useState<Record<string, { fps: number; frames: number; last: FaceMatchResponse | null }>>({});
  const [scanResult, setScanResult] = useState<FaceMatchResponse | null>(null);
  const [framesTotal, setFramesTotal] = useState(0);
  const [qrCode, setQrCode] = useState("");
  const [qrScanning, setQrScanning] = useState(false);
  const [manualStudentId, setManualStudentId] = useState("");
  const [manualStatus, setManualStatus] = useState("present");

  const processingRef = useRef<Record<string, boolean>>({});
  const fpsTracker = useRef<Record<string, { times: number[] }>>({});
  const qrScannerRef = useRef<Html5Qrcode | null>(null);

  const { data: classrooms } = useListClassrooms();
  const { data: todayAttendance, isLoading: attendanceLoading, refetch: refetchAttendance } = useGetTodayAttendance(
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

  // ── Core face capture (per camera tile) ──
  const doCapture = useCallback(async (video: HTMLVideoElement, canvas: HTMLCanvasElement) => {
    const key = video.srcObject && (video.srcObject as MediaStream).id ? (video.srcObject as MediaStream).id : String(video.videoWidth);
    if (processingRef.current[key]) return;
    if (modelStatus !== "ready") return;
    processingRef.current[key] = true;

    // size canvas to video
    if (canvas.width !== video.videoWidth && video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const t0 = performance.now();

    try {
      const descriptor = await extractDescriptor(video);
      const dt = performance.now() - t0;
      fpsTracker.current[key] = fpsTracker.current[key] ?? { times: [] };
      const times = fpsTracker.current[key].times;
      times.push(dt);
      if (times.length > 12) times.shift();
      const avgMs = times.reduce((a, b) => a + b, 0) / times.length;
      const fps = 1000 / Math.max(avgMs + 800, 1);
      setFramesTotal((n) => n + 1);

      if (!descriptor) {
        setGridStat((prev) => ({ ...prev, [key]: { fps, frames: (prev[key]?.frames ?? 0) + 1, last: prev[key]?.last ?? null } }));
        return;
      }

      const classId = selectedClassroomId === "all" ? undefined : Number(selectedClassroomId);
      const body: Record<string, unknown> = { faceDescriptor: Array.from(descriptor) };
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
        [key]: { fps, frames: (prev[key]?.frames ?? 0) + 1, last: result },
      }));

      if (!res.ok) {
        playErrorSound();
        return;
      }

      setScanResult(result);

      if (data.sentToReview) {
        playErrorSound();
        toast({ title: "Sent to review queue", description: data.message, variant: "destructive" });
      } else if (data.alreadyMarked) {
        playErrorSound();
      } else {
        playSuccessSound();
        void refetchAttendance();
        void enumerateCameras();
      }
    } catch {
      /* frame skipped */
    } finally {
      processingRef.current[key] = false;
    }
  }, [modelStatus, selectedClassroomId, refetchAttendance, toast, enumerateCameras]);

  // Auto reset scan result banner
  useEffect(() => {
    if (!scanResult) return;
    const t = setTimeout(() => setScanResult(null), 4000);
    return () => clearTimeout(t);
  }, [scanResult]);

  // ── QR scanner ──
  const startQr = useCallback(async () => {
    setQrScanning(true);
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
              playSuccessSound();
              toast({ title: "QR check-in", description: data.message });
            } else if (data.alreadyMarked) {
              playErrorSound();
              toast({ title: "Already checked in", description: data.message });
            } else {
              playErrorSound();
              toast({ title: "Badge rejected", description: data.message, variant: "destructive" });
            }
            void refetchAttendance();
          } catch (e: any) {
            playErrorSound();
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
        onSuccess: () => { refetchAttendance(); toast({ title: "Attendance marked" }); setManualStudentId(""); },
        onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
      }
    );
  };

  const totalFps = Object.values(gridStat).reduce((acc, s) => acc + s.fps, 0);
  const totalFrames = framesTotal;

  const modelStatusBadge = () => {
    if (modelStatus === "ready") return <span className="text-[10px] st-green flex items-center gap-1"><Brain className="w-3 h-3" /> AI READY</span>;
    if (modelStatus === "loading") return <span className="text-[10px] st-amber flex items-center gap-1 animate-pulse"><Loader2 className="w-3 h-3 animate-spin" /> LOADING AI…</span>;
    if (modelStatus === "error") return <span className="text-[10px] st-red flex items-center gap-1"><XCircle className="w-3 h-3" /> AI ERROR</span>;
    return <span className="text-[10px] text-white/40 flex items-center gap-1"><Brain className="w-3 h-3" /> AI IDLE</span>;
  };

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <SectionTitle sub="REALTIME AI FACE + QR ATTENDANCE">
            ACTIVE SCAN
          </SectionTitle>
          <div className="w-full sm:w-56">
            <select
              value={selectedClassroomId}
              onChange={(e) => setSelectedClassroomId(e.target.value)}
              className="w-full bg-black/40 border border-purple-500/15 rounded-lg px-3 py-2 text-sm text-white/70 focus:outline-none focus:border-purple-500/45"
            >
              <option value="all">All Classrooms</option>
              {classrooms?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* LEFT: tabs + camera grid */}
          <div className="lg:col-span-8 flex flex-col gap-3">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-black/30 border border-white/5 w-fit">
              {([
                { id: "face", label: "Face", icon: ScanFace },
                { id: "qr", label: "QR", icon: QrCode },
                { id: "manual", label: "Manual", icon: Keyboard },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                    tab === t.id ? "bg-purple-600/30 text-purple-200 shadow-[0_0_12px_rgba(155,91,255,0.25)]" : "text-white/40 hover:text-white/70"
                  }`}
                >
                  <t.icon size={13} /> {t.label}
                </button>
              ))}
              <div className="ml-2 px-3 py-1.5 rounded-lg bg-black/40 border border-white/5 flex items-center gap-2">
                <Activity size={11} className="text-emerald-400" />
                <span className="text-[10px] font-mono text-emerald-300">{totalFps.toFixed(1)} FPS</span>
                <span className="text-[10px] font-mono text-white/30">· {totalFrames} frames</span>
              </div>
            </div>

            {/* ── FACE TAB ── */}
            {tab === "face" && (
              <div className="space-y-3">
                {/* camera controls */}
                <GlowCard className="p-3 flex flex-wrap items-center gap-2">
                  <Layers size={13} className="text-purple-400" />
                  <span className="text-[10px] uppercase tracking-widest text-white/35">cameras</span>
                  <button
                    onClick={() => toggleCam("default")}
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
                      onClick={() => toggleCam(c.deviceId)}
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
                      onClick={() => setAutoMode(true)}
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
                        onCapture={autoMode ? doCapture : () => {}}
                        frameStat={stat}
                        facing={primaryFacing}
                      />
                    );
                  })}
                </div>

                {/* manual scan button */}
                {!autoMode && (
                  <button
                    className="py-3 rounded-xl text-sm font-semibold text-white transition-all"
                    style={{ background: "linear-gradient(135deg,#7C3AED,#9B5BFF)", boxShadow: "0 0 18px rgba(124,58,237,0.35)" }}
                    onClick={() => {
                      const first = document.querySelector<HTMLVideoElement>("video");
                      const cv = document.querySelector<HTMLCanvasElement>("canvas");
                      if (first && cv) void doCapture(first, cv);
                    }}
                    disabled={modelStatus !== "ready"}
                  >
                    <ScanFace size={14} className="inline mr-2" /> Scan now
                  </button>
                )}

                {modelStatus === "loading" && (
                  <GlowCard className="px-4 py-3">
                    <div className="w-full bg-white/5 rounded-full h-1 overflow-hidden">
                      <div className="h-full bg-purple-500 animate-pulse rounded-full w-3/4" />
                    </div>
                    <p className="text-[10px] text-white/40 mt-2 text-center">Loading AI face recognition models…</p>
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
                        <p className="font-semibold leading-tight text-white/85">{scanResult.studentName ?? (scanResult.error ?? "Not recognized")}</p>
                        <p className="text-xs text-white/50 mt-0.5">
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
                          <p className="text-[10px] text-white/35 mt-1">
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
              <GlowCard className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-white/70 flex items-center gap-2">
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
                      className="flex-1 bg-black/40 border border-cyan-500/15 rounded-lg px-3 py-2 text-xs font-mono text-white/80 focus:outline-none focus:border-cyan-500/45"
                    />
                    <button
                      className="st-badge st-badge-purple px-4"
                      onClick={async () => {
                        if (!qrCode.trim()) return;
                        try {
                          const data = await api.qrScan(qrCode.trim(), "web");
                          if (data.result === "valid" && !data.alreadyMarked) playSuccessSound();
                          else playErrorSound();
                          toast({
                            title: data.alreadyMarked ? "Already checked in" : data.result === "valid" ? "QR check-in" : "Badge rejected",
                            description: data.message,
                            variant: data.result === "valid" && !data.alreadyMarked ? "default" : "destructive",
                          });
                          setQrCode("");
                          void refetchAttendance();
                        } catch (e: any) {
                          playErrorSound();
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
              <GlowCard className="p-5">
                <span className="text-sm text-white/70 flex items-center gap-2 mb-4">
                  <Keyboard size={15} className="text-purple-400" /> Manual entry
                </span>
                <form onSubmit={handleManualSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs text-white/50">Student system ID</label>
                    <Input
                      placeholder="e.g. 1"
                      value={manualStudentId}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setManualStudentId(e.target.value)}
                      className="bg-black/30 border-purple-500/15 text-white/80"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-white/50">Status</label>
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
                    className="w-full py-2.5 rounded-xl text-sm font-semibold text-white"
                    style={{ background: "linear-gradient(135deg,#7C3AED,#9B5BFF)" }}
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
            <GlowCard className="p-5 h-full flex flex-col" style={{ minHeight: 420 }}>
              <div className="flex items-center justify-between mb-4 shrink-0">
                <div className="flex items-center gap-2">
                  <StatusDot tone="green" pulse />
                  <span className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">TODAY'S STREAM</span>
                </div>
                <Badge variant="outline" className="font-mono text-xs text-white/40 border-white/10">
                  {todayAttendance?.length ?? 0} REC
                </Badge>
              </div>
              <div className="flex-1 overflow-hidden">
                {attendanceLoading ? (
                  <FeedSkeletonRow rows={6} />
                ) : !todayAttendance?.length ? (
                  <GlowEmpty icon={<Clock size={22} />} title="No records yet" hint="Start scanning to populate the feed." />
                ) : (
                  <div className="overflow-y-auto h-full pr-1 space-y-1.5">
                    {todayAttendance.map((log) => (
                      <motion.div
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        key={log.id}
                        className="flex items-center justify-between p-2.5 rounded-lg border border-white/5 bg-white/[0.02] hover:bg-purple-500/5 transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-xs font-bold text-purple-300 shrink-0">
                            {log.studentName.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-xs text-white/80 truncate">{log.studentName}</p>
                            <p className="text-[10px] text-white/30 truncate">{log.classroomName || "Unassigned"}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-1">
                          <div className="flex flex-col items-end gap-0.5">
                            <StatusBadge value={log.status} />
                            <p className="text-[9px] text-white/30 font-mono">{format(new Date(log.markedAt), "HH:mm:ss")}</p>
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
                  <StatusDot tone="green" pulse /> streaming live…
                </p>
              )}
            </GlowCard>
          </div>
        </div>
      </div>
    </div>
  );
}
