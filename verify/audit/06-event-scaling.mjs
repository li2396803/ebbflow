// 审计 6（核心）：份额折算的「未来事件乘数」问题
//   现行实现把份额换算到「最新份额单位」后，乘的是「当日净值」——
//   二者单位不一致，等价于把每个事件发生日之前的流量整体乘上「未来所有事件 ratio 的乘积」m_t。
//   正确的逐日流量必须在「当日单位」下计算：flow_t = (S_t − S_{t−1} × r_t) × nav_t / 1e4
//   （r_t = 当日发生的事件 ratio，无事件则为 1）
import { openDb, loadDates, buildCtx, adjustFactor, r2, siteJson } from "./_db.mjs";
import { loadUniverse } from "../../lib/universe.mjs";
import { sumRange, windowOf } from "./_flows.mjs";
import fs from "node:fs";

const db = openDb();
const dates = loadDates(db, "series_v2");
const ctx = buildCtx(db, dates);
const U = loadUniverse({ taxonomy: "v2" });

const ratioOn = (code, date) => {
  let r = 1;
  for (const e of ctx.events.get(code) ?? []) if (e.date === date && e.ratio > 0) r *= e.ratio;
  return r;
};

function threeForms(code) {
  const n = dates.length;
  const A = new Float64Array(n).fill(NaN); // 现行（series/管道）：最新单位 × 当日净值
  const B = new Float64Array(n).fill(NaN); // metrics.dailyFlow（etf-ranges）：两值都用当日基准
  const C = new Float64Array(n).fill(NaN); // 修正：折回当日单位
  const sh = ctx.shares.get(code);
  const nv = ctx.navs.get(code);
  if (!sh) return { A, B, C };
  for (let i = 1; i < n; i++) {
    const w = sh[i], p = sh[i - 1], nav = nv?.[i];
    if (!Number.isFinite(w) || !Number.isFinite(p) || !Number.isFinite(nav) || !(nav > 0)) continue;
    if (ctx.listDate.get(code) === dates[i]) continue;
    const mt = adjustFactor(ctx, code, dates[i]);
    const mp = adjustFactor(ctx, code, dates[i - 1]);
    A[i] = ((w * mt - p * mp) / 1e4) * nav;
    B[i] = ((w * mt - p * mt) / 1e4) * nav;
    C[i] = ((w - p * (mp / mt)) / 1e4) * nav;
  }
  return { A, B, C };
}

console.log("=".repeat(80));
console.log("A. 事件与乘数分布");
const evCodes = [...ctx.events.keys()];
console.log(`  有折算事件的 ETF = ${evCodes.length} 只，事件总数 = ${[...ctx.events.values()].reduce((a, l) => a + l.length, 0)}`);
const mAt = (code, date) => adjustFactor(ctx, code, date);
const mults = [];
for (const code of evCodes) {
  const evs = ctx.events.get(code);
  const first = evs.map((e) => e.date).sort()[0];
  const m = mAt(code, dates[0]); // 最早交易日的乘数 = 全部未来事件 ratio 的乘积
  mults.push({ code, events: evs.length, first, m: +m.toFixed(4), codes: U.SUB && Object.keys(U.SUB).length });
}
mults.sort((a, b) => Math.abs(Math.log(b.m)) - Math.abs(Math.log(a.m)));
console.log("  按乘数偏离 1 的幅度排序（前 10）：");
console.table(mults.slice(0, 10).map(({ code, events, first, m }) => ({ code, events, first, m })));

console.log("\n" + "=".repeat(80));
console.log("B. 区间流量：修正值 vs 现行 series 值 vs 站点分片值（3y / 5y）");
const shardFlow = new Map();
for (const cat of ["broad", "industry", "theme", "strategy", "bond", "crossborder", "commodity"]) {
  const f = `site/data/etf-ranges/${cat}.json`;
  if (!fs.existsSync(f)) continue;
  const s = siteJson(`etf-ranges/${cat}.json`);
  for (const [sub, per] of Object.entries(s.subs ?? {})) {
    for (const [p, map] of Object.entries(per)) {
      for (const [code, v] of Object.entries(map)) shardFlow.set(`${p}|${code}`, v?.flow ?? null);
    }
  }
}
const rows = [];
for (const code of evCodes) {
  const { A, C } = threeForms(code);
  for (const [p, m] of [["3y", 36], ["5y", 60]]) {
    const w = windowOf(dates, m);
    const c = sumRange(C, w.i0 + 1, w.i1);
    const a = sumRange(A, w.i0 + 1, w.i1);
    const s = shardFlow.get(`${p}|${code}`);
    if (c == null) continue;
    rows.push({ code, p, correct: r2(c), pipeline: r2(a), shard: s, diffShard: s == null ? null : r2(s - c) });
  }
}
rows.sort((x, y) => Math.abs(y.diffShard ?? 0) - Math.abs(x.diffShard ?? 0));
console.log(`  可比条目 ${rows.length}；分片与修正值差 >1 亿的条目 = ${rows.filter((r) => Math.abs(r.diffShard ?? 0) > 1).length}`);
console.table(rows.slice(0, 12));

console.log("\n" + "=".repeat(80));
console.log("C. 汇总：分片 flow 的误差量级（全部 6 个区间，仅含事件 ETF）");
let n = 0, nBad = 0, sumAbs = 0, maxAbs = 0, maxWho = null;
for (const code of evCodes) {
  const { C } = threeForms(code);
  for (const [p, m] of [["1m", 1], ["3m", 3], ["6m", 6], ["1y", 12], ["3y", 36], ["5y", 60]]) {
    const w = windowOf(dates, m);
    const c = sumRange(C, w.i0 + 1, w.i1);
    const s = shardFlow.get(`${p}|${code}`);
    if (c == null || s == null) continue;
    n++;
    const d = Math.abs(s - c);
    sumAbs += d;
    if (d > 1) nBad++;
    if (d > maxAbs) { maxAbs = d; maxWho = { code, p, shard: s, correct: r2(c) }; }
  }
}
console.log(`  条目 ${n}：|误差|>1 亿 的 ${nBad} 条（${((nBad / n) * 100).toFixed(1)}%）；平均 |误差| ${(sumAbs / n).toFixed(1)} 亿；最大 ${maxAbs.toFixed(1)} 亿 @ ${maxWho?.code} ${maxWho?.p}（分片 ${maxWho?.shard} vs 修正 ${maxWho?.correct}）`);

console.log("\n" + "=".repeat(80));
console.log("D. 小类级（series_v2）历史流量是否也被同一乘数污染");
// 取一个事件日之前的日期，比较库内 flow 与「按当日单位修正后」的该小类合计
const sub = "大盘宽基";
const checkDates = ["2023-06-15", "2023-12-15", "2024-06-14"];
const codes = U.SUB[sub].etfs.map((e) => e.code);
const forms = new Map(codes.map((c) => [c, threeForms(c)]));
for (const d of checkDates) {
  const i = ctx.index.get(d);
  if (i == null) continue;
  const stored = db.prepare("SELECT flow, scale FROM series_v2 WHERE sub=? AND date=?").get(sub, d);
  let a = 0, c = 0, hits = 0;
  for (const code of codes) {
    const f = forms.get(code);
    if (Number.isFinite(f.A[i])) { a += f.A[i]; c += f.C[i]; hits++; }
  }
  console.log(`  ${d}: 库内 flow ${stored?.flow}，现行公式合计 ${r2(a)}，当日单位修正合计 ${r2(c)}（${hits} 只有数据）→ 库内≈现行(${Math.abs((stored?.flow ?? 0) - a) < 1 ? "是" : "否"})`);
}
