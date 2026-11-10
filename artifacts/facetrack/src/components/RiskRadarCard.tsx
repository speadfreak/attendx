import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Radar, ArrowRight, ShieldAlert, ShieldCheck, Eye } from "lucide-react";
import { GlowCard, GlowEmpty } from "@/components/gx/Primitives";
import { api, type RiskLevel, type StudentRisk } from "@/lib/api";

/**
 * ABSENCE RISK RADAR — explainable early-warning panel.
 * Ranks students by statistical disengagement risk and shows WHY.
 */

const LEVEL_STYLE: Record<RiskLevel, { dot: string; text: string; bar: string; label: string }> = {
  critical: { dot: "#ef4444", text: "text-red-400", bar: "linear-gradient(90deg,#ef4444,#f87171)", label: "CRITICAL" },
  elevated: { dot: "#f97316", text: "text-orange-400", bar: "linear-gradient(90deg,#f97316,#fb923c)", label: "ELEVATED" },
  watch: { dot: "#eab308", text: "text-amber-300", bar: "linear-gradient(90deg,#eab308,#facc15)", label: "WATCH" },
  low: { dot: "#10b981", text: "text-emerald-400", bar: "linear-gradient(90deg,#10b981,#34d399)", label: "LOW" },
};

function RiskRow({ risk }: { risk: StudentRisk }) {
  const style = LEVEL_STYLE[risk.level];
  return (
    <div className="rounded-xl border border-white/5 bg-black/20 p-3 hover:border-purple-500/25 transition-colors">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-40" style={{ background: style.dot }} />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: style.dot }} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white/85" title={risk.name}>{risk.name}</p>
          <p className="truncate text-[10px] font-mono text-white/35" title={`${risk.studentCode} · ${risk.classroomName ?? "no classroom"}`}>
            {risk.studentCode}{risk.classroomName ? ` · ${risk.classroomName}` : ""}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-sm font-bold ${style.text}`}>{risk.score}</p>
          <p className="text-[9px] uppercase tracking-widest text-white/30">{style.label}</p>
        </div>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, risk.score)}%`, background: style.bar }} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {risk.reasons.slice(0, 3).map((reason, i) => (
          <span key={i} className="rounded-md border border-white/5 bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-white/45">
            {reason}
          </span>
        ))}
      </div>
    </div>
  );
}

export function RiskRadarCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["absence-risk"],
    queryFn: () => api.absenceRisk({ limit: 6 }),
    refetchInterval: 90_000,
  });

  const counts = data?.levelCounts;
  const worrying = (counts?.critical ?? 0) + (counts?.elevated ?? 0);

  return (
    <GlowCard variant="gradient" className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <Radar size={14} className="text-purple-400 shrink-0" />
          <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">ABSENCE RISK RADAR</h3>
          <span className="text-[10px] text-white/30 font-mono hidden sm:inline">· {data?.windowDays ?? 21}d window</span>
        </div>
        {counts && (
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            {(Object.entries(counts) as Array<[RiskLevel, number]>).map(([level, n]) => (
              <span key={level} className="inline-flex items-center gap-1 rounded-md border border-white/5 bg-white/[0.03] px-1.5 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: LEVEL_STYLE[level].dot }} />
                <span className="text-white/45">{n} {level}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array(4).fill(0).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-white/[0.04]" />)}
        </div>
      ) : isError || !data ? (
        <GlowEmpty icon={<ShieldAlert size={22} />} title="Radar unavailable" hint="Could not compute risk scores right now." />
      ) : data.top.length === 0 ? (
        <GlowEmpty icon={<ShieldCheck size={22} />} title="No students to rank" hint="Enroll students and record attendance to power the radar." />
      ) : (
        <>
          {worrying > 0 && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-400/15 bg-amber-400/[0.05] p-2.5 text-[11px] text-amber-200/80">
              <Eye size={13} className="mt-0.5 shrink-0 text-amber-300" />
              <span className="min-w-0 flex-1">
                {worrying} student{worrying === 1 ? "" : "s"} need attention. Risk blends absence rate, consecutive misses, lateness and trend — fully explainable.
              </span>
            </div>
          )}
          <div className="space-y-2">
            {data.top.map((risk) => <RiskRow key={risk.studentId} risk={risk} />)}
          </div>
          <Link
            to="/students"
            className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-purple-300/70 transition-colors hover:text-purple-200"
          >
            open student database <ArrowRight size={12} />
          </Link>
        </>
      )}
    </GlowCard>
  );
}
