import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  useListStudents,
  useListClassrooms,
  useCreateStudent,
  useUpdateStudent,
  useDeleteStudent,
} from "@workspace/api-client-react";
import { api, type StudentSummary, type QrIssueResult } from "@/lib/api";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Plus, UserCircle, QrCode, MoreHorizontal, Pencil, Trash2,
  Scan, Camera, Loader2, CheckCircle2, Brain, Upload, FileSpreadsheet, MapPin,
  Flame, TrendingUp, MessageSquare, Printer, RotateCcw, Ban, X,
  Fingerprint, IdCard, Users, Download, Sparkles,
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { loadModels, extractDescriptor } from "@/lib/faceApi";
import { GlowCard, SectionTitle, StatusBadge, StatusDot, MeshBackground, GlowEmpty } from "@/components/gx/Primitives";
import { TableSkeleton, GlowSkeleton } from "@/components/gx/Skeletons";
import { CalendarHeatmap } from "@/components/gx/CalendarHeatmap";
import { QRCodeSVG } from "qrcode.react";
import { format } from "date-fns";

type Student = {
  id: number;
  name: string;
  studentId: string;
  parentPhone: string;
  classroomId?: number | null;
  classroomName?: string | null;
  hasFaceEncoding?: boolean;
  hasActiveQr?: boolean;
  qrCode?: string | null;
};

