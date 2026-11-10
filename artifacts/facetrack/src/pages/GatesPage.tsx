import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type GateRecord, type GateUpsertInput } from "@/lib/api";
import { GlowCard, GradientButton, MeshBackground, SectionTitle, GlowEmpty } from "@/components/gx/Primitives";
import { FeedSkeletonRow } from "@/components/gx/Skeletons";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  MapPin,
  MapPinOff,
  Pencil,
  Plus,
  Trash2,
  Crosshair,
  Loader2,
  Radar,
  Terminal,
} from "lucide-react";

/**
 * GATES & GEOFENCE — Phase 6 gate registry (geofenced QR).
 * Each gate maps physical entrances to kiosk terminals and carries the
 * geofence center/radius the server distance-checks every GPS-signed scan
 * against (lib/gates.ts haversine). Admin-level surface.
 */

const RADIUS_MIN = 20;
const RADIUS_MAX = 5000;

interface GateFormState {
  gateId: string;
  name: string;
  latText: string;
  lngText: string;
  radius: number;
  terminalsText: string;
}

const EMPTY_FORM: GateFormState = {
  gateId: "",
  name: "",
  latText: "",
  lngText: "",
  radius: 150,
  terminalsText: "",
};

/** Client-side mirror of the server `gateInput` zod schema (routes/gates.ts). */
function validate(form: GateFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const gateId = form.gateId.trim();
  if (!gateId) errors.gateId = "Gate id is required";
  else if (gateId.length > 80) errors.gateId = "Max 80 characters";

  const name = form.name.trim();
  if (!name) errors.name = "Name is required";
  else if (name.length > 120) errors.name = "Max 120 characters";

  const latEmpty = form.latText.trim() === "";
  const lngEmpty = form.lngText.trim() === "";
  if (latEmpty !== lngEmpty) {
    errors.geo = "Latitude and longitude go together — leave both empty to disable the geofence";
  }
  if (!latEmpty && !lngEmpty) {
    const lat = Number(form.latText);
    const lng = Number(form.lngText);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.lat = "Latitude must be between -90 and 90";
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) errors.lng = "Longitude must be between -180 and 180";
  }

  if (!Number.isInteger(form.radius) || form.radius < RADIUS_MIN || form.radius > RADIUS_MAX) {
    errors.radius = `Radius must be ${RADIUS_MIN}–${RADIUS_MAX} meters`;
  }

  const terminals = form.terminalsText.split(",").map((t) => t.trim()).filter(Boolean);
  if (terminals.length > 50) errors.terminals = "Max 50 terminals";
  else if (terminals.some((t) => t.length > 80)) errors.terminals = "Each terminal id must be ≤ 80 characters";

  return errors;
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

