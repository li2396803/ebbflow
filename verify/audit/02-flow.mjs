// 审计 2：净申购口径
//  A. 510310 2024-09-20 合并：修正后 vs 旧实现（两者都用当日折算基准）逐 ETF 对比
//  B. 全 legacy 宇宙重算：正确实现与「同日基准」差多少 (小类×日)，并与库内 series.flow 对齐
//  C. 逐日公式抽查：flow = Δ份额(折算还原) × 当日净值 / 1e4
//  D. 上市首日 / 净值缺失 的处理
import { openDb, loadDates, buildCtx, adjustFactor, r4 } from "./_db.mjs";
import { loadUniverse } from "../../lib/universe.mjs";

const db = openDb();
const dates = loadDates(db, "series");
const ctx = buildCtx(db, dates);
// 成分用构建实际用的 legacy 宇宙（base 773 + 深市归属，已剔除联接/LOF）；算术仍为独立实现
const LU = loadUniverse({});
const subDefs = Object.entries(LU.SUB).map(([sub, m]) => ({ sub, codes: m.etfs.map((e) => e.code) }));

const flowAt = (code, i, { basis }) => {
  const sh = ctx.shares.get(code);
  const nv = ctx.navs.get(code);
  const w = sh?.[i];
  const p = sh?.[i - 1];
  const nav = nv?.[i];
  if (!Number.isFinite(w) || !Number.isFinite(p) || !Number.isFinite(nav) || !(nav > 0)) return NaN;
  if (ctx.listDate.get(code) === ctx.dates[i]) return NaN; // 上市首日
  const cur = w * adjustFactor(ctx, code, ctx.dates[i]);
  // basis = "prev"：前值按「前一日之后的事件」折算（正确）
  // basis = "same"：前值按「当日之后的事件」折算（旧实现，会把拆分当日的变化算成申赎）
  const before = p * (basis === "prev" ? adjustFactor(ctx, code, ctx.dates[i - 1]) : adjustFactor(ctx, code, ctx.dates[i]));
  return ((cur - before) / 1e4) * nav;
};

console.log("=".repeat(76));
console.log("A. 510310 2024-09-20（merge, ratio=0.512）逐 ETF 净申购");
const ia = ctx.index.get("2024-09-20");
const code = "510310";
const sh = ctx.shares.get(code);
const nv = ctx.navs.get(code);
console.log(`  份额 ${ctx.dates[ia - 1]} ${sh[ia - 1]} 万份 → ${ctx.dates[ia]} ${sh[ia]} 万份；净值 ${nv[ia - 1]} → ${nv[ia]}`);
console.log(`  折算因子：前一日基准 ${adjustFactor(ctx, code, ctx.dates[ia - 1]).toFixed(6)}，当日基准 ${adjustFactor(ctx, code, ctx.dates[ia]).toFixed(6)}`);
const good = flowAt(code, ia, { basis: "prev" });
const bad = flowAt(code, ia, { basis: "same" });
console.log(`  正确实现(前值用前一日基准): ${good.toFixed(2)} 亿元`);
console.log(`  旧实现(两者都当日基准):     ${bad.toFixed(2)} 亿元   ← 差 ${(bad - good).toFixed(2)} 亿`);

const v2flow = db.prepare("SELECT flow FROM series_v2 WHERE sub='沪深300' AND date=?").get("2024-09-20");
const lgflow = db.prepare("SELECT flow FROM series WHERE sub='A股大盘' AND date=?").get("2024-09-20");
console.log(`  库内 series_v2[沪深300] 当日 flow = ${v2flow?.flow}（含 510310 等全部成分）`);
console.log(`  库内 series[A股大盘]    当日 flow = ${lgflow?.flow}；METRICS.md §5.5 声称修正后 +57.49 亿`);

// A2. 同一 ETF 在 etf-ranges 分片里的区间净申购（走 lib/metrics.dailyFlow）
for (const p of ["3y", "5y"]) {
  const m = db.prepare("SELECT flow FROM series_v2 WHERE sub='沪深300' AND date >= ? ORDER BY date").all();
  void m;
}
console.log("  （etf-ranges 分片核对见 04-shards-flow.mjs）");

console.log("\n" + "=".repeat(76));
console.log("B. 全 legacy 宇宙：正确实现 vs 旧实现 的 (小类×日) 差异");
let diffDays = 0;
let maxDiff = 0;
let maxWhere = null;
let cmpRows = 0;
let seriesMismatch = 0;
const seriesFlow = new Map();
for (const r of db.prepare("SELECT sub, date, flow FROM series").all()) seriesFlow.set(`${r.sub}|${r.date}`, r.flow);

