import { useState, useRef, useEffect, useCallback } from "react";
import {
  useListStudents,
  useListClassrooms,
  useCreateStudent,
  useUpdateStudent,
  useDeleteStudent,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import {
  Search, Plus, UserCircle, QrCode, MoreHorizontal, Pencil, Trash2,
  Scan, Camera, Loader2, CheckCircle2, Brain,
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { loadModels, extractDescriptor } from "@/lib/faceApi";

type Student = {
  id: number;
  name: string;
  studentId: string;
  parentPhone: string;
  classroomId?: number | null;
  classroomName?: string | null;
  hasFaceEncoding?: boolean;
};

const BASE = import.meta.env.BASE_URL ?? "/";
function apiFetch(path: string, opts?: RequestInit) {
  const token = localStorage.getItem("ft_token");
  return fetch(`${BASE}api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...opts?.headers },
  });
}

// ─────────────────────────────────────────────────────────────
// Face Capture Dialog — uses face-api.js for real descriptors
// ─────────────────────────────────────────────────────────────
function FaceCaptureDialog({ student, onClose }: { student: Student; onClose: () => void }) {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [capturedDataUrl, setCapturedDataUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [faceFound, setFaceFound] = useState<boolean | null>(null);

  const startCam = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 } } });
      streamRef.current = s;
      if (videoRef.current) videoRef.current.srcObject = s;
    } catch {
      toast({ title: "Camera Error", description: "Cannot access camera.", variant: "destructive" });
    }
  }, [toast]);

  const stopCam = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Start camera + preload models on mount
  useEffect(() => {
    startCam();
    loadModels().catch(() => {});
    return () => stopCam();
  }, [startCam, stopCam]);

  const capture = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 480;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    const dataUrl = c.toDataURL("image/jpeg", 0.92);
    setCapturedDataUrl(dataUrl);
    setCaptured(true);
    stopCam();

    // Verify face detected
    setAiLoading(true);
    try {
      const img = new Image();
      img.src = dataUrl;
      await new Promise((r) => { img.onload = r; });
      const desc = await extractDescriptor(img as any);
      setFaceFound(desc !== null);
      if (!desc) toast({ title: "No face detected", description: "Retake photo with face clearly visible.", variant: "destructive" });
    } catch {
      setFaceFound(null);
    } finally {
      setAiLoading(false);
    }
  };

  const retake = () => {
    setCaptured(false);
    setCapturedDataUrl(null);
    setFaceFound(null);
    startCam();
  };

  const save = async () => {
    if (!capturedDataUrl) return;
    setSaving(true);
    try {
      // Extract real descriptor
      const img = new Image();
      img.src = capturedDataUrl;
      await new Promise((r) => { img.onload = r; });
      const descriptor = await extractDescriptor(img as any);

      const body: Record<string, unknown> = { studentId: student.id, imageBase64: capturedDataUrl };
      if (descriptor) body.faceDescriptor = Array.from(descriptor);

      const res = await apiFetch("/face/encode", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Failed"); }

      toast({ title: "Face enrolled successfully", description: `${student.name}'s face is registered.` });
      onClose();
    } catch (err: any) {
      toast({ title: "Failed to enroll face", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) { stopCam(); onClose(); } }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Enroll Face — {student.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          {/* Camera / Preview */}
          <div className="relative bg-black rounded-xl overflow-hidden" style={{ aspectRatio: "4/3" }}>
            {!captured ? (
              <>
                <video
                  ref={videoRef}
                  autoPlay playsInline muted
                  onCanPlay={() => setCameraReady(true)}
                  className="w-full h-full object-cover"
                  style={{ transform: "scaleX(-1)", display: cameraReady ? "block" : "none" }}
                />
                {!cameraReady && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  </div>
                )}
                {cameraReady && (
                  <>
                    <div className="absolute top-3 left-3 w-7 h-7 border-t-2 border-l-2 border-primary" />
                    <div className="absolute top-3 right-3 w-7 h-7 border-t-2 border-r-2 border-primary" />
                    <div className="absolute bottom-3 left-3 w-7 h-7 border-b-2 border-l-2 border-primary" />
                    <div className="absolute bottom-3 right-3 w-7 h-7 border-b-2 border-r-2 border-primary" />
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="w-32 h-40 rounded-full border-2 border-primary/30" />
                    </div>
                    <p className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[11px] text-white/70 bg-black/60 px-3 py-1 rounded-full whitespace-nowrap">
                      Centre face in oval
                    </p>
                  </>
                )}
              </>
            ) : (
              <>
                {capturedDataUrl && (
                  <img
                    src={capturedDataUrl}
                    alt="captured face"
                    className="w-full h-full object-cover"
                    style={{ transform: "scaleX(-1)" }}
                  />
                )}
                <div className="absolute inset-0 flex items-center justify-center">
                  {aiLoading ? (
                    <div className="bg-black/70 rounded-full p-4">
                      <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    </div>
                  ) : faceFound === true ? (
                    <div className="bg-emerald-500/90 rounded-full p-3">
                      <CheckCircle2 className="w-8 h-8 text-white" />
                    </div>
                  ) : faceFound === false ? (
                    <div className="bg-red-500/90 rounded-full p-3">
                      <UserCircle className="w-8 h-8 text-white" />
                    </div>
                  ) : null}
                </div>
                {faceFound !== null && !aiLoading && (
                  <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[11px] font-medium whitespace-nowrap ${faceFound ? "bg-emerald-500/90 text-white" : "bg-red-500/90 text-white"}`}>
                    {faceFound ? "Face detected — AI descriptor ready" : "No face found — retake photo"}
                  </div>
                )}
              </>
            )}
          </div>
          <canvas ref={canvasRef} className="hidden" />

          {/* AI status hint */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Brain className="w-3.5 h-3.5 text-primary" />
            Face-API AI extracts a unique 128-point face descriptor for accurate recognition.
          </div>

          {/* Buttons */}
          <div className="flex gap-2">
            {!captured ? (
              <Button className="flex-1" onClick={capture} disabled={!cameraReady}>
                <Camera className="w-4 h-4 mr-2" /> Capture Photo
              </Button>
            ) : (
              <>
                <Button variant="outline" className="flex-1" onClick={retake} disabled={saving}>
                  Retake
                </Button>
                <Button
                  className="flex-1"
                  onClick={save}
                  disabled={saving || aiLoading || faceFound === false}
                >
                  {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Scan className="w-4 h-4 mr-2" />}
                  {saving ? "Saving..." : "Save Face Data"}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────
// Add / Edit Student Dialog
// ─────────────────────────────────────────────────────────────
function StudentFormDialog({
  student,
  classrooms,
  onClose,
  onSaved,
}: {
  student?: Student;
  classrooms: { id: number; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const isEdit = !!student;

  const [name, setName] = useState(student?.name ?? "");
  const [studentId, setStudentId] = useState(student?.studentId ?? "");
  const [parentPhone, setParentPhone] = useState(student?.parentPhone ?? "");
  const [classroomId, setClassroomId] = useState(student?.classroomId?.toString() ?? "none");

  const createStudent = useCreateStudent();
  const updateStudent = useUpdateStudent();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      name,
      studentId,
      parentPhone,
      classroomId: classroomId && classroomId !== "none" ? Number(classroomId) : undefined,
    };

    if (isEdit && student) {
      updateStudent.mutate(
        { id: student.id, data: payload },
        {
          onSuccess: () => { toast({ title: "Student updated" }); onSaved(); onClose(); },
          onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
        }
      );
    } else {
      createStudent.mutate(
        { data: payload },
        {
          onSuccess: () => { toast({ title: "Student enrolled" }); onSaved(); onClose(); },
          onError: (err: any) => toast({ title: "Failed to add student", description: err.message, variant: "destructive" }),
        }
      );
    }
  };

  const isPending = createStudent.isPending || updateStudent.isPending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Student" : "Enroll New Student"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Full Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Abebe Girma" />
          </div>
          <div className="space-y-2">
            <Label>Student ID Number</Label>
            <Input value={studentId} onChange={(e) => setStudentId(e.target.value)} required placeholder="e.g. STU-001" />
          </div>
          <div className="space-y-2">
            <Label>Parent / Guardian Phone</Label>
            <Input value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} placeholder="+251..." required />
          </div>
          <div className="space-y-2">
            <Label>Classroom Assignment</Label>
            <Select value={classroomId} onValueChange={setClassroomId}>
              <SelectTrigger><SelectValue placeholder="Select classroom (optional)" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Classroom</SelectItem>
                {classrooms.map((c) => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="pt-2 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {isEdit ? "Save Changes" : "Enroll Student"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────
export default function StudentsPage() {
  const [search, setSearch] = useState("");
  const [classroomFilter, setClassroomFilter] = useState<string>("all");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [faceStudent, setFaceStudent] = useState<Student | null>(null);
  const { toast } = useToast();

  const { data: classrooms = [] } = useListClassrooms();
  const { data: students, isLoading, refetch } = useListStudents({
    search: search || undefined,
    classroomId: classroomFilter === "all" ? undefined : Number(classroomFilter),
  });

  const deleteStudent = useDeleteStudent({
    mutation: {
      onSuccess: () => { refetch(); toast({ title: "Student removed" }); },
      onError: (err: any) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
    },
  });

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      {/* Dialogs */}
      {showAddDialog && (
        <StudentFormDialog
          classrooms={classrooms}
          onClose={() => setShowAddDialog(false)}
          onSaved={() => refetch()}
        />
      )}
      {editingStudent && (
        <StudentFormDialog
          student={editingStudent}
          classrooms={classrooms}
          onClose={() => setEditingStudent(null)}
          onSaved={() => refetch()}
        />
      )}
      {faceStudent && (
        <FaceCaptureDialog
          student={faceStudent}
          onClose={() => { setFaceStudent(null); refetch(); }}
        />
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between gap-4 items-start sm:items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Student Database</h1>
          <p className="text-muted-foreground">Manage enrolled students and face identities</p>
        </div>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setShowAddDialog(true)}>
          <Plus className="w-4 h-4 mr-2" /> Add Student
        </Button>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3 border-b border-border/50">
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search students..."
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="w-full sm:w-[200px]">
              <Select value={classroomFilter} onValueChange={setClassroomFilter}>
                <SelectTrigger><SelectValue placeholder="All Classrooms" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Classrooms</SelectItem>
                  {classrooms.map((c) => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Classroom</TableHead>
                  <TableHead>Parent Contact</TableHead>
                  <TableHead>Identity</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading
                  ? Array(5).fill(0).map((_, i) => (
                    <TableRow key={i}>
                      {Array(6).fill(0).map((_, j) => <TableCell key={j}><Skeleton className="h-5 w-full" /></TableCell>)}
                    </TableRow>
                  ))
                  : !students?.length
                  ? (
                    <TableRow>
                      <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                        No students found.
                      </TableCell>
                    </TableRow>
                  )
                  : students.map((s) => (
                    <TableRow key={s.id} className="hover:bg-muted/20 transition-colors">
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                            {s.name.charAt(0)}
                          </div>
                          <span className="truncate max-w-[130px]">{s.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{s.studentId}</TableCell>
                      <TableCell className="text-sm">{s.classroomName || <span className="text-muted-foreground italic">Unassigned</span>}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{s.parentPhone}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {s.hasFaceEncoding ? (
                            <Badge variant="outline" className="bg-cyan-500/10 text-cyan-400 border-cyan-500/20 text-[10px] gap-1">
                              <Scan className="w-3 h-3" /> AI Enrolled
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 text-[10px] gap-1">
                              <UserCircle className="w-3 h-3" /> No Face
                            </Badge>
                          )}
                          <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-[10px] gap-1">
                            <QrCode className="w-3 h-3" /> QR
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem className="cursor-pointer" onClick={() => setFaceStudent(s)}>
                              <Scan className="w-4 h-4 mr-2 text-cyan-500" />
                              {s.hasFaceEncoding ? "Re-enroll Face" : "Enroll Face"}
                            </DropdownMenuItem>
                            <DropdownMenuItem className="cursor-pointer" onClick={() => setEditingStudent(s)}>
                              <Pencil className="w-4 h-4 mr-2" /> Edit Student
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="cursor-pointer text-destructive focus:text-destructive"
                              onClick={() => {
                                if (confirm(`Delete ${s.name}? This cannot be undone.`)) {
                                  deleteStudent.mutate({ id: s.id });
                                }
                              }}
                            >
                              <Trash2 className="w-4 h-4 mr-2" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
