import { type ReactNode, type HTMLAttributes, type ComponentProps } from "react";
import { Loader2 } from "lucide-react";
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
  variant,
  ...rest
}: {
  children: ReactNode;
  accent?: boolean;
  hover?: boolean;
  /** "gradient" adds the aurora gradient border + top sheen. Absent / "default" keeps original look. */
  variant?: "default" | "gradient";
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "gx-card",
        accent && "gx-card-accent",
        !hover && "gx-card-flat",
        variant === "gradient" && "card-gradient-border gx-top-sheen",
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

/* ============================================================
   PHASE 4 — AURORA PRIMITIVES (violet → fuchsia → rose → amber, teal accents)
   ============================================================ */

/**
 * Full-viewport aurora backdrop: layered radial gradient washes plus three
 * slowly drifting blurred blobs (violet / fuchsia / teal). Fixed and -z-10 so
 * it sits behind page content; respects prefers-reduced-motion via CSS.
 */
export function AuroraBackground({
  enabled = true,
  className,
}: {
  enabled?: boolean;
  className?: string;
}) {
  if (!enabled) return null;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "gx-aurora pointer-events-none fixed inset-0 -z-10 overflow-hidden",
        className,
      )}
    >
      <div className="gx-aurora-blob gx-aurora-blob-1" />
      <div className="gx-aurora-blob gx-aurora-blob-2" />
      <div className="gx-aurora-blob gx-aurora-blob-3" />
    </div>
  );
}

/**
 * Primary CTA with an animated aurora gradient (violet → fuchsia → rose →
 * deep amber), a hover shine sweep and the refined gx focus ring. All
 * gradient stops keep ≥ 4.5:1 contrast with white text (WCAG AA).
 * Accepts every native <button> prop; `loading` swaps content for a spinner.
 */
export function GradientButton({
  children,
  className,
  style,
  type = "button",
  disabled,
  loading = false,
  loadingLabel = "Please wait...",
  ...rest
}: {
  children: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
} & ComponentProps<"button">) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={{
        backgroundImage:
          "linear-gradient(115deg, #7C3AED 0%, #C026D3 34%, #E11D48 66%, #B45309 100%)",
        boxShadow:
          "0 0 22px rgba(155, 91, 255, 0.35), 0 10px 30px rgba(192, 38, 211, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.22)",
        ...style,
      }}
      className={cn(
        "group gx-gradient-pan gx-focus-ring relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-xl px-6 py-3",
        "text-sm font-semibold uppercase tracking-widest text-white",
        "transition-[transform,filter,box-shadow] duration-200 hover:brightness-110 active:scale-[0.98]",
        "disabled:cursor-not-allowed disabled:opacity-70",
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="inline-flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {loadingLabel}
        </span>
      ) : (
        children
      )}
      {/* shine sweep */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full"
      />
    </button>
  );
}

/**
 * Glass surface with the aurora gradient border and a subtle top sheen.
 * Pair with `backdrop-blur-xl` (via className) for the full glassmorphism look.
 */
export function GradientCard({
  children,
  className,
  style,
  glow = true,
  sheen = true,
  ...rest
}: {
  children: ReactNode;
  glow?: boolean;
  sheen?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "card-gradient-border rounded-2xl",
        sheen && "gx-top-sheen",
        className,
      )}
      style={{ boxShadow: glow ? "var(--gx-glow-aurora)" : undefined, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}
