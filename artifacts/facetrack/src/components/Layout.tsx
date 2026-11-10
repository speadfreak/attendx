import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { useAuth } from "@/contexts/AuthContext";
import { useLiveEvents, type LiveStatus } from "@/hooks/useLiveEvents";
import { NotificationCenter } from "@/components/NotificationCenter";
import { openCommandPalette } from "@/components/CommandPalette";
import { api, type FraudSummary } from "@/lib/api";
import {
  LayoutDashboard, Users, School,
  FileText, MessageSquare, LogOut, UserCog, Menu, X, ServerCog,
  QrCode, DoorOpen, ScrollText, ShieldAlert, Search, Command, ScanFace,
  MapPin, Download, PanelLeftClose, PanelLeftOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import gsap from "gsap";

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  roles?: Array<"super_admin" | "admin" | "teacher">;
  /** Optional live count badge — "fraud" wires the open-signal count. */
  badge?: "fraud";
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Collapsed icon-rail width (px) — rail tooltips anchor just past this edge. */
const RAIL_WIDTH = 76;
/** localStorage flag for the collapsed sidebar ("1" collapsed / "0" expanded). */
const SIDEBAR_COLLAPSED_KEY = "gx-sidebar-collapsed";

/** Shared micro-animation for labels that morph with the sidebar rail. */
const railLabelMotion = {
  initial: { opacity: 0, x: -6 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -6 },
  transition: { duration: 0.18, ease: "easeOut" },
} as const;

/**
 * Page → accent chemistry map (pure presentation). Sets the --gx-accent-*
 * vars on the layout root so the aurora backdrop + every gx-* utility in the
 * active page inherits the domain gradient. No data/logic impact.
 */
const PAGE_THEMES: Record<string, string> = {
  "/dashboard": "gx-theme-dashboard",
  "/attendance": "gx-theme-attendance",
  "/qr-terminal": "gx-theme-qr",
  "/students": "gx-theme-students",
  "/classrooms": "gx-theme-students",
  "/review-queue": "gx-theme-review",
  "/fraud": "gx-theme-fraud",
  "/reports": "gx-theme-default",
  "/qr-manager": "gx-theme-qr",
  "/sms-logs": "gx-theme-sms",
  "/audit": "gx-theme-default",
  "/sms-templates": "gx-theme-sms",
  "/admins": "gx-theme-default",
  "/operations": "gx-theme-operations",
  "/gates": "gx-theme-gates",
};

/** Same flat nav order as before, now grouped for section headers/rail separators. */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { href: "/dashboard",   label: "Dashboard",   icon: LayoutDashboard },
      { href: "/attendance",  label: "Active Scan", icon: ScanFace },
      { href: "/qr-terminal", label: "QR Terminal", icon: DoorOpen },
    ],
  },
  {
    label: "People",
    items: [
      { href: "/students",   label: "Students",   icon: Users },
      { href: "/classrooms", label: "Classrooms", icon: School },
    ],
  },
  {
    label: "Integrity",
    items: [
      { href: "/review-queue", label: "Review Queue", icon: ShieldAlert },
      { href: "/fraud",        label: "Fraud Radar",  icon: ShieldAlert, badge: "fraud" },
    ],
  },
  {
    label: "Records",
    items: [
      { href: "/reports",    label: "Reports",   icon: FileText },
      { href: "/qr-manager", label: "QR Badges", icon: QrCode },
      { href: "/sms-logs",   label: "SMS Logs",  icon: MessageSquare },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/audit",         label: "Audit Trail",    icon: ScrollText,    roles: ["super_admin", "admin"] },
      { href: "/sms-templates", label: "SMS Templates",  icon: MessageSquare, roles: ["super_admin", "admin"] },
      { href: "/admins",        label: "Admins",         icon: UserCog,       roles: ["super_admin", "admin"] },
      { href: "/operations",    label: "Operations",     icon: ServerCog,     roles: ["super_admin", "admin"] },
      { href: "/gates",         label: "Gates & Geofence", icon: MapPin,      roles: ["super_admin", "admin"] },
    ],
  },
];

