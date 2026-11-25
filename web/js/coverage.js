// @ts-check
/* ==========================================================================
   coverage：低覆盖区间的判定与端点回退
   --------------------------------------------------------------------------
   · 数据层的 coverage[i] ∈ [0,1] = 当日有数据的成分 / 成分总数
   · <0.6 视为「低覆盖」：折线虚线 + 灰底；区间指标的期初/期末向前取最近达标日
   · 不做插值、不改数值：只是端点选择与视觉标注
   ========================================================================== */
export const LOW_COVERAGE = 0.6;

/** 取序列的 coverage（缺失返回 null，视为全覆盖） */
export function coverageOf(obj) {
  const c = obj && obj.coverage;
  return Array.isArray(c) && c.length ? c : null;
}

export function isLow(coverage, i) {
  if (!coverage) return false;
  const v = coverage[i];
  return typeof v === "number" ? v < LOW_COVERAGE : false;
}

/**
 * 端点回退：idx 落在低覆盖日时向前找最近达标日（不越界）。
 * 找不到达标日就保留原 idx（宁可不改，也不编造）。
 * @param {number[]|null|undefined} coverage
 * @param {number} idx
 */
export function effectiveIndex(coverage, idx) {
  if (!coverage || idx == null || idx < 0) return idx;
  const start = Math.min(idx, coverage.length - 1);
  // 优先向前（更早）找最近的达标日
  let j = start;
  while (j >= 0 && isLow(coverage, j)) j -= 1;
  if (j >= 0) return j;
  // 历史开头就没有达标日：向后找最近达标日，避免区间指标退化成"整段不可用"
  let k = start;
  while (k < coverage.length && isLow(coverage, k)) k += 1;
  return k < coverage.length ? k : idx;
}

/**
 * 连续低覆盖区段（绝对索引），用于虚线叠加与灰底 markArea。
 * @param {number[]|null|undefined} coverage
 * @param {number} a
 * @param {number} b
 * @returns {Array<[number, number]>}
 */
export function lowSpans(coverage, a, b) {
  if (!coverage) return [];
  const spans = [];
  let start = -1;
  const lo = Math.max(0, a);
  const hi = Math.min(b, coverage.length - 1);
  for (let i = lo; i <= hi; i += 1) {
    if (isLow(coverage, i)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      spans.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) spans.push([start, hi]);
  return spans;
}
