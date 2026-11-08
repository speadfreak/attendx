import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type HeatmapReport, type ReportSummary } from "@/lib/api";
import { GlowCard, SectionTitle, StatusBadge, MeshBackground, GlowEmpty, StatusDot } from "@/components/gx/Primitives";
import { ChartSkeleton, GlowSkeleton } from "@/components/gx/Skeletons";
import { MiniStatusStrip } from "@/components/gx/CalendarHeatmap";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { Download, Filter, FileText, Flame, Printer, Loader2, TrendingUp } from "lucide-react";
import { format } from "date-fns";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/**
 * REPORTS & ANALYTICS — records, the attendance confidence heatmap
 * (per-classroom, per-student drill-down), and the branded "insane" PDF export.
 */

type Tab = "records" | "heatmap" | "insights";

const BASE = import.meta.env.BASE_URL ?? "/";

async function authGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}api${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem("ft_token")}` } });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

interface AttendanceRecord {
  id: number;
  studentName: string;
  classroomName: string | null;
  status: string;
  method: string;
  markedAt: string;
  notes: string | null;
}

/** Snapshot all recharts SVGs on the page into PNG data URLs. */
function snapshotCharts(): string[] {
  const out: string[] = [];
  for (const svg of Array.from(document.querySelectorAll(".recharts-wrapper svg"))) {
    try {
      const clone = svg.cloneNode(true) as SVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const rect = svg.getBoundingClientRect();
      const w = Math.max(400, Math.round(rect.width) || 600);
      const h = Math.max(220, Math.round(rect.height) || 300);
      clone.setAttribute("width", String(w));
      clone.setAttribute("height", String(h));
      const xml = new XMLSerializer().serializeToString(clone);
      const img = new Image();
      const url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
      const canvas = document.createElement("canvas");
      canvas.width = w * 2;
      canvas.height = h * 2;
      // sync draw after load
      const dataUrl = url;
      const imgSync = document.createElement("img");
      // Fire and wait async — but jsPDF flow awaits via promise
      const promise = new Promise<string>((resolve) => {
        imgSync.onload = () => {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "#0d0515";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(imgSync, 0, 0, canvas.width, canvas.height);
          }
          resolve(canvas.toDataURL("image/png"));
        };
        imgSync.onerror = () => resolve("");
        imgSync.src = dataUrl;
      });
      void img;
      out.push(promise as unknown as string);
    } catch {
      /* skip chart */
    }
  }
  return out;
}

async function exportPdf(summary: ReportSummary, classroomName: string) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();

  // ── Branded cover ──
  doc.setFillColor(13, 5, 21);
  doc.rect(0, 0, W, 420, "F");
  doc.setFillColor(40, 12, 90);
  doc.circle(W - 80, 80, 160, "F");
  doc.setFillColor(90, 30, 180);
  doc.circle(30, 380, 130, "F");

  doc.setTextColor(200, 160, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(40);
  doc.text("ATTEND", 60, 190);
  const w1 = doc.getTextWidth("ATTEND");
  doc.setTextColor(155, 91, 255);
  doc.text("X", 60 + w1, 190);

  doc.setFontSize(12);
  doc.setTextColor(140, 120, 180);
  doc.setFont("helvetica", "normal");
  doc.text("COMMAND CENTER · ATTENDANCE INTELLIGENCE REPORT", 60, 218);

  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text(`${classroomName}`, 60, 270);
  doc.setFontSize(11);
  doc.setTextColor(160, 150, 190);
  doc.text(`${format(new Date(summary.from), "MMM d, yyyy")}  —  ${format(new Date(summary.to), "MMM d, yyyy")}`, 60, 292);
  doc.text(`Generated ${format(new Date(summary.generatedAt), "MMM d, yyyy HH:mm")}`, 60, 310);
  doc.text(`Prepared by AttendX · Addis Ababa`, 60, 340);

  // ── Chart snapshots (current page charts) ──
  doc.addPage();
  doc.setTextColor(30);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("Trend", 40, 50);
  const snaps = snapshotCharts();
  const pngs = await Promise.all(snaps);
  let y = 60;
  for (const png of pngs.slice(0, 2)) {
    if (!png) continue;
    doc.addImage(png, "PNG", 40, y, W - 80, ((W - 80) * 9) / 16);
    y += ((W - 80) * 9) / 16 + 30;
    if (y > 500) break;
  }

  // ── School-wide summary table ──
  autoTable(doc, {
    startY: y + 10,
    head: [["Metric", "Value"]],
    body: [
      ["Marked records", String(summary.totals.marked)],
      ["Present", String(summary.totals.present)],
      ["Late", String(summary.totals.late)],
      ["Absent", String(summary.totals.absent)],
      ["Unique students", `${summary.uniqueStudents} / ${summary.totalStudents}`],
      ["Face scans", String(summary.methodBreakdown["face"] ?? 0)],
      ["QR scans", String(summary.methodBreakdown["qr"] ?? 0)],
      ["Manual marks", String(summary.methodBreakdown["manual"] ?? 0)],
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [90, 30, 180] },
  });

  // ── Classroom breakdown ──
  autoTable(doc, {
    head: [["Classroom", "Present", "Late", "Absent", "Rate"]],
    body: summary.classrooms.map((c) => [
      c.classroomName,
      String(c.present),
      String(c.late),
      String(c.absent),
      `${Math.round(c.rate * 100)}%`,
    ]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [30, 160, 110] },
    startY: (doc as any).lastAutoTable?.finalY ? (doc as any).lastAutoTable.finalY + 24 : undefined,
  });

  // ── Daily trend table ──
  autoTable(doc, {
    head: [["Day", "Present", "Late", "Absent"]],
    body: summary.daily.map((d) => [d.day, String(d.present), String(d.late), String(d.absent)]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [60, 40, 110] },
  });

  doc.save(`attendx-report-${summary.from}_to_${summary.to}.pdf`);
}

export default function ReportsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("records");
  const [date, setDate] = useState<string>(new Date().toISOString().split("T")[0]);
  const [classroomId, setClassroomId] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [heatmapDays, setHeatmapDays] = useState(42);

  const { data: classrooms } = useQuery({
    queryKey: ["classrooms"],
    queryFn: () => authGet<Array<{ id: number; name: string }>>("/classrooms"),
  });

  const { data: records, isLoading: recordsLoading } = useQuery<AttendanceRecord[]>({
    queryKey: ["attendance", date, classroomId, status],
    queryFn: () => authGet(`/attendance?date=${date}&${classroomId !== "all" ? `classroomId=${classroomId}&` : ""}${status !== "all" ? `status=${status}` : ""}`),
    enabled: tab === "records",
  });

  const { data: heatmap, isLoading: heatmapLoading } = useQuery<HeatmapReport>({
    queryKey: ["heatmap-report", classroomId, heatmapDays],
    queryFn: () => api.heatmapReport(classroomId === "all" ? null : Number(classroomId), heatmapDays),
    enabled: tab === "heatmap",
  });

  const weekAgo = useMemo(() => new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10), []);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const { data: summary, isLoading: summaryLoading } = useQuery<ReportSummary>({
    queryKey: ["report-summary", weekAgo, today],
    queryFn: () => api.reportSummary(weekAgo, today),
  });

  const presentCount = records?.filter((r) => r.status === "present").length || 0;
  const lateCount = records?.filter((r) => r.status === "late").length || 0;
  const absentCount = records?.filter((r) => r.status === "absent").length || 0;

  const exportCSV = () => {
    if (!records || records.length === 0) return;
    const headers = ["Student Name", "Classroom", "Status", "Method", "Date/Time", "Notes"];
    const csvContent = [
      headers.join(","),
      ...records.map((r) => [
        `"${r.studentName}"`,
        `"${r.classroomName || ""}"`,
        r.status,
        r.method,
        format(new Date(r.markedAt), "yyyy-MM-dd HH:mm:ss"),
        `"${r.notes || ""}"`,
      ].join(",")),
    ].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.setAttribute("href", URL.createObjectURL(blob));
    link.setAttribute("download", `attendance_export_${date}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handlePdf = async () => {
    if (!summary) return;
    toast({ title: "Building PDF report…", description: "Capturing charts and tables." });
    try {
      const scope = classroomId === "all" ? "School-Wide" : classrooms?.find((c) => c.id === Number(classroomId))?.name ?? "Classroom";
      await exportPdf(summary, scope);
      toast({ title: "PDF exported", description: "Branded report saved to downloads." });
    } catch (e: any) {
      toast({ title: "PDF failed", description: e.message, variant: "destructive" });
    }
  };

  const heatmapGrid = heatmap?.days ?? [];

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5 max-w-7xl mx-auto">
        <div className="flex flex-col sm:flex-row justify-between gap-4 items-start sm:items-center">
          <SectionTitle sub="CONFIDENCE HEATMAPS, STREAKS & BRANDED EXPORTS">
            REPORTS & ANALYTICS
          </SectionTitle>
          <div className="flex gap-2">
            <button
              onClick={exportCSV}
              disabled={!records?.length}
              className="st-badge st-badge-slate px-4 py-2 disabled:opacity-40"
            >
              <Download size={12} /> CSV
            </button>
            <button
              onClick={handlePdf}
              disabled={summaryLoading}
              className="st-badge st-badge-purple px-4 py-2 disabled:opacity-40"
            >
              {summaryLoading ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} PDF report
            </button>
          </div>
        </div>

        {/* tabs */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-black/30 border border-white/5 w-fit">
          {([
            { id: "records", label: "Daily records", icon: FileText },
            { id: "heatmap", label: "Confidence heatmap", icon: Flame },
            { id: "insights", label: "Insights", icon: TrendingUp },
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
        </div>

        {/* filters */}
        <GlowCard className="p-4">
          <div className="flex flex-col sm:flex-row gap-4 items-end sm:items-center">
            <div className="flex items-center gap-2 text-white/40">
              <Filter className="w-4 h-4" />
              <span className="text-sm font-medium">Filters:</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full sm:w-auto flex-1">
              {tab === "records" && (
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="bg-black/40 border border-purple-500/15 rounded-lg px-3 py-2 text-sm text-white/70 [color-scheme:dark]"
                />
              )}
              <select
                value={classroomId}
                onChange={(e) => setClassroomId(e.target.value)}
                className="bg-black/40 border border-purple-500/15 rounded-lg px-3 py-2 text-sm text-white/70"
              >
                <option value="all">All Classrooms</option>
                {classrooms?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {tab === "heatmap" ? (
                <select
                  value={heatmapDays}
                  onChange={(e) => setHeatmapDays(Number(e.target.value))}
                  className="bg-black/40 border border-purple-500/15 rounded-lg px-3 py-2 text-sm text-white/70"
                >
                  <option value={14}>Last 14 days</option>
                  <option value={28}>Last 28 days</option>
                  <option value={42}>Last 42 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              ) : (
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="bg-black/40 border border-purple-500/15 rounded-lg px-3 py-2 text-sm text-white/70"
                >
                  <option value="all">All Statuses</option>
                  <option value="present">Present</option>
                  <option value="late">Late</option>
                  <option value="absent">Absent</option>
                </select>
              )}
            </div>
          </div>
        </GlowCard>

        {/* ── RECORDS TAB ── */}
        {tab === "records" && (
          <GlowCard>
            <div className="grid grid-cols-4 border-b border-white/5">
              {[
                { label: "Present", value: presentCount, cls: "text-emerald-400" },
                { label: "Late", value: lateCount, cls: "text-amber-400" },
                { label: "Absent", value: absentCount, cls: "text-red-400" },
                { label: "Total Logs", value: records?.length || 0, cls: "text-white/70" },
              ].map((s) => (
                <div key={s.label} className="p-4 text-center border-r border-white/5 last:border-0">
                  <p className={`text-2xl font-bold counter-num ${s.cls}`}>{s.value}</p>
                  <p className="text-[10px] text-white/30 uppercase font-medium mt-1 tracking-widest">{s.label}</p>
                </div>
              ))}
            </div>
            <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
              {recordsLoading ? (
                <div className="p-4 space-y-2">
                  {Array(8).fill(0).map((_, i) => <GlowSkeleton key={i} className="h-9 !rounded-md" />)}
                </div>
              ) : !records?.length ? (
                <GlowEmpty icon={<FileText size={24} />} title="No attendance records for these filters" />
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[#120826]/95 backdrop-blur">
                    <tr className="text-left text-[10px] uppercase tracking-widest text-white/35">
                      <th className="px-4 py-3">Student</th>
                      <th className="px-4 py-3">Classroom</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Method</th>
                      <th className="px-4 py-3">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((record) => (
                      <tr key={record.id} className="border-t border-white/5 hover:bg-purple-500/5">
                        <td className="px-4 py-2.5 text-white/80">{record.studentName}</td>
                        <td className="px-4 py-2.5 text-white/40">{record.classroomName || "Unassigned"}</td>
                        <td className="px-4 py-2.5"><StatusBadge value={record.status} /></td>
                        <td className="px-4 py-2.5"><StatusBadge value={record.method} /></td>
                        <td className="px-4 py-2.5 text-white/40 font-mono text-xs">{format(new Date(record.markedAt), "h:mm a")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </GlowCard>
        )}

        {/* ── HEATMAP TAB ── */}
        {tab === "heatmap" && (
          <GlowCard className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">ATTENDANCE CONFIDENCE HEATMAP</h3>
                <p className="text-[10px] text-white/30 mt-1">Per-student drill-down · green = clean matches, amber = low-confidence zone</p>
              </div>
            </div>
            {heatmapLoading ? (
              <ChartSkeleton height="h-72" />
            ) : !heatmap?.rows.length ? (
              <GlowEmpty icon={<Flame size={24} />} title="No heatmap data" hint="Attendance records feed this heatmap." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[9px] uppercase tracking-widest text-white/30 border-b border-white/5">
                      <th className="px-3 py-2">Student</th>
                      <th className="px-3 py-2">Daily strip</th>
                      <th className="px-3 py-2 text-center">Present</th>
                      <th className="px-3 py-2 text-center">Late</th>
                      <th className="px-3 py-2 text-center">Absent</th>
                      <th className="px-3 py-2 text-center">Rate</th>
                      <th className="px-3 py-2 text-center">Avg confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {heatmap.rows.map((row) => (
                      <tr key={row.studentId} className="border-b border-white/5 hover:bg-purple-500/5">
                        <td className="px-3 py-2 text-white/80 whitespace-nowrap">{row.studentName}</td>
                        <td className="px-3 py-2"><MiniStatusStrip days={row.days} window={heatmapGrid} /></td>
                        <td className="px-3 py-2 text-center text-emerald-400 font-mono">{row.presentCount}</td>
                        <td className="px-3 py-2 text-center text-amber-400 font-mono">{row.lateCount}</td>
                        <td className="px-3 py-2 text-center text-red-400 font-mono">{row.absentCount}</td>
                        <td className="px-3 py-2 text-center text-white/60 font-mono">{row.attendanceRate != null ? `${Math.round(row.attendanceRate * 100)}%` : "—"}</td>
                        <td className="px-3 py-2 text-center">
                          {row.avgConfidence != null ? (
                            <span className={`st-badge ${row.avgConfidence >= 0.72 ? "st-badge-green" : "st-badge-amber"}`}>
                              {(row.avgConfidence * 100).toFixed(0)}%
                            </span>
                          ) : (
                            <span className="text-white/20">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </GlowCard>
        )}

        {/* ── INSIGHTS TAB ── */}
        {tab === "insights" && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <GlowCard className="p-5 lg:col-span-2">
              <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text mb-4">7-DAY TREND</h3>
              {summaryLoading || !summary ? (
                <ChartSkeleton />
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={summary.daily.map((d) => ({ ...d, day: format(new Date(d.day), "MMM d") }))}>
                      <defs>
                        <linearGradient id="igPresent" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="igLate" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(155,91,255,0.08)" vertical={false} />
                      <XAxis dataKey="day" stroke="rgba(255,255,255,0.2)" tick={{ fontSize: 10 }} />
                      <YAxis stroke="rgba(255,255,255,0.2)" tick={{ fontSize: 10 }} />
                      <Tooltip contentStyle={{ backgroundColor: "#0d0515", borderColor: "rgba(155,91,255,0.25)", borderRadius: 10 }} itemStyle={{ color: "#e2d9f3", fontSize: 11 }} />
                      <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }} />
                      <Area type="monotone" dataKey="present" stroke="#10b981" strokeWidth={2} fill="url(#igPresent)" />
                      <Area type="monotone" dataKey="late" stroke="#f59e0b" strokeWidth={2} fill="url(#igLate)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </GlowCard>

            {/* method mix + classroom table */}
            <GlowCard className="p-5">
              <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text mb-4">CHECK-IN METHOD MIX</h3>
              {summaryLoading || !summary ? (
                <GlowSkeleton className="h-40" />
              ) : (
                <div className="space-y-3">
                  {Object.entries(summary.methodBreakdown).map(([method, count]) => {
                    const total = Object.values(summary.methodBreakdown).reduce((a, b) => a + b, 0);
                    const pct = total ? Math.round((count / total) * 100) : 0;
                    return (
                      <div key={method}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <StatusBadge value={method} />
                          <span className="text-white/40 font-mono">{count} · {pct}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${pct}%`,
                              background: method === "face" ? "rgb(155,91,255)" : method === "qr" ? "rgb(34,211,238)" : "rgb(148,163,184)",
                              boxShadow: "0 0 8px rgba(155,91,255,0.4)",
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-2 pt-2 text-[11px] text-white/40">
                    <StatusDot tone="green" pulse />
                    {summary.uniqueStudents} of {summary.totalStudents} students recorded in the last 7 days
                  </div>
                </div>
              )}
            </GlowCard>

            <GlowCard className="p-5">
              <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text mb-4">CLASSROOM LEADERBOARD</h3>
              {summaryLoading || !summary ? (
                <GlowSkeleton className="h-40" />
              ) : !summary.classrooms.length ? (
                <GlowEmpty icon={<TrendingUp size={20} />} title="No classroom data" />
              ) : (
                <div className="space-y-2">
                  {summary.classrooms.map((c) => (
                    <div key={String(c.classroomId)} className="flex items-center gap-3">
                      <span className="text-xs text-white/70 w-28 truncate">{c.classroomName}</span>
                      <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.round(c.rate * 100)}%`,
                            background: c.rate >= 0.8 ? "rgb(34,197,94)" : c.rate >= 0.6 ? "rgb(245,158,11)" : "rgb(239,68,68)",
                          }}
                        />
                      </div>
                      <span className="text-xs font-mono text-white/50 w-10 text-right">{Math.round(c.rate * 100)}%</span>
                      {c.rate >= 0.8 && <Flame size={12} className="text-amber-400" />}
                    </div>
                  ))}
                </div>
              )}
            </GlowCard>
          </div>
        )}
      </div>
    </div>
  );
}
