import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  Activity, AlertCircle, Camera, Check, CheckCircle2, ChevronRight, Clipboard,
  Cpu, Fan, Fingerprint, FlaskConical, KeyRound, LoaderCircle, LockKeyhole, Network,
  RefreshCw, RotateCcw, Server, ShieldAlert, ShieldCheck, ShieldX, Thermometer,
  Timer, Trash2, ScrollText, TriangleAlert, Waves, X, XCircle, Zap,
} from "lucide-react";
import {
  getGetDashboardStatsQueryKey,
  getGetConfidenceHeatmapQueryKey,
  getGetPiStatusQueryKey,
  getGetSystemSettingsQueryKey,
  getListAttendanceQueryKey,
  getListAuditLogsQueryKey,
  getListJobsQueryKey,
  getListMatchReviewsQueryKey,
  getPreviewAttendanceClearQueryKey,
  useClearAttendanceRecords,
  useCreatePiAction,
  useDecideMatchReview,
  useGetConfidenceHeatmap,
  useGetPiStatus,
  useKillPiSessions,
  useListJobs,
  useListMatchReviews,
  usePairPiDevice,
  useListAuditLogs,
  usePreviewAttendanceClear,
  useRetryJob,
  useSetFanOverride,
} from "../../../../lib/api-client-react/src/generated/api";
import type { PiPairingResponse } from "../../../../lib/api-client-react/src/generated/api.schemas";
import { api } from "@/lib/api";
import type {
  GateAlertDetail, GateAlertRow, GateSensorEvent, GateSimulateMode, GateVerdict,
} from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SmsHealthCard } from "@/components/SmsHealthCard";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const panel = "rounded-2xl border border-violet-200/10 bg-[#191323] shadow-[0_14px_40px_rgba(18,8,30,0.18)]";
const label = "text-[11px] font-semibold uppercase tracking-[0.15em] text-violet-200/55";
const quiet = "text-sm text-violet-100/55";
const actionClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-violet-200/15 bg-violet-200/[0.06] px-3.5 text-sm font-medium text-violet-50 transition-colors hover:bg-violet-200/[0.12] disabled:pointer-events-none disabled:opacity-45";
const accentAction = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-violet-400 px-3.5 text-sm font-semibold text-[#1b1026] transition-colors hover:bg-violet-300 disabled:pointer-events-none disabled:opacity-45";
const dangerAction = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-rose-300/20 bg-rose-400/10 px-3.5 text-sm font-semibold text-rose-200 transition-colors hover:bg-rose-400/15 disabled:pointer-events-none disabled:opacity-45";
const inputClass = "min-h-10 w-full rounded-lg border border-violet-200/15 bg-[#110d18] px-3 text-sm text-violet-50 outline-none placeholder:text-violet-100/30 focus:border-violet-300/45 focus:ring-2 focus:ring-violet-300/15";

function formatTime(value?: string | null) {
  if (!value) return "Not reported";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function ageLabel(value?: string | null) {
  if (!value) return "No heartbeat received";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `Last heartbeat ${seconds}s ago`;
  if (seconds < 3600) return `Last heartbeat ${Math.floor(seconds / 60)}m ago`;
  return `Last heartbeat ${Math.floor(seconds / 3600)}h ago`;
}

function clockLabel(value: string, withSeconds = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, withSeconds ? "HH:mm:ss" : "HH:mm");
}

function joinList(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function summarizeGateWindow(cameraCount: number, events: GateSensorEvent[]) {
  const parts: string[] = [];
  for (const sensor of ["ultrasonic", "ir_beam"] as const) {
    const times = events
      .filter((event) => event.sensor === sensor)
      .map((event) => `${clockLabel(event.occurredAt, true)}${event.simulated ? " (simulated)" : ""}`);
    if (times.length > 0) {
      parts.push(`${sensor === "ultrasonic" ? "Ultrasonic" : "IR beam"} fired at ${joinList(times)}`);
    }
  }
  const faces = `${cameraCount} face${cameraCount === 1 ? "" : "s"}`;
  return parts.length === 0
    ? `No sensor triggers were recorded — camera matched ${faces} in this window.`
    : `${parts.join("; ")} — camera matched ${faces} in this window.`;
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-rose-300/15 bg-rose-300/[0.06] p-3 text-sm text-rose-100/80" role="alert">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-rose-300" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && <button type="button" className="text-xs font-semibold text-rose-200 underline underline-offset-4" onClick={onRetry}>Retry</button>}
    </div>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-lg bg-violet-100/[0.07] ${className}`} />;
}

function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return (
    <div className="mb-5">
      <p className={label}>{eyebrow}</p>
      <h2 className="mt-1 text-lg font-semibold tracking-tight text-violet-50">{title}</h2>
      {detail && <p className={`mt-1 ${quiet}`}>{detail}</p>}
    </div>
  );
}

export default function OperationsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { admin } = useAuth();
  const canAdmin = admin?.role === "super_admin" || admin?.role === "admin";
  const piQuery = useGetPiStatus({ query: { queryKey: getGetPiStatusQueryKey(), refetchInterval: 15_000 } });
  const jobsQuery = useListJobs({ query: { queryKey: getListJobsQueryKey(), refetchInterval: 20_000 } });
  const reviewsQuery = useListMatchReviews({ query: { queryKey: getListMatchReviewsQueryKey(), refetchInterval: 30_000 } });
  // The generated client predates the attendance time rules; the hand-typed
  // wrapper in lib/api.ts types the full settings payload including the new fields.
  const settingsQuery = useQuery({ queryKey: getGetSystemSettingsQueryKey(), queryFn: api.systemSettings });
  const heatmapQuery = useGetConfidenceHeatmap();
  const auditQuery = useListAuditLogs({ limit: 50 }, { query: { queryKey: getListAuditLogsQueryKey({ limit: 50 }), refetchInterval: 30_000 } });
  const manualClearPreview = usePreviewAttendanceClear({ source: "manual" }, { query: { queryKey: getPreviewAttendanceClearQueryKey({ source: "manual" }), refetchInterval: 30_000 } });
  const automatedClearPreview = usePreviewAttendanceClear({ source: "automated" }, { query: { queryKey: getPreviewAttendanceClearQueryKey({ source: "automated" }), refetchInterval: 30_000 } });
  const gateCurrentQuery = useQuery({ queryKey: ["gate", "current"], queryFn: api.gateCurrent, refetchInterval: 10_000 });
  const gateWindowsQuery = useQuery({ queryKey: ["gate", "windows"], queryFn: () => api.gateWindows(60), refetchInterval: 15_000 });
  const gateAlertsQuery = useQuery({ queryKey: ["gate", "alerts"], queryFn: () => api.gateAlerts(), refetchInterval: 15_000 });
  const clearRecordsMutation = useClearAttendanceRecords();
  const pairMutation = usePairPiDevice();
  const actionMutation = useCreatePiAction();
  const killMutation = useKillPiSessions();
  const retryMutation = useRetryJob();
  const decisionMutation = useDecideMatchReview();
  const settingsMutation = useMutation({ mutationFn: api.updateSystemSettings });
  const fanMutation = useSetFanOverride();
  const gateRunMutation = useMutation({ mutationFn: api.gateRunValidation });
  const gateSimulateMutation = useMutation({ mutationFn: (mode: GateSimulateMode) => api.gateSimulate(mode) });
  const gateResolveMutation = useMutation({ mutationFn: (vars: { id: number; note?: string }) => api.gateResolveAlert(vars.id, vars.note) });

  const [deviceName, setDeviceName] = useState("");
  const [pairing, setPairing] = useState<PiPairingResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [threshold, setThreshold] = useState("");
  const [retention, setRetention] = useState("");
  const [entranceTime, setEntranceTime] = useState("");
  const [lateCutoffTime, setLateCutoffTime] = useState("");
  const [absenceCutoffTime, setAbsenceCutoffTime] = useState("");
  const [attendanceTimezone, setAttendanceTimezone] = useState("");
  const [gateDiscrepancy, setGateDiscrepancy] = useState("");
  const [gateWindow, setGateWindow] = useState("");
  const [gateActiveFrom, setGateActiveFrom] = useState("");
  const [gateActiveTo, setGateActiveTo] = useState("");
  const [feedback, setFeedback] = useState("");
  const [actionFeedback, setActionFeedback] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [selectedAlertId, setSelectedAlertId] = useState<number | null>(null);
  const [resolveNote, setResolveNote] = useState("");
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [simulateMode, setSimulateMode] = useState<GateSimulateMode>("missed_detections");
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const gateDetailQuery = useQuery({
    queryKey: ["gate", "alert", selectedAlertId],
    queryFn: () => api.gateAlertDetail(selectedAlertId as number),
    enabled: selectedAlertId != null,
  });

  useEffect(() => {
    if (!settingsQuery.data) return;
    setThreshold(String(settingsQuery.data.confidenceThreshold));
    setRetention(String(settingsQuery.data.reviewRetentionDays));
    setEntranceTime(settingsQuery.data.entranceTime);
    setLateCutoffTime(settingsQuery.data.lateCutoffTime);
    setAbsenceCutoffTime(settingsQuery.data.absenceCutoffTime);
    setAttendanceTimezone(settingsQuery.data.attendanceTimezone);
    setGateDiscrepancy(String(settingsQuery.data.gateDiscrepancyPct));
    setGateWindow(String(settingsQuery.data.gateWindowSeconds));
    setGateActiveFrom(settingsQuery.data.gateActiveFrom);
    setGateActiveTo(settingsQuery.data.gateActiveTo);
  }, [settingsQuery.data]);

  const device = piQuery.data?.device;
  const pendingReviews = useMemo(
    () => reviewsQuery.data?.filter((review) => review.status === "pending") ?? [],
    [reviewsQuery.data],
  );
  const recentJobs = useMemo(() => jobsQuery.data?.jobs.slice(0, 8) ?? [], [jobsQuery.data]);
  const failedJobs = useMemo(() => jobsQuery.data?.jobs.filter((job) => job.status === "failed") ?? [], [jobsQuery.data]);
  const recentLogJob = useMemo(
    () => jobsQuery.data?.jobs.find((job) => job.payload.action === "recent-logs" && job.result),
    [jobsQuery.data],
  );

  const gate = gateCurrentQuery.data;
  useEffect(() => {
    if (!gate) return;
    setSecondsLeft(gate.partialSecondsLeft);
    const timer = setInterval(() => {
      setSecondsLeft((current) => (current == null ? null : Math.max(0, current - 1)));
    }, 1000);
    return () => clearInterval(timer);
  }, [gate]);

  const gateSeriesData = useMemo(
    () => (gateWindowsQuery.data?.series ?? []).map((point) => ({
      time: clockLabel(point.windowStart),
      camera: point.camera,
      ultrasonic: point.ultrasonic,
      ir: point.ir,
    })),
    [gateWindowsQuery.data],
  );
  const gateAlertDots = useMemo(() => {
    const seen = new Set<string>();
    const dots: Array<{ time: string; y: number; mode: string }> = [];
    for (const point of gateWindowsQuery.data?.series ?? []) {
      if (point.alerts.length === 0) continue;
      const time = clockLabel(point.windowStart);
      if (seen.has(time)) continue;
      seen.add(time);
      dots.push({ time, y: point.camera, mode: point.alerts[0] });
    }
    return dots;
  }, [gateWindowsQuery.data]);
  const gateAlertRows = useMemo(() => {
    const rows = [...(gateAlertsQuery.data ?? [])];
    rows.sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return rows.slice(0, 8);
  }, [gateAlertsQuery.data]);

  const invalidateOperations = () => {
    void queryClient.invalidateQueries({ queryKey: getGetPiStatusQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListMatchReviewsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetSystemSettingsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetConfidenceHeatmapQueryKey() });
  };

  const requestAction = (action: "worker-status" | "restart-worker" | "camera-status" | "recent-logs") => {
    if (action === "restart-worker" && !window.confirm("Restart the attendance worker? This may briefly pause processing.")) return;
    setActionFeedback("");
    actionMutation.mutate({ data: { action } }, {
      onSuccess: (job) => {
        setActionFeedback(`${action.replaceAll("-", " ")} queued as job #${job.id}.`);
        void queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      },
      onError: () => setActionFeedback("The action could not be queued. Check the device connection and try again."),
    });
  };

  const pairDevice = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = deviceName.trim();
    if (!name) return;
    setPairing(null);
    setFeedback("");
    pairMutation.mutate({ data: { name } }, {
      onSuccess: (result) => {
        // Keep this one-time credential only in component memory. It is never persisted.
        setPairing(result);
        setDeviceName("");
        setFeedback("Pairing token issued. Copy it now; it will not be shown again after dismissal or navigation.");
        void queryClient.invalidateQueries({ queryKey: getGetPiStatusQueryKey() });
      },
      onError: () => setFeedback("Pairing could not be started. Verify the device name and try again."),
    });
  };

  const copyToken = async () => {
    if (!pairing?.token) return;
    try {
      await navigator.clipboard.writeText(pairing.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setFeedback("Clipboard access was blocked. Select and copy the token directly.");
    }
  };

  const confirmKillSessions = () => {
    if (!window.confirm("Revoke the Pi session and cancel active operations? The device will need to pair again.")) return;
    setFeedback("");
    killMutation.mutate(undefined, {
      onSuccess: (result) => {
        setFeedback(`Pi session revoked. ${result.cancelledJobs} active job${result.cancelledJobs === 1 ? "" : "s"} cancelled.`);
        invalidateOperations();
      },
      onError: () => setFeedback("Could not revoke the Pi session. No changes were confirmed."),
    });
  };

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const confidenceThreshold = Number(threshold);
    const reviewRetentionDays = Number(retention);
    const gateDiscrepancyPct = Number(gateDiscrepancy);
    const gateWindowSeconds = Number(gateWindow);
    const hhmm = (value: string) => /^\d{2}:\d{2}$/.test(value);
    if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0.1 || confidenceThreshold > 0.99 ||
        !Number.isInteger(reviewRetentionDays) || reviewRetentionDays < 1 || reviewRetentionDays > 365) {
      setFeedback("Use a confidence threshold from 0.10–0.99 and retention from 1–365 days.");
      return;
    }
    if (!hhmm(entranceTime) || !hhmm(lateCutoffTime) || !hhmm(absenceCutoffTime) || !hhmm(gateActiveFrom) ||
        !hhmm(gateActiveTo) || !attendanceTimezone.trim() ||
        !Number.isInteger(gateDiscrepancyPct) || gateDiscrepancyPct < 1 || gateDiscrepancyPct > 100 ||
        !Number.isInteger(gateWindowSeconds) || gateWindowSeconds < 15 || gateWindowSeconds > 300) {
      setFeedback("Attendance time rules and gate integrity values are incomplete (threshold 1–100%, window 15–300 seconds, valid IANA timezone).");
      return;
    }
    setFeedback("");
    settingsMutation.mutate({
      confidenceThreshold,
      reviewRetentionDays,
      entranceTime,
      lateCutoffTime,
      absenceCutoffTime,
      attendanceTimezone: attendanceTimezone.trim(),
      gateDiscrepancyPct,
      gateWindowSeconds,
      gateActiveFrom,
      gateActiveTo,
    }, {
      onSuccess: () => {
        setFeedback("Review, attendance time, and gate settings saved.");
        void queryClient.invalidateQueries({ queryKey: getGetSystemSettingsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetConfidenceHeatmapQueryKey() });
      },
      onError: (error) => {
        // Server-side ordering/timezone validation is surfaced verbatim.
        toast({ title: "Settings were not saved", description: error.message, variant: "destructive" });
      },
    });
  };

  const runGateValidation = () => {
    gateRunMutation.mutate(undefined, {
      onSuccess: (result) => {
        toast({ title: `Validation ran: ${result.windowsEvaluated} windows, ${result.alertsCreated.length} alert${result.alertsCreated.length === 1 ? "" : "s"}` });
        void queryClient.invalidateQueries({ queryKey: ["gate"] });
      },
      onError: (error) => toast({ title: "Validation could not run", description: error.message, variant: "destructive" }),
    });
  };

  const simulateGate = (mode: GateSimulateMode) => {
    gateSimulateMutation.mutate(mode, {
      onSuccess: () => {
        toast({ title: "Simulated mismatch injected (demo)" });
        setSimulateOpen(false);
        void queryClient.invalidateQueries({ queryKey: ["gate"] });
      },
      onError: (error) => toast({ title: "Simulation failed", description: error.message, variant: "destructive" }),
    });
  };

  const resolveGateAlert = () => {
    if (selectedAlertId == null) return;
    gateResolveMutation.mutate({ id: selectedAlertId, note: resolveNote.trim() || undefined }, {
      onSuccess: () => {
        toast({ title: "Alert marked resolved" });
        setResolveNote("");
        void queryClient.invalidateQueries({ queryKey: ["gate"] });
      },
      onError: (error) => toast({ title: "Could not resolve alert", description: error.message, variant: "destructive" }),
    });
  };

  const decideReview = (id: number, decision: "approve" | "reject") => {
    if (decision === "reject" && !window.confirm("Reject this face match? This decision will be recorded.")) return;
    decisionMutation.mutate({ id, data: { decision, note: decisionNote.trim() || undefined } }, {
      onSuccess: () => {
        setDecisionNote("");
        setFeedback(`Review ${decision === "approve" ? "approved" : "rejected"}.`);
        void queryClient.invalidateQueries({ queryKey: getListMatchReviewsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetConfidenceHeatmapQueryKey() });
      },
      onError: () => setFeedback("The review decision was not saved. Please retry."),
    });
  };

  const setFan = (mode: "auto" | "on" | "off") => {
    setFeedback("");
    fanMutation.mutate({ data: { mode } }, {
      onSuccess: (job) => {
        setFeedback(`Fan mode ${mode} queued as job #${job.id}.`);
        void queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetSystemSettingsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetPiStatusQueryKey() });
      },
      onError: () => setFeedback("Fan mode could not be queued. Check device connectivity."),
    });
  };

  const retryJob = (id: number) => retryMutation.mutate({ id }, {
    onSuccess: (job) => {
      setFeedback(`Job #${id} queued for retry as #${job.id}.`);
      void queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
    },
    onError: () => setFeedback(`Job #${id} could not be retried.`),
  });

  const clearRecords = (source: "manual" | "automated", count?: number) => {
    if (count == null || count < 1) {
      setFeedback("There are no matching attendance records to clear.");
      return;
    }
    const label = source === "manual" ? "manual" : "automated (webcam and gate-camera)";
    if (!window.confirm(`Permanently delete ${count} ${label} attendance record${count === 1 ? "" : "s"}? This cannot be undone. Audit history will remain.`)) return;
    clearRecordsMutation.mutate({ data: { source, expectedCount: count } }, {
      onSuccess: (result) => {
        setFeedback(`${result.deletedCount} ${label} attendance record${result.deletedCount === 1 ? "" : "s"} deleted. The action remains in the audit log.`);
        void queryClient.invalidateQueries({ queryKey: getListAttendanceQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListAuditLogsQueryKey({ limit: 50 }) });
        void queryClient.invalidateQueries({ queryKey: getPreviewAttendanceClearQueryKey({ source }) });
      },
      onError: () => {
        setFeedback("Records changed after the preview or deletion failed. Refresh the count and confirm again.");
        void queryClient.invalidateQueries({ queryKey: getPreviewAttendanceClearQueryKey({ source }) });
      },
    });
  };

  const heartbeatFresh = Boolean(device?.lastSeenAt && piQuery.data &&
    Date.now() - new Date(device.lastSeenAt).getTime() <= piQuery.data.staleAfterSeconds * 1000);

  return (
    <div className="mx-auto w-full max-w-[1480px] min-w-0 space-y-4 sm:space-y-6 pb-10">
      <header className="relative overflow-hidden rounded-2xl border border-violet-200/10 bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.16),transparent_48%),linear-gradient(120deg,#21172e,#17111f)] px-5 py-6 sm:px-7 sm:py-8">
        <div className="absolute -right-16 -top-24 h-64 w-64 rounded-full border border-violet-200/[0.07]" aria-hidden="true" />
        <div className="absolute -right-2 -top-9 h-36 w-36 rounded-full border border-violet-200/[0.08]" aria-hidden="true" />
        <div className="relative flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div>
            <div className="mb-3 flex items-center gap-2 text-violet-200/60">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-300" />
              <span className={label}>AttendX / Phase 02</span>
            </div>
            <h1 className="text-3xl font-semibold tracking-[-0.04em] text-violet-50 sm:text-4xl">Operations</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-violet-100/60">
              Device health, attendance processing, and review controls in one place.
            </p>
          </div>
          <div className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium ${
            piQuery.isLoading ? "border-violet-200/10 bg-violet-200/[0.04] text-violet-100/55" :
              piQuery.data?.online && heartbeatFresh ? "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200" :
                "border-amber-300/20 bg-amber-300/[0.08] text-amber-100"
          }`} aria-live="polite" data-testid="status-pi-connectivity">
            <span className={`h-2 w-2 rounded-full ${piQuery.isLoading ? "bg-violet-300/50" : piQuery.data?.online && heartbeatFresh ? "bg-emerald-300" : "bg-amber-300"}`} />
            {piQuery.isLoading ? "Checking device" : piQuery.data?.online && heartbeatFresh ? "Gate device online" : piQuery.data?.online ? "Heartbeat stale" : "Device offline"}
          </div>
        </div>
      </header>

      {feedback && (
        <div role="status" aria-live="polite" className="flex items-start justify-between gap-3 rounded-xl border border-violet-200/15 bg-violet-300/[0.06] px-4 py-3 text-sm text-violet-100/85">
          <span className="min-w-0 flex-1">{feedback}</span>
          <button type="button" onClick={() => setFeedback("")} aria-label="Dismiss notification" className="shrink-0 text-violet-100/55 hover:text-violet-50"><X size={16} /></button>
        </div>
      )}

      <section aria-label="Device health" className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <article className={`${panel} p-5 sm:p-6`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <SectionHeading eyebrow="Gate device" title={device?.name || "Raspberry Pi"} detail="Live heartbeat and hardware telemetry" />
            {device && <span className={`rounded-md px-2.5 py-1 text-xs font-medium ${piQuery.data?.online ? "bg-emerald-300/10 text-emerald-200" : "bg-amber-300/10 text-amber-100"}`}>
              {device.status.replaceAll("_", " ")}
            </span>}
          </div>
          {piQuery.isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-[74px]" />)}</div>
          ) : piQuery.isError ? <ErrorNotice message="Device health is temporarily unavailable." onRetry={() => void piQuery.refetch()} /> :
            !device ? (
              <div className="rounded-xl border border-dashed border-violet-200/15 p-5 text-center">
                <Server size={21} className="mx-auto text-violet-200/45" />
                <p className="mt-2 text-sm font-medium text-violet-50">No gate device paired</p>
                <p className={`mt-1 ${quiet}`}>Pair a Raspberry Pi to begin receiving health signals.</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric icon={Activity} title="Heartbeat" value={ageLabel(device.lastSeenAt)} sub={device.lastSeenAt ? formatTime(device.lastSeenAt) : undefined} />
                  <Metric icon={Network} title="Local address" value={device.localIp || "Not reported"} />
                  <Metric icon={Thermometer} title="CPU temperature" value={device.cpuTempC == null ? "Not reported" : `${device.cpuTempC.toFixed(1)}°C`} />
                  <Metric icon={Cpu} title="Queue depth" value={String(device.queueDepth)} sub={device.uptimeSeconds == null ? "Uptime not reported" : `${Math.floor(device.uptimeSeconds / 3600)}h uptime`} />
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-violet-100/[0.08] pt-4">
                  <div className={`flex items-center gap-2 text-xs ${heartbeatFresh ? "text-emerald-200/75" : "text-amber-100/75"}`}>
                    {heartbeatFresh ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                    {heartbeatFresh ? `Heartbeat within ${piQuery.data?.staleAfterSeconds}s freshness window` : `Heartbeat exceeds ${piQuery.data?.staleAfterSeconds ?? "the"}s freshness window`}
                  </div>
                  <span className="flex items-center gap-2 text-xs text-violet-100/50"><Fan size={14} />Fan {device.fanState}{device.fanTempC == null ? "" : ` · ${device.fanTempC.toFixed(1)}°C`}</span>
                </div>
              </>
            )}
        </article>

        <article className={`${panel} p-5 sm:p-6`}>
          <SectionHeading eyebrow="Secure enrollment" title="Pair a device" detail="Issue a short-lived, one-time pairing credential." />
          <form onSubmit={pairDevice} className="space-y-3">
            <label htmlFor="device-name" className="block text-xs font-medium text-violet-100/75">Device name</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input id="device-name" data-testid="input-device-name" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} required maxLength={80} placeholder="e.g. North gate Pi" className="min-h-10 min-w-0 flex-1 rounded-lg border border-violet-200/15 bg-[#110d18] px-3 text-sm text-violet-50 outline-none placeholder:text-violet-100/30 focus:border-violet-300/45 focus:ring-2 focus:ring-violet-300/15" />
              <button type="submit" disabled={pairMutation.isPending || !deviceName.trim()} className={accentAction}>
                {pairMutation.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <KeyRound size={15} />}
                Generate token
              </button>
            </div>
          </form>
          {pairing ? (
            <div className="mt-4 rounded-xl border border-amber-200/20 bg-amber-200/[0.06] p-3.5" role="status">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-xs font-semibold text-amber-100"><ShieldAlert size={14} />One-time pairing token</p>
                <button type="button" aria-label="Dismiss pairing token" onClick={() => setPairing(null)} className="text-amber-100/55 hover:text-amber-50"><X size={15} /></button>
              </div>
              <code className="mt-2 block break-all rounded-lg bg-black/20 p-2.5 font-mono text-xs leading-relaxed text-amber-50" data-testid="text-pairing-token">{pairing.token}</code>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-amber-100/55">Expires {formatTime(pairing.expiresAt)} · Device {pairing.deviceId}</span>
                <button type="button" onClick={() => void copyToken()} className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-100 hover:text-white">
                  {copied ? <Check size={13} /> : <Clipboard size={13} />}{copied ? "Copied" : "Copy token"}
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-amber-100/65">This credential exists only on this screen. Dismiss it or leave this page and it cannot be recovered here.</p>
            </div>
          ) : feedback.toLowerCase().includes("pair") ? <p className="mt-3 text-xs text-violet-100/55">{feedback}</p> : null}
          {pairMutation.isError && <p className="mt-3 text-xs text-rose-200">Pairing failed. The server did not return a token.</p>}
        </article>
      </section>

      <section aria-label="Gate integrity">
        <article className={`${panel} p-5 sm:p-6`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeading eyebrow="Gate integrity" title="Gate Integrity" detail="Camera and entrance-sensor cross-checks for the gate corridor." />
            <div className="flex flex-wrap items-center gap-2">
              {gate && <GateVerdictBadge verdict={gate.verdict} />}
              {gate && secondsLeft != null && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-violet-200/15 bg-violet-200/[0.06] px-2.5 py-1 font-mono text-xs text-violet-100/70" data-testid="gate-window-countdown">
                  <Timer size={13} className="text-violet-200/60" />Window ends in {secondsLeft}s
                </span>
              )}
              {gate && !gate.withinGateHours && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-violet-100/10 bg-violet-100/[0.04] px-2.5 py-1 text-xs text-violet-100/50" data-testid="gate-outside-hours">
                  <AlertCircle size={13} />Outside gate hours ({gate.gateActiveFrom}–{gate.gateActiveTo} {gate.timezone})
                </span>
              )}
            </div>
          </div>
          {gateCurrentQuery.isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{[1, 2, 3].map((item) => <Skeleton key={item} className="h-[92px]" />)}</div>
          ) : gateCurrentQuery.isError ? (
            <ErrorNotice message="Gate integrity data is temporarily unavailable." onRetry={() => void gateCurrentQuery.refetch()} />
          ) : !gate ? null : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <GateCounter icon={Camera} title="Camera detections" value={gate.camera} tone="violet" sub="faces matched in the current window" />
                <GateCounter icon={Waves} title="Ultrasonic triggers" value={gate.ultrasonic} tone="emerald" sub="motion pulses in the current window" />
                <GateCounter icon={Zap} title="IR beam breaks" value={gate.ir} tone="cyan" sub="beam crossings in the current window" />
              </div>
              <p className="mt-2 text-[11px] text-violet-100/45">
                Alert when camera trails both sensors by &gt;{gate.discrepancyPct}% or sensors disagree by &gt;{gate.discrepancyPct}%.
              </p>
              <div className="mt-4 rounded-xl border border-violet-100/[0.08] bg-[#110d18] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-xs font-semibold text-violet-50"><Activity size={14} className="text-violet-300" />Rolling window counts</p>
                  <span className="text-[10px] text-violet-100/40">last 60 minutes · {gate.windowSeconds}s windows</span>
                </div>
                {gateWindowsQuery.isLoading ? <Skeleton className="mt-3 h-48 sm:h-56" /> :
                  gateWindowsQuery.isError ? <div className="mt-3"><ErrorNotice message="Window history could not be loaded." onRetry={() => void gateWindowsQuery.refetch()} /></div> :
                    gateSeriesData.length === 0 ? (
                      <p className="mt-3 rounded-lg border border-dashed border-violet-200/15 px-4 py-6 text-center text-xs text-violet-100/45">No gate windows recorded yet.</p>
                    ) : (
                      <div className="mt-3 h-48 sm:h-56">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={gateSeriesData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(155,91,255,0.08)" vertical={false} />
                            <XAxis dataKey="time" stroke="rgba(255,255,255,0.2)" tick={{ fontSize: 10 }} tickMargin={6} minTickGap={24} />
                            <YAxis stroke="rgba(255,255,255,0.2)" tick={{ fontSize: 10 }} allowDecimals={false} />
                            <Tooltip
                              contentStyle={{ backgroundColor: "#0d0515", borderColor: "rgba(155,91,255,0.25)", borderRadius: 10 }}
                              itemStyle={{ color: "#e2d9f3", fontSize: 11 }}
                            />
                            <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }} />
                            <Line type="monotone" dataKey="camera" name="Camera" stroke="#a78bfa" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="ultrasonic" name="Ultrasonic" stroke="#34d399" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="ir" name="IR beam" stroke="#22d3ee" strokeWidth={2} dot={false} />
                            {gateAlertDots.map((dot) => (
                              <ReferenceDot
                                key={`${dot.time}-${dot.mode}`}
                                x={dot.time}
                                y={dot.y}
                                r={5}
                                fill={dot.mode === "sensor_conflict" ? "#f87171" : "#fbbf24"}
                                stroke="#17111f"
                                strokeWidth={1.5}
                              />
                            ))}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    )}
              </div>
              {canAdmin && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button type="button" className={actionClass} onClick={() => void gateCurrentQuery.refetch()} disabled={gateCurrentQuery.isFetching} aria-label="Refresh gate integrity">
                    <RefreshCw size={14} className={gateCurrentQuery.isFetching ? "animate-spin" : ""} />Refresh
                  </button>
                  <button type="button" className={dangerAction} onClick={() => setSimulateOpen((open) => !open)} disabled={gateSimulateMutation.isPending} aria-expanded={simulateOpen} data-testid="button-gate-simulate">
                    {gateSimulateMutation.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <FlaskConical size={14} />}Simulate discrepancy
                  </button>
                  <button type="button" className={actionClass} onClick={runGateValidation} disabled={gateRunMutation.isPending} data-testid="button-gate-run">
                    {gateRunMutation.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}Run validation now
                  </button>
                </div>
              )}
              {canAdmin && simulateOpen && (
                <div className="mt-3 rounded-xl border border-amber-200/20 bg-amber-200/[0.05] p-3" role="group" aria-label="Simulation mode">
                  <p className="text-xs font-semibold text-amber-100">Choose the mismatch to inject</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {(["missed_detections", "sensor_conflict"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setSimulateMode(mode)}
                        aria-pressed={simulateMode === mode}
                        className={`min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${simulateMode === mode ? "border-amber-300/35 bg-amber-300/10 text-amber-100" : "border-violet-100/10 bg-violet-100/[0.025] text-violet-100/60 hover:bg-violet-100/[0.06]"}`}
                        data-testid={`button-gate-mode-${mode}`}
                      >
                        {mode.replaceAll("_", " ")}
                      </button>
                    ))}
                    <button type="button" className={accentAction} onClick={() => simulateGate(simulateMode)} disabled={gateSimulateMutation.isPending} data-testid="button-gate-simulate-inject">
                      {gateSimulateMutation.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <FlaskConical size={15} />}Inject demo data
                    </button>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-100/60">Injects synthetic sensor events for demonstration. Alerts created this way are tagged DEMO until they are resolved.</p>
                </div>
              )}
              <div className="mt-4 border-t border-violet-100/[0.08] pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-violet-50">Recent alerts</p>
                  <span className="text-[10px] text-violet-100/40">unresolved first · showing {gateAlertRows.length}</span>
                </div>
                {gateAlertsQuery.isLoading ? <div className="mt-2 space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div> :
                  gateAlertsQuery.isError ? <div className="mt-2"><ErrorNotice message="Gate alerts could not be loaded." onRetry={() => void gateAlertsQuery.refetch()} /></div> :
                    gateAlertRows.length === 0 ? (
                      <div className="mt-2 rounded-xl border border-dashed border-violet-200/15 px-4 py-6 text-center">
                        <ShieldCheck size={20} className="mx-auto text-emerald-200/65" />
                        <p className="mt-2 text-sm font-medium text-violet-50">No gate alerts</p>
                        <p className={`mt-1 ${quiet}`}>Sensor mismatches will appear here as they are detected.</p>
                      </div>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {gateAlertRows.map((alert) => (
                          <GateAlertItem key={alert.id} alert={alert} onOpen={() => setSelectedAlertId(alert.id)} />
                        ))}
                      </div>
                    )}
              </div>
              <GateAlertDialog
                open={selectedAlertId != null}
                detail={gateDetailQuery.data}
                loading={gateDetailQuery.isLoading || gateDetailQuery.isFetching}
                error={gateDetailQuery.isError}
                onRetry={() => void gateDetailQuery.refetch()}
                canAdmin={canAdmin}
                note={resolveNote}
                onNoteChange={setResolveNote}
                onResolve={resolveGateAlert}
                resolving={gateResolveMutation.isPending}
                onClose={() => { setSelectedAlertId(null); setResolveNote(""); }}
              />
            </>
          )}
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.3fr_0.9fr]">
        <article className={`${panel} p-5 sm:p-6`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeading eyebrow="Processing" title="Job queue" detail="Recent device and attendance work" />
            <button type="button" className={actionClass} onClick={() => void jobsQuery.refetch()} disabled={jobsQuery.isFetching} aria-label="Refresh job queue">
              <RefreshCw size={14} className={jobsQuery.isFetching ? "animate-spin" : ""} />Refresh
            </button>
          </div>
          {jobsQuery.isLoading ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">{[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-[65px]" />)}</div>
          ) : jobsQuery.isError ? <ErrorNotice message="The job queue could not be loaded." onRetry={() => void jobsQuery.refetch()} /> :
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {(["pending", "running", "failed", "done"] as const).map((status) => (
                  <div key={status} className={`rounded-xl border px-3 py-2.5 ${status === "failed" && (jobsQuery.data?.counts.failed ?? 0) > 0 ? "border-rose-300/15 bg-rose-300/[0.05]" : "border-violet-100/[0.08] bg-violet-100/[0.025]"}`}>
                    <p className="text-[11px] capitalize text-violet-100/50">{status}</p>
                    <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-violet-50" data-testid={`count-jobs-${status}`}>{jobsQuery.data?.counts[status] ?? 0}</p>
                  </div>
                ))}
              </div>
              {failedJobs.length > 0 && (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-semibold text-rose-200">Failed jobs · retry individually</p>
                  {failedJobs.slice(0, 3).map((job) => (
                    <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200/10 bg-rose-200/[0.035] px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-violet-50" title={job.type}>{job.type} <span className="font-mono text-xs text-violet-100/40">#{job.id}</span></p>
                        <p className="mt-0.5 truncate text-xs text-rose-100/60" title={job.error || "No error detail returned"}>{job.error || "No error detail returned"} · {job.attempts} attempts</p>
                      </div>
                      <button type="button" onClick={() => retryJob(job.id)} disabled={retryMutation.isPending} className={actionClass} data-testid={`button-retry-job-${job.id}`}><RotateCcw size={14} />Retry</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 overflow-x-auto rounded-xl border border-violet-100/[0.08]" role="region" aria-label="Recent jobs table" tabIndex={0}>
                <div className="min-w-[480px]">
                  <div className="grid grid-cols-[1.2fr_0.8fr_auto] gap-2 border-b border-violet-100/[0.08] bg-violet-100/[0.025] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-violet-100/40">
                    <span>Job</span><span>Worker</span><span>Status</span>
                  </div>
                  {recentJobs.length === 0 ? <p className="px-3 py-6 text-center text-xs text-violet-100/45">No jobs have been reported.</p> :
                    recentJobs.map((job) => (
                      <div key={job.id} data-testid={`row-job-${job.id}`} className="grid grid-cols-[1.2fr_0.8fr_auto] items-center gap-2 border-b border-violet-100/[0.05] px-3 py-2.5 last:border-0">
                        <div className="min-w-0"><p className="truncate text-xs font-medium text-violet-50" title={job.type}>{job.type} <span className="font-mono text-[10px] text-violet-100/40">#{job.id}</span></p><p className="truncate text-[10px] text-violet-100/40">{formatTime(job.createdAt)}</p></div>
                        <span className="truncate text-xs text-violet-100/55" title={job.worker || "—"}>{job.worker || "—"}</span>
                        <span className={`rounded-md px-2 py-1 text-[10px] font-medium capitalize ${job.status === "failed" ? "bg-rose-300/10 text-rose-200" : job.status === "done" ? "bg-emerald-300/10 text-emerald-200" : "bg-violet-300/10 text-violet-100/70"}`}>{job.status}</span>
                      </div>
                    ))}
                </div>
              </div>
            </>}
        </article>

        <article className={`${panel} p-5 sm:p-6`}>
          <SectionHeading eyebrow="Allowlisted controls" title="Operator console" detail="Fixed actions only. Every request is tracked as a job." />
          <div className="grid gap-2 sm:grid-cols-2">
            <ConsoleAction icon={Activity} title="Worker status" action="worker-status" disabled={actionMutation.isPending} onRun={requestAction} />
            <ConsoleAction icon={RefreshCw} title="Restart worker" action="restart-worker" disabled={actionMutation.isPending || !piQuery.data?.online} onRun={requestAction} />
            <ConsoleAction icon={Fingerprint} title="Camera status" action="camera-status" disabled={actionMutation.isPending} onRun={requestAction} />
            <ConsoleAction icon={ChevronRight} title="Recent logs" action="recent-logs" disabled={actionMutation.isPending} onRun={requestAction} />
          </div>
          {actionFeedback && <p className="mt-3 rounded-lg bg-violet-300/[0.06] px-3 py-2 text-xs text-violet-100/70" role="status">{actionFeedback}</p>}
          {actionMutation.isError && <p className="mt-2 text-xs text-rose-200">Action request failed. Try again when the device is reachable.</p>}
          <div className="mt-4 rounded-xl border border-violet-100/[0.08] bg-[#110d18] p-3.5">
            <p className="flex items-center gap-2 text-xs font-semibold text-violet-50"><Activity size={14} className="text-violet-300" />Recent log request</p>
            {recentLogJob ? (
              <div className="mt-2">
                <p className="text-[11px] text-violet-100/45">Job #{recentLogJob.id} · {recentLogJob.status} · {formatTime(recentLogJob.completedAt || recentLogJob.createdAt)}</p>
                {recentLogJob.status === "failed" && <p className="mt-1 text-xs text-rose-200">{recentLogJob.error || "Log request failed."}</p>}
                {recentLogJob.result && <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 p-2.5 font-mono text-[10px] leading-relaxed text-violet-100/65">{JSON.stringify(recentLogJob.result, null, 2)}</pre>}
              </div>
            ) : <p className="mt-2 text-xs text-violet-100/45">No completed recent-log request is available.</p>}
          </div>
          <div className="mt-4 border-t border-violet-100/[0.08] pt-4">
            <div className="flex items-start gap-2.5">
              <LockKeyhole size={16} className="mt-0.5 shrink-0 text-rose-200" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-violet-50">Revoke device session</p>
                <p className="mt-1 text-xs leading-relaxed text-violet-100/50">Immediately revoke the Pi credential and cancel active jobs. Pairing will be required again.</p>
              </div>
            </div>
            <button type="button" onClick={confirmKillSessions} disabled={killMutation.isPending} className={`${dangerAction} mt-3 w-full`} data-testid="button-kill-sessions">
              {killMutation.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <ShieldAlert size={15} />}
              Revoke sessions and cancel work
            </button>
            {killMutation.isError && <p className="mt-2 text-xs text-rose-200">Session revocation failed. No success was reported.</p>}
          </div>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <article className={`${panel} p-5 sm:p-6`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeading eyebrow="Human review" title="Uncertain face matches" detail="Approve or reject low-confidence gate-camera matches." />
            <div className="rounded-lg border border-amber-200/15 bg-amber-200/[0.05] px-3 py-2 text-xs text-amber-100/75">
              <span className="font-mono text-base font-semibold text-amber-100">{reviewsQuery.data?.filter((review) => review.status === "pending").length ?? "—"}</span>
              <span className="ml-2">pending</span>
            </div>
          </div>
          {reviewsQuery.isLoading ? <div className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div> :
            reviewsQuery.isError ? <ErrorNotice message="Face reviews could not be loaded." onRetry={() => void reviewsQuery.refetch()} /> :
              pendingReviews.length === 0 ? (
                <div className="rounded-xl border border-dashed border-violet-200/15 px-4 py-8 text-center">
                  <ShieldCheck size={22} className="mx-auto text-emerald-200/65" />
                  <p className="mt-2 text-sm font-medium text-violet-50">Review queue is clear</p>
                  <p className={`mt-1 ${quiet}`}>New uncertain matches will appear here.</p>
                </div>
              ) : (
                <>
                  <label htmlFor="review-note" className="mb-2 block text-xs font-medium text-violet-100/55">Decision note <span className="font-normal">(optional, applies to next decision)</span></label>
                  <input id="review-note" data-testid="input-review-note" value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} maxLength={300} placeholder="Add context for the audit record" className="mb-3 min-h-10 w-full rounded-lg border border-violet-200/15 bg-[#110d18] px-3 text-sm text-violet-50 outline-none placeholder:text-violet-100/30 focus:border-violet-300/45" />
                  <div className="space-y-2">
                    {pendingReviews.map((review) => (
                      <div key={review.id} className="rounded-xl border border-violet-100/[0.09] bg-violet-100/[0.025] p-3.5" data-testid={`card-review-${review.id}`}>
                        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold text-violet-50">{review.studentName || "Unidentified student"}</p>
                              <span className={`rounded-md px-2 py-0.5 font-mono text-[11px] ${review.confidence < 0.7 ? "bg-rose-300/10 text-rose-200" : "bg-amber-200/10 text-amber-100"}`}>{(review.confidence * 100).toFixed(1)}% confidence</span>
                            </div>
                            <p className="mt-1 text-xs text-violet-100/50">{review.classroomName || "Classroom not assigned"} · {review.source.replaceAll("-", " ")} · {formatTime(review.createdAt)}</p>
                            <p className="mt-1 font-mono text-[10px] text-violet-100/35">Student record {review.studentId ?? "not matched"} · Review #{review.id}</p>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <button type="button" onClick={() => decideReview(review.id, "approve")} disabled={decisionMutation.isPending} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-emerald-300/15 px-3 text-xs font-semibold text-emerald-100 hover:bg-emerald-300/25 disabled:opacity-45" data-testid={`button-approve-review-${review.id}`}><Check size={14} />Approve</button>
                            <button type="button" onClick={() => decideReview(review.id, "reject")} disabled={decisionMutation.isPending} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-rose-300/10 px-3 text-xs font-semibold text-rose-100 hover:bg-rose-300/20 disabled:opacity-45" data-testid={`button-reject-review-${review.id}`}><XCircle size={14} />Reject</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {decisionMutation.isError && <p className="mt-2 text-xs text-rose-200">Could not save this decision. It remains in the review queue.</p>}
                </>
              )}
        </article>

        <SmsHealthCard chrome="panel" />

        <article className={`${panel} p-5 sm:p-6`}>
          <SectionHeading eyebrow="Recognition policy" title="Review settings" detail="Tune recognition, attendance time rules, and gate integrity thresholds." />
          {settingsQuery.isLoading ? <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-10" /></div> :
            settingsQuery.isError ? <ErrorNotice message="System settings could not be loaded." onRetry={() => void settingsQuery.refetch()} /> :
              <form onSubmit={saveSettings} className="space-y-5">
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <label htmlFor="confidence-threshold" className="text-xs font-semibold text-violet-100/75">Confidence threshold</label>
                    <span className="font-mono text-sm font-semibold text-violet-50">{threshold ? `${(Number(threshold) * 100).toFixed(0)}%` : "—"}</span>
                  </div>
                  <input id="confidence-threshold" data-testid="input-confidence-threshold" type="range" min="0.1" max="0.99" step="0.01" value={threshold || settingsQuery.data?.confidenceThreshold || 0.1} onChange={(event) => setThreshold(event.target.value)} className="w-full accent-violet-300" />
                  <div className="mt-1 flex justify-between text-[10px] text-violet-100/35"><span>10% · more reviews</span><span>99% · fewer matches</span></div>
                </div>
                <div>
                  <label htmlFor="retention-days" className="mb-2 block text-xs font-semibold text-violet-100/75">Rejected review retention</label>
                  <div className="flex items-center gap-2">
                    <input id="retention-days" data-testid="input-review-retention" type="number" min={1} max={365} step={1} value={retention} onChange={(event) => setRetention(event.target.value)} className="min-h-10 w-28 rounded-lg border border-violet-200/15 bg-[#110d18] px-3 font-mono text-sm text-violet-50 outline-none focus:border-violet-300/45" />
                    <span className="text-xs text-violet-100/50">days</span>
                  </div>
                  <p className="mt-1.5 text-[11px] text-violet-100/40">Allowed range: 1 to 365 days.</p>
                </div>
                <div className="border-t border-violet-100/[0.08] pt-4">
                  <p className="text-xs font-semibold text-violet-100/75">Attendance time rules</p>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="entrance-time" className="mb-1.5 block text-[11px] text-violet-100/55">Entrance time (present until)</label>
                      <input id="entrance-time" data-testid="input-entrance-time" type="time" value={entranceTime} onChange={(event) => setEntranceTime(event.target.value)} className={`${inputClass} font-mono`} />
                    </div>
                    <div>
                      <label htmlFor="late-cutoff-time" className="mb-1.5 block text-[11px] text-violet-100/55">Late cutoff (late until)</label>
                      <input id="late-cutoff-time" data-testid="input-late-cutoff-time" type="time" value={lateCutoffTime} onChange={(event) => setLateCutoffTime(event.target.value)} className={`${inputClass} font-mono`} />
                    </div>
                    <div>
                      <label htmlFor="absence-cutoff-time" className="mb-1.5 block text-[11px] text-violet-100/55">Absence cutoff (absent sweep unlocks)</label>
                      <input id="absence-cutoff-time" data-testid="input-absence-cutoff-time" type="time" value={absenceCutoffTime} onChange={(event) => setAbsenceCutoffTime(event.target.value)} className={`${inputClass} font-mono`} />
                    </div>
                    <div>
                      <label htmlFor="attendance-timezone" className="mb-1.5 block text-[11px] text-violet-100/55">Timezone (IANA)</label>
                      <input id="attendance-timezone" data-testid="input-attendance-timezone" type="text" value={attendanceTimezone} onChange={(event) => setAttendanceTimezone(event.target.value)} maxLength={64} placeholder="Africa/Addis_Ababa" className={inputClass} />
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-violet-100/40">Arrivals at or before the entrance time are marked present; arrivals after it are marked late and trigger the parent SMS. Students with no attendance record are only marked absent once the absence cutoff time unlocks the sweep.</p>
                </div>
                <div className="border-t border-violet-100/[0.08] pt-4">
                  <p className="text-xs font-semibold text-violet-100/75">Gate integrity</p>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="gate-discrepancy-pct" className="mb-1.5 block text-[11px] text-violet-100/55">Discrepancy threshold %</label>
                      <input id="gate-discrepancy-pct" data-testid="input-gate-discrepancy-pct" type="number" min={1} max={100} step={1} value={gateDiscrepancy} onChange={(event) => setGateDiscrepancy(event.target.value)} className={`${inputClass} font-mono`} />
                    </div>
                    <div>
                      <label htmlFor="gate-window-seconds" className="mb-1.5 block text-[11px] text-violet-100/55">Window seconds</label>
                      <input id="gate-window-seconds" data-testid="input-gate-window-seconds" type="number" min={15} max={300} step={1} value={gateWindow} onChange={(event) => setGateWindow(event.target.value)} className={`${inputClass} font-mono`} />
                    </div>
                    <div>
                      <label htmlFor="gate-active-from" className="mb-1.5 block text-[11px] text-violet-100/55">Gate active from</label>
                      <input id="gate-active-from" data-testid="input-gate-active-from" type="time" value={gateActiveFrom} onChange={(event) => setGateActiveFrom(event.target.value)} className={`${inputClass} font-mono`} />
                    </div>
                    <div>
                      <label htmlFor="gate-active-to" className="mb-1.5 block text-[11px] text-violet-100/55">Gate active to</label>
                      <input id="gate-active-to" data-testid="input-gate-active-to" type="time" value={gateActiveTo} onChange={(event) => setGateActiveTo(event.target.value)} className={`${inputClass} font-mono`} />
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-violet-100/40">Discrepancy threshold: 1–100%. Window seconds: 15–300. Outside the active hours the gate is not expected to report and no alerts are raised.</p>
                </div>
                <button type="submit" className={accentAction} disabled={settingsMutation.isPending || !settingsQuery.data || !canAdmin}>
                  {settingsMutation.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}Save policy
                </button>
                {!canAdmin && <p className="text-[10px] text-violet-100/40">Read-only: only super admins and admins can change these settings.</p>}
                {settingsQuery.data?.updatedAt && <p className="text-[10px] text-violet-100/35">Last updated {formatTime(settingsQuery.data.updatedAt)}</p>}
                {settingsMutation.isError && <p className="text-xs text-rose-200">Settings update failed. Current server values are unchanged.</p>}
              </form>}
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <article className={`${panel} p-5 sm:p-6`}>
          <SectionHeading eyebrow="Match quality" title="Confidence heatmap" detail="Historical low-confidence matches by date and classroom." />
          {heatmapQuery.isLoading ? <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div> :
            heatmapQuery.isError ? <ErrorNotice message="Confidence history could not be loaded." onRetry={() => void heatmapQuery.refetch()} /> :
              heatmapQuery.data?.length ? (
                <div className="overflow-x-auto" role="region" aria-label="Confidence heatmap table" tabIndex={0}>
                  <div className="min-w-[520px]">
                    <div className="grid grid-cols-[1.2fr_1fr_0.8fr_1fr] gap-2 border-b border-violet-100/[0.08] pb-2 text-[10px] font-semibold uppercase tracking-wider text-violet-100/40">
                      <span>Date</span><span>Classroom</span><span>Matches</span><span>Low confidence</span>
                    </div>
                    <div className="divide-y divide-violet-100/[0.06]">
                      {heatmapQuery.data.slice(0, 14).map((point, index) => {
                        const rate = Math.max(0, Math.min(1, point.lowConfidenceRate));
                        const color = rate >= 0.45 ? "bg-rose-300/30 text-rose-100" : rate >= 0.2 ? "bg-amber-200/20 text-amber-100" : "bg-emerald-300/15 text-emerald-100";
                        return (
                          <div key={`${point.day}-${point.classroomId ?? index}-${index}`} className="grid grid-cols-[1.2fr_1fr_0.8fr_1fr] items-center gap-2 py-2.5 text-xs">
                            <span className="text-violet-100/70">{formatTime(point.day)}</span>
                            <span className="truncate text-violet-100/65" title={point.classroomName || "Unassigned"}>{point.classroomName || "Unassigned"}</span>
                            <span className="font-mono text-violet-100/60">{point.lowConfidenceMatches}/{point.totalMatches}</span>
                            <span className={`inline-flex w-fit min-w-16 items-center justify-center rounded-md px-2 py-1 font-mono text-[11px] ${color}`}>{(rate * 100).toFixed(1)}%</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-violet-200/15 p-6 text-center">
                  <Activity size={20} className="mx-auto text-violet-200/45" />
                  <p className="mt-2 text-sm text-violet-50">No confidence history yet</p>
                  <p className={`mt-1 ${quiet}`}>Heatmap cells appear after face-match activity.</p>
                </div>
              )}
        </article>

        <article className={`${panel} p-5 sm:p-6`}>
          <SectionHeading eyebrow="Thermal control" title="Cooling fan" detail="Set the Pi fan policy. Changes are queued for the device." />
          {settingsQuery.isLoading ? <Skeleton className="h-20" /> :
            settingsQuery.isError ? <ErrorNotice message="Fan policy is unavailable until settings load." onRetry={() => void settingsQuery.refetch()} /> :
              <>
                <div role="group" aria-label="Fan mode" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(["auto", "on", "off"] as const).map((mode) => {
                    const selected = settingsQuery.data?.fanMode === mode;
                    return (
                      <button key={mode} type="button" onClick={() => setFan(mode)} disabled={fanMutation.isPending || !piQuery.data?.online} aria-pressed={selected} className={`min-h-16 rounded-xl border px-3 text-left transition-colors disabled:opacity-45 ${selected ? "border-violet-300/35 bg-violet-300/10" : "border-violet-100/10 bg-violet-100/[0.025] hover:bg-violet-100/[0.06]"}`} data-testid={`button-fan-${mode}`}>
                        <span className="block text-sm font-semibold capitalize text-violet-50">{mode}</span>
                        <span className="mt-1 block text-[10px] text-violet-100/45">{selected ? "Current policy" : mode === "auto" ? "Temperature managed" : mode === "on" ? "Force cooling" : "Fan disabled"}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-violet-100/45"><AlertCircle size={13} className="mt-0.5 shrink-0" />Unavailable while the device is offline. Fan changes are not applied until the Pi confirms the queued action.</p>
                {fanMutation.isError && <p className="mt-2 text-xs text-rose-200">Fan override could not be queued.</p>}
              </>}
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <article className={`${panel} p-5 sm:p-6`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeading eyebrow="Accountability" title="Audit trail" detail="Recent admin decisions and automated attendance operations." />
            <button type="button" className={actionClass} onClick={() => void auditQuery.refetch()} disabled={auditQuery.isFetching}>
              <RefreshCw size={14} className={auditQuery.isFetching ? "animate-spin" : ""} />Refresh
            </button>
          </div>
          {auditQuery.isLoading ? <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div> :
            auditQuery.isError ? <ErrorNotice message="The audit trail could not be loaded." onRetry={() => void auditQuery.refetch()} /> :
              auditQuery.data?.length ? (
                <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
                  {auditQuery.data.map((event) => (
                    <div key={event.id} className="grid grid-cols-[1fr_auto] gap-2 rounded-lg border border-violet-100/[0.08] bg-violet-100/[0.025] px-3 py-2.5 sm:grid-cols-[1fr_0.8fr_0.8fr_auto] sm:items-center">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-violet-50" title={event.action.replaceAll(".", " ")}>{event.action.replaceAll(".", " ")}</p>
                        <p className="mt-0.5 truncate text-[10px] text-violet-100/40" title={event.targetType}>{event.targetType}{event.targetId == null ? "" : ` · ${event.targetId}`}</p>
                      </div>
                      <span className="truncate text-[11px] text-violet-100/55" title={event.actorName || "System"}>{event.actorName || "System"}</span>
                      <span className="truncate text-[10px] text-violet-100/40">{formatTime(event.createdAt)}</span>
                      <span className="font-mono text-[10px] text-violet-100/35">#{event.id}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-violet-200/15 p-6 text-center">
                  <ScrollText size={20} className="mx-auto text-violet-200/45" />
                  <p className="mt-2 text-sm text-violet-50">No audit events yet</p>
                </div>
              )}
        </article>

        <article className={`${panel} p-5 sm:p-6`}>
          <SectionHeading eyebrow="Data control" title="Attendance records" detail="Review biometric data retention or clear records by source." />
          <div className="mb-4 rounded-xl border border-violet-100/[0.08] bg-violet-100/[0.025] p-3">
            <p className="flex items-center gap-2 text-xs font-semibold text-violet-50"><ShieldCheck size={14} className="text-violet-300" />Face data handling</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-violet-100/50">Face descriptors are removed when a review is decided. Rejected review metadata is purged after {settingsQuery.data?.reviewRetentionDays ?? "—"} days. Raw camera images are not uploaded.</p>
          </div>
          <div className="space-y-3">
            <ClearRecordControl
              title="Manual attendance"
              detail="Only records entered manually"
              count={manualClearPreview.data?.count}
              loading={manualClearPreview.isLoading}
              disabled={manualClearPreview.isError || clearRecordsMutation.isPending}
              onRefresh={() => void manualClearPreview.refetch()}
              onClear={() => clearRecords("manual", manualClearPreview.data?.count)}
            />
            <ClearRecordControl
              title="Automated attendance"
              detail="Webcam and gate-camera records"
              count={automatedClearPreview.data?.count}
              loading={automatedClearPreview.isLoading}
              disabled={automatedClearPreview.isError || clearRecordsMutation.isPending}
              onRefresh={() => void automatedClearPreview.refetch()}
              onClear={() => clearRecords("automated", automatedClearPreview.data?.count)}
            />
          </div>
          {manualClearPreview.isError && <ErrorNotice message="Manual attendance count unavailable." onRetry={() => void manualClearPreview.refetch()} />}
          {automatedClearPreview.isError && <ErrorNotice message="Automated attendance count unavailable." onRetry={() => void automatedClearPreview.refetch()} />}
          {clearRecordsMutation.isError && <p className="mt-3 text-xs text-rose-200">Nothing was reported as cleared. Refresh the count and try again.</p>}
          <p className="mt-3 text-[10px] leading-relaxed text-violet-100/35">Clearing is permanent. The app shows the current row count and asks for confirmation before deleting. Audit history is retained.</p>
        </article>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-violet-100/[0.07] pt-3 text-[10px] text-violet-100/35">
        <span className="flex items-center gap-1.5"><ShieldCheck size={12} />Operator actions are restricted to approved device operations.</span>
        <span>Heartbeat timestamp: {formatTime(device?.lastSeenAt)}</span>
      </footer>
    </div>
  );
}

function Metric({ icon: Icon, title, value, sub }: { icon: typeof Activity; title: string; value: string; sub?: string }) {
  return (
    <div className="min-h-[76px] rounded-xl border border-violet-100/[0.08] bg-violet-100/[0.025] p-3" data-testid={`metric-${title.toLowerCase().replaceAll(" ", "-")}`}>
      <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-violet-100/40"><Icon size={12} />{title}</p>
      <p className="mt-2 truncate text-sm font-semibold text-violet-50" title={value}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-[10px] text-violet-100/40" title={sub}>{sub}</p>}
    </div>
  );
}

function ClearRecordControl({ title, detail, count, loading, disabled, onRefresh, onClear }: {
  title: string;
  detail: string;
  count?: number;
  loading: boolean;
  disabled: boolean;
  onRefresh: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200/10 bg-rose-200/[0.025] p-3">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-violet-50">{title}</p>
        <p className="mt-0.5 text-[10px] text-violet-100/45">{detail} · {loading ? "Counting…" : `${count ?? "—"} records`}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" className={actionClass} onClick={onRefresh} aria-label={`Refresh ${title} count`} disabled={loading || disabled}><RefreshCw size={13} /></button>
        <button type="button" className={dangerAction} onClick={onClear} disabled={disabled || loading || !count} data-testid={`button-clear-${title.toLowerCase().replaceAll(" ", "-")}`}>
          <Trash2 size={14} />Clear
        </button>
      </div>
    </div>
  );
}

function ConsoleAction({ icon: Icon, title, action, disabled, onRun }: {
  icon: typeof Activity;
  title: string;
  action: "worker-status" | "restart-worker" | "camera-status" | "recent-logs";
  disabled: boolean;
  onRun: (action: "worker-status" | "restart-worker" | "camera-status" | "recent-logs") => void;
}) {
  return (
    <button type="button" onClick={() => onRun(action)} disabled={disabled} className="group flex min-h-[66px] items-center gap-3 rounded-xl border border-violet-100/[0.09] bg-violet-100/[0.025] p-3 text-left transition-colors hover:border-violet-200/20 hover:bg-violet-100/[0.06] disabled:pointer-events-none disabled:opacity-45" data-testid={`button-console-${action}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-300/10 text-violet-200"><Icon size={16} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-violet-50">{title}</span>
        <span className="mt-0.5 block text-[10px] text-violet-100/40">{action === "restart-worker" ? "Service restart" : `Queue ${action.replaceAll("-", " ")}`}</span>
      </span>
      {disabled ? <LoaderCircle size={14} className="animate-spin text-violet-100/40" /> : <ChevronRight size={14} className="text-violet-100/35 transition-transform group-hover:translate-x-0.5" />}
    </button>
  );
}

