// @ts-check
/* ==========================================================================
   etf-range：成分 ETF 表的区间指标（v4）
   --------------------------------------------------------------------------
   · 优先使用后端下发的精确值 etfRanges[preset][code] = {chgPct, flow, scaleEnd}
   · 自定义区间或数据包没有 etfRanges 时，回退「小类级 × ETF 规模权重」估算，
     并在表头保留「近似」标注（绝不冒充满分数据）
   · 期初/期末 = 当前区间首尾交易日；端点落在低覆盖日（coverage<0.6）时向前
     取最近达标日，并在 tooltip 注明
   ========================================================================== */
import { load } from "./api.js";
import { state } from "./state.js";
import { coverageOf, effectiveIndex } from "./coverage.js";

/** @type {Map<string, Promise<any>>} */
const loading = new Map();
/** @type {Map<string, Promise<any>>} */
const rangeLoading = new Map();

/** etfRanges 按大类分片懒加载：etf-ranges/<cat>.json */
async function loadEtfRanges(app, cat) {
  if (!cat) return null;
  if (app?.etfRanges?.has?.(cat)) return app.etfRanges.get(cat);
  if (rangeLoading.has(cat)) return rangeLoading.get(cat);
  const p = load(`etf-ranges/${cat}`)
    .then((data) => {
      try {
        app?.etfRanges?.set?.(cat, data);
      } catch {}
      rangeLoading.delete(cat);
      return data;
    })
    .catch(() => {
      rangeLoading.delete(cat);
      return null;
    });
  rangeLoading.set(cat, p);
  return p;
}

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

/** 本次区间能用的精确值表（仅预设区间；自定义区间返回 null） */
function exactMap(entry, subName, shard) {
  if (!entry || state.custom) return null;
  const preset = state.preset;
  if (!preset) return null;
  const map =
    (entry.etfRanges && entry.etfRanges[preset]) ||
    (shard && shard[preset]) ||
    (shard && shard.subs && shard.subs[subName] && shard.subs[subName][preset]) ||
    null;
  if (!map || typeof map !== "object") return null;
  return Object.keys(map).length ? map : null;
}

/**
 * 区间上下文
 * @param {any} app
 * @param {string} subName
 * @param {any[]} rows
 */
export async function rangeContext(app, subName, rows) {
  const entry = app?.subs?.[subName];
  if (!entry) return null;
  const chart = await ensureChart(app, entry.cat);
  const series = chart?.series?.find((s) => s.name === subName) || null;
  // 规模序列唯一来源 = charts-<cat>.json（subs.scaleSeries 已置 null）
  const scale = (series && series.scale) || [];
  const flowArr = Array.isArray(entry.flowSeries) && entry.flowSeries.length ? entry.flowSeries : series?.flow;
  const coverage = coverageOf(entry) || coverageOf(series);
  const r = /** @type {any} */ (state.rangeInfo || {});
  const i0 = clampIdx(r.fromIdx ?? 0, scale.length);
  const i1 = clampIdx(r.toIdx ?? scale.length - 1, scale.length);
  const eff0 = coverage ? effectiveIndex(coverage, i0) : i0;
  const eff1 = coverage ? effectiveIndex(coverage, i1) : i1;
  const startScale = scale[eff0];
  const endScale = scale[eff1];
  const scalePct =
    startScale != null && endScale != null && Number.isFinite(+startScale) && Number.isFinite(+endScale) && +startScale !== 0
      ? ((endScale - startScale) / Math.abs(startScale)) * 100
      : null;
  // 审计口径：区间净申购 = Σ[i0+1..i1]，排除期初当天（属于上一区间）
  const flowSum = sumRange(flowArr, Math.min(i0 + 1, i1), i1);
  const totalScale = (rows || []).reduce((acc, x) => acc + (Number.isFinite(x?.scale) ? x.scale : 0), 0);
  const latestIdx = scale.length - 1;
  const shard = await loadEtfRanges(app, entry.cat);
  const exact = exactMap(entry, subName, shard);
  return {
    mode: exact ? "exact" : "approx",
    exact,
    preset: state.preset,
    scalePct,
    flowSum,
    scaleEnd: endScale,
    totalScale,
    coverage,
    atLatest: i1 >= latestIdx,
    i0,
    i1,
    eff0,
    eff1,
    endpointsAdjusted: eff0 !== i0 || eff1 !== i1,
    from: r.from,
    to: r.to,
    dates: entry.dates || state.calendar,
  };
}

/**
 * 给每行附加区间指标（不修改原对象）
 * @param {any[]} rows
 * @param {any} ctx
 */
export function decorateRows(rows, ctx) {
  const total = ctx?.totalScale || 0;
  return (rows || []).map((r) => {
    const w = total > 0 && Number.isFinite(r?.scale) ? r.scale / total : null;
    const ex = ctx?.mode === "exact" && ctx.exact ? ctx.exact[r.code] : null;
    const pctRange = ex && ex.chgPct != null ? +ex.chgPct : ctx?.mode === "approx" ? ctx?.scalePct ?? null : null;
    const flowRange =
      ex && ex.flow != null ? +ex.flow : ctx?.mode === "approx" && w != null && ctx?.flowSum != null ? ctx.flowSum * w : null;
    const scaleEnd =
      ex && ex.scaleEnd != null ? +ex.scaleEnd : ctx?.mode === "approx" && w != null && ctx?.scaleEnd != null ? ctx.scaleEnd * w : null;
    return {
      ...r,
      weightPct: w != null ? w * 100 : null,
      pctRange,
      flowRange,
      scaleEnd,
      premiumEnd: ctx?.atLatest && r?.premium != null ? r.premium : null,
      approx: ctx?.mode !== "exact",
      endpointNote: endpointNote(ctx),
    };
  });
}

export const APPROX_TIP = "小类级规模日序列 × 该 ETF 当前规模权重估算（自定义区间无精确值）";

/** 端点回退说明（供 tooltip） */
export function endpointNote(ctx) {
  if (!ctx || !ctx.endpointsAdjusted) return "";
  const dates = ctx.dates || [];
  const parts = [];
  if (ctx.eff0 !== ctx.i0) parts.push(`期初回退至 ${dates[ctx.eff0] || "—"}`);
  if (ctx.eff1 !== ctx.i1) parts.push(`期末回退至 ${dates[ctx.eff1] || "—"}`);
  return parts.join("；");
}
