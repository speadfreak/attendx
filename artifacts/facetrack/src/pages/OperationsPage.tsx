import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity, AlertCircle, Check, CheckCircle2, ChevronRight, Clipboard,
  Cpu, Fan, Fingerprint, KeyRound, LoaderCircle, LockKeyhole, Network,
  RefreshCw, RotateCcw, Server, ShieldAlert, ShieldCheck, Thermometer,
  X, XCircle,
} from "lucide-react";
import {
  getGetConfidenceHeatmapQueryKey,
  getGetPiStatusQueryKey,
  getGetSystemSettingsQueryKey,
  getListJobsQueryKey,
  getListMatchReviewsQueryKey,
  useCreatePiAction,
  useDecideMatchReview,
  useGetConfidenceHeatmap,
  useGetPiStatus,
  useGetSystemSettings,
  useKillPiSessions,
  useListJobs,
  useListMatchReviews,
  usePairPiDevice,
  useRetryJob,
  useSetFanOverride,
  useUpdateSystemSettings,
} from "../../../../lib/api-client-react/src/generated/api";
import type { PiPairingResponse } from "../../../../lib/api-client-react/src/generated/api.schemas";

const panel = "rounded-2xl border border-violet-200/10 bg-[#191323] shadow-[0_14px_40px_rgba(18,8,30,0.18)]";
const label = "text-[11px] font-semibold uppercase tracking-[0.15em] text-violet-200/55";
const quiet = "text-sm text-violet-100/55";
const actionClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-violet-200/15 bg-violet-200/[0.06] px-3.5 text-sm font-medium text-violet-50 transition-colors hover:bg-violet-200/[0.12] disabled:pointer-events-none disabled:opacity-45";
const accentAction = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-violet-400 px-3.5 text-sm font-semibold text-[#1b1026] transition-colors hover:bg-violet-300 disabled:pointer-events-none disabled:opacity-45";
const dangerAction = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-rose-300/20 bg-rose-400/10 px-3.5 text-sm font-semibold text-rose-200 transition-colors hover:bg-rose-400/15 disabled:pointer-events-none disabled:opacity-45";

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
  const piQuery = useGetPiStatus({ query: { queryKey: getGetPiStatusQueryKey(), refetchInterval: 15_000 } });
  const jobsQuery = useListJobs({ query: { queryKey: getListJobsQueryKey(), refetchInterval: 20_000 } });
  const reviewsQuery = useListMatchReviews({ query: { queryKey: getListMatchReviewsQueryKey(), refetchInterval: 30_000 } });
  const settingsQuery = useGetSystemSettings();
  const heatmapQuery = useGetConfidenceHeatmap();
  const pairMutation = usePairPiDevice();
  const actionMutation = useCreatePiAction();
  const killMutation = useKillPiSessions();
  const retryMutation = useRetryJob();
  const decisionMutation = useDecideMatchReview();
  const settingsMutation = useUpdateSystemSettings();
  const fanMutation = useSetFanOverride();

  const [deviceName, setDeviceName] = useState("");
  const [pairing, setPairing] = useState<PiPairingResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [threshold, setThreshold] = useState("");
  const [retention, setRetention] = useState("");
  const [feedback, setFeedback] = useState("");
  const [actionFeedback, setActionFeedback] = useState("");
  const [decisionNote, setDecisionNote] = useState("");

  useEffect(() => {
    if (!settingsQuery.data) return;
    setThreshold(String(settingsQuery.data.confidenceThreshold));
    setRetention(String(settingsQuery.data.reviewRetentionDays));
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
    if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0.1 || confidenceThreshold > 0.99 ||
        !Number.isInteger(reviewRetentionDays) || reviewRetentionDays < 1 || reviewRetentionDays > 365) {
      setFeedback("Use a confidence threshold from 0.10–0.99 and retention from 1–365 days.");
      return;
    }
    setFeedback("");
    settingsMutation.mutate({ data: { confidenceThreshold, reviewRetentionDays } }, {
      onSuccess: () => {
        setFeedback("Review settings saved.");
        void queryClient.invalidateQueries({ queryKey: getGetSystemSettingsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetConfidenceHeatmapQueryKey() });
      },
      onError: () => setFeedback("Settings were not saved. Review the values and retry."),
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

  const heartbeatFresh = Boolean(device?.lastSeenAt && piQuery.data &&
    Date.now() - new Date(device.lastSeenAt).getTime() <= piQuery.data.staleAfterSeconds * 1000);

  return (
    <div className="mx-auto w-full max-w-[1480px] space-y-6 pb-10">
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
          <span>{feedback}</span>
          <button type="button" onClick={() => setFeedback("")} aria-label="Dismiss notification" className="text-violet-100/55 hover:text-violet-50"><X size={16} /></button>
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-[74px]" />)}</div>
          ) : piQuery.isError ? <ErrorNotice message="Device health is temporarily unavailable." onRetry={() => void piQuery.refetch()} /> :
            !device ? (
              <div className="rounded-xl border border-dashed border-violet-200/15 p-5 text-center">
                <Server size={21} className="mx-auto text-violet-200/45" />
                <p className="mt-2 text-sm font-medium text-violet-50">No gate device paired</p>
                <p className={`mt-1 ${quiet}`}>Pair a Raspberry Pi to begin receiving health signals.</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

      <section className="grid gap-4 xl:grid-cols-[1.3fr_0.9fr]">
        <article className={`${panel} p-5 sm:p-6`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeading eyebrow="Processing" title="Job queue" detail="Recent device and attendance work" />
            <button type="button" className={actionClass} onClick={() => void jobsQuery.refetch()} disabled={jobsQuery.isFetching} aria-label="Refresh job queue">
              <RefreshCw size={14} className={jobsQuery.isFetching ? "animate-spin" : ""} />Refresh
            </button>
          </div>
          {jobsQuery.isLoading ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-[65px]" />)}</div>
          ) : jobsQuery.isError ? <ErrorNotice message="The job queue could not be loaded." onRetry={() => void jobsQuery.refetch()} /> :
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                        <p className="truncate text-sm font-medium text-violet-50">{job.type} <span className="font-mono text-xs text-violet-100/40">#{job.id}</span></p>
                        <p className="mt-0.5 truncate text-xs text-rose-100/60">{job.error || "No error detail returned"} · {job.attempts} attempts</p>
                      </div>
                      <button type="button" onClick={() => retryJob(job.id)} disabled={retryMutation.isPending} className={actionClass} data-testid={`button-retry-job-${job.id}`}><RotateCcw size={14} />Retry</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 overflow-hidden rounded-xl border border-violet-100/[0.08]">
                <div className="grid grid-cols-[1.2fr_0.8fr_auto] gap-2 border-b border-violet-100/[0.08] bg-violet-100/[0.025] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-violet-100/40">
                  <span>Job</span><span>Worker</span><span>Status</span>
                </div>
                {recentJobs.length === 0 ? <p className="px-3 py-6 text-center text-xs text-violet-100/45">No jobs have been reported.</p> :
                  recentJobs.map((job) => (
                    <div key={job.id} data-testid={`row-job-${job.id}`} className="grid grid-cols-[1.2fr_0.8fr_auto] items-center gap-2 border-b border-violet-100/[0.05] px-3 py-2.5 last:border-0">
                      <div className="min-w-0"><p className="truncate text-xs font-medium text-violet-50">{job.type} <span className="font-mono text-[10px] text-violet-100/40">#{job.id}</span></p><p className="truncate text-[10px] text-violet-100/40">{formatTime(job.createdAt)}</p></div>
                      <span className="truncate text-xs text-violet-100/55">{job.worker || "—"}</span>
                      <span className={`rounded-md px-2 py-1 text-[10px] font-medium capitalize ${job.status === "failed" ? "bg-rose-300/10 text-rose-200" : job.status === "done" ? "bg-emerald-300/10 text-emerald-200" : "bg-violet-300/10 text-violet-100/70"}`}>{job.status}</span>
                    </div>
                  ))}
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

        <article className={`${panel} p-5 sm:p-6`}>
          <SectionHeading eyebrow="Recognition policy" title="Review settings" detail="Tune the threshold and how long rejected reviews are retained." />
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
                <button type="submit" className={accentAction} disabled={settingsMutation.isPending || !settingsQuery.data}>
                  {settingsMutation.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}Save policy
                </button>
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
                <div className="overflow-x-auto">
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
                            <span className="truncate text-violet-100/65">{point.classroomName || "Unassigned"}</span>
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
                <div role="group" aria-label="Fan mode" className="grid grid-cols-3 gap-2">
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
      <p className="mt-2 truncate text-sm font-semibold text-violet-50">{value}</p>
      {sub && <p className="mt-0.5 truncate text-[10px] text-violet-100/40">{sub}</p>}
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
