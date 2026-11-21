/* =============================================================================
 * ETF 细分行业资金流向 · 前端应用（原生 ESM，无构建、无依赖）
 *
 * 数据来自同目录 data/*.json（静态优先），失败时回退 /api/*。
 * 模块分段：
 *    0. 通用工具      1. 全局状态        2. 数据加载
 *    3. 顶栏渲染      4. 表格（排序）    5. 图表
 *    6. 搜索          7. 抽屉            8. CSV 导出
 *    9. URL 状态     10. 主题           11. 刷新
 *   12. 引导
 * ========================================================================== */

/* ------------------------------- 0. 通用工具 ------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** HTML 转义（数据虽来自本地构建，但 ETF 名称等仍是外部字符串） */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** 消除 -0 / 极小值，避免出现 "-0.0" */
function tidy(v) {
  if (v == null || !Number.isFinite(+v)) return null;
  const n = +v;
  return Math.abs(n) < 1e-9 ? 0 : n;
}

/** 份额：1 位小数 */
const n1 = (v) => (tidy(v) == null ? "—" : tidy(v).toFixed(1));
/** 百分比：2 位小数带正负号 */
const p2 = (v) => (tidy(v) == null ? "—" : (tidy(v) >= 0 ? "+" : "") + tidy(v).toFixed(2) + "%");
/** 变化量：1 位小数带正负号 */
const s1 = (v) => (tidy(v) == null ? "—" : (tidy(v) >= 0 ? "+" : "") + tidy(v).toFixed(1));
/** 涨跌配色 class（涨红跌绿） */
const ud = (v) => (tidy(v) == null ? "" : tidy(v) > 0 ? "up" : tidy(v) < 0 ? "down" : "");

/** 口径单位：优先用 meta.metricUnits（份额=亿份、规模/净流入=亿元），缺省给兜底 */
function unit(key, dflt) {
  const u = S.meta?.metricUnits?.[key];
  return typeof u === "string" && u ? u : dflt;
}
const U_SHARES = () => unit("shares", "亿份");
const U_SCALE = () => unit("scale", "亿元");
const U_FLOW = () => unit("flow", "亿元");

/** meta.metrics 声明了哪些口径；老数据没有该字段时按「有」处理 */
function hasMetric(key) {
  const m = S.meta?.metrics;
  if (Array.isArray(m) && m.length) return m.includes(key);
  return true;
}

const ymd = (s) => String(s ?? "").slice(0, 10);
const mmdd = (s) => String(s ?? "").slice(5);
const hhmm = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** "YYYY-MM-DD" → 当天 0 点的 UTC 毫秒（避免时区漂移） */
function dayMs(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

function debounce(fn, wait = 120) {
  let t = 0;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), wait);
  };
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

/** 轻量提示条 */
let toastTimer = 0;
function toast(msg, kind = "") {
  const host = $("#toastHost");
  if (!host) return;
  host.innerHTML = `<div class="toast ${kind}">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (host.innerHTML = ""), kind === "err" ? 6000 : 3600);
}

function download(name, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

/* 区间定义：years 按自然年回溯，days 按自然日回溯 */
const RANGES = [
  { key: "1y", label: "1年", unit: "years", n: 1 },
  { key: "3y", label: "3年", unit: "years", n: 3 },
  { key: "5y", label: "5年", unit: "years", n: 5 },
  { key: "7d", label: "近7日", unit: "days", n: 7 },
  { key: "30d", label: "近30日", unit: "days", n: 30 },
  { key: "90d", label: "近90日", unit: "days", n: 90 },
];
const RANGE_MAP = new Map(RANGES.map((r) => [r.key, r]));
const DEFAULT_RANGE = "3y";

/* 大类 Tab 的排列顺序（与原站一致；发现的新 key 追加在后面） */
const TAB_ORDER = ["1_宽基市场", "2_风格策略", "3_科技", "4_制造", "5_能源", "6_资源", "7_消费", "7_医药", "8_金融地产", "9_债券"];

/* --------------------------------- 1. 状态 -------------------------------- */

const S = {
  meta: null,
  tables: null,
  index: null, // {subs:[{name,cat,label}], etfs:[{code,name,subs[]}]}
  subs: null, // data/subs.json 懒加载
  subPromise: null,
  charts: new Map(), // catKey -> charts-<catKey>.json
  chartReq: new Map(), // 正在加载的 Promise
  cats: [], // [{key,label,color}] Tab 列表
  cat: null,
  range: DEFAULT_RANGE,
  sub: null, // 搜索结果高亮 / 抽屉中的小类
  highlight: null, // 待高亮的系列名
  theme: "auto",
  echarts: null,
  dataMode: "loading", // loading | static | live
  fatal: false,
};

/* 小类 → 大类 的映射（来自 index.json，供搜索/抽屉用） */
const subCat = new Map();
const etfSubs = new Map(); // code -> [subName]

/* ------------------------------ 2. 数据加载 ------------------------------- */

/** 拉 JSON；`bust` 用于刷新后绕过缓存 */
async function getJSON(url, { bust = false } = {}) {
  const u = bust ? url + (url.includes("?") ? "&" : "?") + "t=" + Date.now() : url;
  const res = await fetch(u, { cache: bust ? "no-store" : "default", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}

/** 静态优先，失败回退 /api/*。返回 {data, via} */
async function getData(name, apiPath, opts) {
  try {
    return { data: await getJSON(`data/${name}`, opts), via: "data" };
  } catch (e) {
    const r = await getJSON(apiPath, opts); // 这里再抛就一路抛上去
    return { data: r, via: "api" };
  }
}

/** 取某个大类的图表数据（带缓存与并发合并） */
function loadCatChart(catKey) {
  if (S.charts.has(catKey)) return Promise.resolve(S.charts.get(catKey));
  if (S.chartReq.has(catKey)) return S.chartReq.get(catKey);
  const p = (async () => {
    const { data, via } = await getData(`charts-${catKey}.json`, `/api/charts/${encodeURIComponent(catKey)}`);
    if (via === "api") noteApiFallback();
    S.charts.set(catKey, data);
    return data;
  })();
  S.chartReq.set(catKey, p);
  return p.finally(() => S.chartReq.delete(catKey));
}

/** 懒加载 subs.json（首次打开抽屉时用，空闲时预取） */
function loadSubs() {
  if (S.subs) return Promise.resolve(S.subs);
  if (S.subPromise) return S.subPromise;
  S.subPromise = (async () => {
    const { data, via } = await getData("subs.json", "/api/subs");
    if (via === "api") noteApiFallback();
    S.subs = data || {};
    return S.subs;
  })();
  return S.subPromise;
}

let apiFallbackNoted = false;
function noteApiFallback() {
  if (apiFallbackNoted) return;
  apiFallbackNoted = true;
  setDataBadge("api");
}

/** 取某个小类的日期轴（兼容两种结构：dates 在每个小类里，或提到 subs.json 顶层共用） */
function subDates(rec) {
  return rec?.dates || S.subs?.__dates || S.subs?.dates || [];
}

/* ------------------------------- 3. 顶栏渲染 ------------------------------ */

function renderHeader() {
  const m = S.meta || {};
  const title = m.title || "ETF 细分行业资金流向";
  document.title = title;
  $("#pageTitle").textContent = title;

  const r = m.range || {};
  const rc = m.recent || {};
  const parts = [];
  if (r.from && r.to) parts.push(`数据区间 ${ymd(r.from)} ~ ${ymd(r.to)}（${r.days ?? "?"} 个交易日，最多展示 5 年）`);
  if (rc.from && rc.to) parts.push(`近期区间 ${ymd(rc.from)} ~ ${ymd(rc.to)}（${rc.days ?? "?"} 个交易日）`);
  $("#subLine").textContent = parts.join(" ｜ ") || "数据区间未知";

  const chips = [];
  if (m.lastTradeDate) chips.push(`<span class="chip"><b>最新交易日</b>${esc(ymd(m.lastTradeDate))}</span>`);
  if (m.updatedAt) chips.push(`<span class="chip"><b>数据更新</b>${esc(hhmm(m.updatedAt))}</span>`);
  const cnt = m.counts || {};
  if (cnt.subs || cnt.etfs) {
    chips.push(`<span class="chip"><b>覆盖</b>${cnt.subs ?? "?"} 个小类 / ${cnt.etfs ?? "?"} 只 ETF</span>`);
  }
  if (Array.isArray(m.sources) && m.sources.length) {
    chips.push(`<span class="chip"><b>数据源</b>${esc(m.sources.join(" / "))}</span>`);
  }
  $("#metaChips").innerHTML = chips.join("");

  if (Array.isArray(m.warnings) && m.warnings.length) {
    const w = el("p", "notice notice-warn", `⚠ ${m.warnings.map(esc).join("；")}`);
    $(".notice")?.after(w);
  }

  const foot = $("#footNote");
  if (foot) {
    const bits = ["数据来自交易所公开接口，仅供研究参考。"];
    if (m.lastTradeDate) bits.push(`最新交易日 ${ymd(m.lastTradeDate)}`);
    if (m.updatedAt) bits.push(`生成于 ${hhmm(m.updatedAt)}`);
    foot.textContent = bits.join(" · ");
  }
}

function setDataBadge(mode, text) {
  S.dataMode = mode;
  const b = $("#dataSource");
  if (!b) return;
  b.dataset.mode = mode;
  b.textContent =
    text ||
    { loading: "加载中…", static: "静态快照", live: "实时服务已连接", api: "接口回退模式" }[mode] ||
    mode;
}

/** 从 index.json / tables.json 推导 Tab 列表 */
function deriveCats() {
  const seen = new Map();
  const add = (key, label) => {
    if (!key || seen.has(key)) return;
    seen.set(key, { key, label: label || key.replace("_", "."), color: "" });
  };
  // 1) index.json：每个小类带着自己的大类
  for (const s of S.index?.subs || []) add(s.cat);
  // 2) tables.json：补齐（跳过合并出来的 7_医药&消费 这类伪大类）
  for (const c of S.tables?.cats || []) {
    if (String(c.key).includes("&")) continue;
    add(c.key, c.label);
  }
  const rank = (k) => {
    const i = TAB_ORDER.indexOf(k);
    return i >= 0 ? i : TAB_ORDER.length + 999;
  };
  const list = [...seen.values()].sort((a, b) => {
    const d = rank(a.key) - rank(b.key);
    if (d) return d;
    const na = parseInt(a.key, 10);
    const nb = parseInt(b.key, 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.key.localeCompare(b.key, "zh-Hans-CN");
  });
  S.cats = list;
}

/* ------------------------------- 4. 表格（排序） --------------------------- */

const TBL = new Map(); // id -> {rows, sortKey, sortDir, renderRow, ready}

/**
 * 注册一张可排序表格。
 * renderRow(row, index) → <tr> 内部 HTML（不含 tr 标签）
 */
function initTable(id, renderRow) {
  const tbl = document.getElementById(id);
  if (!tbl) return null;
  const st = { el: tbl, rows: [], sortKey: null, sortDir: -1, renderRow, ready: false };
  TBL.set(id, st);
  $$("th[data-sort]", tbl).forEach((th) => {
    th.classList.add("sortable");
    th.tabIndex = 0;
    th.setAttribute("role", "button");
    const onSort = () => {
      const k = th.dataset.sort;
      const isText = th.dataset.type === "text";
      if (st.sortKey === k) st.sortDir = -st.sortDir;
      else {
        st.sortKey = k;
        st.sortDir = isText ? 1 : -1;
      }
      paintTable(id);
    };
    th.addEventListener("click", onSort);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSort();
      }
    });
  });
  return st;
}

function sortRows(st) {
  const rows = [...st.rows];
  if (!st.sortKey) return rows;
  const k = st.sortKey;
  const dir = st.sortDir;
  const isText = typeof rows[0]?.[k] === "string" && !/^-?\d/.test(rows[0]?.[k] ?? "");
  return rows.sort((a, b) => {
    if (isText) return String(a[k] ?? "").localeCompare(String(b[k] ?? ""), "zh-Hans-CN") * dir;
    const av = tidy(a[k]);
    const bv = tidy(b[k]);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // 空值永远沉底
    if (bv == null) return -1;
    return (av - bv) * dir;
  });
}

function paintTable(id) {
  const st = TBL.get(id);
  if (!st) return;
  const tbody = st.el.tBodies[0];
  const rows = sortRows(st);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td class="tbl-empty" colspan="9">暂无数据</td></tr>`;
  } else {
    tbody.innerHTML = rows.map((r, i) => `<tr data-i="${i}">${st.renderRow(r, i)}</tr>`).join("");
  }
  $$("th[data-sort]", st.el).forEach((th) => {
    const on = th.dataset.sort === st.sortKey;
    th.classList.toggle("sorted", on);
    th.classList.toggle("asc", on && st.sortDir === 1);
    th.setAttribute("aria-sort", on ? (st.sortDir === 1 ? "ascending" : "descending") : "none");
    const arrow = $(".sarrow", th);
    if (arrow) arrow.textContent = on ? (st.sortDir === 1 ? "▲" : "▼") : "";
  });
  st.ready = true;
}

