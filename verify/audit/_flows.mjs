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
    const cur = w * adjustFactor(ctx, code, ctx.dates[i]);
    const before = p * adjustFactor(ctx, code, basis === "prev" ? ctx.dates[i - 1] : ctx.dates[i]);
    out[i] = ((cur - before) / 1e4) * nav;
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
