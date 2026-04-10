import { useEffect, useRef } from "react";
import {
  useGetDashboardStats,
  useGetRecentActivity,
  useGetAttendanceTrend,
  useGetClassroomSummary
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, Legend
} from "recharts";
import {
  Users, School, UserCheck, UserX,
  MessageSquare, Activity, Zap, Eye
} from "lucide-react";
import { format } from "date-fns";
import gsap from "gsap";

// ── Animated stat card ─────────────────────────────────────
function StatCard({
  title, value, sub, icon: Icon, color, delay = 0,
}: {
  title: string; value: string; sub?: React.ReactNode;
  icon: React.ElementType; color: string; delay?: number;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const numRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    gsap.fromTo(card,
      { opacity: 0, y: 30, scale: 0.95 },
      { opacity: 1, y: 0, scale: 1, duration: 0.6, delay, ease: "expo.out" }
    );
  }, [delay]);

  const handleEnter = () => {
    gsap.to(cardRef.current, { y: -4, scale: 1.02, duration: 0.25, ease: "power2.out" });
  };
  const handleLeave = () => {
    gsap.to(cardRef.current, { y: 0, scale: 1, duration: 0.25, ease: "power2.out" });
  };

  return (
    <div
      ref={cardRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className="stat-card-accent rounded-2xl p-5 relative overflow-hidden cursor-default"
      style={{
        background: "linear-gradient(135deg, rgba(20,8,40,0.9) 0%, rgba(12,4,24,0.95) 100%)",
        border: `1px solid rgba(${color},0.2)`,
        boxShadow: `0 4px 24px rgba(${color},0.08)`,
      }}
    >
      {/* BG glow */}
      <div
        className="absolute -bottom-6 -right-6 w-28 h-28 rounded-full blur-2xl opacity-20"
        style={{ background: `rgb(${color})` }}
      />
      <div className="relative z-10 flex items-start justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-white/40 mb-2">{title}</p>
          <p
            ref={numRef}
            className="counter-num text-3xl text-white leading-none mb-2"
          >
            {value}
          </p>
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

// ── Activity row ──────────────────────────────────────────
function ActivityRow({ log, index }: { log: any; index: number }) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    gsap.fromTo(rowRef.current,
      { opacity: 0, x: 20 },
      { opacity: 1, x: 0, duration: 0.4, delay: 0.05 * index, ease: "expo.out" }
    );
  }, [index]);

  const statusColors: Record<string, string> = {
    present: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    late:    "text-amber-400  bg-amber-500/10  border-amber-500/20",
    absent:  "text-red-400   bg-red-500/10   border-red-500/20",
  };
  const methodColors: Record<string, string> = {
    face:   "text-purple-400 bg-purple-500/10",
    qr:     "text-blue-400   bg-blue-500/10",
    manual: "text-slate-400  bg-slate-500/10",
  };

  return (
    <div
      ref={rowRef}
      className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-0"
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
        <span className={`text-[9px] uppercase font-semibold px-2 py-0.5 rounded border ${statusColors[log.status] || "text-white/30 bg-white/5 border-white/10"}`}>
          {log.status}
        </span>
        <span className={`text-[9px] uppercase font-medium px-1.5 py-0.5 rounded ${methodColors[log.method] || "text-white/30 bg-white/5"}`}>
          {log.method}
        </span>
      </div>
    </div>
  );
}

// ── Section Header ─────────────────────────────────────────
function SectionHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-sm font-semibold text-white/70 uppercase tracking-widest">{title}</h2>
      {badge && (
        <span className="text-[10px] text-purple-400 bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 rounded-full">
          {badge}
        </span>
      )}
    </div>
  );
}

