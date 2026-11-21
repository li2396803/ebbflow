// 回归校验：用本项目自建的数据（交易所 + Tushare）复算历史，与原站已发布的序列逐点对比
//
// 用途：证明「自己抓的数据」与「原站显示的」在独立实现下仍然一致；
//      不一致的点会列出小类/日期/两边数值，便于判断是原站锁定旧值还是本方抓取异常。
//
//   node scripts/verify-origin.mjs [--json out.json]
import fs from "node:fs";
import path from "node:path";
import { openDb, tradingDates, shareRows, daySources } from "../lib/db.mjs";
import { SUB as BASE_SUB, BOND_CAT } from "../lib/taxonomy.mjs";
import { parseChunk } from "../tools/parse-chunks.mjs";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const DIR = path.join(ROOT, "tools", "original-charts");
const outJsonIdx = process.argv.indexOf("--json");
const outFile = outJsonIdx > 0 ? process.argv[outJsonIdx + 1] : path.join(ROOT, "data", "validation-origin.json");

if (!fs.existsSync(DIR)) {
  console.error("缺少原站数据副本 tools/original-charts/，无法做回归校验");
  process.exit(1);
}

const db = openDb();
// 说明：v3.1 起看板纳入深市成分，series 表是「沪深合并」口径，不能直接与原看板（仅沪市）比对。
// 因此这里用 share 表**只取沪市代码**重新算一遍，得到与原看板可比的口径。
const dates = tradingDates(db);
const shByDate = new Map();
for (const d of dates) {
  const m = new Map();
  const src = daySources(db, d);
  for (const r of shareRows(db, d)) {
    if (!/^[569]/.test(r.code)) continue;
    // 与看板口径一致：该日若有交易所快照，则只认交易所行，Tushare 补充行不计入
    if (src.sse && r.src !== "sse") continue;
    m.set(r.code, r.wan);
  }
  shByDate.set(d, m);
}
const series = new Map();
for (const [name, meta] of Object.entries(BASE_SUB)) {
  const factor = meta.cat === BOND_CAT ? 100 : 1;
  const m = new Map();
  for (const d of dates) {
    const day = shByDate.get(d);
    let sum = 0, hit = 0;
    for (const e of meta.etfs) {
      const v = day.get(e.code);
      if (v != null) { sum += v; hit++; }
    }
    m.set(d, hit ? Math.round((sum / 1e4) * factor * 1e4) / 1e4 : null);
  }
  series.set(name, m);
}

let total = 0, same = 0, d01 = 0, d05 = 0, big = 0;
const diffs = [];
const perSub = {};
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".js"))) {
  const D = parseChunk(path.join(DIR, f));
  const c1 = Object.values(D)[0].c1;
  for (const s of c1.series) {
    const m = series.get(s.name);
    if (!m) { diffs.push({ sub: s.name, date: null, note: "本地缺该细分行业" }); continue; }
    const stat = (perSub[s.name] ??= { total: 0, same: 0, diff: 0 });
    for (let i = 0; i < c1.dates.length; i++) {
      const a = s.values[i];
      const b = m.get(c1.dates[i]);
      if (a == null || b == null) continue;
      total++;
      stat.total++;
      const d = Math.abs(Math.round(b * 10) / 10 - a);
      if (d < 1e-9) { same++; stat.same++; }
      else {
        stat.diff++;
        if (d <= 0.1) d01++;
        else if (d <= 0.5) d05++;
        else big++;
        if (diffs.length < 400) diffs.push({ sub: s.name, date: c1.dates[i], mine: Math.round(b * 10) / 10, origin: a, delta: Math.round((Math.round(b * 10) / 10 - a) * 10) / 10 });
      }
    }
  }
}

// 找出「原站当日值 = 前一日值」而本日不同 的情况（原站疑似锁定旧值）
const staleDates = new Map();
for (const d of diffs) {
  if (!d.date) continue;
  const m = series.get(d.sub);
  if (!m) continue;
  const dates = [...m.keys()].sort();
  const i = dates.indexOf(d.date);
  if (i <= 0) continue;
  const minePrev = m.get(dates[i - 1]);
  if (minePrev == null) continue;
  if (Math.abs(d.origin - Math.round(minePrev * 10) / 10) < 1e-9) {
    staleDates.set(d.date, (staleDates.get(d.date) || 0) + 1);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    points: total,
    identical: same,
    identicalPct: +(total ? (same / total) * 100 : 0).toFixed(3),
    le01: d01,
    le05: d05,
    gt05: big,
  },
  staleDates: [...staleDates.entries()].map(([date, n]) => ({ date, subs: n })).sort((a, b) => b.subs - a.subs),
  subs: Object.entries(perSub).filter(([, v]) => v.diff > 0).map(([sub, v]) => ({ sub, ...v })).sort((a, b) => b.diff - a.diff),
  diffs: diffs.slice(0, 120),
};
fs.writeFileSync(outFile, JSON.stringify(report, null, 1));

console.log(`回归校验：${total} 个数据点，与原站完全一致 ${same}（${report.summary.identicalPct}%）`);
console.log(`  偏差 ≤0.1：${d01} ｜ ≤0.5：${d05} ｜ >0.5：${big}`);
if (report.staleDates.length) {
  console.log(`  疑似原站锁定旧值的日期：${report.staleDates.map((x) => `${x.date}(${x.subs}项)`).join(", ")}`);
}
console.log(`  明细：${outFile}`);
if (big > 0 && report.staleDates.length === 0) process.exitCode = 1;
