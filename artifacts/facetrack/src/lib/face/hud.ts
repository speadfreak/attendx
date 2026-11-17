/**
 * AttendX futuristic face-detection HUD renderer.
 *
 * One canvas painter shared by the Active Scan tiles (web) and the phone
 * camera-node kiosk. Handles the object-cover coordinate mismatch (video px →
 * displayed px), draws glowing corner-bracket boxes, landmark dots, animated
 * sweep lines, label plates and the big "NO FACE DETECTED" state.
 */

export interface HudBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HudFace {
  box: HudBox;
  score?: number;
}

export type HudTone = "violet" | "green" | "amber" | "red" | "cyan";

export interface HudLabel {
  box: HudBox;
  title: string;
  sub?: string;
  tone: HudTone;
}

export interface HudOptions {
  /** Native video frame size (source coordinates of boxes). */
  videoW: number;
  videoH: number;
  /** Mirrored view (front camera preview). */
  mirror?: boolean;
  faces: HudFace[];
  labels: HudLabel[];
  /** No faces in frame at all. */
  noFace: boolean;
  /** Face(s) present but server hasn't matched yet. */
  scanning: boolean;
  /** QR mode kiosk framing. */
  qrMode?: boolean;
  /** DOM text state line (also drawn on canvas). */
  statusText?: string;
  now: number;
}

const TONES: Record<HudTone, { rgb: string; dim: string }> = {
  violet: { rgb: "167, 139, 250", dim: "139, 92, 246" },
  green: { rgb: "52, 211, 153", dim: "16, 185, 129" },
  amber: { rgb: "251, 191, 36", dim: "245, 158, 11" },
  red: { rgb: "248, 113, 113", dim: "239, 68, 68" },
  cyan: { rgb: "103, 232, 249", dim: "34, 211, 238" },
};

