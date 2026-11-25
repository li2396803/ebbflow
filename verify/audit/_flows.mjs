// 审计共用：逐日净申购、区间窗口、前缀和（独立实现，不 import lib/metrics.mjs）
import { adjustFactor } from "./_db.mjs";

/** 单只 ETF 逐日净申购（亿元/日）；NaN = 不可算
 *  basis="prev"：前值按「前一日之后的事件」折算（契约 §5.5 的正确实现）
 *  basis="same"：前值按「当日之后的事件」折算（旧实现；仅用于复现 bug 量级）
 */
export function dailyFlows(ctx, code, basis = "prev") {
  const n = ctx.dates.length;
  const out = new Float64Array(n).fill(NaN);
  const sh = ctx.shares.get(code);
  const nv = ctx.navs.get(code);
  if (!sh) return out;
  for (let i = 1; i < n; i++) {
    const w = sh[i];
    const p = sh[i - 1];
    const nav = nv?.[i];
    if (!Number.isFinite(w) || !Number.isFinite(p) || !Number.isFinite(nav) || !(nav > 0)) continue;
    if (ctx.listDate.get(code) === ctx.dates[i]) continue; // 上市首日不计
    const mt = adjustFactor(ctx, code, ctx.dates[i]);
    // "same" 是旧实现的错误基准（两值都用当日），只用于复现历史缺陷
    const mp = adjustFactor(ctx, code, basis === "same" ? ctx.dates[i] : ctx.dates[i - 1]);
    // basis="day"：v4.0.1 契约口径（折回当日份额单位）；"prev"：v4.0.0 的「最新单位 × 当日净值」
    out[i] = basis === "day" ? ((w - p * (mp / mt)) / 1e4) * nav : ((w * mt - p * mp) / 1e4) * nav;
  }
  return out;
}

/** 前缀和：NaN 视为「该日无贡献」，同时返回「区间内有效天数」 */
export function prefix(arr) {
  const s = new Float64Array(arr.length);
  const c = new Int32Array(arr.length);
  let acc = 0;
  let cnt = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isFinite(v)) {
      acc += v;
      cnt++;
    }
    s[i] = acc;
    c[i] = cnt;
  }
  return { sum: s, cnt: c };
}

/** 区间 [i0,i1] 的和（闭区间；含 i0 —— 与当前实现一致） */
export function sumRange(arr, i0, i1) {
  let s = 0;
  let any = false;
  for (let i = i0; i <= i1; i++) {
    const v = arr[i];
    if (Number.isFinite(v)) {
      s += v;
      any = true;
    }
  }
  return any ? s : null;
}

export function addMonthsUTC(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim));
  return d.toISOString().slice(0, 10);
}

/** 与 lib/metrics.periodWindows 同规则：期初 = 最后一个 ≤（末日 − N 个月）的交易日 */
export function windowOf(dates, months, endIndex = dates.length - 1) {
  const target = addMonthsUTC(dates[endIndex], -months);
  let i0 = 0;
  for (let i = endIndex; i >= 0; i--) {
    if (dates[i] <= target) {
      i0 = i;
      break;
    }
  }
  return { i0, i1: endIndex, from: dates[i0], to: dates[endIndex] };
}

export const PERIOD_MONTHS = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "3y": 36, "5y": 60 };

/** 当日事件 ratio（无事件 = 1） */
export function ratioOn(ctx, code, date) {
  let r = 1;
  for (const e of ctx.events.get(code) ?? []) if (e.date === date && e.ratio > 0) r *= e.ratio;
  return r;
}
