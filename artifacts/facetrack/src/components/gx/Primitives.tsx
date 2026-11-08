import { type ReactNode, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Phase 3 design system primitives — the layered glow-card language applied
 * consistently across every surface: soft outer glow + sharp inner border.
 */

export function GlowCard({
  children,
  className,
  accent = false,
  hover = true,
  ...rest
}: {
  children: ReactNode;
  accent?: boolean;
  hover?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "gx-card",
        accent && "gx-card-accent",
        !hover && "gx-card-flat",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Gradient wordmark treatment used for page titles and section headers. */
export function SectionTitle({
  children,
  sub,
  right,
  size = "page",
}: {
  children: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  size?: "page" | "section";
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
      <div>
        <h1
          className={
            size === "page"
              ? "text-2xl sm:text-3xl font-black tracking-tight gx-gradient-text"
              : "text-sm font-semibold uppercase tracking-widest gx-gradient-text"
          }
          style={{ fontFamily: "'Orbitron', monospace" }}
        >
          {children}
        </h1>
        {sub && <p className="text-xs text-white/30 mt-1 tracking-wide">{sub}</p>}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

/** Status → color mapping used by every badge, dot and button. */
export type StatusTone = "green" | "amber" | "red" | "purple" | "cyan" | "slate";

export function statusToneFor(value?: string | null): StatusTone {
  switch (value) {
    case "present":
    case "online":
    case "done":
    case "approved":
    case "valid":
    case "sent":
    case "operational":
      return "green";
    case "late":
    case "pending":
    case "review":
    case "warning":
    case "running":
    case "already marked":
    case "duplicate":
      return "amber";
    case "absent":
    case "offline":
    case "failed":
    case "rejected":
    case "revoked":
    case "expired":
    case "error":
    case "no-identity":
      return "red";
    case "face":
    case "ai":
    case "primary":
      return "purple";
    case "qr":
      return "cyan";
    default:
      return "slate";
  }
}

export function StatusBadge({ value, label, tone }: { value?: string | null; label?: string; tone?: StatusTone }) {
  const t = tone ?? statusToneFor(value);
  return (
    <span className={`st-badge st-badge-${t}`}>
      {label ?? value ?? "—"}
    </span>
  );
}

export function StatusDot({ tone = "slate", pulse = false }: { tone?: StatusTone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex">
      {pulse && (
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
          style={{ background: `rgb(var(--st-${tone === "purple" ? "purple" : tone}))` }}
        />
      )}
      <span className={`st-dot st-dot-${tone} relative inline-flex`} />
    </span>
  );
}

/** Confidence tier → tone (green ≥ accept threshold, amber = review queue). */
export function confidenceTone(confidence: number, acceptThreshold = 0.72): StatusTone {
  if (confidence >= acceptThreshold) return "green";
  if (confidence >= 0.3) return "amber";
  return "red";
}

export function ConfidenceChip({ confidence, threshold }: { confidence: number; threshold?: number }) {
  const tone = confidenceTone(confidence, threshold);
  return (
    <span className={`st-badge st-badge-${tone} font-mono`}>
      {(confidence * 100).toFixed(0)}%
    </span>
  );
}

/** Animated gradient mesh backdrop — subtle, behind content. */
export function MeshBackground({ enabled = true }: { enabled?: boolean }) {
  if (!enabled) return null;
  return <div className="gx-mesh" aria-hidden="true" />;
}

/** Empty state with on-brand styling. */
export function GlowEmpty({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-white/25 text-center">
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3"
        style={{
          background: "rgba(155,91,255,0.06)",
          border: "1px solid rgba(155,91,255,0.14)",
          boxShadow: "var(--gx-glow-outer)",
        }}
      >
        {icon}
      </div>
      <p className="text-sm text-white/45">{title}</p>
      {hint && <p className="text-xs text-white/25 mt-1">{hint}</p>}
    </div>
  );
}