export function RoleBadge({ role }: { role?: string }) {
  if (!role) return null;
  const map: Record<string, { label: string; cls: string }> = {
    super_admin: { label: "SUPER ADMIN", cls: "st-badge-purple" },
    admin: { label: "ADMIN", cls: "st-badge-green" },
    teacher: { label: "TEACHER", cls: "st-badge-amber" },
  };
  const m = map[role] ?? { label: role.toUpperCase(), cls: "st-badge-slate" };
  return <span className={`st-badge ${m.cls}`}>{m.label}</span>;
}

export function LiveBadge() {
  const { status } = useLiveEvents();
  const tone: Record<LiveStatus, { cls: string; label: string }> = {
    live: { cls: "st-dot-green", label: "LIVE" },
    polling: { cls: "st-dot-amber", label: "POLLING" },
    connecting: { cls: "st-dot-slate", label: "SYNC" },
    offline: { cls: "st-dot-red", label: "OFFLINE" },
  };
  const t = tone[status];
  return (
    <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/30 border border-white/5 text-[9px] font-mono text-white/50 tracking-widest">
      <span className={`st-dot ${t.cls} ${status === "live" ? "animate-pulse" : ""}`} />
      {t.label}
    </span>
  );
}

/**
 * Subtle network dot — mirrors navigator.onLine so staff can tell spooled
 * (offline) kiosk scans from failed uploads. Sits next to the install button.
 */
function NetDot() {
  const [online, setOnline] = useState<boolean>(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return (
    <span
      title={online ? "Network online" : "Network offline — scans will spool locally"}
      className={`st-dot ${online ? "st-dot-green" : "st-dot-red"} ${online ? "" : "animate-pulse"}`}
    />
  );
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/** PWA install pill — renders only while the browser advertises installability. */
function InstallAppButton() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferredPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!deferredPrompt) return null;
  return (
    <button
      onClick={() => {
        void deferredPrompt.prompt();
        setDeferredPrompt(null);
      }}
      className="inline-flex items-center gap-1.5 px-3 py-2 min-h-11 rounded-full text-[10px] font-mono tracking-widest text-purple-300 bg-purple-500/10 border border-purple-500/25 hover:bg-purple-500/20 transition-colors"
      title="Install AttendX as an app"
    >
      <Download size={11} />
      INSTALL APP
    </button>
  );
}

/** Open fraud-signal count for the sidebar badge — cheap 60s poll. */
function FraudNavBadge({ compact = false }: { compact?: boolean }) {
  const { data } = useQuery<FraudSummary>({
    queryKey: ["fraud-summary-nav"],
    queryFn: api.fraudSummary,
    refetchInterval: 60000,
    staleTime: 30000,
  });
  const open = data?.byStatus?.open ?? 0;
  if (!open) return null;
  if (compact) {
    // Collapsed rail: count survives as a tiny glowing numbered dot on the tile.
    return (
      <span
        className="absolute -top-1 -right-1 z-20 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-mono font-bold leading-none text-red-100"
        style={{
          background: "linear-gradient(135deg, rgba(248,113,113,0.38), rgba(239,68,68,0.28))",
          border: "1px solid rgba(248,113,113,0.6)",
          boxShadow: "0 0 10px rgba(248,113,113,0.5)",
        }}
      >
        {open > 99 ? "99+" : open}
      </span>
    );
  }
  return (
    <span className="gx-chip gx-chip-red font-mono">
      {open > 99 ? "99+" : open}
    </span>
  );
}

