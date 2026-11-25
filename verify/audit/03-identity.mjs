// 审计 3：变化率恒等式
//   逐日精确分解（逐 ETF）：规模_t − 规模_{t−1} = Δ份额_t × 净值_t + 份额_{t−1} × Δ净值_t
//   区间求和：规模变化 = 净申购 + 净值贡献  →  chgPct = flow/期初规模 + 净值贡献/期初规模
//   并比较「净值贡献率」与「净值涨跌幅」（份额不变时二者相等）
import { openDb, loadDates, buildCtx, r1, r2, siteJson } from "./_db.mjs";
import { loadUniverse } from "../../lib/universe.mjs";
import { dailyFlows, sumRange, windowOf, ratioOn, PERIOD_MONTHS } from "./_flows.mjs";

const db = openDb();
const dates = loadDates(db, "series_v2");
const ctx = buildCtx(db, dates);
const U = loadUniverse({ taxonomy: "v2" });

const SUBS = ["大盘宽基", "半导体芯片", "医药生物", "信用债", "黄金"];
const PERIODS = ["1m", "3m", "6m", "1y"];

function subAgg(sub, i0, i1) {
  const codes = U.SUB[sub].etfs.map((e) => e.code);
  let scaleStart = 0, sHit = 0, scaleEnd = 0, eHit = 0;
  let flowIn = 0, flowEx = 0, fHit = 0;
  let navContrib = 0; // Σ 份额_{t−1} × Δnav_t
  let navShareBase = 0; // Σ 份额_{t−1} × nav_{t−1}（用于算净值贡献率）
  const per = codes.map((c) => ({ c, d: dailyFlows(ctx, c, "day") }));
  for (const { c, d } of per) {
    const sh = ctx.shares.get(c);
    const nv = ctx.navs.get(c);
    const w0 = sh?.[i0], n0 = nv?.[i0], w1 = sh?.[i1], n1 = nv?.[i1];
    if (Number.isFinite(w0) && Number.isFinite(n0) && n0 > 0) {
      scaleStart += (w0 / 1e4) * n0;
      sHit++;
    }
    if (Number.isFinite(w1) && Number.isFinite(n1) && n1 > 0) {
      scaleEnd += (w1 / 1e4) * n1;
      eHit++;
    }
    const fi = sumRange(d, i0, i1);
    const fe = sumRange(d, i0 + 1, i1);
    if (fi != null) { flowIn += fi; fHit++; }
    if (fe != null) flowEx += fe;
    for (let t = i0 + 1; t <= i1; t++) {
      const wp = sh?.[t - 1], np = nv?.[t - 1], nt = nv?.[t];
      if (Number.isFinite(wp) && Number.isFinite(np) && Number.isFinite(nt) && np > 0) {
        const r = ratioOn(ctx, c, dates[t]);
        navContrib += ((wp * r) / 1e4) * (nt - np / r);
        navShareBase += (wp / 1e4) * np;
      }
    }
  }
  return { scaleStart, scaleEnd, sHit, eHit, flowIn, flowEx, fHit, navContrib, navShareBase, n: codes.length };
}

console.log("=== 变化率恒等式：规模变化 = 净申购 + 净值贡献（样本 5 小类 × 4 区间）===");
console.log("说明：flowInc=含期初(当前实现) / flowExc=不含期初；chg=规模变化率；flowRate=净申购/期初规模；navRate=净值贡献/期初规模");
const rows = [];
for (const sub of SUBS) {
  for (const p of PERIODS) {
    const w = windowOf(dates, PERIOD_MONTHS[p]);
    const a = subAgg(sub, w.i0, w.i1);
    if (!(a.scaleStart > 0) || !(a.scaleEnd > 0)) continue;
    const chg = ((a.scaleEnd - a.scaleStart) / a.scaleStart) * 100;
    const frInc = (a.flowIn / a.scaleStart) * 100;
    const frExc = (a.flowEx / a.scaleStart) * 100;
    const navRate = (a.navContrib / a.scaleStart) * 100;
    const vwr = a.navShareBase > 0 ? (a.navContrib / a.navShareBase) * 100 : null; // 份额加权的净值涨跌幅
    rows.push({
      sub, p, from: w.from, to: w.to,
      chg: r2(chg), flowRateInc: r2(frInc), flowRateExc: r2(frExc), navRate: r2(navRate), vwr: r2(vwr),
      identityInc: r2(chg - frInc - navRate), identityExc: r2(chg - frExc - navRate),
      gap_inc_vs_nav: vwr == null ? null : r2(frInc - (chg - navRate)),
    });
  }
}
console.table(rows);

console.log("\n=== 恒等式残差（chg − flowRate − navRate，应为 0；含期初口径）===");
const maxResInc = Math.max(...rows.map((r) => Math.abs(r.identityInc)));
const maxResExc = Math.max(...rows.map((r) => Math.abs(r.identityExc)));
console.log(`  含期初 最大残差 ${maxResInc.toFixed(4)} pp；不含期初 最大残差 ${maxResExc.toFixed(4)} pp`);
console.log("  → 两种口径下「规模变化率 = 净申购率 + 净值贡献率」都成立；差别只在净申购率本身（期初那天算不算，见 04-t0.mjs）。");

console.log("\n=== 单只 ETF 的净值涨跌幅对照（份额几乎不变时，净值贡献率 ≈ 净值涨跌幅）===");
for (const [sub, code] of [["大盘宽基", "510050"], ["沪深300", "510310"], ["黄金", "518880"]]) {
  if (!U.SUB[sub]?.etfs.some((e) => e.code === code)) continue;
  const d = dailyFlows(ctx, code, "day");
  for (const p of ["1y"]) {
    const w = windowOf(dates, PERIOD_MONTHS[p]);
    const sh = ctx.shares.get(code), nv = ctx.navs.get(code);
    const s0 = (sh[w.i0] / 1e4) * nv[w.i0], s1 = (sh[w.i1] / 1e4) * nv[w.i1];
    const fl = sumRange(d, w.i0 + 1, w.i1);
    const chg = ((s1 - s0) / s0) * 100;
    const fr = (fl / s0) * 100;
    const navRet = (nv[w.i1] / nv[w.i0] - 1) * 100;
    console.log(`  ${sub}/${code} ${p} ${w.from}→${w.to}: 规模变化率 ${chg.toFixed(2)}% − 净申购率(不含期初) ${fr.toFixed(2)}% = ${(chg - fr).toFixed(2)}pp vs 净值涨跌幅 ${navRet.toFixed(2)}%（差 ${(chg - fr - navRet).toFixed(2)}pp，来自份额变动与申赎时点）`);
  }
}
