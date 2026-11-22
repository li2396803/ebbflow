// @ts-check
/* ==========================================================================
   state：唯一状态源（视图 / 大类 / 区间 / 指标 / 自选 / URL）
   --------------------------------------------------------------------------
   · 区间是全局的：图表缩放、框选、表格、KPI 全部由它派生
   · URL 是区间的持久化：?view=cat&cat=3_科技&from=…&to=…&m=shares
   · 自选只存 localStorage，不做任何网络上报
   ========================================================================== */

import { addMonths, clamp, isDesktop } from "./util.js";

/* ------------------------------- 常量 ------------------------------- */
export const METRICS = [
  { id: "shares", label: "份额", unit: "亿份", short: "份额" },
  { id: "scale", label: "规模", unit: "亿元", short: "规模" },
  { id: "flow", label: "份额净申购", unit: "亿元", short: "份额净申购" },
  { id: "pct", label: "变化率", unit: "%", short: "变化率" },
];

/** 聚焦态下四个指标完全平等：任意子集，顺序固定（分面顺序也按这个顺序） */
export const METRIC_IDS = METRICS.map((m) => m.id);
export const orderedSel = (list) => METRIC_IDS.filter((id) => (list || []).includes(id));
export const overlayAllowed = () => METRIC_IDS.slice(); // 兼容旧引用

export const PRESETS = [
  { id: "1m", label: "近1月", short: "1月", months: 1 },
  { id: "3m", label: "近3月", short: "3月", months: 3 },
  { id: "6m", label: "近6月", short: "6月", months: 6 },
  { id: "1y", label: "近1年", short: "1年", months: 12 },
  { id: "3y", label: "近3年", short: "3年", months: 36 },
  { id: "5y", label: "近5年", short: "5年", months: 60 },
  { id: "ytd", label: "年初至今", short: "今年" },
  { id: "all", label: "全部", short: "全部" },
];

export const DEFAULT_PRESET = "1y"; // 新访客默认看近一年
const WATCH_KEY = "etf-watch";
const maxCompare = () => (isDesktop() ? 8 : 4);

/* ------------------------------- 状态 ------------------------------- */
export const state = {
  taxonomy: "v2", // v2（默认）| legacy（原看板口径）
  view: "overview", // overview | cat | watch
  cat: null,
  sub: null, // 抽屉打开的小类
  metric: "shares", // 非聚焦态的单选指标
  metricSel: ["shares"], // 聚焦态：选中的指标集合（≥1，顺序=选择顺序）
  focusLayout: "axes", // 聚焦布局：axes（叠加多轴，默认）| panes（分面）
  norm: "win", // 变化率基准：win（区间首日）| all（全历史首日）
  preset: DEFAULT_PRESET,
  custom: null, // {from,to} 自定义区间（≤ 日历范围）
  compare: [], // 对比小类（2–8 个，移动端 4）
  compareHidden: [], // 对比模式下被图例关掉的系列
  catTableExpanded: false, // 本类明细表是否展开全部行
  overlay: [], // 旧字段，保留以兼容老链接（不再写入）
  showAll: false, // 单系列聚焦时叠加的指标：scale / flow / pct
  log: false, // 对数坐标（份额/规模）
  focused: null, // 图例聚焦的系列名
  marketMetric: "scale", // 市场图指标：scale | shares
  allMetric: "shares", // 全部小类表：shares | scale
  allSign: "all", // all | in | out
  allQuery: "",
  allSort: { key: "delta", dir: -1 },
  catSort: { key: "pct", dir: -1 },
  topSort: { in: { key: "delta", dir: -1 }, out: { key: "delta", dir: 1 } },
  watch: [],
  calendar: [], // 交易日（ISO 升序）
  rangeInfo: { from: "—", to: "—", days: 0, fromIdx: -1, toIdx: -1, preset: "1y", isCustom: false },
  ready: false,
};

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}
export function emit(evt, payload) {
  listeners.get(evt)?.forEach((fn) => {
    try {
      fn(payload);
    } catch (e) {
      console.error("[state]", evt, e);
    }
  });
}

