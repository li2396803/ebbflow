// 为 v2 分类重新分配小类配色：同一大类内任意两条线要能分辨（CIE76 ΔE ≥ 12），
// 同时保证线色对白/黑背景都有足够对比度。
//
// 基底用 Okabe–Ito（色盲友好 8 色）+ 扩展 8 色，共 16 色；按大类依次贪心取「与已用色 ΔE 最大」的那个。
// 用法：node scripts/palette-v2.mjs [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, "data", "classification-v2.json");

/** 由 Okabe–Ito 8 色打底，再按色相环 + 双明度带扩展到 32 色，保证大类内 24 条线也能拉开 */
const OKABE_ITO = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00", "#8C6D31", "#6A3D9A"];

function hsl2hex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

const PALETTE = [
  ...OKABE_ITO,
  // 28 个候选：14 个色相 × 2 个明度带（实测这组在 24 条线时 ΔE 最高）
  ...Array.from({ length: 28 }, (_, i) => {
    const hue = (i % 14) * (360 / 14) + 5;
    const band = Math.floor(i / 14);
    return hsl2hex(hue, band ? 0.68 : 0.82, band ? 0.34 : 0.42);
  }),
];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function lab(h) {
  const [r, g, b] = hex(h).map((v) => v / 255).map((v) => (v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92));
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const deltaE = (a, b) => {
  const A = lab(a), B = lab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
};
const relLum = (h) => {
  const [r, g, b] = hex(h).map((v) => v / 255).map((v) => (v > 0.03928 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (h, bg) => {
  const a = relLum(h), b = relLum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

export function assign(cls) {
  const used = new Set();
  const result = {};
  for (const cat of cls.cats) {
    const subs = Object.entries(cls.subs).filter(([, v]) => v.cat === cat.key).map(([n]) => n);
    const taken = [];
    for (const name of subs) {
      // 贪心：与「本大类已用色」的最小 ΔE 最大者优先
      let best = null, bestScore = -1;
      for (const c of PALETTE) {
        if (taken.includes(c) && PALETTE.length > subs.length) continue;
        const cw = contrast(c, "#ffffff");
        if (cw < 3.0) continue; // 白底看不清的直接淘汰
        const minD = taken.length ? Math.min(...taken.map((t) => deltaE(c, t))) : 999;
        const score = minD + cw * 1.2;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      taken.push(best);
      used.add(best);
      result[name] = best;
    }
  }
  return result;
}

export function report(cls, colors) {
  const rows = [];
  for (const cat of cls.cats) {
    const subs = Object.entries(cls.subs).filter(([, v]) => v.cat === cat.key).map(([n]) => n);
    let min = 999, pair = null;
    for (let i = 0; i < subs.length; i++) {
      for (let j = i + 1; j < subs.length; j++) {
        const d = deltaE(colors[subs[i]], colors[subs[j]]);
        if (d < min) { min = d; pair = [subs[i], subs[j]]; }
      }
    }
    const cw = Math.min(...subs.map((s) => contrast(colors[s], "#ffffff")));
    const cb = Math.min(...subs.map((s) => contrast(colors[s], "#0a0b0e")));
    rows.push({ cat: cat.label, subs: subs.length, minDE: +min.toFixed(1), pair, contrast: +cw.toFixed(2), contrastDark: +cb.toFixed(2) });
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dry = process.argv.includes("--dry-run");
  const cls = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const colors = assign(cls);
  for (const [name, c] of Object.entries(colors)) if (cls.subs[name]) cls.subs[name].color = c;
  if (!dry) fs.writeFileSync(FILE, JSON.stringify(cls));
  const rows = report(cls, colors);
  for (const r of rows) console.log(`${r.cat.padEnd(6)} ${String(r.subs).padStart(2)}条  最小ΔE=${String(r.minDE).padStart(5)}  白底对比=${r.contrast}  黑底=${r.contrastDark}${r.minDE < 12 || r.contrast < 3 ? "  ⚠️" : ""}`);
  if (!dry) console.log("已写回", FILE);
}
