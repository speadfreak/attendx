/**
 * Phase 7 — tiny WebAudio feedback for the kiosk (no assets needed).
 * AttendancePage/QrTerminalPage use the same oscillator-stub pattern.
 */

export function playTone(kind: "success" | "duplicate" | "error" | "ping"): void {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    const t = ctx.currentTime;
    switch (kind) {
      case "success":
        o.type = "sine";
        o.frequency.setValueAtTime(880, t);
        o.frequency.exponentialRampToValueAtTime(1320, t + 0.15);
        g.gain.setValueAtTime(0.25, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        o.start(t);
        o.stop(t + 0.5);
        break;
      case "duplicate":
        o.type = "triangle";
        o.frequency.setValueAtTime(520, t);
        g.gain.setValueAtTime(0.18, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        o.start(t);
        o.stop(t + 0.35);
        break;
      case "error":
        o.type = "sawtooth";
        o.frequency.setValueAtTime(280, t);
        o.frequency.exponentialRampToValueAtTime(90, t + 0.4);
        g.gain.setValueAtTime(0.22, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        o.start(t);
        o.stop(t + 0.5);
        break;
      case "ping":
        o.type = "sine";
        o.frequency.setValueAtTime(660, t);
        o.frequency.exponentialRampToValueAtTime(990, t + 0.08);
        g.gain.setValueAtTime(0.12, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        o.start(t);
        o.stop(t + 0.25);
        break;
    }
    window.setTimeout(() => void ctx.close().catch(() => {}), 800);
  } catch {
    /* audio unavailable / blocked — silent */
  }
}
