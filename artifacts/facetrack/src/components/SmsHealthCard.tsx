import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, ShieldCheck, ShieldAlert, Activity, Send, RefreshCw,
  CheckCircle2, XCircle, Zap, Radio, CircleDollarSign, Globe, ChevronDown, ChevronUp,
} from "lucide-react";
import { GlowCard, StatusBadge } from "@/components/gx/Primitives";
import { api, type SmsDiagnostics, type SmsTestSendResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

/**
 * SMS DELIVERY HEALTH — live Twilio diagnostics, sender configuration and
 * test-send, built around the real production failure modes (20003 bad auth,
 * 21612 international To/From, 63016 WhatsApp templates …). Every error is
 * shown with an actionable FIX line.
 */

const inputCls = "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/85 placeholder:text-white/25 focus:border-purple-500/50 focus:outline-none";
const labelCls = "text-[10px] font-semibold uppercase tracking-widest text-white/40";
const smallBtn = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs font-medium text-white/75 transition-colors hover:bg-white/[0.09] disabled:opacity-40";
const primaryBtn = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-purple-600 px-3.5 text-xs font-semibold text-white transition-colors hover:bg-purple-500 disabled:opacity-40";

const SEVERITY_STYLE = {
  critical: { icon: XCircle, cls: "border-red-400/20 bg-red-400/[0.06]", iconCls: "text-red-400" },
  warning: { icon: ShieldAlert, cls: "border-amber-400/20 bg-amber-400/[0.05]", iconCls: "text-amber-300" },
  info: { icon: ShieldCheck, cls: "border-emerald-400/15 bg-emerald-400/[0.04]", iconCls: "text-emerald-400" },
} as const;

function RecommendationList({ diagnostics }: { diagnostics: SmsDiagnostics }) {
  return (
    <div className="space-y-2">
      {diagnostics.recommendations.map((rec, i) => {
        const style = SEVERITY_STYLE[rec.severity];
        const Icon = style.icon;
        return (
          <div key={i} className={`flex items-start gap-2.5 rounded-xl border p-3 ${style.cls}`}>
            <Icon size={15} className={`mt-0.5 shrink-0 ${style.iconCls}`} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-white/85">{rec.title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-white/55">{rec.detail}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SmsHealthCard({ chrome = "glow" }: { chrome?: "glow" | "panel" }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({ queryKey: ["system-settings"], queryFn: () => api.systemSettings() });

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [channelMode, setChannelMode] = useState<"sms" | "whatsapp" | "auto">("auto");
  const [serviceSid, setServiceSid] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [defaultCountry, setDefaultCountry] = useState("+251");
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the form once settings arrive
  if (settings && !hydrated) {
    setChannelMode(settings.smsChannelMode ?? "auto");
    setServiceSid(settings.smsMessagingServiceSid ?? "");
    setFromNumber(settings.smsFromNumber ?? "");
    setDefaultCountry(settings.smsDefaultCountry ?? "+251");
    setHydrated(true);
  }

  const [saving, setSaving] = useState(false);
  const saveSettings = async () => {
    setSaving(true);
    try {
      await api.updateSystemSettings({
        smsChannelMode: channelMode,
        smsMessagingServiceSid: serviceSid.trim(),
        smsFromNumber: fromNumber.trim(),
        smsDefaultCountry: defaultCountry.trim() || "+251",
      });
      toast({ title: "SMS sender config saved", description: "New sends use it immediately." });
      await queryClient.invalidateQueries({ queryKey: ["sms-config"] });
      await queryClient.invalidateQueries({ queryKey: ["sms-diagnostics"] });
    } catch (err: unknown) {
      toast({ title: "Save failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const { data: diagnostics, isFetching: diagFetching, error: diagError, refetch: refetchDiagnostics } = useQuery({
    queryKey: ["sms-diagnostics"],
    queryFn: () => api.smsDiagnostics(),
    enabled: showAdvanced,
    staleTime: 60_000,
  });

  // Phase 6: pending-delivery truth — cheap local stats (GET /sms-logs/health),
  // refreshed alongside the one-minute reconcile sweep. Hidden entirely on
  // fetch failure so the card never lies about data it couldn't load.
  const { data: health } = useQuery({
    queryKey: ["sms-health"],
    queryFn: () => api.smsHealth(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const pendingDelivery = health?.pendingDelivery ?? 0;

  const [testTo, setTestTo] = useState("");
  const [testBody, setTestBody] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SmsTestSendResult | null>(null);
  const runTestSend = async () => {
    if (!testTo.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.smsTestSend(testTo.trim(), testBody.trim() || undefined);
      setTestResult(result);
      if (result.ok) {
        toast({ title: "Test notification accepted ✅", description: `Queued via ${result.sender.via === "messaging-service" ? "Messaging Service" : "From number"} to ${result.normalizedTo}.` });
      }
    } catch (err: unknown) {
      // HTTP-level failure (auth/permissions) — surface inline too
      setTestResult({
        ok: false,
        normalizedTo: testTo.trim(),
        sender: { via: "from-number", messagingServiceSid: null, fromNumber: null },
        attempts: [],
        error: { message: err instanceof Error ? err.message : String(err), code: null, fix: "Check your role (admin required) and that the API is reachable." },
      });
    } finally {
      setTesting(false);
    }
  };

  const rootCls = chrome === "panel"
    ? "rounded-2xl border border-violet-200/10 bg-[#191323] shadow-[0_14px_40px_rgba(18,8,30,0.18)] p-5 sm:p-6"
    : "";

  return chrome === "panel" ? (
    <article className={rootCls}>{smsHealthInner()}</article>
  ) : (
    <GlowCard className="p-5">{smsHealthInner()}</GlowCard>
  );

  function smsHealthInner() {
    return (
    <>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare size={14} className="text-amber-300 shrink-0" />
          <h3 className="text-sm font-semibold uppercase tracking-widest gx-gradient-text">SMS DELIVERY HEALTH</h3>
        </div>
        <StatusBadge
          value={settings?.smsMessagingServiceSid ? "valid" : "pending"}
          label={settings?.smsMessagingServiceSid ? "SERVICE ROUTING" : settings?.smsFromNumber ? "RAW FROM" : "UNCONFIGURED"}
          tone={settings?.smsMessagingServiceSid ? "green" : settings?.smsFromNumber ? "amber" : "red"}
        />
      </div>

      {/* Pending delivery — honest queue truth (hidden if stats can't be fetched) */}
      {health && (
        <div className={`mb-4 flex items-center justify-between gap-3 rounded-xl border p-3 ${pendingDelivery > 0 ? "border-amber-400/25 bg-amber-400/[0.06]" : "border-white/5 bg-black/20"}`}>
          <div className="min-w-0">
            <p className={labelCls}>pending delivery</p>
            <p className="mt-1 text-[11px] leading-snug text-white/45">Awaiting carrier confirmation — auto-reconciles every minute</p>
          </div>
          {pendingDelivery > 0 ? (
            <span className="flex shrink-0 items-center gap-2" aria-label={`${pendingDelivery} messages awaiting carrier confirmation`}>
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60 animate-ping" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
              </span>
              <span className="text-2xl font-bold tabular-nums text-amber-300 animate-pulse">{pendingDelivery}</span>
            </span>
          ) : (
            <span className="text-2xl font-bold tabular-nums text-white/35">0</span>
          )}
        </div>
      )}

      {/* Sender config — the 21612 fix lives here */}
      <div className="rounded-xl border border-white/5 bg-black/20 p-4">
        <p className={labelCls}>sender configuration</p>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="min-w-0">
            <label className="mb-1 block text-[11px] text-white/50" htmlFor="sms-channel-mode">Channel strategy</label>
            <select
              id="sms-channel-mode"
              value={channelMode}
              onChange={(e) => setChannelMode(e.target.value as "sms" | "whatsapp" | "auto")}
              className={inputCls}
            >
              <option value="auto">auto — SMS first, WhatsApp fallback (recommended)</option>
              <option value="sms">sms only</option>
              <option value="whatsapp">whatsapp only</option>
            </select>
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-[11px] text-white/50" htmlFor="sms-service-sid">Messaging Service SID (fixes 21612)</label>
            <input
              id="sms-service-sid"
              value={serviceSid}
              onChange={(e) => setServiceSid(e.target.value)}
              placeholder="MG… (paste from diagnostics below)"
              className={`${inputCls} font-mono break-all`}
            />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-[11px] text-white/50" htmlFor="sms-from-number">From number (fallback)</label>
            <input
              id="sms-from-number"
              value={fromNumber}
              onChange={(e) => setFromNumber(e.target.value)}
              placeholder="+18312826811"
              className={`${inputCls} font-mono`}
            />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-[11px] text-white/50" htmlFor="sms-default-country">Default country for local numbers</label>
            <input
              id="sms-default-country"
              value={defaultCountry}
              onChange={(e) => setDefaultCountry(e.target.value)}
              placeholder="+251"
              className={`${inputCls} font-mono`}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={primaryBtn} onClick={() => void saveSettings()} disabled={saving}>
            {saving ? <RefreshCw size={13} className="animate-spin" /> : <ShieldCheck size={13} />} save sender config
          </button>
          <p className="text-[10px] leading-snug text-white/35 min-w-0 flex-1">
            Messaging Service routing is what makes <span className="text-amber-300/80">Ethiopia (+251)</span> deliverable —
            US long codes direct-dialing ET get Twilio <span className="font-mono">21612</span>.
          </p>
        </div>
      </div>

      {/* Test send */}
      <div className="mt-4 rounded-xl border border-white/5 bg-black/20 p-4">
        <p className={labelCls}>live test send</p>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="min-w-0">
            <label className="mb-1 block text-[11px] text-white/50" htmlFor="sms-test-to">To (parent number)</label>
            <input
              id="sms-test-to"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="0912345678 or +251912345678"
              className={inputCls}
            />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-[11px] text-white/50" htmlFor="sms-test-body">Message (optional)</label>
            <input
              id="sms-test-body"
              value={testBody}
              onChange={(e) => setTestBody(e.target.value)}
              placeholder="AttendX test notification…"
              maxLength={320}
              className={inputCls}
            />
          </div>
        </div>
        <button type="button" className={`${primaryBtn} mt-3`} onClick={() => void runTestSend()} disabled={testing || !testTo.trim()}>
          {testing ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />} send test
        </button>

        {testResult && (
          <div className={`mt-3 rounded-xl border p-3 text-[11px] leading-relaxed ${testResult.ok ? "border-emerald-400/20 bg-emerald-400/[0.05]" : "border-red-400/20 bg-red-400/[0.05]"}`}>
            <div className="flex items-center gap-2">
              {testResult.ok ? <CheckCircle2 size={14} className="shrink-0 text-emerald-400" /> : <XCircle size={14} className="shrink-0 text-red-400" />}
              <p className={`font-semibold ${testResult.ok ? "text-emerald-300" : "text-red-300"}`}>
                {testResult.ok ? "Accepted by Twilio — delivery in progress" : "Delivery failed"}
              </p>
            </div>
            <p className="mt-1 text-white/45 font-mono break-all">to: {testResult.normalizedTo} · sender: {testResult.sender.via}{testResult.sender.messagingServiceSid ? ` (${testResult.sender.messagingServiceSid.slice(0, 10)}…)` : ""}</p>
            {testResult.attempts.map((a, i) => (
              <p key={i} className="mt-1 text-white/55">
                channel <span className="font-mono text-white/70">{a.channel}</span>: {a.ok ? "✅ accepted" : `❌ ${a.error?.message ?? "failed"}`}
              </p>
            ))}
            {testResult.error?.fix && (
              <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] p-2 text-amber-200/85">
                <span className="font-semibold">FIX:</span> {testResult.error.fix}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Advanced diagnostics */}
      <button
        type="button"
        className="mt-4 flex w-full items-center justify-between gap-2 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-2.5 text-xs font-semibold text-white/60 transition-colors hover:bg-white/[0.05]"
        onClick={() => setShowAdvanced((v) => !v)}
        aria-expanded={showAdvanced}
      >
        <span className="inline-flex items-center gap-2"><Activity size={13} className="text-cyan-300" /> LIVE TWILIO DIAGNOSTICS {diagnostics?.twilio.balance != null ? `· balance $${diagnostics.twilio.balance}` : ""}</span>
        {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {showAdvanced && (
        <div className="mt-3 space-y-3">
          {diagFetching && !diagnostics ? (
            <div className="h-20 animate-pulse rounded-xl bg-white/[0.04]" />
          ) : diagError || !diagnostics ? (
            <div className="rounded-xl border border-red-400/20 bg-red-400/[0.05] p-3 text-[11px] text-red-200/80">
              Diagnostics failed: {diagError instanceof Error ? diagError.message : "unknown error"} (admin role required)
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 text-[10px]">
                <span className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-white/60">
                  <Radio size={11} className="text-emerald-400" /> account: {diagnostics.twilio.accountStatus ?? "?"}
                </span>
                <span className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-white/60">
                  <CircleDollarSign size={11} className="text-amber-300" /> balance: {diagnostics.twilio.balance ?? "?"} {diagnostics.twilio.currency ?? ""}
                </span>
                <span className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-white/60">
                  <Globe size={11} className="text-cyan-300" /> numbers: {diagnostics.numbers.length} · services: {diagnostics.messagingServices.length}
                </span>
              </div>

              <RecommendationList diagnostics={diagnostics} />

              {diagnostics.messagingServices.length > 0 && (
                <div className="rounded-xl border border-white/5 bg-black/20 p-3">
                  <p className={labelCls}>your messaging services — click “use” to apply</p>
                  <div className="mt-2 space-y-2">
                    {diagnostics.messagingServices.map((svc) => (
                      <div key={svc.sid} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-white/80">{svc.friendlyName}</p>
                          <p className="truncate font-mono text-[10px] text-white/35" title={svc.sid}>{svc.sid} · {svc.poolSize} number(s) in pool{svc.usecase ? ` · ${svc.usecase}` : ""}</p>
                        </div>
                        <button
                          type="button"
                          className={smallBtn}
                          onClick={() => { setServiceSid(svc.sid); toast({ title: "SID filled in", description: "Press “save sender config” to apply." }); }}
                        >
                          <Zap size={12} className="text-amber-300" /> use
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {diagnostics.destinations.length > 0 && (
                <div className="rounded-xl border border-white/5 bg-black/20 p-3">
                  <p className={labelCls}>parent destination reachability (live pricing)</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {diagnostics.destinations.map((d) => (
                      <span
                        key={d.prefix}
                        title={`${d.parents} parent number(s) · ${d.reachable ? `~$${d.pricePerSms ?? "?"}/SMS` : "no outbound pricing — likely unreachable"}`}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] ${
                          d.reachable ? "border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-200/80" : "border-red-400/25 bg-red-400/[0.06] text-red-200/85"
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${d.reachable ? "bg-emerald-400" : "bg-red-400"}`} />
                        {d.country} {d.prefix} · {d.parents} parent{d.parents === 1 ? "" : "s"}{d.reachable && d.pricePerSms ? ` · $${d.pricePerSms}/SMS` : ""}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <button type="button" className={smallBtn} onClick={() => void refetchDiagnostics()} disabled={diagFetching}>
                <RefreshCw size={12} className={diagFetching ? "animate-spin" : ""} /> re-run diagnostics
              </button>
            </>
          )}
        </div>
      )}
    </>
    );
  }
}

