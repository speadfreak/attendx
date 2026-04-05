import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { 
  LayoutDashboard, 
  Users, 
  UserCheck, 
  School, 
  FileText, 
  MessageSquare,
  LogOut,
  ShieldAlert,
  UserCog,
  Menu,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";

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

  return (
    <div className="min-h-screen bg-background flex">
      {/* Desktop Sidebar */}
      <aside className="w-60 bg-card border-r border-border flex-col hidden md:flex shrink-0">
        <div className="p-5 flex items-center gap-3 border-b border-border/50">
          <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center border border-primary/50 text-primary">
            <ShieldAlert size={18} />
          </div>
          <h1 className="text-xl font-bold text-foreground tracking-tight">FaceTrack</h1>
        </div>

        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href;
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer text-sm ${
                    isActive
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                  }`}
                >
                  <Icon size={16} className={isActive ? "text-primary" : "text-muted-foreground"} />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-border/50 mt-auto">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-sm font-medium border border-border shrink-0">
                {admin?.name?.charAt(0) || "A"}
              </div>
              <div className="overflow-hidden">
                <p className="text-sm font-medium truncate text-foreground">{admin?.name}</p>
                <p className="text-xs text-muted-foreground truncate">{admin?.email}</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={logout}
              className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
            >
              <LogOut size={15} />
            </Button>
          </div>
          <div className="text-[10px] text-center text-muted-foreground/50 pt-2 border-t border-border/30">
            Developed by Joseph James
          </div>
        </div>
      </aside>

      {/* Mobile Sidebar Overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile Drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border flex flex-col md:hidden transition-transform duration-300 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-4 flex items-center justify-between border-b border-border/50">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center border border-primary/50 text-primary">
              <ShieldAlert size={15} />
            </div>
            <h1 className="text-lg font-bold text-foreground tracking-tight">FaceTrack</h1>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)}>
            <X size={18} />
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
                  className={`flex items-center gap-3 px-3 py-3 rounded-lg transition-colors cursor-pointer text-sm ${
                    isActive
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                  }`}
                >
                  <Icon size={17} className={isActive ? "text-primary" : "text-muted-foreground"} />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-border/50">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-sm font-medium border border-border shrink-0">
              {admin?.name?.charAt(0) || "A"}
            </div>
            <div className="overflow-hidden flex-1">
              <p className="text-sm font-medium truncate text-foreground">{admin?.name}</p>
              <p className="text-xs text-muted-foreground truncate">{admin?.email}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={logout}
              className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
            >
              <LogOut size={15} />
            </Button>
          </div>
          <div className="text-[10px] text-center text-muted-foreground/50 pt-2 border-t border-border/30">
            Developed by Joseph James
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-h-screen overflow-hidden">
        {/* Mobile Header */}
        <header className="md:hidden h-14 bg-card border-b border-border flex items-center px-4 justify-between shrink-0 sticky top-0 z-30">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} className="-ml-2">
              <Menu size={20} />
            </Button>
            <ShieldAlert size={16} className="text-primary" />
            <h1 className="font-bold text-sm">FaceTrack</h1>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-xs font-medium border border-border">
              {admin?.name?.charAt(0) || "A"}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-auto p-4 md:p-6 pb-6">
          {children}
        </div>
      </main>
    </div>
  );
}
