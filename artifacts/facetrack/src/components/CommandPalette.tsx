import { useEffect, useMemo, useState, type ElementType } from "react";
import { useLocation } from "wouter";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { api, type SearchResults } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard, Users, School, FileText, QrCode, ScanFace, Scan,
  UserCheck, MessageSquare, UserCog, ServerCog, ScrollText, Bell,
  Sparkles, LogOut, Clock, CheckCircle2, XCircle, DoorOpen, ShieldAlert,
  MapPin,
} from "lucide-react";

/**
 * Command palette (Cmd+K / Ctrl+K): fuzzy-jump to any student, classroom,
 * page or action. Marking a student present, opening the gate camera,
 * running the absent sweep — all one keystroke away.
 */

let paletteOpenGlobal = false;
const openListeners = new Set<() => void>();

/** Global opener callable from anywhere (e.g. top bar button). */
export function openCommandPalette() {
  paletteOpenGlobal = !paletteOpenGlobal;
  openListeners.forEach((fn) => fn());
}

interface PaletteStudent { id: number; name: string; studentId: string; classroomName: string | null }

const BASE = import.meta.env.BASE_URL ?? "/";

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = target.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 100;
  if (t.includes(q)) return 80 - t.indexOf(q) * 0.5;
  // subsequence match
  let qi = 0;
  let score = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++;
      score += 2;
    }
  }
  return qi === q.length ? score : 0;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();
  const { admin, logout } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchResults>({ students: [], classrooms: [] });
  const [allStudents, setAllStudents] = useState<PaletteStudent[]>([]);
  const isTeacher = admin?.role === "teacher";

  useEffect(() => {
    const sync = () => setOpen(paletteOpenGlobal);
    openListeners.add(sync);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        openCommandPalette();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      openListeners.delete(sync);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    // cache student list for offline fuzzy search
    const token = localStorage.getItem("ft_token");
    fetch(`${BASE}api/students`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setAllStudents(rows))
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setResults({ students: [], classrooms: [] });
      return;
    }
    const t = setTimeout(() => {
      api.search(search.trim()).then(setResults).catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [search]);

  const run = (fn: () => void) => {
    setOpen(false);
    paletteOpenGlobal = false;
    fn();
  };

  const markPresent = async (student: PaletteStudent, status: "present" | "late" | "absent") => {
    run(async () => {
      const res = await fetch(`${BASE}api/attendance`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("ft_token")}` },
        body: JSON.stringify({ studentId: student.id, status, method: "manual" }),
      });
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: ["attendance"] });
        await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        toast(`${student.name} marked ${status}`);
      } else {
        const body = await res.json().catch(() => ({}));
        toast(body.error || "Failed to mark attendance", true);
      }
    });
  };

  function toast(message: string, error = false) {
    const ev = new CustomEvent("gx-toast", { detail: { message, error } });
    window.dispatchEvent(ev);
  }

  const students = useMemo(() => {
    const pool = search.length >= 2 && results.students.length ? results.students : allStudents;
    if (!search.trim()) return pool.slice(0, 6) as PaletteStudent[];
    return (pool as PaletteStudent[])
      .map((s) => ({ s, score: Math.max(fuzzyScore(search, s.name), fuzzyScore(search, s.studentId)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.s);
  }, [search, results.students, allStudents]);

  const actions = useMemo(() => {
    const q = search.toLowerCase();
    const list: Array<{ id: string; label: string; icon: ElementType; keywords?: string; run: () => void }> = [];
    const pages = [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/attendance", label: "Active Scan · Face Attendance", icon: ScanFace },
      { href: "/qr-terminal", label: "QR Door Terminal", icon: DoorOpen },
      { href: "/qr-manager", label: "QR Badge Manager", icon: QrCode },
      { href: "/students", label: "Student Database", icon: Users },
      { href: "/classrooms", label: "Classrooms & Seating", icon: School },
      { href: "/reports", label: "Reports & Analytics", icon: FileText },
      { href: "/sms-logs", label: "SMS Logs", icon: MessageSquare },
      { href: "/review-queue", label: "Review Queue", icon: ShieldAlert },
      { href: "/fraud", label: "Fraud Radar · Proxy Signals", icon: ShieldAlert },
    ];
    if (!isTeacher) {
      pages.push(
        { href: "/admins", label: "Admins & Roles", icon: UserCog },
        { href: "/operations", label: "Operations · Pi Control", icon: ServerCog },
        { href: "/gates", label: "Gates & Geofence", icon: MapPin },
        { href: "/audit", label: "Audit Trail", icon: ScrollText },
        { href: "/sms-templates", label: "SMS Templates", icon: MessageSquare },
      );
    }
    for (const p of pages) {
      if (fuzzyScore(q, p.label) > 0) list.push({ id: p.href, label: p.label, icon: p.icon, run: () => run(() => setLocation(p.href)) });
    }
    return list;
  }, [search, isTeacher, setLocation]);

  return (
    <CommandDialog open={open} onOpenChange={(o) => { setOpen(o); paletteOpenGlobal = o; }}>
      <CommandInput placeholder='Type a command or search… e.g. "mark Abebe present"' value={search} onValueChange={setSearch} />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {students.length > 0 && (
          <CommandGroup heading="Students">
            {students.map((s) => (
              <Group key={s.id} student={s} onMark={markPresent} onOpen={() => run(() => setLocation(`/students?focus=${s.id}`))} />
            ))}
          </CommandGroup>
        )}

        {results.classrooms.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Classrooms">
              {results.classrooms.map((c) => (
                <CommandItem key={c.id} onSelect={() => run(() => setLocation(`/classrooms?focus=${c.id}`))}>
                  <School className="mr-2 h-4 w-4 text-purple-400" />
                  <span>{c.name}</span>
                  {c.teacherName && <span className="ml-auto text-xs text-white/30">{c.teacherName}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading={search ? "Actions & Pages" : "Go to"}>
          {actions.map((a) => (
            <CommandItem key={a.id} onSelect={a.run}>
              <a.icon className="mr-2 h-4 w-4 text-purple-400" />
              {a.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {students.length > 0 && !isTeacher && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Danger zone">
              <CommandItem
                className="text-red-400"
                onSelect={() =>
                  run(async () => {
                    const res = await fetch(`${BASE}api/attendance/absent-sweep`, {
                      method: "POST",
                      headers: { Authorization: `Bearer ${localStorage.getItem("ft_token")}` },
                    });
                    const body = await res.json().catch(() => ({}));
                    toast(res.ok ? `Absent sweep: ${body.markedAbsent} marked, ${body.smsQueued} SMS queued` : body.error || "Sweep failed", !res.ok);
                  })
                }
              >
                <XCircle className="mr-2 h-4 w-4" />
                Run absent sweep (mark all missing students absent + SMS)
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
      <div className="border-t border-white/5 px-4 py-2 text-[10px] text-white/25 flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 text-purple-400" /> AttendX Command Center
        </span>
        <span>{admin?.role?.replace("_", " ")}</span>
      </div>
    </CommandDialog>
  );
}

function Group({
  student,
  onMark,
  onOpen,
}: {
  student: PaletteStudent;
  onMark: (s: PaletteStudent, status: "present" | "late" | "absent") => void;
  onOpen: () => void;
}) {
  return (
    <CommandItem onSelect={onOpen}>
      <Users className="mr-2 h-4 w-4 text-purple-400" />
      <span className="flex-1">
        {student.name}
        <span className="ml-2 text-xs text-white/30 font-mono">{student.studentId}</span>
        {student.classroomName && <span className="ml-2 text-xs text-white/20">{student.classroomName}</span>}
      </span>
      <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <button
          className="st-badge st-badge-green hover:bg-emerald-500/20"
          onClick={(e) => { e.stopPropagation(); onMark(student, "present"); }}
        >
          <CheckCircle2 className="h-3 w-3" /> present
        </button>
        <button
          className="st-badge st-badge-amber hover:bg-amber-500/20"
          onClick={(e) => { e.stopPropagation(); onMark(student, "late"); }}
        >
          <Clock className="h-3 w-3" /> late
        </button>
        <button
          className="st-badge st-badge-red hover:bg-red-500/20"
          onClick={(e) => { e.stopPropagation(); onMark(student, "absent"); }}
        >
          <XCircle className="h-3 w-3" /> absent
        </button>
      </span>
    </CommandItem>
  );
}
