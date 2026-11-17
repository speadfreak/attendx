import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useGetRecentActivity,
  getGetRecentActivityQueryKey,
} from "@workspace/api-client-react";
import { api, type CommandCenterSnapshot } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { GlowCard, SectionTitle, StatusBadge, StatusDot, MeshBackground, GlowEmpty } from "@/components/gx/Primitives";
import { RiskRadarCard } from "@/components/RiskRadarCard";
import { ChartSkeleton, FeedSkeletonRow, GlowSkeleton } from "@/components/gx/Skeletons";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, Legend
} from "recharts";
import {
  Users, School, UserCheck, UserX, AlertTriangle,
  MessageSquare, Activity, Zap, Eye, DoorOpen, LogOut, Wifi,
  Radio, Smartphone, ShieldAlert, Timer, TrendingUp, Clock,
} from "lucide-react";
import { format } from "date-fns";
import gsap from "gsap";
import { useToast } from "@/hooks/use-toast";
import { useLiveEvents } from "@/hooks/useLiveEvents";

// ── Honest query-failure panel (never look like an empty state) ──
function QueryErrorBox({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div
      className="gx-empty-tint flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center"
      role="alert"
    >
      <AlertTriangle className="w-7 h-7 text-destructive shrink-0" />
      <div>
        <p className="text-sm font-medium text-destructive">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
      </div>
      <button type="button" onClick={onRetry} className="st-badge st-badge-slate px-4 py-2">
        Retry
      </button>
    </div>
  );
}

// ── Animated stat card (glow design system) ────────────────
function StatCard({
  title, value, sub, icon: Icon, color, delay = 0, alert = false,
}: {
  title: string; value: string; sub?: React.ReactNode;
  icon: React.ElementType; color: string; delay?: number; alert?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    gsap.fromTo(cardRef.current,
      { opacity: 0, y: 30, scale: 0.95 },
      { opacity: 1, y: 0, scale: 1, duration: 0.6, delay, ease: "expo.out" }
    );
  }, [delay]);

  const handleEnter = () => gsap.to(cardRef.current, { y: -4, scale: 1.02, duration: 0.25, ease: "power2.out" });
  const handleLeave = () => gsap.to(cardRef.current, { y: 0, scale: 1, duration: 0.25, ease: "power2.out" });

  return (
    <div
      ref={cardRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className={`gx-stat gx-card gx-card-accent rounded-2xl p-5 relative overflow-hidden cursor-default ${alert ? "ring-1 ring-red-500/30" : ""}`}
    >
      <div
        className="absolute -bottom-6 -right-6 w-28 h-28 rounded-full blur-2xl opacity-20"
        style={{ background: `rgb(${color})` }}
      />
      <div className="relative z-10 flex items-start justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-foreground/40 mb-2">{title}</p>
          <p className="counter-num text-3xl text-foreground leading-none mb-2 gx-gradient-text">{value}</p>
          {sub && <div className="text-[11px] text-foreground/40">{sub}</div>}
        </div>
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: `rgba(${color},0.12)`,
            border: `1px solid rgba(${color},0.2)`,
            boxShadow: `0 0 12px rgba(${color},0.2)`,
          }}
        >
          <Icon size={18} style={{ color: `rgb(${color})` }} />
        </div>
      </div>
    </div>
  );
}