/** object-cover math: how source video maps onto the displayed box. */
function coverTransform(videoW: number, videoH: number, dispW: number, dispH: number) {
  if (!videoW || !videoH) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.max(dispW / videoW, dispH / videoH);
  return {
    scale,
    offsetX: (dispW - videoW * scale) / 2,
    offsetY: (dispH - videoH * scale) / 2,
  };
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawBrackets(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tone: HudTone, now: number, pulse: boolean) {
  const { rgb } = TONES[tone];
  const c = Math.max(14, Math.min(w, h) * 0.18);
  const alpha = pulse ? 0.75 + 0.25 * Math.sin(now / 180) : 0.9;
  ctx.save();
  ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.shadowColor = `rgba(${rgb}, 0.9)`;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  // four corner brackets
  ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
  ctx.moveTo(x + w - c, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + c);
  ctx.moveTo(x + w, y + h - c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - c, y + h);
  ctx.moveTo(x + c, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - c);
  ctx.stroke();
  ctx.restore();
}

function drawLabelPlate(ctx: CanvasRenderingContext2D, x: number, y: number, title: string, sub: string | undefined, tone: HudTone) {
  const { rgb } = TONES[tone];
  ctx.save();
  ctx.font = "700 13px 'Inter', system-ui, sans-serif";
  const titleW = ctx.measureText(title).width;
  let subW = 0;
  if (sub) {
    ctx.font = "500 10px 'Inter', system-ui, sans-serif";
    subW = ctx.measureText(sub).width;
  }
  const plateW = Math.max(titleW, subW) + 18;
  const plateH = sub ? 34 : 24;
  const px = Math.min(Math.max(x, 4), ctx.canvas.width - plateW - 4);
  ctx.shadowColor = `rgba(${rgb}, 0.55)`;
  ctx.shadowBlur = 16;
  ctx.fillStyle = "rgba(4, 2, 10, 0.82)";
  roundRectPath(ctx, px, y, plateW, plateH, 8);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = `rgba(${rgb}, 0.95)`;
  ctx.fillRect(px, y, 3, plateH);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 13px 'Inter', system-ui, sans-serif";
  ctx.fillText(title, px + 10, y + (sub ? 14 : 17));
  if (sub) {
    ctx.fillStyle = `rgba(${rgb}, 0.85)`;
    ctx.font = "500 10px 'Inter', system-ui, sans-serif";
    ctx.fillText(sub, px + 10, y + 28);
  }
  ctx.restore();
}

function drawScanSweep(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tone: HudTone, now: number) {
  const { rgb } = TONES[tone];
  const t = (now % 1600) / 1600;
  const ly = y + h * t;
  const grad = ctx.createLinearGradient(x, ly - 24, x, ly + 6);
  grad.addColorStop(0, `rgba(${rgb}, 0)`);
  grad.addColorStop(1, `rgba(${rgb}, 0.35)`);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(x, ly - 24, w, 30);
  ctx.strokeStyle = `rgba(${rgb}, 0.8)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 2, ly);
  ctx.lineTo(x + w - 2, ly);
  ctx.stroke();
  ctx.restore();
}

function drawNoFaceState(ctx: CanvasRenderingContext2D, dispW: number, dispH: number, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 500);
  ctx.save();
  // center reticle
  const cx = dispW / 2;
  const cy = dispH / 2;
  const r = Math.min(dispW, dispH) * 0.16;
  ctx.strokeStyle = `rgba(255, 255, 255, ${0.22 + 0.16 * pulse})`;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  // rotating ticks
  const rot = (now % 4000) / 4000 * Math.PI * 2;
  for (let i = 0; i < 4; i++) {
    const a = rot + (i * Math.PI) / 2;
    ctx.strokeStyle = "rgba(167, 139, 250, 0.75)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 10, a, a + 0.5);
    ctx.stroke();
  }
  // crosshair
  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12);
  ctx.stroke();
  // big state text
  const fs = Math.max(15, Math.min(26, dispW * 0.05));
  ctx.font = `800 ${fs}px 'Inter', system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = `rgba(255, 255, 255, ${0.6 + 0.3 * pulse})`;
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 8;
  ctx.fillText("NO FACE DETECTED", cx, cy + r + fs + 22);
  ctx.font = `500 ${Math.max(10, fs * 0.52)}px 'Inter', system-ui, sans-serif`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
  ctx.fillText("STEP INTO FRAME · FACE THE CAMERA", cx, cy + r + fs + 22 + fs * 0.9);
  ctx.restore();
}

function drawQrFrame(ctx: CanvasRenderingContext2D, dispW: number, dispH: number, now: number) {
  const side = Math.min(dispW, dispH) * 0.62;
  const x = (dispW - side) / 2;
  const y = (dispH - side) / 2 - dispH * 0.04;
  const pulse = 0.6 + 0.4 * Math.sin(now / 350);
  ctx.save();
  ctx.strokeStyle = `rgba(52, 211, 153, ${0.55 + 0.3 * pulse})`;
  ctx.lineWidth = 3;
  ctx.shadowColor = "rgba(16, 185, 129, 0.8)";
  ctx.shadowBlur = 16;
  const c = side * 0.12;
  ctx.beginPath();
  ctx.moveTo(x, y + c); ctx.lineTo(x, y); ctx.lineTo(x + c, y);
  ctx.moveTo(x + side - c, y); ctx.lineTo(x + side, y); ctx.lineTo(x + side, y + c);
  ctx.moveTo(x + side, y + side - c); ctx.lineTo(x + side, y + side); ctx.lineTo(x + side - c, y + side);
  ctx.moveTo(x + c, y + side); ctx.lineTo(x, y + side); ctx.lineTo(x, y + side - c);
  ctx.stroke();
  // sweeping scan band
  const t = (now % 1800) / 1800;
  const ly = y + side * t;
  const grad = ctx.createLinearGradient(x, ly - 30, x, ly + 6);
  grad.addColorStop(0, "rgba(52, 211, 153, 0)");
  grad.addColorStop(1, "rgba(52, 211, 153, 0.3)");
  ctx.shadowBlur = 0;
  ctx.fillStyle = grad;
  ctx.fillRect(x + 4, ly - 30, side - 8, 36);
  // caption
  const fs = Math.max(13, Math.min(22, dispW * 0.045));
  ctx.font = `800 ${fs}px 'Inter', system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 8;
  ctx.fillText("SHOW YOUR QR ID", dispW / 2, y + side + fs + 18);
  ctx.font = `600 ${Math.max(11, fs * 0.62)}px 'Noto Sans Ethiopic', 'Inter', system-ui, sans-serif`;
  ctx.fillStyle = "rgba(52, 211, 153, 0.9)";
  ctx.fillText("የQR ካርድዎን ያሳዩ", dispW / 2, y + side + fs + 18 + fs * 0.95);
  ctx.restore();
}

/**
 * Paint a full HUD frame onto `canvas` (already positioned over the video).
 * Sizes the canvas to its displayed CSS box (DPR-aware) and maps boxes from
 * video coordinates through the object-cover transform.
 */
export function drawFaceHud(canvas: HTMLCanvasElement, opts: HudOptions): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const dispW = canvas.clientWidth;
  const dispH = canvas.clientHeight;
  if (!dispW || !dispH) return;
  if (canvas.width !== Math.round(dispW * dpr) || canvas.height !== Math.round(dispH * dpr)) {
    canvas.width = Math.round(dispW * dpr);
    canvas.height = Math.round(dispH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, dispW, dispH);

  if (opts.qrMode) {
    drawQrFrame(ctx, dispW, dispH, opts.now);
    return;
  }

  const { scale, offsetX, offsetY } = coverTransform(opts.videoW, opts.videoH, dispW, dispH);
  const map = (b: HudBox) => {
    const x = b.x * scale + offsetX;
    const y = b.y * scale + offsetY;
    const w = b.width * scale;
    const h = b.height * scale;
    return opts.mirror ? { x: dispW - x - w, y, w, h } : { x, y, w, h };
  };

  for (const label of opts.labels) {
    const m = map(label.box);
    drawBrackets(ctx, m.x, m.y, m.w, m.h, label.tone, opts.now, true);
    drawLabelPlate(ctx, m.x, m.y + m.h + 8, label.title, label.sub, label.tone);
  }

  const labeledBoxes = new Set(opts.labels.map((l) => `${l.box.x},${l.box.y},${l.box.width},${l.box.height}`));
  for (const face of opts.faces) {
    const key = `${face.box.x},${face.box.y},${face.box.width},${face.box.height}`;
    if (labeledBoxes.has(key)) continue;
    const m = map(face.box);
    const tone: HudTone = opts.scanning ? "violet" : "cyan";
    drawBrackets(ctx, m.x, m.y, m.w, m.h, tone, opts.now, false);
    drawScanSweep(ctx, m.x, m.y, m.w, m.h, tone, opts.now);
  }

  if (opts.noFace) {
    drawNoFaceState(ctx, dispW, dispH, opts.now);
  } else if (opts.scanning) {
    // subtle "SCANNING" chip top-center
    ctx.save();
    ctx.font = "700 12px 'Inter', system-ui, sans-serif";
    const text = "SCANNING FACE…";
    const tw = ctx.measureText(text).width + 20;
    ctx.fillStyle = "rgba(88, 28, 135, 0.75)";
    ctx.shadowColor = "rgba(139, 92, 246, 0.6)";
    ctx.shadowBlur = 12;
    roundRectPath(ctx, (dispW - tw) / 2, 12, tw, 26, 13);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(233, 213, 255, 0.95)";
    ctx.textAlign = "center";
    ctx.fillText(text, dispW / 2, 29);
    ctx.restore();
  }
}
