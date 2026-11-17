import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Arduino Lab — serial plotter.
 *
 * Canvas strip-chart for numeric fields parsed out of the monitor stream
 * (ATX1 status/ack payloads, `DIST:42`-style chatter). Index-based x axis
 * over a rolling window, one colored polyline per series, auto-scaled y,
 * DPI-crisp. Renders an explicit "listening" empty state — never a blank box.
 */

export const MAX_PLOT_POINTS = 240;
export const MAX_PLOT_SERIES = 4;

/** Keys too noisy/meaningless to plot. */
const PLOT_BLACKLIST = new Set([
  "ts", "millis", "uptime", "uptimems", "deviceMillis", "gate", "sensor",
  "code", "type", "heartbeat", "relay", "pong", "led",
]);

const SERIES_COLORS = ["#34d399", "#a78bfa", "#fbbf24", "#22d3ee"];

export interface PlotState {
  /** Insertion-ordered series names (≤ MAX_PLOT_SERIES). */
  names: string[];
  /** name → ring of values, oldest first, ≤ MAX_PLOT_POINTS each. */
  data: Record<string, number[]>;
}

/** Fold one line's plottable values into the rolling window state. */
export function mergePlot(prev: PlotState, values: Record<string, number>): PlotState {
  let names = prev.names.slice();
  const data: Record<string, number[]> = {};
  for (const n of names) data[n] = prev.data[n]!.slice();
  for (const [key, value] of Object.entries(values)) {
    if (!names.includes(key)) {
      if (names.length >= MAX_PLOT_SERIES) continue;
      names = [...names, key];
      data[key] = [];
    }
    const series = data[key]!;
    series.push(value);
    if (series.length > MAX_PLOT_POINTS) series.splice(0, series.length - MAX_PLOT_POINTS);
  }
  return { names, data };
}

/**
 * Pull plottable `key: number` pairs out of one monitor line. ATX1 JSON
 * payloads contribute their numeric fields; plain chatter contributes
 * `key=value` / `key: value` matches. Returns {} when nothing plots.
 */
export function extractPlotValues(text: string, payload: Record<string, unknown> | null): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (key: string, value: unknown) => {
    const k = key.toLowerCase();
    if (PLOT_BLACKLIST.has(k) || typeof value !== "number" || !Number.isFinite(value)) return;
    if (out[k] === undefined) out[k] = value;
  };

  if (payload) {
    for (const [key, value] of Object.entries(payload)) add(key, value);
    if (Object.keys(out).length > 0) return out;
  }

  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) add(m[1]!, Number(m[2]));
  return out;
}

interface PlotterProps {
  plot: PlotState;
  heightClass?: string;
  className?: string;
}

export function Plotter({ plot, heightClass = "h-56", className }: PlotterProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const latest = useMemo(() => {
    return plot.names.map((n) => {
      const series = plot.data[n];
      return { name: n, color: SERIES_COLORS[plot.names.indexOf(n) % SERIES_COLORS.length]!, value: series?.[series.length - 1] };
    });
  }, [plot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(rect.width, 10);
      const height = Math.max(rect.height, 10);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const padL = 8;
      const padR = 44;
      const padT = 10;
      const padB = 14;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;

      // grid
      ctx.strokeStyle = "rgba(148,163,184,0.13)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padT + (plotH * i) / 4;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
      }

      const seriesList = plot.names.map((n) => plot.data[n] ?? []);
      const active = seriesList.filter((s) => s.length > 0);
      if (active.length === 0) return;

      let min = Infinity;
      let max = -Infinity;
      for (const s of active) {
        for (const v of s) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (min === max) {
        min -= 1;
        max += 1;
      }
      const span = max - min;
      min -= span * 0.08;
      max += span * 0.08;

      const xFor = (idx: number, len: number) => padL + (len <= 1 ? plotW : (idx / (len - 1)) * plotW);
      const yFor = (v: number) => padT + (1 - (v - min) / (max - min)) * plotH;

      // axes labels (right edge)
      ctx.fillStyle = "rgba(148,163,184,0.6)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "left";
      const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(Math.abs(max - min) < 4 ? 1 : 0));
      ctx.fillText(fmt(max), padL + plotW + 4, padT + 8);
      ctx.fillText(fmt(min), padL + plotW + 4, padT + plotH);

      plot.names.forEach((name, si) => {
        const series = plot.data[name] ?? [];
        if (series.length === 0) return;
        const color = SERIES_COLORS[si % SERIES_COLORS.length]!;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        series.forEach((v, i) => {
          const x = xFor(i, series.length);
          const y = yFor(v);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // last point marker
        const lastX = xFor(series.length - 1, series.length);
        const lastY = yFor(series[series.length - 1]!);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [plot]);

  const hasData = plot.names.some((n) => (plot.data[n]?.length ?? 0) > 0);

  return (
    <div className={cn("space-y-2", className)}>
      <div ref={wrapRef} className={cn("relative overflow-hidden rounded-lg border border-border bg-slate-950/95", heightClass)}>
        <canvas ref={canvasRef} aria-label="Serial data plot" className="absolute inset-0" />
        {!hasData && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
            <p className="font-mono text-[11px] text-slate-600">
              listening for numeric fields — STATUS replies, distCm, DIST:42-style chatter…
            </p>
          </div>
        )}
      </div>
      {latest.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {latest.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5 font-mono text-[10px]">
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="text-foreground/50">{s.name}</span>
              <span className="text-foreground/85">{s.value ?? "—"}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
