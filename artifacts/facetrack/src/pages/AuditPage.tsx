import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type AuditRow } from "@/lib/api";
import { GlowCard, SectionTitle, StatusBadge, MeshBackground, GlowEmpty, StatusDot } from "@/components/gx/Primitives";
import { GlowSkeleton } from "@/components/gx/Skeletons";
import { format } from "date-fns";
import { ScrollText, Search, ShieldCheck, ShieldAlert, Terminal, KeyRound, UserCog, Download } from "lucide-react";

/**
 * ADMIN AUDIT TRAIL — searchable, filterable table of every sensitive action:
 * terminal/SSH-ish commands, manual attendance overrides, review decisions,
 * admin logins, QR issuance/revocation, SMS template edits, bulk enrollment.
 */

const BASE = import.meta.env.BASE_URL ?? "/";

async function authGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}api${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem("ft_token")}` } });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

function actionTone(action: string): { tone: "green" | "amber" | "red" | "purple" | "cyan" | "slate"; label: string } {
  if (action.includes("approved") || action.includes("created") && action.includes("admin")) return { tone: "green", label: "ok" };
  if (action.includes("failed") || action.includes("deleted") || action.includes("revoked")) return { tone: "red", label: "risk" };
  if (action.includes("issued") || action.includes("rotated") || action.includes("qr")) return { tone: "cyan", label: "qr" };
  if (action.includes("updated") || action.includes("cleared") || action.includes("sweep")) return { tone: "amber", label: "change" };
  return { tone: "purple", label: "action" };
}

function actionIcon(action: string): React.ElementType {
  if (action.includes("pi.") || action.includes("fan")) return Terminal;
  if (action.includes("admin.")) return UserCog;
  if (action.includes("qr.")) return KeyRound;
  return ScrollText;
}

export default function AuditPage() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const { data: logs, isLoading } = useQuery<AuditRow[]>({
    queryKey: ["audit-logs"],
    queryFn: () => api.auditLogs(200),
    refetchInterval: 20000,
  });

  const types = useMemo(() => {
    const set = new Set<string>();
    for (const log of logs ?? []) set.add(log.targetType);
    return Array.from(set).sort();
  }, [logs]);

  const filtered = useMemo(() => {
    let rows = logs ?? [];
    if (typeFilter !== "all") rows = rows.filter((r) => r.targetType === typeFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((r) =>
        r.action.toLowerCase().includes(q) ||
        r.actorName?.toLowerCase().includes(q) ||
        r.targetId?.toLowerCase().includes(q) ||
        JSON.stringify(r.payload).toLowerCase().includes(q)
      );
    }
    return rows;
  }, [logs, search, typeFilter]);

  const exportCsv = () => {
    if (!filtered.length) return;
    const csv = [
      ["time", "actor", "action", "target_type", "target_id", "payload"].join(","),
      ...filtered.map((r) => [
        r.createdAt,
        `"${r.actorName ?? "system"}"`,
        r.action,
        r.targetType,
        `"${r.targetId ?? ""}"`,
        `"${JSON.stringify(r.payload).replace(/"/g, "'")}"`
      ].join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `attendx_audit_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5 max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <SectionTitle sub="EVERY SENSITIVE ACTION · SEARCHABLE FOREVER">
            AUDIT TRAIL
          </SectionTitle>
          <div className="flex items-center gap-2">
            <span className="st-badge st-badge-green"><ShieldCheck size={11} /> {filtered.length} entries</span>
            <button className="st-badge st-badge-slate px-3 py-2" onClick={exportCsv} disabled={!filtered.length}>
              <Download size={11} /> CSV
            </button>
          </div>
        </div>

        <GlowCard className="p-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-white/25" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search actions, actors, payloads…"
                className="w-full bg-black/40 border border-purple-500/15 rounded-lg pl-9 pr-3 py-2 text-sm text-white/80 focus:outline-none focus:border-purple-500/45"
              />
            </div>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="bg-black/40 border border-purple-500/15 rounded-lg px-3 py-2 text-sm text-white/70"
            >
              <option value="all">All target types</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </GlowCard>

        <GlowCard className="p-2">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array(10).fill(0).map((_, i) => <GlowSkeleton key={i} className="h-10 !rounded-lg" />)}
            </div>
          ) : !filtered.length ? (
            <GlowEmpty icon={<ScrollText size={24} />} title="No audit entries match" hint="Sensitive actions will appear here as they happen." />
          ) : (
            <div className="max-h-[560px] overflow-y-auto">
              {filtered.map((log) => {
                const tone = actionTone(log.action);
                const Icon = actionIcon(log.action);
                return (
                  <div key={log.id} className="flex items-start gap-3 px-3 py-3 border-b border-white/5 last:border-0 hover:bg-purple-500/5 transition-colors">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5`}
                      style={{ background: `rgba(var(--st-${tone.tone}),0.08)`, border: `1px solid rgba(var(--st-${tone.tone}),0.2)` }}>
                      <Icon size={13} className={`st-${tone.tone}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatusDot tone={tone.tone} />
                        <span className="text-xs font-mono text-white/80">{log.action}</span>
                        <StatusBadge value={tone.label} tone={tone.tone} />
                      </div>
                      <p className="text-[11px] text-white/40 mt-1">
                        {log.actorName ?? "system"} → <span className="font-mono">{log.targetType}</span>
                        {log.targetId ? ` #${log.targetId}` : ""}
                      </p>
                      {Object.keys(log.payload ?? {}).length > 0 && (
                        <p className="text-[10px] text-white/25 font-mono mt-1 truncate max-w-lg">
                          {JSON.stringify(log.payload)}
                        </p>
                      )}
                    </div>
                    <span className="text-[10px] font-mono text-white/30 shrink-0 mt-1">
                      {format(new Date(log.createdAt), "MMM d HH:mm:ss")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </GlowCard>
      </div>
    </div>
  );
}
