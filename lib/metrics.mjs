// 钱口径指标（v4.0.0）：规模 / 净申购 / 变化率 + 每只 ETF 的区间精确指标
//
// 口径以 docs/METRICS.md 为准：
//   规模(亿元)      = 份额(万份) / 1e4 × 单位净值(元)
//   净申购(亿元/日) = Δ份额(万份) / 1e4 × 当日净值，按 event 折算还原、剔除上市首日
//   变化率(%)       = (期末规模 − 期初规模) / 期初规模
// 债券 ×100 只用于旧的「份额」展示，**不进**规模/净申购。
//
// 设计要点：
//   · 全部按 (code, date) 精确计算，不用「小类级 × 权重」估算；
//   · `createMetricContext()` 一次把份额/净值读成按代码索引的定长数组（NaN = 缺失），
//     避免逐 code 查询（1.25M 行 join 实测 33s，分表读进内存 ~4s）；
//   · `periodWindows()` 的期初是「≤ 目标日 的最后一个交易日」，保证窗口至少覆盖整个周期。
import { loadUniverse } from "./universe.mjs";

export const PERIODS = ["1m", "3m", "6m", "1y", "3y", "5y"];
export const PERIOD_MONTHS = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "3y": 36, "5y": 60 };
export const PERIOD_LABELS = { "1m": "近 1 月", "3m": "近 3 月", "6m": "近 6 月", "1y": "近 1 年", "3y": "近 3 年", "5y": "近 5 年" };

const rnd = (v, d = 2) => {
  if (v == null || !Number.isFinite(v)) return null;
  const k = 10 ** d;
  return Math.round(v * k) / k;
};

/** UTC 加减月份（月末对齐：1-31 减 1 个月 → 2-28/29） */
export function addMonths(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim));
  return d.toISOString().slice(0, 10);
}

/**
 * 预设区间的起止索引（闭区间）。
 * 期初 = 最后一个 ≤（末日 − N 个月）的交易日；历史不够长时用第 0 天。
 * @param {string[]} dates 升序交易日
 * @returns {Record<string,{i0:number,i1:number,from:string,to:string,months:number}>}
 */
export function periodWindows(dates, { endIndex = dates.length - 1 } = {}) {
  const out = {};
  if (!Array.isArray(dates) || !dates.length || endIndex < 0) return out;
  const last = dates[endIndex];
  for (const p of PERIODS) {
    const target = addMonths(last, -PERIOD_MONTHS[p]);
    let i0 = 0;
    for (let i = endIndex; i >= 0; i--) {
      if (dates[i] <= target) {
        i0 = i;
        break;
      }
    }
    out[p] = { i0, i1: endIndex, from: dates[i0], to: last, months: PERIOD_MONTHS[p] };
  }
  return out;
}

/**
 * 拆分/合并还原：把 date 当日的份额换算到「最新份额单位」。
 * 语义与 v3 pipeline 内联实现完全一致（对同一份 event 数据逐字节等价）：
 * 把该日期**之后**所有事件的累计比例乘上去。
 * @param {Map<string, Array<{date:string, ratio:number}>>} eventsByCode
 */
export function makeSplitAdjuster(eventsByCode) {
  const cache = new Map();
  return (code, date, wan) => {
    const list = eventsByCode?.get(code);
    if (!list || !list.length) return wan;
    let m = cache.get(code);
    if (!m) {
      m = new Map();
      let factor = 1;
      for (const e of [...list].sort((a, b) => b.date.localeCompare(a.date))) {
        m.set(e.date, (factor *= e.ratio && e.ratio > 0 ? e.ratio : 1));
      }
      cache.set(code, m);
    }
    for (const [d, v] of m) if (d > date) return wan * v;
    return wan;
  };
}

/**
 * 把份额/净值读成「按代码索引的定长数组」。
 * @param {object} db
 * @param {string[]} dates 交易日（升序）
 * @param {{codes?: Iterable<string>}} [opts] 只保留这些代码（可省内存）
 * @returns {{dates:string[], shares:Map<string,Float64Array>, navs:Map<string,Float64Array>, listDate:Map<string,string>, adjust:Function, index:Map<string,number>}}
 */
export function createMetricContext(db, dates, { codes } = {}) {
  const n = dates.length;
  const index = new Map(dates.map((d, i) => [d, i]));
  const want = codes ? new Set(codes) : null;
  const shares = new Map();
  const navs = new Map();
  const ensure = (m, code) => {
    let a = m.get(code);
    if (!a) {
      a = new Float64Array(n);
      a.fill(NaN);
      m.set(code, a);
    }
    return a;
  };
  for (const r of db.prepare("SELECT date, code, wan FROM share").all()) {
    const i = index.get(r.date);
    if (i == null) continue;
    if (want && !want.has(r.code)) continue;
    ensure(shares, r.code)[i] = r.wan;
  }
  for (const r of db.prepare("SELECT code, date, nav FROM nav").all()) {
    const i = index.get(r.date);
    if (i == null) continue;
    if (want && !want.has(r.code)) continue;
    ensure(navs, r.code)[i] = r.nav;
  }
  const eventsByCode = new Map();
  try {
    for (const r of db.prepare("SELECT code, date, ratio FROM event").all()) {
      let list = eventsByCode.get(r.code);
      if (!list) eventsByCode.set(r.code, (list = []));
      list.push({ date: r.date, ratio: r.ratio });
    }
  } catch {
    /* 没有 event 表：不做折算还原 */
  }
  const listDate = new Map();
  try {
    for (const r of db.prepare("SELECT code, list_date FROM fund WHERE list_date IS NOT NULL").all()) listDate.set(r.code, r.list_date);
  } catch {}
  return { dates, shares, navs, listDate, adjust: makeSplitAdjuster(eventsByCode), index };
}