function GateVerdictBadge({ verdict }: { verdict: GateVerdict }) {
  if (verdict === "ok") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300/20 bg-emerald-300/10 px-2.5 py-1 text-xs font-medium text-emerald-200" data-testid="gate-verdict">
        <CheckCircle2 size={14} />In sync
      </span>
    );
  }
  if (verdict === "sensor_conflict") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 text-xs font-medium text-amber-100" data-testid="gate-verdict">
        <TriangleAlert size={14} />Sensor conflict
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-rose-300/20 bg-rose-300/10 px-2.5 py-1 text-xs font-medium text-rose-200" data-testid="gate-verdict">
      <ShieldX size={14} />Possible missed detections
    </span>
  );
}

function GateCounter({ icon: Icon, title, value, sub, tone }: {
  icon: typeof Activity;
  title: string;
  value: number;
  sub: string;
  tone: "violet" | "emerald" | "cyan";
}) {
  const toneClass = tone === "violet" ? "text-violet-300" : tone === "emerald" ? "text-emerald-300" : "text-cyan-300";
  return (
    <div className="min-h-[92px] rounded-xl border border-violet-100/[0.08] bg-violet-100/[0.025] p-3" data-testid={`metric-gate-${title.toLowerCase().replaceAll(" ", "-")}`}>
      <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-violet-100/40"><Icon size={12} className={toneClass} />{title}</p>
      <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-violet-50">{value}</p>
      <p className="mt-0.5 truncate text-[10px] text-violet-100/40" title={sub}>{sub}</p>
    </div>
  );
}