// ── Live ops ticker — every SSE event, newest first ─────────
function LiveOpsTicker() {
  const { events, status } = useLiveEvents();
  const recent = events.slice(0, 9);
  return (
    <GlowCard variant="gradient" className="p-5 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Radio size={13} className="text-cyan-400" />
          <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">LIVE OPS FEED</h3>
        </div>
        <span className={`st-badge ${status === "live" ? "st-badge-green" : status === "polling" ? "st-badge-amber" : "st-badge-slate"}`}>
          <StatusDot tone={status === "live" ? "green" : "amber"} pulse={status === "live"} />
          {status === "live" ? "PUSH LIVE" : status === "polling" ? "POLLING" : "CONNECTING"}
        </span>
      </div>
      {recent.length === 0 ? (
        <GlowEmpty icon={<Radio size={20} />} title="Awaiting live events" hint="Scans, SMS and device heartbeats stream here in realtime." />
      ) : (
        <div className="flex-1 overflow-y-auto max-h-64 pr-1 space-y-1.5">
          {recent.map((ev, i) => {
            const tone =
              ev.type === "attendance.created" ? "text-emerald-400" :
              ev.type === "sms.sent" ? "text-amber-400" :
              ev.type === "device.heartbeat" ? "text-violet-400" :
              ev.type === "qr.scan" ? "text-cyan-400" :
              ev.type.startsWith("attendance.absent") ? "text-red-400" :
              "text-foreground/40";
            const name = typeof ev.payload?.studentName === "string" ? ev.payload.studentName : "";
            const extra = typeof ev.payload?.status === "string" ? ` · ${ev.payload.status}` : "";
            const device = typeof ev.payload?.name === "string" ? ev.payload.name : "";
            return (
              <div
                key={`${ev.at}-${ev.type}-${i}`}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-foreground/10 bg-foreground/5 text-[11px] ${i === 0 ? "gx-slide-in" : ""}`}
              >
                <span className={`font-mono text-[9px] text-foreground/30 shrink-0`}>{format(new Date(ev.at), "HH:mm:ss")}</span>
                <Zap size={10} className={`${tone} shrink-0`} />
                <span className="text-foreground/70 font-medium shrink-0">{ev.type}</span>
                <span className="text-foreground/45 truncate">{name || device}{extra}</span>
              </div>
            );
          })}
        </div>
      )}
    </GlowCard>
  );
}

// ── Arrival pulse — today's check-ins hour by hour ──────────
function ArrivalPulse({ arrivals, loading, error, onRetry }: {
  arrivals?: CommandCenterSnapshot["arrivals"];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const data = useMemo(() => {
    if (!arrivals) return [];
    // trim to the school day window (05:00–20:00) for a dense, readable chart
    return arrivals.filter((_, h) => h >= 5 && h <= 19);
  }, [arrivals]);
  const peak = useMemo(() => {
    let best = 0;
    for (const a of data) best = Math.max(best, a.present + a.late);
    return best;
  }, [data]);
  const peakHour = useMemo(() => data.find((a) => a.present + a.late === peak)?.hour ?? "—", [data, peak]);

  return (
    <GlowCard variant="gradient" className="lg:col-span-2 p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <TrendingUp size={13} className="text-purple-400" />
          <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">ARRIVAL PULSE · TODAY</h3>
        </div>
        {peak > 0 && (
          <span className="st-badge st-badge-cyan"><Activity size={9} /> peak {peak} @ {peakHour}</span>
        )}
      </div>
      {error ? (
        <QueryErrorBox title="Failed to load arrival pulse" message={error.message} onRetry={onRetry} />
      ) : loading ? (
        <ChartSkeleton />
      ) : (
        <div className="h-56 sm:h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 10, left: -22, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="hour" stroke="hsl(var(--border))" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} interval={1} />
              <YAxis stroke="hsl(var(--border))" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} />
              <Tooltip
                contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--popover-border))", borderRadius: 10 }}
                itemStyle={{ color: "hsl(var(--popover-foreground))", fontSize: 11 }}
                cursor={{ fill: "rgba(155,91,255,0.06)" }}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }} />
              <Bar dataKey="present" name="Present" stackId="p" fill="#10b981" radius={[0, 0, 0, 0]} />
              <Bar dataKey="late" name="Late" stackId="p" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </GlowCard>
  );
}

// ── Classroom command grid — every room, one glance ─────────
function ClassroomCommandGrid({ snapshot, loading, error, onRetry }: {
  snapshot?: CommandCenterSnapshot;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <GlowCard variant="gradient" className="p-5">
        <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text mb-4">CLASSROOM COMMAND GRID</h3>
        <QueryErrorBox title="Failed to load classroom grid" message={error.message} onRetry={onRetry} />
      </GlowCard>
    );
  }
  const rooms = snapshot?.classrooms ?? [];
  return (
    <GlowCard variant="gradient" className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <School size={13} className="text-cyan-400" />
          <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">CLASSROOM COMMAND GRID</h3>
        </div>
        <Badge variant="outline" className="font-mono text-[10px] text-foreground/40 border-foreground/10">
          {rooms.length} rooms
        </Badge>
      </div>
      {loading ? (
        <ChartSkeleton height="h-48" />
      ) : rooms.length === 0 ? (
        <GlowEmpty icon={<School size={22} />} title="No classrooms yet" hint="Create classrooms and enroll students to light up the grid." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 max-h-96 overflow-y-auto pr-1">
          {rooms.map((r) => {
            const tone = r.attendanceRate >= 80 ? "green" : r.attendanceRate >= 55 ? "amber" : "red";
            const barColor = tone === "green" ? "#10b981" : tone === "amber" ? "#f59e0b" : "#ef4444";
            return (
              <div key={r.classroomId} className="rounded-xl border border-foreground/10 bg-foreground/5 p-3.5 hover:border-purple-500/30 transition-colors">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="text-xs font-semibold text-foreground/80 truncate">{r.classroomName}</p>
                  <span className="text-sm font-bold gx-gradient-text">{r.attendanceRate}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden mb-2.5">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(100, r.attendanceRate)}%`, background: barColor, boxShadow: `0 0 8px ${barColor}66` }} />
                </div>
                <div className="flex items-center gap-2 text-[10px] font-mono flex-wrap">
                  <span className="text-emerald-400">{r.presentCount} in</span>
                  {r.lateCount > 0 && <span className="text-amber-400">{r.lateCount} late</span>}
                  {r.absentCount > 0 && <span className="text-red-400">{r.absentCount} absent</span>}
                  <span className="text-foreground/30 ml-auto">{r.presentCount + r.absentCount}/{r.totalStudents}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </GlowCard>
  );
}

// ── Fleet + pipeline strip: nodes, SMS, reviews ──────────────
function CommandFleetStrip({ snapshot, loading }: { snapshot?: CommandCenterSnapshot; loading: boolean }) {
  if (loading || !snapshot) return null;
  const d = snapshot.devices;
  const sms = snapshot.sms;
  const cell = (
    icon: React.ElementType, label: string, value: string, color: string, badge?: React.ReactNode,
  ) => {
    const Icon = icon;
    return (
      <GlowCard variant="gradient" className="p-4 flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `rgba(${color},0.1)`, border: `1px solid rgba(${color},0.2)` }}
        >
          <Icon size={16} style={{ color: `rgb(${color})` }} />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-foreground/30">{label}</p>
          <p className="text-xs font-semibold text-foreground/75 mt-0.5 truncate">{value}</p>
        </div>
        <div className="ml-auto shrink-0">{badge ?? <StatusDot tone="green" pulse />}</div>
      </GlowCard>
    );
  };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {cell(
        Smartphone,
        "Gate camera nodes",
        `${d.online}/${d.total} online · ${d.phonesOnline}/${d.phones} phones`,
        "155,91,255",
        <StatusDot tone={d.online > 0 ? "green" : "red"} pulse={d.online > 0} />,
      )}
      {cell(
        MessageSquare,
        "SMS pipeline",
        `${sms.sentToday} sent · ${sms.queued} queued`,
        "34,197,94",
        sms.failedToday > 0
          ? <StatusBadge value="failed" label={`${sms.failedToday} failed`} tone="red" />
          : <StatusDot tone="green" pulse />,
      )}
      {cell(
        ShieldAlert,
        "Review queue",
        `${snapshot.reviewsPending} pending matches`,
        "245,158,11",
        <StatusDot tone={snapshot.reviewsPending > 0 ? "amber" : "green"} pulse={snapshot.reviewsPending > 0} />,
      )}
      {cell(
        Timer,
        "Parent alerts",
        snapshot.lastAbsentMark
          ? `Last absence marked ${format(new Date(snapshot.lastAbsentMark), "HH:mm")}`
          : "No absence marked today",
        "34,211,238",
        <StatusDot tone={snapshot.lastAbsentMark ? "red" : "green"} pulse />,
      )}
    </div>
  );
}

// ── Activity row with new-entry slide-in ───────────────────
function ActivityRow({ log, isNew }: { log: any; isNew?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between py-2.5 border-b border-foreground/10 last:border-0 ${isNew ? "gx-slide-in" : ""}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
          style={{ background: "linear-gradient(135deg, #7C3AED55, #9B5BFF33)" }}
        >
          {log.studentName?.charAt(0) || "?"}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground/80 truncate">{log.studentName}</p>
          <p className="text-[10px] text-foreground/30">
            {format(new Date(log.markedAt), "h:mm a")} · {log.classroomName || "—"}
          </p>
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0 ml-2">
        <StatusBadge value={log.status} />
        <StatusBadge value={log.method} />
      </div>
    </div>
  );
}

// ── Occupancy card: "who's in the building right now" ──────
function OccupancyCard() {
  const { toast } = useToast();
  const { data: occupancy, refetch, isLoading, isError, error } = useQuery<OccupancyType>({
    queryKey: ["occupancy"],
    queryFn: () => api.occupancy(),
    refetchInterval: 15000,
  });

  const checkOut = async (studentId: number, name: string) => {
    try {
      await api.checkOut(studentId);
      toast({ title: `${name} checked out`, description: "Removed from live occupancy." });
      void refetch();
    } catch (e: any) {
      toast({ title: "Check-out failed", description: e.message, variant: "destructive" });
    }
  };

  return (
    <GlowCard accent variant="gradient" className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 animate-ping" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
          </span>
          <h3 className="text-sm font-semibold text-foreground/70 uppercase tracking-widest">In the building now</h3>
        </div>
        <span className="counter-num text-2xl gx-gradient-text-green">{occupancy?.count ?? "—"}</span>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array(3).fill(0).map((_, i) => <GlowSkeleton key={i} className="h-9 !rounded-lg" />)}
        </div>
      ) : isError ? (
        <QueryErrorBox
          title="Failed to load occupancy"
          message={error instanceof Error ? error.message : "Unknown error"}
          onRetry={() => void refetch()}
        />
      ) : !occupancy?.people.length ? (
        <GlowEmpty icon={<DoorOpen size={20} />} title="Nobody inside" hint="Occupancy fills as students check in." />
      ) : (
        <div className="max-h-52 overflow-y-auto pr-1 space-y-1.5">
          {occupancy.people.map((p) => (
            <div key={p.studentId} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg bg-foreground/5 border border-foreground/10">
              <StatusDot tone={p.status === "late" ? "amber" : "green"} pulse />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-foreground/75 truncate">{p.studentName}</p>
                <p className="text-[9px] text-foreground/25">{p.classroomName || "—"} · since {format(new Date(p.since), "HH:mm")}</p>
              </div>
              <button
                onClick={() => checkOut(p.studentId, p.studentName)}
                className="st-badge st-badge-slate hover:bg-red-500/15 hover:text-red-400 transition-colors"
                title="Mark check-out"
              >
                <LogOut size={10} /> out
              </button>
            </div>
          ))}
        </div>
      )}
      {!!occupancy?.checkedOut && (
        <p className="text-[10px] text-foreground/25 mt-3 flex items-center gap-1">
          <Wifi size={10} /> {occupancy.checkedOut} checked out today
        </p>
      )}
    </GlowCard>
  );
}