/** 单只 ETF 每日净申购（亿元/日）；NaN = 当日不可算（缺份额/缺净值/上市首日） */
export function dailyFlow(ctx, code) {
  const sh = ctx.shares.get(code);
  const nv = ctx.navs.get(code);
  const out = new Float64Array(ctx.dates.length).fill(NaN);
  if (!sh) return out;
  for (let i = 1; i < ctx.dates.length; i++) {
    const w = sh[i];
    const prev = sh[i - 1];
    const nav = nv?.[i];
    if (!Number.isFinite(w) || !Number.isFinite(prev) || !Number.isFinite(nav) || !(nav > 0)) continue;
    if (ctx.listDate.get(code) === ctx.dates[i]) continue; // 上市首日不计申购
    const cur = ctx.adjust(code, ctx.dates[i], w);
    const before = ctx.adjust(code, ctx.dates[i], prev);
    out[i] = ((cur - before) / 1e4) * nav;
  }
  return out;
}

/** 单只 ETF 在 [i0,i1] 的规模/变化率/净申购（精确，按 code/date 取期初期末） */
export function etfRangeMetrics(ctx, code, { i0, i1 }, flowDaily = null) {
  const sh = ctx.shares.get(code);
  const nv = ctx.navs.get(code);
  const scaleAt = (i) => {
    const w = sh?.[i];
    const nav = nv?.[i];
    return Number.isFinite(w) && Number.isFinite(nav) && nav > 0 ? (w / 1e4) * nav : null;
  };
  const scaleEnd = scaleAt(i1);
  const scaleStart = scaleAt(i0);
  const chgPct = scaleEnd != null && scaleStart != null && scaleStart > 0 ? ((scaleEnd - scaleStart) / scaleStart) * 100 : null;
  const daily = flowDaily ?? dailyFlow(ctx, code);
  let flow = null;
  for (let i = i0; i <= i1; i++) {
    const v = daily[i];
    if (Number.isFinite(v)) flow = (flow ?? 0) + v;
  }
  return { chgPct: rnd(chgPct, 2), flow: rnd(flow, 2), scaleEnd: rnd(scaleEnd, 2), scaleStart: rnd(scaleStart, 2) };
}

/**
 * 每只 ETF 在预设区间上的精确指标：{"1m": { "510300": {chgPct, flow, scaleEnd} }, ...}
 * @param {{ctx:object, universe:{SUB:object}, windows?:object, periods?:string[]}} p
 */
export function buildEtfRanges({ ctx, universe, windows, periods = PERIODS }) {
  const win = windows ?? periodWindows(ctx.dates);
  const U = universe ?? loadUniverse();
  const out = {};
  for (const p of periods) out[p] = {};
  for (const meta of Object.values(U.SUB)) {
    for (const e of meta.etfs) {
      const code = e.code;
      const daily = dailyFlow(ctx, code);
      for (const p of periods) {
        const w = win[p];
        if (!w) continue;
        const m = etfRangeMetrics(ctx, code, w, daily);
        out[p][code] = { chgPct: m.chgPct, flow: m.flow, scaleEnd: m.scaleEnd };
      }
    }
  }
  return out;
}

/**
 * 小类每日覆盖率 = 当日**真正参与聚合**的成分数 / 成分总数。
 * 「真正参与」与 pipeline 的 eff 完全同口径：孤立披露（filterIsolated）被剔除、
 * 官方口径日里被丢弃的 Tushare 行，都不计入。
 * @param {{universe:{SUB:object}, dates:string[], sharesByDate:Map<string,Map<string,{wan:number,src:string}>>, modes:Map<string,object>}} p
 * @returns {Map<string, Array<number|null>>} 0..1（4 位小数）；缺当日数据行时为 0
 */
export function subCoverage({ universe, dates, sharesByDate, modes }) {
  const out = new Map();
  for (const [sub, meta] of Object.entries(universe.SUB)) {
    const codes = meta.etfs.map((e) => e.code);
    const total = codes.length;
    const arr = new Array(dates.length).fill(null);
    for (let i = 0; i < dates.length; i++) {
      const day = sharesByDate.get(dates[i]);
      if (!day) {
        arr[i] = 0;
        continue;
      }
      const mode = modes?.get?.(dates[i]) ?? { sh: "all", sz: "all" };
      let hit = 0;
      for (const code of codes) {
        const r = day.get(code);
        if (!r) continue;
        const isSh = /^[56]/.test(code);
        const officialRow = isSh ? r.src === "sse" : r.src === "szse";
        const useOfficial = isSh ? mode.sh === "official" : mode.sz === "official";
        if (useOfficial && !officialRow) continue;
        hit++;
      }
      arr[i] = total ? Math.round((hit / total) * 1e4) / 1e4 : null;
    }
    out.set(sub, arr);
  }
  return out;
}

/** 低覆盖日统计（coverage < threshold），供 quality.json 汇总 */
export function lowCoverageSummary(coverageBySub, { threshold = 0.6 } = {}) {
  const perSub = {};
  let total = 0;
  for (const [sub, arr] of coverageBySub ?? []) {
    let n = 0;
    for (const v of arr ?? []) if (v != null && v < threshold) n++;
    if (n) perSub[sub] = n;
    total += n;
  }
  const top = Object.entries(perSub)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([sub, n]) => ({ sub, days: n }));
  return { threshold, total, subs: Object.keys(perSub).length, top };
}
