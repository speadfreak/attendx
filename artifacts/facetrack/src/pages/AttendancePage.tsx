import { useState, useRef, useEffect, useCallback } from "react";
import {
  useListClassrooms,
  useGetTodayAttendance,
  useCreateAttendance,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, ScanFace, QrCode, Keyboard, Loader2, CheckCircle2, XCircle, Clock, Brain } from "lucide-react";
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

// ── API call helper ──────────────────────────────────────
const BASE = import.meta.env.BASE_URL ?? "/";
function apiFetch(path: string, opts?: RequestInit) {
  const token = localStorage.getItem("ft_token");
  return fetch(`${BASE}api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...opts?.headers },
  });
}

// ── Main Component ───────────────────────────────────────
export default function AttendancePage() {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processingRef = useRef(false);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [autoMode, setAutoMode] = useState(true);
  const [selectedClassroomId, setSelectedClassroomId] = useState<string>("all");
  const [modelStatus, setModelStatus] = useState<LoadStatus>("idle");
  const [scanResult, setScanResult] = useState<{
    success: boolean;
    studentName?: string;
    status?: string;
    confidence?: number;
    message?: string;
  } | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [manualStudentId, setManualStudentId] = useState("");
  const [manualStatus, setManualStatus] = useState("present");

  const { data: classrooms } = useListClassrooms();
  const { data: todayAttendance, isLoading: attendanceLoading, refetch: refetchAttendance } = useGetTodayAttendance(
    { classroomId: selectedClassroomId === "all" ? undefined : Number(selectedClassroomId) },
    { query: { refetchInterval: 5000 } }
  );
  const createAttendance = useCreateAttendance();

  // Load AI models
  useEffect(() => {
    const unsub = onLoadStatusChange(setModelStatus);
    loadModels().catch(() => {});
    return unsub;
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(false);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = s;
      if (videoRef.current) { videoRef.current.srcObject = s; }
      setCameraReady(true);
    } catch {
      setCameraError(true);
      toast({ title: "Camera Error", description: "Could not access camera.", variant: "destructive" });
    }
  }, [toast]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraReady(false);
  }, []);

  useEffect(() => {
    startCamera();
    return () => { stopCamera(); };
  }, []);

  const doScan = useCallback(async () => {
    if (processingRef.current) return;
    if (!streamRef.current || !videoRef.current) return;
    if (videoRef.current.readyState < 2) return;
    if (modelStatus !== "ready") return;

    processingRef.current = true;
    setIsScanning(true);
    setScanResult(null);

    try {
      const descriptor = await extractDescriptor(videoRef.current);

      if (!descriptor) {
        setScanResult({ success: false, message: "No face detected in frame. Position face clearly." });
        playErrorSound();
        return;
      }

      const classId = selectedClassroomId === "all" ? undefined : Number(selectedClassroomId);
      const body: Record<string, unknown> = { faceDescriptor: Array.from(descriptor) };
      if (classId) body.classroomId = classId;

      const res = await apiFetch("/face/recognize", { method: "POST", body: JSON.stringify(body) });
      const data = await res.json();

      if (!res.ok) {
        setScanResult({ success: false, message: data.error || "Face not recognized." });
        playErrorSound();
        return;
      }

      setScanResult({
        success: true,
        studentName: data.studentName,
        status: data.alreadyMarked ? "already marked" : data.status,
        confidence: data.confidence,
        message: data.alreadyMarked
          ? `${data.studentName} is already marked today.`
          : `Marked ${data.studentName} as ${data.status}.`,
      });

      if (!data.alreadyMarked) {
        playSuccessSound();
        refetchAttendance();
      }
    } catch (err: any) {
      setScanResult({ success: false, message: err?.message || "Recognition failed." });
      playErrorSound();
    } finally {
      setIsScanning(false);
      processingRef.current = false;
    }
  }, [modelStatus, selectedClassroomId, refetchAttendance]);

  // Auto-scan every 3 seconds
  useEffect(() => {
    if (autoTimerRef.current) clearInterval(autoTimerRef.current);
    if (autoMode && cameraReady && modelStatus === "ready") {
      autoTimerRef.current = setInterval(doScan, 3000);
    }
    return () => { if (autoTimerRef.current) clearInterval(autoTimerRef.current); };
  }, [autoMode, cameraReady, modelStatus, doScan]);

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

  const getStatusBadge = (s: string) => {
    const map: Record<string, string> = { present: "bg-emerald-500/20 text-emerald-400 border-emerald-500/20", late: "bg-amber-500/20 text-amber-400 border-amber-500/20", absent: "bg-red-500/20 text-red-400 border-red-500/20" };
    return <Badge className={`${map[s] ?? ""} uppercase text-[10px]`}>{s}</Badge>;
  };

  const getMethodBadge = (m: string) => {
    const cls: Record<string, string> = { face: "bg-cyan-500/20 text-cyan-400", qr: "bg-blue-500/20 text-blue-400", manual: "bg-slate-500/20 text-slate-400" };
    return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls[m] ?? "bg-muted"} uppercase font-medium`}>{m}</span>;
  };

  const modelStatusBadge = () => {
    if (modelStatus === "ready") return <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Brain className="w-3 h-3" /> AI Ready</span>;
    if (modelStatus === "loading") return <span className="text-[10px] text-amber-400 flex items-center gap-1 animate-pulse"><Loader2 className="w-3 h-3 animate-spin" /> Loading AI...</span>;
    if (modelStatus === "error") return <span className="text-[10px] text-red-400 flex items-center gap-1"><XCircle className="w-3 h-3" /> AI Error</span>;
    return <span className="text-[10px] text-muted-foreground flex items-center gap-1"><Brain className="w-3 h-3" /> AI Idle</span>;
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Active Scan</h1>
          <p className="text-muted-foreground text-sm">Real-time AI face recognition attendance</p>
        </div>
        <div className="w-full sm:w-56">
          <Select value={selectedClassroomId} onValueChange={setSelectedClassroomId}>
            <SelectTrigger><SelectValue placeholder="All Classrooms" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Classrooms</SelectItem>
              {classrooms?.map((c) => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* LEFT: Camera + Controls */}
        <div className="lg:col-span-5 flex flex-col gap-3">
          <Tabs defaultValue="face" className="flex flex-col">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="face"><ScanFace className="w-3.5 h-3.5 mr-1" />Face</TabsTrigger>
              <TabsTrigger value="qr"><QrCode className="w-3.5 h-3.5 mr-1" />QR</TabsTrigger>
              <TabsTrigger value="manual"><Keyboard className="w-3.5 h-3.5 mr-1" />Manual</TabsTrigger>
            </TabsList>

            {/* ── FACE TAB ── */}
            <TabsContent value="face" className="mt-3">
              <Card className="bg-card border-border overflow-hidden">
                {/* Camera */}
                <div className="relative bg-black w-full overflow-hidden" style={{ aspectRatio: "4/3" }}>
                  <video
                    ref={videoRef}
                    autoPlay playsInline muted
                    className="w-full h-full object-cover"
                    style={{ transform: "scaleX(-1)", display: cameraReady ? "block" : "none" }}
                    onCanPlay={() => setCameraReady(true)}
                  />

                  {/* Loading state */}
                  {!cameraReady && !cameraError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0a0f1a] gap-3">
                      <Loader2 className="w-10 h-10 animate-spin text-primary" />
                      <p className="text-sm text-muted-foreground">Starting camera...</p>
                    </div>
                  )}
                  {cameraError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0a0f1a] gap-3 px-6 text-center">
                      <Camera className="w-12 h-12 opacity-30 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">Camera unavailable</p>
                      <Button size="sm" variant="outline" onClick={startCamera}>Retry</Button>
                    </div>
                  )}

                  {/* Scan frame corners */}
                  {cameraReady && (
                    <>
                      <div className="absolute top-3 left-3 w-8 h-8 border-t-2 border-l-2 border-primary rounded-tl" />
                      <div className="absolute top-3 right-3 w-8 h-8 border-t-2 border-r-2 border-primary rounded-tr" />
                      <div className="absolute bottom-3 left-3 w-8 h-8 border-b-2 border-l-2 border-primary rounded-bl" />
                      <div className="absolute bottom-3 right-3 w-8 h-8 border-b-2 border-r-2 border-primary rounded-br" />

                      {/* Centre guide oval */}
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className="w-36 h-44 rounded-full border-2 border-primary/30" />
                      </div>
                    </>
                  )}

                  {/* Scan sweep */}
                  {isScanning && cameraReady && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden">
                      <div className="absolute inset-0 bg-primary/8 animate-pulse" />
                      <div
                        className="absolute left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent shadow-[0_0_12px_hsl(var(--primary))]"
                        style={{ animation: "scanSweep 1.5s ease-in-out infinite", top: "30%" }}
                      />
                    </div>
                  )}

                  {/* Status badges */}
                  {cameraReady && (
                    <div className="absolute top-2 left-2 flex flex-col gap-1">
                      <div className="bg-black/70 rounded-full px-2.5 py-1 flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${autoMode ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
                        <span className="text-[10px] font-mono text-white/80">{autoMode ? "AUTO · 3s" : "MANUAL"}</span>
                      </div>
                      <div className="bg-black/70 rounded-full px-2.5 py-1">
                        {modelStatusBadge()}
                      </div>
                    </div>
                  )}
                </div>

                {/* Result */}
                <AnimatePresence mode="wait">
                  {scanResult && (
                    <motion.div
                      key={scanResult.message}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className={`mx-3 mt-3 flex items-start gap-2 p-3 rounded-lg border text-sm ${
                        scanResult.success
                          ? scanResult.status === "already marked"
                            ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
                            : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                          : "bg-red-500/10 border-red-500/20 text-red-400"
                      }`}
                    >
                      {scanResult.success ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                      <div>
                        <p className="font-semibold leading-tight">{scanResult.studentName || (scanResult.success ? "Success" : "Not Recognized")}</p>
                        <p className="text-xs opacity-80 mt-0.5">{scanResult.message}</p>
                        {scanResult.confidence != null && (
                          <p className="text-[10px] opacity-60 mt-0.5">Confidence: {(scanResult.confidence * 100).toFixed(1)}%</p>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Controls */}
                <div className="p-3 flex gap-2">
                  <Button size="sm" variant={autoMode ? "default" : "outline"} className="flex-1 text-xs" onClick={() => setAutoMode(true)}>
                    Auto (3s)
                  </Button>
                  <Button size="sm" variant={!autoMode ? "default" : "outline"} className="flex-1 text-xs" onClick={() => setAutoMode(false)}>
                    Manual
                  </Button>
                  {!autoMode && (
                    <Button
                      size="sm"
                      className="flex-1 text-xs bg-primary text-primary-foreground"
                      onClick={doScan}
                      disabled={!cameraReady || isScanning || modelStatus !== "ready"}
                    >
                      {isScanning ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <ScanFace className="w-3.5 h-3.5 mr-1" />}
                      Scan
                    </Button>
                  )}
                </div>

                {modelStatus === "loading" && (
                  <div className="px-3 pb-3">
                    <div className="w-full bg-muted rounded-full h-1 overflow-hidden">
                      <div className="h-full bg-primary animate-pulse rounded-full w-3/4" />
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1 text-center">Loading AI face recognition models...</p>
                  </div>
                )}
              </Card>
            </TabsContent>

            {/* ── QR TAB ── */}
            <TabsContent value="qr" className="mt-3">
              <Card className="bg-card border-border">
                <CardHeader><CardTitle className="text-base">QR Code Scanner</CardTitle></CardHeader>
                <CardContent>
                  <div className="flex flex-col items-center py-10 border-2 border-dashed border-border rounded-xl gap-4 text-center">
                    <QrCode className="w-14 h-14 text-muted-foreground/30" />
                    <Input
                      placeholder="Focus here and scan..."
                      className="max-w-[240px] text-center"
                      value={qrCode}
                      onChange={(e) => setQrCode(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground max-w-[220px]">Aim QR scanner at student ID card. Submits automatically.</p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── MANUAL TAB ── */}
            <TabsContent value="manual" className="mt-3">
              <Card className="bg-card border-border">
                <CardHeader><CardTitle className="text-base">Manual Entry</CardTitle></CardHeader>
                <CardContent>
                  <form onSubmit={handleManualSubmit} className="space-y-4">
                    <div className="space-y-2">
                      <Label>Student ID</Label>
                      <Input placeholder="Enter system ID" value={manualStudentId} onChange={(e) => setManualStudentId(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Status</Label>
                      <Select value={manualStatus} onValueChange={setManualStatus}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="present">Present</SelectItem>
                          <SelectItem value="late">Late</SelectItem>
                          <SelectItem value="absent">Absent</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button type="submit" className="w-full" disabled={createAttendance.isPending || !manualStudentId}>
                      {createAttendance.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                      Submit Record
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        {/* RIGHT: Live Feed */}
        <div className="lg:col-span-7">
          <Card className="bg-card border-border h-full flex flex-col" style={{ minHeight: 420 }}>
            <CardHeader className="shrink-0 pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  Today's Live Stream
                </CardTitle>
                <Badge variant="outline" className="font-mono text-xs text-muted-foreground">
                  {todayAttendance?.length ?? 0} RECORDS
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-0 relative">
              {attendanceLoading ? (
                <div className="p-4 space-y-3">{Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : !todayAttendance?.length ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
                  <Clock className="w-10 h-10 mb-3 opacity-20 text-muted-foreground" />
                  <p className="font-medium text-foreground">No records yet</p>
                  <p className="text-sm text-muted-foreground">Start scanning to populate the feed.</p>
                </div>
              ) : (
                <div className="overflow-y-auto h-full px-4 pb-4 space-y-2">
                  {todayAttendance.map((log) => (
                    <motion.div
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      key={log.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-card/50 hover:bg-muted/20 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center border border-border text-sm font-bold shrink-0">
                          {log.studentName.charAt(0)}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{log.studentName}</p>
                          <p className="text-xs text-muted-foreground truncate">{log.classroomName || "Unassigned"}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <div className="flex flex-col items-end gap-0.5">
                          {getStatusBadge(log.status)}
                          <p className="text-[10px] text-muted-foreground font-mono">{format(new Date(log.markedAt), "HH:mm:ss")}</p>
                        </div>
                        {getMethodBadge(log.method)}
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <style>{`
        @keyframes scanSweep {
          0% { top: 20%; opacity: 0; }
          20% { opacity: 1; }
          80% { opacity: 1; }
          100% { top: 80%; opacity: 0; }
        }
      `}</style>
    </motion.div>
  );
}
