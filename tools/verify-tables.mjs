// 用播种后的序列复算首页三张表，与原站 HTML 对比
import fs from "node:fs";
import { loadSeries } from "../lib/store.mjs";
import { recentWindow, windowChanges, catScale } from "../lib/aggregate.mjs";

const store = loadSeries();
const win = recentWindow(store.dates, 7);
console.log("窗口:", store.dates[win[0]], "→", store.dates.at(-1), `(${win.length} 个交易日)`);

const html = fs.readFileSync("tools/original-index.html", "utf8");
const tbl = html.match(/<div class="tbl-grid">([\s\S]*?)<\/div>\s*<div class="tabs"/)?.[1] ?? "";
const sections = [...tbl.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map((m) => m[1]);

const parseRows = (s) => [...s.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) =>
  [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/&amp;/g, "&").trim())
);

const [origCat, origUp, origDown] = sections.map(parseRows);

// 1) 大类表
const mineCat = catScale(store, win);
console.log("\n大类表  计算 vs 原站");
let bad = 0;
mineCat.forEach((r, i) => {
  const o = origCat[i];
  const okr = o && o[0] === r.label && o[1] === r.now.toFixed(1) && o[2] === r.start.toFixed(1) && (r.pct >= 0 ? "+" : "") + r.pct.toFixed(2) + "%" === o[3];
  if (!okr) bad++;
  console.log(` ${okr ? "OK " : "XX "} ${r.label.padEnd(12)} ${r.now.toFixed(1).padStart(9)} ${o ? o[1].padStart(9) : "-"} | ${r.start.toFixed(1).padStart(9)} ${o ? o[2].padStart(9) : "-"} | ${(((r.pct >= 0 ? "+" : "") + r.pct.toFixed(2) + "%")).padStart(8)} ${o ? o[3].padStart(8) : "-"}`);
});
console.log("大类表偏差行:", bad);

// 2) TOP5
const rows = windowChanges(store, win);
const up = [...rows].sort((a, b) => b.delta - a.delta).slice(0, 5);
const down = [...rows].sort((a, b) => a.delta - b.delta).slice(0, 5);
const fmt = (n, d) => (n >= 0 ? "+" : "") + n.toFixed(d);
console.log("\nTOP5 增加  计算 vs 原站");
up.forEach((r, i) => { const o = origUp[i]; const ok = o && o[0] === r.sub && fmt(r.delta,1) === o[1] && fmt(r.pct,2)+"%" === o[2];
  console.log(` ${ok?"OK ":"XX "} ${r.sub.padEnd(10)} ${fmt(r.delta,1).padStart(8)} ${o?o[1].padStart(8):"-"} | ${(fmt(r.pct,2)+"%").padStart(8)} ${o?o[2].padStart(8):"-"}`); });
console.log("\nTOP5 减少  计算 vs 原站");
down.forEach((r, i) => { const o = origDown[i]; const ok = o && o[0] === r.sub && fmt(r.delta,1) === o[1] && fmt(r.pct,2)+"%" === o[2];
  console.log(` ${ok?"OK ":"XX "} ${r.sub.padEnd(10)} ${fmt(r.delta,1).padStart(8)} ${o?o[1].padStart(8):"-"} | ${(fmt(r.pct,2)+"%").padStart(8)} ${o?o[2].padStart(8):"-"}`); });