function fillTable(id, rows) {
  const st = TBL.get(id);
  if (!st) return;
  st.rows = rows || [];
  paintTable(id);
}

/* --------------------------------- 5. 图表 -------------------------------- */

/** 取出当前主题下用于 ECharts 的配色（跟随 CSS 变量） */
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (name, dflt) => (cs.getPropertyValue(name) || "").trim() || dflt;
  return {
    text: g("--text", "#1f2328"),
    muted: g("--muted", "#57606a"),
    border: g("--border", "#d0d7de"),
    grid: g("--grid", "#eaeef2"),
    panel: g("--panel", "#ffffff"),
  };
}

/** 区间 → 起始下标（含） */
function startIndex(dates, rangeKey) {
  const R = RANGE_MAP.get(rangeKey);
  if (!R || !dates.length) return 0;
  const lastMs = dayMs(dates[dates.length - 1]);
  let cut;
  if (R.unit === "years") {
    const d = new Date(lastMs);
    d.setUTCFullYear(d.getUTCFullYear() - R.n);
    cut = d.getTime();
  } else {
    cut = lastMs - R.n * 86400000;
  }
  for (let i = 0; i < dates.length; i++) if (dayMs(dates[i]) >= cut) return i;
  return Math.max(0, dates.length - 1);
}

/** 按区间裁剪一组 {name,color,values} */
function sliceSeries(series, start) {
  return series.map((s) => ({
    name: s.name,
    color: s.color,
    values: Array.isArray(s.values) ? s.values.slice(start) : [],
  }));
}

/** 把百分比序列线性缩放到「首个有效值 = 100」 */
function percentToWindow(s) {
  let base = null;
  for (const v of s.values) {
    const t = tidy(v);
    if (t != null && t !== 0) {
      base = t;
      break;
    }
  }
  if (!base) return s;
  return { name: s.name, color: s.color, values: s.values.map((v) => (tidy(v) == null ? null : (tidy(v) / base) * 100)) };
}

/**
 * 渲染一张折线图。
 * cfg: {dates, series, percent, shortDates}
 * 返回 'ok' | 'empty'
 */
function renderChart(hostId, cfg, { percent = false, shortDates = false, range = S.range, highlight = null } = {}) {
  const elHost = document.getElementById(hostId);
  if (!elHost || !S.echarts) return "empty";
  const allDates = cfg.dates || [];
  if (!allDates.length || !(cfg.series || []).length) return "empty";

  const start = shortDates ? 0 : startIndex(allDates, range);
  const dates = allDates.slice(start);
  let series = sliceSeries(cfg.series, start).filter((s) => s.values.some((v) => tidy(v) != null));
  if (!series.length) return "empty";

  // 百分比曲线：把「区间首日」拉回 100%。
  // 数据里的 c2/c3 已是百分比，这里只做线性缩放（不重新从 c1 推导），
  // 效果等价于原站 ratesFromFirstPositive(窗口内切片)，保证短区间也看得清变化。
  if (percent) series = series.map(percentToWindow);

  const C = themeColors();
  const charts = (S._inst = S._inst || new Map());
  let chart = charts.get(hostId);
  if (!chart || chart.isDisposed?.()) {
    chart = S.echarts.init(elHost, null, { renderer: "canvas" });
    charts.set(hostId, chart);
    watchResize(elHost, chart);
    bindChartEvents(chart, hostId);
  }

  // 窄屏（手机）压缩留白，把宽度让给曲线；右侧留给 endLabel
  const narrow = elHost.clientWidth > 0 && elHost.clientWidth < 560;

  const option = {
    backgroundColor: "transparent",
    animation: false,
    legend: {
      type: "scroll",
      top: 6,
      left: 12,
      right: 132,
      itemWidth: 14,
      itemHeight: 8,
      itemGap: 12,
      icon: "roundRect",
      textStyle: { color: C.muted, fontSize: 11 },
      pageIconSize: 10,
      pageTextStyle: { color: C.muted },
    },
    grid: narrow
      ? { left: 46, right: 92, top: 56, bottom: 34 }
      : { left: 60, right: 132, top: 58, bottom: 40 },
    tooltip: {
      trigger: "axis",
      backgroundColor: C.panel,
      borderColor: C.border,
      textStyle: { color: C.text, fontSize: 12 },
      extraCssText: "box-shadow:0 2px 12px rgba(0,0,0,.12);border-radius:8px;",
      valueFormatter: (v) => (v == null ? "—" : Number(v).toFixed(2) + (percent ? "%" : "")),
    },
    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: C.border } },
      axisTick: { show: false },
      splitLine: { show: true, alignWithLabel: true, lineStyle: { color: C.grid, type: "dashed" } },
      axisLabel: {
        color: C.muted,
        fontSize: 11,
        formatter: shortDates ? mmdd : (v) => String(v).slice(0, 7),
        interval: shortDates ? (narrow ? 1 : 0) : "auto",
        hideOverlap: true,
      },
      axisPointer: { label: { backgroundColor: C.border, color: C.text } },
    },
    yAxis: {
      type: "value",
      scale: true,
      splitLine: { lineStyle: { color: C.grid, type: "dashed" } },
      axisLabel: { color: C.muted, fontSize: 11, formatter: percent ? "{value}%" : "{value}" },
    },
    series: series.map((s) => {
      const dim = highlight && highlight !== s.name;
      const hot = highlight && highlight === s.name;
      const item = {
        name: s.name,
        type: "line",
        data: s.values.map(tidy),
        showSymbol: !!shortDates,
        sampling: shortDates ? undefined : "lttb",
        // 让整条折线（而不只是数据点）都能响应点击 → 打开抽屉
        triggerLineEvent: true,
        symbol: "circle",
        symbolSize: 4,
        lineStyle: { width: hot ? 3.5 : 2.5, opacity: dim ? 0.14 : 0.9 },
        itemStyle: { color: s.color, opacity: dim ? 0.25 : 1 },
        color: s.color,
        z: hot ? 10 : 2,
        emphasis: { focus: "series" },
        endLabel: {
          show: true,
          precision: 0,
          formatter: (pt) => `${pt.seriesName} ${Number(pt.value).toFixed(0)}${percent ? "%" : ""}`,
          color: s.color,
          fontWeight: "bold",
          fontSize: narrow ? 10 : 11,
          backgroundColor: C.panel,
          padding: narrow ? [1, 2] : [2, 4],
          borderRadius: 3,
          overflow: "break",
        },
        labelLayout: { moveOverlap: "shiftY", hideOverlap: false },
      };
      if (percent) item.areaStyle = { color: s.color, opacity: dim ? 0.03 : 0.12, origin: 100 };
      return item;
    }),
  };

  if (percent) {
    option.series.push({
      name: "基准线",
      type: "line",
      data: [],
      silent: true,
      markLine: {
        silent: true,
        symbol: "none",
        lineStyle: { color: C.muted, type: "dashed", width: 1.5, opacity: 0.7 },
        label: { show: false },
        data: [{ yAxis: 100 }],
      },
    });
  }

  chart.setOption(option, true);
  if (highlight) {
    try {
      chart.dispatchAction({ type: "highlight", seriesName: highlight });
    } catch (e) {}
  }
  return "ok";
}

