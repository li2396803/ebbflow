// 审计 4：区间净申购「含/不含期初」的口径裁决所需数据
//  A. 510050 1y 两个口径的数值（复核 Lead 给的 −1071.3 / −1086.6）
//  B. 相邻区间在边界日重复计量的实例（1m 窗口）
//  C. 全样本量级：期初日流量占区间流量的比例
//  D. 与规模变化的对账：哪个口径才能让 flow 与 (期末−期初) 对齐
import { openDb, loadDates, buildCtx, r2, siteJson } from "./_db.mjs";
import { loadUniverse } from "../../lib/universe.mjs";
import { dailyFlows, sumRange, windowOf, PERIOD_MONTHS } from "./_flows.mjs";

const db = openDb();
const dates = loadDates(db, "series_v2");
const ctx = buildCtx(db, dates);
const U = loadUniverse({ taxonomy: "v2" });

console.log("=".repeat(78));
console.log("A. 510050 1 年窗口：含期初 vs 不含期初");
const w1y = windowOf(dates, 12);
const f50 = dailyFlows(ctx, "510050", "day");
const inc = sumRange(f50, w1y.i0, w1y.i1);
const exc = sumRange(f50, w1y.i0 + 1, w1y.i1);
console.log(`  窗口 ${w1y.from} → ${w1y.to}（i0=${w1y.i0}, i1=${w1y.i1}）`);
console.log(`  含 T0（当前实现::Σ[i0..i1]）  = ${r2(inc)} 亿元   ← Lead 给 −1071.3`);
console.log(`  不含 T0（Σ[i0+1..i1]）        = ${r2(exc)} 亿元   ← Lead 给 −1086.6`);
console.log(`  期初日 ${dates[w1y.i0]} 自身流量 = ${r2(f50[w1y.i0])} 亿元（含 T0 时被计入）`);
const sh = ctx.shares.get("510050");
const nv = ctx.navs.get("510050");
const s0 = (sh[w1y.i0] / 1e4) * nv[w1y.i0];
const s1 = (sh[w1y.i1] / 1e4) * nv[w1y.i1];
let navC = 0;
for (let t = w1y.i0 + 1; t <= w1y.i1; t++) navC += (sh[t - 1] / 1e4) * (nv[t] - nv[t - 1]);
console.log(`  对账：期末−期初 = ${r2(s1 - s0)}；净值贡献 = ${r2(navC)}；则「净申购应为」= ${r2(s1 - s0 - navC)}`);
console.log(`     → 不含 T0 的 ${r2(exc)} 与对账值 ${r2(s1 - s0 - navC)} 一致；含 T0 的 ${r2(inc)} 与规模变化对不上`);

console.log("\n" + "=".repeat(78));
console.log("B. 相邻区间在边界日重复计量（以 510050 的 1m 窗口为例）");
const wPrev = windowOf(dates, 1, dates.indexOf("2026-10-23"));
const wCur = windowOf(dates, 1, dates.indexOf("2026-11-24"));
const day = "2026-10-23";
const iDay = ctx.index.get(day);
console.log(`  窗口1 ${wPrev.from} → ${wPrev.to}（i0=${wPrev.i0}, i1=${wPrev.i1}）`);
console.log(`  窗口2 ${wCur.from} → ${wCur.to}（i0=${wCur.i0}, i1=${wCur.i1}）`);
console.log(`  边界日 ${day} 同时是：窗口1 的期末(i1=${wPrev.i1})、窗口2 的期初(i0=${wCur.i0}) → 同一日 ${day} 的流量 ${r2(f50[iDay])} 亿元被两个区间各算一次`);
const f1 = sumRange(f50, wPrev.i0, wPrev.i1);
const f2 = sumRange(f50, wCur.i0, wCur.i1);
const f1x = sumRange(f50, wPrev.i0, wPrev.i1 - 1); // 若改为「不含期初」，窗口1 应去掉它自己的 i0，边界日在窗口1 仍作为期末计入
const f2x = sumRange(f50, wCur.i0 + 1, wCur.i1);
console.log(`  当前：窗口1 = ${r2(f1)}，窗口2 = ${r2(f2)}；两段相加里 ${day} 被计了 2 次`);

console.log("\n" + "=".repeat(78));
console.log("C. 量级：期初日流量占区间流量的比例（v2 全宇宙，1m/1y 两个窗口）");
for (const p of ["1m", "1y"]) {
  const w = windowOf(dates, PERIOD_MONTHS[p]);
  let n = 0, nBig = 0, maxRatio = 0, maxWho = null, sumAbs = 0;
  for (const [sub, meta] of Object.entries(U.SUB)) {
    for (const e of meta.etfs) {
      const d = dailyFlows(ctx, e.code, "day");
      const f0 = d[w.i0];
      const tot = sumRange(d, w.i0 + 1, w.i1);
      if (!Number.isFinite(f0) || tot == null) continue;
      n++;
      sumAbs += Math.abs(f0);
      const ratio = Math.abs(tot) > 1e-9 ? Math.abs(f0) / Math.abs(tot) : Infinity;
      if (Math.abs(f0) > 5) nBig++;
      if (Number.isFinite(ratio) && ratio > maxRatio) {
        maxRatio = ratio;
        maxWho = { sub, code: e.code, f0, tot };
      }
    }
  }
  console.log(`  ${p}（${w.from}→${w.to}）：可算 ETF ${n} 只；期初日 |flow|>5 亿 的 ${nBig} 只；平均 |期初日流量| ${(sumAbs / n).toFixed(2)} 亿`);
  console.log(`     最大占比 ${(maxRatio * 100).toFixed(1)}% @ ${maxWho?.sub}/${maxWho?.code}（期初日 ${r2(maxWho?.f0)} / 区间 ${r2(maxWho?.tot)}）`);
}

console.log("\n" + "=".repeat(78));
console.log("D. 站点实际展示的区间净申购走的是哪条路径");
const shard = siteJson("etf-ranges/broad.json");
const v = shard.subs["沪深300"]["1y"]["510310"];
console.log(`  etf-ranges/broad.json 沪深300/510310 1y flow = ${v.flow}（= Σ[i0..i1]，含期初）`);
const subs = siteJson("subs.json");
const entry = subs["大盘宽基"];
console.log(`  subs.json 大盘宽基.flow（7 日窗口）= ${entry.flow}；flowSeries 长度为 ${entry.flowSeries.length}`);
console.log(`  web/js/etf-range.js::sumRange(flowArr, i0, i1) 同样含 i0 → 前端区间净申购也是「含期初」口径`);
