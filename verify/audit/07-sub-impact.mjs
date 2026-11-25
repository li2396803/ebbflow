// 审计 7：小类级序列（series_v2 → charts/subs 下发值）受「未来事件乘数」影响的程度
//   对每个小类：用修正公式（当日单位）重算逐日净申购合计，与库内 flow 比较
import { openDb, loadDates, buildCtx, adjustFactor, r2 } from "./_db.mjs";
import { loadUniverse } from "../../lib/universe.mjs";

const db = openDb();
const dates = loadDates(db, "series_v2");
const ctx = buildCtx(db, dates);
const U = loadUniverse({ taxonomy: "v2" });

/** 修正后的逐日流量：折回「当日份额单位」再乘当日净值 */
function correctedFlow(code, i) {
  const sh = ctx.shares.get(code);
  const nv = ctx.navs.get(code);
  const w = sh?.[i];
  const p = sh?.[i - 1];
  const nav = nv?.[i];
  if (!Number.isFinite(w) || !Number.isFinite(p) || !Number.isFinite(nav) || !(nav > 0)) return NaN;
  if (ctx.listDate.get(code) === dates[i]) return NaN;
  const mt = adjustFactor(ctx, code, dates[i]);
  const mp = adjustFactor(ctx, code, dates[i - 1]);
  return ((w - p * (mp / mt)) / 1e4) * nav;
}

const stored = new Map();
for (const r of db.prepare("SELECT sub, date, flow FROM series_v2").all()) stored.set(`${r.sub}|${r.date}`, r.flow);

const rows = [];
for (const [sub, meta] of Object.entries(U.SUB)) {
  const codes = meta.etfs.map((e) => e.code);
  let sumAbs = 0, maxD = 0, maxDate = null, days = 0, cumStored = 0, cumFixed = 0;
  for (let i = 1; i < dates.length; i++) {
    const st = stored.get(`${sub}|${dates[i]}`);
    if (st == null) continue;
    let fix = 0, any = false;
    for (const c of codes) {
      const v = correctedFlow(c, i);
      if (Number.isFinite(v)) { fix += v; any = true; }
    }
    if (!any) continue;
    days++;
    const d = Math.abs(st - fix);
    sumAbs += d;
    cumStored += st;
    cumFixed += fix;
    if (d > maxD) { maxD = d; maxDate = dates[i]; }
  }
  rows.push({ sub, days, meanAbs: days ? +(sumAbs / days).toFixed(3) : null, maxD: +maxD.toFixed(2), maxDate, cumStored: +cumStored.toFixed(0), cumFixed: +cumFixed.toFixed(0), cumGap: +(cumFixed - cumStored).toFixed(0) });
}
rows.sort((a, b) => b.maxD - a.maxD);
console.log("=== 小类级：库内 flow vs 修正后 flow（全历史 1214 个交易日）===");
console.log(`小类数 ${rows.length}；最大单日偏差 >1 亿的小类 = ${rows.filter((r) => r.maxD > 1).length}`);
console.table(rows.slice(0, 12));
const tot = rows.reduce((a, r) => a + Math.abs(r.cumGap), 0);
console.log(`\n全历史累计流量（1214 日求和）的分歧：|修正 − 库内| 合计 ${tot.toFixed(0)} 亿元（跨全部小类）`);
console.log(`其中 大盘宽基：库内累计 ${rows.find((r) => r.sub === "大盘宽基")?.cumStored}，修正后 ${rows.find((r) => r.sub === "大盘宽基")?.cumFixed}`);
