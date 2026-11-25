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
    // Map 的插入顺序是「日期降序」，直接用 for..of 会命中「最晚事件」的累计积；
    // 这里要的是「该日之后全部事件」的积，所以按日期升序找第一个 > date 的累计值。
    // 审计 E4：多次折算的 ETF（如 159219）在早期事件日之前会被少乘，凭空多出流量。
    for (const [d, v] of [...m].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (d > date) return wan * v;
    }
    return wan; // 之后没有事件：不缩放
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
  const adjust = makeSplitAdjuster(eventsByCode);
  // 事件日当天是否有折算（ratio != 1），供「事件日流量异常」警告使用
  const eventRatio = (code, date) => {
    const list = eventsByCode?.get(code);
    if (!list) return 1;
    const hit = list.find((e) => e.date === date);
    return hit && hit.ratio > 0 ? hit.ratio : 1;
  };
  return { dates, shares, navs, listDate, adjust, eventRatio, index };
}

/**
 * 单步净申购（亿元）：把前值按 **r_t = m_{t−1} / m_t** 折回「当日份额单位」后再计价。
 *
 *   m_t = 该日之后所有事件 ratio 的乘积（makeSplitAdjuster 的乘数）
 *   r_t = 当日事件 ratio（无事件 = 1）
 *   flow = (w − p·r_t) / 1e4 × nav_t
 *
 * 为什么不能直接用 (w·m_t − p·m_{t−1})：那是「最新份额单位」，乘当日净值等于把历史流量
 * 整体放大 m_t 倍（审计 E1：159219 报 −23.36 亿而当日 AUM 仅 0.77 亿，真实 −0.99 亿）。
 */
export function flowStep(w, p, nav, mt, mp) {
  if (!Number.isFinite(w) || !Number.isFinite(p) || !Number.isFinite(nav) || !(nav > 0)) return null;
  const back = mt > 0 && Number.isFinite(mp) ? mp / mt : 1;
  return ((w - p * back) / 1e4) * nav;
}

/**
 * 不变量：单只 ETF 单日净申购必须落在「期初规模」与「期末规模」之间。
 *
 *   −scale_{t−1} ≤ flow_t ≤ scale_t
 *
 * 为什么不是简单的 |flow| ≤ scale_t（审计 S1 的表述）：
 *   当天赎回 90% 的份额时，flow = −0.9×scale_{t−1}，而期末规模只剩 0.1×scale_{t−1}，
 *   于是 |flow| 会是 |scale_t| 的 9 倍——那是**合法**的清仓，不是错误。
 *   真正做到单边受益的是「申购不可能超过期末规模、赎回不可能超过期初规模」。
 * E1 这类「未来事件乘数」错误会让 flow 达到 AUM 的几十倍，必然越界。
 */
export function flowOutOfBounds(flow, scalePrev, scaleEnd, { tolerance = 1e-6 } = {}) {
  if (!Number.isFinite(flow)) return false;
  const hi = Number.isFinite(scaleEnd) ? scaleEnd : Infinity;
  const lo = Number.isFinite(scalePrev) ? -scalePrev : -Infinity;
  const pad = 1e-9 + tolerance * Math.max(Math.abs(scalePrev || 0), Math.abs(scaleEnd || 0), 1);
  return flow > hi + pad || flow < lo - pad;
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
    // 前值用「前一日」的折算基准（E2：这里曾经漏改，etf-ranges 因此与管道口径不一致）
    const mt = ctx.adjust(code, ctx.dates[i], 1);
    const mp = ctx.adjust(code, ctx.dates[i - 1], 1);
    const f = flowStep(w, prev, nav, mt, mp);
    if (f == null) continue;
    out[i] = f;
    const scalePrev = (prev / 1e4) * nav;
    const scaleEnd = (w / 1e4) * nav;
    // 事件日警告（审计建议）：越界断言有盲区——合并日 `scalePrev` 用「前一日份额×当日净值」，
    // 净值翻倍会把下界放大，导致「假流出」恰好落在合法区间内（如 510310 2024-09-20 的 −1905.8 亿）。
    // 因此在有折算事件的日期额外检查：流量不应超过当日规模与前日规模（按当日净值折算）较大者的 50%。
    const evRatio = ctx.eventRatio?.(code, ctx.dates[i]) ?? 1;
    const scalePrevAdj = Number.isFinite(scalePrev) ? scalePrev / evRatio : 0;
    const bound = 0.5 * Math.max(Number.isFinite(scaleEnd) ? scaleEnd : 0, Math.abs(scalePrevAdj));
    if (evRatio !== 1 && bound > 0 && Math.abs(f) > bound) {
      if (!ctx.eventWarnings) ctx.eventWarnings = [];
      if (ctx.eventWarnings.length < 50) {
        ctx.eventWarnings.push({ code, date: ctx.dates[i], flow: f, scalePrev, scaleEnd, ratio: evRatio });
      }
    }
    if (flowOutOfBounds(f, scalePrev, scaleEnd)) {
      if (!ctx.anomalies) ctx.anomalies = [];
      if (ctx.anomalies.length < 50) ctx.anomalies.push({ code, date: ctx.dates[i], flow: f, scalePrev, scaleEnd });
    }
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
  // 审计裁决 C1：区间净申购**不含期初当天**（期初规模取 scale[i0]，对应资金变动从 i0 之后开始）
  let flow = null;
  for (let i = i0 + 1; i <= i1; i++) {
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
