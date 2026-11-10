import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListClassrooms,
  useCreateClassroom,
  useUpdateClassroom,
  useDeleteClassroom,
} from "@workspace/api-client-react";
import { api, type SeatRow } from "@/lib/api";
import { GlowCard, SectionTitle, StatusBadge, MeshBackground, GlowEmpty } from "@/components/gx/Primitives";
import { GlowSkeleton } from "@/components/gx/Skeletons";
import { useToast } from "@/hooks/use-toast";
import { School, Plus, Pencil, Trash2, Grid3X3, Users, Save, GripVertical, MapPin, Loader2, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Classrooms + seating map. The drag-and-drop grid lets admins assign seats;
 * the Active Scan review queue cross-references expected seat position as a
 * tie-breaker hint (never auto-applied).
 */

interface Classroom {
  id: number;
  name: string;
  description: string | null;
  teacherName: string | null;
  studentCount: number;
  createdAt: string;
}

interface Student { id: number; name: string; studentId: string; classroomId: number | null; classroomName: string | null }

const ROWS = 5;
const COLS = 6;

function SeatingEditor({ classroom, onClose }: { classroom: Classroom; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [seats, setSeats] = useState<SeatRow[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState<{ type: "student" | "seat"; id: number; seatIdx?: number } | null>(null);
  const [cols, setCols] = useState(COLS);
  const [rows, setRows] = useState(ROWS);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [seatRows, allStudents] = await Promise.all([
          api.seats(classroom.id),
          fetch(`${import.meta.env.BASE_URL ?? "/"}api/students`, {
            headers: { Authorization: `Bearer ${localStorage.getItem("ft_token")}` },
          }).then((r) => r.json()) as Promise<Student[]>,
        ]);
        setSeats(seatRows);
        setStudents(allStudents.filter((s) => s.classroomId === classroom.id));
        const maxCol = Math.max(COLS, ...seatRows.map((s) => s.colIdx + 1));
        const maxRow = Math.max(ROWS, ...seatRows.map((s) => s.rowIdx + 1));
        setCols(Math.min(10, maxCol));
        setRows(Math.min(10, maxRow));
      } catch (e: any) {
        toast({ title: "Failed to load seating", description: e.message, variant: "destructive" });
      } finally {
        setLoading(false);
      }
    })();
  }, [classroom.id, toast]);

  const seatAt = (rowIdx: number, colIdx: number): SeatRow | undefined =>
    seats.find((s) => s.rowIdx === rowIdx && s.colIdx === colIdx);

  const labelFor = (rowIdx: number, colIdx: number) =>
    `${String.fromCharCode(65 + rowIdx)}${colIdx + 1}`;

  const placeSeat = (rowIdx: number, colIdx: number) => {
    // toggle a seat on/off
    const existing = seatAt(rowIdx, colIdx);
    if (existing) {
      setSeats((prev) => prev.filter((s) => s !== existing));
    } else {
      setSeats((prev) => [...prev, {
        id: -Date.now(),
        seatLabel: labelFor(rowIdx, colIdx),
        rowIdx, colIdx,
        studentId: null, studentName: null, studentRef: null,
      }]);
    }
  };

  const assignStudent = (seatIdx: number, studentId: number | null) => {
    setSeats((prev) => {
      const next = [...prev];
      // remove student from any other seat in this classroom
      for (let i = 0; i < next.length; i++) {
        if (i !== seatIdx && next[i].studentId === studentId && studentId !== null) {
          next[i] = { ...next[i], studentId: null, studentName: null };
        }
      }
      const seat = next[seatIdx];
      const student = students.find((s) => s.id === studentId);
      next[seatIdx] = { ...seat, studentId, studentName: student?.name ?? null, studentRef: student?.studentId ?? null };
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSeats(classroom.id, seats.map((s) => ({
        seatLabel: s.seatLabel,
        rowIdx: s.rowIdx,
        colIdx: s.colIdx,
        studentId: s.studentId ?? null,
      })));
      toast({ title: "Seating map saved", description: `${seats.length} seats in ${classroom.name}.` });
      void queryClient.invalidateQueries({ queryKey: ["seats"] });
      onClose();
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const unassigned = students.filter((s) => !seats.some((seat) => seat.studentId === s.id));

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[760px] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Grid3X3 size={16} className="text-purple-400" /> Seating Map — {classroom.name}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8"><GlowSkeleton className="h-64" /></div>
        ) : (
          <div className="space-y-4 pt-2">
            {/* size controls */}
            <div className="flex items-center gap-3 text-xs text-white/50">
              <span>Grid size:</span>
              <select value={rows} onChange={(e) => setRows(Number(e.target.value))} className="bg-black/40 border border-purple-500/15 rounded px-2 py-1 text-white/70">
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} rows</option>)}
              </select>
              <select value={cols} onChange={(e) => setCols(Number(e.target.value))} className="bg-black/40 border border-purple-500/15 rounded px-2 py-1 text-white/70">
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} cols</option>)}
              </select>
              <span className="ml-auto text-white/30">{seats.length} seats · {seats.filter((s) => s.studentId).length} assigned</span>
            </div>

            {/* grid */}
            <div className="rounded-xl border border-white/8 p-3 bg-black/20 overflow-x-auto">
              <div className="inline-grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(72px, 1fr))` }}>
                {Array.from({ length: rows }).flatMap((_, r) =>
                  Array.from({ length: cols }).map((__, c) => {
                    const seat = seatAt(r, c);
                    return (
                      <div key={`${r}-${c}`}>
                        {seat ? (
                          <div
                            draggable
                            onDragStart={() => setDragging({ type: "seat", id: seat.id, seatIdx: seats.indexOf(seat) })}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (dragging?.type === "seat" && dragging.seatIdx != null) {
                                // swap positions
                                const moving = seats[dragging.seatIdx];
                                setSeats((prev) => prev.map((s) =>
                                  s === moving
                                    ? { ...s, rowIdx: r, colIdx: c, seatLabel: labelFor(r, c) }
                                    : s.rowIdx === r && s.colIdx === c && s !== moving
                                      ? { ...s, rowIdx: moving.rowIdx, colIdx: moving.colIdx, seatLabel: labelFor(moving.rowIdx, moving.colIdx) }
                                      : s
                                ));
                              } else if (dragging?.type === "student") {
                                const idx = seats.indexOf(seat);
                                if (idx >= 0) assignStudent(idx, dragging.id);
                              }
                              setDragging(null);
                            }}
                            className={`group relative rounded-lg p-1.5 text-[10px] cursor-grab active:cursor-grabbing transition-colors ${
                              seat.studentId
                                ? "bg-purple-500/15 border border-purple-500/30 hover:bg-purple-500/25"
                                : "bg-white/[0.03] border border-white/10 hover:border-purple-500/30"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-white/30">{seat.seatLabel}</span>
                              <GripVertical size={9} className="text-white/20" />
                            </div>
                            <p className={`truncate ${seat.studentId ? "text-purple-200" : "text-white/25"}`}>
                              {seat.studentName ?? "empty"}
                            </p>
                            {seat.studentId && (
                              <button
                                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-white/40 hover:text-red-400"
                                onClick={() => assignStudent(seats.indexOf(seat), null)}
                                title="Unassign"
                              >
                                <X size={10} />
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            onClick={() => placeSeat(r, c)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (dragging?.type === "student") {
                                setSeats((prev) => [...prev, {
                                  id: -Date.now() - r * 100 - c,
                                  seatLabel: labelFor(r, c),
                                  rowIdx: r, colIdx: c,
                                  studentId: dragging.id,
                                  studentName: students.find((s) => s.id === dragging.id)?.name ?? null,
                                  studentRef: null,
                                }]);
                                setDragging(null);
                              }
                            }}
                            className="h-[52px] w-full rounded-lg border border-dashed border-white/10 text-white/20 hover:border-purple-500/40 hover:text-purple-400 text-[10px] transition-colors"
                          >
                            + seat
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* unassigned students */}
            <div className="rounded-xl border border-white/8 p-3 bg-black/20">
              <p className="text-[10px] uppercase tracking-widest text-white/35 mb-2">Unassigned students — drag onto a seat</p>
              <div className="flex flex-wrap gap-1.5">
                {unassigned.length === 0 ? (
                  <span className="text-[11px] text-white/25 italic">Everyone has a seat.</span>
                ) : (
                  unassigned.map((s) => (
                    <div
                      key={s.id}
                      draggable
                      onDragStart={() => setDragging({ type: "student", id: s.id })}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-[11px] text-purple-200 cursor-grab active:cursor-grabbing"
                    >
                      <Users size={10} /> {s.name}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex justify-between items-center pt-1">
              <p className="text-[10px] text-white/30 flex items-center gap-1">
                <MapPin size={10} className="text-cyan-400" /> Seats feed the review-queue tie-breaker hint.
              </p>
              <div className="flex gap-2">
                <button className="st-badge st-badge-slate px-3 py-1.5" onClick={onClose}>Cancel</button>
                <button
                  className="st-badge st-badge-purple px-4 py-1.5"
                  onClick={save}
                  disabled={saving}
                >
                  {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />} Save map
                </button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function ClassroomsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Classroom | null>(null);
  const [seatingFor, setSeatingFor] = useState<Classroom | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [teacherName, setTeacherName] = useState("");

  const { data: classrooms, isLoading } = useListClassrooms();
  const createClassroom = useCreateClassroom();
  const updateClassroom = useUpdateClassroom();
  const deleteClassroom = useDeleteClassroom();

  const openEdit = (c: Classroom) => {
    setEditing(c);
    setName(c.name);
    setDescription(c.description ?? "");
    setTeacherName(c.teacherName ?? "");
    setShowAdd(true);
  };

  const openAdd = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setTeacherName("");
    setShowAdd(true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = { name, description: description || undefined, teacherName: teacherName || undefined };
    if (editing) {
      updateClassroom.mutate(
        { id: editing.id, data: payload },
        {
          onSuccess: () => { toast({ title: "Classroom updated" }); setShowAdd(false); void queryClient.invalidateQueries(); },
          onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
        },
      );
    } else {
      createClassroom.mutate(
        { data: payload },
        {
          onSuccess: () => { toast({ title: "Classroom created" }); setShowAdd(false); void queryClient.invalidateQueries(); },
          onError: (err: any) => toast({ title: "Create failed", description: err.message, variant: "destructive" }),
        },
      );
    }
  };

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5 max-w-6xl mx-auto">
        <div className="gx-page-header flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <SectionTitle className="gx-title-gradient" sub="ZONES, HOMEROOM TEACHERS & SEATING MAPS">
            CLASSROOMS
          </SectionTitle>
          <button
            onClick={openAdd}
            className="gx-btn-accent gx-gradient-pan flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white"
          >
            <Plus size={14} /> Add Classroom
          </button>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array(4).fill(0).map((_, i) => <GlowSkeleton key={i} className="h-32" />)}
          </div>
        ) : !classrooms?.length ? (
          <GlowCard variant="gradient" className="gx-empty-tint p-6">
            <GlowEmpty icon={<School size={26} />} title="No classrooms yet" hint="Create your first classroom zone to enroll students into it." />
          </GlowCard>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {classrooms.map((c: any) => (
              <GlowCard key={c.id} accent variant="gradient" className="gx-glow-hover p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/25 flex items-center justify-center">
                      <School size={17} className="text-purple-400" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white/85">{c.name}</p>
                      <p className="text-[10px] text-white/30">
                        {c.teacherName ? `Homeroom: ${c.teacherName}` : "No homeroom teacher"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button className="p-1.5 rounded-md text-white/35 hover:text-cyan-300 hover:bg-cyan-500/10" title="Seating map" onClick={() => setSeatingFor(c as Classroom)}>
                      <Grid3X3 size={14} />
                    </button>
                    <button className="p-1.5 rounded-md text-white/35 hover:text-purple-300 hover:bg-purple-500/10" onClick={() => openEdit(c as Classroom)}>
                      <Pencil size={13} />
                    </button>
                    <button
                      className="p-1.5 rounded-md text-white/35 hover:text-red-400 hover:bg-red-500/10"
                      onClick={() => {
                        if (confirm(`Delete ${c.name}?`)) {
                          deleteClassroom.mutate(
                            { id: c.id },
                            {
                              onSuccess: () => toast({ title: "Classroom deleted" }),
                              onError: (err: any) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
                            },
                          );
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {c.description && <p className="text-xs text-white/40 mt-3">{c.description}</p>}
                <div className="flex items-center gap-2 mt-4">
                  <StatusBadge value="operational" label={`${c.studentCount} students`} tone="green" />
                  <StatusBadge value="valid" label="zone monitored" tone="purple" />
                </div>
              </GlowCard>
            ))}
          </div>
        )}

        {/* add/edit dialog */}
        {showAdd && (
          <Dialog open onOpenChange={(open) => { if (!open) setShowAdd(false); }}>
            <DialogContent className="sm:max-w-[420px]">
              <DialogHeader>
                <DialogTitle>{editing ? "Edit Classroom" : "Create Classroom"}</DialogTitle>
              </DialogHeader>
              <form onSubmit={submit} className="space-y-4 pt-2">
                <div className="space-y-2">
                  <Label>Classroom name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Grade 4A" className="bg-black/30 border-purple-500/15 text-white/85" />
                </div>
                <div className="space-y-2">
                  <Label>Homeroom teacher (can issue QR badges)</Label>
                  <Input value={teacherName} onChange={(e) => setTeacherName(e.target.value)} placeholder="e.g. Ms. Hanna" className="bg-black/30 border-purple-500/15 text-white/85" />
                </div>
                <div className="space-y-2">
                  <Label>Description (optional)</Label>
                  <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Main building, second floor" className="bg-black/30 border-purple-500/15 text-white/85" />
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" className="st-badge st-badge-slate px-3 py-1.5" onClick={() => setShowAdd(false)}>Cancel</button>
                  <button
                    type="submit"
                    className="gx-btn-accent gx-gradient-pan rounded-lg px-4 py-1.5 text-xs font-semibold text-white"
                    disabled={createClassroom.isPending || updateClassroom.isPending}
                  >
                    {editing ? "Save changes" : "Create"}
                  </button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )}

        {/* seating editor */}
        {seatingFor && <SeatingEditor classroom={seatingFor} onClose={() => setSeatingFor(null)} />}
      </div>
    </div>
  );
}