/* ------------------------------- 日历 ------------------------------- */
/** 把当前区间写入 state.rangeInfo（视图层统一读它） */
export function syncRangeInfo() {
  state.rangeInfo = range();
  return state.rangeInfo;
}

export function setCalendar(dates) {
  if (!Array.isArray(dates) || !dates.length) return;
  state.calendar = dates.slice();
  clampCustom();
  syncRangeInfo();
}

export const hasCalendar = () => state.calendar.length > 2;
export const lastDate = () => state.calendar[state.calendar.length - 1] || null;

/** 二分：第一个 >= target 的下标 */
export function lowerBound(dates, target) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function indexOfDate(d) {
  const i = lowerBound(state.calendar, d);
  return state.calendar[i] === d ? i : -1;
}

function presetRange(preset) {
  const dates = state.calendar;
  if (dates.length < 2) return null;
  const toIdx = dates.length - 1;
  const to = dates[toIdx];
  if (preset === "all") return { fromIdx: 0, toIdx, from: dates[0], to, preset: "all" };
  if (preset === "ytd") {
    const year = to.slice(0, 4) + "-01-01";
    const i = lowerBound(dates, year);
    return { fromIdx: Math.min(i, toIdx - 1), toIdx, from: dates[Math.min(i, toIdx - 1)], to, preset: "ytd" };
  }
  const meta = PRESETS.find((p) => p.id === preset) || PRESETS[0];
  const target = addMonths(to, -(meta.months || 1));
  let i = lowerBound(dates, target);
  i = clamp(i, 0, toIdx - 1);
  return { fromIdx: i, toIdx, from: dates[i], to, preset: meta.id };
}

function clampCustom() {
  if (!state.custom || state.calendar.length < 2) return;
  const dates = state.calendar;
  let i = indexOfDate(state.custom.from);
  if (i < 0) i = clamp(lowerBound(dates, state.custom.from), 0, dates.length - 2);
  let j = indexOfDate(state.custom.to);
  if (j < 0) j = clamp(lowerBound(dates, state.custom.to) - 1, 1, dates.length - 1);
  if (j <= i) j = Math.min(dates.length - 1, i + 1);
  state.custom = { from: dates[i], to: dates[j] };
}

/** 当前生效区间（永远对齐到真实交易日下标） */
export function range() {
  const dates = state.calendar;
  if (dates.length < 2) {
    const from = state.custom?.from || "—";
    const to = state.custom?.to || "—";
    return { from, to, fromIdx: -1, toIdx: -1, days: 0, preset: state.custom ? "custom" : state.preset, isCustom: !!state.custom };
  }
  if (state.custom) {
    clampCustom();
    const fromIdx = indexOfDate(state.custom.from);
    const toIdx = indexOfDate(state.custom.to);
    return {
      from: state.custom.from,
      to: state.custom.to,
      fromIdx,
      toIdx,
      days: Math.max(1, toIdx - fromIdx + 1),
      preset: "custom",
      isCustom: true,
      defaultOf: state.preset,
    };
  }
  const r = presetRange(state.preset) || presetRange("all");
  return {
    from: r.from,
    to: r.to,
    fromIdx: r.fromIdx,
    toIdx: r.toIdx,
    days: r.toIdx - r.fromIdx + 1,
    preset: r.preset,
    isCustom: false,
  };
}

/** 预设区间的实际首末（用于判断"是否已回到默认"） */
export function rangeOfPreset(preset) {
  return presetRange(preset);
}

export function setPreset(preset, { silent = false } = {}) {
  if (!PRESETS.some((p) => p.id === preset)) preset = DEFAULT_PRESET;
  state.preset = preset;
  state.custom = null;
  if (!silent) emit("range", { source: "preset" });
}

export function setCustomRange(from, to, { silent = false } = {}) {
  if (!from || !to) return;
  if (from > to) [from, to] = [to, from];
  state.custom = { from, to };
  clampCustom();
  if (!silent) emit("range", { source: "custom" });
}