/** 容器尺寸变化自适应 */
const RO = new ResizeObserver((entries) => {
  for (const en of entries) {
    const inst = S._inst?.get(en.target.id);
    if (inst && !inst.isDisposed?.()) inst.resize();
  }
});
function watchResize(host, chart) {
  RO.observe(host);
}

/** 图表交互：点击数据点 / 图例 → 打开抽屉 */
function bindChartEvents(chart, hostId) {
  // 悬停图例/曲线时浮出该小类的 ETF 清单（不占版面）
  chart.on("highlight", (e) => {
    const box = document.getElementById(hostId)?.parentElement;
    const pop = box?.querySelector(".etf-pop");
    if (!pop) return;
    // 单选高亮给 seriesName；批量高亮（悬停图例）给 batch[0].seriesName
    const b0 = e?.batch && e.batch.length === 1 ? e.batch[0] : null;
    const name = e?.seriesName || b0?.seriesName || null;
    if (!name) return;
    const list = etfsOfSub(name);
    if (list.length) {
      pop.innerHTML = `<div><b>${esc(name)}</b> · ${list.length} 只标的</div><div class="l">${esc(list.join("，"))}</div>`;
      pop.style.display = "block";
    } else pop.style.display = "none";
  });
  chart.on("downplay", () => {
    const pop = document.getElementById(hostId)?.parentElement?.querySelector(".etf-pop");
    if (pop) pop.style.display = "none";
  });

  chart.on("click", (p) => {
    if (p.componentType === "legend") return; // 交给 legendselectchanged
    if (p.seriesName) openSub(p.seriesName);
  });

  // 点图例 = 查看详情（保持曲线可见，避免误关）
  chart.on("legendselectchanged", (p) => {
    chart.dispatchAction({ type: "legendSelect", name: p.name });
    openSub(p.name);
  });
}

function etfsOfSub(name) {
  const rec = S.subs?.[name];
  if (rec?.etfs?.length) return rec.etfs.map((e) => `${e.code} ${e.name}`);
  const out = [];
  for (const e of S.index?.etfs || []) if ((e.subs || []).includes(name)) out.push(`${e.code} ${e.name}`);
  return out;
}

/* ------------------------------ 图表区域 DOM ------------------------------ */

function buildCatSections() {
  const host = $("#charts");
  host.innerHTML = S.cats
    .map(
      (c, i) => `
    <section class="cat" id="cat-${esc(c.key)}" data-cat="${esc(c.key)}" aria-labelledby="h2-${esc(c.key)}">
      <h2 id="h2-${esc(c.key)}" style="border-left-color:#58a6ff">${esc(c.label)}</h2>
      ${card(c.key, 1, "ETF 份额变化全景分析", "")}
      ${card(c.key, 2, "长期份额变化率（区间首日 = 100%）", "")}
      ${card(c.key, 3, "近 7 个自然日内交易日份额变化率（窗口首日 = 100%）", " short")}
    </section>`
    )
    .join("");
  $$(".cat", host).forEach((sec) => {
    sec.hidden = true;
  });
}

function card(catKey, n, title, extra) {
  return `<div class="card${extra ? " is-short" : ""}">
    <h3>${esc(title)}</h3>
    <div class="chart${extra}" id="ch-${esc(catKey)}-c${n}" data-cat="${esc(catKey)}" data-n="${n}"
         role="img" aria-label="${esc(title)}"></div>
    <div class="chart-skeleton" data-sk="${esc(catKey)}-c${n}" aria-hidden="true">
      ${'<span class="sk sk-line" style="width:38%"></span>'.repeat(1)}
      <span class="sk sk-block" style="height:220px"></span>
    </div>
  </div>`;
}

function setChartState(catKey, n, state, msg) {
  const id = `ch-${catKey}-c${n}`;
  const host = document.getElementById(id);
  if (!host) return;
  const cardEl = host.closest(".card");
  const sk = cardEl?.querySelector(".chart-skeleton");
  const box = cardEl?.querySelector(".chart-note");
  if (sk) sk.hidden = state !== "loading";
  if (box) box.remove();
  if (state === "empty" || state === "error") {
    const note = el("div", `chart-note ${state}`, "");
    note.innerHTML =
      state === "empty"
        ? `<span>该大类在所选区间内暂无数据</span>`
        : `<span>${esc(msg || "图表数据加载失败")}</span><button class="btn btn-sm" type="button">重试</button>`;
    const btn = note.querySelector("button");
    if (btn) btn.addEventListener("click", () => renderCat(S.cat, { force: true }));
    cardEl?.appendChild(note);
  }
}

/* 渲染当前大类 */
async function renderCat(catKey, { force = false } = {}) {
  const sec = document.getElementById(`cat-${catKey}`);
  if (!sec) return;
  let data;
  try {
    data = await loadCatChart(catKey);
  } catch (e) {
    for (const n of [1, 2, 3]) setChartState(catKey, n, "error", "图表数据加载失败");
    return;
  }
  // 大类配色（标题左侧竖条）
  const h2 = $("h2", sec);
  if (h2 && data.color) h2.style.borderLeftColor = data.color;

  const hl = S.highlight && S.cat === catKey ? S.highlight : null;
  const plan = [
    [1, data.c1, { percent: false }],
    [2, data.c2, { percent: true }],
    [3, data.c3, { percent: true, shortDates: true }],
  ];
  for (const [n, cfg, opt] of plan) {
    if (!cfg) {
      setChartState(catKey, n, "empty");
      continue;
    }
    setChartState(catKey, n, "loading");
    let r;
    try {
      r = renderChart(`ch-${catKey}-c${n}`, cfg, { ...opt, highlight: hl });
    } catch (e) {
      console.error(e);
      r = "error";
    }
    setChartState(catKey, n, r === "ok" ? "ok" : r);
  }
  // 隐藏状态下初始化过的实例，切回来要重算尺寸
  requestAnimationFrame(() => resizeCat(catKey));
}

function resizeCat(catKey) {
  for (const n of [1, 2, 3]) {
    const inst = S._inst?.get(`ch-${catKey}-c${n}`);
    if (inst && !inst.isDisposed?.()) inst.resize();
  }
}

function activateCat(catKey, { scroll = false, highlight = undefined } = {}) {
  if (!S.cats.some((c) => c.key === catKey)) catKey = S.cats[0]?.key;
  if (!catKey) return;
  const changed = S.cat !== catKey;
  S.cat = catKey;
  // 切大类默认清掉高亮；显式传入 highlight 时以传入值为准（搜索定位用）
  if (highlight !== undefined) S.highlight = highlight;
  else if (changed) S.highlight = null;

  $$("#tabs [role=tab]").forEach((b) => {
    const on = b.dataset.cat === catKey;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
    if (on && b.parentElement) {
      // 窄屏下把当前 tab 滚进可视区
      const p = b.parentElement;
      if (p.scrollWidth > p.clientWidth) p.scrollLeft = b.offsetLeft - 24;
    }
  });
  $$(".cat").forEach((sec) => {
    const on = sec.dataset.cat === catKey;
    sec.hidden = !on;
    sec.classList.toggle("active", on);
  });

  renderCat(catKey);
  syncURL();
  if (scroll) {
    document.getElementById(`cat-${catKey}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function buildTabs() {
  const host = $("#tabs");
  host.innerHTML = S.cats
    .map(
      (c, i) =>
        `<button type="button" role="tab" data-cat="${esc(c.key)}" aria-selected="false" tabindex="-1"
          aria-controls="cat-${esc(c.key)}"${i === 0 ? ' class="active" aria-selected="true" tabindex="0"' : ""}>${esc(c.label)}</button>`
    )
    .join("");
  host.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cat]");
    if (b) activateCat(b.dataset.cat);
  });
  host.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const idx = S.cats.findIndex((c) => c.key === S.cat);
    const next = (idx + (e.key === "ArrowRight" ? 1 : -1) + S.cats.length) % S.cats.length;
    e.preventDefault();
    activateCat(S.cats[next].key);
    $(`#tabs button[data-cat="${CSS.escape(S.cats[next].key)}"]`)?.focus();
  });
}

function buildRanges() {
  const host = $("#ranges");
  host.innerHTML = RANGES.map(
    (r) =>
      `<button type="button" data-range="${r.key}" class="${r.key === S.range ? "active" : ""}"
        aria-pressed="${r.key === S.range}">${r.label}</button>`
  ).join("");
  host.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-range]");
    if (!b) return;
    setRange(b.dataset.range);
  });
}

