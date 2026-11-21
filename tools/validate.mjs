// 用 2026-11-20 的两个市场快照复算各小类，与原站最后一列对比
import fs from "node:fs";
import { parseChunk, parseIndexTaxonomy } from "./parse-chunks.mjs";

const sse = JSON.parse(fs.readFileSync("/tmp/probe/sse_2026-11-20.json", "utf8"));
const sseMap = new Map();
for (const r of sse) sseMap.set(r.SEC_CODE.trim(), parseFloat(String(r.TOT_VOL).replace(/,/g,""))); // 万份
const szse = JSON.parse(fs.readFileSync("tools/_probe_szse.json", "utf8"));
const szseMap = new Map(szse.map((r) => [r.code, r.gm])); // 万份

const tax = parseIndexTaxonomy("tools/original-index.html");
const site = {};
for (const f of fs.readdirSync("site/charts")) {
  const D = parseChunk("site/charts/" + f);
  const cid = Object.keys(D)[0];
  for (const s of D[cid].c1.series) site[s.name] = s.values.at(-1);
}

let bad = 0, ok = 0; const rows = [];
for (const [sub, list] of Object.entries(tax)) {
  const codes = list.map((s) => s.slice(0, 6));
  let sh = 0, sz = 0, miss = 0;
  for (const c of codes) {
    if (sseMap.has(c)) sh += sseMap.get(c);
    else if (szseMap.has(c)) sz += szseMap.get(c);
    else miss++;
  }
  const calc = Math.round((sh + sz) / 1e4 * 10) / 10;
  const orig = site[sub];
  const diff = orig == null ? NaN : calc - orig;
  const rel = orig ? Math.abs(diff) / orig : 1;
  rows.push({ sub, codes: codes.length, miss, calc, orig, diff: +diff.toFixed(1), rel: +(rel * 100).toFixed(2) });
  if (Math.abs(diff) > Math.max(0.2, orig * 0.005)) bad++; else ok++;
}
rows.sort((a, b) => b.rel - a.rel);
console.log("小类数:", rows.length, "| 吻合:", ok, "| 偏差:", bad);
console.log("偏差最大的 8 个:");
for (const r of rows.slice(0, 8)) console.log(`  ${r.sub.padEnd(10)} 标的${r.codes} 缺${r.miss} 计算${r.calc} 原站${r.orig} 差${r.diff} (${r.rel}%)`);
const total = rows.reduce((a, r) => a + r.calc, 0), ototal = rows.reduce((a, r) => a + (r.orig || 0), 0);
console.log("全口径合计: 计算", total.toFixed(1), "原站", ototal.toFixed(1), "差", (total - ototal).toFixed(1));
