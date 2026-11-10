import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type FraudSignal,
  type FraudSignalSeverity,
  type FraudSignalStatus,
  type FraudSummary,
} from "@/lib/api";
import { GlowCard, MeshBackground, SectionTitle, GlowEmpty } from "@/components/gx/Primitives";
import { FeedSkeletonRow } from "@/components/gx/Skeletons";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Rocket,
  Users,
  MapPinOff,
  Network,
  Check,
  X,
  EyeOff,
  RotateCcw,
  ChevronDown,
  Fingerprint,
} from "lucide-react";

/**
 * FRAUD RADAR — Phase 6 proxy-fraud signals (lib/fraud.ts engine output).
 * Staff triage: filter, review evidence, then acknowledge / resolve / dismiss
 * each signal. Summary tiles poll every 30s; list uses offset pagination.
 */

const PAGE_SIZE = 25;

const KIND_META: Record<string, { label: string; icon: typeof TrendingUp }> = {
  impossible_travel: { label: "Impossible travel", icon: TrendingUp },
  burst_scan: { label: "Burst scan", icon: Rocket },
  badge_sharing: { label: "Badge sharing", icon: Users },
  proxy_farm: { label: "Proxy farm", icon: Network },
  geofence_violation: { label: "Geofence violation", icon: MapPinOff },
};

const KINDS = Object.keys(KIND_META) as Array<keyof typeof KIND_META>;

/** severity → chip class + score-bar fill (no blue/indigo: red/amber/slate family). */
const SEVERITY_META: Record<FraudSignalSeverity, { label: string; chip: string; bar: string }> = {
  critical: { label: "Critical", chip: "st-badge st-badge-red", bar: "bg-red-500" },
  high: { label: "High", chip: "st-badge st-badge-amber", bar: "bg-amber-500" },
  medium: {
    label: "Medium",
    chip: "st-badge border-amber-500/15 bg-amber-500/[0.06] text-amber-200/80",
    bar: "bg-amber-500/60",
  },
  low: { label: "Low", chip: "st-badge st-badge-slate", bar: "bg-slate-500" },
};

const STATUS_KEYS = ["open", "acknowledged", "resolved", "dismissed"] as const;
const SEVERITY_KEYS = ["critical", "high", "medium", "low"] as const;