export function resetRange() {
  state.custom = null;
  state.preset = DEFAULT_PRESET;
  emit("range", { source: "reset" });
}

/* ------------------------------- 自选（按口径独立） ------------------------------- */
const watchKey = (tax = state.taxonomy) => `ebbflow-watch::${tax === "legacy" ? "legacy" : "v2"}`;

/** 迁移旧键：老数据归到 legacy 口径下 */
function migrateWatch() {
  try {
    if (localStorage.getItem(watchKey("legacy"))) return;
    // 兼容两代旧键：etf-watch / ebbflow-watch → 归到 legacy 口径
    for (const legacyKey of ["ebbflow-watch", WATCH_KEY]) {
      const old = localStorage.getItem(legacyKey);
      if (!old) continue;
      localStorage.setItem(watchKey("legacy"), old);
      localStorage.removeItem(legacyKey);
      break;
    }
  } catch (e) {
    /* 忽略 */
  }
}

export function loadWatch(tax = state.taxonomy) {
  migrateWatch();
  try {
    const raw = localStorage.getItem(watchKey(tax));
    const arr = raw ? JSON.parse(raw) : [];
    state.watch = Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch (e) {
    state.watch = [];
  }
  return state.watch;
}

export function saveWatch() {
  try {
    localStorage.setItem(watchKey(), JSON.stringify(state.watch));
  } catch (e) {
    /* 隐私模式下可能失败，忽略 */
  }
  emit("watch", state.watch.slice());
}

/** 另一套口径里的自选（用于「另有 N 个在另一套口径中」） */
export function otherWatch(tax = state.taxonomy) {
  try {
    const other = tax === "legacy" ? "v2" : "legacy";
    const raw = localStorage.getItem(watchKey(other));
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    return list.filter((n) => !state.watch.includes(n));
  } catch (e) {
    return [];
  }
}

export const inWatch = (name) => state.watch.includes(name);

export function toggleWatch(name) {
  if (!name) return false;
  const i = state.watch.indexOf(name);
  let added;
  if (i >= 0) {
    state.watch.splice(i, 1);
    added = false;
  } else {
    state.watch.push(name);
    added = true;
  }
  saveWatch();
  return added;
}

export function removeWatch(name) {
  const i = state.watch.indexOf(name);
  if (i >= 0) {
    state.watch.splice(i, 1);
    saveWatch();
  }
}

/* ------------------------------- 单系列聚焦 + 指标选择 ------------------------------- */
const FOCUS_LAYOUT_KEY = "ebbflow-focus-layout";

/** 聚焦布局：axes（默认，多轴叠加）/ panes（分面）；记住上次选择 */
export function setFocusLayout(layout, { silent = false } = {}) {
  const next = layout === "axes" ? "axes" : "panes";
  if (state.focusLayout === next) return next;
  state.focusLayout = next;
  try {
    localStorage.setItem(FOCUS_LAYOUT_KEY, next);
  } catch (e) {
    /* ignore */
  }
  if (!silent) emit("focusLayout", next);
  return next;
}
export const focusActive = () => !!(state.sub && state.view === "cat");

/** 聚焦某个小类（同时用于图例聚焦与 URL 的 sub=） */
export function setFocus(name, { silent = false } = {}) {
  if (!name) return;
  if (state.sub === name) return;
  state.sub = name;
  if (!state.metricSel.length) state.metricSel = [state.metric];
  if (!silent) emit("focus", name);
}

export function clearFocus({ silent = false } = {}) {
  state.sub = null;
  if (!silent) emit("focus", null);
}

/** 规范化并写入聚焦态选中集合（至少 1 项，按固定顺序） */
export function setMetricSel(list, { silent = false } = {}) {
  // 保留用户点选顺序：第 1 个选中的指标排第 1 条轴（左右交替），不预设主次
  const seen = new Set();
  const sel = [];
  for (const id of list || []) {
    if (!METRIC_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    sel.push(id);
  }
  state.metricSel = sel.length ? sel : [state.metric];
  if (!silent) emit("metricSel", state.metricSel.slice());
}

/** 返回 { changed, sel, reason }：invalid / min（不能一个都不选）/ limit（小屏上限） */
export function toggleMetricSel(id, { max = Infinity } = {}) {
  if (!METRIC_IDS.includes(id)) return { changed: false, sel: state.metricSel.slice(), reason: "invalid" };
  const has = state.metricSel.includes(id);
  if (has) {
    if (state.metricSel.length <= 1) return { changed: false, sel: state.metricSel.slice(), reason: "min" };
    state.metricSel = state.metricSel.filter((m) => m !== id);
  } else {
    if (state.metricSel.length >= max) return { changed: false, sel: state.metricSel.slice(), reason: "limit" };
    state.metricSel = [...state.metricSel, id];
  }
  emit("metricSel", state.metricSel.slice());
  return { changed: true, sel: state.metricSel.slice() };
}

/* ------------------------------- 对比 ------------------------------- */
export function toggleCompare(name) {
  if (!name) return { ok: false, reason: "empty" };
  const i = state.compare.indexOf(name);
  if (i >= 0) {
    state.compare.splice(i, 1);
    state.compareHidden = state.compareHidden.filter((n) => n !== name);
    emit("compare", state.compare.slice());
    return { ok: true, added: false, count: state.compare.length };
  }
  if (state.compare.length >= maxCompare()) {
    return { ok: false, reason: "limit", max: maxCompare() };
  }
  state.compare.push(name);
  emit("compare", state.compare.slice());
  return { ok: true, added: true, count: state.compare.length };
}

export function setCompare(list) {
  const seen = new Set();
  const next = [];
  for (const n of list || []) {
    if (typeof n !== "string" || seen.has(n)) continue;
    seen.add(n);
    next.push(n);
    if (next.length >= maxCompare()) break;
  }
  state.compare = next;
  state.compareHidden = state.compareHidden.filter((n) => next.includes(n));
  emit("compare", state.compare.slice());
  return next;
}

export const compareLimit = () => maxCompare();


export function clearCompare() {
  state.compare = [];
  state.compareHidden = [];
  state.focused = null;
  emit("compare");
}

/* ------------------------------- URL ------------------------------- */
const VALID_VIEWS = new Set(["overview", "cat", "watch"]);

export function readURL() {
  const p = new URLSearchParams(location.search);
  // 分类口径：URL 优先，其次 localStorage，默认 v2
  const tax = p.get("taxonomy");
  if (tax === "legacy" || tax === "v2") state.taxonomy = tax;
  else {
    try {
      const saved = localStorage.getItem("ebbflow-taxonomy");
      state.taxonomy = saved === "legacy" ? "legacy" : "v2";
    } catch (e) {
      state.taxonomy = "v2";
    }
  }
  const view = p.get("view");
  state.view = VALID_VIEWS.has(view) ? view : "overview";
  state.cat = p.get("cat") || null;
  const mRaw = p.get("metric") || p.get("m") || "";
  const ovRaw = p.get("overlay") || "";
  let sel = mRaw
    .split(",")
    .map((x) => x.trim())
    .filter((x) => METRIC_IDS.includes(x));
  // 兼容旧链接：?metric=shares&overlay=flow,pct
  if (ovRaw) sel = sel.concat(ovRaw.split(",").map((x) => x.trim()).filter((x) => METRIC_IDS.includes(x)));
  setMetricSel(sel, { silent: true });
  state.metric = state.metricSel[0];
  const layout = p.get("layout");
  if (layout === "panes" || layout === "axes") state.focusLayout = layout;
  else {
    try {
      state.focusLayout = localStorage.getItem(FOCUS_LAYOUT_KEY) === "panes" ? "panes" : "axes";
    } catch (e) {
      state.focusLayout = "axes";
    }
  }
  state.overlay = [];
  state.norm = p.get("norm") === "all" ? "all" : "win";
  state.log = p.get("log") === "1";
  state.sub = p.get("sub") || null;
  const cmpRaw = p.get("compare") || p.get("cmp") || "";
  const cmps = cmpRaw
    .split(cmpRaw.includes(",") ? "," : "|")
    .map((x) => x.trim())
    .filter(Boolean);
  state.compare = Array.from(new Set(cmps)).slice(0, maxCompare());
  state.compareHidden = [];

  const from = p.get("from");
  const to = p.get("to");
  const r = p.get("r");
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    state.custom = { from, to };
    state.preset = PRESETS.some((x) => x.id === r) ? r : DEFAULT_PRESET;
  } else {
    state.custom = null;
    state.preset = PRESETS.some((x) => x.id === r) ? r : DEFAULT_PRESET;
  }
  if (state.view === "cat" && !state.cat) state.view = "overview";
}

export function writeURL({ push = false, replace = true } = {}) {
  const p = new URLSearchParams();
  if (state.taxonomy === "legacy") p.set("taxonomy", "legacy");
  if (state.view !== "overview") p.set("view", state.view);
  if (state.view === "cat" && state.cat) p.set("cat", state.cat);
  if (state.cat && state.view !== "cat") p.set("cat", state.cat);
  if (state.custom) {
    p.set("from", state.custom.from);
    p.set("to", state.custom.to);
    if (state.preset !== DEFAULT_PRESET) p.set("r", state.preset);
  } else if (state.preset !== DEFAULT_PRESET) {
    p.set("r", state.preset);
  }
  if (state.sub && state.view === "cat") {
    if (state.metricSel.join(",") !== "shares") p.set("metric", state.metricSel.join(","));
    if (state.focusLayout === "axes") p.set("layout", "axes");
  } else if (state.metric !== "shares") {
    p.set("metric", state.metric);
  }
  if (state.norm === "all") p.set("norm", "all");
  if (state.log) p.set("log", "1");
  if (state.sub) p.set("sub", state.sub);
  if (state.compare.length) p.set("compare", state.compare.join(","));
  // metric 用逗号分隔更可读：URLSearchParams 会把 , 编码成 %2C，这里还原
  const qs = p.toString().replace(/%2C/g, ",");
  const url = location.pathname + (qs ? "?" + qs : "") + location.hash;
  if (url === location.pathname + location.search + location.hash) return;
  try {
    if (push) history.pushState({ t: "nav" }, "", url);
    else if (replace) history.replaceState({ t: "state" }, "", url);
  } catch (e) {
    /* file:// 下可能受限，忽略 */
  }
}

/* ------------------------------- 派生：区间统计 ------------------------------- */
/**
 * 从 subs.json 计算任意区间的小类/大类统计（份额口径）。
 * 返回的 series 已裁剪到区间内，供 sparkline 与迷你图使用。
 */
export function computeStats(subsPayload, r = range()) {
  const dates = state.calendar;
  const out = { subs: [], byName: new Map(), cats: [], byCat: new Map(), from: r.from, to: r.to, days: r.days, fromIdx: r.fromIdx, toIdx: r.toIdx };
  if (!subsPayload || r.fromIdx < 0) return out;

  const catAcc = new Map();

  for (const [name, entry] of Object.entries(subsPayload)) {
    const srcDates = Array.isArray(entry.dates) && entry.dates.length ? entry.dates : dates;
    const values = entry.values || [];
    if (!values.length) continue;

    // 不同来源的 dates 可能不等长：建立 date → value 的映射后按全局日历取
    let at;
    if (srcDates === dates || (srcDates.length === dates.length && srcDates[0] === dates[0] && srcDates[srcDates.length - 1] === dates[dates.length - 1])) {
      at = (i) => values[i];
    } else {
      const map = new Map(srcDates.map((d, i) => [d, values[i]]));
      at = (i) => map.get(dates[i]);
    }

    let first = null;
    let firstIdx = -1;
    for (let i = r.fromIdx; i <= r.toIdx; i++) {
      const v = at(i);
      if (v != null && Number.isFinite(+v)) {
        first = +v;
        firstIdx = i;
        break;
      }
    }
    let last = null;
    let lastIdx = -1;
    for (let i = r.toIdx; i >= r.fromIdx; i--) {
      const v = at(i);
      if (v != null && Number.isFinite(+v)) {
        last = +v;
        lastIdx = i;
        break;
      }
    }
    if (first == null || last == null) continue;

    const series = [];
    for (let i = r.fromIdx; i <= r.toIdx; i++) {
      const v = at(i);
      series.push(v == null || !Number.isFinite(+v) ? null : +v);
    }
    const delta = last - first;
    const pct = first !== 0 ? (delta / Math.abs(first)) * 100 : null;
    const rec = {
      name,
      cat: entry.cat,
      color: entry.color,
      first,
      last,
      delta,
      pct,
      series,
      firstIdx,
      lastIdx,
      scale: entry.scale ?? null,
      flow: entry.flow ?? null,
      etfCount: entry.etfs?.length || 0,
      navCoverage: entry.navCoverage || null,
    };
    out.subs.push(rec);
    out.byName.set(name, rec);

    // 大类聚合：各日求和（null 跳过）
    if (!catAcc.has(entry.cat)) catAcc.set(entry.cat, { series: new Array(r.days).fill(0), count: 0 });
    const acc = catAcc.get(entry.cat);
    acc.count += 1;
    for (let i = 0; i < series.length; i++) {
      if (series[i] != null) acc.series[i] += series[i];
    }
  }

  for (const [key, acc] of catAcc) {
    const series = acc.series.map((v) => (Number.isFinite(v) ? v : 0));
    let first = null;
    let last = null;
    for (const v of series) if (v) { first = v; break; }
    for (let i = series.length - 1; i >= 0; i--) if (series[i]) { last = series[i]; break; }
    if (first == null) first = series[0] || 0;
    if (last == null) last = series[series.length - 1] || 0;
    const delta = last - first;
    const rec = {
      key,
      count: acc.count,
      series,
      first,
      last,
      delta,
      pct: first ? (delta / Math.abs(first)) * 100 : null,
      scale: null,
      flow: null,
    };
    out.cats.push(rec);
    out.byCat.set(key, rec);
  }
  return out;
}

/** 区间内涨跌排名（1 起） */
export function rankOf(stats, name, key = "pct") {
  const arr = stats.subs.filter((s) => Number.isFinite(s[key])).sort((a, b) => b[key] - a[key]);
  const i = arr.findIndex((s) => s.name === name);
  return i < 0 ? null : { rank: i + 1, total: arr.length };
}

/** 市场合计的区间变化（用 market.json 的 total 序列） */
export function marketRangeStats(market, r = range()) {
  if (!market?.total?.shares || r.fromIdx < 0) return null;
  const slice = (arr) => (Array.isArray(arr) ? arr.slice(r.fromIdx, r.toIdx + 1) : []);
  const shares = slice(market.total.shares);
  const scale = slice(market.total.scale);
  const pick = (arr) => {
    const first = arr.find((v) => v != null && Number.isFinite(+v));
    let last = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null && Number.isFinite(+arr[i])) {
        last = +arr[i];
        break;
      }
    }
    if (first == null || last == null) return { first: null, last: null, delta: null, pct: null };
    return { first: +first, last, delta: last - +first, pct: +first ? ((last - +first) / Math.abs(+first)) * 100 : null };
  };
  const sh = pick(shares);
  const sc = pick(scale);
  return {
    shares: { ...sh, series: shares },
    scale: { ...sc, series: scale },
    sh: { shares: slice(market.sh?.shares), scale: slice(market.sh?.scale) },
    sz: { shares: slice(market.sz?.shares), scale: slice(market.sz?.scale) },
    dates: state.calendar.slice(r.fromIdx, r.toIdx + 1),
  };
}
