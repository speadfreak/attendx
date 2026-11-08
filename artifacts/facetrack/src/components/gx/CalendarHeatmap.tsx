import { useMemo } from "react";
import { format } from "date-fns";

/**
 * GitHub-contribution-style attendance calendar: green = present,
 * amber = late, red = absent, empty = no record. Works for a single
 * student (90-day window) or a whole classroom grid.
 */

export interface HeatmapDay {
  day: string;
  status: string;
  method?: string;
  confidence?: number | null;
}

function statusClass(status?: string): string {
  if (status === "present") return "hm-present";
  if (status === "late") return "hm-late";
  if (status === "absent") return "hm-absent";
  return "hm-empty";
}

export function CalendarHeatmap({
  days,
  weeks = 13,
  onCellClick,
}: {
  days: HeatmapDay[];
  weeks?: number;
  onCellClick?: (d: HeatmapDay) => void;
}) {
  const byDay = useMemo(() => {
    const m = new Map<string, HeatmapDay>();
    for (const d of days) m.set(d.day, d);
    return m;
  }, [days]);

  const grid = useMemo(() => {
    // Build columns of weeks; end column is the current week
    const cols: Array<Array<{ key: string; data?: HeatmapDay; isFuture: boolean }>> = [];
    const today = new Date();
    // walk back to the Sunday of the current week
    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay())); // Saturday of this week
    for (let w = weeks - 1; w >= 0; w--) {
      const col: Array<{ key: string; data?: HeatmapDay; isFuture: boolean }> = [];
      for (let dow = 0; dow < 7; dow++) {
        const d = new Date(end);
        d.setDate(end.getDate() - w * 7 - (6 - dow));
        const key = d.toISOString().slice(0, 10);
        col.push({
          key,
          data: byDay.get(key),
          isFuture: d > today,
        });
      }
      cols.push(col);
    }
    return cols;
  }, [byDay, weeks]);

  const monthLabels = useMemo(() => {
    const labels: Array<{ col: number; label: string }> = [];
    let lastMonth = -1;
    grid.forEach((col, i) => {
      const first = col[0];
      const d = new Date(first.key);
      if (d.getMonth() !== lastMonth) {
        lastMonth = d.getMonth();
        labels.push({ col: i, label: format(d, "MMM") });
      }
    });
    return labels;
  }, [grid]);

  return (
    <div className="overflow-x-auto pb-1">
      <div className="inline-flex flex-col gap-1">
        <div className="flex gap-[3px] min-h-[14px]">
          {grid.map((_, i) => {
            const label = monthLabels.find((m) => m.col === i);
            return (
              <div key={i} className="w-[13px] text-[8px] text-white/30 text-left whitespace-nowrap">
                {label?.label ?? ""}
              </div>
            );
          })}
        </div>
        <div className="flex gap-[3px]">
          {grid.map((col, ci) => (
            <div key={ci} className="flex flex-col gap-[3px]">
              {col.map((cell) => (
                <button
                  key={cell.key}
                  type="button"
                  title={
                    cell.data
                      ? `${cell.key}: ${cell.data.status}${cell.data.confidence != null ? ` (${(cell.data.confidence * 100).toFixed(0)}%)` : ""}`
                      : `${cell.key}: no record`
                  }
                  onClick={() => cell.data && onCellClick?.(cell.data)}
                  className={`heatmap-cell ${cell.isFuture ? "opacity-0" : statusClass(cell.data?.status)}`}
                  aria-label={cell.key}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-2 text-[9px] text-white/30 uppercase tracking-wider">
          <span className="flex items-center gap-1"><span className="heatmap-cell hm-present inline-block" /> Present</span>
          <span className="flex items-center gap-1"><span className="heatmap-cell hm-late inline-block" /> Late</span>
          <span className="flex items-center gap-1"><span className="heatmap-cell hm-absent inline-block" /> Absent</span>
          <span className="flex items-center gap-1"><span className="heatmap-cell hm-empty inline-block" /> No record</span>
        </div>
      </div>
    </div>
  );
}

/** Compact per-day status grid for a classroom heatmap drill-down. */
export function MiniStatusStrip({ days, window }: { days: Record<string, { status: string }>; window: string[] }) {
  return (
    <div className="flex gap-[2px]">
      {window.map((day) => (
        <div
          key={day}
          title={`${day}: ${days[day]?.status ?? "no record"}`}
          className={`heatmap-cell !w-[9px] !h-[14px] !rounded-sm ${statusClass(days[day]?.status)}`}
        />
      ))}
    </div>
  );
}
