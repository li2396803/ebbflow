// 审计 8（第二轮）：归档快照是否也用了 v4.0.1 口径
//   site/data/archive/<date>.json 的 cats[].flow = Σ 小类 flowSeries[i0+1..i1]（不含期初）
//   同时给出「含期初」的值做对照，用以判定归档到底是哪个口径
import { openDb, loadDates, r1, r2 } from "./_db.mjs";
import { loadUniverse } from "../../lib/universe.mjs";
import fs from "node:fs";

const db = openDb();
const dates = loadDates(db, "series_v2");
const U = loadUniverse({ taxonomy: "v2" });

// series_v2 全量读入
const flow = new Map(); // sub|date -> flow
const scale = new Map();
for (const r of db.prepare("SELECT sub, date, scale, flow FROM series_v2").all()) {
  flow.set(`${r.sub}|${r.date}`, r.flow);
  scale.set(`${r.sub}|${r.date}`, r.scale);
}

const idx = new Map(dates.map((d, i) => [d, i]));

/** 最近 7 个自然日内的交易日下标（与 lib/aggregate.recentWindow 同规则） */
function recentWindow(endIdx, days = 7) {
  const last = new Date(dates[endIdx] + "T00:00:00Z");
  const cut = new Date(last.getTime() - days * 86400000);
  const out = [];
  for (let i = 0; i <= endIdx; i++) if (new Date(dates[i] + "T00:00:00Z") >= cut) out.push(i);
  return out;
}

function catAgg(cat, endIdx, { includeT0 }) {
  const win = recentWindow(endIdx);
  if (!win.length) return null;
  const i0 = win[0];
  const i1 = win[win.length - 1];
  let now = 0;
  let start = 0;
  let fl = 0;
  let nowHit = 0;
  let startHit = 0;
  for (const sub of U.CATS.find((c) => c.key === cat).subs) {
    const b = scale.get(`${sub}|${dates[i1]}`);
    const a = scale.get(`${sub}|${dates[i0]}`);
    if (b != null) { now += b; nowHit++; }
    if (a != null) { start += a; startHit++; }
    for (let i = includeT0 ? i0 : i0 + 1; i <= i1; i++) {
      const v = flow.get(`${sub}|${dates[i]}`);
      if (v != null) fl += v;
    }
  }
  return {
    now: nowHit ? r1(now) : null,
    start: startHit ? r1(start) : null,
    pct: start > 0 && nowHit ? r2(((now - start) / start) * 100) : null,
    flow: r2(fl),
    win: `${dates[i0]}→${dates[i1]}`,
  };
}

const files = fs.readdirSync("site/data/archive").filter((f) => f.endsWith(".json")).sort();
console.log(`=== 归档快照 ${files.length} 个，逐个用两种口径复算 cats[].flow ===`);

let newOk = 0;
let oldOk = 0;
let neither = 0;
const bad = [];
for (const f of files) {
  const rec = JSON.parse(fs.readFileSync(`site/data/archive/${f}`, "utf8"));
  const i = idx.get(rec.date);
  if (i == null) continue;
  let allNew = true;
  let allOld = true;
  for (const c of rec.cats ?? []) {
    const n = catAgg(c.key, i, { includeT0: false });
    const o = catAgg(c.key, i, { includeT0: true });
    if (n == null || Math.abs(c.flow - n.flow) > 0.051) allNew = false;
    if (o == null || Math.abs(c.flow - o.flow) > 0.051) allOld = false;
  }
  if (allNew) newOk++;
  else if (allOld) oldOk++;
  else {
    neither++;
    if (bad.length < 5) bad.push({ file: f, date: rec.date, sample: rec.cats?.[0] ? { key: rec.cats[0].key, flow: rec.cats[0].flow, newV: catAgg(rec.cats[0].key, i, { includeT0: false })?.flow, oldV: catAgg(rec.cats[0].key, i, { includeT0: true })?.flow } : null });
  }
}
console.log(`  不含期初（v4.0.1 契约）匹配：${newOk} / ${files.length}`);
console.log(`  含期初（旧口径）匹配：      ${oldOk} / ${files.length}`);
console.log(`  两者都不匹配：              ${neither}`);
if (bad.length) console.table(bad);

// 最大偏差（归档 vs 新口径），用于说明 1 位小数舍入
let maxAbs = 0;
let maxAt = null;
for (const f of files) {
  const rec = JSON.parse(fs.readFileSync(`site/data/archive/${f}`, "utf8"));
  const i = idx.get(rec.date);
  if (i == null) continue;
  for (const c of rec.cats ?? []) {
    const n = catAgg(c.key, i, { includeT0: false });
    if (!n) continue;
    const d = Math.abs(c.flow - n.flow);
    if (d > maxAbs) { maxAbs = d; maxAt = { date: rec.date, cat: c.key, archive: c.flow, mine: n.flow }; }
  }
}
console.log(`\n  归档 vs 新口径：最大 |Δ| = ${maxAbs.toFixed(4)} 亿 @ ${maxAt?.date} ${maxAt?.cat}（归档 ${maxAt?.archive} / 复算 ${maxAt?.mine}）`);

console.log("\n=== 抽查 3 天明细（每个大类的 flow：归档 vs 新口径 vs 旧口径）===");
for (const d of ["2026-06-01", "2026-08-14", "2026-10-29"]) {
  const rec = JSON.parse(fs.readFileSync(`site/data/archive/${d}.json`, "utf8"));
  const i = idx.get(d);
  console.log(`\n${d}（窗口 ${recentWindow(i).length} 个交易日）`);
  for (const c of rec.cats ?? []) {
    const n = catAgg(c.key, i, { includeT0: false });
    const o = catAgg(c.key, i, { includeT0: true });
    const mark = Math.abs(c.flow - n.flow) <= 0.051 ? "新口径✓" : Math.abs(c.flow - o.flow) <= 0.051 ? "旧口径(含T0)" : "都不符";
    console.log(`  ${c.key.padEnd(12)} 归档 ${String(c.flow).padStart(9)} | 新 ${String(n.flow).padStart(9)} | 旧 ${String(o.flow).padStart(9)} → ${mark}`);
  }
}