export default function GatesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const gatesQuery = useQuery<GateRecord[]>({
    queryKey: ["gates"],
    queryFn: api.listGates,
  });

  // ── editor dialog state ──
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<GateRecord | null>(null); // null = create
  const [form, setForm] = useState<GateFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── geolocation ──
  const [locating, setLocating] = useState(false);
  const [locMsg, setLocMsg] = useState<string | null>(null);

  // ── delete dialog ──
  const [deleteTarget, setDeleteTarget] = useState<GateRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const gates = gatesQuery.data ?? [];
  const geofencedCount = useMemo(() => gates.filter((g) => g.latitude != null && g.longitude != null).length, [gates]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setServerError(null);
    setLocMsg(null);
    setEditorOpen(true);
  };

  const openEdit = (gate: GateRecord) => {
    setEditing(gate);
    setForm({
      gateId: gate.gateId,
      name: gate.name,
      latText: gate.latitude == null ? "" : String(gate.latitude),
      lngText: gate.longitude == null ? "" : String(gate.longitude),
      radius: gate.geofenceRadiusM,
      terminalsText: gate.terminalIds.join(", "),
    });
    setErrors({});
    setServerError(null);
    setLocMsg(null);
    setEditorOpen(true);
  };

  const setField = <K extends keyof GateFormState>(key: K, value: GateFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      if (!e[key as string] && !(key === "latText" && e.geo) && !(key === "lngText" && e.geo)) return e;
      const next = { ...e };
      delete next[key as string];
      if (key === "latText" || key === "lngText") delete next.geo;
      return next;
    });
  };

  const locate = () => {
    if (!navigator.geolocation) {
      setLocMsg("Geolocation is not supported on this device");
      return;
    }
    setLocating(true);
    setLocMsg(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({
          ...f,
          latText: pos.coords.latitude.toFixed(6),
          lngText: pos.coords.longitude.toFixed(6),
        }));
        setErrors((e) => {
          const next = { ...e };
          delete next.geo;
          delete next.lat;
          delete next.lng;
          return next;
        });
        setLocMsg(`GPS fix acquired — accuracy ±${Math.round(pos.coords.accuracy)} m`);
        setLocating(false);
      },
      (err) => {
        setLocMsg(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied — enter coordinates manually"
            : "Could not get a GPS fix — enter coordinates manually",
        );
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  };

  const saveGate = async () => {
    const vErrors = validate(form);
    if (Object.keys(vErrors).length) {
      setErrors(vErrors);
      return;
    }
    setSaving(true);
    setServerError(null);
    const body: GateUpsertInput = {
      name: form.name.trim(),
      latitude: form.latText.trim() === "" ? null : Number(form.latText),
      longitude: form.lngText.trim() === "" ? null : Number(form.lngText),
      geofenceRadiusM: form.radius,
      terminalIds: form.terminalsText.split(",").map((t) => t.trim()).filter(Boolean),
    };
    try {
      const saved = await api.upsertGate(form.gateId.trim(), body);
      toast({
        title: editing ? "Gate updated" : "Gate created",
        description: `${saved.gateId} · ${saved.latitude != null ? "geofence on" : "geofence off"}`,
      });
      setEditorOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["gates"] });
    } catch (e: any) {
      setServerError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteGate(deleteTarget.gateId);
      toast({ title: "Gate deleted", description: `${deleteTarget.gateId} removed from the registry.` });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["gates"] });
    } catch (e: any) {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5 max-w-6xl mx-auto pb-6">
        <div className="gx-page-header flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <SectionTitle
            className="gx-title-gradient"
            sub={
              gates.length
                ? `${gates.length} gate${gates.length === 1 ? "" : "s"} · ${geofencedCount} geofenced`
                : "PHYSICAL GATES · GPS GEOFENCE FOR QR SCANS"
            }
          >
            GATES & GEOFENCE
          </SectionTitle>
          <GradientButton onClick={openCreate} className="!py-3 min-h-11">
            <Plus size={15} /> Add gate
          </GradientButton>
        </div>

        {gatesQuery.isLoading ? (
          <div className="space-y-3"><FeedSkeletonRow rows={3} /></div>
        ) : gatesQuery.isError ? (
          <GlowCard variant="gradient" className="gx-empty-tint p-6">
            <GlowEmpty
              icon={<MapPinOff size={26} />}
              title="Couldn't load gates"
              hint={(gatesQuery.error as Error).message}
            />
          </GlowCard>
        ) : gates.length === 0 ? (
          <GlowCard variant="gradient" className="gx-empty-tint p-6">
            <GlowEmpty
              icon={<MapPin size={26} />}
              title="No gates registered yet"
              hint="Register each physical entrance and link its kiosk terminals. Scans carrying a GPS fix are distance-checked against the gate's geofence — badges scanned from home get rejected as geofence violations."
            />
            <div className="flex justify-center mt-2">
              <Button
                variant="ghost"
                onClick={openCreate}
                className="min-h-11 text-purple-300 hover:bg-purple-500/10"
              >
                <Plus size={14} className="mr-1.5" /> Register your first gate
              </Button>
            </div>
          </GlowCard>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {gates.map((gate) => {
              const geoOn = gate.latitude != null && gate.longitude != null;
              return (
                <GlowCard key={gate.gateId} variant="gradient" className="gx-glow-hover p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                        style={{
                          background: geoOn ? "rgba(16,185,129,0.10)" : "rgba(255,255,255,0.04)",
                          border: `1px solid ${geoOn ? "rgba(16,185,129,0.25)" : "rgba(255,255,255,0.08)"}`,
                        }}
                      >
                        {geoOn ? (
                          <Radar size={17} className="text-emerald-400" />
                        ) : (
                          <MapPinOff size={17} className="text-white/30" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white/85 truncate">{gate.name}</p>
                        <span className="st-badge st-badge-purple font-mono mt-1">{gate.gateId}</span>
                      </div>
                    </div>
                    <span className={`st-badge ${geoOn ? "st-badge-green" : "st-badge-slate"}`}>
                      {geoOn ? "geofence on" : "geofence off"}
                    </span>
                  </div>

                  {/* geofence details */}
                  <div className="grid grid-cols-2 gap-2 mt-4 text-xs">
                    <div className="rounded-lg bg-black/30 border border-white/5 px-3 py-2">
                      <p className="text-[9px] uppercase tracking-widest text-white/30 mb-0.5">Latitude</p>
                      <p className="font-mono text-white/70">
                        {gate.latitude == null ? "—" : gate.latitude.toFixed(4)}
                      </p>
                    </div>
                    <div className="rounded-lg bg-black/30 border border-white/5 px-3 py-2">
                      <p className="text-[9px] uppercase tracking-widest text-white/30 mb-0.5">Longitude</p>
                      <p className="font-mono text-white/70">
                        {gate.longitude == null ? "—" : gate.longitude.toFixed(4)}
                      </p>
                    </div>
                    <div className="rounded-lg bg-black/30 border border-white/5 px-3 py-2">
                      <p className="text-[9px] uppercase tracking-widest text-white/30 mb-0.5">Radius</p>
                      <p className="font-mono text-white/70">{gate.geofenceRadiusM} m</p>
                    </div>
                    <div className="rounded-lg bg-black/30 border border-white/5 px-3 py-2">
                      <p className="text-[9px] uppercase tracking-widest text-white/30 mb-0.5">Terminals</p>
                      <p className="font-mono text-white/70">{gate.terminalIds.length}</p>
                    </div>
                  </div>

                  {gate.terminalIds.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-3">
                      {gate.terminalIds.map((t) => (
                        <span key={t} className="st-badge st-badge-cyan font-mono text-[9px]">
                          <Terminal size={9} /> {t}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 mt-4">
                    <p className="text-[10px] text-white/30">updated {relTime(gate.updatedAt)}</p>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        onClick={() => openEdit(gate)}
                        className="min-h-11 px-4 text-xs text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                      >
                        <Pencil size={13} className="mr-1.5" /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setDeleteTarget(gate)}
                        className="min-h-11 px-4 text-xs text-red-300 hover:bg-red-500/10 hover:text-red-200"
                      >
                        <Trash2 size={13} className="mr-1.5" /> Delete
                      </Button>
                    </div>
                  </div>
                </GlowCard>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Add / Edit dialog ──────────────────────────── */}
      <Dialog open={editorOpen} onOpenChange={(o) => { if (!o) setEditorOpen(false); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-white/90">
              {editing ? "Edit gate" : "Add gate"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? `Update ${editing.gateId} — coordinates, radius or terminal links.`
                : "Gate ids are permanent identifiers (e.g. main-gate, gate-2). Terminals linked here inherit the geofence check."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="gate-id" className="text-xs text-white/60">Gate id</Label>
              <Input
                id="gate-id"
                value={form.gateId}
                onChange={(e) => setField("gateId", e.target.value)}
                disabled={!!editing}
                placeholder="main-gate"
                className="font-mono text-xs bg-black/30 border-white/10 h-11"
              />
              {errors.gateId && <p className="text-[10px] text-red-400">{errors.gateId}</p>}
              {editing && <p className="text-[10px] text-white/25">Gate id can't be changed after creation.</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="gate-name" className="text-xs text-white/60">Name</Label>
              <Input
                id="gate-name"
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="Main entrance"
                className="text-xs bg-black/30 border-white/10 h-11"
              />
              {errors.name && <p className="text-[10px] text-red-400">{errors.name}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="gate-lat" className="text-xs text-white/60">Latitude</Label>
                <Input
                  id="gate-lat"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={form.latText}
                  onChange={(e) => setField("latText", e.target.value)}
                  placeholder="9.0330"
                  className="font-mono text-xs bg-black/30 border-white/10 h-11"
                />
                {errors.lat && <p className="text-[10px] text-red-400">{errors.lat}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gate-lng" className="text-xs text-white/60">Longitude</Label>
                <Input
                  id="gate-lng"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={form.lngText}
                  onChange={(e) => setField("lngText", e.target.value)}
                  placeholder="38.7500"
                  className="font-mono text-xs bg-black/30 border-white/10 h-11"
                />
                {errors.lng && <p className="text-[10px] text-red-400">{errors.lng}</p>}
              </div>
            </div>
            {errors.geo && <p className="text-[10px] text-red-400">{errors.geo}</p>}

            <Button
              type="button"
              variant="ghost"
              onClick={locate}
              disabled={locating}
              className="w-full min-h-11 text-xs text-emerald-300 hover:bg-emerald-500/10 border border-emerald-500/20"
            >
              {locating ? (
                <>
                  <Loader2 size={14} className="animate-spin mr-1.5" /> Getting GPS fix…
                </>
              ) : (
                <>
                  <Crosshair size={14} className="mr-1.5" /> 📍 Use my location
                </>
              )}
            </Button>
            {locMsg && (
              <p className={`text-[10px] ${locMsg.includes("acquired") ? "text-emerald-400" : "text-amber-400"}`}>
                {locMsg}
              </p>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="gate-radius-num" className="text-xs text-white/60">Geofence radius</Label>
                <div className="flex items-center gap-1">
                  <Input
                    id="gate-radius-num"
                    type="number"
                    min={RADIUS_MIN}
                    max={RADIUS_MAX}
                    value={form.radius}
                    onChange={(e) => setField("radius", Number(e.target.value))}
                    className="w-24 h-9 font-mono text-xs bg-black/30 border-white/10"
                  />
                  <span className="text-xs text-white/40">m</span>
                </div>
              </div>
              <Slider
                min={RADIUS_MIN}
                max={RADIUS_MAX}
                step={10}
                value={[form.radius]}
                onValueChange={(v) => setField("radius", v[0] ?? form.radius)}
                aria-label="Geofence radius in meters"
              />
              <p className="text-[10px] text-white/25">
                Allowed distance from the gate center ({RADIUS_MIN}–{RADIUS_MAX} m). GPS accuracy adds a small buffer
                server-side. New gates default to 150 m.
              </p>
              {errors.radius && <p className="text-[10px] text-red-400">{errors.radius}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="gate-terminals" className="text-xs text-white/60">Terminal ids (comma-separated)</Label>
              <Input
                id="gate-terminals"
                value={form.terminalsText}
                onChange={(e) => setField("terminalsText", e.target.value)}
                placeholder="door-1, door-2"
                className="font-mono text-xs bg-black/30 border-white/10 h-11"
              />
              <p className="text-[10px] text-white/25">
                Kiosks at this gate — scans signed by these terminals are geofence-checked.
              </p>
              {errors.terminals && <p className="text-[10px] text-red-400">{errors.terminals}</p>}
            </div>

            {serverError && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {serverError}
              </p>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setEditorOpen(false)}
              disabled={saving}
              className="min-h-11 text-white/50 hover:text-white/85"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveGate()}
              disabled={saving}
              className="min-h-11 bg-purple-600 hover:bg-purple-500 text-white"
            >
              {saving ? "Saving…" : editing ? "Save changes" : "Create gate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm dialog ──────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white/90">
              <Trash2 size={15} className="text-red-400" /> Delete gate
            </DialogTitle>
            <DialogDescription>
              Remove <span className="font-mono text-white/70">{deleteTarget?.gateId}</span> from the registry?
              Its terminals will no longer inherit a geofence, and GPS checks for those scans will be skipped
              until the terminals are linked to another gate.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="min-h-11 text-white/50 hover:text-white/85"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              className="min-h-11"
            >
              {deleting ? "Deleting…" : "Delete gate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