function GateAlertItem({ alert, onOpen }: { alert: GateAlertRow; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-violet-100/[0.05] ${alert.resolved ? "border-violet-100/[0.06] bg-violet-100/[0.015] opacity-70" : "border-violet-100/[0.09] bg-violet-100/[0.025]"}`}
      data-testid={`row-gate-alert-${alert.id}`}
    >
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-[10px] font-medium ${alert.alertType === "missed_detections" ? "bg-rose-300/10 text-rose-200" : "bg-amber-200/10 text-amber-100"}`}>
          {alert.alertType.replaceAll("_", " ")}
        </span>
        {alert.simulated && (
          <span className="inline-flex items-center gap-1 rounded-md border border-amber-300/25 bg-amber-300/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200">
            <FlaskConical size={10} />Demo
          </span>
        )}
        <span className="font-mono text-xs text-violet-100/70">{clockLabel(alert.windowStart, true)} – {clockLabel(alert.windowEnd, true)}</span>
      </span>
      <span className="flex items-center gap-3">
        <span className="font-mono text-[11px] text-violet-100/55">camera {alert.cameraCount} · ultrasonic {alert.ultrasonicCount} · IR {alert.irCount}</span>
        {alert.resolved ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-200/75"><Check size={12} />resolved</span>
        ) : (
          <ChevronRight size={14} className="text-violet-100/35" />
        )}
      </span>
    </button>
  );
}