type OccupancyType = Awaited<ReturnType<typeof api.occupancy>>;

// ── Weekly trend ────────────────────────────────────────────
function TrendChart({
  trend, loading,
}: {
  trend?: Array<{ date: string; present: number; absent: number; late: number }>;
  loading: boolean;
}) {
  return (
    <div className="h-56 sm:h-72 w-full">
      {loading ? (
        <ChartSkeleton />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={trend || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="gPresent" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gAbsent" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gLate" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="date" stroke="hsl(var(--border))" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              tickFormatter={(v) => { try { return format(new Date(v), "MMM d"); } catch { return v; } }}
            />
            <YAxis stroke="hsl(var(--border))" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
            <Tooltip
              contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--popover-border))", borderRadius: 10 }}
              itemStyle={{ color: "hsl(var(--popover-foreground))", fontSize: 11 }}
              labelFormatter={(v) => { try { return format(new Date(v), "MMM d, yyyy"); } catch { return v; } }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }} />
            <Area type="monotone" dataKey="present" name="Present" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#gPresent)" />
            <Area type="monotone" dataKey="late" name="Late" stroke="#f59e0b" strokeWidth={2} fillOpacity={1} fill="url(#gLate)" />
            <Area type="monotone" dataKey="absent" name="Absent" stroke="#ef4444" strokeWidth={2} fillOpacity={1} fill="url(#gAbsent)" />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── Main: CAMPUS COMMAND CENTER ────────────────────────────
export default function DashboardPage() {
  const headerRef = useRef<HTMLDivElement>(null);
  const [seenActivityIds, setSeenActivityIds] = useState<Set<number>>(new Set());
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [clock, setClock] = useState("");

  const { data: snapshot, isLoading: ccLoading, isError: ccError, error: ccErr, refetch: refetchCc, isFetching: ccFetching } = useQuery<CommandCenterSnapshot>({
    queryKey: ["command-center"],
    queryFn: api.commandCenter,
    refetchInterval: 15000,
  });
  const { data: activity, isLoading: activityLoading, isError: activityError, error: activityErr, refetch: refetchActivity } = useGetRecentActivity({ query: { queryKey: getGetRecentActivityQueryKey(), refetchInterval: 30000 } });
  const { data: trend, isLoading: trendLoading, isError: trendError, error: trendErr, refetch: refetchTrend } = useQuery({
    queryKey: ["attendance-trend", "week"],
    queryFn: () => api.trend("week"),
    refetchInterval: 60000,
  });

  const tz = snapshot?.timezone ?? "Africa/Addis_Ababa";

  // live school-timezone clock
  useEffect(() => {
    const tick = () => {
      try {
        setClock(new Intl.DateTimeFormat("en-GB", {
          timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
        }).format(new Date()));
      } catch {
        setClock(new Date().toLocaleTimeString());
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [tz]);

  // Detect genuinely-new feed entries → slide-in animation
  useEffect(() => {
    if (!activity?.length) return;
    const ids = new Set(activity.map((a) => a.id));
    const fresh = new Set<number>();
    for (const id of ids) {
      if (!seenActivityIds.has(id)) fresh.add(id);
    }
    if (seenActivityIds.size > 0 && fresh.size > 0) setNewIds(fresh);
    setSeenActivityIds(ids);
    if (fresh.size > 0) {
      const t = setTimeout(() => setNewIds(new Set()), 2000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [activity]);

  useEffect(() => {
    gsap.fromTo(headerRef.current,
      { opacity: 0, y: -10 },
      { opacity: 1, y: 0, duration: 0.5, ease: "expo.out" }
    );
  }, []);

  const stats = snapshot?.stats;
  const rate = stats ? `${stats.attendanceRate}%` : "—";

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5 max-w-7xl mx-auto pb-2">
        {/* ── Command header ── */}
        <div ref={headerRef} className="gx-page-header flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <SectionTitle className="gx-title-gradient" sub={<>WHOLE-CAMPUS LIVE COMMAND · EVERY GATE · EVERY ROOM · EVERY PARENT</>}>
            CAMPUS COMMAND CENTER
          </SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="gx-glow-hover flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] text-purple-300/60 border border-purple-500/15 font-mono"
              style={{ background: "rgba(124,58,237,0.06)" }}
            >
              <Clock size={12} className="text-purple-400" />
              <span className="tabular-nums">{clock || "--:--:--"}</span>
              <span className="text-foreground/30">({tz})</span>
            </div>
            <div
              className="gx-glow-hover flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] text-foreground/50 border border-foreground/10"
            >
              <Eye size={12} className="text-purple-400" />
              {format(new Date(), "EEEE, MMM d yyyy")}
            </div>
            {ccFetching && !ccLoading && (
              <span className="st-badge st-badge-cyan"><RefreshSpin /> sync</span>
            )}
          </div>
        </div>

        {/* ── KPI wall ── */}
        {ccError ? (
          <QueryErrorBox
            title="Failed to load the command center snapshot"
            message={ccErr instanceof Error ? ccErr.message : "Unknown error"}
            onRetry={() => void refetchCc()}
          />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
            {ccLoading || !stats ? (
              Array(6).fill(0).map((_, i) => <GlowSkeleton key={i} className="h-28" />)
            ) : (
              <>
                <StatCard title="Attendance Rate" value={rate} sub="Whole campus today" icon={Activity} color="155,91,255" delay={0.05} />
                <StatCard
                  title="Present"
                  value={`${stats.presentToday}/${stats.totalStudents}`}
                  sub={<span className="st-amber">{stats.lateToday} late arrivals</span>}
                  icon={UserCheck} color="34,197,94" delay={0.1}
                />
                <StatCard
                  title="Absent"
                  value={String(stats.absentToday)}
                  sub={<span className="text-red-400/80">parents auto-alerted</span>}
                  icon={UserX} color="239,68,68" delay={0.15}
                  alert={stats.absentToday > 0}
                />
                <StatCard
                  title="Inside Now"
                  value={String(snapshot?.occupancy.inside ?? 0)}
                  sub={<span>{snapshot?.occupancy.checkedOut ?? 0} checked out</span>}
                  icon={DoorOpen} color="34,211,238" delay={0.2}
                />
                <StatCard
                  title="Parent SMS"
                  value={String(stats.smsSentToday)}
                  sub={<span>{snapshot?.sms.queued ?? 0} queued · {snapshot?.sms.failedToday ?? 0} failed</span>}
                  icon={MessageSquare} color="245,158,11" delay={0.25}
                />
                <StatCard
                  title="Campus Scale"
                  value={String(stats.totalStudents)}
                  sub={<span>{stats.totalClassrooms} classrooms monitored</span>}
                  icon={Users} color="124,58,237" delay={0.3}
                />
              </>
            )}
          </div>
        )}

        {/* ── Arrival pulse + live ops feed ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ArrivalPulse
            arrivals={snapshot?.arrivals}
            loading={ccLoading}
            error={ccError ? (ccErr instanceof Error ? ccErr : new Error("Unknown")) : null}
            onRetry={() => void refetchCc()}
          />
          <LiveOpsTicker />
        </div>

        {/* ── Weekly trend + occupancy ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <GlowCard variant="gradient" className="lg:col-span-2 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">7-DAY ATTENDANCE TREND</h3>
              <span className="st-badge st-badge-slate">campus-wide</span>
            </div>
            {trendError ? (
              <QueryErrorBox
                title="Failed to load attendance trend"
                message={trendErr instanceof Error ? trendErr.message : "Unknown error"}
                onRetry={() => void refetchTrend()}
              />
            ) : (
              <TrendChart trend={trend} loading={trendLoading} />
            )}
          </GlowCard>

          <OccupancyCard />
        </div>

        {/* ── Classroom command grid ── */}
        <ClassroomCommandGrid
          snapshot={snapshot}
          loading={ccLoading}
          error={ccError ? (ccErr instanceof Error ? ccErr : new Error("Unknown")) : null}
          onRetry={() => void refetchCc()}
        />

        {/* ── Fleet + pipeline strip ── */}
        <CommandFleetStrip snapshot={snapshot} loading={ccLoading} />

        {/* ── Live check-in feed ── */}
        <GlowCard variant="gradient" className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Zap size={13} className="text-purple-400" />
              <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">LATEST CHECK-INS</h3>
            </div>
            <StatusBadge value="valid" label="REALTIME" tone="green" />
          </div>
          <div className="max-h-72 overflow-y-auto pr-1">
            {activityLoading ? (
              <FeedSkeletonRow />
            ) : activityError ? (
              <QueryErrorBox
                title="Failed to load live feed"
                message={activityErr instanceof Error ? activityErr.message : "Unknown error"}
                onRetry={() => void refetchActivity()}
              />
            ) : !activity?.length ? (
              <GlowEmpty icon={<Zap size={22} />} title="No activity today" hint="Check-ins will stream in live." />
            ) : (
              activity.map((log) => <ActivityRow key={log.id} log={log} isNew={newIds.has(log.id)} />)
            )}
          </div>
        </GlowCard>

        {/* ── Absence Risk Radar ── */}
        <RiskRadarCard />
      </div>
    </div>
  );
}

function RefreshSpin() {
  return <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />;
}
