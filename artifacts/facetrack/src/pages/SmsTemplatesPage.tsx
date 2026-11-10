import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GlowCard, SectionTitle, MeshBackground, GlowEmpty } from "@/components/gx/Primitives";
import { GlowSkeleton } from "@/components/gx/Skeletons";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Save, Loader2, Variable, Eye } from "lucide-react";

/**
 * SMS TEMPLATE MANAGER — the present/late/absent messages were hardcoded.
 * They're now editable with variable placeholders and the absent template
 * is fully wired to the absent sweep + manual absent marks.
 */

interface Templates { present: string; late: string; absent: string }

const VARIABLES = ["{student_name}", "{time}", "{classroom}", "{status}", "{date}", "{school}"];

function renderPreview(tpl: string): string {
  return tpl
    .replace("{student_name}", "Abebe Girma")
    .replace("{time}", "8:42 AM")
    .replace("{classroom}", "Grade 4A")
    .replace("{status}", "present")
    .replace("{date}", new Date().toISOString().slice(0, 10))
    .replace("{school}", "AttendX");
}

export default function SmsTemplatesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [templates, setTemplates] = useState<Templates | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    api.smsTemplates().then(setTemplates).catch(() => {});
  }, []);

  const update = (key: keyof Templates, value: string) => {
    setTemplates((prev) => (prev ? { ...prev, [key]: value } : prev));
    setDirty(true);
  };

  const save = async () => {
    if (!templates) return;
    setSaving(true);
    try {
      await api.saveSmsTemplates(templates);
      toast({ title: "Templates saved", description: "New messages apply to every future SMS job." });
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative">
      <MeshBackground />
      <div className="relative z-10 space-y-5 max-w-4xl mx-auto">
        <div className="gx-page-header flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <SectionTitle className="gx-title-gradient" sub="PARENT NOTIFICATIONS · EDITABLE WITH VARIABLES">
            SMS TEMPLATES
          </SectionTitle>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="gx-btn-accent gx-gradient-pan gx-focus-ring inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-40 disabled:pointer-events-none"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save templates
          </button>
        </div>

        {/* variables palette */}
        <GlowCard variant="gradient" className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Variable size={13} className="text-cyan-400" />
            <span className="text-[10px] uppercase tracking-widest text-white/40">Variables — click to copy</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {VARIABLES.map((v) => (
              <button
                key={v}
                className="st-badge st-badge-cyan font-mono"
                onClick={() => {
                  navigator.clipboard?.writeText(v).catch(() => {});
                  toast({ title: "Copied", description: v });
                }}
              >
                {v}
              </button>
            ))}
          </div>
        </GlowCard>

        {!templates ? (
          <div className="space-y-3">
            {Array(3).fill(0).map((_, i) => <GlowSkeleton key={i} className="h-32" />)}
          </div>
        ) : (
          <div className="space-y-4">
            {([
              { key: "present", label: "PRESENT ARRIVAL", tone: "green", hint: "Auto-sent after every new present check-in (face, QR, gate camera or manual)." },
              { key: "late", label: "LATE ARRIVAL", tone: "amber", hint: "Auto-sent after every new late check-in." },
              { key: "absent", label: "ABSENT ALERT", tone: "red", hint: "Wired in: fires from the end-of-day absent sweep and manual absent marks." },
            ] as const).map((row) => (
              <GlowCard key={row.key} accent variant="gradient" className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <MessageSquare size={14} className={`st-${row.tone}`} />
                    <span className="text-xs font-semibold uppercase tracking-widest text-white/60">{row.label}</span>
                  </div>
                  <span className={`st-badge st-badge-${row.tone}`}>{row.hint ? "active" : "idle"}</span>
                </div>
                <textarea
                  value={templates[row.key]}
                  onChange={(e) => update(row.key, e.target.value)}
                  rows={2}
                  className="w-full bg-black/40 border border-purple-500/15 rounded-lg p-3 text-sm text-white/80 focus:outline-none focus:border-purple-500/45 font-mono"
                />
                <div className="flex items-start gap-2 mt-2 text-[11px] text-white/35">
                  <Eye size={12} className="mt-0.5 shrink-0 text-purple-400" />
                  <p>
                    <span className="text-white/50">Preview:</span> {renderPreview(templates[row.key])}
                  </p>
                </div>
              </GlowCard>
            ))}
          </div>
        )}

        <GlowCard variant="gradient" className="p-4">
          <p className="text-[11px] text-white/35 leading-relaxed">
            <strong className="text-white/60">How sending works:</strong> present, late & absent marks enqueue an SMS job; the worker
            renders your template (student name, time, classroom) and delivers via Twilio when configured — otherwise the
            message is recorded as a simulated delivery in SMS Logs. The end-of-day absent sweep marks every student
            without a record and notifies each parent with the absent template.
          </p>
        </GlowCard>
      </div>
    </div>
  );
}
