import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useGetDashboardStats,
  useGetRecentActivity,
  useGetClassroomSummary,
  getGetDashboardStatsQueryKey,
  getGetRecentActivityQueryKey,
  getGetClassroomSummaryQueryKey,
} from "@workspace/api-client-react";
import { api, type Occupancy } from "@/lib/api";
import { GlowCard, SectionTitle, StatusBadge, StatusDot, MeshBackground, GlowEmpty } from "@/components/gx/Primitives";
import { ChartSkeleton, FeedSkeletonRow, GlowSkeleton } from "@/components/gx/Skeletons";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, Legend
} from "recharts";
import {
  Users, School, UserCheck, UserX,
  MessageSquare, Activity, Zap, Eye, DoorOpen, LogOut, Wifi,
} from "lucide-react";
import { format } from "date-fns";
import gsap from "gsap";
import { useToast } from "@/hooks/use-toast";

// ── Animated stat card (glow design system) ────────────────
function StatCard({
  title, value, sub, icon: Icon, color, delay = 0,
}: {
  title: string; value: string; sub?: React.ReactNode;
  icon: React.ElementType; color: string; delay?: number;
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
      className="gx-card gx-card-accent rounded-2xl p-5 relative overflow-hidden cursor-default"
    >
      <div
        className="absolute -bottom-6 -right-6 w-28 h-28 rounded-full blur-2xl opacity-20"
        style={{ background: `rgb(${color})` }}
      />
      <div className="relative z-10 flex items-start justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-white/40 mb-2">{title}</p>
          <p className="counter-num text-3xl text-white leading-none mb-2 gx-gradient-text">{value}</p>
          {sub && <div className="text-[11px] text-white/40">{sub}</div>}
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

// ── Activity row with new-entry slide-in ───────────────────
function ActivityRow({ log, isNew }: { log: any; isNew?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between py-2.5 border-b border-white/5 last:border-0 ${isNew ? "gx-slide-in" : ""}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
          style={{ background: "linear-gradient(135deg, #7C3AED55, #9B5BFF33)" }}
        >
          {log.studentName?.charAt(0) || "?"}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-white/80 truncate">{log.studentName}</p>
          <p className="text-[10px] text-white/30">
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
  const { data: occupancy, refetch, isLoading } = useQuery<Occupancy>({
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
    <GlowCard accent className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 animate-ping" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
          </span>
          <h3 className="text-sm font-semibold text-white/70 uppercase tracking-widest">In the building now</h3>
        </div>
        <span className="counter-num text-2xl gx-gradient-text-green">{occupancy?.count ?? "—"}</span>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array(3).fill(0).map((_, i) => <GlowSkeleton key={i} className="h-9 !rounded-lg" />)}
        </div>
      ) : !occupancy?.people.length ? (
        <GlowEmpty icon={<DoorOpen size={20} />} title="Nobody inside" hint="Occupancy fills as students check in." />
      ) : (
        <div className="max-h-52 overflow-y-auto pr-1 space-y-1.5">
          {occupancy.people.map((p) => (
            <div key={p.studentId} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg bg-white/[0.02] border border-white/5">
              <StatusDot tone={p.status === "late" ? "amber" : "green"} pulse />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-white/75 truncate">{p.studentName}</p>
                <p className="text-[9px] text-white/25">{p.classroomName || "—"} · since {format(new Date(p.since), "HH:mm")}</p>
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
        <p className="text-[10px] text-white/25 mt-3 flex items-center gap-1">
          <Wifi size={10} /> {occupancy.checkedOut} checked out today
        </p>
      )}
    </GlowCard>
  );
}

// ── Classroom Monitor with range toggle ────────────────────
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
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(155,91,255,0.08)" vertical={false} />
            <XAxis
              dataKey="date" stroke="rgba(255,255,255,0.2)" tick={{ fontSize: 10 }}
              tickFormatter={(v) => { try { return format(new Date(v), "MMM d"); } catch { return v; } }}
            />
            <YAxis stroke="rgba(255,255,255,0.2)" tick={{ fontSize: 10 }} />
            <Tooltip
              contentStyle={{ backgroundColor: "#0d0515", borderColor: "rgba(155,91,255,0.25)", borderRadius: 10 }}
              itemStyle={{ color: "#e2d9f3", fontSize: 11 }}
              labelFormatter={(v) => { try { return format(new Date(v), "MMM d, yyyy"); } catch { return v; } }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }} />
            <Area type="monotone" dataKey="present" name="Present" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#gPresent)" />
            <Area type="monotone" dataKey="late" name="Late" stroke="#f59e0b" strokeWidth={2} fillOpacity={1} fill="url(#gLate)" />
            <Area type="monotone" dataKey="absent" name="Absent" stroke="#ef4444" strokeWidth={2} fillOpacity={1} fill="url(#gAbsent)" />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────
export default function DashboardPage() {
  const headerRef = useRef<HTMLDivElement>(null);
  const [trendRange, setTrendRange] = useState<"today" | "week" | "month">("week");
  const [seenActivityIds, setSeenActivityIds] = useState<Set<number>>(new Set());
  const [newIds, setNewIds] = useState<Set<number>>(new Set());

  const { data: stats, isLoading: statsLoading } = useGetDashboardStats({ query: { queryKey: getGetDashboardStatsQueryKey(), refetchInterval: 30000 } });
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity({ query: { queryKey: getGetRecentActivityQueryKey(), refetchInterval: 30000 } });
  const { data: classroomStats, isLoading: classroomsLoading } = useGetClassroomSummary({ query: { queryKey: getGetClassroomSummaryQueryKey(), refetchInterval: 30000 } });
  const trendRangeRef = useRef(trendRange);
  trendRangeRef.current = trendRange;
  const { data: trend, isLoading: trendLoading } = useQuery({
    queryKey: ["attendance-trend", trendRange],
    queryFn: () => api.trend(trendRange),
    refetchInterval: 60000,
  });

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

  const rate = stats?.attendanceRate !== undefined ? `${stats.attendanceRate}%` : "—";

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-6 max-w-7xl mx-auto">
        {/* ── Header ── */}
        <div ref={headerRef} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <SectionTitle sub={<>LIVE MONITORING ACTIVE · REALTIME PUSH</>}>
            SYSTEM OVERVIEW
          </SectionTitle>
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] text-purple-300/60 border border-purple-500/15"
            style={{ background: "rgba(124,58,237,0.06)" }}
          >
            <Eye size={12} className="text-purple-400" />
            {format(new Date(), "EEEE, MMM d yyyy")}
          </div>
        </div>

        {/* ── Stats Grid ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {statsLoading ? (
            Array(4).fill(0).map((_, i) => <GlowSkeleton key={i} className="h-28" />)
          ) : (
            <>
              <StatCard title="Attendance Rate" value={rate} sub="Today's completion" icon={Activity} color="155,91,255" delay={0.1} />
              <StatCard
                title="Present / Total"
                value={`${stats?.presentToday ?? 0}/${stats?.totalStudents ?? 0}`}
                sub={<><span className="st-amber">{stats?.lateToday ?? 0} late</span> · <span className="st-red">{stats?.absentToday ?? 0} absent</span></>}
                icon={UserCheck} color="34,197,94" delay={0.18}
              />
              <StatCard title="Active Classrooms" value={String(stats?.totalClassrooms ?? 0)} sub="Monitored zones" icon={School} color="34,211,238" delay={0.26} />
              <StatCard title="SMS Sent Today" value={String(stats?.smsSentToday ?? 0)} sub="Parent notifications" icon={MessageSquare} color="245,158,11" delay={0.34} />
            </>
          )}
        </div>

        {/* ── Charts Row ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <GlowCard className="lg:col-span-2 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">ATTENDANCE TREND</h3>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-black/30 border border-white/5">
                {(["today", "week", "month"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setTrendRange(r)}
                    className={`px-2.5 py-1 rounded-md text-[10px] uppercase font-semibold tracking-wider transition-all ${
                      trendRange === r
                        ? "bg-purple-600/30 text-purple-200 shadow-[0_0_10px_rgba(155,91,255,0.3)]"
                        : "text-white/35 hover:text-white/60"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <TrendChart trend={trend} loading={trendLoading} />
          </GlowCard>

          <OccupancyCard />
        </div>

        {/* ── Live feed + Classroom monitor ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <GlowCard className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Zap size={13} className="text-purple-400" />
                <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">LIVE FEED</h3>
              </div>
              <StatusBadge value="valid" label="REALTIME" tone="green" />
            </div>
            <div className="max-h-72 overflow-y-auto pr-1">
              {activityLoading ? (
                <FeedSkeletonRow />
              ) : !activity?.length ? (
                <GlowEmpty icon={<Zap size={22} />} title="No activity today" hint="Check-ins will stream in live." />
              ) : (
                activity.map((log) => <ActivityRow key={log.id} log={log} isNew={newIds.has(log.id)} />)
              )}
            </div>
          </GlowCard>

          <GlowCard className="lg:col-span-2 p-5">
            <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text mb-4">CLASSROOM MONITOR</h3>
            {classroomsLoading ? (
              <ChartSkeleton height="h-52 sm:h-64" />
            ) : !classroomStats?.length ? (
              <GlowEmpty icon={<School size={22} />} title="No classroom data available" hint="Create classrooms and enroll students to see the monitor." />
            ) : (
              <div className="h-52 sm:h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={classroomStats} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(155,91,255,0.08)" vertical={false} />
                    <XAxis dataKey="classroomName" stroke="rgba(255,255,255,0.2)" tick={{ fontSize: 10 }} />
                    <YAxis stroke="rgba(255,255,255,0.2)" tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#0d0515", borderColor: "rgba(155,91,255,0.25)", borderRadius: 10 }}
                      itemStyle={{ color: "#e2d9f3", fontSize: 11 }}
                      cursor={{ fill: "rgba(155,91,255,0.05)" }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }} />
                    <Bar dataKey="presentCount" name="Present" stackId="a" fill="#10b981" radius={[0, 0, 4, 4]} />
                    <Bar dataKey="absentCount" name="Absent" stackId="a" fill="#ef4444" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </GlowCard>
        </div>

        {/* ── Quick Stats Row ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { label: "Face Recognition", value: "Operational", icon: Eye, color: "155,91,255" },
            { label: "QR Door Terminals", value: "Armed", icon: DoorOpen, color: "34,211,238" },
            { label: "SMS Gateway", value: "Active", icon: MessageSquare, color: "34,197,94" },
          ].map((item, i) => {
            const Icon = item.icon;
            return (
              <GlowCard key={i} className="p-4 flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: `rgba(${item.color},0.1)`, border: `1px solid rgba(${item.color},0.2)` }}
                >
                  <Icon size={15} style={{ color: `rgb(${item.color})` }} />
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-white/30">{item.label}</p>
                  <p className="text-xs font-semibold text-white/70 mt-0.5">{item.value}</p>
                </div>
                <div className="ml-auto">
                  <StatusDot tone={statusToneFor(item.value)} pulse />
                </div>
              </GlowCard>
            );
          })}
        </div>
      </div>
    </div>
  );
}

import type { StatusTone } from "@/components/gx/Primitives";

function statusToneFor(value: string): StatusTone {
  if (value === "Operational" || value === "Active") return "green";
  if (value === "Armed") return "purple";
  return "slate";
}