function GateAlertDialog({ open, detail, loading, error, onRetry, canAdmin, note, onNoteChange, onResolve, resolving, onClose }: {
  open: boolean;
  detail?: GateAlertDetail;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  canAdmin: boolean;
  note: string;
  onNoteChange: (value: string) => void;
  onResolve: () => void;
  resolving: boolean;
  onClose: () => void;
}) {
  const events = useMemo(
    () => [...(detail?.sensorEvents ?? [])].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()),
    [detail],
  );
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto border-violet-200/15 bg-[#191323] text-violet-50 sm:rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-violet-50" data-testid="gate-alert-dialog-title">
            {detail ? `Window ${clockLabel(detail.windowStart, true)} – ${clockLabel(detail.windowEnd, true)}` : "Gate alert"}
          </DialogTitle>
          <DialogDescription className="text-violet-100/55">
            {detail ? `${detail.alertType.replaceAll("_", " ")} on gate ${detail.gateId}${detail.simulated ? " · simulated demo data" : ""}` : "Sensor events recorded for this window."}
          </DialogDescription>
        </DialogHeader>
        {error ? <ErrorNotice message="The alert detail could not be loaded." onRetry={onRetry} /> :
          loading || !detail ? (
            <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
          ) : (
            <div className="mt-1 space-y-4">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-violet-200/15 bg-violet-200/[0.06] px-2.5 py-2 text-center">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-violet-100/45">Camera</p>
                  <p className="mt-0.5 font-mono text-lg font-semibold text-violet-50">{detail.cameraCount}</p>
                </div>
                <div className="rounded-lg border border-emerald-300/15 bg-emerald-300/[0.05] px-2.5 py-2 text-center">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-emerald-100/60">Ultrasonic</p>
                  <p className="mt-0.5 font-mono text-lg font-semibold text-emerald-100">{detail.ultrasonicCount}</p>
                </div>
                <div className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.05] px-2.5 py-2 text-center">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-cyan-100/60">IR beam</p>
                  <p className="mt-0.5 font-mono text-lg font-semibold text-cyan-100">{detail.irCount}</p>
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold text-violet-100/75">Sensor event timeline</p>
                {events.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-violet-200/15 px-3 py-4 text-center text-xs text-violet-100/45">No sensor triggers were recorded in this window.</p>
                ) : (
                  <div className="max-h-52 space-y-2 overflow-auto pr-1">
                    {events.map((event) => (
                      <div
                        key={event.id}
                        className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${event.simulated ? "border-dashed border-amber-300/25 bg-amber-300/[0.05]" : "border-violet-100/[0.08] bg-violet-100/[0.025]"}`}
                        data-testid={`gate-event-${event.id}`}
                      >
                        <span className="flex min-w-0 flex-wrap items-center gap-2.5">
                          <span className={`h-1.5 w-1.5 rounded-full ${event.sensor === "ultrasonic" ? "bg-emerald-300" : "bg-cyan-300"}`} />
                          <span className="font-mono text-xs text-violet-100/80">{clockLabel(event.occurredAt, true)}</span>
                          <span className="text-xs text-violet-100/65">{event.sensor === "ultrasonic" ? "Ultrasonic" : "IR beam"}</span>
                          {event.piDeviceId && <span className="truncate font-mono text-[10px] text-violet-100/35" title={event.piDeviceId}>{event.piDeviceId}</span>}
                        </span>
                        {event.simulated && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300/25 bg-amber-300/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200">
                            <FlaskConical size={10} />simulated
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-1.5 text-[10px] text-violet-100/40">Camera-matched faces are summarized above; only ultrasonic and IR hardware events appear in the timeline.</p>
              </div>
              <p className="rounded-lg bg-violet-300/[0.06] px-3 py-2 text-xs leading-relaxed text-violet-100/70" data-testid="gate-alert-summary">{summarizeGateWindow(detail.cameraCount, events)}</p>
              {detail.resolved ? (
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-emerald-200/80">
                  <CheckCircle2 size={14} />Resolved{detail.resolvedAt ? ` ${formatTime(detail.resolvedAt)}` : ""}{detail.resolveNote ? ` · ${detail.resolveNote}` : ""}
                </p>
              ) : canAdmin ? (
                <div className="space-y-2 border-t border-violet-100/[0.08] pt-3">
                  <label htmlFor="gate-resolve-note" className="block text-xs font-medium text-violet-100/70">Resolution note <span className="font-normal">(optional)</span></label>
                  <input id="gate-resolve-note" data-testid="input-gate-resolve-note" value={note} onChange={(event) => onNoteChange(event.target.value)} maxLength={300} placeholder="Context saved with the resolution" className={inputClass} />
                  <button type="button" className={accentAction} onClick={onResolve} disabled={resolving} data-testid="button-gate-resolve">
                    {resolving ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}Mark resolved
                  </button>
                </div>
              ) : null}
            </div>
          )}
      </DialogContent>
    </Dialog>
  );
}
