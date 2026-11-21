// 口径独立复算：直接用 data/shares/<date>.json 的原始份额（万份）重算「小类 = 其 ETF 份额之和」
// 与两份产物（原站副本 c1 / 复刻版 c1）对照，验证口径与数值来源。
import fs from "node:fs";
import path from "node:path";
import { SUB, BOND_CAT } from "../lib/taxonomy.mjs";
import { parseChunk } from "../tools/parse-chunks.mjs";

const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const SHARES = "data/shares";
const dates = fs
  .readdirSync(SHARES)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.slice(0, 10))
  .sort();

function loadCharts(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const D = parseChunk(path.join(dir, f));
    const k = Object.keys(D)[0];
    out[k] = D[k];
  }
  return out;
}
const O = loadCharts("tools/original-charts");
const R = loadCharts("site/charts");

/** 用某日原始份额复算某小类（亿份，1 位小数） */
function recompute(subName, shares) {
  const meta = SUB[subName];
  const factor = meta.cat === BOND_CAT ? 100 : 1;
  let sum = 0;
  let hit = 0;
  const missing = [];
  for (const e of meta.etfs) {
    const v = shares[e.code];
    if (v == null) missing.push(e.code);
    else {
      sum += v;
      hit++;
    }
  }
  return { value: hit ? r1((sum / 1e4) * factor) : null, hit, total: meta.etfs.length, missing };
}

function chartValue(charts, catKey, subName, date) {
  const c = charts[catKey]?.c1;
  if (!c) return null;
  const i = c.dates.indexOf(date);
  if (i < 0) return null;
  const s = c.series.find((x) => x.name === subName);
  return s ? s.values[i] : null;
}

const FOCUS = ["A股大盘", "半导体芯片", "可转债与可交换债"];
const catOf = (sub) => SUB[sub].cat;

console.log("=".repeat(80));
console.log("口径复算：小类 = 该小类全部 ETF 当日份额之和（万份 ÷ 1e4 = 亿份；9.债券 ×100）");
console.log("原始快照日:", dates.join(" "));
console.log("=".repeat(80));

let bad = 0;
let checked = 0;
for (const sub of FOCUS) {
  const cat = catOf(sub);
  console.log(`\n【${sub}】 大类 ${cat}，ETF ${SUB[sub].etfs.length} 只`);
  console.log("  日期        复算(亿份)  原站c1   复刻c1   ETF命中");
  for (const d of dates) {
    const day = JSON.parse(fs.readFileSync(path.join(SHARES, d + ".json"), "utf8"));
    const shares = { ...(day.sse || {}), ...(day.szse || {}) };
    const got = recompute(sub, shares);
    const o = chartValue(O, cat, sub, d);
    const r = chartValue(R, cat, sub, d);
    checked++;
    const ok = got.value != null && Math.abs(got.value - (o ?? NaN)) < 1e-9 && Math.abs(got.value - (r ?? NaN)) < 1e-9;
    if (!ok) bad++;
    console.log(
      `  ${d}  ${String(got.value).padStart(9)}  ${String(o).padStart(8)} ${String(r).padStart(8)}   ${got.hit}/${got.total}` +
        (ok ? "" : `   <== 不一致`)
    );
  }
}
console.log(`\n抽查合计 ${checked} 个点，不一致 ${bad} 个`);

// 2026-11-20：两市场齐全，复算全部 86 个小类并与两份产物对照
const FULL = "2026-11-20";
const day = JSON.parse(fs.readFileSync(path.join(SHARES, FULL + ".json"), "utf8"));
console.log(`\n${"=".repeat(80)}`);
console.log(`全量复算 ${FULL}（沪 ${Object.keys(day.sse || {}).length} 只 / 深 ${Object.keys(day.szse || {}).length} 只）`);
const mism = [];
const miss = [];
for (const sub of Object.keys(SUB)) {
  const cat = catOf(sub);
  const got = recompute(sub, { ...(day.sse || {}), ...(day.szse || {}) });
  const o = chartValue(O, cat, sub, FULL);
  const r = chartValue(R, cat, sub, FULL);
  if (got.missing.length) miss.push(`${sub}: 缺 ${got.missing.length}/${got.total} 个代码`);
  if (got.value == null || Math.abs(got.value - (o ?? NaN)) > 1e-9) mism.push({ sub, cat, o, got: got.value, kind: "原站" });
  if (got.value == null || Math.abs(got.value - (r ?? NaN)) > 1e-9) mism.push({ sub, cat, r, got: got.value, kind: "复刻" });
}
console.log(`86 个小类中：与两份产物都不一致 ${new Set(mism.map((m) => m.sub)).size} 个`);
mism.slice(0, 20).forEach((m) => console.log(`  ${m.kind} ${m.sub}(${m.cat}): 复算 ${m.got} vs 产物 ${m.kind === "原站" ? m.o : m.r}`));
console.log(`原始快照缺失代码的小类: ${miss.length}`);
miss.slice(0, 10).forEach((x) => console.log("  " + x));

fs.writeFileSync(
  "verify/recompute-report.json",
  JSON.stringify({ dates, focus: FOCUS, focusChecked: checked, focusBad: bad, fullDate: FULL, fullMismatch: mism, missing: miss }, null, 2)
);
console.log("\n已写出 verify/recompute-report.json");
