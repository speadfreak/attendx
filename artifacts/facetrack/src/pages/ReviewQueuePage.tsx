import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ReviewCandidates, type ReviewRow } from "@/lib/api";
import { GlowCard, SectionTitle, StatusBadge, StatusDot, ConfidenceChip, MeshBackground, GlowEmpty, confidenceTone } from "@/components/gx/Primitives";
import { FeedSkeletonRow, GlowSkeleton } from "@/components/gx/Skeletons";
import { useToast } from "@/hooks/use-toast";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { format } from "date-fns";
import {
  ShieldAlert, Check, X, Repeat, ScanFace, MapPin, Fingerprint, Gavel,
} from "lucide-react";

/**
 * REVIEW QUEUE — every ambiguous face match awaiting an admin decision.
 * Card shows the descriptor fingerprint, expected seat hint (tie-breaker,
 * never auto-applied), top-3 candidates with scores, and one-click
 * approve / reject / reassign.
 */

/** Deterministic face-fingerprint visual from the review id (stable artwork). */
function FingerprintArt({ seed, tone }: { seed: number; tone: string }) {
  const bars = useMemo(() => {
    let x = seed * 9301 + 49297;
    const rand = () => {
      x = (x * 9301 + 49297) % 233280;
      return x / 233280;
    };
    return Array(24).fill(0).map(() => 25 + rand() * 75);
  }, [seed]);
  return (
    <div className="flex items-end gap-[2px] h-16">
      {bars.map((h, i) => (
        <div
          key={i}
          className="flex-1 rounded-t"
          style={{
            height: `${h}%`,
            background: `linear-gradient(180deg, rgb(var(--st-${tone}) / 0.9), rgb(var(--st-${tone}) / 0.25))`,
          }}
        />
      ))}
    </div>
  );
}

export default function ReviewQueuePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { lastEvent } = useLiveEvents();
  const [candidates, setCandidates] = useState<Record<number, ReviewCandidates | null>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const { data: reviews, isLoading, refetch } = useQuery<ReviewRow[]>({
    queryKey: ["reviews"],
    queryFn: () => api.reviews(),
    refetchInterval: 15000,
  });

  useEffect(() => {
    if (lastEvent?.type === "review.created" || lastEvent?.type === "review.decided") {
      void refetch();
    }
  }, [lastEvent, refetch]);

  const loadCandidates = async (id: number) => {
    if (candidates[id] !== undefined) return;
    try {
      const data = await api.reviewCandidates(id);
      setCandidates((prev) => ({ ...prev, [id]: data }));
    } catch {
      setCandidates((prev) => ({ ...prev, [id]: null }));
    }
  };

  useEffect(() => {
    for (const r of reviews ?? []) void loadCandidates(r.id);
  }, [reviews]);

  const decide = async (id: number, decision: "approve" | "reject" | "reassign", studentId?: number) => {
    setBusyId(id);
    try {
      const result = await api.reviewDecision(id, decision, studentId ?? null);
      const labels = { approve: "approved", reject: "rejected", reassign: "reassigned" };
      toast({
        title: `Match ${labels[decision]}`,
        description: result.attendance
          ? `Attendance ${result.attendance.alreadyMarked ? "already existed" : "committed"} for today.`
          : "Review resolved.",
      });
      void refetch();
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (e: any) {
      toast({ title: "Decision failed", description: e.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = reviews?.length ?? 0;

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5 max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <SectionTitle sub="AMBIGUOUS FACE MATCHES · ONE-CLICK DECISIONS">
            REVIEW QUEUE
          </SectionTitle>
          <div className="flex items-center gap-2">
            <span className="st-badge st-badge-amber">
              <ShieldAlert size={11} /> {pendingCount} pending
            </span>
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3"><FeedSkeletonRow rows={4} /></div>
        ) : !reviews?.length ? (
          <GlowCard className="p-6">
            <GlowEmpty
              icon={<ScanFace size={26} />}
              title="Queue is clear"
              hint="Low-confidence gate matches land here automatically — approve, reject or reassign them."
            />
          </GlowCard>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {reviews.map((review) => {
              const cands = candidates[review.id];
              const tone = confidenceTone(review.confidence);
              return (
                <GlowCard key={review.id} accent className="p-5">
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-11 h-11 rounded-xl flex items-center justify-center"
                        style={{
                          background: `rgba(var(--st-${tone}),0.10)`,
                          border: `1px solid rgba(var(--st-${tone}),0.25)`,
                          boxShadow: `0 0 14px rgba(var(--st-${tone}),0.2)`,
                        }}
                      >
                        <Fingerprint size={18} className={`st-${tone}`} />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-white/85">{review.studentName ?? "Unknown face"}</p>
                        <p className="text-[10px] text-white/35">
                          {review.classroomName ?? "no classroom"} · {review.source} · {format(new Date(review.createdAt), "HH:mm")}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <ConfidenceChip confidence={review.confidence} />
                      {review.expectedSeat && (
                        <span className="st-badge st-badge-cyan" title="Seating-map tie-breaker hint — never auto-applied">
                          <MapPin size={10} /> seat {review.expectedSeat}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* descriptor fingerprint */}
                  <div className="rounded-xl bg-black/30 border border-white/5 p-3 mb-4">
                    <p className="text-[9px] uppercase tracking-widest text-white/30 mb-2">Captured face signature</p>
                    <FingerprintArt seed={review.id} tone={tone} />
                  </div>

                  {/* candidates */}
                  <div className="space-y-1.5 mb-4">
                    <p className="text-[9px] uppercase tracking-widest text-white/30 mb-1">Top candidates</p>
                    {!cands ? (
                      <GlowSkeleton className="h-16 !rounded-lg" />
                    ) : cands.candidates.length === 0 ? (
                      <p className="text-xs text-white/30 italic">No face encodings to compare against.</p>
                    ) : (
                      cands.candidates.map((c, i) => (
                        <div
                          key={c.studentId}
                          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/5"
                        >
                          <span className="text-[10px] font-mono text-white/25 w-4">#{i + 1}</span>
                          <span className="text-xs text-white/75 flex-1 truncate">{c.name}</span>
                          <span className="text-[10px] font-mono text-white/30">d={c.distance}</span>
                          <ConfidenceChip confidence={c.confidence} />
                          <button
                            className="st-badge st-badge-purple"
                            disabled={busyId === review.id}
                            onClick={() => decide(review.id, "reassign", c.studentId)}
                            title="Mark this student present instead"
                          >
                            <Repeat size={10} /> assign
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  {/* actions */}
                  <div className="flex gap-2">
                    <button
                      disabled={busyId === review.id || !review.studentId}
                      onClick={() => decide(review.id, "approve")}
                      className="flex-1 py-2 rounded-lg text-xs font-semibold text-emerald-200 bg-emerald-500/12 border border-emerald-500/25 hover:bg-emerald-500/20 transition-all disabled:opacity-40"
                    >
                      <Check size={12} className="inline mr-1" /> Approve
                    </button>
                    <button
                      disabled={busyId === review.id}
                      onClick={() => decide(review.id, "reject")}
                      className="flex-1 py-2 rounded-lg text-xs font-semibold text-red-200 bg-red-500/12 border border-red-500/25 hover:bg-red-500/20 transition-all disabled:opacity-40"
                    >
                      <X size={12} className="inline mr-1" /> Reject
                    </button>
                  </div>
                </GlowCard>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