// ── Chart Card ─────────────────────────────────────────────
function ChartCard({ title, badge, children, className = "" }: {
  title: string; badge?: string; children: React.ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    gsap.fromTo(ref.current,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.6, delay: 0.5, ease: "expo.out" }
    );
  }, []);
  return (
    <div
      ref={ref}
      className={`rounded-2xl p-5 ${className}`}
      style={{
        background: "linear-gradient(135deg, rgba(20,8,40,0.9) 0%, rgba(12,4,24,0.95) 100%)",
        border: "1px solid rgba(155,91,255,0.12)",
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white/70 uppercase tracking-widest">{title}</h3>
        {badge && (
          <span className="text-[10px] text-purple-400 bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 rounded-full">
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────
export default function DashboardPage() {
  const headerRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLSpanElement | null>(null);

  const { data: stats, isLoading: statsLoading } = useGetDashboardStats({ query: { refetchInterval: 30000 } });
  const { data: trend,    isLoading: trendLoading }    = useGetAttendanceTrend({ query: { refetchInterval: 30000 } });
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity({ query: { refetchInterval: 30000 } });
  const { data: classroomStats, isLoading: classroomsLoading } = useGetClassroomSummary({ query: { refetchInterval: 30000 } });

  useEffect(() => {
    gsap.fromTo(headerRef.current,
      { opacity: 0, y: -10 },
      { opacity: 1, y: 0, duration: 0.5, ease: "expo.out" }
    );
    gsap.to(dotRef.current, {
      scale: 1.5, opacity: 0.4, duration: 0.8, yoyo: true, repeat: -1, ease: "sine.inOut"
    });
  }, []);

  const rate = stats?.attendanceRate !== undefined
    ? `${(stats.attendanceRate * 100).toFixed(1)}%` : "—";

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* ── Header ──────────────────────────────────────── */}
      <div ref={headerRef} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1
            className="text-2xl sm:text-3xl font-black text-white tracking-tight"
            style={{ fontFamily: "'Orbitron', monospace" }}
          >
            <span className="text-purple-400">SYS</span>TEM OVERVIEW
          </h1>
          <p className="text-xs text-white/30 mt-1 flex items-center gap-2 tracking-wide">
            <span className="relative flex h-2 w-2">
              <span
                ref={dotRef}
                className="absolute inline-flex h-full w-full rounded-full bg-purple-500 opacity-75"
              />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-400" />
            </span>
            LIVE MONITORING ACTIVE · AUTO-REFRESH 30s
          </p>
        </div>
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] text-purple-300/60 border border-purple-500/15"
          style={{ background: "rgba(124,58,237,0.06)" }}
        >
          <Eye size={12} className="text-purple-400" />
          {format(new Date(), "EEEE, MMM d yyyy")}
        </div>
      </div>

      {/* ── Stats Grid ───────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {statsLoading ? (
          Array(4).fill(0).map((_, i) => (
            <div key={i} className="rounded-2xl h-28 animate-pulse" style={{ background: "rgba(20,8,40,0.7)" }} />
          ))
        ) : (
          <>
            <StatCard
              title="Attendance Rate" value={rate}
              sub="Today's completion"
              icon={Activity} color="155,91,255" delay={0.1}
            />
            <StatCard
              title="Present / Total"
              value={`${stats?.presentToday ?? 0}/${stats?.totalStudents ?? 0}`}
              sub={<><span className="text-amber-400">{stats?.lateToday ?? 0} late</span> · <span className="text-red-400">{stats?.absentToday ?? 0} absent</span></>}
              icon={UserCheck} color="34,197,94" delay={0.18}
            />
            <StatCard
              title="Active Classrooms"
              value={String(stats?.totalClassrooms ?? 0)}
              sub="Monitored zones"
              icon={School} color="59,130,246" delay={0.26}
            />
            <StatCard
              title="SMS Sent Today"
              value={String(stats?.smsSentToday ?? 0)}
              sub="Parent notifications"
              icon={MessageSquare} color="245,158,11" delay={0.34}
            />
          </>
        )}
      </div>

      {/* ── Charts Row ───────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Area chart */}
        <ChartCard title="7-Day Attendance Trend" className="lg:col-span-2">
          <div className="h-56 sm:h-72 w-full">
            {trendLoading ? (
              <div className="w-full h-full rounded-xl animate-pulse" style={{ background: "rgba(20,8,40,0.7)" }} />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gPresent" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#10b981" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gAbsent" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gLate" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#f59e0b" stopOpacity={0.25} />
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
                  <Area type="monotone" dataKey="late"    name="Late"    stroke="#f59e0b" strokeWidth={2} fillOpacity={1} fill="url(#gLate)" />
                  <Area type="monotone" dataKey="absent"  name="Absent"  stroke="#ef4444" strokeWidth={2} fillOpacity={1} fill="url(#gAbsent)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </ChartCard>

        {/* Live feed */}
        <ChartCard title="Live Feed" badge="Real-time">
          <div className="max-h-64 sm:max-h-72 overflow-y-auto pr-1">
            {activityLoading ? (
              <div className="space-y-2">
                {Array(5).fill(0).map((_, i) => (
                  <div key={i} className="h-11 rounded-xl animate-pulse" style={{ background: "rgba(20,8,40,0.7)" }} />
                ))}
              </div>
            ) : !activity?.length ? (
              <div className="flex flex-col items-center justify-center h-48 text-white/20">
                <Zap size={24} className="mb-2" />
                <p className="text-xs">No activity today</p>
              </div>
            ) : (
              activity.map((log, i) => <ActivityRow key={log.id} log={log} index={i} />)
            )}
          </div>
        </ChartCard>
      </div>

      {/* ── Classroom Monitor ─────────────────────────────── */}
      <ChartCard title="Classroom Monitor">
        {classroomsLoading ? (
          <div className="h-48 rounded-xl animate-pulse" style={{ background: "rgba(20,8,40,0.7)" }} />
        ) : !classroomStats?.length ? (
          <div className="py-10 text-center text-white/20 text-sm">No classroom data available</div>
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
                <Bar dataKey="absentCount"  name="Absent"  stackId="a" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </ChartCard>

      {/* ── Quick Stats Row ──────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: "Face Recognition", value: "Operational", icon: Eye,    color: "155,91,255" },
          { label: "QR Scanner",       value: "Operational", icon: Zap,    color: "59,130,246" },
          { label: "SMS Gateway",      value: "Active",      icon: MessageSquare, color: "34,197,94" },
        ].map((item, i) => {
          const Icon = item.icon;
          return (
            <div
              key={i}
              className="rounded-xl p-4 flex items-center gap-3"
              style={{
                background: "linear-gradient(135deg, rgba(20,8,40,0.8) 0%, rgba(12,4,24,0.9) 100%)",
                border: `1px solid rgba(${item.color},0.15)`,
              }}
            >
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
              <div className="ml-auto flex items-center gap-1">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: `rgb(${item.color})` }} />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: `rgb(${item.color})` }} />
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