/** Global toast bridge for command-palette actions (gx-toast events). */
function GlobalToastBridge() {
  const { toast } = useToast();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ message: string; error?: boolean }>).detail;
      toast({
        title: detail.error ? "Action failed" : "Success",
        description: detail.message,
        variant: detail.error ? "destructive" : "default",
      });
    };
    window.addEventListener("gx-toast", handler);
    return () => window.removeEventListener("gx-toast", handler);
  }, [toast]);
  return null;
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { admin, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const pageTheme = PAGE_THEMES[location] ?? "gx-theme-default";

  // ── Collapse system (desktop ≥ md): persisted icon rail ──────────────
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [railTip, setRailTip] = useState<{ label: string; top: number } | null>(null);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable — the toggle still works for this session */
      }
      return next;
    });
    setRailTip(null);
  }, []);

  // ⌘B / Ctrl+B toggles the rail (ignored while typing in text fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.key !== "b" && e.key !== "B")) return;
      if (e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      toggleCollapsed();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleCollapsed]);

  /** Hover/focus tooltip for the collapsed rail — rendered viewport-fixed. */
  const showRailTip = (label: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setRailTip({ label, top: r.top + r.height / 2 });
  };
  const hideRailTip = () => setRailTip(null);

  const sidebarRef = useRef<HTMLElement>(null);
  const navItemsRef = useRef<HTMLDivElement[]>([]);
  const logoRef = useRef<HTMLDivElement>(null);
  const logoImgRef = useRef<HTMLImageElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const isTeacher = admin?.role === "teacher";

  // Sidebar mount animation
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set(sidebarRef.current, { x: -20, opacity: 0 });
      gsap.set(navItemsRef.current.filter(Boolean), { x: -15, opacity: 0 });
      gsap.set(logoRef.current, { opacity: 0, y: -10 });

      gsap.to(sidebarRef.current, { x: 0, opacity: 1, duration: 0.5, ease: "expo.out" });
      gsap.to(logoRef.current, { opacity: 1, y: 0, duration: 0.4, delay: 0.2, ease: "expo.out" });
      gsap.to(navItemsRef.current.filter(Boolean), {
        x: 0, opacity: 1, duration: 0.4, ease: "expo.out",
        stagger: 0.04, delay: 0.25,
      });

      gsap.to(logoImgRef.current, {
        filter: "drop-shadow(0 0 12px rgba(155,91,255,0.9)) drop-shadow(0 0 4px rgba(155,91,255,1))",
        duration: 2, yoyo: true, repeat: -1, ease: "sine.inOut",
      });
    }, sidebarRef);
    return () => ctx.revert();
  }, []);

  useEffect(() => {
    if (!pageRef.current) return;
    gsap.fromTo(pageRef.current,
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.45, ease: "expo.out" }
    );
  }, [location]);

  const handleNavHover = (el: HTMLDivElement | null, enter: boolean) => {
    if (!el) return;
    gsap.to(el, {
      x: enter ? 4 : 0,
      duration: 0.2, ease: "power2.out"
    });
  };

  const NavLinks = ({ collapsed: rail = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) => {
    const groups = NAV_GROUPS
      .map((g) => ({
        label: g.label,
        items: g.items.filter((it) => !it.roles || !isTeacher || it.roles.includes("teacher")),
      }))
      .filter((g) => g.items.length > 0);

    // Flat GSAP-stagger indices continue across group boundaries.
    let acc = 0;
    const starts = groups.map((g) => {
      const s = acc;
      acc += g.items.length;
      return s;
    });

    return (
      <nav className="flex-1 min-h-0 p-3 space-y-1 overflow-y-auto overscroll-contain">
        {groups.map((group, gi) => (
          <div key={group.label} className={gi === 0 ? "" : "pt-3"}>
            {/* Collapsed rail: hairline separators stand in for section labels */}
            {rail ? (
              <div aria-hidden="true" className="flex justify-center pb-1.5">
                <div
                  className="w-7 h-px rounded-full"
                  style={{ background: "linear-gradient(90deg, transparent, rgba(155,91,255,0.4), transparent)" }}
                />
              </div>
            ) : (
              <div
                aria-hidden="true"
                className="px-2 pt-0.5 pb-1.5 text-[9px] font-mono font-semibold uppercase tracking-[0.22em] text-white/25 select-none"
              >
                {group.label}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item, ii) => {
                const i = starts[gi] + ii;
                const isActive = location === item.href;
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={item.href} aria-label={rail ? item.label : undefined}>
                    <div
                      ref={(el) => { if (el) navItemsRef.current[i] = el; }}
                      onMouseEnter={(e) => {
                        handleNavHover(e.currentTarget, true);
                        if (rail) showRailTip(item.label, e.currentTarget);
                      }}
                      onMouseLeave={(e) => {
                        handleNavHover(e.currentTarget, false);
                        hideRailTip();
                      }}
                      onFocus={(e) => { if (rail) showRailTip(item.label, e.currentTarget); }}
                      onBlur={hideRailTip}
                      onClick={() => { hideRailTip(); onNavigate?.(); }}
                      className={`nav-item flex items-center rounded-lg cursor-pointer text-sm transition-colors ${
                        isActive
                          ? "active gx-nav-pill text-purple-200 font-medium"
                          : "gx-nav-hover text-white/40 hover:text-white/80"
                      } ${
                        rail
                          ? "relative w-11 h-11 mx-auto justify-center"
                          : "gap-3 px-3 py-2.5"
                      }`}
                    >
                      <div className={`relative flex items-center justify-center w-6 h-6 rounded-md shrink-0 transition-colors ${
                        isActive ? "gx-accent-grad bg-purple-500/25" : ""
                      }`}>
                        {isActive && <div className="absolute inset-0 rounded-md bg-purple-500/30 blur-sm" />}
                        <Icon size={15} className={`relative z-10 ${isActive ? "text-white" : "text-white/40"}`} />
                      </div>

                      {rail ? (
                        <>
                          {item.badge === "fraud" && <FraudNavBadge compact />}
                          {isActive && (
                            <span
                              className="absolute bottom-1 right-1 w-1 h-1 rounded-full bg-purple-400"
                              style={{ boxShadow: "0 0 5px #a855f7" }}
                            />
                          )}
                        </>
                      ) : (
                        <>
                          <AnimatePresence initial={false} mode="popLayout">
                            <motion.span key="label" {...railLabelMotion} className="truncate">
                              {item.label}
                            </motion.span>
                          </AnimatePresence>
                          {(item.badge === "fraud" || isActive) && (
                            <div className="ml-auto flex items-center gap-1.5">
                              {item.badge === "fraud" && <FraudNavBadge />}
                              {isActive && (
                                <div className="w-1 h-1 rounded-full bg-purple-400" style={{ boxShadow: "0 0 4px #a855f7" }} />
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    );
  };

  return (
    /* App shell: the viewport NEVER scrolls — the sidebar is locked in place
       and <main> below is the only vertical scroller. */
    <div className={`h-screen supports-[height:100dvh]:h-[100dvh] w-full overflow-hidden flex isolate bg-background ${pageTheme}`}>
      {/* ── App-wide aurora backdrop (pure presentation, behind content) ── */}
      <div
        aria-hidden="true"
        className="gx-aurora-page pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      />
      <GlobalToastBridge />

      {/* ── Collapsed-rail tooltips — viewport-fixed, outside every clipping context ── */}
      <AnimatePresence initial={false}>
        {railTip && (
          <motion.div
            key={railTip.label}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="fixed z-[70] pointer-events-none whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur-md"
            style={{
              left: RAIL_WIDTH + 10,
              top: railTip.top,
              y: "-50%",
              background: "linear-gradient(135deg, rgba(18,9,32,0.94), rgba(10,5,18,0.94))",
              border: "1px solid rgba(var(--gx-accent-from), 0.38)",
              boxShadow: "0 0 18px rgba(var(--gx-accent-from), 0.22), 0 8px 24px rgba(0,0,0,0.45)",
            }}
          >
            {railTip.label}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Desktop Sidebar — permanently locked relative to the viewport ── */}
      <aside
        ref={sidebarRef}
        className={`gx-sidebar-rail hidden h-full shrink-0 md:flex flex-col overflow-hidden relative backdrop-blur-xl border-r gx-accent-border ${
          collapsed ? "w-[76px]" : "w-60"
        }`}
        style={{ background: "linear-gradient(180deg, rgba(13,5,21,0.84) 0%, rgba(8,5,16,0.92) 100%)" }}
      >
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-500/40 to-transparent" />

        {/* Brand block — collapses to the bare emblem + rail toggle */}
        <div className="border-b border-white/5">
          <div
            ref={logoRef}
            className={`flex items-center transition-[padding,gap] duration-300 ${
              collapsed ? "flex-col gap-2 px-0 py-3" : "gap-3 px-5 py-3.5"
            }`}
          >
            <div className="relative shrink-0">
              <div className="absolute inset-0 rounded-xl bg-purple-600/30 blur-md" />
              <img
                ref={logoImgRef}
                src="/attendx-emblem.png"
                alt="AttendX emblem"
                className="relative w-9 h-9 rounded-xl object-cover"
                style={{ filter: "drop-shadow(0 0 8px rgba(155,91,255,0.7))" }}
              />
            </div>
            <AnimatePresence initial={false} mode="popLayout">
              {!collapsed && (
                <motion.div key="brand-title" {...railLabelMotion} className="min-w-0">
                  <h1
                    className="text-base font-black text-white leading-none tracking-wider"
                    style={{ fontFamily: "'Orbitron', monospace" }}
                  >
                    ATTEND<span className="text-gradient">X</span>
                  </h1>
                  <p className="text-[9px] text-purple-400/50 tracking-widest mt-0.5">COMMAND CENTER</p>
                </motion.div>
              )}
            </AnimatePresence>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
              className={`h-11 w-11 shrink-0 grid place-items-center rounded-lg text-white/35 hover:text-purple-300 hover:bg-purple-500/10 active:scale-95 transition gx-glow-hover ${
                collapsed ? "" : "ml-auto"
              }`}
              style={{ border: "1px solid rgba(155,91,255,0.14)" }}
            >
              {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>
        </div>

        <NavLinks collapsed={collapsed} />

        {/* Quick jump — icon-only in rail mode */}
        <div className={collapsed ? "px-3 pb-3" : "px-3 pb-2"}>
          <button
            onClick={() => openCommandPalette()}
            onMouseEnter={(e) => { if (collapsed) showRailTip("Quick jump…", e.currentTarget); }}
            onMouseLeave={hideRailTip}
            className={`gx-glow-hover flex items-center rounded-lg text-xs text-white/35 hover:text-purple-300 hover:bg-purple-500/8 transition-colors ${
              collapsed ? "h-11 w-11 mx-auto justify-center" : "w-full gap-2 px-3 py-2"
            }`}
            style={{ border: "1px dashed rgba(155,91,255,0.18)" }}
          >
            <Search size={13} className="shrink-0" />
            <AnimatePresence initial={false} mode="popLayout">
              {!collapsed && (
                <motion.span key="quickjump" {...railLabelMotion} className="flex-1 min-w-0 flex items-center gap-2">
                  Quick jump…
                  <kbd className="ml-auto flex items-center gap-0.5 text-[9px] font-mono bg-white/5 px-1.5 py-0.5 rounded">
                    <Command size={9} />K
                  </kbd>
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </div>

        {/* Footer — stacks to avatar + logout in rail mode */}
        <div className={`border-t border-white/5 mt-auto transition-[padding] duration-300 ${collapsed ? "px-2 py-3" : "p-4"}`}>
          {collapsed ? (
            <div className="flex flex-col items-center gap-2.5">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border shrink-0"
                style={{
                  background: "linear-gradient(135deg, #7C3AED, #9B5BFF)",
                  borderColor: "rgba(155,91,255,0.3)",
                  boxShadow: "0 0 10px rgba(124,58,237,0.4)"
                }}
              >
                {admin?.name?.charAt(0) || "A"}
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={logout}
                aria-label="Log out"
                title="Log out"
                className="text-white/30 hover:text-red-400 hover:bg-red-500/10 h-8 w-8"
              >
                <LogOut size={14} />
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2.5 overflow-hidden">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border shrink-0"
                    style={{
                      background: "linear-gradient(135deg, #7C3AED, #9B5BFF)",
                      borderColor: "rgba(155,91,255,0.3)",
                      boxShadow: "0 0 10px rgba(124,58,237,0.4)"
                    }}
                  >
                    {admin?.name?.charAt(0) || "A"}
                  </div>
                  <div className="overflow-hidden">
                    <p className="text-xs font-semibold truncate text-white/80">{admin?.name}</p>
                    <p className="text-[10px] text-white/30 truncate">{admin?.email}</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={logout}
                  className="text-white/30 hover:text-red-400 hover:bg-red-500/10 shrink-0 h-7 w-7"
                >
                  <LogOut size={13} />
                </Button>
              </div>
              <div className="flex items-center justify-between">
                <RoleBadge role={admin?.role} />
                <div className="text-[9px] text-white/15 tracking-widest">BY JOSEPH JAMES</div>
              </div>
            </>
          )}
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-500/20 to-transparent" />
      </aside>

      {/* ── Mobile Overlay ─────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/80 md:hidden backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
      )}

      {/* ── Mobile Drawer ──────────────────────────────── */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 flex flex-col md:hidden transition-transform duration-300 border-r gx-accent-border backdrop-blur-xl ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ background: "linear-gradient(180deg, rgba(13,5,21,0.90) 0%, rgba(8,5,16,0.95) 100%)" }}
      >
        <div className="p-4 flex items-center justify-between border-b border-white/5">
          <div className="flex items-center gap-2">
            <img src="/attendx-emblem.png" alt="AttendX emblem" className="w-7 h-7 rounded-lg object-cover" style={{ filter: "drop-shadow(0 0 6px rgba(155,91,255,0.6))" }} />
            <h1 className="font-black text-white tracking-wider text-sm" style={{ fontFamily: "'Orbitron', monospace" }}>
              ATTEND<span className="text-gradient">X</span>
            </h1>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} className="text-white/40 h-7 w-7">
            <X size={16} />
          </Button>
        </div>
        <NavLinks onNavigate={() => setMobileOpen(false)} />
        <div className="p-4 border-t border-white/5">
          <div className="flex items-center gap-2.5 mb-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0" style={{ background: "linear-gradient(135deg, #7C3AED, #9B5BFF)" }}>
              {admin?.name?.charAt(0) || "A"}
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="text-xs font-semibold truncate text-white/80">{admin?.name}</p>
              <RoleBadge role={admin?.role} />
            </div>
            <Button variant="ghost" size="icon" onClick={logout} className="text-white/30 hover:text-red-400 h-7 w-7">
              <LogOut size={13} />
            </Button>
          </div>
        </div>
      </aside>

      {/* ── Main column — owns the ONLY vertical scroll in the app ── */}
      <main className="min-w-0 flex-1 flex flex-col overflow-hidden">
        {/* Desktop topbar (static header — it no longer scrolls, no sticky needed) */}
        <header className="gx-topbar-line hidden md:flex h-12 items-center px-5 justify-between shrink-0 z-30 border-b border-white/5"
          style={{ background: "rgba(8,5,16,0.68)", backdropFilter: "blur(14px)" }}>
          <button
            onClick={() => openCommandPalette()}
            className="gx-glow-hover flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-white/30 hover:text-white/60 hover:bg-purple-500/8 transition-colors w-72"
            style={{ border: "1px solid rgba(155,91,255,0.12)", background: "rgba(20,8,40,0.5)" }}
          >
            <Search size={13} />
            Search students, actions, pages…
            <kbd className="ml-auto flex items-center gap-0.5 text-[9px] font-mono bg-white/5 px-1.5 py-0.5 rounded">
              <Command size={9} />K
            </kbd>
          </button>
          <div className="flex items-center gap-3">
            <NetDot />
            <InstallAppButton />
            <LiveBadge />
            <NotificationCenter />
          </div>
        </header>

        {/* Mobile header */}
        <header
          className="gx-topbar-line md:hidden h-14 flex items-center px-4 justify-between shrink-0 z-30 border-b border-white/5"
          style={{ background: "rgba(8,5,16,0.80)", backdropFilter: "blur(14px)" }}
        >
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} className="text-white/50 -ml-2 h-8 w-8">
              <Menu size={18} />
            </Button>
            <img src="/attendx-emblem.png" alt="AttendX emblem" className="w-6 h-6 rounded-md object-cover" style={{ filter: "drop-shadow(0 0 4px rgba(155,91,255,0.6))" }} />
            <span className="font-black text-sm text-white tracking-wider" style={{ fontFamily: "'Orbitron', monospace" }}>
              ATTEND<span className="text-gradient">X</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <NetDot />
            <InstallAppButton />
            <LiveBadge />
            <NotificationCenter />
          </div>
        </header>

        {/* The one true scroll container (aurora backdrop is a fixed sibling → unaffected) */}
        <div ref={pageRef} className="flex-1 overflow-y-auto overscroll-contain p-4 md:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