const BASE = import.meta.env.BASE_URL ?? "/";
function apiFetch(path: string, opts?: RequestInit) {
  const token = localStorage.getItem("ft_token");
  return fetch(`${BASE}api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...opts?.headers },
  });
}

// ─────────────────────────────────────────────────────────────
// Face Capture Dialog
// ─────────────────────────────────────────────────────────────
function FaceCaptureDialog({ student, onClose }: { student: Student; onClose: () => void }) {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [capturedDataUrl, setCapturedDataUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [faceFound, setFaceFound] = useState<boolean | null>(null);

  const startCam = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 } } });
      streamRef.current = s;
      if (videoRef.current) videoRef.current.srcObject = s;
    } catch {
      toast({ title: "Camera Error", description: "Cannot access camera.", variant: "destructive" });
    }
  }, [toast]);

  const stopCam = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    startCam();
    loadModels().catch(() => {});
    return () => stopCam();
  }, [startCam, stopCam]);

  const capture = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 480;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    const dataUrl = c.toDataURL("image/jpeg", 0.92);
    setCapturedDataUrl(dataUrl);
    setCaptured(true);
    stopCam();

    setAiLoading(true);
    try {
      const img = new Image();
      img.src = dataUrl;
      await new Promise((r) => { img.onload = r; });
      const desc = await extractDescriptor(img as any);
      setFaceFound(desc !== null);
      if (!desc) toast({ title: "No face detected", description: "Retake photo with face clearly visible.", variant: "destructive" });
    } catch {
      setFaceFound(null);
    } finally {
      setAiLoading(false);
    }
  };

  const retake = () => {
    setCaptured(false);
    setCapturedDataUrl(null);
    setFaceFound(null);
    startCam();
  };

  const save = async () => {
    if (!capturedDataUrl) return;
    setSaving(true);
    try {
      const img = new Image();
      img.src = capturedDataUrl;
      await new Promise((r) => { img.onload = r; });
      const descriptor = await extractDescriptor(img as any);

      const body: Record<string, unknown> = { studentId: student.id, imageBase64: capturedDataUrl };
      if (descriptor) body.faceDescriptor = Array.from(descriptor);

      const res = await apiFetch("/face/encode", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Failed"); }

      toast({ title: "Face enrolled successfully", description: `${student.name}'s face is registered.` });
      onClose();
    } catch (err: any) {
      toast({ title: "Failed to enroll face", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) { stopCam(); onClose(); } }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Enroll Face — {student.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="relative bg-black rounded-xl overflow-hidden" style={{ aspectRatio: "4/3" }}>
            {!captured ? (
              <>
                <video ref={videoRef} autoPlay playsInline muted
                  onCanPlay={() => setCameraReady(true)}
                  className="w-full h-full object-cover"
                  style={{ transform: "scaleX(-1)", display: cameraReady ? "block" : "none" }}
                />
                {!cameraReady && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  </div>
                )}
                {cameraReady && (
                  <>
                    <div className="absolute top-3 left-3 w-7 h-7 border-t-2 border-l-2 border-primary" />
                    <div className="absolute top-3 right-3 w-7 h-7 border-t-2 border-r-2 border-primary" />
                    <div className="absolute bottom-3 left-3 w-7 h-7 border-b-2 border-l-2 border-primary" />
                    <div className="absolute bottom-3 right-3 w-7 h-7 border-b-2 border-r-2 border-primary" />
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="w-32 h-40 rounded-full border-2 border-primary/30" />
                    </div>
                    <p className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[11px] text-white/70 bg-black/60 px-3 py-1 rounded-full whitespace-nowrap">
                      Centre face in oval
                    </p>
                  </>
                )}
              </>
            ) : (
              <>
                {capturedDataUrl && (
                  <img src={capturedDataUrl} alt="captured face" className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
                )}
                <div className="absolute inset-0 flex items-center justify-center">
                  {aiLoading ? (
                    <div className="bg-black/70 rounded-full p-4"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
                  ) : faceFound === true ? (
                    <div className="bg-emerald-500/90 rounded-full p-3"><CheckCircle2 className="w-8 h-8 text-white" /></div>
                  ) : faceFound === false ? (
                    <div className="bg-red-500/90 rounded-full p-3"><UserCircle className="w-8 h-8 text-white" /></div>
                  ) : null}
                </div>
                {faceFound !== null && !aiLoading && (
                  <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[11px] font-medium whitespace-nowrap ${faceFound ? "bg-emerald-500/90 text-white" : "bg-red-500/90 text-white"}`}>
                    {faceFound ? "Face detected — AI descriptor ready" : "No face found — retake photo"}
                  </div>
                )}
              </>
            )}
          </div>
          <canvas ref={canvasRef} className="hidden" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Brain className="w-3.5 h-3.5 text-primary" />
            Face-API AI extracts a unique 128-point face descriptor for accurate recognition.
          </div>
          <div className="flex gap-2">
            {!captured ? (
              <Button className="flex-1" onClick={capture} disabled={!cameraReady}>
                <Camera className="w-4 h-4 mr-2" /> Capture Photo
              </Button>
            ) : (
              <>
                <Button variant="outline" className="flex-1" onClick={retake} disabled={saving}>Retake</Button>
                <Button className="flex-1" onClick={save} disabled={saving || aiLoading || faceFound === false}>
                  {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Scan className="w-4 h-4 mr-2" />}
                  {saving ? "Saving..." : "Save Face Data"}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────
// Add / Edit Student Dialog
// ─────────────────────────────────────────────────────────────
function StudentFormDialog({
  student, classrooms, onClose, onSaved,
}: {
  student?: Student;
  classrooms: { id: number; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const isEdit = !!student;

  const [name, setName] = useState(student?.name ?? "");
  const [studentId, setStudentId] = useState(student?.studentId ?? "");
  const [parentPhone, setParentPhone] = useState(student?.parentPhone ?? "");
  const [classroomId, setClassroomId] = useState(student?.classroomId?.toString() ?? "none");

  const createStudent = useCreateStudent();
  const updateStudent = useUpdateStudent();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      name,
      studentId,
      parentPhone,
      classroomId: classroomId && classroomId !== "none" ? Number(classroomId) : undefined,
    };
    if (isEdit && student) {
      updateStudent.mutate(
        { id: student.id, data: payload },
        {
          onSuccess: () => { toast({ title: "Student updated" }); onSaved(); onClose(); },
          onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
        }
      );
    } else {
      createStudent.mutate(
        { data: payload },
        {
          onSuccess: () => { toast({ title: "Student enrolled" }); onSaved(); onClose(); },
          onError: (err: any) => toast({ title: "Failed to add student", description: err.message, variant: "destructive" }),
        }
      );
    }
  };

  const isPending = createStudent.isPending || updateStudent.isPending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Student" : "Enroll New Student"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Full Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Abebe Girma" />
          </div>
          <div className="space-y-2">
            <Label>Student ID Number</Label>
            <Input value={studentId} onChange={(e) => setStudentId(e.target.value)} required placeholder="e.g. STU-001" />
          </div>
          <div className="space-y-2">
            <Label>Parent / Guardian Phone</Label>
            <Input value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} placeholder="+251..." required />
          </div>
          <div className="space-y-2">
            <Label>Classroom Assignment</Label>
            <Select value={classroomId} onValueChange={setClassroomId}>
              <SelectTrigger><SelectValue placeholder="Select classroom (optional)" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Classroom</SelectItem>
                {classrooms.map((c) => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="pt-2 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {isEdit ? "Save Changes" : "Enroll Student"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────
// Student Detail Drawer — heatmap, streaks, confidence, SMS, QR
// ─────────────────────────────────────────────────────────────
function StudentDetailDrawer({
  student, onClose, onChanged,
}: {
  student: Student;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [issueQr, setIssueQr] = useState<QrIssueResult | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: summary, isLoading, refetch } = useQuery<StudentSummary>({
    queryKey: ["student-summary", student.id],
    queryFn: () => api.studentSummary(student.id),
  });

  const issueBadge = async () => {
    setBusy(true);
    try {
      const result = await api.qrIssue([student.id], null, "id-card");
      setIssueQr(result.issued[0] ?? null);
      toast({ title: "QR badge issued", description: result.issued[0]?.serial });
      void refetch();
      onChanged();
    } catch (e: any) {
      toast({ title: "Failed to issue badge", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const rotateBadge = async () => {
    setBusy(true);
    try {
      const issued = await api.qrRotate(student.id);
      setIssueQr(issued);
      toast({ title: "Badge rotated", description: `${issued.serial} — older prints invalid.` });
      void refetch();
      onChanged();
    } catch (e: any) {
      toast({ title: "Rotate failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const trend = summary?.confidenceTrend ?? [];
  const sparkPoints = trend.map((t, i) => `${(i / Math.max(1, trend.length - 1)) * 100},${34 - t.confidence * 30}`).join(" ");

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ x: 520 }}
        animate={{ x: 0 }}
        exit={{ x: 520 }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
        className="fixed right-0 top-0 bottom-0 z-50 w-full sm:w-[520px] overflow-y-auto"
        style={{
          background: "linear-gradient(180deg, #0d0515 0%, #080510 100%)",
          borderLeft: "1px solid rgba(155,91,255,0.2)",
          boxShadow: "-20px 0 60px rgba(90,30,180,0.25)",
        }}
      >
        <div className="sticky top-0 z-10 px-5 py-4 border-b border-white/5 flex items-center justify-between"
          style={{ background: "rgba(8,5,16,0.95)", backdropFilter: "blur(12px)" }}>
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
              style={{ background: "linear-gradient(135deg,#7C3AED55,#9B5BFF33)", border: "1px solid rgba(155,91,255,0.25)" }}
            >
              {student.name.charAt(0)}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white/85 truncate">{student.name}</p>
              <p className="text-[10px] text-white/35 font-mono">{student.studentId} · {student.classroomName ?? "no classroom"}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-white/40 hover:text-white/80 hover:bg-purple-500/10">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {isLoading || !summary ? (
            <>
              <GlowSkeleton className="h-28" />
              <GlowSkeleton className="h-24" />
              <GlowSkeleton className="h-40" />
            </>
          ) : (
            <>
              {/* ── Streaks + stats ── */}
              <div className="grid grid-cols-4 gap-2">
                <GlowCard className="p-3 text-center">
                  <Flame size={14} className="mx-auto text-amber-400" />
                  <p className="counter-num text-xl mt-1 gx-gradient-text">{summary.streaks.current}</p>
                  <p className="text-[8px] uppercase tracking-widest text-white/30">streak</p>
                </GlowCard>
                <GlowCard className="p-3 text-center">
                  <TrendingUp size={14} className="mx-auto text-emerald-400" />
                  <p className="counter-num text-xl mt-1 gx-gradient-text">{summary.streaks.longest}</p>
                  <p className="text-[8px] uppercase tracking-widest text-white/30">best</p>
                </GlowCard>
                <GlowCard className="p-3 text-center">
                  <CheckCircle2 size={14} className="mx-auto text-emerald-400" />
                  <p className="counter-num text-xl mt-1 gx-gradient-text">{summary.stats.present}</p>
                  <p className="text-[8px] uppercase tracking-widest text-white/30">present</p>
                </GlowCard>
                <GlowCard className="p-3 text-center">
                  <span className="counter-num text-xl gx-gradient-text block mt-4">{summary.stats.rate != null ? `${Math.round(summary.stats.rate * 100)}%` : "—"}</span>
                  <p className="text-[8px] uppercase tracking-widest text-white/30">rate</p>
                </GlowCard>
              </div>

              {/* streak motivator */}
              {summary.streaks.current >= 3 && (
                <div className="rounded-xl px-4 py-3 flex items-center gap-3"
                  style={{ background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.2)" }}>
                  <Flame size={16} className="text-amber-400" />
                  <p className="text-xs text-amber-300/90">
                    <strong>{summary.streaks.current}-day streak!</strong> Consistent attendance builds strong habits — keep celebrating it.
                  </p>
                </div>
              )}

              {/* ── Calendar heatmap ── */}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-white/35 mb-2">ATTENDANCE HEATMAP · LAST 90 DAYS</p>
                <GlowCard className="p-4">
                  <CalendarHeatmap days={summary.heatmap} weeks={13} />
                </GlowCard>
              </div>

              {/* ── Confidence trend ── */}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-white/35 mb-2">FACE MATCH CONFIDENCE TREND</p>
                <GlowCard className="p-4">
                  {trend.length === 0 ? (
                    <p className="text-xs text-white/30 italic py-3">No camera matches recorded yet.</p>
                  ) : (
                    <div className="flex items-center gap-3">
                      <svg viewBox="0 0 100 40" className="flex-1 h-16" preserveAspectRatio="none">
                        <polyline points={sparkPoints} fill="none" stroke="rgb(155,91,255)" strokeWidth="1.5" strokeLinejoin="round" />
                        {trend.map((t, i) => (
                          <circle
                            key={i}
                            cx={(i / Math.max(1, trend.length - 1)) * 100}
                            cy={34 - t.confidence * 30}
                            r="1.4"
                            fill={t.confidence >= 0.72 ? "rgb(34,197,94)" : "rgb(245,158,11)"}
                          />
                        ))}
                      </svg>
                      <div className="text-right">
                        <p className="counter-num text-lg gx-gradient-text">
                          {Math.round((trend[trend.length - 1]?.confidence ?? 0) * 100)}%
                        </p>
                        <p className="text-[9px] text-white/30">latest match</p>
                      </div>
                    </div>
                  )}
                </GlowCard>
              </div>

              {/* ── Identity methods ── */}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-white/35 mb-2">IDENTITY METHODS</p>
                <GlowCard className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-xs text-white/60">
                      <Scan size={13} className={summary.student.hasFaceEncoding ? "text-purple-400" : "text-white/25"} />
                      Face recognition
                    </span>
                    {summary.student.hasFaceEncoding ? <StatusBadge value="valid" label="AI enrolled" tone="purple" /> : <StatusBadge value="no-identity" label="no face" tone="red" />}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-xs text-white/60">
                      <QrCode size={13} className={summary.qr.active ? "text-cyan-400" : "text-white/25"} />
                      QR badge
                    </span>
                    {summary.qr.active ? (
                      <span className="flex items-center gap-2">
                        <span className="text-[9px] font-mono text-white/30">{summary.qr.serial} · {summary.qr.scans} scans</span>
                        <StatusBadge value="valid" label="active" tone="green" />
                      </span>
                    ) : <StatusBadge value="no-identity" label="no badge" tone="red" />}
                  </div>
                  {!summary.student.hasFaceEncoding && !summary.qr.active && (
                    <div className="rounded-lg px-3 py-2 text-[11px] text-red-300 flex items-center gap-2"
                      style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
                      <StatusDot tone="red" pulse /> No identity method set up — this student can't check in automatically.
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {!summary.qr.active ? (
                      <button className="st-badge st-badge-purple px-3 py-1.5" disabled={busy} onClick={issueBadge}>
                        <QrCode size={11} /> Issue QR badge
                      </button>
                    ) : (
                      <>
                        <button className="st-badge st-badge-purple px-3 py-1.5" disabled={busy} onClick={rotateBadge}>
                          <RotateCcw size={11} /> Rotate & reprint
                        </button>
                        {issueQr && (
                          <a className="st-badge st-badge-green px-3 py-1.5" href={`#/qr-manager`} onClick={() => { window.location.hash = ""; }}>
                            <Printer size={11} /> open print sheet
                          </a>
                        )}
                      </>
                    )}
                  </div>
                  {issueQr && (
                    <div className="flex items-center gap-3 rounded-xl p-3 bg-white/[0.03] border border-purple-500/15">
                      <div className="bg-white p-1.5 rounded-lg">
                        <QRCodeSVG value={issueQr.token} size={84} level="M" includeMargin />
                      </div>
                      <div className="min-w-0 text-[10px] text-white/50">
                        <p className="font-mono text-purple-300 mb-0.5">{issueQr.serial}</p>
                        <p>Print this badge (QR Manager → Print sheet) or download the PNG from there.</p>
                      </div>
                    </div>
                  )}
                </GlowCard>
              </div>

              {/* ── Parent contact + SMS history ── */}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-white/35 mb-2">PARENT CONTACT & SMS HISTORY</p>
                <GlowCard className="p-4">
                  <div className="flex items-center gap-2 mb-3 pb-3 border-b border-white/5">
                    <MessageSquare size={13} className="text-cyan-400" />
                    <span className="text-xs text-white/70 font-mono">{summary.student.parentPhone}</span>
                  </div>
                  {summary.sms.length === 0 ? (
                    <p className="text-xs text-white/30 italic py-2">No SMS sent to this parent yet.</p>
                  ) : (
                    <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                      {summary.sms.map((s) => (
                        <div key={s.id} className="rounded-lg p-2.5 bg-white/[0.02] border border-white/5">
                          <div className="flex items-center justify-between mb-1">
                            <StatusBadge value={s.status} tone={s.status === "sent" ? "green" : "red"} />
                            <span className="text-[9px] text-white/25">{format(new Date(s.sentAt), "MMM d · HH:mm")}</span>
                          </div>
                          <p className="text-[11px] text-white/55">{s.message}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </GlowCard>
              </div>

              {/* seat */}
              {summary.seat && (
                <div className="flex items-center gap-2 text-xs text-white/50">
                  <MapPin size={12} className="text-cyan-400" />
                  Assigned seat: <span className="font-mono text-cyan-300">{summary.seat.seatLabel}</span>
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Bulk Enrollment Wizard
// ─────────────────────────────────────────────────────────────
function BulkEnrollWizard({ classrooms, onClose, onDone }: {
  classrooms: { id: number; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [csvText, setCsvText] = useState("");
  const [photos, setPhotos] = useState<Map<string, File>>(new Map());
  const [classroomId, setClassroomId] = useState("none");
  const [issueQr, setIssueQr] = useState(true);
  const [step, setStep] = useState<"input" | "processing" | "done">("input");
  const [progress, setProgress] = useState({ total: 0, done: 0, faces: 0 });
  const [result, setResult] = useState<{ created: number[]; updated: number[]; failed: Array<{ studentId: string; reason: string }>; qrIssued: number } | null>(null);

  const parsedRows = useMemo(() => {
    // CSV: name,student_id,parent_phone,classroom (optional)
    const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows: Array<{ name: string; studentId: string; parentPhone: string; classroomName?: string }> = [];
    for (const line of lines) {
      const parts = line.split(/[,;\t]/).map((p) => p.trim().replace(/^"|"$/g, ""));
      if (parts.length >= 3 && parts[0].toLowerCase() !== "name") {
        rows.push({ name: parts[0], studentId: parts[1], parentPhone: parts[2], classroomName: parts[3] });
      }
    }
    return rows;
  }, [csvText]);

  const matched = useMemo(() => {
    // photo filename (without ext) matched to studentId or name
    return parsedRows.map((row) => {
      const byId = photos.get(row.studentId.toLowerCase());
      const byName = photos.get(row.name.toLowerCase().replace(/\s+/g, ""));
      return { row, photo: byId ?? byName ?? null };
    });
  }, [parsedRows, photos]);

  const run = async () => {
    setStep("processing");
    await loadModels().catch(() => {});
    const rows: Array<Record<string, unknown>> = [];
    const total = matched.length;
    setProgress({ total, done: 0, faces: 0 });

    for (const { row, photo } of matched) {
      const entry: Record<string, unknown> = {
        name: row.name,
        studentId: row.studentId,
        parentPhone: row.parentPhone,
        classroomId: classroomId !== "none" ? Number(classroomId) : row.classroomName
          ? classrooms.find((c) => c.name.toLowerCase() === row.classroomName?.toLowerCase())?.id ?? null
          : null,
        faceDescriptor: null,
        photoDataUrl: null,
      };
      if (photo) {
        try {
          const bitmap = await createImageBitmap(photo);
          const canvas = document.createElement("canvas");
          const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
          canvas.width = Math.round(bitmap.width * scale);
          canvas.height = Math.round(bitmap.height * scale);
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const desc = await extractDescriptor(canvas).catch(() => null);
            if (desc) {
              entry.faceDescriptor = Array.from(desc);
              setProgress((p) => ({ ...p, faces: p.faces + 1 }));
            }
          }
        } catch {
          /* photo unreadable — enroll without descriptor */
        }
      }
      rows.push(entry);
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    try {
      const res = await api.bulkEnroll(rows, issueQr);
      setResult(res);
      setStep("done");
      onDone();
    } catch (e: any) {
      toast({ title: "Bulk enrollment failed", description: e.message, variant: "destructive" });
      setStep("input");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-purple-400" /> Bulk Enrollment
          </DialogTitle>
        </DialogHeader>

        {step === "input" && (
          <div className="space-y-4 pt-2">
            <div className="rounded-xl p-3 bg-purple-500/5 border border-purple-500/15 text-xs text-white/50 space-y-1">
              <p className="flex items-center gap-1.5 text-purple-300"><FileSpreadsheet size={12} /> CSV format: <code>name, student_id, parent_phone, classroom(optional)</code> — one student per line.</p>
              <p className="flex items-center gap-1.5 text-cyan-300"><Scan size={12} /> Photos: filenames are auto-matched to <code>student_id</code> or <code>name</code>. Face descriptors are extracted in-browser by AI.</p>
            </div>

            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              rows={6}
              placeholder={"Abebe Girma, STU-001, +251911000001, Grade 4A\nSara Tesfaye, STU-002, +251911000002, Grade 4A"}
              className="w-full bg-black/40 border border-purple-500/15 rounded-lg p-3 text-xs font-mono text-white/80 focus:outline-none focus:border-purple-500/45"
            />

            <label className="block">
              <span className="text-xs text-white/50 flex items-center gap-2 mb-1.5"><Camera size={12} className="text-cyan-400" /> Student photos (multi-select)</span>
              <input
                type="file"
                multiple
                accept="image/*"
                onChange={(e) => {
                  const map = new Map<string, File>();
                  for (const f of Array.from(e.target.files ?? [])) {
                    map.set(f.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/\s+/g, ""), f);
                  }
                  setPhotos(map);
                }}
                className="w-full bg-black/40 border border-purple-500/15 rounded-lg p-2 text-xs text-white/60 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-purple-500/20 file:text-purple-200"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Default classroom</Label>
                <Select value={classroomId} onValueChange={setClassroomId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">From CSV column / none</SelectItem>
                    {classrooms.map((c) => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Auto-issue QR badges</Label>
                <label className="flex items-center gap-2 text-xs text-white/60 cursor-pointer mt-2">
                  <input type="checkbox" checked={issueQr} onChange={(e) => setIssueQr(e.target.checked)} className="accent-purple-500" />
                  Generate a signed QR badge for each new student
                </label>
              </div>
            </div>

            {parsedRows.length > 0 && (
              <div className="rounded-lg bg-black/30 border border-white/5 p-3 text-xs">
                <p className="text-white/60 mb-2">
                  <Users size={12} className="inline mr-1 text-purple-400" />
                  {parsedRows.length} students parsed · <span className="text-cyan-300">{matched.filter((m) => m.photo).length} photos matched</span>
                </p>
                <div className="max-h-24 overflow-y-auto space-y-0.5">
                  {matched.slice(0, 12).map((m, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px] text-white/40">
                      <span>{m.row.name} <span className="font-mono text-white/25">({m.row.studentId})</span></span>
                      {m.photo ? <span className="text-emerald-400/70 flex items-center gap-1"><CheckCircle2 size={10} /> photo</span> : <span className="text-white/20">no photo</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={run} disabled={!parsedRows.length}>
                <Sparkles className="w-4 h-4 mr-2" /> Enroll {parsedRows.length} students
              </Button>
            </div>
          </div>
        )}

        {step === "processing" && (
          <div className="py-10 space-y-4 text-center">
            <Loader2 className="w-10 h-10 animate-spin text-purple-400 mx-auto" />
            <p className="text-sm text-white/70">Extracting AI face descriptors…</p>
            <div className="w-64 mx-auto h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`, background: "linear-gradient(90deg,#7C3AED,#9B5BFF)" }}
              />
            </div>
            <p className="text-xs text-white/40 font-mono">{progress.done}/{progress.total} processed · {progress.faces} faces found</p>
          </div>
        )}

        {step === "done" && result && (
          <div className="py-6 space-y-4 text-center">
            <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto" />
            <p className="text-lg font-semibold text-white/85">Bulk enrollment complete</p>
            <div className="grid grid-cols-3 gap-3 max-w-sm mx-auto">
              <GlowCard className="p-3">
                <p className="counter-num text-xl text-emerald-400">{result.created.length}</p>
                <p className="text-[9px] uppercase tracking-widest text-white/30">created</p>
              </GlowCard>
              <GlowCard className="p-3">
                <p className="counter-num text-xl text-cyan-400">{result.updated.length}</p>
                <p className="text-[9px] uppercase tracking-widest text-white/30">updated</p>
              </GlowCard>
              <GlowCard className="p-3">
                <p className="counter-num text-xl text-purple-400">{result.qrIssued}</p>
                <p className="text-[9px] uppercase tracking-widest text-white/30">QR issued</p>
              </GlowCard>
            </div>
            {result.failed.length > 0 && (
              <div className="text-left max-w-sm mx-auto rounded-lg bg-red-500/5 border border-red-500/15 p-3">
                <p className="text-xs text-red-300 mb-1">{result.failed.length} failed:</p>
                {result.failed.map((f, i) => (
                  <p key={i} className="text-[10px] text-white/40 font-mono">{f.studentId}: {f.reason}</p>
                ))}
              </div>
            )}
            <Button onClick={onClose}>Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────
export default function StudentsPage() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [classroomFilter, setClassroomFilter] = useState<string>("all");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [faceStudent, setFaceStudent] = useState<Student | null>(null);
  const [drawerStudent, setDrawerStudent] = useState<Student | null>(null);
  const { toast } = useToast();

  const { data: classrooms = [] } = useListClassrooms();
  const { data: students, isLoading, refetch } = useListStudents({
    search: search || undefined,
    classroomId: classroomFilter === "all" ? undefined : Number(classroomFilter),
  });
  const studentRows = ((students ?? []) as unknown as Student[]);

  // Command palette "open student" focus support
  useEffect(() => {
    const focusId = searchParams.get("focus");
    if (focusId && studentRows.length) {
      const target = studentRows.find((s) => s.id === Number(focusId));
      if (target) setDrawerStudent(target);
    }
  }, [searchParams, studentRows]);

  const deleteStudent = useDeleteStudent({
    mutation: {
      onSuccess: () => { refetch(); toast({ title: "Student removed" }); },
      onError: (err: any) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
    },
  });

  const identityStats = useMemo(() => {
    const rows = studentRows;
    const hasQrOf = (s: Student) => !!s.hasActiveQr;
    const noIdentity = rows.filter((s) => !s.hasFaceEncoding && !hasQrOf(s)).length;
    const faceOnly = rows.filter((s) => s.hasFaceEncoding && !hasQrOf(s)).length;
    const qrOnly = rows.filter((s) => !s.hasFaceEncoding && hasQrOf(s)).length;
    const both = rows.filter((s) => s.hasFaceEncoding && hasQrOf(s)).length;
    return { total: rows.length, noIdentity, faceOnly, qrOnly, both };
  }, [studentRows]);

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5">
        <SectionTitle sub="IDENTITIES, HEATMAPS, STREAKS & BADGES">
          STUDENT DATABASE
        </SectionTitle>

        {/* identity coverage strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Total students", value: identityStats.total, icon: Users, tone: "purple" },
            { label: "Face + QR", value: identityStats.both, icon: Fingerprint, tone: "green" },
            { label: "Partial identity", value: identityStats.faceOnly + identityStats.qrOnly, icon: IdCard, tone: "amber" },
            { label: "No identity method", value: identityStats.noIdentity, icon: UserCircle, tone: "red" },
          ].map((s, i) => (
            <GlowCard key={i} className="p-3.5 flex items-center justify-between">
              <div>
                <p className="text-[9px] uppercase tracking-widest text-white/35">{s.label}</p>
                <p className="counter-num text-xl mt-1 gx-gradient-text">{s.value}</p>
              </div>
              <s.icon size={16} className={`st-${s.tone}`} />
            </GlowCard>
          ))}
        </div>

        {/* dialogs */}
        {showAddDialog && (
          <StudentFormDialog classrooms={classrooms} onClose={() => setShowAddDialog(false)} onSaved={() => refetch()} />
        )}
        {editingStudent && (
          <StudentFormDialog student={editingStudent} classrooms={classrooms} onClose={() => setEditingStudent(null)} onSaved={() => refetch()} />
        )}
        {faceStudent && (
          <FaceCaptureDialog student={faceStudent} onClose={() => { setFaceStudent(null); refetch(); }} />
        )}
        {showBulk && (
          <BulkEnrollWizard classrooms={classrooms} onClose={() => setShowBulk(false)} onDone={() => refetch()} />
        )}
        <AnimatePresence>
          {drawerStudent && (
            <StudentDetailDrawer
              key={drawerStudent.id}
              student={drawerStudent}
              onClose={() => setDrawerStudent(null)}
              onChanged={() => refetch()}
            />
          )}
        </AnimatePresence>

        {/* header actions */}
        <div className="flex flex-wrap justify-between gap-3 items-start sm:items-center">
          <div className="flex flex-wrap gap-2">
            <Button className="bg-purple-600 hover:bg-purple-500 text-white" onClick={() => setShowAddDialog(true)}>
              <Plus className="w-4 h-4 mr-2" /> Add Student
            </Button>
            <Button variant="outline" className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10" onClick={() => setShowBulk(true)}>
              <Upload className="w-4 h-4 mr-2" /> Bulk Enrollment
            </Button>
          </div>
        </div>

        <GlowCard>
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between p-4 border-b border-white/5">
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-white/25" />
              <Input
                placeholder="Search students..."
                className="pl-9 bg-black/30 border-purple-500/15 text-white/80"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="w-full sm:w-[200px]">
              <Select value={classroomFilter} onValueChange={setClassroomFilter}>
                <SelectTrigger className="border-purple-500/15 bg-black/30 text-white/80"><SelectValue placeholder="All Classrooms" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Classrooms</SelectItem>
                  {classrooms.map((c) => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/5 hover:bg-transparent">
                    <TableHead className="text-white/40">Student</TableHead>
                    <TableHead className="text-white/40">ID</TableHead>
                    <TableHead className="text-white/40">Classroom</TableHead>
                    <TableHead className="text-white/40">Parent Contact</TableHead>
                    <TableHead className="text-white/40">Identity</TableHead>
                    <TableHead className="text-right text-white/40">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={6} className="p-0"><TableSkeleton rows={5} cols={6} /></TableCell>
                    </TableRow>
                  ) : !students?.length ? (
                    <TableRow>
                      <TableCell colSpan={6}>
                        <GlowEmpty icon={<Users size={24} />} title="No students found" hint="Add a student or run the bulk enrollment wizard." />
                      </TableCell>
                    </TableRow>
                  ) : (
                    studentRows.map((s) => {
                      const hasQr = !!s.hasActiveQr;
                      const noIdentity = !s.hasFaceEncoding && !hasQr;
                      return (
                        <TableRow
                          key={s.id}
                          className="border-white/5 hover:bg-purple-500/5 cursor-pointer transition-colors"
                          onClick={() => setDrawerStudent(s)}
                        >
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-xs font-bold text-purple-300 shrink-0">
                                {s.name.charAt(0)}
                              </div>
                              <span className="truncate max-w-[130px] text-white/85">{s.name}</span>
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-white/40">{s.studentId}</TableCell>
                          <TableCell className="text-sm text-white/60">{s.classroomName || <span className="italic text-white/25">Unassigned</span>}</TableCell>
                          <TableCell className="text-sm text-white/40 font-mono">{s.parentPhone}</TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <div className="flex flex-wrap gap-1">
                              {noIdentity ? (
                                <span className="st-badge st-badge-red" title="No face AND no QR — cannot check in automatically">
                                  <StatusDot tone="red" pulse /> NO IDENTITY
                                </span>
                              ) : (
                                <>
                                  {s.hasFaceEncoding ? (
                                    <span className="st-badge st-badge-purple"><Scan className="w-2.5 h-2.5" /> AI ENROLLED</span>
                                  ) : (
                                    <span className="st-badge st-badge-amber"><UserCircle className="w-2.5 h-2.5" /> NO FACE</span>
                                  )}
                                  {hasQr ? (
                                    <span className="st-badge st-badge-cyan"><QrCode className="w-2.5 h-2.5" /> QR</span>
                                  ) : (
                                    <span className="st-badge st-badge-slate"><QrCode className="w-2.5 h-2.5" /> NO QR</span>
                                  )}
                                </>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-white/40">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="border-purple-500/20">
                                <DropdownMenuItem className="cursor-pointer" onClick={() => setDrawerStudent(s)}>
                                  <IdCard className="w-4 h-4 mr-2 text-purple-400" /> Open details
                                </DropdownMenuItem>
                                <DropdownMenuItem className="cursor-pointer" onClick={() => setFaceStudent(s)}>
                                  <Scan className="w-4 h-4 mr-2 text-purple-400" />
                                  {s.hasFaceEncoding ? "Re-enroll Face" : "Enroll Face"}
                                </DropdownMenuItem>
                                <DropdownMenuItem className="cursor-pointer" onClick={() => setEditingStudent(s)}>
                                  <Pencil className="w-4 h-4 mr-2" /> Edit Student
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="cursor-pointer text-red-400 focus:text-red-400"
                                  onClick={() => {
                                    if (confirm(`Delete ${s.name}? This cannot be undone.`)) {
                                      deleteStudent.mutate({ id: s.id });
                                    }
                                  }}
                                >
                                  <Trash2 className="w-4 h-4 mr-2" /> Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </GlowCard>
      </div>
    </div>
  );
}
