import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { formatDistanceToNowStrict } from "date-fns";
import { motion } from "framer-motion";
import {
  AlertTriangle, ArrowLeftRight, BatteryFull, BatteryLow, BatteryMedium, Camera, Check, CheckCircle2,
  ChevronDown, Copy, Cpu, ExternalLink, Flashlight, Link2, QrCode, RefreshCw, ScanFace, Smartphone, Timer, VideoOff, X,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, type DevicePairing, type GateDeviceRow, type GateRecord } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

/**
 * CAMERA NETWORK (Phase 7) — live fleet view for every gate camera (phones + Pis).
 * Reads GET /devices (heartbeat ≤30s = online, JPEG data-URL thumbnails, health)
 * and GET /devices/uptime; drives the pairing dialog (one-time token, 15-minute
 * expiry, 3s first-heartbeat poll) and the live command surface (mode switch,
 * flashlight, quality, disconnect). SSE device.* events invalidate ["camera-network"]
 * so heartbeats and command effects land instantly.
 * Palette: slate / emerald / red / violet (amber only where a blind-spot demands it).
 */

type DeviceCommand = Parameters<typeof api.deviceCommand>[1];
type QualityChoice = "auto" | "low" | "balanced" | "hd";

const cardCls = "overflow-hidden rounded-xl border border-violet-200/10 bg-card text-foreground shadow-none";
const btnBase =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-violet-200/15 bg-violet-200/[0.06] px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-violet-200/[0.12] disabled:pointer-events-none disabled:opacity-45";
const accentBtn =
  "gx-btn-accent gx-gradient-pan gx-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold text-white transition-all disabled:pointer-events-none disabled:opacity-45";
const dangerBtn =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-rose-300/20 bg-rose-400/10 px-3.5 text-sm font-semibold text-rose-200 transition-colors hover:bg-rose-400/15 disabled:pointer-events-none disabled:opacity-45";
const infoLabel = "text-[10px] font-semibold uppercase tracking-widest text-violet-200/45";
const infoValue = "truncate text-xs font-medium text-foreground/85";

/** Pulsing status dot — same pattern as SmsLogsPage, re-implemented locally. */
function PulsingDot({ cls }: { cls: string }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${cls}`} />
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${cls}`} />
    </span>
  );
}