const STATUS_META: Record<FraudSignalStatus, { label: string; chip: string }> = {
  open: { label: "Open", chip: "bg-red-500/10 border-red-500/30 text-red-300" },
  acknowledged: { label: "Ack", chip: "bg-amber-500/10 border-amber-500/30 text-amber-300" },
  resolved: { label: "Resolved", chip: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" },
  dismissed: { label: "Dismissed", chip: "bg-white/[0.04] border-white/10 text-white/40" },
};

/** Radix Select can't use empty-string values — "all" is the sentinel. */
const ALL = "all";

/** Parse the structured evidence JSON into compact key/value chips. */
function evidencePairs(evidence: string | null): Array<[string, string]> {
  if (!evidence) return [];
  try {
    const obj = JSON.parse(evidence) as Record<string, unknown>;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return Object.entries(obj)
        .slice(0, 4)
        .map(([k, v]) => [k, String(v)] as [string, string]);
    }
    return [];
  } catch {
    return [[ "raw", evidence.slice(0, 80) ] as [string, string]];
  }
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

/** Score mini progress bar (0-100) tinted by severity. */
function ScoreBar({ score, severity }: { score: number; severity: FraudSignalSeverity }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="h-1.5 flex-1 rounded-full bg-white/[0.06] overflow-hidden" role="presentation">
        <div className={`h-full rounded-full ${SEVERITY_META[severity].bar}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-white/40 w-8 text-right shrink-0">{pct}</span>
    </div>
  );
}

type DecideAction = "acknowledged" | "resolved" | "dismissed";

export default function FraudSignalsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── filters ──
  const [status, setStatus] = useState<FraudSignalStatus | typeof ALL>(ALL);
  const [kind, setKind] = useState<string>(ALL);
  const [severity, setSeverity] = useState<FraudSignalSeverity | typeof ALL>(ALL);

  // ── decide dialog ──
  const [decideTarget, setDecideTarget] = useState<{ signal: FraudSignal; action: DecideAction } | null>(null);
  const [decideNote, setDecideNote] = useState("");
  const [deciding, setDeciding] = useState(false);

  // ── queries ──
  const summaryQuery = useQuery<FraudSummary>({
    queryKey: ["fraud-summary"],
    queryFn: api.fraudSummary,
    refetchInterval: 30000, // summary only — list refetches on decide / filters
  });

  const filters = {
    status: status === ALL ? undefined : status,
    kind: kind === ALL ? undefined : kind,
    severity: severity === ALL ? undefined : severity,
    limit: PAGE_SIZE,
  };
  const filtersKey = JSON.stringify(filters);

  const listQuery = useInfiniteQuery({
    queryKey: ["fraud-signals", filtersKey],
    queryFn: ({ pageParam }) => api.listFraudSignals({ ...filters, offset: pageParam as number }),
    initialPageParam: 0,
    getNextPageParam: (last, allPages) =>
      last.length === PAGE_SIZE ? allPages.length * PAGE_SIZE : undefined,
  });

  const signals = useMemo(
    () => listQuery.data?.pages.flatMap((p) => p) ?? [],
    [listQuery.data],
  );

  const summary = summaryQuery.data;

  const openDecide = (signal: FraudSignal, action: DecideAction) => {
    setDecideNote("");
    setDecideTarget({ signal, action });
  };

  const submitDecide = async () => {
    if (!decideTarget) return;
    setDeciding(true);
    try {
      await api.decideFraudSignal(decideTarget.signal.id, {
        status: decideTarget.action,
        note: decideNote.trim() || undefined,
      });
      toast({
        title: `Signal ${decideTarget.action}`,
        description: `#${decideTarget.signal.id} marked ${decideTarget.action}.`,
      });
      setDecideTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["fraud-signals"] });
      void queryClient.invalidateQueries({ queryKey: ["fraud-summary"] });
      void queryClient.invalidateQueries({ queryKey: ["fraud-summary-nav"] }); // sidebar badge
    } catch (e: any) {
      toast({ title: "Decision failed", description: e.message, variant: "destructive" });
    } finally {
      setDeciding(false);
    }
  };

  const hasFilters = status !== ALL || kind !== ALL || severity !== ALL;
  const resetFilters = () => {
    setStatus(ALL);
    setKind(ALL);
    setSeverity(ALL);
  };

  const actionable = (s: FraudSignal) => s.status === "open" || s.status === "acknowledged";

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5 max-w-6xl mx-auto pb-6">
        <div className="gx-page-header">
          <SectionTitle className="gx-title-gradient" sub="PROXY-FRAUD SIGNALS · TRIAGE & DECIDE">FRAUD RADAR</SectionTitle>
        </div>

        {/* ── Summary chips ─────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_KEYS.map((k) => {
            const meta = STATUS_META[k];
            const count = summary?.byStatus?.[k] ?? 0;
            const active = status === k;
            return (
              <button
                key={k}
                onClick={() => setStatus(active ? ALL : k)}
                className={`min-h-11 inline-flex items-center gap-2 px-3.5 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
                  active
                    ? meta.chip + " ring-1 ring-white/20"
                    : meta.chip + " opacity-80 hover:opacity-100"
                }`}
              >
                {meta.label}
                <span className="font-mono text-[11px] opacity-70">{count}</span>
              </button>
            );
          })}
          {(summary?.openCritical ?? 0) > 0 && (
            <span
              className="min-h-11 inline-flex items-center gap-2 px-3.5 rounded-xl border border-red-500/50 bg-red-500/20 text-red-200 text-xs font-bold"
              style={{ boxShadow: "0 0 18px rgba(239,68,68,0.25)" }}
            >
              <ShieldAlert size={14} className="animate-pulse" />
              {summary!.openCritical} critical open
            </span>
          )}
        </div>

        {/* ── Filters ───────────────────────────────────── */}
        <GlowCard hover={false} variant="gradient" className="p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={status} onValueChange={(v) => setStatus(v as FraudSignalStatus | typeof ALL)}>
              <SelectTrigger className="h-11 w-[150px] text-xs bg-black/30 border-white/10" aria-label="Filter by status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {STATUS_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>{STATUS_META[k].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger className="h-11 w-[180px] text-xs bg-black/30 border-white/10" aria-label="Filter by kind">
                <SelectValue placeholder="Kind" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All kinds</SelectItem>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>{KIND_META[k].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={severity} onValueChange={(v) => setSeverity(v as FraudSignalSeverity | typeof ALL)}>
              <SelectTrigger className="h-11 w-[150px] text-xs bg-black/30 border-white/10" aria-label="Filter by severity">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All severities</SelectItem>
                {SEVERITY_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>{SEVERITY_META[k].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="ghost"
              onClick={resetFilters}
              disabled={!hasFilters}
              className="h-11 px-3 text-xs text-white/40 hover:text-white/80 hover:bg-white/5"
            >
              <RotateCcw size={13} className="mr-1.5" /> Reset
            </Button>

            <span className="ml-auto text-[10px] font-mono text-white/25 hidden sm:block">
              {signals.length} shown
            </span>
          </div>
        </GlowCard>

        {/* ── Signal list ───────────────────────────────── */}
        {listQuery.isLoading ? (
          <div className="space-y-3"><FeedSkeletonRow rows={4} /></div>
        ) : listQuery.isError ? (
          <GlowCard variant="gradient" className="gx-empty-tint p-6">
            <GlowEmpty
              icon={<ShieldAlert size={26} />}
              title="Couldn't load signals"
              hint={(listQuery.error as Error).message}
            />
          </GlowCard>
        ) : signals.length === 0 ? (
          <GlowCard variant="gradient" className="gx-empty-tint p-6">
            <GlowEmpty
              icon={<ShieldCheck size={26} />}
              title={hasFilters ? "No signals match these filters" : "No signals — campus is clean"}
              hint={
                hasFilters
                  ? "Try widening the filters or reset them."
                  : "The fraud engine watches every scan for proxy patterns — anything suspicious lands here."
              }
            />
          </GlowCard>
        ) : (
          <div className="space-y-3">
            {signals.map((s) => {
              const sev = (SEVERITY_KEYS as readonly string[]).includes(s.severity)
                ? (s.severity as FraudSignalSeverity)
                : "low";
              const kindMeta = KIND_META[s.kind] ?? { label: s.kind, icon: Fingerprint };
              const KindIcon = kindMeta.icon;
              const stKey = (STATUS_KEYS as readonly string[]).includes(s.status)
                ? (s.status as FraudSignalStatus)
                : null;
              const evPairs = evidencePairs(s.evidence);
              const related = s.relatedScanIds?.length ?? 0;
              return (
                <GlowCard key={s.id} variant="gradient" className="gx-glow-hover p-4 sm:p-5">
                  {/* header row */}
                  <div className="flex items-start gap-3">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                      style={{
                        background: sev === "critical" ? "rgba(239,68,68,0.10)" : "rgba(245,158,11,0.10)",
                        border: `1px solid ${sev === "critical" ? "rgba(239,68,68,0.25)" : "rgba(245,158,11,0.25)"}`,
                      }}
                    >
                      <KindIcon size={17} className={sev === "critical" ? "text-red-400" : "text-amber-400"} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="text-sm font-semibold text-white/85 truncate">
                          {s.studentName ?? "Unknown student"}
                        </p>
                        <span className="text-[11px] text-white/35">{kindMeta.label}</span>
                        <span className={SEVERITY_META[sev].chip}>{SEVERITY_META[sev].label}</span>
                        {stKey && (
                          <span className={`st-badge ${STATUS_META[stKey].chip}`}>{STATUS_META[stKey].label}</span>
                        )}
                      </div>
                      <p className="text-[10px] text-white/30 mt-0.5">
                        #{s.id} · {relTime(s.createdAt)}
                      </p>
                    </div>
                  </div>

                  {/* detail */}
                  {s.detail && (
                    <p className="text-xs text-white/50 mt-3 leading-relaxed break-words">{s.detail}</p>
                  )}

                  {/* score bar */}
                  <div className="mt-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[9px] uppercase tracking-widest text-white/30">Fraud score</span>
                    </div>
                    <ScoreBar score={s.score} severity={sev} />
                  </div>

                  {/* meta chips */}
                  <div className="flex flex-wrap items-center gap-1.5 mt-3">
                    {s.terminalId && <span className="st-badge st-badge-slate font-mono">term {s.terminalId}</span>}
                    {s.gateId && <span className="st-badge st-badge-cyan font-mono">gate {s.gateId}</span>}
                    {related > 0 && (
                      <span className="st-badge st-badge-slate" title={`Related scan ids: ${s.relatedScanIds.join(", ")}`}>
                        +{related} related scan{related === 1 ? "" : "s"}
                      </span>
                    )}
                    {evPairs.map(([k, v]) => (
                      <span key={k} className="st-badge st-badge-slate font-mono text-[9px]">
                        {k}: {v}
                      </span>
                    ))}
                  </div>

                  {/* resolution info or actions */}
                  {actionable(s) ? (
                    <div className="flex flex-col sm:flex-row gap-2 mt-4">
                      {s.status === "open" && (
                        <button
                          disabled={listQuery.isFetching}
                          onClick={() => openDecide(s, "acknowledged")}
                          className="min-h-11 flex-1 py-2.5 rounded-lg text-xs font-semibold text-amber-200 bg-amber-500/12 border border-amber-500/25 hover:bg-amber-500/20 transition-all disabled:opacity-40"
                        >
                          <Check size={13} className="inline mr-1.5" /> Acknowledge
                        </button>
                      )}
                      <button
                        disabled={listQuery.isFetching}
                        onClick={() => openDecide(s, "resolved")}
                        className="min-h-11 flex-1 py-2.5 rounded-lg text-xs font-semibold text-emerald-200 bg-emerald-500/12 border border-emerald-500/25 hover:bg-emerald-500/20 transition-all disabled:opacity-40"
                      >
                        <Check size={13} className="inline mr-1.5" /> Resolve
                      </button>
                      <button
                        disabled={listQuery.isFetching}
                        onClick={() => openDecide(s, "dismissed")}
                        className="min-h-11 flex-1 py-2.5 rounded-lg text-xs font-semibold text-white/60 bg-white/[0.04] border border-white/10 hover:bg-white/10 transition-all disabled:opacity-40"
                      >
                        <EyeOff size={13} className="inline mr-1.5" /> Dismiss
                      </button>
                    </div>
                  ) : (
                    (s.resolvedAt || s.resolveNote) && (
                      <p className="text-[10px] text-white/30 mt-3">
                        {s.resolveNote ? `Note: ${s.resolveNote} · ` : ""}
                        decided {relTime(s.resolvedAt)}
                      </p>
                    )
                  )}
                </GlowCard>
              );
            })}

            {/* load more */}
            {listQuery.hasNextPage && (
              <div className="flex justify-center pt-1">
                <Button
                  variant="ghost"
                  onClick={() => void listQuery.fetchNextPage()}
                  disabled={listQuery.isFetchingNextPage}
                  className="min-h-11 px-6 text-xs text-white/50 hover:text-white/85 hover:bg-white/5 border border-white/10"
                >
                  {listQuery.isFetchingNextPage ? (
                    "Loading…"
                  ) : (
                    <>
                      Load more <ChevronDown size={14} className="ml-1.5" />
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Decide confirm dialog ──────────────────────── */}
      <Dialog open={!!decideTarget} onOpenChange={(o) => { if (!o) setDecideTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white/90">
              <ShieldAlert size={16} className="text-amber-400" />
              {decideTarget?.action === "acknowledged" && "Acknowledge signal"}
              {decideTarget?.action === "resolved" && "Resolve signal"}
              {decideTarget?.action === "dismissed" && "Dismiss signal"}
            </DialogTitle>
            <DialogDescription>
              {decideTarget?.action === "acknowledged" &&
                "Mark that you've seen this signal. It stays on the radar but leaves the open queue."}
              {decideTarget?.action === "resolved" &&
                "Close this signal as handled — use this when fraud was confirmed and dealt with."}
              {decideTarget?.action === "dismissed" &&
                "Dismiss as a false positive. The dedupe window still applies until it expires."}
              {decideTarget && (
                <span className="block mt-2 text-white/50">
                  Signal #{decideTarget.signal.id}
                  {decideTarget.signal.studentName ? ` · ${decideTarget.signal.studentName}` : ""}
                  {" · "}
                  {KIND_META[decideTarget.signal.kind]?.label ?? decideTarget.signal.kind}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={decideNote}
            onChange={(e) => setDecideNote(e.target.value)}
            placeholder="Optional note (max 500 chars) — context for the audit trail…"
            rows={3}
            maxLength={500}
            className="text-xs"
          />
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setDecideTarget(null)}
              disabled={deciding}
              className="min-h-11 text-white/50 hover:text-white/85"
            >
              <X size={14} className="mr-1.5" /> Cancel
            </Button>
            <Button
              onClick={() => void submitDecide()}
              disabled={deciding}
              className="min-h-11 bg-purple-600 hover:bg-purple-500 text-white"
            >
              <Check size={14} className="mr-1.5" />
              {deciding ? "Saving…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

