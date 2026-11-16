#!/usr/bin/env node
/**
 * AttendX Phase 7 — icon rasterizer.
 *
 * Takes the hand-drawn `public/favicon.svg` (512 viewBox, maskable-safe
 * geometry) and rasterizes the full PNG icon set the PWA manifest + iOS home
 * screen expect:
 *
 *   icons/icon-192.png            any purpose
 *   icons/icon-512.png            any purpose
 *   icons/icon-512-maskable.png   maskable purpose (full-bleed bg + art scaled
 *                                 into the W3C inner-80% safe zone)
 *   apple-touch-icon.png          180x180, full-bleed (iOS rounds it itself)
 *   favicon-32.png                32x32 PNG fallback for index.html
 *   favicon.png                   192x192 PNG fallback for index.html
 *
 * Run from artifacts/facetrack:   bun scripts/generate-icons.mjs
 * (Requires the @resvg/resvg-js devDependency — no browser, no ImageMagick.)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const svgPath = join(appRoot, "public", "favicon.svg");
const iconsDir = join(appRoot, "public", "icons");

const faviconSvg = readFileSync(svgPath, "utf8");

/** Render an SVG string to PNG bytes at a fixed pixel width. */
function renderPng(svgText, width) {
  const resvg = new Resvg(svgText, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

/**
 * Maskable variant: the W3C maskable safe zone is the inner 80% of the icon,
 * so the launcher may crop anything outside it. We square off the rounded
 * background (full-bleed) and scale the whole art group to 0.8 about the
 * center, which lands every critical mark inside the safe zone by design.
 */
function maskableVariant(svgText) {
  let out = svgText.replace('rx="112"', 'rx="0"');
  out = out.replace(
    'id="gx-art"',
    'id="gx-art" transform="translate(256 256) scale(0.8) translate(-256 -256)"',
  );
  if (out === svgText) {
    throw new Error("maskable variant: favicon.svg anchors (gx-bg / gx-art) not found");
  }
  return out;
}

/** [relative output path, pixel size, svg source] */
const TARGETS = [
  ["icons/icon-192.png", 192, faviconSvg],
  ["icons/icon-512.png", 512, faviconSvg],
  ["icons/icon-512-maskable.png", 512, maskableVariant(faviconSvg)],
  ["apple-touch-icon.png", 180, maskableVariant(faviconSvg)],
  ["favicon-32.png", 32, faviconSvg],
  ["favicon.png", 192, faviconSvg],
];

mkdirSync(iconsDir, { recursive: true });
for (const [relPath, size, source] of TARGETS) {
  const outPath = join(appRoot, "public", relPath);
  writeFileSync(outPath, renderPng(source, size));
  console.log(`wrote ${relPath} (${size}x${size})`);
}
console.log("icon set generated from public/favicon.svg");
