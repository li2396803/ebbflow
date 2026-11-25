// @ts-check
/* ==========================================================================
   etf-range：让成分 ETF 表的指标跟随「当前区间」
   --------------------------------------------------------------------------
   数据现状（subs.json / charts-*.json）：
   · 小类级有逐日的份额（subs.values）、规模（charts.series[].scale）与
     份额净申购（charts.series[].flow）
   · ETF 级只有最新快照（shares/scale/flow/...），没有逐日序列
   因此按约定做「小类级 × ETF 最新权重」估算，并在表头标注「近似」：
   · 区间份额变化 % = 小类期初/期末份额变化（同一小类内各 ETF 相同）
   · 区间净申购 = 小类区间 flow 求和 × 该 ETF 最新份额权重
   · 期末规模   = 小类期末规模 × 该 ETF 最新份额权重
   · 折溢价     = 仅当区间终点=最新交易日时用快照值，否则留空（不编造）
   ========================================================================== */
import { load } from "./api.js";
import { state } from "./state.js";

/** @type {Map<string, Promise<any>>} */
const loading = new Map();

/** 读取某大类的 charts 载荷：优先内存缓存（app.chartData），其次 data/charts-*.json */
async function ensureChart(app, cat) {
  if (!cat) return null;
  if (app?.chartData?.has?.(cat)) return app.chartData.get(cat);
  if (loading.has(cat)) return loading.get(cat);
  const p = load(`charts:${cat}`)
    .then((data) => {
      try {
        app?.chartData?.set?.(cat, data);
      } catch {}
      loading.delete(cat);
      return data;
    })
    .catch(() => {
      loading.delete(cat);
      return null;
    });
  loading.set(cat, p);
  return p;
}

const clampIdx = (i, len) => Math.max(0, Math.min(len - 1, Number.isFinite(i) ? i : 0));

/** 区间内求和（跳过 null） */
function sumRange(arr, i0, i1) {
  if (!Array.isArray(arr) || !arr.length) return null;
  let sum = 0;
  let any = false;
  for (let i = i0; i <= i1; i += 1) {
    const v = arr[i];
    if (v != null && Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

/**
 * 计算区间上下文（供表格 decorate 使用）
 * @param {any} app
 * @param {string} subName
 * @param {any[]} rows
 */
export async function rangeContext(app, subName, rows) {
  const entry = app?.subs?.[subName];
  if (!entry) return null;
  const vals = Array.isArray(entry.values) ? entry.values : [];
  const r = /** @type {any} */ (state.rangeInfo || {});
  const i0 = clampIdx(r.fromIdx ?? 0, vals.length);
  const i1 = clampIdx(r.toIdx ?? vals.length - 1, vals.length);
  const first = vals[i0];
  const last = vals[i1];
  const pct = first != null && last != null && first !== 0 ? ((last - first) / first) * 100 : null;

  const chart = await ensureChart(app, entry.cat);
  const series = chart?.series?.find((s) => s.name === subName) || null;
  const flowSum = sumRange(series?.flow, i0, i1);
  const scaleEnd = series?.scale ? series.scale[i1] : null;

  const totalShares = (rows || []).reduce((acc, x) => acc + (Number.isFinite(x?.shares) ? x.shares : 0), 0);
  const latestIdx = vals.length - 1;
  return {
    pct,
    flowSum,
    scaleEnd,
    totalShares,
    atLatest: i1 >= latestIdx,
    i0,
    i1,
    from: r.from,
    to: r.to,
  };
}

/**
 * 给每行附加区间指标（不修改原对象）
 * @param {any[]} rows
 * @param {any} ctx
 */
export function decorateRows(rows, ctx) {
  const total = ctx?.totalShares || 0;
  return (rows || []).map((r) => {
    const w = total > 0 && Number.isFinite(r?.shares) ? r.shares / total : null;
    return {
      ...r,
      weightPct: w != null ? w * 100 : null,
      pctRange: ctx?.pct ?? null,
      flowRange: w != null && ctx?.flowSum != null ? ctx.flowSum * w : null,
      scaleEnd: w != null && ctx?.scaleEnd != null ? ctx.scaleEnd * w : null,
      // 只有区间终点=最新交易日时，快照里的折溢价才是「期末值」
      premiumEnd: ctx?.atLatest && r?.premium != null ? r.premium : null,
    };
  });
}

/** 表头「近似」角标（小类级 × 权重估算） */
export const APPROX_TIP = "小类级日序列 × 该 ETF 最新份额权重估算（ETF 级逐日数据未提供）";
