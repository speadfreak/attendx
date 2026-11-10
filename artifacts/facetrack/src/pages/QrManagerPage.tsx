import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useQuery } from "@tanstack/react-query";
import { api, type QrIssueResult, type QrIssueRow, type QrScanLogRow, type QrStats } from "@/lib/api";
import { GlowCard, SectionTitle, StatusBadge, StatusDot, MeshBackground, GlowEmpty } from "@/components/gx/Primitives";
import { FeedSkeletonRow, GlowSkeleton, TableSkeleton } from "@/components/gx/Skeletons";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { format } from "date-fns";
import {
  QrCode, Printer, RotateCcw, Ban, Download, School, ShieldCheck,
  ShieldAlert, Users, Activity, Search, BadgeCheck, Copy,
} from "lucide-react";

/**
 * QR BADGE MANAGER — where admins & homeroom teachers control the badge fleet:
 * issue per student or whole classroom, rotate (old badge dies instantly),
 * revoke (lost card), reprint, download PNG, and a printable ID-card sheet
 * with the school wordmark + student details + signed QR.
 */

interface Classroom { id: number; name: string; studentCount: number; teacherName: string | null }
interface Student { id: number; name: string; studentId: string; classroomId: number | null; classroomName: string | null }

const BASE = import.meta.env.BASE_URL ?? "/";

