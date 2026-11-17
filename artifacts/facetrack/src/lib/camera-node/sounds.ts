/**
 * Phase 7 kiosk feedback — now a thin delegate to the loud shared engine
 * (src/lib/audio/feedback.ts) so the phone gate gets the same compressed,
 * punchy cues as the web console instead of the old whisper-quiet oscillator.
 */

import { playDuplicate, playMarked, playPing, playUnknown } from "@/lib/audio/feedback";

export function playTone(kind: "success" | "duplicate" | "error" | "ping"): void {
  switch (kind) {
    case "success":
      playMarked();
      break;
    case "duplicate":
      playDuplicate();
      break;
    case "error":
      playUnknown();
      break;
    case "ping":
      playPing();
      break;
  }
}
