/**
 * AttendX loud feedback engine — WebAudio, no assets.
 *
 * Old feedback used a bare oscillator at gain 0.25 through no compression —
 * inaudible across a school gate. This engine:
 *   - keeps ONE AudioContext (browsers cap contexts per page),
 *   - resumes it on every play (autoplay-policy safe),
 *   - runs everything through a DynamicsCompressor + loud master gain so
 *     chimes punch through playground noise without clipping,
 *   - layers sub-thumps + arpeggios + shimmer for distinct, unmistakable cues,
 *   - provides bilingual (EN + አማርኛ) spoken announcements for QR gates.
 */

const MUTE_KEY = "atx_audio_muted";
const ANNOUNCE_KEY = "atx_announce_enabled";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let unlocked = false;

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* private mode */
  }
}

export function isAnnounceEnabled(): boolean {
  try {
    return localStorage.getItem(ANNOUNCE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAnnounceEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ANNOUNCE_KEY, enabled ? "1" : "0");
  } catch {
    /* private mode */
  }
}

function ensureContext(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 24;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;
      master = ctx.createGain();
      master.gain.value = 0.95;
      master.connect(comp);
      comp.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    unlocked = ctx.state === "running";
    return ctx;
  } catch {
    return null;
  }
}

/** Call once from any user gesture (Start camera button etc.) to pre-unlock audio. */
export function primeAudio(): void {
  const c = ensureContext();
  if (!c) return;
  // Silent 1-frame buffer unlocks iOS Safari's WebAudio.
  try {
    const buf = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* noop */
  }
}

interface ToneSpec {
  type: OscillatorType;
  /** Hz at note start. */
  freq: number;
  /** Hz at note end (glide). */
  glideTo?: number;
  /** Delay from cue start, seconds. */
  at: number;
  /** Note duration, seconds. */
  dur: number;
  /** Peak gain 0..1. */
  gain: number;
}

function schedule(c: AudioContext, tones: ToneSpec[]): void {
  if (!master) return;
  const out = master;
  for (const t of tones) {
    const start = c.currentTime + t.at;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = t.type;
    osc.frequency.setValueAtTime(t.freq, start);
    if (t.glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(t.glideTo, 1), start + t.dur);
    }
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(t.gain, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + t.dur);
    osc.connect(g);
    g.connect(out);
    osc.start(start);
    osc.stop(start + t.dur + 0.05);
  }
}

/** Deep sub-thump that gives the "marked" cue physical weight. */
function thump(c: AudioContext, at = 0, gain = 0.85): void {
  schedule(c, [{ type: "sine", freq: 170, glideTo: 55, at, dur: 0.22, gain }]);
}

/** ATTENDANCE MARKED — triumphant 4-note riser + sub + shimmer. LOUD by design. */
export function playMarked(): void {
  if (isMuted()) return;
  const c = ensureContext();
  if (!c) return;
  thump(c, 0);
  schedule(c, [
    { type: "triangle", freq: 523.25, at: 0.0, dur: 0.16, gain: 0.55 }, // C5
    { type: "triangle", freq: 659.25, at: 0.12, dur: 0.16, gain: 0.6 }, // E5
    { type: "triangle", freq: 783.99, at: 0.24, dur: 0.16, gain: 0.65 }, // G5
    { type: "triangle", freq: 1046.5, at: 0.36, dur: 0.42, gain: 0.8 }, // C6 hero note
    { type: "sine", freq: 2093.0, at: 0.38, dur: 0.4, gain: 0.3 }, // C7 shimmer
    { type: "sine", freq: 1568.0, at: 0.46, dur: 0.3, gain: 0.22 }, // G6 sparkle
  ]);
}

/** ALREADY MARKED — distinct "you're already in" double-boop, impossible to confuse with success. */
export function playDuplicate(): void {
  if (isMuted()) return;
  const c = ensureContext();
  if (!c) return;
  schedule(c, [
    { type: "square", freq: 392.0, at: 0.0, dur: 0.14, gain: 0.4 }, // G4
    { type: "square", freq: 392.0, at: 0.2, dur: 0.2, gain: 0.4 },
    { type: "sine", freq: 196.0, at: 0.0, dur: 0.4, gain: 0.25 }, // G3 body
  ]);
}

/** NOT RECOGNIZED / REJECTED — harsh descending buzz. */
export function playUnknown(): void {
  if (isMuted()) return;
  const c = ensureContext();
  if (!c) return;
  schedule(c, [
    { type: "sawtooth", freq: 320, glideTo: 110, at: 0.0, dur: 0.38, gain: 0.5 },
    { type: "square", freq: 160, glideTo: 80, at: 0.05, dur: 0.4, gain: 0.35 },
  ]);
}

/** UI blip (commands, toggles). */
export function playPing(): void {
  if (isMuted()) return;
  const c = ensureContext();
  if (!c) return;
  schedule(c, [{ type: "sine", freq: 660, glideTo: 990, at: 0, dur: 0.12, gain: 0.3 }]);
}

/** Rising 3-note attention chime played right before spoken announcements. */
export function playAttentionChime(): void {
  if (isMuted()) return;
  const c = ensureContext();
  if (!c) return;
  schedule(c, [
    { type: "triangle", freq: 587.33, at: 0.0, dur: 0.18, gain: 0.5 }, // D5
    { type: "triangle", freq: 739.99, at: 0.18, dur: 0.18, gain: 0.55 }, // F#5
    { type: "triangle", freq: 880.0, at: 0.36, dur: 0.3, gain: 0.65 }, // A5
  ]);
}

// ── spoken announcements (bilingual) ─────────────────────────────────

export const QR_ANNOUNCE_EN = "Attention please. Please scan your QR ID here for attendance.";
export const QR_ANNOUNCE_AM = "እባክዎን ለመገኘት የኢዲ ካርድዎን (QR) እዚህ ይቃኙ።";

function pickVoice(langs: string[]): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis.getVoices();
    for (const lang of langs) {
      const exact = voices.find((v) => v.lang.toLowerCase() === lang);
      if (exact) return exact;
      const base = voices.find((v) => v.lang.toLowerCase().startsWith(lang.split("-")[0]));
      if (base) return base;
    }
  } catch {
    /* noop */
  }
  return null;
}

function speak(text: string, lang: string, delayMs: number): void {
  window.setTimeout(() => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = 0.95;
      u.pitch = 1;
      u.volume = 1;
      const voice = pickVoice([lang]);
      if (voice) u.voice = voice;
      window.speechSynthesis.speak(u);
    } catch {
      /* speech unavailable */
    }
  }, delayMs);
}

/**
 * Full QR-gate announcement: attention chime, then English, then አማርኛ.
 * Safe to call without a gesture — SpeechSynthesis may be dropped by the
 * browser in that case, the chime still fires once audio is unlocked.
 */
export function announceQrGate(opts: { english?: boolean; amharic?: boolean } = {}): void {
  if (isMuted() || !isAnnounceEnabled()) return;
  const { english = true, amharic = true } = opts;
  playAttentionChime();
  if (english) speak(QR_ANNOUNCE_EN, "en-US", 900);
  if (amharic) speak(QR_ANNOUNCE_AM, "am-ET", 900 + (english ? 3600 : 0));
}

/** Warm the voice list (some browsers only after getVoices() has warmed). */
export function primeVoices(): void {
  try {
    window.speechSynthesis?.getVoices();
  } catch {
    /* noop */
  }
}

export function unlockedAudio(): boolean {
  ensureContext();
  return unlocked;
}