/** Wraps any control in a tooltip; works for disabled buttons too (span bridge). */
function Tip({ hint, children }: { hint: string | null; children: ReactNode }) {
  if (!hint) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex min-w-0">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px] text-xs">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

function prettyStatus(s: string) {
  const t = s.replaceAll("_", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function statusMeta(d: GateDeviceRow): { label: string; dot: string } {
  if (!d.online) {
    return d.status === "discovered"
      ? { label: "Discovered", dot: "bg-violet-400" }
      : { label: "Offline", dot: "bg-slate-400" };
  }
  if (d.healthStatus === "frozen") return { label: "Frozen", dot: "bg-red-400" };
  if (d.healthStatus === "obstructed") return { label: "Obstructed", dot: "bg-amber-400" };
  return { label: d.status === "connected" ? "Online" : prettyStatus(d.status), dot: "bg-emerald-400" };
}

function BatteryGlyph({ level }: { level: number }) {
  const Icon = level >= 60 ? BatteryFull : level >= 25 ? BatteryMedium : BatteryLow;
  return <Icon size={13} className="shrink-0 text-violet-200/60" aria-hidden="true" />;
}

function lastSeenLabel(d: GateDeviceRow): string {
  if (!d.lastSeenAt) return "Never reported";
  const t = new Date(d.lastSeenAt).getTime();
  if (Number.isNaN(t)) return "Unknown";
  try {
    return formatDistanceToNowStrict(new Date(t), { addSuffix: true });
  } catch {
    return "Unknown";
  }
}

const COMMAND_LABEL: Record<DeviceCommand, string> = {
  switch_mode: "Mode switch delivered",
  request_snapshot: "Snapshot requested",
  disconnect: "Disconnect queued",
  flashlight_toggle: "Flashlight toggled",
  set_quality: "Stream quality updated",
  set_data_saver: "Data saver updated",
};

function expiryLabel(secondsLeft: number) {
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── Pairing dialog ───────────────────────────────────────────────

interface PairFormInput {
  name: string;
  gateId: string | null;
  deviceType: "phone" | "pi";
  mode: "face" | "qr";
}

function PairDialog({
  open,
  onOpenChange,
  gates,
  repairTarget,
  suggestedName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  gates: GateRecord[];
  repairTarget: GateDeviceRow | null;
  suggestedName: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(suggestedName);
  const [gateId, setGateId] = useState("none");
  const [deviceType, setDeviceType] = useState<"phone" | "pi">("phone");
  const [mode, setMode] = useState<"face" | "qr">("face");
  const [pairing, setPairing] = useState<DevicePairing | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // Reset the whole flow each time the dialog opens (or the repair target flips).
  useEffect(() => {
    if (!open) return;
    setPairing(null);
    setConfirmed(false);
    setCopied(false);
    setCopiedLink(false);
    setSecondsLeft(null);
    setName(repairTarget ? repairTarget.name : suggestedName);
    setGateId(repairTarget?.assignedGateId ?? "none");
    setDeviceType(repairTarget?.deviceType ?? "phone");
    setMode(repairTarget?.mode ?? "face");
  }, [open, repairTarget, suggestedName]);

  const pairMutation = useMutation({
    mutationFn: async (input: PairFormInput) => {
      if (repairTarget) {
        return api.repairDevice(repairTarget.id, {
          name: input.name,
          deviceType: input.deviceType,
          // "" = the operator picked "No gate" → server unassigns. Never send
          // null here: the server reads absent/null as "keep the current gate".
          gateId: input.gateId ?? "",
          mode: input.mode,
        });
      }
      return api.pairDevice({
        name: input.name,
        deviceType: input.deviceType,
        mode: input.mode,
        gateId: input.gateId ?? undefined,
      });
    },
    onSuccess: (result) => {
      setPairing(result);
      setConfirmed(false);
      setCopied(false);
      toast({ title: "Pairing code ready", description: "It expires in 15 minutes and works for exactly one device." });
    },
    onError: (error) =>
      toast({
        title: "Pairing failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      }),
  });

  // 15:00 expiry countdown.
  useEffect(() => {
    if (!pairing) return;
    const expiresAt = new Date(pairing.expiresAt).getTime();
    const tick = () =>
      setSecondsLeft(Number.isNaN(expiresAt) ? null : Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  // Poll every 3s until the freshly-created device reports its first heartbeat.
  useEffect(() => {
    if (!open || !pairing || confirmed) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const devices = await api.devices();
          if (devices.some((d) => d.id === pairing.deviceId && d.online)) {
            setConfirmed(true);
            void queryClient.invalidateQueries({ queryKey: ["camera-network"] });
            toast({ title: "Paired — first heartbeat received", description: "The camera is now streaming into the network." });
          }
        } catch {
          /* transient network error — keep polling */
        }
      })();
    }, 3000);
    return () => clearInterval(timer);
  }, [open, pairing, confirmed, queryClient, toast]);

  const copyToken = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Select the code text and copy it manually.", variant: "destructive" });
    }
  };

  /** Deep link the phone's NATIVE camera app can scan — opens /camera-node already paired. */
  const pairingHref = pairing
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/camera-node?pair=${encodeURIComponent(pairing.token)}`
    : "";

  const copyLink = async () => {
    if (!pairingHref) return;
    try {
      await navigator.clipboard.writeText(pairingHref);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Select the link text and copy it manually.", variant: "destructive" });
    }
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    pairMutation.mutate({
      name: trimmed,
      gateId: gateId === "none" ? null : gateId,
      deviceType,
      mode,
    });
  };

  const deviceTypeOption = (value: "phone" | "pi", label: string, Icon: typeof Smartphone) => (
    <button
      type="button"
      onClick={() => setDeviceType(value)}
      aria-pressed={deviceType === value}
      className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${
        deviceType === value
          ? "border-violet-300/45 bg-violet-300/15 text-foreground"
          : "border-violet-200/15 bg-transparent text-foreground/60 hover:bg-violet-200/[0.06]"
      }`}
    >
      <Icon size={15} aria-hidden="true" />
      {label}
    </button>
  );

  const modeOption = (value: "face" | "qr", label: string, Icon: typeof ScanFace) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      aria-pressed={mode === value}
      className={`inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${
        mode === value
          ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-100"
          : "border-violet-200/15 bg-transparent text-foreground/60 hover:bg-violet-200/[0.06]"
      }`}
    >
      <Icon size={15} aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto border-violet-200/15 bg-popover text-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{repairTarget ? `Re-pair ${repairTarget.name}` : "Pair a new camera"}</DialogTitle>
          <DialogDescription className="text-foreground/60">
            {repairTarget
              ? "A fresh one-time code revokes the old session. The device must scan it to reconnect."
              : "The code works once, for one device, and expires in 15 minutes."}
          </DialogDescription>
        </DialogHeader>

        {!pairing ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="pair-device-name" className="block text-xs font-medium text-foreground/75">
                Device name
              </label>
              <input
                id="pair-device-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="e.g. North gate phone"
                className="min-h-11 w-full rounded-lg border border-violet-200/15 bg-muted px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-violet-300/45 focus:ring-2 focus:ring-violet-300/15"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground/75">Assign to gate (optional)</label>
              <Select value={gateId} onValueChange={setGateId}>
                <SelectTrigger className="min-h-11 w-full border-violet-200/15 bg-muted text-foreground focus:ring-violet-300/15">
                  <SelectValue placeholder="Choose a gate" />
                </SelectTrigger>
                <SelectContent className="border-violet-200/15 bg-popover text-foreground">
                  <SelectItem value="none">Unassigned</SelectItem>
                  {gates.map((gate) => (
                    <SelectItem key={gate.gateId} value={gate.gateId}>
                      {gate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!repairTarget && (
              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-foreground/75">Device type</span>
                <div className="flex gap-2">
                  {deviceTypeOption("phone", "Phone", Smartphone)}
                  {deviceTypeOption("pi", "Pi", Cpu)}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-foreground/75">Recognition mode</span>
              <div className="flex gap-2">
                {modeOption("face", "Face", ScanFace)}
                {modeOption("qr", "QR", QrCode)}
              </div>
            </div>

            <button
              type="button"
              onClick={submit}
              disabled={pairMutation.isPending || !name.trim()}
              className={`${accentBtn} w-full`}
              data-testid="button-generate-pairing-code"
            >
              {pairMutation.isPending ? <RefreshCw size={15} className="animate-spin" aria-hidden="true" /> : <QrCode size={15} aria-hidden="true" />}
              Generate pairing code
            </button>
            {pairMutation.isError && (
              <p className="text-xs text-rose-200" role="alert">
                {pairMutation.error instanceof Error ? pairMutation.error.message : "Pairing request failed."}
              </p>
            )}
          </div>
        ) : confirmed ? (
          <div className="space-y-4 text-center" role="status">
            <CheckCircle2 size={44} className="mx-auto text-emerald-300" aria-hidden="true" />
            <p className="text-base font-semibold text-emerald-100">Paired — first heartbeat received</p>
            <p className="break-all font-mono text-xs text-foreground/50">{pairing.deviceId}</p>
            <button type="button" onClick={() => onOpenChange(false)} className={`${btnBase} w-full`}>
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="mx-auto w-fit rounded-xl bg-white p-3 shadow-lg" aria-label="Pairing QR code">
              <QRCodeSVG value={pairingHref || pairing.token} size={200} level="M" marginSize={2} />
            </div>
            <p className="text-center text-xs text-foreground/55">
              Scan with the phone's <span className="font-semibold text-foreground/80">regular camera app</span> —
              it opens <span className="font-mono">/camera-node</span> and pairs automatically.
            </p>

            <div className="rounded-lg border border-violet-200/15 bg-muted p-3">
              <p className={infoLabel}>Pairing code</p>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-foreground/85">
                  {pairing.token}
                </code>
                <button
                  type="button"
                  onClick={() => void copyToken()}
                  className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-violet-200/15 bg-violet-200/[0.06] text-foreground/75 transition-colors hover:bg-violet-200/[0.12]"
                  aria-label="Copy pairing code"
                >
                  {copied ? <Check size={15} className="text-emerald-300" aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void copyLink()}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-violet-200/15 bg-violet-200/[0.06] px-3 text-xs font-medium text-foreground/85 transition-colors hover:bg-violet-200/[0.12]"
              >
                {copiedLink ? <Check size={14} className="text-emerald-300" aria-hidden="true" /> : <Link2 size={14} aria-hidden="true" />}
                {copiedLink ? "Link copied" : "Copy pairing link"}
              </button>
              <a
                href="/camera-node"
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-violet-200/15 bg-violet-200/[0.06] px-3 text-xs font-medium text-foreground/85 transition-colors hover:bg-violet-200/[0.12]"
              >
                <ExternalLink size={14} aria-hidden="true" />
                Open camera node
              </a>
            </div>

            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 text-foreground/75">
                <Timer size={14} className="text-violet-200/60" aria-hidden="true" />
                Expires in
              </span>
              <span
                className={`font-mono text-base font-semibold tabular-nums ${
                  secondsLeft !== null && secondsLeft <= 60 ? "text-rose-200" : "text-foreground"
                }`}
                role="timer"
                aria-live="off"
              >
                {secondsLeft === null ? "--:--" : expiryLabel(secondsLeft)}
              </span>
            </div>

            {secondsLeft === 0 && (
              <p className="rounded-lg border border-rose-300/20 bg-rose-300/[0.07] px-3 py-2 text-xs text-rose-100" role="alert">
                This code expired. Generate a fresh one — nothing was lost, the device never saw it.
              </p>
            )}

            <ol className="space-y-1.5 rounded-lg border border-violet-200/10 bg-violet-200/[0.03] p-3 text-xs leading-relaxed text-foreground/70">
              <li>1. Easiest: point the phone's camera app at the QR above — the pairing page opens already connected</li>
              <li>2. Or open <span className="font-mono text-violet-200">/camera-node</span> on the phone, then scan this QR in-app or paste the code</li>
              <li>3. Keep this dialog open until the first heartbeat lands</li>
            </ol>

            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-xs text-foreground/55">
                <PulsingDot cls="bg-violet-300" />
                Polling for first heartbeat every 3s
              </span>
              <button
                type="button"
                onClick={submit}
                disabled={pairMutation.isPending}
                title="Issues a brand-new code — every code shown before it stops working instantly"
                className={`${btnBase} px-3 text-xs`}
              >
                <RefreshCw size={13} className={pairMutation.isPending ? "animate-spin" : ""} aria-hidden="true" />
                Fresh token
              </button>
            </div>
            <p className="text-center text-[11px] leading-relaxed text-foreground/45">
              Heads up: pressing <span className="font-semibold text-foreground/75">Fresh token</span> (or generating a
              code again later) instantly retires every older code — the phone must use the latest one.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Device card ──────────────────────────────────────────────────

function DeviceCard({
  device,
  index,
  busy,
  runCommand,
  onRepair,
  onDisconnect,
  disconnectPending,
}: {
  device: GateDeviceRow;
  index: number;
  busy: boolean;
  runCommand: (id: string, command: DeviceCommand, value?: string | number | boolean | null) => void;
  onRepair: (d: GateDeviceRow) => void;
  onDisconnect: (d: GateDeviceRow) => void;
  disconnectPending: boolean;
}) {
  const meta = statusMeta(device);
  const nextMode = device.mode === "face" ? "QR" : "Face";
  const quality: QualityChoice = (device.targetQuality as QualityChoice) || "auto";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.3) }}
    >
      <Card className={cardCls} data-testid={`camera-device-card-${device.id}`}>
        {/* Thumbnail strip */}
        <div className="relative h-28 w-full overflow-hidden rounded-t-xl bg-slate-950">
          {device.thumbnail ? (
            <img
              src={device.thumbnail}
              alt={`Latest frame from ${device.name}`}
              className="h-28 w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="flex h-28 w-full flex-col items-center justify-center gap-1.5 text-slate-500">
              <VideoOff size={22} aria-hidden="true" />
              <span className="text-[11px] font-medium">no frame yet</span>
            </div>
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" aria-hidden="true" />
        </div>

        <div className="space-y-3 p-4">
          {/* Title + badges */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground" title={device.name}>
                {device.name}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-foreground/60">
                <PulsingDot cls={meta.dot} />
                <span className={device.online ? "" : "text-foreground/60"}>{meta.label}</span>
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md border border-violet-200/15 bg-violet-200/[0.06] px-2 py-1 text-[10px] font-medium text-foreground/80">
                {device.deviceType === "phone" ? <Smartphone size={11} aria-hidden="true" /> : <Cpu size={11} aria-hidden="true" />}
                {device.deviceType === "phone" ? "Phone" : "Pi"}
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-300/20 bg-emerald-300/[0.08] px-2 py-1 text-[10px] font-medium text-emerald-200">
                {device.mode === "face" ? <ScanFace size={11} aria-hidden="true" /> : <QrCode size={11} aria-hidden="true" />}
                {device.mode === "face" ? "Face" : "QR"}
              </span>
            </div>
          </div>

          {/* Info rows */}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <div className="min-w-0">
              <dt className={infoLabel}>Gate</dt>
              <dd className={infoValue} title={device.gateName ?? undefined}>{device.gateName ?? "Unassigned"}</dd>
            </div>
            <div className="min-w-0">
              <dt className={infoLabel}>Stream</dt>
              <dd className={infoValue}>
                {device.fps != null || device.resolution
                  ? `${device.fps != null ? `${device.fps} fps` : "fps —"}${device.resolution ? ` · ${device.resolution}` : ""}`
                  : "Not reported"}
              </dd>
            </div>
            {device.deviceType === "phone" && device.batteryLevel != null && (
              <div className="min-w-0">
                <dt className={infoLabel}>Battery</dt>
                <dd className={`${infoValue} flex items-center gap-1.5`}>
                  <BatteryGlyph level={device.batteryLevel} />
                  {Math.round(device.batteryLevel)}%
                </dd>
              </div>
            )}
            {device.deviceType === "pi" && device.cpuTempC != null && (
              <div className="min-w-0">
                <dt className={infoLabel}>CPU temp</dt>
                <dd className={infoValue}>{device.cpuTempC.toFixed(1)}°C</dd>
              </div>
            )}
            <div className="min-w-0">
              <dt className={infoLabel}>Connection</dt>
              <dd className={infoValue} title={device.connection ?? undefined}>{device.connection ?? "Unknown"}</dd>
            </div>
            <div className="min-w-0">
              <dt className={infoLabel}>Last seen</dt>
              <dd className={infoValue}>{lastSeenLabel(device)}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap items-center gap-1.5">
            {device.dataSaver && (
              <span className="inline-flex items-center gap-1 rounded-full border border-violet-200/20 bg-violet-200/[0.08] px-2 py-0.5 text-[10px] font-medium text-violet-200">
                Data saver on
              </span>
            )}
            {device.healthStatus === "unknown" && device.online && (
              <span className="inline-flex items-center gap-1 rounded-full border border-foreground/20 bg-foreground/10 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Health unknown
              </span>
            )}
          </div>

          {/* Actions */}
          <div className="space-y-2 border-t border-foreground/10 pt-3">
            <div className="flex gap-2">
              <Tip hint={device.online ? null : "Device is offline — connect it before sending commands"}>
                <button
                  type="button"
                  onClick={() => runCommand(device.id, "switch_mode", device.mode === "face" ? "qr" : "face")}
                  disabled={!device.online || busy}
                  className={`${btnBase} min-w-0 flex-1`}
                  aria-label={`Switch ${device.name} to ${nextMode} mode`}
                >
                  <ArrowLeftRight size={14} aria-hidden="true" />
                  To {nextMode}
                </button>
              </Tip>
              {device.deviceType === "phone" && device.online && (
                <button
                  type="button"
                  onClick={() => runCommand(device.id, "flashlight_toggle")}
                  disabled={busy}
                  className={btnBase}
                  aria-label={`Toggle flashlight on ${device.name}`}
                >
                  <Flashlight size={14} aria-hidden="true" />
                  Light
                </button>
              )}
            </div>

            <div className="flex gap-2">
              <Select
                value={quality}
                onValueChange={(v) => runCommand(device.id, "set_quality", v === "auto" ? null : v)}
                disabled={busy}
              >
                <SelectTrigger
                  className="min-h-11 min-w-0 flex-1 border-violet-200/15 bg-violet-200/[0.04] text-xs text-foreground focus:ring-violet-300/15"
                  aria-label={`Stream quality for ${device.name}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-violet-200/15 bg-popover text-foreground">
                  <SelectItem value="auto">Auto (server default)</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="balanced">Balanced</SelectItem>
                  <SelectItem value="hd">HD</SelectItem>
                </SelectContent>
              </Select>

              {device.online ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button type="button" className={dangerBtn} disabled={disconnectPending} aria-label={`Disconnect ${device.name}`}>
                      <X size={14} aria-hidden="true" />
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="border-violet-200/15 bg-popover text-foreground">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnect {device.name}?</AlertDialogTitle>
                      <AlertDialogDescription className="text-foreground/65">
                        The device session is revoked immediately. To stream again it must re-pair with a fresh one-time code.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="min-h-11 border-violet-200/15 bg-transparent text-foreground/75 hover:bg-violet-200/[0.08]">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        className="min-h-11 border border-rose-300/30 bg-rose-400/15 text-rose-100 hover:bg-rose-400/25"
                        onClick={() => onDisconnect(device)}
                      >
                        Disconnect device
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <button
                  type="button"
                  onClick={() => onRepair(device)}
                  className={`${btnBase} shrink-0`}
                  aria-label={`Connect ${device.name} — generate a new pairing code`}
                >
                  <QrCode size={14} aria-hidden="true" />
                  Connect
                </button>
              )}
            </div>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}

// ── The card ─────────────────────────────────────────────────────

export function CameraNetworkCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const devicesQuery = useQuery({
    queryKey: ["camera-network"],
    queryFn: api.devices,
    refetchInterval: 10_000,
  });
  const gatesQuery = useQuery({ queryKey: ["gates"], queryFn: api.listGates });
  const uptimeQuery = useQuery({
    queryKey: ["camera-network", "uptime"],
    queryFn: () => api.deviceUptime(7),
    refetchInterval: 60_000,
  });

  const [pairOpen, setPairOpen] = useState(false);
  const [repairTarget, setRepairTarget] = useState<GateDeviceRow | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const devices = devicesQuery.data ?? [];
  const onlineCount = devices.filter((d) => d.online).length;
  const offlineCount = devices.length - onlineCount;
  const degradedCount = devices.filter((d) => d.status === "degraded").length;

  // Phase 4.3 blind-spot rule: a PAIRED, gate-assigned camera that is offline,
  // obstructed or frozen means that gate has no eyes — demand manual/QR fallback.
  const blindSpots = useMemo(
    () =>
      devices.filter(
        (d) =>
          d.paired &&
          d.assignedGateId &&
          (!d.online || d.healthStatus === "obstructed" || d.healthStatus === "frozen"),
      ),
    [devices],
  );
  const blindSpotKey = useMemo(
    () => blindSpots.map((d) => `${d.id}:${d.online ? "on" : "off"}:${d.healthStatus}`).sort().join("|"),
    [blindSpots],
  );
  const bannerVisible = blindSpots.length > 0 && dismissedKey !== blindSpotKey;
  const bannerHard = blindSpots.some((d) => !d.online || d.healthStatus === "frozen");
  const bannerGateNames = [...new Set(blindSpots.map((d) => d.gateName ?? d.assignedGateId ?? "gate"))];
  const bannerHeadline =
    bannerGateNames.length === 1
      ? `Gate ${bannerGateNames[0]} camera down — switch to manual/QR fallback`
      : `${blindSpots.length} gate camera${blindSpots.length === 1 ? "" : "s"} down — switch to manual/QR fallback`;

  // Group by assigned gate; label = gateName ?? "Unassigned" (Pis group the same way).
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; items: GateDeviceRow[] }>();
    for (const d of devices) {
      const key = d.assignedGateId ?? "__unassigned";
      const group = map.get(key) ?? { label: d.gateName ?? "Unassigned", items: [] };
      if (group.label === "Unassigned" && d.gateName) group.label = d.gateName;
      group.items.push(d);
      map.set(key, group);
    }
    return [...map.entries()]
      .map(([key, group]) => ({
        key,
        label: group.label || "Unassigned",
        items: [...group.items].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort(
        (a, b) =>
          (a.key === "__unassigned" ? 1 : 0) - (b.key === "__unassigned" ? 1 : 0) || a.label.localeCompare(b.label),
      );
  }, [devices]);

  const suggestedName = useMemo(() => {
    const names = new Set(devices.map((d) => d.name));
    let n = devices.filter((d) => d.deviceType === "phone").length + 1;
    while (names.has(`Gate phone ${n}`)) n += 1;
    return `Gate phone ${n}`;
  }, [devices]);

  const commandMutation = useMutation({
    mutationFn: (vars: { id: string; command: DeviceCommand; value?: string | number | boolean | null }) =>
      api.deviceCommand(vars.id, vars.command, vars.value),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["camera-network"] });
      toast({ title: COMMAND_LABEL[result.command as DeviceCommand] ?? "Command delivered" });
    },
    onError: (error) =>
      toast({
        title: "Command failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      }),
  });

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => api.disconnectDevice(id),
    onSuccess: (result, id) => {
      void queryClient.invalidateQueries({ queryKey: ["camera-network"] });
      toast({
        title: result.revoked ? "Device disconnected — session revoked" : "Device marked for disconnect",
        description: devices.find((d) => d.id === id)?.name,
      });
    },
    onError: (error) =>
      toast({
        title: "Disconnect failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      }),
  });

  const openPair = () => {
    setRepairTarget(null);
    setPairOpen(true);
  };
  const openRepair = (d: GateDeviceRow) => {
    setRepairTarget(d);
    setPairOpen(true);
  };
  const runCommand = (id: string, command: DeviceCommand, value?: string | number | boolean | null) =>
    commandMutation.mutate({ id, command, value });

  const chipCls = "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium";

  return (
    <TooltipProvider delayDuration={200}>
      <article className="gx-panel rounded-2xl p-5 sm:p-6" data-testid="camera-network-card" aria-label="Camera network">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-violet-200/55">Camera fleet</p>
            <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-foreground">
              Camera Network
              <span className="ml-2 text-sm font-normal text-foreground/50">
                {devicesQuery.isLoading ? "loading…" : `${devices.length} device${devices.length === 1 ? "" : "s"}`}
              </span>
            </h2>
            {!devicesQuery.isLoading && !devicesQuery.isError && devices.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="Fleet summary">
                <span className={`${chipCls} border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                  {onlineCount} online
                </span>
                <span className={`${chipCls} border-foreground/20 bg-foreground/[0.08] text-muted-foreground`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-400" aria-hidden="true" />
                  {offlineCount} offline
                </span>
                <span className={`${chipCls} border-rose-300/20 bg-rose-300/[0.08] text-rose-200`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-400" aria-hidden="true" />
                  {degradedCount} degraded
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void devicesQuery.refetch()}
              disabled={devicesQuery.isFetching}
              className={btnBase}
              aria-label="Refresh camera network"
            >
              <RefreshCw size={14} className={devicesQuery.isFetching ? "animate-spin" : ""} aria-hidden="true" />
              Refresh
            </button>
            <button type="button" onClick={openPair} className={accentBtn} data-testid="button-pair-camera">
              <Camera size={15} aria-hidden="true" />
              Pair new camera
            </button>
          </div>
        </div>

        {/* Blind-spot banner */}
        {bannerVisible && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className={`mt-4 rounded-xl border p-4 ${
              bannerHard ? "border-rose-300/25 bg-rose-400/[0.08]" : "border-amber-300/25 bg-amber-400/[0.08]"
            }`}
            role="alert"
            data-testid="blind-spot-banner"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <AlertTriangle
                  size={18}
                  className={`mt-0.5 shrink-0 ${bannerHard ? "text-rose-300" : "text-amber-300"}`}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className={`text-sm font-semibold ${bannerHard ? "text-rose-100" : "text-amber-100"}`}>
                    {bannerHeadline}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {blindSpots.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground/75">
                        <span className="font-medium text-foreground">{d.name}</span>
                        <span className="text-foreground/45">·</span>
                        <span>Gate {d.gateName ?? d.assignedGateId}</span>
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                            !d.online
                              ? "bg-rose-300/15 text-rose-200"
                              : d.healthStatus === "frozen"
                                ? "bg-rose-300/15 text-rose-200"
                                : "bg-amber-300/15 text-amber-200"
                          }`}
                        >
                          {!d.online ? "Offline" : d.healthStatus === "frozen" ? "Frozen" : "Obstructed"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDismissedKey(blindSpotKey)}
                className="shrink-0 rounded-md p-1.5 text-foreground/50 transition-colors hover:bg-violet-200/[0.08] hover:text-foreground"
                aria-label="Dismiss blind-spot alert until device state changes"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          </motion.div>
        )}

        {/* Body states */}
        {devicesQuery.isLoading ? (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3].map((item) => (
              <Skeleton key={item} className="h-[340px] rounded-xl border border-violet-200/10 bg-violet-200/[0.04]" />
            ))}
          </div>
        ) : devicesQuery.isError ? (
          <div
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-rose-300/15 bg-rose-300/[0.06] p-4 text-sm text-rose-100/80"
            role="alert"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p>The camera network could not be loaded.</p>
              <p className="mt-0.5 text-xs text-rose-100/60">
                {devicesQuery.error instanceof Error ? devicesQuery.error.message : "Unknown error"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void devicesQuery.refetch()}
              className="shrink-0 rounded-lg border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-400/15"
            >
              Retry
            </button>
          </div>
        ) : devices.length === 0 ? (
          <div className="mt-4 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-violet-200/15 p-10 text-center">
            <Camera size={26} className="text-violet-200/45" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No camera devices yet — pair the first one</p>
            <p className="text-xs text-foreground/55">
              Phones scan the pairing code at /camera-node; Pis pick it up on their next boot.
            </p>
          </div>
        ) : (
          <div className="mt-5 space-y-6">
            {groups.map((group, groupIndex) => (
              <motion.section
                key={group.key}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: Math.min(groupIndex * 0.05, 0.2) }}
                aria-label={`Cameras assigned to ${group.label}`}
              >
                <div className="mb-2.5 flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-violet-200/55">
                    {group.label}
                  </span>
                  <span className="rounded-md bg-violet-200/[0.07] px-1.5 py-0.5 text-[10px] font-medium text-foreground/55">
                    {group.items.length}
                  </span>
                  <span className="h-px flex-1 bg-foreground/10" aria-hidden="true" />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {group.items.map((device, i) => (
                    <DeviceCard
                      key={device.id}
                      device={device}
                      index={groupIndex * 3 + i}
                      busy={commandMutation.isPending && commandMutation.variables?.id === device.id}
                      runCommand={runCommand}
                      onRepair={openRepair}
                      onDisconnect={(d) => disconnectMutation.mutate(d.id)}
                      disconnectPending={
                        disconnectMutation.isPending && disconnectMutation.variables === device.id
                      }
                    />
                  ))}
                </div>
              </motion.section>
            ))}
          </div>
        )}

        {/* Reliability — Phase 4.5 uptime trail */}
        {!devicesQuery.isLoading && !devicesQuery.isError && devices.length > 0 && (
          <Collapsible defaultOpen className="mt-6 border-t border-foreground/10 pt-4">
            <CollapsibleTrigger className="group inline-flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-1 text-left transition-colors hover:bg-violet-200/[0.04]">
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
                <Timer size={15} className="text-violet-200/60" aria-hidden="true" />
                Uptime — last 7 days
                <span className="text-xs font-normal text-foreground/45">heartbeat-derived</span>
              </span>
              <span className="flex items-center gap-2">
                {uptimeQuery.isFetching && (
                  <RefreshCw size={13} className="animate-spin text-violet-200/45" aria-hidden="true" />
                )}
                <ChevronDown
                  size={16}
                  className="text-violet-200/50 transition-transform duration-200 group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-3 space-y-2">
                {uptimeQuery.isError ? (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-300/15 bg-rose-300/[0.06] px-3 py-2.5" role="alert">
                    <p className="text-xs text-rose-100/75">Uptime trail could not be loaded.</p>
                    <button
                      type="button"
                      onClick={() => void uptimeQuery.refetch()}
                      className="rounded-lg border border-rose-300/20 bg-rose-400/10 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-400/15"
                    >
                      Retry
                    </button>
                  </div>
                ) : uptimeQuery.isLoading ? (
                  [1, 2, 3].map((item) => <Skeleton key={item} className="h-9 rounded-lg bg-violet-200/[0.04]" />)
                ) : (uptimeQuery.data?.length ?? 0) === 0 ? (
                  <p className="rounded-lg border border-dashed border-violet-200/10 px-3 py-3 text-center text-xs text-foreground/50">
                    No uptime data yet — heartbeats build the 7-day trail automatically.
                  </p>
                ) : (
                  uptimeQuery.data?.map((report) => {
                    const pct = Math.round(report.onlinePct);
                    const badgeCls =
                      pct >= 95
                        ? "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200"
                        : pct >= 80
                          ? "border-amber-300/20 bg-amber-300/[0.08] text-amber-200"
                          : "border-rose-300/20 bg-rose-300/[0.08] text-rose-200";
                    return (
                      <div
                        key={report.deviceId}
                        className="flex items-center gap-3 rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/85" title={report.deviceName}>
                          {report.deviceName}
                        </span>
                        <div className="flex h-7 flex-1 items-end gap-1 sm:flex-none sm:w-56" aria-hidden="true">
                          {report.days.map((day) => (
                            <div
                              key={day.day}
                              title={`${day.day}: ${Math.round(day.onlineSeconds / 3600)}h online · ${day.heartbeats} heartbeats`}
                              className={`w-2.5 flex-1 rounded-sm ${
                                day.onlineSeconds > 0 ? "bg-emerald-400/75" : "bg-slate-600/60"
                              }`}
                              style={{ height: `${Math.max(2, Math.round((day.onlineSeconds / 86400) * 28))}px` }}
                            />
                          ))}
                        </div>
                        <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold tabular-nums ${badgeCls}`}>
                          {pct}%
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        <PairDialog
          open={pairOpen}
          onOpenChange={setPairOpen}
          gates={gatesQuery.data ?? []}
          repairTarget={repairTarget}
          suggestedName={suggestedName}
        />
      </article>
    </TooltipProvider>
  );
}