function authToken() {
  return localStorage.getItem("ft_token") ?? "";
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}api${path}`, { headers: { Authorization: `Bearer ${authToken()}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Failed (${res.status})`);
  return res.json() as Promise<T>;
}

/** Printable ID card — school branding + student + QR. */
function IdCard({ student, token, serial, expiresAt, classroom }: {
  student: { name: string; studentId: string };
  token: string;
  serial: string;
  expiresAt: string | null;
  classroom: string;
}) {
  return (
    <div className="gx-print-card relative rounded-xl p-3 flex gap-3 items-center"
      style={{ background: "linear-gradient(135deg,#ffffff,#f3effc)", width: 300, height: 170 }}>
      <div className="absolute inset-0 rounded-xl pointer-events-none"
        style={{ border: "2px solid #7C3AED22" }} />
      <div className="flex flex-col items-center gap-1">
        <div className="bg-white p-1.5 rounded-lg border border-purple-200">
          <QRCodeSVG value={token} size={92} level="M" includeMargin />
        </div>
        <p className="text-[7px] font-mono text-purple-900/60 max-w-[100px] truncate">{serial}</p>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[9px] font-black tracking-widest text-purple-800" style={{ fontFamily: "'Orbitron', monospace" }}>
          ATTEND<span className="text-purple-500">X</span>
        </p>
        <p className="text-[7px] text-purple-900/50 uppercase tracking-wider mb-2">QR attendance badge</p>
        <p className="text-[13px] font-bold text-gray-900 leading-tight truncate">{student.name}</p>
        <p className="text-[10px] font-mono text-gray-500">{student.studentId}</p>
        <p className="text-[9px] text-gray-500 mt-0.5">{classroom}</p>
        <p className="text-[8px] text-gray-400 mt-1.5">
          {expiresAt ? `Valid until ${format(new Date(expiresAt), "MMM d, yyyy")}` : "Valid until revoked"}
        </p>
        <p className="text-[7px] text-gray-400">Scan at the door terminal · Do not duplicate</p>
      </div>
    </div>
  );
}

export default function QrManagerPage() {
  const { toast } = useToast();
  const { admin } = useAuth();
  const [tab, setTab] = useState<"console" | "print" | "scans">("console");

  const [classroomId, setClassroomId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [students, setStudents] = useState<Student[]>([]);
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expiry, setExpiry] = useState<string>("0");
  const [pendingTokens, setPendingTokens] = useState<QrIssueResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [printClassroomId, setPrintClassroomId] = useState<string>("all");

  const { data: stats, isLoading: statsLoading } = useQuery<QrStats>({
    queryKey: ["qr", "stats"],
    queryFn: () => api.qrStats(),
    refetchInterval: 15000,
  });
  const { data: issues, isLoading: issuesLoading, refetch: refetchIssues } = useQuery<QrIssueRow[]>({
    queryKey: ["qr", "issues", classroomId],
    queryFn: () => api.qrIssues(classroomId === "all" ? undefined : { classroomId: Number(classroomId) }),
    refetchInterval: 20000,
  });
  const { data: scanLogs, isLoading: logsLoading } = useQuery<QrScanLogRow[]>({
    queryKey: ["qr", "scan-logs"],
    queryFn: () => api.qrScanLogs(80),
    refetchInterval: 10000,
  });

  useEffect(() => {
    apiGet<Student[]>("/students").then(setStudents).catch(() => {});
    apiGet<Classroom[]>("/classrooms").then(setClassrooms).catch(() => {});
  }, []);

  const filteredStudents = useMemo(() => {
    let rows = students;
    if (classroomId !== "all") rows = rows.filter((s) => s.classroomId === Number(classroomId));
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((s) => s.name.toLowerCase().includes(q) || s.studentId.toLowerCase().includes(q));
    }
    return rows;
  }, [students, classroomId, search]);

  const issueStateById = useMemo(() => {
    // studentId -> latest active badge state
    const map = new Map<number, QrIssueRow>();
    for (const issue of issues ?? []) {
      if (issue.state === "active" && !map.has(issue.studentId)) map.set(issue.studentId, issue);
    }
    return map;
  }, [issues]);

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const issue = async (studentIds: number[], opts?: { expiresInDays?: number | null }) => {
    if (!studentIds.length) return;
    setBusy(true);
    try {
      const days = opts?.expiresInDays ?? (Number(expiry) || null);
      const result = await api.qrIssue(studentIds, days);
      setPendingTokens(result.issued);
      toast({ title: `Issued ${result.issued.length} badge${result.issued.length === 1 ? "" : "s"}`, description: "Older badges were rotated automatically." });
      setSelected(new Set());
      void refetchIssues();
      setTab("print");
    } catch (e: any) {
      toast({ title: "Issue failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (studentId: number) => {
    setBusy(true);
    try {
      const issued = await api.qrRotate(studentId);
      setPendingTokens([issued]);
      toast({ title: "Badge rotated", description: `New ${issued.serial} — old print is now invalid.` });
      void refetchIssues();
      setTab("print");
    } catch (e: any) {
      toast({ title: "Rotate failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (issue: QrIssueRow) => {
    try {
      await api.qrRevoke(issue.id, "revoked-from-console");
      toast({ title: `Badge ${issue.serial} revoked`, description: "Scans with this badge will be blocked and logged." });
      void refetchIssues();
    } catch (e: any) {
      toast({ title: "Revoke failed", description: e.message, variant: "destructive" });
    }
  };

  const issueAll = async () => {
    if (classroomId === "all") {
      toast({ title: "Pick a classroom first", description: "Batch issue targets one classroom (homeroom flow).", variant: "destructive" });
      return;
    }
    const cls = classrooms.find((c) => c.id === Number(classroomId));
    if (!confirm(`Issue fresh badges for ALL ${cls?.studentCount ?? ""} students in ${cls?.name ?? "this classroom"}? Previous badges become invalid.`)) return;
    setBusy(true);
    try {
      const result = await api.qrIssueAll(Number(classroomId), Number(expiry) || null);
      setPendingTokens(result.issued);
      toast({ title: `Batch issued ${result.issued.length} badges`, description: `Classroom ${cls?.name} — ready to print.` });
      void refetchIssues();
      setTab("print");
    } catch (e: any) {
      toast({ title: "Batch failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const downloadPng = async (token: string, name: string, serial: string) => {
    // Render the QR SVG to PNG via canvas
    const svg = document.querySelector(`[data-qr-token="${serial}"] svg`) as SVGSVGElement | null;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    const svgBlob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    await new Promise((r) => { img.onload = r; img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 512, 512);
    ctx.drawImage(img, 0, 0, 512, 512);
    URL.revokeObjectURL(url);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `qr-${name.replace(/\s+/g, "-")}-${serial}.png`;
    a.click();
  };

  const printRows = useMemo(() => {
    if (pendingTokens.length) {
      return pendingTokens.map((t) => ({
        token: t.token,
        serial: t.serial,
        student: { name: t.name, studentId: String(t.studentId) },
        expiresAt: t.expiresAt,
        classroom: classrooms.find((c) => c.id === students.find((s) => s.id === t.studentId)?.classroomId)?.name ?? "—",
      }));
    }
    // Print active badges for chosen classroom
    const targets = printClassroomId === "all"
      ? students
      : students.filter((s) => s.classroomId === Number(printClassroomId));
    return targets
      .map((s) => ({ s, issue: issueStateById.get(s.id) }))
      .filter((x): x is { s: Student; issue: QrIssueRow } => !!x.issue)
      .map(({ s, issue }) => ({
        token: `reprint:${issue.id}`,
        serial: issue.serial,
        student: { name: s.name, studentId: s.studentId },
        expiresAt: issue.expiresAt,
        classroom: s.classroomName ?? "—",
      }));
  }, [pendingTokens, students, classrooms, printClassroomId, issueStateById]);

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5 max-w-7xl mx-auto">
        <div className="gx-page-header">
          <SectionTitle className="gx-title-gradient" sub="ISSUE · ROTATE · REVOKE · PRINT — THE FULL BADGE FLEET">
            QR BADGE MANAGER
          </SectionTitle>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {statsLoading ? (
            Array(5).fill(0).map((_, i) => <GlowSkeleton key={i} className="h-20" />)
          ) : stats ? (
            [
              { label: "Active badges", value: stats.activeBadges, icon: BadgeCheck, tone: "green" },
              { label: "Valid scans today", value: stats.validScansToday, icon: Activity, tone: "purple" },
              { label: "Anomalies today", value: stats.anomaliesToday, icon: ShieldAlert, tone: stats.anomaliesToday > 0 ? "red" : "slate" },
              { label: "Revoked badges", value: stats.revokedBadges, icon: Ban, tone: "amber" },
              { label: "Students w/o badge", value: stats.studentsWithoutActiveBadge, icon: Users, tone: stats.studentsWithoutActiveBadge > 0 ? "amber" : "green" },
            ].map((s, i) => (
              <GlowCard key={i} variant="gradient" className="gx-stat p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[9px] uppercase tracking-widest text-white/35">{s.label}</p>
                    <p className="counter-num text-2xl mt-1 gx-gradient-text">{s.value}</p>
                  </div>
                  <s.icon size={16} className={`st-${s.tone}`} />
                </div>
              </GlowCard>
            ))
          ) : null}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-black/30 border border-white/5 w-fit">
          {([
            { id: "console", label: "Issue console", icon: QrCode },
            { id: "print", label: "Print sheet", icon: Printer },
            { id: "scans", label: "Scan log", icon: Activity },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                tab === t.id ? "gx-nav-pill text-purple-200" : "text-white/40 hover:text-white/70"
              }`}
            >
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>

        {/* ── Issue console ── */}
        {tab === "console" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-8">
              <GlowCard variant="gradient" className="p-4">
                <div className="flex flex-col sm:flex-row gap-2 mb-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-white/25" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search students…"
                      className="w-full bg-black/40 border border-purple-500/15 rounded-lg pl-9 pr-3 py-2 text-sm text-white/80 focus:outline-none focus:border-purple-500/45"
                    />
                  </div>
                  <select
                    value={classroomId}
                    onChange={(e) => setClassroomId(e.target.value)}
                    className="bg-black/40 border border-purple-500/15 rounded-lg px-3 py-2 text-sm text-white/70 focus:outline-none"
                  >
                    <option value="all">All classrooms</option>
                    {classrooms.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    className="bg-black/40 border border-purple-500/15 rounded-lg px-3 py-2 text-sm text-white/70 focus:outline-none"
                    title="Badge expiry"
                  >
                    <option value="0">No expiry</option>
                    <option value="1">1 day (temp pass)</option>
                    <option value="7">7 days</option>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                    <option value="365">1 year</option>
                  </select>
                </div>

                <div className="max-h-80 overflow-y-auto rounded-lg border border-white/5">
                  {filteredStudents.length === 0 ? (
                    <TableSkeleton rows={5} cols={3} />
                  ) : (
                    filteredStudents.map((s) => {
                      const active = issueStateById.get(s.id);
                      return (
                        <label key={s.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-white/5 last:border-0 hover:bg-purple-500/5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selected.has(s.id)}
                            onChange={() => toggleSelect(s.id)}
                            className="accent-purple-500"
                          />
                          <div className="w-7 h-7 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-[10px] font-bold text-purple-300">
                            {s.name.charAt(0)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-white/80 truncate">{s.name}</p>
                            <p className="text-[10px] text-white/30 font-mono">{s.studentId} · {s.classroomName ?? "no classroom"}</p>
                          </div>
                          {active ? (
                            <span className="flex items-center gap-2">
                              <span className="text-[9px] font-mono text-white/30">{active.serial}</span>
                              <StatusBadge value="valid" label="active" tone="green" />
                            </span>
                          ) : (
                            <StatusBadge value="no-identity" label="no badge" tone="red" />
                          )}
                        </label>
                      );
                    })
                  )}
                </div>
              </GlowCard>
            </div>

            <div className="lg:col-span-4 space-y-3">
              <GlowCard accent variant="gradient" className="p-4">
                <p className="text-[10px] uppercase tracking-widest text-white/35 mb-3">Issue actions</p>
                <div className="space-y-2">
                  <button
                    disabled={!selected.size || busy}
                    onClick={() => issue(Array.from(selected))}
                    className="gx-btn-accent gx-gradient-pan w-full py-2.5 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-40"
                  >
                    Issue {selected.size || ""} badge{selected.size === 1 ? "" : "s"}
                  </button>
                  <button
                    disabled={classroomId === "all" || busy}
                    onClick={issueAll}
                    className="gx-glow-hover w-full py-2.5 rounded-lg text-xs font-semibold text-purple-200 border border-purple-500/25 bg-purple-500/10 hover:bg-purple-500/20 transition-all disabled:opacity-40"
                  >
                    <School size={12} className="inline mr-1.5" /> Whole-classroom batch
                  </button>
                  <p className="text-[9px] text-white/25 leading-relaxed">
                    Rotating kills every older badge instantly — safe for lost cards.
                    Expiry turns badges into time-boxed passes.
                  </p>
                </div>
              </GlowCard>

              <GlowCard variant="gradient" className="p-4">
                <p className="text-[10px] uppercase tracking-widest text-white/35 mb-3">Badge inventory</p>
                {issuesLoading ? (
                  <FeedSkeletonRow rows={4} />
                ) : !issues?.length ? (
                  <GlowEmpty icon={<QrCode size={20} />} title="No badges yet" hint="Issue the first badge to get started." />
                ) : (
                  <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
                    {issues.slice(0, 50).map((issue) => (
                      <div key={issue.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white/[0.02] border border-white/5">
                        <StatusDot tone={issue.state === "active" ? "green" : issue.state === "expired" ? "amber" : "red"} />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-white/75 truncate">{issue.studentName ?? "?"}</p>
                          <p className="text-[9px] text-white/30 font-mono">{issue.serial} · v{issue.version} · {issue.scans} scans</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            title="Rotate (reprint)"
                            className="p-1.5 rounded-md text-white/40 hover:text-purple-300 hover:bg-purple-500/10"
                            onClick={() => rotate(issue.studentId)}
                          >
                            <RotateCcw size={12} />
                          </button>
                          {issue.state === "active" && (
                            <button
                              title="Revoke"
                              className="p-1.5 rounded-md text-white/40 hover:text-red-400 hover:bg-red-500/10"
                              onClick={() => revoke(issue)}
                            >
                              <Ban size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </GlowCard>
            </div>
          </div>
        )}

        {/* ── Print sheet ── */}
        {tab === "print" && (
          <GlowCard variant="gradient" className="p-4">
            <div className="gx-no-print flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <Printer size={15} className="text-purple-400" />
                <span className="text-sm text-white/70">
                  {pendingTokens.length ? `${pendingTokens.length} fresh badge${pendingTokens.length === 1 ? "" : "s"} ready` : "Active badges by classroom"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {!pendingTokens.length && (
                  <select
                    value={printClassroomId}
                    onChange={(e) => setPrintClassroomId(e.target.value)}
                    className="bg-black/40 border border-purple-500/15 rounded-lg px-3 py-2 text-sm text-white/70"
                  >
                    <option value="all">All classrooms</option>
                    {classrooms.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
                <button
                  onClick={() => window.print()}
                  className="gx-btn-accent gx-gradient-pan inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white"
                >
                  <Printer size={12} /> Print sheet
                </button>
              </div>
            </div>
            {printRows.length === 0 ? (
              <GlowEmpty icon={<Printer size={22} />} title="Nothing to print" hint="Issue badges first, or pick a classroom with active badges." />
            ) : (
              <div className="gx-print-sheet grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {printRows.map((row, i) =>
                  row.token.startsWith("reprint:") ? (
                    <div key={i} className="opacity-70">
                      <div className="flex items-center gap-2 text-xs text-white/40 p-3">
                        <RotateCcw size={13} className="text-amber-400" />
                        {row.student.name} — badge {row.serial} is active.
                        <button className="st-badge st-badge-amber" onClick={() => rotate(students.find((s) => s.name === row.student.name)?.id ?? 0)}>
                          rotate to reprint
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="relative" data-qr-token={row.serial}>
                      <IdCard student={row.student} token={row.token} serial={row.serial} expiresAt={row.expiresAt} classroom={row.classroom} />
                      <button
                        className="gx-no-print absolute top-1 right-1 p-1.5 rounded-md bg-black/60 text-white/50 hover:text-purple-300"
                        title="Download PNG"
                        onClick={() => downloadPng(row.token, row.student.name, row.serial)}
                      >
                        <Download size={12} />
                      </button>
                    </div>
                  )
                )}
              </div>
            )}
          </GlowCard>
        )}

        {/* ── Scan log ── */}
        {tab === "scans" && (
          <GlowCard variant="gradient" className="p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-white/70 flex items-center gap-2">
                <ShieldCheck size={14} className="text-emerald-400" /> Every tap & every anomaly
              </span>
              <span className="text-[10px] text-white/30">valid · duplicate · expired · revoked · forged · stale-version</span>
            </div>
            {logsLoading ? (
              <TableSkeleton rows={6} cols={5} />
            ) : !scanLogs?.length ? (
              <GlowEmpty icon={<Activity size={22} />} title="No scans recorded yet" />
            ) : (
              <div className="max-h-96 overflow-y-auto">
                {scanLogs.map((log) => {
                  const bad = log.result !== "valid" && log.result !== "duplicate";
                  return (
                    <div key={log.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-white/5 last:border-0">
                      <StatusDot tone={log.result === "valid" ? "green" : log.result === "duplicate" ? "amber" : "red"} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-white/80">
                          {log.studentName ?? <span className="text-white/40 italic">unknown badge</span>}
                          <span className="ml-2 font-mono text-[10px] text-white/30">{log.terminalId}</span>
                        </p>
                        <p className="text-[10px] text-white/35">{log.status ? `status: ${log.status}` : ""} {log.detail && Object.keys(log.detail).length ? `· ${JSON.stringify(log.detail).slice(0, 80)}` : ""}</p>
                      </div>
                      <StatusBadge value={log.result} tone={bad ? "red" : log.result === "duplicate" ? "amber" : "green"} />
                      <span className="text-[10px] font-mono text-white/30">{format(new Date(log.createdAt), "HH:mm:ss")}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </GlowCard>
        )}
      </div>
    </div>
  );
}
