import { ReactNode, useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useLiveEvents, type LiveStatus } from "@/hooks/useLiveEvents";
import { NotificationCenter } from "@/components/NotificationCenter";
import { openCommandPalette } from "@/components/CommandPalette";
import {
  LayoutDashboard, Users, UserCheck, School,
  FileText, MessageSquare, LogOut, UserCog, Menu, X, ServerCog,
  QrCode, DoorOpen, ScrollText, ShieldAlert, Search, Command, ScanFace,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import gsap from "gsap";

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  roles?: Array<"super_admin" | "admin" | "teacher">;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard",    label: "Dashboard",        icon: LayoutDashboard },
  { href: "/attendance",   label: "Active Scan",      icon: ScanFace },
  { href: "/qr-terminal",  label: "QR Terminal",      icon: DoorOpen },
  { href: "/students",     label: "Students",         icon: Users },
  { href: "/classrooms",   label: "Classrooms",       icon: School },
  { href: "/review-queue", label: "Review Queue",     icon: ShieldAlert },
  { href: "/reports",      label: "Reports",          icon: FileText },
  { href: "/qr-manager",   label: "QR Badges",        icon: QrCode },
  { href: "/sms-logs",     label: "SMS Logs",         icon: MessageSquare },
  { href: "/audit",        label: "Audit Trail",      icon: ScrollText, roles: ["super_admin", "admin"] },
  { href: "/sms-templates", label: "SMS Templates",   icon: MessageSquare, roles: ["super_admin", "admin"] },
  { href: "/admins",       label: "Admins",           icon: UserCog, roles: ["super_admin", "admin"] },
  { href: "/operations",   label: "Operations",       icon: ServerCog, roles: ["super_admin", "admin"] },
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

  const sidebarRef = useRef<HTMLElement>(null);
  const navItemsRef = useRef<HTMLDivElement[]>([]);
  const logoRef = useRef<HTMLDivElement>(null);
  const logoImgRef = useRef<HTMLImageElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const isTeacher = admin?.role === "teacher";
  const visibleNav = NAV_ITEMS.filter((item) => !item.roles || !isTeacher || item.roles.includes("teacher"));

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

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
      {visibleNav.map((item, i) => {
        const isActive = location === item.href;
        const Icon = item.icon;
        return (
          <Link key={item.href} href={item.href}>
            <div
              ref={(el) => { if (el) navItemsRef.current[i] = el; }}
              onMouseEnter={(e) => handleNavHover(e.currentTarget, true)}
              onMouseLeave={(e) => handleNavHover(e.currentTarget, false)}
              onClick={onNavigate}
              className={`nav-item flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm transition-colors ${
                isActive
                  ? "active bg-purple-600/15 text-purple-300 font-medium"
                  : "text-white/40 hover:bg-purple-500/8 hover:text-white/80"
              }`}
            >
              <div className={`relative flex items-center justify-center w-6 h-6 rounded-md ${
                isActive ? "bg-purple-600/30" : ""
              }`}>
                {isActive && <div className="absolute inset-0 rounded-md bg-purple-500/20 blur-sm" />}
                <Icon size={15} className={`relative z-10 ${isActive ? "text-purple-400" : "text-white/40"}`} />
              </div>
              {item.label}
              {isActive && (
                <div className="ml-auto w-1 h-1 rounded-full bg-purple-400" style={{ boxShadow: "0 0 4px #a855f7" }} />
              )}
            </div>
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-background flex">
      <GlobalToastBridge />

      {/* ── Desktop Sidebar ─────────────────────────────── */}
      <aside
        ref={sidebarRef}
        className="w-60 border-r border-white/5 flex-col hidden md:flex shrink-0 relative"
        style={{ background: "linear-gradient(180deg, #0d0515 0%, #080510 100%)" }}
      >
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-500/40 to-transparent" />

        <div ref={logoRef} className="p-5 flex items-center gap-3 border-b border-white/5">
          <div className="relative">
            <div className="absolute inset-0 rounded-xl bg-purple-600/30 blur-md" />
            <img
              ref={logoImgRef}
              src="/logo.jpg"
              alt="AttendX"
              className="relative w-9 h-9 rounded-xl object-cover"
              style={{ filter: "drop-shadow(0 0 8px rgba(155,91,255,0.7))" }}
            />
          </div>
          <div>
            <h1
              className="text-base font-black text-white leading-none tracking-wider"
              style={{ fontFamily: "'Orbitron', monospace" }}
            >
              ATTEND<span className="text-purple-400">X</span>
            </h1>
            <p className="text-[9px] text-purple-400/50 tracking-widest mt-0.5">COMMAND CENTER</p>
          </div>
        </div>

        <NavLinks />

        <div className="px-3 pb-2">
          <button
            onClick={() => openCommandPalette()}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-white/35 hover:text-purple-300 hover:bg-purple-500/8 transition-colors"
            style={{ border: "1px dashed rgba(155,91,255,0.18)" }}
          >
            <Search size={13} />
            Quick jump…
            <kbd className="ml-auto flex items-center gap-0.5 text-[9px] font-mono bg-white/5 px-1.5 py-0.5 rounded">
              <Command size={9} />K
            </kbd>
          </button>
        </div>

        <div className="p-4 border-t border-white/5 mt-auto">
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
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-500/20 to-transparent" />
      </aside>

      {/* ── Mobile Overlay ─────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/80 md:hidden backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
      )}

      {/* ── Mobile Drawer ──────────────────────────────── */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 flex flex-col md:hidden transition-transform duration-300 border-r border-white/5 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ background: "linear-gradient(180deg, #0d0515 0%, #080510 100%)" }}
      >
        <div className="p-4 flex items-center justify-between border-b border-white/5">
          <div className="flex items-center gap-2">
            <img src="/logo.jpg" alt="AttendX" className="w-7 h-7 rounded-lg object-cover" style={{ filter: "drop-shadow(0 0 6px rgba(155,91,255,0.6))" }} />
            <h1 className="font-black text-white tracking-wider text-sm" style={{ fontFamily: "'Orbitron', monospace" }}>
              ATTEND<span className="text-purple-400">X</span>
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

      {/* ── Main ──────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-h-screen overflow-hidden">
        {/* Desktop topbar */}
        <header className="hidden md:flex h-12 items-center px-5 justify-between shrink-0 border-b border-white/5 sticky top-0 z-30"
          style={{ background: "rgba(8,5,16,0.85)", backdropFilter: "blur(12px)" }}>
          <button
            onClick={() => openCommandPalette()}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-white/30 hover:text-white/60 hover:bg-purple-500/8 transition-colors w-72"
            style={{ border: "1px solid rgba(155,91,255,0.12)", background: "rgba(20,8,40,0.5)" }}
          >
            <Search size={13} />
            Search students, actions, pages…
            <kbd className="ml-auto flex items-center gap-0.5 text-[9px] font-mono bg-white/5 px-1.5 py-0.5 rounded">
              <Command size={9} />K
            </kbd>
          </button>
          <div className="flex items-center gap-3">
            <LiveBadge />
            <NotificationCenter />
          </div>
        </header>

        {/* Mobile header */}
        <header
          className="md:hidden h-14 flex items-center px-4 justify-between shrink-0 sticky top-0 z-30 border-b border-white/5"
          style={{ background: "rgba(8,5,16,0.95)", backdropFilter: "blur(12px)" }}
        >
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} className="text-white/50 -ml-2 h-8 w-8">
              <Menu size={18} />
            </Button>
            <img src="/logo.jpg" alt="AttendX" className="w-6 h-6 rounded-md object-cover" style={{ filter: "drop-shadow(0 0 4px rgba(155,91,255,0.6))" }} />
            <span className="font-black text-sm text-white tracking-wider" style={{ fontFamily: "'Orbitron', monospace" }}>
              ATTEND<span className="text-purple-400">X</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <LiveBadge />
            <NotificationCenter />
          </div>
        </header>

        <div ref={pageRef} className="flex-1 overflow-auto p-4 md:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