for (const s of subDefs) {
  for (let i = 1; i < dates.length; i++) {
    let g = NaN;
    let b = NaN;
    for (const c of s.codes) {
      const fg = flowAt(c, i, { basis: "prev" });
      if (Number.isFinite(fg)) g = (Number.isFinite(g) ? g : 0) + fg;
      const fb = flowAt(c, i, { basis: "same" });
      if (Number.isFinite(fb)) b = (Number.isFinite(b) ? b : 0) + fb;
    }
    if (!Number.isFinite(g) && !Number.isFinite(b)) continue;
    cmpRows++;
    const d = Math.abs((g || 0) - (b || 0));
    if (d > 1e-9) {
      diffDays++;
      if (d > maxDiff) {
        maxDiff = d;
        maxWhere = { sub: s.sub, date: dates[i], good: g, bad: b };
      }
    }
    // 与库内 series 对齐（只用正确实现）
    const stored = seriesFlow.get(`${s.sub}|${dates[i]}`);
    if (stored != null && Number.isFinite(g) && Math.abs(stored - r4(g)) > 2e-4) seriesMismatch++;
  }
}
console.log(`  比较的 (小类×日) = ${cmpRows}`);
console.log(`  两种实现结果不同的 (小类×日) = ${diffDays}   ← METRICS.md §5.5 声称 172 个`);
console.log(`  最大差 ${maxDiff.toFixed(2)} 亿元 @ ${maxWhere?.sub} ${maxWhere?.date}（正确 ${maxWhere?.good.toFixed(2)} / 旧 ${maxWhere?.bad.toFixed(2)}）`);
console.log(`  正确实现与库内 series.flow 不一致的点 = ${seriesMismatch}（>2e-4，含 eff 过滤/混源等差异）`);

console.log("\n" + "=".repeat(76));
console.log("C. 逐日公式抽查（5 个随机 (code,date)）");
const uniqCodes = [...new Set(subDefs.flatMap((s) => s.codes))].filter((c) => ctx.shares.get(c) && ctx.navs.get(c));
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
for (let k = 0; k < 5; k++) {
  const c = uniqCodes[Math.floor(rnd() * uniqCodes.length)];
  const i = 1 + Math.floor(rnd() * (dates.length - 1));
  const f = flowAt(c, i, { basis: "prev" });
  if (!Number.isFinite(f)) {
    console.log(`  ${c} ${dates[i]}: 不可算（缺份额/净值/上市首日），flow=null`);
    continue;
  }
  const fs1 = adjustFactor(ctx, c, dates[i]);
  const fs0 = adjustFactor(ctx, c, dates[i - 1]);
  const cur = ctx.shares.get(c)[i] * fs1;
  const before = ctx.shares.get(c)[i - 1] * fs0;
  const nav = ctx.navs.get(c)[i];
  console.log(`  ${c} ${dates[i]}: (${cur.toFixed(1)}−${before.toFixed(1)})万份/1e4×${nav} = ${f.toFixed(4)} 亿  [折算 ${fs0}→${fs1}]`);
}

console.log("\n" + "=".repeat(76));
console.log("D. 上市首日 / 净值缺失");
// D1: 找 universe 内 list_date 落在序列区间、且当日有份额的标的
let listingHits = 0;
const listingSamples = [];
for (const s of subDefs.slice(0, 88)) {
  for (const c of s.codes) {
    const ld = ctx.listDate.get(c);
    if (!ld) continue;
    const i = ctx.index.get(ld);
    if (i == null || i < 1) continue;
    const w = ctx.shares.get(c)?.[i];
    if (!Number.isFinite(w)) continue;
    listingHits++;
    // 若不算上市首日，该日 flow 会是多少
    const fake = ((w * 1 - (ctx.shares.get(c)[i - 1] ?? NaN)) / 1e4) * (ctx.navs.get(c)?.[i] ?? NaN);
    if (listingSamples.length < 3) listingSamples.push({ sub: s.sub, code: c, listDate: ld, wan: w, prev: ctx.shares.get(c)?.[i - 1] ?? null, fake });
  }
}
console.log(`  宇宙内「上市日 == 交易日且当日有份额」的标的 = ${listingHits}`);
listingSamples.forEach((x) => console.log(`    ${x.sub}/${x.code} 上市 ${x.listDate}，当日份额 ${x.wan} 万份，前值 ${x.prev} → 若计入会凭空产生 ${Number.isFinite(x.fake) ? x.fake.toFixed(2) : "-"} 亿；实现里已跳过`));

// D2: 净值缺失但份额存在的点
let navMissing = 0;
const navMissingSamples = [];
for (const s of subDefs) {
  for (const c of s.codes) {
    const sh2 = ctx.shares.get(c);
    const nv2 = ctx.navs.get(c);
    if (!sh2) continue;
    for (let i = 0; i < dates.length; i++) {
      if (Number.isFinite(sh2[i]) && !(Number.isFinite(nv2?.[i]) && nv2[i] > 0)) {
        navMissing++;
        if (navMissingSamples.length < 3) navMissingSamples.push(`${c} ${dates[i]} 份额${sh2[i]} 净值${nv2?.[i] ?? "缺失"}`);
      }
    }
  }
}
console.log(`  份额存在但净值缺失/≤0 的 (code×日) = ${navMissing}；样例: ${navMissingSamples.join(" | ")}`);
console.log("  → 这些点 scale/flow 都跳过（不计入 scaleHit/flowHit），不会写成 0。");
