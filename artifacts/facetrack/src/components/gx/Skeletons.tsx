import { cn } from "@/lib/utils";

/**
 * On-brand skeleton loaders shaped like the glow-card system — shimmer sweep
 * instead of "Loading..." text or placeholder letters.
 */

export function GlowSkeleton({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("gx-skeleton relative", className)}>
      {children}
    </div>
  );
}

export function StatSkeletonRow({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array(count).fill(0).map((_, i) => (
        <GlowSkeleton key={i} className="h-28" />
      ))}
    </>
  );
}

export function ChartSkeleton({ height = "h-56 sm:h-72" }: { height?: string }) {
  return (
    <GlowSkeleton className={cn("w-full", height)}>
      <div className="absolute bottom-4 left-6 right-6 flex items-end gap-2 h-2/3 opacity-40">
        {[55, 80, 40, 65, 90, 50, 70].map((h, i) => (
          <div
            key={i}
            className="flex-1 rounded-t bg-purple-400/20"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
    </GlowSkeleton>
  );
}

export function FeedSkeletonRow({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array(rows).fill(0).map((_, i) => (
        <div key={i} className="gx-skeleton h-12 !rounded-xl">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-purple-400/10" />
          <div className="absolute left-14 top-3 w-28 h-2.5 rounded bg-white/10" />
          <div className="absolute left-14 top-7 w-20 h-2 rounded bg-white/5" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array(rows).fill(0).map((_, r) => (
        <div key={r} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {Array(cols).fill(0).map((_, c) => (
            <div key={c} className="gx-skeleton h-7 !rounded-md" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <GlowSkeleton className="h-8 w-64 !rounded-lg" />
        <GlowSkeleton className="h-3 w-40 !rounded" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatSkeletonRow />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2"><ChartSkeleton /></div>
        <div><GlowSkeleton className="h-64" /></div>
      </div>
    </div>
  );
}
