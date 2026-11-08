import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Bell, ShieldAlert, Server, Briefcase, QrCode, Info } from "lucide-react";
import { api, type NotificationFeed } from "@/lib/api";
import { useLiveEvents } from "@/hooks/useLiveEvents";
import { formatDistanceToNow } from "date-fns";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GlowEmpty } from "@/components/gx/Primitives";

/**
 * Notification center — the events that used to be buried across pages
 * (low-confidence matches, Pi offline, failed SMS jobs, QR anomalies)
 * surfaced in one bell dropdown, refreshed by live push.
 */

const CATEGORY_ICON: Record<string, React.ElementType> = {
  review: ShieldAlert,
  device: Server,
  job: Briefcase,
  qr: QrCode,
  system: Info,
};

const SEVERITY_DOT: Record<string, string> = {
  critical: "st-dot-red",
  warning: "st-dot-amber",
  info: "st-dot-green",
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: "st-badge-red",
  warning: "st-badge-amber",
  info: "st-badge-green",
};

export function NotificationCenter() {
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();
  const { lastEvent } = useLiveEvents();
  const lastLoad = useRef(0);

  const load = (force = false) => {
    const now = Date.now();
    if (!force && now - lastLoad.current < 5000) return;
    lastLoad.current = now;
    api.notifications().then(setFeed).catch(() => {});
  };

  useEffect(() => {
    load(true);
    const t = setInterval(() => load(true), 20000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (lastEvent) load();
  }, [lastEvent]);

  const counts = feed?.counts ?? { total: 0, critical: 0, warning: 0, pendingReviews: 0 };
  const alertCount = counts.critical + counts.warning;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative w-9 h-9 rounded-xl flex items-center justify-center transition-colors hover:bg-purple-500/10"
          style={{ border: "1px solid rgba(155,91,255,0.18)", background: "rgba(20,8,40,0.6)" }}
          aria-label={`Notifications${alertCount ? `, ${alertCount} unread alerts` : ""}`}
          onClick={() => load(true)}
        >
          <Bell size={15} className="text-purple-300" />
          {alertCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold flex items-center justify-center text-white"
              style={{ background: counts.critical > 0 ? "rgb(239,68,68)" : "rgb(245,158,11)", boxShadow: "0 0 8px rgba(239,68,68,0.6)" }}>
              {alertCount > 9 ? "9+" : alertCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[360px] p-0 border-purple-500/20"
        style={{ background: "linear-gradient(135deg, rgba(20,8,40,0.98), rgba(12,4,24,0.99))", boxShadow: "var(--gx-glow-outer-strong)" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Bell size={13} className="text-purple-400" />
            <span className="text-xs font-semibold text-white/70 uppercase tracking-widest">System Events</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="st-badge st-badge-red">{counts.critical} critical</span>
            <span className="st-badge st-badge-amber">{counts.warning} review</span>
          </div>
        </div>
        <div className="max-h-[380px] overflow-y-auto">
          {!feed || feed.items.length === 0 ? (
            <GlowEmpty icon={<Bell size={22} />} title="All clear" hint="No system events right now." />
          ) : (
            feed.items.map((item) => {
              const Icon = CATEGORY_ICON[item.category] ?? Info;
              return (
                <button
                  key={item.id}
                  className="w-full text-left px-4 py-3 border-b border-white/5 last:border-0 hover:bg-purple-500/8 transition-colors flex gap-3"
                  onClick={() => { setOpen(false); setLocation(item.link); }}
                >
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${item.severity === "critical" ? "bg-red-500/10 border border-red-500/20" : "bg-amber-500/10 border border-amber-500/20"}`}>
                    <Icon size={13} className={item.severity === "critical" ? "text-red-400" : "text-amber-400"} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`st-dot ${SEVERITY_DOT[item.severity]}`} />
                      <p className="text-xs font-medium text-white/80 truncate">{item.title}</p>
                    </div>
                    <p className="text-[11px] text-white/35 mt-0.5 line-clamp-2">{item.detail}</p>
                    <p className="text-[9px] text-white/25 mt-1 uppercase tracking-wider">
                      {formatDistanceToNow(new Date(item.at), { addSuffix: true })} · {item.category}
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>
        <div className="px-4 py-2 border-t border-white/5 text-[9px] text-white/25 flex items-center justify-between">
          <span>{counts.pendingReviews} matches awaiting review</span>
          <button className="text-purple-400 hover:text-purple-300" onClick={() => { setOpen(false); setLocation("/review-queue"); }}>
            Open review queue →
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
