import { ReactNode, useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import {
  LayoutDashboard, Users, UserCheck, School,
  FileText, MessageSquare, LogOut, UserCog, Menu, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import gsap from "gsap";

const NAV_ITEMS = [
  { href: "/dashboard",  label: "Dashboard",  icon: LayoutDashboard },
  { href: "/attendance", label: "Attendance",  icon: UserCheck },
  { href: "/students",   label: "Students",   icon: Users },
  { href: "/classrooms", label: "Classrooms", icon: School },
  { href: "/reports",    label: "Reports",    icon: FileText },
  { href: "/sms-logs",   label: "SMS Logs",   icon: MessageSquare },
  { href: "/admins",     label: "Admins",     icon: UserCog },
];

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { admin, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const sidebarRef = useRef<HTMLElement>(null);
  const navItemsRef = useRef<HTMLDivElement[]>([]);
  const logoRef = useRef<HTMLDivElement>(null);
  const logoImgRef = useRef<HTMLImageElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

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
        stagger: 0.05, delay: 0.25,
      });

      // Logo pulse
      gsap.to(logoImgRef.current, {
        filter: "drop-shadow(0 0 12px rgba(155,91,255,0.9)) drop-shadow(0 0 4px rgba(155,91,255,1))",
        duration: 2, yoyo: true, repeat: -1, ease: "sine.inOut",
      });
    }, sidebarRef);
    return () => ctx.revert();
  }, []);

  // Page transition on location change
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

  return (
    <div className="min-h-screen bg-background flex">
      {/* ── Desktop Sidebar ─────────────────────────────── */}
      <aside
        ref={sidebarRef}
        className="w-60 border-r border-white/5 flex-col hidden md:flex shrink-0 relative"
        style={{ background: "linear-gradient(180deg, #0d0515 0%, #080510 100%)" }}
      >
        {/* Top accent line */}
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-purple-500/40 to-transparent" />

        {/* Logo */}
        <div
          ref={logoRef}
          className="p-5 flex items-center gap-3 border-b border-white/5"
        >
          <div className="relative">
            <div className="absolute inset-0 rounded-xl bg-purple-600/30 blur-md" />
            <img
              ref={logoImgRef}
              src="/logo.jpg"
              alt="FaceTrack"
              className="relative w-9 h-9 rounded-xl object-cover"
              style={{ filter: "drop-shadow(0 0 8px rgba(155,91,255,0.7))" }}
            />
          </div>
          <div>
            <h1
              className="text-base font-black text-white leading-none tracking-wider"
              style={{ fontFamily: "'Orbitron', monospace" }}
            >
              ATTEND<span className="text-purple-400">X ⚡</span>
            </h1>
            <p className="text-[9px] text-purple-400/50 tracking-widest mt-0.5">COMMAND CENTER</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map((item, i) => {
            const isActive = location === item.href;
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href}>
                <div
                  ref={(el) => { if (el) navItemsRef.current[i] = el; }}
                  onMouseEnter={(e) => handleNavHover(e.currentTarget, true)}
                  onMouseLeave={(e) => handleNavHover(e.currentTarget, false)}
                  className={`nav-item flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm transition-colors ${
                    isActive
                      ? "active bg-purple-600/15 text-purple-300 font-medium"
                      : "text-white/40 hover:bg-purple-500/8 hover:text-white/80"
                  }`}
                >
                  <div className={`relative flex items-center justify-center w-6 h-6 rounded-md ${
                    isActive ? "bg-purple-600/30" : ""
                  }`}>
                    {isActive && (
                      <div className="absolute inset-0 rounded-md bg-purple-500/20 blur-sm" />
                    )}
                    <Icon
                      size={15}
                      className={`relative z-10 ${isActive ? "text-purple-400" : "text-white/40"}`}
                    />
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

        {/* User footer */}
        <div className="p-4 border-t border-white/5 mt-auto">
          <div className="flex items-center justify-between mb-3">
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
          <div className="text-[9px] text-center text-white/15 pt-2 border-t border-white/5 tracking-widest">
            BY JOSEPH JAMES · ADDIS ABABA
          </div>
        </div>

        {/* Bottom glow */}
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
              ATTEND<span className="text-purple-400">X ⚡</span>
            </h1>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} className="text-white/40 h-7 w-7">
            <X size={16} />
          </Button>
        </div>
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href;
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href}>
                <div
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-3 py-3 rounded-lg cursor-pointer text-sm ${
                    isActive ? "bg-purple-600/15 text-purple-300 font-medium" : "text-white/40 hover:text-white/70"
                  }`}
                >
                  <Icon size={16} className={isActive ? "text-purple-400" : ""} />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-white/5">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0" style={{ background: "linear-gradient(135deg, #7C3AED, #9B5BFF)" }}>
              {admin?.name?.charAt(0) || "A"}
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="text-xs font-semibold truncate text-white/80">{admin?.name}</p>
              <p className="text-[10px] text-white/30 truncate">{admin?.email}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={logout} className="text-white/30 hover:text-red-400 h-7 w-7">
              <LogOut size={13} />
            </Button>
          </div>
        </div>
      </aside>

      {/* ── Main ──────────────────────────────────────── */}
      <main ref={mainRef} className="flex-1 flex flex-col min-h-screen overflow-hidden">
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
              ATTEND<span className="text-purple-400">X ⚡</span>
            </span>
          </div>
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: "linear-gradient(135deg, #7C3AED, #9B5BFF)" }}>
            {admin?.name?.charAt(0) || "A"}
          </div>
        </header>

        <div ref={pageRef} className="flex-1 overflow-auto p-4 md:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