function setRange(key) {
  if (!RANGE_MAP.has(key) || S.range === key) return;
  S.range = key;
  $$("#ranges button").forEach((b) => {
    const on = b.dataset.range === key;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  if (S.cat) renderCat(S.cat);
  syncURL();
}

/* 高亮提示条 */
function renderHighlightBar() {
  let bar = $("#hlBar");
  if (!S.highlight) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = el("div", "hl-bar", "");
    bar.id = "hlBar";
    $("#charts").before(bar);
  }
  bar.innerHTML = `<span class="hl-dot"></span>已定位：<b>${esc(S.highlight)}</b>
    <button class="btn btn-sm ghost" type="button" id="hlClear">取消高亮</button>`;
  $("#hlClear").addEventListener("click", () => {
    S.highlight = null;
    S.sub = null;
    renderHighlightBar();
    if (S.cat) renderCat(S.cat);
    syncURL();
  });
}

/* --------------------------------- 6. 搜索 -------------------------------- */

const SEARCH = { open: false, items: [], idx: -1 };

/* 汉字 → 拼音首字母（只覆盖 86 个小类名用到的 181 个字，约 0.4KB）。
 * 数据里的 index.json 若带 pinyin 字段就用它，没有就用这张表兜底，
 * 保证「bdxt → 半导体芯片」这类输入在任何数据源下都能命中。 */
const PY_PAIRS =
  "与y业y中z事s云y互h交j产c人r件j价j企q伏f传c低d体t保b信x债z值z光g全q公g养y军j农n创c利l制z券q力l务w化h区q医y半b发f可k合h和h品p商s器q国g地d城c域y基j备b大d天t央y媒m子z家j宽k导d小x居j展z" +
  "属s工g府f建j息x戏x成c房f技j投t指z换h据j改g政z教j数s料l新x方f施s旅l智z有y服f期q机j材c板b械x殖z气q池c汽q沪h油y治z波b流l消x深s港g游y源y炭t煤m片p牌p牧m物w率l环h现x理l生s用y电d畜c略l疗l" +
  "疫y白b盘p短d石s础c碳t科k稀x程c空k端d筑z策c算s红h综z绿l网w老l联l股g育y能n航h舶b船c色s芯x苗m药y融r行x装z计j设s贵g费f资z超c车c转z软r通t造z部b酒j金j钢g铁t银y长z防f险x零l非f革g风f食s饮y" +
  "高g";
const PY_INITIAL = (() => {
  const m = new Map();
  for (let i = 0; i + 1 < PY_PAIRS.length; i += 2) m.set(PY_PAIRS[i], PY_PAIRS[i + 1]);
  return m;
})();

/** 取小类的拼音首字母：优先数据里的 pinyin，否则本地映射；纯英文数字原样保留 */
function pinyinOf(name, rec) {
  const given = (rec?.pinyin || "").toLowerCase();
  if (given) return given;
  let out = "";
  for (const ch of String(name || "")) {
    if (PY_INITIAL.has(ch)) out += PY_INITIAL.get(ch);
    else if (/[A-Za-z0-9]/.test(ch)) out += ch.toLowerCase();
  }
  return out;
}

/** 小类匹配打分：越高越靠前 */
function scoreSub(q) {
  const ql = q.toLowerCase();
  const out = [];
  for (const s of S.index?.subs || []) {
    const name = s.name || "";
    let sc = 0;
    if (name === q) sc = 100;
    else if (name.startsWith(q)) sc = 80;
    else if (name.includes(q)) sc = 60;
    else {
      const py = pinyinOf(name, s);
      if (py && py === ql) sc = 70;
      else if (py && py.startsWith(ql)) sc = 50;
      else if (py && py.includes(ql)) sc = 35;
    }
    if (sc) out.push({ type: "sub", sc, name, cat: s.cat, pinyin: pinyinOf(name, s), label: s.label || String(s.cat || "").replace("_", ".") });
  }
  return out.sort((a, b) => b.sc - a.sc);
}

function scoreEtf(q) {
  const ql = q.toLowerCase();
  const out = [];
  for (const e of S.index?.etfs || []) {
    const code = String(e.code || "");
    const name = String(e.name || "");
    let sc = 0;
    if (code === q) sc = 100;
    else if (code.startsWith(q)) sc = 85;
    else if (code.includes(q)) sc = 55;
    else if (name.includes(q)) sc = 65;
    else if (name.toLowerCase().includes(ql)) sc = 40;
    if (sc) out.push({ type: "etf", sc, code, name, subs: e.subs || [] });
  }
  return out.sort((a, b) => b.sc - a.sc);
}

function runSearch(q) {
  q = (q || "").trim();
  if (!q) return [];
  if (!S.index) return [];
  const subs = scoreSub(q).slice(0, 8).map((r) => ({ ...r, key: `sub:${r.name}` }));
  const etfs = scoreEtf(q).slice(0, 8).map((r) => ({ ...r, key: `etf:${r.code}` }));
  return [...subs, ...etfs];
}

const searchInput = () => $("#searchInput");

function renderSearchPop() {
  const pop = $("#searchList");
  const input = searchInput();
  if (!pop || !input) return;
  if (!SEARCH.open) {
    pop.hidden = true;
    input.setAttribute("aria-expanded", "false");
    return;
  }
  if (!S.index) {
    pop.innerHTML = `<div class="sp-empty">搜索索引加载失败</div>`;
    pop.hidden = false;
    input.setAttribute("aria-expanded", "true");
    return;
  }
  if (!SEARCH.items.length) {
    pop.innerHTML = `<div class="sp-empty">没有匹配的小类或 ETF</div>`;
  } else {
    let html = "";
    let lastType = "";
    SEARCH.items.forEach((it, i) => {
      if (it.type !== lastType) {
        html += `<div class="sp-group">${it.type === "sub" ? "细分行业" : "ETF 标的"}</div>`;
        lastType = it.type;
      }
      const on = i === SEARCH.idx ? " on" : "";
      if (it.type === "sub") {
        html += `<div class="sp-item${on}" role="option" data-i="${i}" aria-selected="${i === SEARCH.idx}">
          <span class="sp-name">${esc(it.name)}</span>
          <span class="sp-meta">${esc(it.label)}</span></div>`;
      } else {
        html += `<div class="sp-item${on}" role="option" data-i="${i}" aria-selected="${i === SEARCH.idx}">
          <span class="sp-code">${esc(it.code)}</span>
          <span class="sp-name">${esc(it.name)}</span>
          <span class="sp-meta">${esc((it.subs || []).slice(0, 2).join(" / "))}</span></div>`;
      }
    });
    pop.innerHTML = html;
  }
  pop.hidden = false;
  input.setAttribute("aria-expanded", "true");
  pop.querySelector(".sp-item.on")?.scrollIntoView({ block: "nearest" });
}

function openSearch() {
  const input = searchInput();
  if (!input) return;
  SEARCH.open = true;
  SEARCH.items = runSearch(input.value);
  SEARCH.idx = SEARCH.items.length ? 0 : -1;
  renderSearchPop();
}

function closeSearch() {
  SEARCH.open = false;
  SEARCH.idx = -1;
  renderSearchPop();
}

function moveSearch(delta) {
  if (!SEARCH.items.length) return;
  const n = SEARCH.items.length;
  SEARCH.idx = (SEARCH.idx + delta + n) % n;
  renderSearchPop();
}

function pickSearch(i) {
  const it = SEARCH.items[i];
  if (!it) return;
  const input = searchInput();
  if (it.type === "sub") {
    if (input) input.value = it.name;
    closeSearch();
    gotoSub(it.name);
  } else {
    // ETF：定位到它所属的第一个小类
    const sub = (it.subs || [])[0];
    if (input) input.value = `${it.code} ${it.name}`;
    closeSearch();
    if (sub) gotoSub(sub);
    else toast(`「${it.name}」暂未归类到细分行业`);
  }
}

function gotoSub(subName) {
  const cat = subCat.get(subName) || S.index?.subs?.find((s) => s.name === subName)?.cat;
  if (!cat) {
    toast(`找不到「${subName}」所属的大类`);
    return;
  }
  S.sub = subName;
  if (S.cat !== cat) {
    // 同一个调用里带上高亮，避免 activateCat 把刚设的高亮清掉
    activateCat(cat, { highlight: subName });
  } else {
    S.highlight = subName;
    renderCat(cat);
  }
  renderHighlightBar();
  syncURL();
  requestAnimationFrame(() => {
    document.getElementById(`cat-${cat}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function wireSearch() {
  const input = searchInput();
  const pop = $("#searchList");
  if (!input || !pop) return;

  const onInput = debounce(() => {
    SEARCH.items = runSearch(input.value);
    SEARCH.idx = SEARCH.items.length ? 0 : -1;
    SEARCH.open = true;
    renderSearchPop();
  }, 90);

  input.addEventListener("input", onInput);
  input.addEventListener("focus", () => {
    if (input.value.trim()) openSearch();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!SEARCH.open) openSearch();
      else moveSearch(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (SEARCH.open) moveSearch(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (SEARCH.items.length) pickSearch(Math.max(0, SEARCH.idx));
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (SEARCH.open) closeSearch();
      else input.blur();
    }
  });
  pop.addEventListener("mousedown", (e) => {
    const it = e.target.closest(".sp-item");
    if (it) {
      e.preventDefault();
      pickSearch(+it.dataset.i);
    }
  });
  document.addEventListener("click", (e) => {
    if (!SEARCH.open) return;
    if (!e.target.closest("#searchBox")) closeSearch();
  });
  // 全局 "/" 聚焦搜索
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) {
      e.preventDefault();
      input.focus();
      input.select?.();
    }
  });
}

/* --------------------------------- 7. 抽屉 -------------------------------- */

const DRAWER = { open: false, kind: null, sub: null, chart: null, lastFocus: null, rankFilter: "all", rankQ: "" };

function drawerEls() {
  return { mask: $("#drawerMask"), panel: $("#drawer"), body: $("#drawerBody"), eyebrow: $("#drawerEyebrow"), title: $("#drawerTitle") };
}

function openDrawer() {
  const { mask, panel } = drawerEls();
  if (!panel) return;
  DRAWER.open = true;
  DRAWER.lastFocus = document.activeElement;
  mask.hidden = false;
  panel.hidden = false;
  document.body.classList.add("no-scroll");
  requestAnimationFrame(() => {
    mask.classList.add("on");
    panel.classList.add("on");
  });
  $("#drawerClose")?.focus();
}

function closeDrawer() {
  const { mask, panel } = drawerEls();
  if (!panel || !DRAWER.open) return;
  DRAWER.open = false;
  mask.classList.remove("on");
  panel.classList.remove("on");
  document.body.classList.remove("no-scroll");
  setTimeout(() => {
    mask.hidden = true;
    panel.hidden = true;
    if (DRAWER.chart && !DRAWER.chart.isDisposed?.()) {
      DRAWER.chart.dispose();
      DRAWER.chart = null;
    }
  }, 180);
  DRAWER.kind = null;
  DRAWER.sub = null;
  try {
    DRAWER.lastFocus?.focus?.();
  } catch (e) {}
}

/** 小类详情抽屉 */
async function openSub(name) {
  const { body, eyebrow, title } = drawerEls();
  if (!body) return;
  DRAWER.kind = "sub";
  DRAWER.sub = name;
  eyebrow.textContent = "细分行业详情";
  title.textContent = name;
  body.innerHTML = `
    <div class="drawer-section">
      ${'<span class="sk sk-line" style="width:40%"></span><span class="sk sk-block" style="height:64px;margin-top:12px"></span>'}
    </div>`;
  openDrawer();

  let data;
  try {
    await loadSubs();
    data = S.subs?.[name] || null;
  } catch (e) {
    body.innerHTML = `<div class="drawer-section"><p class="muted">成分明细加载失败，请稍后重试。</p>
      <button class="btn" type="button" id="drawerRetry">重试</button></div>`;
    $("#drawerRetry").addEventListener("click", () => openSub(name));
    return;
  }
  if (DRAWER.kind !== "sub" || DRAWER.sub !== name) return; // 期间切换了
  renderSubDrawer(name, data);
}

function renderSubDrawer(name, rec) {
  const { body, eyebrow, title } = drawerEls();
  const catKey = rec?.cat || subCat.get(name) || "";
  const catLabel = catLabelOf(catKey);
  const row = (S.tables?.all || []).find((r) => r.sub === name) || null;
  const rank = row ? (S.tables.all || []).findIndex((r) => r.sub === name) + 1 : null;
  const total = (S.tables?.all || []).length || 86;
  const cur = rec?.current ?? (rec?.values || []).filter((v) => tidy(v) != null).pop() ?? null;
  const color = rec?.color || catColorOf(catKey) || "#1f6feb";
  const win = S.tables?.window || {};

  // 金额口径（规模 / 净流入）是可空的新字段，缺就不渲染，避免出现一堆「—」
  const hasScale = hasMetric("scale") && !!rec && Object.hasOwn(rec, "scale");
  const hasFlow = hasMetric("flow") && !!rec && Object.hasOwn(rec, "flow");
  const scale = tidy(rec?.scale);
  const flow = tidy(rec?.flow);
  const navCov = rec?.navCoverage || null;
  const navHit = tidy(navCov?.hit);
  const navTotal = tidy(navCov?.total);
  const navGap = navHit != null && navTotal != null && navHit < navTotal;
  const navTip = navGap
    ? `该小类 ${navTotal} 只成分 ETF 中有 ${navTotal - navHit} 只缺净值，规模 / 净流入按有净值部分汇总，为下限估计`
    : "";

  const etfs = (rec?.etfs || []).map((e) => ({ ...e }));
  const etfNav = etfs.some((e) => Object.hasOwn(e, "nav"));
  const etfScale = etfs.some((e) => Object.hasOwn(e, "scale"));
  const etfFlow = etfs.some((e) => Object.hasOwn(e, "flow"));

  eyebrow.innerHTML = `<span class="badge-cat" style="--c:${esc(color)}">${esc(catLabel)}</span> 细分行业详情`;
  title.textContent = name;

  const kpi = (k, v, cls = "", flag = "") =>
    `<div class="kpi"><div class="kpi-k">${k}${flag}</div><div class="kpi-v ${cls}">${v}</div></div>`;
  const navFlag = navGap ? `<span class="kpi-flag" title="${esc(navTip)}">部分无净值</span>` : "";

  const kpis = [
    kpi(`当前份额（${U_SHARES()}）`, n1(cur)),
    kpi(`近一周变化（${win.days ?? 7} 交易日）`, row ? `<span class="${ud(row.delta)}">${s1(row.delta)}</span>` : "—"),
    kpi("近一周变化率", row ? `<span class="${ud(row.pct)}">${p2(row.pct)}</span>` : "—"),
  ];
  if (hasScale) kpis.push(kpi(`当前规模（${U_SCALE()}）`, n1(scale), "", navFlag));
  if (hasFlow)
    kpis.push(kpi(`近一周净流入（${U_FLOW()}）`, flow == null ? "—" : `<span class="${ud(flow)}">${s1(flow)}</span>`, "", navFlag));
  kpis.push(kpi("小类排名", rank ? `<span class="${ud(row?.delta)}">#${rank}</span>` : "—"));

  const noteBits = [
    `${esc(name)} 属于 <b>${esc(catLabel)}</b>，当前共 ${esc(rec?.etfs?.length ?? etfsOfSub(name).length)} 只 ETF 标的。`,
  ];
  if (row) {
    noteBits.push(
      `近 ${win.days ?? 7} 个交易日份额${tidy(row.delta) >= 0 ? "增加" : "减少"} <b class="${ud(row.delta)}">${n1(Math.abs(tidy(row.delta)))}</b> ${U_SHARES()}（${p2(row.pct)}），在 ${total} 个小类中排名第 ${rank}。`
    );
  }
  if (hasScale && scale != null) noteBits.push(`当前规模约 <b>${n1(scale)}</b> ${U_SCALE()}。`);
  if (hasFlow && flow != null) {
    noteBits.push(`近一周净流入 <b class="${ud(flow)}">${s1(flow)}</b> ${U_FLOW()}。`);
  }
  if (navGap) noteBits.push(`金额口径覆盖 ${navHit}/${navTotal} 只成分 ETF，未覆盖部分未计入。`);

  const th = (key, label, type = "num", extra = "") =>
    `<th data-sort="${key}" data-type="${type}" class="${type === "num" ? "num " : ""}sortable ${extra}" scope="col">${label}<span class="sarrow"></span></th>`;

  body.innerHTML = `
    <div class="drawer-section">
      <div class="kpis">${kpis.join("")}</div>
      <p class="drawer-note">${noteBits.join(" ")}</p>
    </div>

    <div class="drawer-section">
      <h3 class="drawer-h3">自身份额走势（${esc(rangeLabel())}）</h3>
      <div class="mini-chart" id="miniChart" role="img" aria-label="${esc(name)} 份额走势"></div>
    </div>

    <div class="drawer-section">
      <div class="drawer-h3-row">
        <h3 class="drawer-h3">成分 ETF（${esc(etfs.length)}）</h3>
        <button class="btn btn-sm" type="button" id="btnSubCsv">导出本小类 CSV</button>
      </div>
      <div class="tbl-scroll">
        <table class="tbl tbl-etf" id="tblEtf">
          <thead><tr>
            ${th("code", "代码", "text")}
            ${th("name", "名称", "text")}
            ${th("shares", `份额(${U_SHARES()})`)}
            ${th("delta", "近一周变化")}
            ${etfNav ? th("nav", "净值", "num", "col-nav") : ""}
            ${etfScale ? th("scale", `规模(${U_SCALE()})`) : ""}
            ${etfFlow ? th("flow", `净流入(${U_FLOW()})`) : ""}
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <div class="drawer-section drawer-actions">
      <button class="btn" type="button" id="btnOnlyThis">图表只看这条线</button>
      <button class="btn ghost" type="button" id="btnGotoChart">回到图表</button>
    </div>
  `;

  initTable("tblEtf", (r) => {
    const cells = [
      `<td class="mono">${esc(r.code)}</td>`,
      `<td class="ellip" title="${esc(r.name)}">${esc(r.name)}</td>`,
      `<td class="num">${n1(r.shares)}</td>`,
      `<td class="num ${ud(r.delta)}">${s1(r.delta)}</td>`,
    ];
    if (etfNav) cells.push(`<td class="num col-nav">${r.nav == null ? "—" : tidy(r.nav).toFixed(3)}</td>`);
    if (etfScale) cells.push(`<td class="num">${n1(r.scale)}</td>`);
    if (etfFlow) cells.push(`<td class="num ${ud(r.flow)}">${s1(r.flow)}</td>`);
    return cells.join("");
  });
  const st = TBL.get("tblEtf");
  st.sortKey = "shares";
  st.sortDir = -1;
  fillTable("tblEtf", etfs);

  renderMini(name, rec, color);

  $("#btnOnlyThis")?.addEventListener("click", () => {
    S.highlight = name;
    if (S.cat !== catKey) activateCat(catKey, { highlight: name });
    else renderCat(catKey);
    renderHighlightBar();
    closeDrawer();
    document.getElementById(`cat-${catKey}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#btnGotoChart")?.addEventListener("click", () => {
    closeDrawer();
    document.getElementById(`cat-${catKey}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#btnSubCsv")?.addEventListener("click", () => exportSub(name));
}

function renderMini(name, rec, color) {
  const host = $("#miniChart");
  if (!host || !S.echarts) return;
  const dates = subDates(rec);
  const values = rec?.values || [];
  if (!dates.length || !values.length) {
    host.innerHTML = `<div class="chart-note empty"><span>暂无序列数据</span></div>`;
    return;
  }
  const start = startIndex(dates, S.range);
  const C = themeColors();
  if (DRAWER.chart && !DRAWER.chart.isDisposed?.()) DRAWER.chart.dispose();
  DRAWER.chart = S.echarts.init(host, null, { renderer: "canvas" });
  DRAWER.chart.setOption(
    {
      animation: false,
      backgroundColor: "transparent",
      grid: { left: 52, right: 18, top: 18, bottom: 28 },
      tooltip: {
        trigger: "axis",
        backgroundColor: C.panel,
        borderColor: C.border,
        textStyle: { color: C.text, fontSize: 12 },
        valueFormatter: (v) => (v == null ? "—" : Number(v).toFixed(1)),
      },
      xAxis: {
        type: "category",
        data: dates.slice(start),
        boundaryGap: false,
        axisLine: { lineStyle: { color: C.border } },
        axisTick: { show: false },
        axisLabel: {
          color: C.muted,
          fontSize: 11,
          formatter: (v) => String(v).slice(0, 7),
          hideOverlap: true,
        },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitLine: { lineStyle: { color: C.grid, type: "dashed" } },
        axisLabel: { color: C.muted, fontSize: 11 },
      },
      series: [
        {
          name,
          type: "line",
          data: values.slice(start).map(tidy),
          showSymbol: false,
          sampling: "lttb",
          lineStyle: { width: 2, color },
          itemStyle: { color },
          areaStyle: { color, opacity: 0.1 },
        },
      ],
    },
    true
  );
  setTimeout(() => DRAWER.chart && !DRAWER.chart.isDisposed?.() && DRAWER.chart.resize(), 60);
}

/** 全部 86 个小类排行抽屉 */
function openRank() {
  const { body, eyebrow, title } = drawerEls();
  if (!body) return;
  DRAWER.kind = "rank";
  eyebrow.textContent = "增减排行";
  title.textContent = "全部小类";
  const all = S.tables?.all || [];
  const win = S.tables?.window || {};
  const moneyOk = hasMetric("flow") && all.some((r) => tidy(r.flow) != null);
  const mode = DRAWER.rankMode === "money" && moneyOk ? "money" : "shares";
  DRAWER.rankMode = mode;

  const th = (key, label, type = "num") =>
    `<th data-sort="${key}" data-type="${type}" class="${type === "num" ? "num " : ""}sortable" scope="col"><span class="thlab">${label}</span><span class="sarrow"></span></th>`;

  body.innerHTML = `
    <div class="drawer-section">
      <div class="rank-tools">
        <input class="rank-search" id="rankSearch" type="search" placeholder="筛选小类名 / 拼音"
               aria-label="筛选小类" autocomplete="off" spellcheck="false">
        <div class="chipfilters" role="group" aria-label="按增减筛选">
          <button class="chipf${DRAWER.rankFilter === "all" ? " on" : ""}" data-f="all" type="button">全部</button>
          <button class="chipf${DRAWER.rankFilter === "up" ? " on" : ""}" data-f="up" type="button">增加</button>
          <button class="chipf${DRAWER.rankFilter === "down" ? " on" : ""}" data-f="down" type="button">减少</button>
        </div>
        <button class="btn btn-sm" type="button" id="btnRankCsv">导出全部 CSV</button>
      </div>
      ${
        moneyOk
          ? `<div class="modeswitch" role="group" aria-label="口径切换">
               <button class="mchip${mode === "shares" ? " on" : ""}" data-m="shares" type="button">按份额变化</button>
               <button class="mchip${mode === "money" ? " on" : ""}" data-m="money" type="button">按金额净流入</button>
             </div>`
          : ""
      }
      <p class="drawer-note" id="rankNote"></p>
      <div class="tbl-scroll tall">
        <table class="tbl tbl-rank${mode === "money" ? " money" : ""}" id="tblRank">
          <thead><tr>
            <th class="num" scope="col">#</th>
            ${th("sub", "小类", "text")}
            ${th("catLabel", "大类", "text")}
            ${th("cur", "当前份额")}
            ${th("chg", "变化量")}
            ${th("pctv", "变化率")}
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  // 两种口径共用同一套列，只是喂给列的数据不同（cur/chg/pctv）
  const rows = all.map((r) => ({
    ...r,
    catLabel: catLabelOf(r.cat),
    cur: mode === "shares" ? tidy(r.last) ?? tidy(r.now) : tidy(r.scale),
    chg: mode === "shares" ? tidy(r.delta) : tidy(r.flow),
    pctv: mode === "shares" ? tidy(r.pct) : null,
    name: r.sub,
  }));

  initTable("tblRank", (r) => {
    const cells = [
      `<td class="num rank-no"></td>`,
      `<td class="sub-cell"><button class="linkbtn sub-link" type="button" data-sub="${esc(r.sub)}">${esc(r.sub)}</button></td>`,
      `<td class="muted-cell">${esc(r.catLabel)}</td>`,
      `<td class="num">${n1(r.cur)}</td>`,
      `<td class="num ${ud(r.chg)}">${s1(r.chg)}</td>`,
      `<td class="num ${ud(r.pctv)}">${p2(r.pctv)}</td>`,
    ];
    return cells.join("");
  });
  const st = TBL.get("tblRank");
  st.sortKey = "chg";
  st.sortDir = -1;

  const paintRank = () => {
    const q = DRAWER.rankQ.toLowerCase();
    const f = DRAWER.rankFilter;
    let list = rows;
    if (f === "up") list = list.filter((r) => tidy(r.chg) > 0);
    if (f === "down") list = list.filter((r) => tidy(r.chg) < 0);
    if (q) {
      list = list.filter(
        (r) =>
          r.sub.toLowerCase().includes(q) ||
          pinyinOf(r.sub).includes(q) ||
          String(r.catLabel).toLowerCase().includes(q)
      );
    }
    fillTable("tblRank", list);
    // # 列跟随当前排序/筛选后的行序，切口径或改排序时都不会出现跳号
    $$("#tblRank tbody tr").forEach((tr, i) => {
      const cell = tr.querySelector(".rank-no");
      if (cell) cell.textContent = i + 1;
    });
    $$("#tblRank tbody .sub-link").forEach((b) => {
      b.addEventListener("click", () => openSub(b.dataset.sub));
    });
  };

  const syncHeaders = () => {
    const tb = $("#tblRank");
    if (!tb) return;
    tb.classList.toggle("money", mode === "money");
    const set = (key, label) => {
      const el2 = tb.querySelector(`th[data-sort="${key}"] .thlab`);
      if (el2) el2.textContent = label;
    };
    set("cur", mode === "shares" ? `当前份额(${U_SHARES()})` : `当前规模(${U_SCALE()})`);
    set("chg", mode === "shares" ? "变化量" : `净流入(${U_FLOW()})`);
    const note = $("#rankNote");
    if (note) {
      note.innerHTML =
        `统计区间 ${esc(ymd(win.from))} ~ ${esc(ymd(win.to))}（${esc(win.days ?? "?")} 个交易日）；共 ${all.length} 个小类，` +
        (mode === "shares"
          ? "按区间份额增减排序。"
          : "按区间净流入（份额变化 × 净值）排序，缺净值的成分不计入，口径偏保守。");
    }
  };
  syncHeaders();
  paintRank();

  $("#rankSearch").addEventListener(
    "input",
    debounce((e) => {
      DRAWER.rankQ = e.target.value.trim();
      paintRank();
    }, 100)
  );
  $$("#drawerBody .chipf").forEach((b) => {
    b.addEventListener("click", () => {
      DRAWER.rankFilter = b.dataset.f;
      $$("#drawerBody .chipf").forEach((x) => x.classList.toggle("on", x === b));
      paintRank();
    });
  });
  $$("#drawerBody .mchip").forEach((b) => {
    b.addEventListener("click", () => {
      if (DRAWER.rankMode === b.dataset.m) return;
      DRAWER.rankMode = b.dataset.m;
      openRank();
      const si = $("#rankSearch");
      if (si && DRAWER.rankQ) si.value = DRAWER.rankQ;
    });
  });
  $("#btnRankCsv").addEventListener("click", () => exportRank());
  openDrawer();
  setTimeout(() => $("#rankSearch")?.focus(), 200);
}

/** 数据质量抽屉 */
function openQuality() {
  const { body, eyebrow, title } = drawerEls();
  if (!body) return;
  DRAWER.kind = "quality";
  eyebrow.textContent = "数据校验";
  title.textContent = "数据质量摘要";
  const q = S.quality;
  if (!q) {
    body.innerHTML = `<div class="drawer-section"><p class="muted">质量报告加载中…</p></div>`;
    openDrawer();
    getData("quality.json", "/api/quality")
      .then(({ data }) => {
        S.quality = data;
        if (DRAWER.kind === "quality") openQuality();
      })
      .catch(() => {
        body.innerHTML = `<div class="drawer-section"><p class="muted">质量报告暂不可用。</p></div>`;
      });
    return;
  }
  const sum = q.summary || {};
  const m = S.meta || {};
  body.innerHTML = `
    <div class="drawer-section">
      <div class="kpis">
        <div class="kpi"><div class="kpi-k">交叉校验</div><div class="kpi-v">${esc(sum.checked ?? "—")}</div></div>
        <div class="kpi"><div class="kpi-k">一致</div><div class="kpi-v up">${esc(sum.agree ?? "—")}</div></div>
        <div class="kpi"><div class="kpi-k">不一致</div><div class="kpi-v ${Number(sum.disagree) > 0 ? "down" : ""}">${esc(sum.disagree ?? "—")}</div></div>
        <div class="kpi"><div class="kpi-k">交易日</div><div class="kpi-v">${esc(m.range?.days ?? "—")}</div></div>
      </div>
      <p class="drawer-note">生成时间 ${esc(hhmm(q.generatedAt))}；数据源 ${esc((m.sources || []).join(" / ") || "—")}；覆盖 ${esc(m.counts?.subs ?? "—")} 个小类 / ${esc(m.counts?.etfs ?? "—")} 只 ETF。</p>
    </div>
    <div class="drawer-section">
      <h3 class="drawer-h3">逐日校验（最近 20 个交易日）</h3>
      <ul class="q-days">
        ${(q.days || [])
          .slice(-20)
          .reverse()
          .map(
            (d) => `<li><span class="mono">${esc(ymd(d.date))}</span>
              <span class="q-count ${Number(d.count) ? "" : "ok"}">${esc(d.count)} 处差异</span>
              ${d.samples?.length ? `<span class="muted ellip" title="${esc(d.samples.join("，"))}">${esc(d.samples.join("，"))}</span>` : ""}</li>`
          )
          .join("") || `<li class="muted">暂无逐日记录</li>`}
      </ul>
    </div>`;
  openDrawer();
}

function catLabelOf(key) {
  const hit = S.cats.find((c) => c.key === key);
  if (hit) return hit.label;
  const t = (S.tables?.cats || []).find((c) => c.key === key);
  if (t) return t.label;
  return String(key || "").replace("_", ".");
}
function catColorOf(key) {
  return S.charts.get(key)?.color || S.cats.find((c) => c.key === key)?.color || "";
}
function rangeLabel() {
  return RANGE_MAP.get(S.range)?.label || S.range;
}

/* ------------------------------- 8. CSV 导出 ------------------------------ */

const CSV_BOM = "\ufeff";
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows) {
  return CSV_BOM + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** 当前视图：当前大类 + 当前区间的份额宽表 */
function exportCurrentView() {
  const catKey = S.cat;
  const data = S.charts.get(catKey);
  if (!data?.c1?.dates?.length) {
    toast("当前大类数据尚未加载完成，请稍后再试", "err");
    return;
  }
  const dates = data.c1.dates;
  const start = startIndex(dates, S.range);
  const ds = dates.slice(start);
  const series = (data.c1.series || []).filter((s) => (s.values || []).slice(start).some((v) => tidy(v) != null));
  if (!series.length) {
    toast("当前区间没有可导出的数据", "err");
    return;
  }
  const rows = [[`# ${data.label || catLabelOf(catKey)} · 份额（亿份）· ${ds[0]} ~ ${ds[ds.length - 1]} · ${rangeLabel()}`]];
  rows.push(["日期", ...series.map((s) => s.name)]);
  ds.forEach((d, i) => rows.push([d, ...series.map((s) => {
    const v = tidy(s.values[start + i]);
    return v == null ? "" : v.toFixed(1);
  })]));
  const name = `etf份额_${catKey}_${S.range}_${ymd(S.meta?.lastTradeDate || ds[ds.length - 1])}.csv`;
  download(name, toCSV(rows));
  toast(`已导出：${name}`);
}

/** 全部小类当前值 */
function exportRank() {
  const all = S.tables?.all || [];
  if (!all.length) {
    toast("排行数据尚未加载", "err");
    return;
  }
  const win = S.tables?.window || {};
  const moneyOk = hasMetric("flow") && all.some((r) => tidy(r.flow) != null);
  const head = [
    [`# 全部小类区间增减 · ${ymd(win.from)} ~ ${ymd(win.to)}（${win.days} 个交易日）· 份额 ${U_SHARES()} · 规模/净流入 ${U_SCALE()}`],
  ];
  head.push([
    "排名",
    "小类",
    "大类",
    `当前份额(${U_SHARES()})`,
    "区间变化量",
    "区间变化率(%)",
    ...(moneyOk ? [`当前规模(${U_SCALE()})`, `近一周净流入(${U_FLOW()})`] : []),
  ]);
  all.forEach((r, i) => {
    const line = [
      i + 1,
      r.sub,
      catLabelOf(r.cat),
      tidy(r.last ?? r.now)?.toFixed(1) ?? "",
      tidy(r.delta)?.toFixed(1) ?? "",
      tidy(r.pct)?.toFixed(2) ?? "",
    ];
    if (moneyOk) line.push(tidy(r.scale)?.toFixed(1) ?? "", tidy(r.flow)?.toFixed(1) ?? "");
    head.push(line);
  });
  const name = `etf小类增减_${ymd(win.from)}_${ymd(win.to)}.csv`;
  download(name, toCSV(head));
  toast(`已导出：${name}`);
}

/** 单个小类：份额时间序列 + 成分 ETF 明细（含金额口径） */
function exportSub(name) {
  const rec = S.subs?.[name];
  if (!rec?.values?.length) {
    toast("该小类暂无序列数据", "err");
    return;
  }
  const dates = subDates(rec);
  const start = startIndex(dates, S.range);
  const scale = tidy(rec.scale);
  const flow = tidy(rec.flow);
  const extras = [];
  if (scale != null) extras.push(`当前规模 ${scale.toFixed(1)} ${U_SCALE()}`);
  if (flow != null) extras.push(`近一周净流入 ${flow >= 0 ? "+" : ""}${flow.toFixed(1)} ${U_FLOW()}`);
  if (rec.navCoverage && tidy(rec.navCoverage.hit) < tidy(rec.navCoverage.total)) {
    extras.push(`金额口径覆盖 ${rec.navCoverage.hit}/${rec.navCoverage.total} 只成分`);
  }

  const rows = [[`# ${name} · 份额（${U_SHARES()}）· ${rangeLabel()}${extras.length ? " · " + extras.join(" · ") : ""}`]];
  rows.push(["日期", `份额(${U_SHARES()})`]);
  for (let i = start; i < dates.length; i++) {
    const v = tidy(rec.values[i]);
    rows.push([dates[i], v == null ? "" : v.toFixed(1)]);
  }

  // 第二个区块：成分 ETF 明细
  const etfs = rec.etfs || [];
  if (etfs.length) {
    const hasNav = etfs.some((e) => Object.hasOwn(e, "nav"));
    const hasScale = etfs.some((e) => Object.hasOwn(e, "scale"));
    const hasFlow = etfs.some((e) => Object.hasOwn(e, "flow"));
    rows.push([]);
    rows.push([`# 成分 ETF（${etfs.length}）`]);
    rows.push([
      "代码",
      "名称",
      `份额(${U_SHARES()})`,
      "近一周变化",
      ...(hasNav ? ["净值"] : []),
      ...(hasScale ? [`规模(${U_SCALE()})`] : []),
      ...(hasFlow ? [`净流入(${U_FLOW()})`] : []),
    ]);
    for (const e of etfs) {
      const line = [
        e.code,
        e.name,
        tidy(e.shares)?.toFixed(1) ?? "",
        tidy(e.delta)?.toFixed(1) ?? "",
      ];
      if (hasNav) line.push(tidy(e.nav) == null ? "" : tidy(e.nav).toFixed(3));
      if (hasScale) line.push(tidy(e.scale)?.toFixed(1) ?? "");
      if (hasFlow) line.push(tidy(e.flow)?.toFixed(1) ?? "");
      rows.push(line);
    }
  }

  const fname = `etf份额_${name}_${S.range}.csv`;
  download(fname, toCSV(rows));
  toast(`已导出：${fname}`);
}

/* ------------------------------- 9. URL 状态 ------------------------------ */

function syncURL() {
  const p = new URLSearchParams();
  if (S.cat) p.set("cat", S.cat);
  if (S.range && S.range !== DEFAULT_RANGE) p.set("range", S.range);
  if (S.sub) p.set("sub", S.sub);
  const q = p.toString();
  const url = q ? `${location.pathname}?${q}` : location.pathname;
  try {
    history.replaceState(null, "", url);
  } catch (e) {}
}

function readURL() {
  const p = new URLSearchParams(location.search);
  const cat = p.get("cat");
  const range = p.get("range");
  const sub = p.get("sub");
  if (cat && S.cats.some((c) => c.key === cat)) S.cat = cat;
  if (range && RANGE_MAP.has(range)) S.range = range;
  if (sub) {
    S.sub = sub;
    S.highlight = sub;
    const c = subCat.get(sub);
    if (c && S.cats.some((x) => x.key === c)) S.cat = c;
  }
}

/* --------------------------------- 10. 主题 ------------------------------- */

const THEME_ORDER = ["auto", "dark", "light"];
const THEME_ICON = { auto: "◐", dark: "🌙", light: "☀" };
const THEME_TIP = { auto: "跟随系统", dark: "深色", light: "浅色" };

function applyTheme(t, { rerender = true } = {}) {
  S.theme = THEME_ORDER.includes(t) ? t : "auto";
  document.documentElement.setAttribute("data-theme", S.theme);
  try {
    if (S.theme === "auto") localStorage.removeItem("etf-theme");
    else localStorage.setItem("etf-theme", S.theme);
  } catch (e) {}
  const icon = $("#themeIcon");
  if (icon) icon.textContent = THEME_ICON[S.theme];
  const btn = $("#btnTheme");
  if (btn) {
    btn.setAttribute("aria-label", `主题：${THEME_TIP[S.theme]}（点击切换）`);
    btn.title = `主题：${THEME_TIP[S.theme]}`;
  }
  if (rerender) {
    if (S.cat) renderCat(S.cat);
    if (DRAWER.open && DRAWER.kind === "sub" && DRAWER.sub) {
      const rec = S.subs?.[DRAWER.sub];
      if (rec) renderMini(DRAWER.sub, rec, rec.color || catColorOf(rec.cat));
    }
  }
}

function wireTheme() {
  let t = "auto";
  try {
    t = localStorage.getItem("etf-theme") || "auto";
  } catch (e) {}
  applyTheme(t, { rerender: false });
  $("#btnTheme")?.addEventListener("click", () => {
    const i = THEME_ORDER.indexOf(S.theme);
    applyTheme(THEME_ORDER[(i + 1) % THEME_ORDER.length]);
  });
  // 系统主题变化时，auto 模式自动跟随
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (S.theme === "auto" && S.cat) renderCat(S.cat);
    });
  } catch (e) {}
}

/* --------------------------------- 11. 刷新 ------------------------------- */

/** 是否可能存在本地服务（静态托管时直接跳过探测，避免控制台 404 噪音） */
function mayHaveServer() {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "" || location.protocol === "file:";
}

async function probeServer() {
  if (!mayHaveServer()) {
    setDataBadge("static", "静态快照");
    return false;
  }
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const j = await res.json();
    if (j?.mark?.latestTradeDate) {
      setDataBadge("live");
      return true;
    }
    setDataBadge("live");
    return true;
  } catch (e) {
    const src = apiFallbackNoted ? "api" : "static";
    setDataBadge(src, src === "static" ? "静态快照" : undefined);
    return false;
  }
}

async function doRefresh() {
  const btn = $("#btnRefresh");
  if (!btn) return;
  if (S.dataMode === "static") {
    setDataBadge("static");
    toast("本页为静态快照，未连接数据服务，无法在线刷新");
    return;
  }
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "刷新中…";
  try {
    const res = await fetch("/api/refresh", { method: "POST", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${res.status}`);
    const j = await res.json().catch(() => ({}));
    if (j?.error) {
      toast(`刷新失败：${j.error}`, "err");
    } else if (j?.skipped) {
      toast("服务端刚刷新过，稍后再试");
    } else {
      toast("数据已刷新，正在重新加载…");
      setTimeout(() => location.reload(), 700);
    }
  } catch (e) {
    setDataBadge("static", "静态快照");
    toast("刷新接口不可用，本页为静态快照");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* --------------------------------- 12. 引导 ------------------------------- */

function wireTables() {
  initTable("tblCatScale", (r) => `
    <td><a class="linkbtn cat-link" href="#cat-${esc(r.catKey || r.key)}" data-cat="${esc(r.catKey || r.key)}">${esc(r.label)}</a></td>
    <td class="num">${n1(r.now)}</td>
    <td class="num">${n1(r.start)}</td>
    <td class="num ${ud(r.pct)}">${p2(r.pct)}</td>`);

  initTable("tblTop", (r) => `
    <td><button class="linkbtn sub-link" type="button" data-sub="${esc(r.sub)}">${esc(r.sub)}</button></td>
    <td class="num ${ud(r.delta)}">${s1(r.delta)}</td>
    <td class="num ${ud(r.pct)}">${p2(r.pct)}</td>`);

  initTable("tblBottom", (r) => `
    <td><button class="linkbtn sub-link" type="button" data-sub="${esc(r.sub)}">${esc(r.sub)}</button></td>
    <td class="num ${ud(r.delta)}">${s1(r.delta)}</td>
    <td class="num ${ud(r.pct)}">${p2(r.pct)}</td>`);

  // 小类名 / 大类名 → 打开抽屉或切页
  $("#tblGrid").addEventListener("click", (e) => {
    const sub = e.target.closest(".sub-link");
    if (sub) {
      e.preventDefault();
      openSub(sub.dataset.sub);
      return;
    }
    const cat = e.target.closest("a[data-cat]");
    if (cat) {
      e.preventDefault();
      activateCat(cat.dataset.cat, { scroll: true });
    }
  });
}

function fillTables() {
  const t = S.tables || {};
  const win = t.window || {};
  // 大类表：key 与 Tab 对应（合并项用 label 跳转到第一个子大类）
  const cats = (t.cats || []).map((c) => {
    let catKey = c.key;
    if (String(catKey).includes("&")) {
      catKey = S.cats.find((x) => x.key.startsWith(String(catKey).slice(0, 1) + "_"))?.key || S.cats[0]?.key;
    }
    return { ...c, catKey };
  });
  fillTable("tblCatScale", cats);
  fillTable("tblTop", t.top || []);
  fillTable("tblBottom", t.bottom || []);

  // 表头里的小提示
  const h = $("#secTop h2");
  if (h && win.from) h.dataset.sub = `${win.from} ~ ${win.to}`;
  const btn = $("#btnAllSubs");
  if (btn && t.all) btn.textContent = `查看全部 ${t.all.length} 个小类 ›`;
}

function fatalError(msg) {
  S.fatal = true;
  const host = $("#charts");
  if (host) {
    host.innerHTML = `<div class="fatal">
      <h2>数据加载失败</h2>
      <p>${esc(msg)}</p>
      <p class="muted">请确认 <code>data/</code> 目录存在（静态托管）或本地服务已启动，然后重试。</p>
      <button class="btn" type="button" id="fatalRetry">重试</button>
    </div>`;
    $("#fatalRetry")?.addEventListener("click", () => location.reload());
  }
  setDataBadge("static", "加载失败");
  $$("#tblCatScale tbody, #tblTop tbody, #tblBottom tbody").forEach((b) => (b.innerHTML = ""));
}

/** 读取 <meta name="etf-flow:signature"> 等隐性标识，挂到 window 并打一条控制台 banner */
function stampIdentity() {
  const q = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute("content") || "";
  const id = {
    project: "etf-flow",
    author: q("author"),
    generator: q("generator"),
    fingerprint: q("etf-flow:signature"),
    license: q("etf-flow:license"),
    origin: q("etf-flow:origin"),
    repo: "https://github.com/li2396803/etf-flow",
    build: document.documentElement.getAttribute("data-build") || "",
  };
  window.__ETFFLOW__ = id;
  document.documentElement.setAttribute("data-signature", id.fingerprint || "etf-flow");
  if (id.fingerprint) {
    try {
      console.log(
        `%c${id.project}%c v${id.generator.split("/")[1]?.split(" ")[0] || ""} · by ${id.author} · ${id.license}`,
        "background:#1f6feb;color:#fff;padding:2px 6px;border-radius:4px;font-weight:700",
        "color:#8b949e"
      );
      console.log(`%c指纹 ${id.fingerprint} · 仓库 ${id.repo}\n原典：${id.origin}`, "color:#8b949e");
    } catch (e) {}
  }
  return id;
}

/** 页脚的项目信息（数据截至 / 交易日 / 覆盖） */
function fillFoot() {
  const m = S.meta || {};
  const set = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.textContent = v; };
  set("footDate", m.lastTradeDate || "—");
  set("footDays", m.range?.days != null ? `${m.range.days} 个` : "—");
  set("footCover", m.counts ? `${m.counts.subs} 小类 / ${m.counts.etfs} 只 ETF` : "—");
}

async function boot() {
  const ID = stampIdentity();
  wireTheme();
  wireSearch();
  wireTables();

  $("#drawerClose")?.addEventListener("click", closeDrawer);
  $("#drawerMask")?.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && DRAWER.open) {
      e.preventDefault();
      closeDrawer();
    }
  });
  $("#btnExport")?.addEventListener("click", exportCurrentView);
  $("#btnRefresh")?.addEventListener("click", doRefresh);
  $("#btnAllSubs")?.addEventListener("click", openRank);
  $("#btnQuality")?.addEventListener("click", openQuality);
  $("#btnTop")?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  // ECharts 就绪
  S.echarts = await waitForEcharts();

  // 元信息 + 表格 + 搜索索引（并行，互不阻塞）
  const [metaR, tblR, idxR] = await Promise.allSettled([
    getData("meta.json", "/api/meta"),
    getData("tables.json", "/api/tables"),
    getData("index.json", "/api/index"),
  ]);

  if (metaR.status === "fulfilled") {
    S.meta = metaR.value.data;
    fillFoot();
    if (metaR.value.via === "api") noteApiFallback();
  }
  if (tblR.status === "fulfilled") S.tables = tblR.value.data;
  if (idxR.status === "fulfilled") {
    S.index = idxR.value.data;
    for (const s of S.index?.subs || []) subCat.set(s.name, s.cat);
    for (const e of S.index?.etfs || []) for (const sub of e.subs || []) {
      if (!etfSubs.has(e.code)) etfSubs.set(e.code, []);
      etfSubs.get(e.code).push(sub);
    }
  }

  renderHeader();
  if (!S.meta) {
    fatalError("未能读取 data/meta.json");
    return;
  }
  if (!S.index) {
    const si = $("#searchInput");
    if (si) {
      si.disabled = true;
      si.placeholder = "搜索索引加载失败";
    }
  }

  deriveCats();
  if (!S.cats.length) {
    fatalError("未在数据中找到任何大类（data/index.json 或 data/tables.json）");
    return;
  }

  // URL 里的状态必须先恢复，再据此渲染 Tab / 区间按钮
  readURL();

  buildTabs();
  buildRanges();
  buildCatSections();
  fillTables();

  activateCat(S.cat || S.cats[0].key);
  renderHighlightBar();

  // 抽屉如果要还原（?sub=）：延迟一点，避免和首屏图表抢资源
  if (S.sub) setTimeout(() => openSub(S.sub), 260);

  // 后台：探测服务 + 预取抽屉数据
  probeServer();
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
  idle(() => loadSubs().catch(() => {}));
}

function waitForEcharts(timeout = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function poll() {
      if (window.echarts) return resolve(window.echarts);
      if (Date.now() - t0 > timeout) return resolve(null);
      setTimeout(poll, 60);
    })();
  });
}

boot().catch((e) => {
  console.error(e);
  fatalError(String(e?.message || e));
});
