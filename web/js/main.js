/* ==========================================================================
   main：启动、路由、事件编排、主题、身份标识
   --------------------------------------------------------------------------
   启动顺序（尽量让首屏早出现，又不撒谎）：
     meta（小） → tables（小，拿大类清单） → 日历（market.json 或首个大类图表）
     → subs + index（并行，算区间统计） → 渲染 → 按需拉当前大类 charts
   ========================================================================== */

import * as api from "./api.js";
import * as chart from "./chart.js";
import * as ui from "./ui.js";
import * as views from "./views.js";
import {
  PRESETS,
  METRICS,
  OVERLAY_METRICS,
  overlayAllowed,
  setFocus,
  clearFocus,
  toggleOverlay,
  state,
  on,
  readURL,
  writeURL,
  setCalendar,
  syncRangeInfo,
  setPreset,
  setCustomRange,
  resetRange,
  loadWatch,
  toggleWatch,
  toggleCompare,
  clearCompare,
  inWatch,
  computeStats,
  marketRangeStats,
  range,
  indexOfDate,
} from "./state.js";
import { cnum, debounce, download, esc, fmtPct, fmtSigned, isDesktop, toCSV, toTSV, toneColor, isDark } from "./util.js";
import { initDetail, openDetail, initAllSubs, openAllSubs, initQuality } from "./detail.js";
import { toast } from "./ui.js";

const app = {
  meta: null,
  tables: null,
  subs: null,
  index: null,
  market: null,
  quality: null,
  cats: [],
  catMap: new Map(),
  subsByCat: new Map(),
  pinyin: new Map(),
  stats: null,
  subsReady: false,
  indexReady: false,
  chartData: new Map(),
  pinyinOf: (name) => app.pinyin.get(name) || "",
  onMarketRender: (p) => chart.renderMarket(p),
  onCategoryRender: (key) => renderCatChart(key),
};

let palette = null;
let marketReady = false;
let mainReady = false;
let freshChartToken = 0;
const COMPARE_COLORS = ["#4b57d6", "#d97a2b"];
const OVERLAY_COLORS = { scale: "#0e9c9c", pct: "#8b5cf6", flow: "#8b93a7" };
const METRIC_LABEL = { shares: "份额", scale: "规模", flow: "净流入", pct: "变化率" };
const METRIC_UNIT = { shares: "亿份", scale: "亿元", flow: "亿元/日", pct: "%" };
/** charts 缓存键：taxonomy + catKey，两套口径互不污染 */
const chartKey = (cat) => `${state.taxonomy}:${cat}`;
const getChart = (cat) => app.chartData.get(chartKey(cat));
const hasChart = (cat) => app.chartData.has(chartKey(cat));
const setChart = (cat, payload) => app.chartData.set(chartKey(cat), payload);

const isFocusMode = () =>
  !!(
    state.sub &&
    state.view === "cat" &&
    !state.compare.length &&
    (app.subsByCat?.get(state.cat) || []).includes(state.sub)
  );
const FALLBACK_CAT_COLORS = ["#D16F3F", "#D13F70", "#3F70D1", "#D1D03F", "#D03FD1", "#6F3FD1", "#70D13F", "#3FD16F", "#3FD1D0", "#8A6F3F"];

/* ==========================================================================
   身份标识（隐性署名）：读 <meta> 注入的签名，挂到 window 并打控制台 banner
   ========================================================================== */
function stampIdentity() {
  const q = (...names) => {
    for (const n of names) {
      const v = document.querySelector(`meta[name="${n}"]`)?.getAttribute("content");
      if (v) return v;
    }
    return "";
  };
  const id = {
    project: "ebbflow",
    author: q("author"),
    generator: q("generator"),
    // 新键名 ebbflow:*，旧数据包回退到 etf-flow:*
    fingerprint: q("ebbflow:signature", "etf-flow:signature"),
    license: q("ebbflow:license", "etf-flow:license"),
    origin: q("ebbflow:origin", "etf-flow:origin"),
    originBilibili: q("ebbflow:origin-bilibili"),
    originGithub: q("ebbflow:origin-github"),
    repo: "https://github.com/li2396803/ebbflow",
  };
  window.__ETFFLOW__ = id;
  document.documentElement.setAttribute("data-signature", id.fingerprint || "ebbflow");
  if (id.fingerprint) {
    try {
      const ver = (id.generator.match(/(?:ebbflow|etf-flow)\/([\d.]+)/) || [])[1] || "";
      console.log(
        `%cEbbflow%c v${ver} · by ${id.author} · ${id.license}`,
        "background:#4b57d6;color:#fff;padding:2px 6px;border-radius:4px;font-weight:700",
        "color:#8b949e"
      );
      console.log(`%c指纹 ${id.fingerprint} · 仓库 ${id.repo}\n原典：${id.origin}`, "color:#8b949e");
    } catch (e) {}
  }
}

/* ==========================================================================
   主题 / 显示设置
   ========================================================================== */
const THEME_KEY = "etf-theme";
const CVD_KEY = "etf-cvd";
const MOTION_KEY = "etf-motion";
const RAIL_KEY = "etf-rail";

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "auto";
}

function applyTheme(t, { persist = true } = {}) {
  document.documentElement.setAttribute("data-theme", t === "light" || t === "dark" ? t : "auto");
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch (e) {}
  }
  updateThemeBtn();
  chart.repaintAll();
  // sparkline 里用了 var(--up/--down) 与数据色，主题切换后重绘受影响的视图
  if (app.stats) renderView({ chart: false });
}

function updateThemeBtn() {
  const t = currentTheme();
  const use = document.querySelector("#themeIcon use");
  if (use) use.setAttribute("href", t === "light" ? "#i-sun" : t === "dark" ? "#i-moon" : "#i-monitor");
  const btn = document.getElementById("btnTheme");
  if (btn) {
    btn.title = `主题：${t === "light" ? "浅色" : t === "dark" ? "深色" : "跟随系统"}`;
    btn.setAttribute("aria-label", btn.title);
  }
}

function cycleTheme() {
  const order = ["auto", "light", "dark"];
  const i = order.indexOf(currentTheme());
  applyTheme(order[(i + 1) % order.length]);
  toast(`主题：${currentTheme() === "auto" ? "跟随系统" : currentTheme() === "light" ? "浅色" : "深色"}`, "info", 1400);
}

function applyCvd(on) {
  if (on) document.documentElement.setAttribute("data-cvd", "deuter");
  else document.documentElement.removeAttribute("data-cvd");
  try {
    localStorage.setItem(CVD_KEY, on ? "deuter" : "off");
  } catch (e) {}
  chart.repaintAll();
  if (app.stats) renderView({ chart: false });
}

function applyMotion(on) {
  if (on) document.documentElement.removeAttribute("data-motion");
  else document.documentElement.setAttribute("data-motion", "off");
  try {
    localStorage.setItem(MOTION_KEY, on ? "on" : "off");
  } catch (e) {}
}

function applyRail(mode) {
  document.documentElement.setAttribute("data-rail", mode);
  try {
    localStorage.setItem(RAIL_KEY, mode);
  } catch (e) {}
  const btn = document.getElementById("railToggle");
  btn?.setAttribute("aria-expanded", String(mode === "expanded"));
  btn?.setAttribute("aria-label", mode === "expanded" ? "收起侧边导航" : "展开侧边导航");
  setTimeout(() => {
    chart.resizeMain();
    chart.resizeMarket();
  }, 260);
}

function toggleRail() {
  const cur = document.documentElement.getAttribute("data-rail") === "collapsed" ? "expanded" : "collapsed";
  applyRail(cur);
}

function openSettings() {
  const pop = document.getElementById("settingsPop");
  const btn = document.getElementById("btnSettings");
  const theme = currentTheme();
  const cvd = document.documentElement.getAttribute("data-cvd") === "deuter";
  const motionOff = document.documentElement.getAttribute("data-motion") === "off";
  const rail = document.documentElement.getAttribute("data-rail");
  ui.openPopover(pop, btn, (host) => {
    host.innerHTML = `
      <div class="popover-title">主题</div>
      ${[
        ["auto", "跟随系统", "#i-monitor"],
        ["light", "浅色", "#i-sun"],
        ["dark", "深色", "#i-moon"],
      ]
        .map(
          ([v, label, ico]) => `<button class="popover-item" type="button" role="menuitemradio" aria-checked="${theme === v}" data-set-theme="${v}">
            <span class="pi-check" aria-hidden="true"><svg width="12" height="12"><use href="#i-check"/></svg></span>
            <svg width="14" height="14" aria-hidden="true" style="color:var(--ink-4)"><use href="${ico}"/></svg>${label}
          </button>`
        )
        .join("")}
      <div class="popover-sep"></div>
      <div class="popover-title">分类口径</div>
      <button class="popover-item" type="button" role="menuitemradio" aria-checked="${state.taxonomy === "v2"}" data-tax="v2">
        <span class="pi-check" aria-hidden="true"><svg width="12" height="12"><use href="#i-check"/></svg></span>
        新版分类<span class="dim t-2xs" style="margin-left:auto">指数类别 + 申万一级</span>
      </button>
      <button class="popover-item" type="button" role="menuitemradio" aria-checked="${state.taxonomy === "legacy"}" data-tax="legacy">
        <span class="pi-check" aria-hidden="true"><svg width="12" height="12"><use href="#i-check"/></svg></span>
        原看板口径<span class="dim t-2xs" style="margin-left:auto">86 小类·沪市</span>
      </button>
      <div class="popover-sep"></div>
      <div class="popover-title">涨跌配色</div>
      <button class="popover-item" type="button" role="menuitemradio" aria-checked="${!cvd}" data-set-cvd="0">
        <span class="pi-check" aria-hidden="true"><svg width="12" height="12"><use href="#i-check"/></svg></span>
        <span style="display:inline-flex;gap:3px" aria-hidden="true"><i style="width:8px;height:8px;border-radius:2px;background:#c8322d;display:inline-block"></i><i style="width:8px;height:8px;border-radius:2px;background:#0a7551;display:inline-block"></i></span>
        红涨绿跌（A 股习惯）
      </button>
      <button class="popover-item" type="button" role="menuitemradio" aria-checked="${cvd}" data-set-cvd="1">
        <span class="pi-check" aria-hidden="true"><svg width="12" height="12"><use href="#i-check"/></svg></span>
        <span style="display:inline-flex;gap:3px" aria-hidden="true"><i style="width:8px;height:8px;border-radius:2px;background:#1f63c9;display:inline-block"></i><i style="width:8px;height:8px;border-radius:2px;background:#b45309;display:inline-block"></i></span>
        蓝涨橙跌（色盲友好）
      </button>
      <div class="popover-sep"></div>
      <div class="popover-title">其他</div>
      <button class="popover-item" type="button" role="menuitemcheckbox" aria-checked="${motionOff}" data-set-motion="${motionOff ? "1" : "0"}">
        <span class="pi-check" aria-hidden="true"><svg width="12" height="12"><use href="#i-check"/></svg></span>
        减少动效
      </button>
      ${
        isDesktop()
          ? `<button class="popover-item" type="button" data-set-rail="1">
              <span class="pi-check" aria-hidden="true"><svg width="12" height="12"><use href="#i-check"/></svg></span>
              ${rail === "collapsed" ? "展开侧边导航" : "收起侧边导航"}
            </button>`
          : ""
      }
      <div class="popover-sep"></div>
      <button class="popover-item" type="button" data-open-quality="1">
        <span class="pi-check" aria-hidden="true"></span>
        <svg width="14" height="14" aria-hidden="true" style="color:var(--ink-4)"><use href="#i-shield"/></svg>数据质量
      </button>
      <button class="popover-item" type="button" data-open-shortcuts="1">
        <span class="pi-check" aria-hidden="true"></span>
        <svg width="14" height="14" aria-hidden="true" style="color:var(--ink-4)"><use href="#i-info"/></svg>快捷键
      </button>`;
  });
}

/* ==========================================================================
   数据徽标 / 页脚 / 元信息
   ========================================================================== */
function setDataBadge(mode, text) {
  const badge = document.getElementById("dataBadge");
  const txt = document.getElementById("dataBadgeTxt");
  if (!badge || !txt) return;
  badge.dataset.mode = mode;
  txt.textContent = text;
  badge.title = mode === "static" ? "当前为静态数据（site/data/*.json）" : mode === "live" ? "当前连接本地服务（127.0.0.1:5188）" : text;
}

function applyMeta() {
  const m = app.meta || {};
  document.title = `Ebbflow · ${m.title || "ETF 细分行业资金流向"}`;

  // 计数文案统一从 meta.counts 读（小类/ETF/大类数量会随数据增长，不写死）
  const subs = m.counts?.subs;
  const etfs = m.counts?.etfs;
  const cats = m.counts?.cats ?? app.cats.length;
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  if (subs) {
    setText("navAllSubsLabel", `全部 ${subs} 个小类`);
    setText("allTitle", `全部 ${subs} 个细分行业`);
  }
  if (cats) setText("catGridTitle", `${cats} 大类区间表现`);
  if (subs && etfs) setText("paletteHint", `输入以搜索 ${subs} 个小类与 ${etfs} 只 ETF`);
  const navBtn = document.getElementById("btnAllSubsNav");
  if (navBtn && subs) navBtn.setAttribute("aria-label", `查看全部 ${subs} 个小类`);
  const taxLine = document.getElementById("taxLine");
  if (taxLine) {
    taxLine.textContent =
      state.taxonomy === "legacy" ? "分类口径：原看板（86 小类·沪市）" : "分类口径：v2（指数类别 + 申万一级）";
  }
  const desc = document.querySelector('meta[name="description"]');
  if (desc && subs && etfs) {
    desc.setAttribute(
      "content",
      `Ebbflow · ETF 细分行业资金流向：${cats} 大类 / ${subs} 个细分行业 / ${etfs} 只 ETF 的份额、规模与净流入长期序列，含区间对比、自选、全市场总览与数据质量校验。`
    );
  }
  fillFoot();
  const rf = document.getElementById("railFoot");
  if (rf) {
    rf.innerHTML = `数据截至 <b class="tnum">${esc(m.lastTradeDate || "—")}</b><br>仅供研究参考`;
  }
  const badgeMode = api.net.mode === "live" ? "live" : "static";
  setDataBadge(badgeMode, api.net.mode === "live" ? "本地服务" : `静态数据`);
  if (m.warnings?.length) {
    const main = document.getElementById("main");
    if (main && !document.getElementById("warnBanner")) {
      const el = document.createElement("div");
      el.id = "warnBanner";
      el.className = "notice notice--warn";
      el.innerHTML = `<svg aria-hidden="true"><use href="#i-alert"/></svg><span>数据管线告警：${esc(m.warnings.slice(0, 2).join("；"))}</span>`;
      main.prepend(el);
    }
  }
}

function fillFoot() {
  const m = app.meta || {};
  const set = (id, v) => {
    const e = document.getElementById(id);
    if (e && v != null) e.textContent = v;
  };
  set("footDate", m.lastTradeDate || "—");
  set("footDays", m.range?.days != null ? `${m.range.days} 个` : "—");
  set(
    "footCover",
    m.counts ? `${m.counts.subs} 小类 / ${m.counts.etfs} 只 ETF` : m.counts ? "—" : "—"
  );
  const dots = [];
  for (const [k, label] of [
    ["sh", "沪市"],
    ["sz", "深市"],
  ]) {
    const v = m.markets?.[k];
    if (v) dots.push(`${label} ${v.covered ?? "—"}/${v.etfs ?? "—"}`);
  }
  const note = document.getElementById("footNote");
  if (note && dots.length) {
    note.textContent = `数据来自交易所公开接口，仅供研究参考，不构成投资建议。· 覆盖 ${dots.join(" · ")}`;
  }
}

/* ==========================================================================
   目录（大类 / 小类 / 拼音）
   ========================================================================== */
function buildCatalog() {
  const byCat = new Map();
  for (const [name, entry] of Object.entries(app.subs || {})) {
    const k = entry.cat || "未分类";
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(name);
  }
  app.subsByCat = byCat;

  // 规范清单：meta.categories（10 项，与 charts-<key>.json 一一对应）
  // 注意 tables.cats 是「9 行合并口径」（含 7_医药&消费），不能拿来当导航。
  const labelOf = new Map();
  for (const s of app.index?.subs || []) if (s.cat && !labelOf.has(s.cat)) labelOf.set(s.cat, s.label || s.cat);
  let cats = [];
  const metaCats = Array.isArray(app.meta?.categories) ? app.meta.categories : [];
  if (metaCats.length) {
    cats = metaCats.map((c) => ({
      key: c.key,
      label: c.label || c.key,
      color: c.color || null,
      subs: c.subs,
    }));
    // subs 里存在但 meta 没列的（防御：数据包不一致时也不丢小类）
    for (const k of byCat.keys()) {
      if (!cats.some((c) => c.key === k)) cats.push({ key: k, label: labelOf.get(k) || k.replace("_", "."), color: null });
    }
  } else if (byCat.size) {
    cats = Array.from(byCat.keys()).map((k) => ({ key: k, label: labelOf.get(k) || k.replace("_", "."), color: null }));
    for (const c of app.tables?.cats || []) {
      if (!byCat.has(c.key) && !c.key.includes("&")) cats.push({ key: c.key, label: c.label || c.key, color: null });
    }
  } else if (app.tables?.cats?.length) {
    cats = app.tables.cats.filter((c) => !c.key.includes("&")).map((c) => ({ key: c.key, label: c.label || c.key, color: null, pct: c.pct }));
  }
  // 颜色：优先 charts 已加载的 color，其次 subs 里第一个小类的颜色，最后回退调色板
  cats = cats.map((c, i) => {
    const color =
      getChart(c.key)?.color ||
      app.subs?.[(byCat.get(c.key) || [])[0]]?.color ||
      FALLBACK_CAT_COLORS[i % FALLBACK_CAT_COLORS.length];
    return { ...c, color };
  });
  if (!metaCats.length) {
    const order = new Map(cats.map((c, i) => [c.key, i]));
    cats.sort((a, b) => {
      const na = parseInt(a.key, 10);
      const nb = parseInt(b.key, 10);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return (order.get(a.key) || 0) - (order.get(b.key) || 0);
    });
  }
  app.cats = cats;
  app.catMap = new Map(cats.map((c) => [c.key, c]));

  // 拼音（index.json 优先）
  app.pinyin = new Map();
  for (const s of app.index?.subs || []) {
    if (s.name && s.pinyin) app.pinyin.set(s.name, String(s.pinyin).toLowerCase());
  }
}

function recomputeStats() {
  syncRangeInfo();
  app.stats = computeStats(app.subs, state.rangeInfo);
}

/* ==========================================================================
   懒加载：subs.json（~1.9MB）/ index.json（~86KB）
   --------------------------------------------------------------------------
   首屏只拉 meta + market + 当前大类 charts；这两份数据在需要时才加载：
   · 抽屉（成分 ETF）/ 搜索（索引）/ 全部小类（区间统计）/ 大类明细表
   · 首屏渲染完成后，空闲时再补一份，让总览的卡片与排行自然补齐
   加载期间各视图给轻量占位（骨架），不阻塞任何交互。
   ========================================================================== */
let subsPromise = null;
let indexPromise = null;

/** @returns {Promise<object|null>} subs.json 内容 */
export function ensureSubs() {
  if (app.subs) return Promise.resolve(app.subs);
  if (subsPromise) return subsPromise;
  subsPromise = api
    .load("subs")
    .then((data) => {
      app.subs = data;
      app.subsReady = true;
      buildCatalog();
      recomputeStats();
      app.flowOf = flowOf;
      app.catFlowOf = catFlowOf;
      afterSubsReady();
      return data;
    })
    .catch((e) => {
      subsPromise = null;
      toast("成分数据加载失败，请检查 data/subs.json", "error", 3600);
      throw e;
    });
  return subsPromise;
}

/** @returns {Promise<object|null>} index.json 内容（搜索索引） */
export function ensureIndex() {
  if (app.index) return Promise.resolve(app.index);
  if (indexPromise) return indexPromise;
  indexPromise = api
    .load("index")
    .then((data) => {
      app.index = data;
      app.indexReady = true;
      // 索引里带 pinyin + 大类标签，顺手补一份小类→大类映射
      app.pinyin = new Map();
      for (const s of data?.subs || []) if (s.name && s.pinyin) app.pinyin.set(s.name, String(s.pinyin).toLowerCase());
      if (!app.cats.length && Array.isArray(data?.subs)) {
        const seen = new Map();
        for (const s of data.subs) if (!seen.has(s.cat)) seen.set(s.cat, { key: s.cat, label: s.label || s.cat, color: null });
        app.cats = Array.from(seen.values());
        app.catMap = new Map(app.cats.map((c) => [c.key, c]));
      }
      return data;
    })
    .catch((e) => {
      indexPromise = null;
      throw e;
    });
  return indexPromise;
}

/** subs 到位后：补齐所有依赖区间统计的区块（并触发图表预取） */
function afterSubsReady() {
  if (state.view === "cat" && state.cat) {
    renderCatChart(state.cat, { silent: true });
  }
  if (!marketReady) ensureMarketChart().then(() => chart.repaintAll());
  renderView({ chart: state.view === "cat" });
  scheduleChartPrefetch();
}

/* ==========================================================================
   日历（交易日轴）
   ========================================================================== */
async function ensureCalendar() {
  if (state.calendar.length > 2) return state.calendar;
  // 1) market.json 自带全市场 dates
  try {
    const m = await api.load("market");
    app.market = m;
    if (Array.isArray(m?.dates) && m.dates.length > 2) {
      setCalendar(m.dates);
      return state.calendar;
    }
  } catch (e) {
    /* 老数据包没有 market.json，继续走备选 */
  }
  // 2) 任一 available 大类图表
  const keys = api.catKeys();
  const candidates = [state.cat, ...keys].filter(Boolean);
  for (const k of candidates) {
    try {
      const p = await api.load(`charts:${k}`);
      setChart(k, p);
      if (Array.isArray(p?.dates) && p.dates.length > 2) {
        setCalendar(p.dates);
        return state.calendar;
      }
    } catch (e) {
      /* 试下一个 */
    }
  }
  // 3) subs 里的 dates
  const anySub = Object.values(app.subs || {}).find((x) => Array.isArray(x.dates) && x.dates.length > 2);
  if (anySub) {
    setCalendar(anySub.dates);
    return state.calendar;
  }
  return state.calendar;
}

/* ==========================================================================
   视图渲染
   ========================================================================== */
function renderView({ chart: withChart = true } = {}) {
  try {
    chart.hideTooltips?.();
  } catch (e) {}
  const views_ = { overview: "view-overview", cat: "view-cat", watch: "view-watch" };
  for (const [key, id] of Object.entries(views_)) {
    const el = document.getElementById(id);
    if (el) el.hidden = key !== state.view;
  }
  views.syncNavActive(app);
  views.renderRangeSegs();

  if (state.view === "overview") {
    views.renderOverview(app);
    ensureMarketChart().then(() => chart.repaintAll());
  } else if (state.view === "cat") {
    if (!state.cat && app.cats.length) state.cat = app.cats[0].key;
    views.renderCategory(app, { chart: withChart });
    ensureSubs().catch(() => {});
  } else {
    views.renderWatch(app);
    ensureSubs().catch(() => {});
  }
  views.renderCatNav(app);
  views.syncNavActive(app);
  syncFocusUI();
  renderRangeChip();
}

function renderRangeChip() {
  const chip = document.getElementById("rangeChip");
  const txt = document.getElementById("rangeChipTxt");
  const r = state.rangeInfo;
  if (!chip || !txt) return;
  if (!r.isCustom) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  txt.textContent = `${r.from} → ${r.to} · ${r.days} 日`;
  chip.title = `自定义区间：${r.from} 至 ${r.to}（${r.days} 个交易日），点击 ✕ 恢复默认`;
}

/**
 * 区间净流入：优先用已加载图表里的「每日净流入」求和（精确），
 * 未加载时退回 Δ份额 × 最新净值（近似）。两处 UI 都标「估算」，避免口径承诺。
 */
function flowOf(name, stats) {
  const s = stats || app.stats?.byName?.get(name);
  if (!s) return 0;
  const cat = app.subs?.[name]?.cat;
  const payload = cat ? getChart(cat) : null;
  const series = payload?.series?.find((x) => x.name === name);
  if (series?.flow?.length) {
    const { fromIdx, toIdx } = state.rangeInfo;
    if (fromIdx >= 0) {
      let sum = 0;
      let hit = 0;
      for (let i = fromIdx; i <= Math.min(toIdx, series.flow.length - 1); i++) {
        const v = series.flow[i];
        if (v != null && Number.isFinite(+v)) {
          sum += +v;
          hit += 1;
        }
      }
      if (hit) return sum;
    }
  }
  const nav = s.scale != null && s.last ? s.scale / s.last : null;
  return Number.isFinite(nav) && nav ? s.delta * nav : s.flow || 0;
}

function catFlowOf(key) {
  return (app.subsByCat?.get(key) || []).reduce((acc, n) => acc + flowOf(n), 0);
}

/* ==========================================================================
   图表编排
   ========================================================================== */
async function ensureMarketChart() {
  if (marketReady) return;
  const el = document.getElementById("mktChart");
  if (!el) return;
  if (!app.market) {
    document.getElementById("mktLoading")?.remove();
    return;
  }
  await chart.initMarket(el);
  performance.mark("ebbflow:market-init");
  marketReady = true;
  document.getElementById("mktLoading")?.remove();
}

async function ensureMainChart() {
  if (mainReady) return;
  const el = document.getElementById("mainChart");
  if (!el) return;
  await chart.initMain(el, {
    onRangeChange: (from, to, source) => {
      commitRange(from, to, source);
    },
    onReset: () => {
      resetRange();
      afterRangeChange("reset");
    },
  });
  mainReady = true;
}

/** 图例右侧的数值：净流入显示区间累计（当日值没有比较意义），其余显示窗口末端值 */
function legendValue(series, payload) {
  if (state.metric !== "flow" || !payload?.series) return lastNonNull(series.values, 0, series.values.length - 1);
  const { fromIdx, toIdx } = state.rangeInfo;
  const raw = payload.series.find((x) => x.name === series.name)?.flow;
  if (!raw || fromIdx < 0) return null;
  let sum = 0;
  for (let i = fromIdx; i <= toIdx; i++) {
    const v = raw[i];
    if (v != null && Number.isFinite(+v)) sum += +v;
  }
  return sum;
}

function idxIn(dates, d) {
  const i = dates.indexOf(d);
  if (i >= 0) return i;
  // 找不到就取最后一个 <= d 的位置
  let lo = 0;
  for (let k = 0; k < dates.length; k++) if (dates[k] <= d) lo = k;
  return lo;
}

function normalizeSeries(arr, a, b, base, { index100 = false } = {}) {
  const baseIdx = typeof base === "number" ? base : null;
  let bv = baseIdx != null ? arr[baseIdx] : null;
  if (bv == null) {
    for (let i = a; i <= b; i++) if (arr[i] != null && Number.isFinite(+arr[i])) { bv = +arr[i]; break; }
  }
  if (bv == null || bv === 0) return arr.map(() => null);
  return arr.map((v) => (v == null || !Number.isFinite(+v) ? null : index100 ? (v / bv) * 100 : (v / bv - 1) * 100));
}

function firstNonNull(arr, a, b) {
  for (let i = a; i <= b; i++) if (arr[i] != null && Number.isFinite(+arr[i])) return +arr[i];
  return null;
}
function lastNonNull(arr, a, b) {
  for (let i = b; i >= a; i--) if (arr[i] != null && Number.isFinite(+arr[i])) return +arr[i];
  return null;
}

/** 组装主图 payload：指标/归一化/对比都在这里收敛 */
function buildChartPayload(payload, catKey) {
  const dates = payload.dates || state.calendar;
  const r = state.rangeInfo;
  const a = idxIn(dates, r.from);
  const b = idxIn(dates, r.to);
  const metric = state.metric;
  const compare =
    state.compare.length > 0
      ? state.compare
          .map((name) => {
            const cat = app.subs?.[name]?.cat;
            const p = getChart(cat);
            const s = p?.series?.find((x) => x.name === name);
            return s ? { name, color: s.color, series: s } : null;
          })
          .filter(Boolean)
      : [];

  let series = [];
  let mode = metric === "flow" ? "bar" : "line";
  let unit = metric === "flow" ? "亿元 / 日" : metric === "scale" ? "亿元" : metric === "shares" ? "亿份" : "%";
  let footNote = "";
  let secondary = null;

  if (compare.length) {
    mode = "line";
    if (metric === "flow") {
      unit = "亿元（区间累计）";
      series = compare.map((c, i) => {
        const arr = c.series.flow || [];
        let acc = 0;
        const vals = arr.map((v, i) => {
          if (i < a) return null;
          if (i > b) return null;
          if (v == null) return null;
          acc += v;
          return +acc.toFixed(2);
        });
        return { name: c.name, color: COMPARE_COLORS[i % 2], values: vals };
      });
      footNote = "对比：区间累计净流入";
    } else {
      unit = "指数（区间起点 = 100）";
      series = compare.map((c, i) => {
        const arr = c.series[metric === "pct" ? "shares" : metric] || [];
        const baseIdx = state.norm === "all" ? 0 : a;
        return {
          name: c.name,
          color: COMPARE_COLORS[i % 2],
          values: normalizeSeries(arr, a, b, state.norm === "all" ? null : baseIdx, { index100: true }),
        };
      });
      footNote = "对比：归一化到区间起点 = 100";
    }
  } else {
    const list = (payload.series || []).filter((s) => (s[metric === "pct" ? "shares" : metric] || []).some((v) => v != null));
    series = list.map((s) => {
      let values;
      if (metric === "pct") {
        const baseIdx = state.norm === "all" ? 0 : a;
        values = normalizeSeries(s.shares || [], a, b, state.norm === "all" ? null : baseIdx, { index100: false });
      } else {
        values = s[metric] || [];
      }
      return { name: s.name, color: s.color, values };
    });
    if (metric === "pct") {
      footNote = state.norm === "all" ? "相对全历史首日的变化率" : "相对区间首日的变化率";
      unit = "%";
    } else if (metric === "flow") {
      footNote = "每日净流入（Δ份额 × 当日净值）";
    }

    // tooltip 第二列
    const map = {};
    for (const s of list) {
      if (metric === "pct") {
        const v = lastNonNull(s.shares || [], a, b);
        map[s.name] = v;
      } else if (metric === "flow") {
        const arr = s.flow || [];
        const totalAbs = arr.slice(a, b + 1).reduce((acc, v) => acc + (v == null ? 0 : Math.abs(v)), 0) || 1;
        const lastV = lastNonNull(arr, a, b);
        map[s.name] = lastV == null ? null : (Math.abs(lastV) / totalAbs) * 100;
      } else {
        const f = firstNonNull(s[metric] || [], a, b);
        const l = lastNonNull(s[metric] || [], a, b);
        map[s.name] = f && l != null ? ((l - f) / Math.abs(f)) * 100 : null;
      }
    }
    secondary = { type: metric === "flow" ? "pct" : metric === "pct" ? "value" : "pct", map };
  }

  // 端点标签（窗口末端）
  const endLabels = series
    .map((s) => {
      const v = lastNonNull(s.values, 0, s.values.length - 1);
      return v == null ? null : { name: s.name, value: v, color: s.color };
    })
    .filter(Boolean)
    .sort((m, n) => Math.abs(n.value) - Math.abs(m.value))
    // 全部交给 chart.js：竖直放得下就全画，放不下再按 |值| 保留 6 条 + 「查看全部」
    .slice(0, 12);

  const axisRole = metric === "pct" ? "pct" : metric === "flow" ? "flow" : "amount";
  const kind = mode === "bar" ? "bar" : "line";
  const unitOf = {};
  for (const s of series) unitOf[s.name] = unit;

  return {
    dates,
    series: series.map((s) => ({ ...s, kind, axis: 0, unit })),
    axes: [{ role: axisRole, position: "left" }],
    unitOf,
    mixed: false,
    mode,
    unit,
    zero: metric === "flow" && !compare.length,
    focused: state.focused,
    log: state.log && metric !== "flow" && metric !== "pct" && !compare.length,
    compare: compare.length > 0,
    secondary,
    footNote,
    endLabels: endLabels.map((x) => ({ ...x, axis: 0 })),
    endLabelDigits: metric === "pct" || compare.length ? 1 : 0,
    gutterRight: isDesktop() ? 124 : 10,
    gridRight: (isDesktop() ? 124 : 10) + 8,
    zoom: [a, b],
    metric,
    catKey,
  };
}

/**
 * 单系列聚焦 + 指标叠加：
 *  · 左轴 = 金额（份额/规模；主指标是净流入时左轴就是 亿元/日）
 *  · 右轴 = 百分比（变化率，仅在勾选时出现）
 *  · 净流入永远是柱子，且有独立轴（不与折线共用刻度），z 轴压在折线下方
 */
function buildFocusPayload(payload, catKey, name) {
  const dates = payload.dates || state.calendar;
  const r = state.rangeInfo;
  const a = idxIn(dates, r.from);
  const b = idxIn(dates, r.to);
  const sub = payload.series?.find((x) => x.name === name);
  if (!sub) return buildChartPayload(payload, catKey);

  const main = state.metric;
  const overlays = state.overlay.filter((m) => m !== main && OVERLAY_METRICS.includes(m));
  const arrOf = (m) => (m === "scale" ? sub.scale : m === "flow" ? sub.flow : sub.shares);
  const pctSource = main === "scale" ? "scale" : "shares";
  const pctValues = () => normalizeSeries(arrOf(pctSource), a, b, state.norm === "all" ? null : a, { index100: false });

  const mainColor = toneColor(sub.color || "#4b57d6", isDark());
  const scaleColor = toneColor(OVERLAY_COLORS.scale, isDark());
  const pctColor = toneColor(OVERLAY_COLORS.pct, isDark());

  const hasScale = overlays.includes("scale");
  const hasFlow = main === "flow" || overlays.includes("flow");
  const hasPct = main === "pct" || overlays.includes("pct");

  let leftRole;
  if (main === "flow") leftRole = "flow";
  else if (main === "shares" || main === "scale") leftRole = "amount";
  else leftRole = hasScale ? "amount" : "pct";

  const axes = [];
  const addAxis = (role, position) => {
    axes.push({ role, position, offset: 0 });
    return axes.length - 1;
  };
  const leftIdx = addAxis(leftRole, "left");
  const pctIdx = hasPct ? (leftRole === "pct" ? leftIdx : addAxis("pct", "right")) : null;
  const flowIdx = hasFlow ? (leftRole === "flow" ? leftIdx : addAxis("flow", "right")) : null;
  const amountRightIdx = main === "flow" && hasScale ? addAxis("amount", "right") : null;
  let rightCount = 0;
  for (const ax of axes) {
    if (ax.position === "right") {
      ax.offset = rightCount * 54;
      rightCount += 1;
    }
  }

  const series = [];
  const lastOf = (values) => lastNonNull(values, 0, values.length - 1);
  const pushLine = (metric, values, color, { dash = false } = {}) => {
    const axis = metric === "scale" ? (main === "flow" ? amountRightIdx : leftIdx) : metric === "pct" ? pctIdx : leftIdx;
    series.push({
      name: METRIC_LABEL[metric],
      metricId: metric,
      isOverlay: metric !== main,
      values,
      color,
      kind: "line",
      axis,
      unit: METRIC_UNIT[metric],
      dash,
    });
  };
  const pushBars = (metric, values) => {
    series.push({
      name: METRIC_LABEL[metric],
      metricId: metric,
      isOverlay: metric !== main,
      values,
      color: toneColor(OVERLAY_COLORS.flow, isDark()),
      kind: "bar",
      axis: flowIdx,
      unit: METRIC_UNIT.flow,
    });
  };

  // 主指标
  if (main === "flow") pushBars("flow", arrOf("flow"));
  else if (main === "pct") pushLine("pct", pctValues(), mainColor);
  else pushLine(main, arrOf(main), mainColor);

  // 叠加项
  if (hasScale && main !== "scale") pushLine("scale", arrOf("scale"), scaleColor);
  if (overlays.includes("flow")) pushBars("flow", arrOf("flow"));
  if (overlays.includes("pct")) pushLine("pct", pctValues(), pctColor, { dash: true });

  const unitOf = {};
  for (const s of series) unitOf[s.name] = s.unit;
  const lineSeries = series.filter((s) => s.kind === "line");
  const gutter = isDesktop() && lineSeries.length ? 92 : 0;
  const gridRight = 12 + rightCount * 54 + gutter;
  const endLabels = lineSeries
    .map((s) => {
      const v = lastOf(s.values);
      return v == null ? null : { name: s.name, value: v, color: s.color, axis: s.axis };
    })
    .filter(Boolean);

  return {
    dates,
    series,
    axes,
    unitOf,
    zoom: [a, b],
    area: series.length === 1,
    mixed: series.length > 1,
    mode: series.some((s) => s.kind === "bar") ? "bar" : "line",
    unit: series[0]?.unit || "",
    zero: false,
    focused: null,
    log: false,
    compare: false,
    secondary: null,
    footNote: [
      `${name} · 主指标 ${METRIC_LABEL[main]}`,
      overlays.length ? `叠加 ${overlays.map((m) => METRIC_LABEL[m]).join(" / ")}` : "未叠加",
    ].join(" ｜ "),
    endLabels,
    endLabelDigits: 1,
    gutterRight: gutter,
    gridRight,
    focusMode: true,
    focusName: name,
    legend: series.map((s) => ({
      id: s.metricId,
      label: s.name,
      unit: s.unit,
      color: s.color,
      kind: s.kind,
      toggle: s.isOverlay,
      value: lastOf(s.values),
    })),
  };
}

async function renderCatChart(catKey, opts = {}) {
  const token = ++freshChartToken;
  const loading = document.getElementById("mainLoading");
  const catNameEl = document.getElementById("mainLoadingCat");
  if (catNameEl) catNameEl.textContent = app.catMap.get(catKey)?.label || catKey;
  if (loading && !opts.silent) loading.hidden = false;
  try {
    let payload = getChart(catKey);
    if (!payload) {
      payload = await api.load(`charts:${catKey}`);
      setChart(catKey, payload);
    }
    // 对比对象可能在别的大类，需要补齐
    for (const name of state.compare) {
      const cat = app.subs?.[name]?.cat;
      if (cat && !hasChart(cat)) {
        try {
          setChart(cat, await api.load(`charts:${cat}`));
        } catch (e) {}
      }
    }
    if (token !== freshChartToken) return;
    await ensureMainChart();
    if (token !== freshChartToken) return;
    if (payload?.dates?.length && state.calendar.length !== payload.dates.length) {
      setCalendar(payload.dates);
      recomputeStats();
    }
    const p = isFocusMode() ? buildFocusPayload(payload, catKey, state.sub) : buildChartPayload(payload, catKey);
    syncLogUI();
    syncFocusUI();
    const shell = document.getElementById("mainWrap");
    shell?.querySelector(".chart-empty")?.remove();
    if (!p.series.length) {
      if (shell) {
        const div = document.createElement("div");
        div.className = "chart-empty";
        div.innerHTML = `<div class="state"><div class="state-ico" aria-hidden="true"><svg width="18" height="18"><use href="#i-info"/></svg></div>
          <p class="state-title">该区间没有可用数据</p>
          <p class="state-desc">所选区间内这个大类没有任何非空观测（可能是停牌、净值缺失或超出数据范围）。换一个区间或点「重置」试试。</p>
          <button class="btn btn--sm" type="button" id="emptyRangeReset">恢复默认区间</button></div>`;
        shell.append(div);
        div.querySelector("#emptyRangeReset")?.addEventListener("click", () => {
          resetRange();
          afterRangeChange("reset");
        });
      }
      if (loading) loading.hidden = true;
      return;
    }
    chart.renderMain(p);
    if (p.focusMode) {
      views.renderFocusLegend(p.legend, (id) => toggleOverlayFromUI(id));
    } else {
      views.renderLegend(
        p.series.map((s) => ({
          name: s.name,
          color: s.color,
          endValue: legendValue(s, payload),
        })),
        state.focused,
        onFocusSeries
      );
    }
    const unitEl = document.getElementById("chartUnit");
    const metricObj = METRICS.find((m) => m.id === state.metric);
    const hintEl = document.querySelector(".legend-hint");
    if (hintEl) {
      hintEl.textContent = p.focusMode
        ? "点带单位的叠加项可从图例移除；主指标在上方切换"
        : "点击图例聚焦某个小类 · 再点「全部」退出";
    }
    if (unitEl) {
      unitEl.innerHTML = p.focusMode
        ? `<b>${esc(state.sub)}</b> 单系列 · 主指标 ${esc(metricObj?.label || "")}（${esc(METRIC_UNIT[state.metric])}）${
            state.overlay.length ? ` · 叠加 ${esc(state.overlay.map((m) => METRIC_LABEL[m]).join(" / "))}` : " · 未叠加"
          } · ${esc(rangeTextForChart())}`
        : `<b>${esc(metricObj?.label || "")}</b> ${esc(p.unit)} · ${p.series.length} 个系列 · ${esc(rangeTextForChart())}${
            p.compare ? " · 对比模式" : ""
          }`;
    }
    document.getElementById("brushHint").hidden = true;
  } catch (e) {
    if (token !== freshChartToken) return;
    console.error("[cat-chart]", e);
    const shell = document.getElementById("mainWrap");
    if (shell) {
      const old = shell.querySelector(".chart-empty");
      old?.remove();
      const div = document.createElement("div");
      div.className = "chart-empty";
      div.innerHTML = `<div class="state"><div class="state-ico" aria-hidden="true"><svg width="18" height="18"><use href="#i-alert"/></svg></div>
        <p class="state-title">该大类图表加载失败</p>
        <p class="state-desc">${esc(e?.message || "未知错误")}。数据文件可能尚未生成，表格是实时计算的仍可用。</p>
        <button class="btn btn--sm" type="button" data-retry-chart="1">重试</button></div>`;
      shell.append(div);
    }
  } finally {
    if (token === freshChartToken && loading) loading.hidden = true;
  }
}

const rangeTextForChart = () => `${state.rangeInfo.from} → ${state.rangeInfo.to} · ${state.rangeInfo.days} 个交易日`;

function onFocusSeries(name) {
  if (state.compare.length) {
    // 对比模式：维持「淡化其它」的语义
    state.focused = name || null;
    if (state.view !== "cat") return;
    const payload = getChart(state.cat);
    if (!payload) return;
    chart.renderMain(buildChartPayload(payload, state.cat));
    views.renderLegend(
      (payload.series || []).map((s) => ({
        name: s.name,
        color: s.color,
        endValue: legendValue({ name: s.name, values: (state.metric === "pct" ? s.shares : s[state.metric]) || [] }, payload),
      })),
      state.focused,
      onFocusSeries
    );
    return;
  }
  if (!name) return; // 多系列里的「全部」= 已经是全部
  if (state.sub === name) return;
  setFocus(name);
  writeURL({ replace: true });
  syncFocusUI();
  if (state.view === "cat") renderCatChart(state.cat, { silent: true });
}

/** 叠加项开关（胶囊 / 图例共用） */
function toggleOverlayFromUI(id) {
  if (!isFocusMode()) return;
  const max = isDesktop() ? Infinity : 2;
  const res = toggleOverlay(id, { max });
  if (res.reason === "limit") {
    toast(`小屏最多叠加 ${max} 项`, "error", 2200);
    return;
  }
  if (!res.changed) return;
  writeURL({ replace: true });
  syncFocusUI();
  renderCatChart(state.cat, { silent: true });
}

/** 聚焦态 UI：聚焦胶囊 + 叠加开关（只在单系列聚焦时出现） */
function syncFocusUI() {
  const bar = document.getElementById("focusBar");
  if (!bar) return;
  const on = isFocusMode();
  bar.hidden = !on;
  if (!on) return;
  const name = state.sub;
  const sub = app.subs?.[name];
  const dot = document.getElementById("focusDot");
  if (dot) dot.style.background = toneColor(sub?.color || "#4b57d6", isDark());
  const nm = document.getElementById("focusName");
  if (nm) nm.textContent = name;

  // 小屏：最多 2 项，超出直接截断（进入时可能来自分享链接）
  const max = isDesktop() ? Infinity : 2;
  if (state.overlay.length > max) {
    state.overlay = state.overlay.slice(0, max);
    writeURL({ replace: true });
  }
  const group = document.getElementById("overlayGroup");
  if (group) {
    const allowed = overlayAllowed();
    group.innerHTML = allowed
      .map(
        (m) => `<button class="ov-pill" type="button" data-overlay="${m}" aria-pressed="${
          state.overlay.includes(m)
        }" title="叠加${METRIC_LABEL[m]}（${METRIC_UNIT[m]}）">
          <span class="ov-name">${METRIC_LABEL[m]}</span><span class="ov-unit">${METRIC_UNIT[m]}</span>
        </button>`
      )
      .join("");
  }
  const tip = document.getElementById("overlayTip");
  if (tip) {
    tip.textContent = isDesktop() ? "" : max === 2 ? `小屏最多叠加 ${max} 项` : "";
    tip.hidden = isDesktop();
  }
}

/* ==========================================================================
   区间变更 → 全站同步
   ========================================================================== */
const commitRangeDebounced = debounce((from, to) => {
  setCustomRange(from, to, { silent: true });
  afterRangeChange("zoom");
}, 140);

function commitRange(from, to, source) {
  if (source === "zoom") {
    commitRangeDebounced(from, to);
    return;
  }
  setCustomRange(from, to, { silent: true });
  afterRangeChange(source);
}

function exitBrushMode() {
  const btn = document.getElementById("btnBrush");
  if (!btn || btn.getAttribute("aria-pressed") !== "true") return;
  btn.setAttribute("aria-pressed", "false");
  chart.setBrushMode(false);
  const hint = document.getElementById("brushHint");
  if (hint) hint.hidden = true;
  document.getElementById("mainWrap").dataset.mode = "pan";
}

function afterRangeChange(source) {
  if (source === "brush") exitBrushMode();
  syncRangeInfo();
  app.stats = computeStats(app.subs, state.rangeInfo);
  writeURL({ replace: true });
  renderRangeChip();
  views.renderRangeSegs();
  views.renderCatNav(app);
  renderView({ chart: source !== "theme" });
  // 图表：zoom 不需要重建数据，但需要更新端点标签/提示
  if (state.view === "cat") {
    const payload = getChart(state.cat);
    if (payload) {
      chart.renderMain(buildChartPayload(payload, state.cat));
      document.getElementById("chartNoteRange").textContent = `当前区间 ${rangeTextForChart()}`;
    }
  }
}

/* ==========================================================================
   导航
   ========================================================================== */
function navigate(view, opts = {}) {
  if (view === state.view && opts.cat && opts.cat === state.cat) {
    renderView();
    return;
  }
  state.view = view;
  if (opts.cat !== undefined) {
    if (state.cat !== opts.cat) state.focused = null;
    state.cat = opts.cat;
    if (state.sub && app.subs?.[state.sub]?.cat !== state.cat) {
      state.sub = null;
      state.overlay = [];
    }
  }
  if (view === "cat" && !state.cat && app.cats.length) state.cat = app.cats[0].key;
  if (view === "cat" && opts.cat && !hasChart(opts.cat)) {
    // 先切视图再拉数据，loading 覆盖层接管反馈
  }
  writeURL({ push: true });
  renderView();
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

/* ==========================================================================
   搜索 / 对比选择
   ========================================================================== */
/**
 * 拼音首字母打分：精确 > 前缀 > 包含 > 子序列 > 「字母全含」（容忍漏字/换序，如 bdxt → bdtxp）
 * 后端生成的拼音是每个字的完整首字母，用户常少打或换序，所以后两档很重要。
 */
function pinyinScore(q, py) {
  if (!py) return 0;
  if (py === q) return 100;
  if (py.startsWith(q)) return 92;
  if (py.includes(q)) return 82;
  let i = 0;
  for (const ch of py) if (i < q.length && ch === q[i]) i += 1;
  if (i === q.length) return 72;
  const set = new Set(py.split(""));
  if (q.length >= 2 && py.length <= q.length + 2 && Array.from(q).every((ch) => set.has(ch))) return 55;
  return 0;
}

function searchProvider(q, mode) {
  const query = q.trim().toLowerCase();
  const groups = [];
  const subs = app.index?.subs || Object.entries(app.subs || {}).map(([name, v]) => ({
    name,
    cat: v.cat,
    label: app.catMap.get(v.cat)?.label || v.cat,
    pinyin: app.pinyinOf(name),
  }));
  const etfs = app.index?.etfs || [];

  const catOf = (k) => app.catMap.get(k)?.label || k;

  if (!query) {
    // 空查询：给几个「最近看过的/热门的」入口
    const recent = state.watch.slice(0, 4).map((n) => {
      const s = app.subs?.[n];
      return { type: "sub", label: n, meta: catOf(s?.cat), color: s?.color, cat: s?.cat, name: n };
    });
    if (recent.length) groups.push({ label: "我的自选", items: recent });
    const top = (app.stats?.subs || [])
      .slice()
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5)
      .map((s) => ({ type: "sub", label: s.name, meta: `${catOf(s.cat)} · ${fmtPct(s.pct, 1)}`, color: s.color, cat: s.cat, name: s.name }));
    if (top.length) groups.push({ label: "区间变化最大", items: top });
    return { groups, hint: mode === "compare" ? "选择要对比的 2 个小类" : `共 ${subs.length} 个小类 / ${etfs.length} 只 ETF` };
  }

  const scoredSubs = [];
  for (const s of subs) {
    const name = s.name;
    const py = (s.pinyin || app.pinyinOf(name) || "").toLowerCase();
    let score = -1;
    if (name.toLowerCase() === query) score = 100;
    else if (name.toLowerCase().startsWith(query)) score = 90;
    else if (name.toLowerCase().includes(query)) score = 70;
    else score = pinyinScore(query, py) ? Math.max(40, pinyinScore(query, py) - 10) : -1;
    if (score > 0)
      scoredSubs.push({
        type: "sub",
        score,
        label: name,
        meta: `${catOf(s.cat)}${py ? " · " + py : ""}`,
        color: app.subs?.[name]?.color,
        cat: s.cat,
        name,
      });
  }
  scoredSubs.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, "zh-CN"));
  if (scoredSubs.length) groups.push({ label: "细分行业", items: scoredSubs.slice(0, 12) });

  if (mode !== "compare") {
    const scoredEtfs = [];
    for (const e of etfs) {
      const code = String(e.code || "");
      const nm = String(e.name || "");
      let score = -1;
      if (code === query) score = 100;
      else if (code.startsWith(query)) score = 85;
      else if (nm.includes(q.trim())) score = 60;
      if (score > 0)
        scoredEtfs.push({
          type: "etf",
          score,
          label: nm.length > 18 ? nm.slice(0, 18) + "…" : nm,
          code,
          meta: (e.subs || []).slice(0, 1).join("") + (e.market ? ` · ${e.market}` : ""),
          name: (e.subs || [])[0],
          cat: app.subs?.[(e.subs || [])[0]]?.cat,
        });
    }
    scoredEtfs.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
    if (scoredEtfs.length) groups.push({ label: "ETF", items: scoredEtfs.slice(0, 8) });
  }

  return {
    groups,
    hint: mode === "compare" ? `已选 ${state.compare.length}/2 · 选择要对比的小类` : `${scoredSubs.length} 个小类 · ${groups[1]?.items.length || 0} 只 ETF`,
  };
}

function openSearch(mode = "search") {
  if (!app.indexReady) {
    toast("正在加载搜索索引…", "info", 1200);
    ensureIndex()
      .then(() => openSearch(mode))
      .catch(() => toast("搜索索引加载失败，请检查 data/index.json", "error", 3200));
    return;
  }
  if (!palette) {
    palette = ui.createPalette({});
  }
  palette.open({
    mode,
    provider: searchProvider,
    placeholder: mode === "compare" ? "搜索要对比的小类（可输入拼音首字母）…" : "搜索小类 / 拼音首字母 / ETF 代码或名称…",
    onPick: (item) => {
      if (mode === "compare") {
        if (item.type !== "sub") return true;
        const res = toggleCompare(item.name);
        if (res.ok) {
          if (state.compare.length >= 2) {
            writeCompareUrl();
            if (state.view !== "cat") navigate("cat", { cat: app.subs?.[state.compare[0]]?.cat });
            else renderView();
            toast(`对比：${state.compare.join(" vs ")}`, "info", 2000);
            return false;
          }
          toast(`已选择 ${item.name}，再选一个`, "info", 1800);
          return true;
        }
        return true;
      }
      if (item.type === "etf") {
        if (item.name) {
          const cat = app.subs?.[item.name]?.cat;
          if (state.view !== "cat" || state.cat !== cat) navigate("cat", { cat });
          setTimeout(() => openDetail(item.name), 60);
        }
        return false;
      }
      if (item.type === "sub") {
        const cat = app.subs?.[item.name]?.cat;
        if (state.view !== "cat" || state.cat !== cat) navigate("cat", { cat });
        setTimeout(() => openDetail(item.name), 80);
      }
      return false;
    },
  });
}

function syncLogUI() {
  const btn = document.getElementById("btnLog");
  if (!btn) return;
  const usable = state.metric === "shares" || state.metric === "scale";
  btn.hidden = !usable || state.compare.length > 0 || isFocusMode();
  btn.setAttribute("aria-pressed", String(!!state.log && usable));
}

function syncCompareUI() {
  const btn = document.getElementById("btnCatCompare");
  if (!btn) return;
  const on = state.compare.length > 0;
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? `对比中：${state.compare.join(" vs ")}（点击退出）` : "选择 2 个小类做归一化对比";
}

function writeCompareUrl() {
  writeURL({ replace: true });
  syncCompareUI();
}

function openComparePicker() {
  if (!state.cat) return;
  // 默认把当前大类的头两个小类放进去，降低操作成本
  const names = app.subsByCat.get(state.cat) || [];
  if (state.compare.length === 0 && names.length >= 2) {
    state.compare = names.slice(0, 2);
    writeCompareUrl();
    renderView();
    toast(`已对比 ${state.compare.join(" vs ")}，点「对比」可重新选择`, "info", 2600);
    return;
  }
  openSearch("compare");
}

/* ==========================================================================
   CSV 导出 / 复制
   ========================================================================== */
function exportCatCsv() {
  const payload = getChart(state.cat);
  if (!payload) {
    toast("图表数据还没加载好", "error");
    return;
  }
  const p = buildChartPayload(payload, state.cat);
  const dates = p.dates.slice(state.rangeInfo.fromIdx, state.rangeInfo.toIdx + 1);
  const names = p.series.map((s) => s.name);
  const header = ["日期", ...names];
  const rows = dates.map((d, i) => {
    const gi = state.rangeInfo.fromIdx + i;
    return [d, ...p.series.map((s) => (s.values[gi] == null ? "" : +s.values[gi].toFixed(2)))];
  });
  download(`${app.catMap.get(state.cat)?.label || state.cat}-${p.metric}-${state.rangeInfo.from}-${state.rangeInfo.to}.csv`, toCSV([header, ...rows]));
  toast("已导出图表 CSV", "ok");
}

function exportWatchCsv() {
  const rows = state.watch.map((n) => {
    const s = app.stats?.byName?.get(n);
    return [n, app.catMap.get(s?.cat)?.label || s?.cat || "", s?.last ?? "", s?.delta ?? "", s?.pct != null ? s.pct.toFixed(2) : "", s?.scale ?? ""];
  });
  download(`自选-${state.rangeInfo.from}-${state.rangeInfo.to}.csv`, toCSV([["细分行业", "大类", "最新份额(亿份)", "区间变化(亿份)", "变化率(%)", "规模(亿元)"], ...rows]));
  toast("已导出自选 CSV", "ok");
}

/** 把页面里已经渲染好的表格导出为 CSV（与用户看到的排序一致） */
function exportTableCsv(kind) {
  const map = { topin: ["tblTopIn", "份额增加TOP"], topout: ["tblTopOut", "份额减少TOP"], cattable: ["tblCat", "本类明细"] };
  const [id, name] = map[kind] || [];
  const tbl = id && document.getElementById(id);
  if (!tbl) return;
  const rows = [];
  tbl.querySelectorAll("tr").forEach((tr) => {
    const cells = [];
    tr.querySelectorAll("th,td").forEach((td) => {
      if (td.querySelector("svg")) return;
      const txt = td.innerText.trim().replace(/\s+/g, " ");
      if (txt) cells.push(txt);
    });
    if (cells.length) rows.push(cells);
  });
  const label = kind === "cattable" ? app.catMap.get(state.cat)?.label || "大类" : "全市场";
  download(`${name}-${label}-${state.rangeInfo.from}-${state.rangeInfo.to}.csv`, toCSV(rows));
  toast("已导出表格 CSV", "ok");
}

async function copyTable(kind) {
  const map = { topin: "tblTopIn", topout: "tblTopOut", cattable: "tblCat" };
  const tbl = document.getElementById(map[kind]);
  if (!tbl) return;
  const rows = [];
  tbl.querySelectorAll("tr").forEach((tr) => {
    const cells = [];
    tr.querySelectorAll("th,td").forEach((td) => {
      if (td.querySelector("svg")) return;
      cells.push(td.innerText.trim().replace(/\s+/g, " "));
    });
    if (cells.length) rows.push(cells);
  });
  const text = toTSV(rows);
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else throw new Error("no clipboard");
    toast("已复制表格（可粘贴到 Excel）", "ok");
  } catch (e) {
    // 兜底
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-1000px";
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast("已复制表格", "ok");
    } catch (err) {
      toast("复制失败，请手动选择表格", "error");
    }
    ta.remove();
  }
}

/* ==========================================================================
   移动端大类抽屉
   ========================================================================== */
function buildSheet() {
  const body = document.getElementById("sheetBody");
  if (!body) return;
  body.innerHTML = (app.cats || [])
    .map((c) => {
      const subs = app.subsByCat.get(c.key) || [];
      const s = app.stats?.byCat?.get(c.key);
      return `<div class="drawer-sec" style="margin-bottom:var(--sp-3)">
        <div class="drawer-sec-head">
          <h3 style="text-transform:none;letter-spacing:0;font-size:var(--fs-xs);color:var(--ink)">
            <span class="cat-dot" style="background:${esc(c.color)}"></span> ${esc(c.label)}
          </h3>
          <span class="chip ${s?.pct > 0 ? "chip--up" : s?.pct < 0 ? "chip--down" : "chip--flat"}">${fmtPct(s?.pct, 2)}</span>
        </div>
        <div class="rail-group">
          ${subs
            .map(
              (n) => `<button class="nav-item" type="button" data-navsub="${esc(n)}" data-cat="${esc(c.key)}">
                <span class="nav-label">${esc(n)}</span>
                <span class="cat-pct ${(app.stats?.byName?.get(n)?.pct || 0) > 0 ? "up" : "down"}">${fmtPct(app.stats?.byName?.get(n)?.pct, 1)}</span>
              </button>`
            )
            .join("")}
        </div>
      </div>`;
    })
    .join("");
}

function openSheet() {
  const mask = document.getElementById("sheetMask");
  const sheet = document.getElementById("catSheet");
  if (!mask || !sheet) return;
  buildSheet();
  mask.hidden = false;
  sheet.hidden = false;
  void mask.offsetWidth;
  mask.dataset.open = "1";
  sheet.dataset.open = "1";
  document.body.style.overflow = "hidden";
}

function closeSheet() {
  const mask = document.getElementById("sheetMask");
  const sheet = document.getElementById("catSheet");
  if (!sheet) return;
  mask.dataset.open = "0";
  sheet.dataset.open = "0";
  document.body.style.overflow = "";
  setTimeout(() => {
    mask.hidden = true;
    sheet.hidden = true;
  }, 240);
}

/* ==========================================================================
   后台预取：首屏之后逐个拉取其余大类图表
   · 目的：① 区间净流入从「估算」升级为「每日求和」的精确值；
            ② 大类切换即时（命中缓存），不阻塞首屏
   · 尊重 saveData / 2G 网络，串行加载避免抢带宽
   ========================================================================== */
let prefetchStarted = false;
function chartsAllLoaded() {
  const keys = api.catKeys();
  return keys.length > 0 && keys.every((k) => hasChart(k));
}

function scheduleChartPrefetch() {
  if (prefetchStarted || !app.subsReady) return;
  prefetchStarted = true;
  const conn = navigator.connection;
  if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType || "")) return;
  const run = async () => {
    const queue = api.catKeys().filter((k) => !hasChart(k));
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const k = queue.shift();
        try {
          setChart(k, await api.load(`charts:${k}`));
        } catch (e) {
          /* 单个失败不影响其它 */
        }
        done += 1;
        if (done % 2 === 0 && state.view === "overview") views.renderOverviewWatch(app);
      }
    };
    // 限并发 2：不抢首屏与交互的带宽
    await Promise.all([worker(), worker()]);
    if (chartsAllLoaded()) {
      app.flowComplete = true;
      if (state.view === "overview") views.renderOverview(app);
      else if (state.view === "cat") views.renderCategory(app, { chart: true });
    }
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

/** 首屏图表画完之后，再补 subs/index（不占首屏带宽） */
function scheduleDeferredData() {
  const run = async () => {
    performance.mark("ebbflow:deferred-start");
    try {
      await ensureIndex();
    } catch (e) {}
    try {
      await ensureSubs();
    } catch (e) {}
  };
  const idle = () => ("requestIdleCallback" in window ? window.requestIdleCallback(run, { timeout: 2500 }) : setTimeout(run, 800));
  idle();
}

/* ==========================================================================
   事件绑定
   ========================================================================== */
function wireEvents() {
  // 全局点击委托
  document.addEventListener("click", (e) => {
    const t = e.target;
    const closest = (sel) => t.closest?.(sel);

    if (closest("[data-retry-chart]")) {
      renderCatChart(state.cat);
      return;
    }
    const unwatch = closest("[data-unwatch]");
    if (unwatch) {
      e.stopPropagation();
      const name = unwatch.dataset.unwatch;
      toggleWatch(name);
      toast(`已取消自选：${name}`, "info", 1600);
      views.renderView?.(app);
      if (state.view === "watch") views.renderWatch(app);
      if (state.view === "overview") views.renderOverviewWatch(app);
      views.syncNavActive(app);
      return;
    }
    const catToggle = closest("[data-cat-toggle]");
    if (catToggle) {
      const group = catToggle.closest(".cat-nav");
      const open = group.dataset.open === "1";
      group.dataset.open = open ? "0" : "1";
      catToggle.setAttribute("aria-expanded", String(!open));
      return;
    }
    const nav = closest("[data-nav]");
    if (nav) {
      closeSheet();
      navigate(nav.dataset.nav);
      return;
    }
    const preset = closest("[data-preset]");
    if (preset) {
      state.focused = null;
      setPreset(preset.dataset.preset, { silent: true });
      afterRangeChange("preset");
      return;
    }
    const metric = closest("[data-metric]");
    if (metric) {
      if (state.metric === metric.dataset.metric) return;
      state.metric = metric.dataset.metric;
      state.focused = null;
      // 主指标不能同时出现在叠加里
      if (state.overlay.includes(state.metric)) state.overlay = state.overlay.filter((m) => m !== state.metric);
      views.renderMetricSegs();
      writeURL({ replace: true });
      syncLogUI();
      if (state.view === "cat") renderCatChart(state.cat, { silent: true });
      return;
    }
    const norm = closest("[data-norm]");
    if (norm) {
      state.norm = norm.dataset.norm;
      views.renderMetricSegs();
      writeURL({ replace: true });
      if (state.view === "cat") renderCatChart(state.cat, { silent: true });
      return;
    }
    if (closest("[data-clear-compare]")) {
      state.compare = [];
      state.focused = null;
      clearCompare();
      writeCompareUrl();
      if (state.view === "cat") renderCatChart(state.cat, { silent: true });
      return;
    }
    const taxBtn = closest("[data-tax]");
    if (taxBtn) {
      const next = taxBtn.dataset.tax;
      ui.closePopover();
      switchTaxonomy(next);
      return;
    }
    if (closest("[data-open-quality]")) {
      ui.closePopover();
      initQuality(app);
      document.getElementById("btnQuality")?.click();
      return;
    }
    if (closest("[data-set-theme]")) {
      applyTheme(closest("[data-set-theme]").dataset.setTheme);
      ui.closePopover();
      return;
    }
    if (closest("[data-set-cvd]")) {
      applyCvd(closest("[data-set-cvd]").dataset.setCvd === "1");
      ui.closePopover();
      return;
    }
    if (closest("[data-set-motion]")) {
      const cur = document.documentElement.getAttribute("data-motion") === "off";
      applyMotion(cur);
      ui.closePopover();
      return;
    }
    if (closest("[data-set-rail]")) {
      toggleRail();
      ui.closePopover();
      return;
    }
    const ovPill = closest("[data-overlay]");
    if (ovPill && ovPill.closest("#focusBar")) {
      toggleOverlayFromUI(ovPill.dataset.overlay);
      return;
    }
    if (closest("#focusClear")) {
      clearFocus();
      writeURL({ replace: true });
      syncFocusUI();
      if (state.view === "cat") renderCatChart(state.cat, { silent: true });
      return;
    }
    const focusChip = closest("[data-focus]");
    if (focusChip && focusChip.classList.contains("legend-chip")) {
      onFocusSeries(focusChip.dataset.focus || null);
      return;
    }
    const sortTh = closest("th[data-sort-key]");
    if (sortTh) {
      const table = sortTh.closest("table");
      const key = sortTh.dataset.sortKey;
      const numeric = sortTh.dataset.type !== "text";
      if (table?.id === "tblCat") {
        state.catSort = { key, dir: state.catSort.key === key ? -state.catSort.dir : numeric ? -1 : 1 };
        views.renderCategory(app, { chart: false });
      } else if (table?.id === "tblTopIn" || table?.id === "tblTopOut") {
        const side = table.id === "tblTopIn" ? "in" : "out";
        const cur = state.topSort[side];
        state.topSort[side] = { key, dir: cur.key === key ? -cur.dir : numeric ? -1 : 1 };
        views.renderTopTables(app);
      } else if (table?.id === "tblAll") {
        state.allSort = { key, dir: state.allSort.key === key ? -state.allSort.dir : numeric ? -1 : 1 };
      }
      return;
    }
    const tableCsv = closest("[data-table-csv]");
    if (tableCsv) {
      exportTableCsv(tableCsv.dataset.tableCsv);
      return;
    }
    const copyBtn = closest("[data-copy]");
    if (copyBtn) {
      copyTable(copyBtn.dataset.copy);
      return;
    }
    const mktBtn = closest("#mktMetric [data-m]");
    if (mktBtn) {
      state.marketMetric = mktBtn.dataset.m;
      views.renderOverview(app);
      return;
    }
    const navSub = closest("[data-navsub]");
    if (navSub) {
      closeSheet();
      const name = navSub.dataset.navsub;
      const cat = app.subs?.[name]?.cat || navSub.dataset.cat;
      if (state.view !== "cat") navigate("cat", { cat });
      else if (cat && state.cat !== cat) navigate("cat", { cat });
      // 侧栏/移动端抽屉里的「小类」= 单系列聚焦（不弹明细抽屉，避免挡住图表）
      setFocus(name);
      writeURL({ replace: true });
      syncFocusUI();
      renderCatChart(state.cat, { silent: true });
      return;
    }
    const subEl = closest("[data-sub]");
    if (subEl) {
      closeSheet();
      openDetail(subEl.dataset.sub);
      return;
    }
    const catEl = closest("[data-cat]");
    if (catEl) {
      closeSheet();
      navigate("cat", { cat: catEl.dataset.cat });
      return;
    }
    const jump = closest("[data-open-all]");
    if (jump) {
      openAllSubs({ sign: jump.dataset.openAll });
      return;
    }
    if (closest("[data-open-shortcuts]")) {
      ui.closePopover();
      ui.toast("快捷键：⌘K / Ctrl+K 搜索 · / 搜索 · Esc 关闭 · Ctrl+B 收起导航 · 图表上双击复位", "info", 5000);
      return;
    }
    if (closest("#watchEmptySearch")) {
      openSearch();
      return;
    }
  });

  document.getElementById("brandLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    navigate("overview");
  });
  document.getElementById("railToggle")?.addEventListener("click", () => {
    if (isDesktop()) toggleRail();
    else openSheet();
  });
  document.getElementById("btnTheme")?.addEventListener("click", cycleTheme);
  document.getElementById("btnSettings")?.addEventListener("click", openSettings);
  document.getElementById("searchOpen")?.addEventListener("click", () => openSearch());
  document.getElementById("tabSearch")?.addEventListener("click", () => openSearch());
  document.getElementById("tabCats")?.addEventListener("click", openSheet);
  document.getElementById("sheetClose")?.addEventListener("click", closeSheet);
  document.getElementById("sheetMask")?.addEventListener("click", closeSheet);
  document.getElementById("rangeChipReset")?.addEventListener("click", () => {
    state.focused = null;
    resetRange();
    afterRangeChange("reset");
  });
  document.getElementById("btnTop")?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  document.getElementById("btnRefresh")?.addEventListener("click", doRefresh);
  document.getElementById("btnCatBack")?.addEventListener("click", () => navigate("overview"));
  document.getElementById("btnCatExport")?.addEventListener("click", exportCatCsv);
  document.getElementById("btnChartCsv")?.addEventListener("click", exportCatCsv);
  document.getElementById("btnWatchCsv")?.addEventListener("click", exportWatchCsv);
  document.getElementById("btnLog")?.addEventListener("click", () => {
    state.log = !state.log;
    syncLogUI();
    writeURL({ replace: true });
    if (state.view === "cat") renderCatChart(state.cat, { silent: true });
  });
  document.getElementById("btnResetZoom")?.addEventListener("click", () => {
    state.focused = null;
    resetRange();
    afterRangeChange("reset");
  });
  document.getElementById("btnBrush")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const on = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(on));
    chart.setBrushMode(on);
    const hint = document.getElementById("brushHint");
    if (hint) hint.hidden = !on;
    document.getElementById("mainWrap").dataset.mode = on ? "brush" : "pan";
  });
  document.getElementById("btnCatCompare")?.addEventListener("click", () => {
    if (state.compare.length) {
      state.compare = [];
      state.focused = null;
      clearCompare();
      writeCompareUrl();
      if (state.view === "cat") renderCatChart(state.cat, { silent: true });
      toast("已退出对比模式", "info", 1600);
    } else {
      openComparePicker();
    }
  });

  // 端点标签「查看全部」→ 打开该小类明细抽屉
  document.addEventListener("etf:pick-series", (e) => {
    const name = e.detail?.name;
    if (name) openDetail(name);
  });

  // 键盘
  document.addEventListener("keydown", (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openSearch();
      return;
    }
    if (meta && e.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleRail();
      return;
    }
    if (e.key === "/" && !inField && !ui.hasOverlay()) {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.key === "Escape") {
      const hint = document.getElementById("brushHint");
      if (hint && !hint.hidden) {
        hint.hidden = true;
        chart.setBrushMode(false);
        document.getElementById("btnBrush")?.setAttribute("aria-pressed", "false");
        document.getElementById("mainWrap").dataset.mode = "pan";
      }
      if (document.getElementById("catSheet")?.dataset.open === "1") closeSheet();
    }
  });

  // 浏览器前进/后退
  window.addEventListener("popstate", () => {
    readURL();
    if (state.view === "cat" && !state.cat && app.cats.length) state.cat = app.cats[0].key;
    syncRangeInfo();
    app.stats = computeStats(app.subs, state.rangeInfo);
    renderView();
  });

  // 系统主题变化
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentTheme() === "auto") {
      chart.repaintAll();
      renderView({ chart: false });
    }
  });

  // 跟随窗口尺寸：移动端隐藏滑块由 chart 内部判断，这里只做 resize
  window.addEventListener("resize", debounce(() => {
    chart.resizeMain();
    chart.resizeMarket();
  }, 150));

  // 表格行键盘可达
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest?.("tr[data-sub]");
    if (!tr) return;
    e.preventDefault();
    openDetail(tr.dataset.sub);
  });
}

async function doRefresh() {
  if (!api.net.hasService) {
    toast("静态托管模式下无法刷新，请使用本地服务", "error", 3200);
    return;
  }
  const btn = document.getElementById("btnRefresh");
  btn?.classList.add("busy");
  try {
    await api.refresh();
    toast("已触发更新，正在重新加载数据…", "ok");
    api.clearCache();
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    toast(`刷新失败：${e.message}`, "error", 3600);
  } finally {
    btn?.classList.remove("busy");
  }
}

/* ==========================================================================
   启动
   ========================================================================== */
/** 页脚占位符兜底：构建时被 lib/signature.mjs 替换；直接访问 web/ 时用运行时数据填上 */
async function fillPlaceholders() {
  const foot = document.getElementById("foot");
  if (!foot || !foot.innerHTML.includes("__")) return;
  try {
    const sig = await api.load("signature");
    app.version = sig?.version || "";
  } catch (e) {
    /* signature.json 不是必须的 */
  }
  const map = {
    __REPO__: app.meta?.repo || "",
    __AUTHOR_URL__: app.meta?.authorUrl || app.meta?.repo || "",
    __AUTHOR__: app.meta?.author || "",
    __LICENSE__: app.meta?.license || "MIT",
    __VERSION__: app.version || "",
    __YEAR__: String(new Date().getFullYear()),
  };
  const tw = document.createTreeWalker(foot, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (tw.nextNode()) nodes.push(tw.currentNode);
  for (const n of nodes) {
    let v = n.nodeValue;
    if (!/__[A-Z_]+__/.test(v)) continue;
    for (const [k, rep] of Object.entries(map)) if (v.includes(k)) v = v.split(k).join(rep);
    n.nodeValue = v;
  }
  foot.querySelectorAll("[href],[title]").forEach((a) => {
    for (const attr of ["href", "title"]) {
      const val = a.getAttribute(attr);
      if (!val || !/__[A-Z_]+__/.test(val)) continue;
      let v = val;
      for (const [k, rep] of Object.entries(map)) if (v.includes(k)) v = v.split(k).join(rep);
      a.setAttribute(attr, v);
    }
  });
}

/** 加载当前 taxonomy 的数据并渲染（首屏与切换共用） */
async function loadTaxonomyData() {
  try {
    app.meta = await api.load("meta");
  } catch (e) {
    fatal(e);
    throw e;
  }

  // 大类清单只依赖 meta.categories（与 charts 文件名一一对应）
  const metaCats = Array.isArray(app.meta.categories) ? app.meta.categories : [];
  if (metaCats.length) {
    app.cats = metaCats.map((c) => ({ key: c.key, label: c.label || c.key, color: c.color || null, subs: c.subs }));
    app.catMap = new Map(app.cats.map((c) => [c.key, c]));
  }
  api.rememberCatKeys(metaCats.map((c) => c.key));
  applyMeta();
  syncTaxonomyUI();

  // 当前大类若不在新口径里，重置到第一项
  if (state.view === "cat" || state.cat) {
    if (!state.cat || !app.catMap.has(state.cat)) state.cat = app.cats[0]?.key ?? null;
  }

  // 首屏关键路径：market（KPI + 走势 + 交易日轴）＋ 当前大类的 charts
  const wantCat = state.view === "cat" && state.cat;
  const [market, firstChart] = await Promise.all([
    api.load("market").catch(() => null),
    wantCat ? api.load(`charts:${state.cat}`).catch(() => null) : Promise.resolve(null),
  ]);
  app.market = market;
  if (firstChart && state.cat) setChart(state.cat, firstChart);
  if (!app.cats.length) await ensureIndex().catch(() => null);
  const cal = market?.dates || firstChart?.dates || [];
  if (cal.length > 2) setCalendar(cal);
  if (!state.calendar.length) {
    fatal(new Error("无法确定交易日轴（缺少 market.json / charts）"));
    throw new Error("日历缺失");
  }

  recomputeStats();
  // 口径切换后 cat 可能被重置，这里把 URL 对齐一次，保证刷新可还原
  writeURL({ replace: true });
  setDataBadge(api.net.mode === "live" ? "live" : "static", api.net.mode === "live" ? "本地服务" : "静态数据");
  renderView();
  views.syncNavActive(app);
  fillPlaceholders();
  syncCompareUI();
  syncLogUI();
  syncFocusUI();
}

async function boot() {
  stampIdentity();
  updateThemeBtn();
  readURL();
  loadWatch();
  api.setTaxonomy(state.taxonomy);
  views.renderRangeSegs();
  wireEvents();

  initDetail(app, {
    ensureSubs,
    onOpen: (name) => {
      const cat = app.subs?.[name]?.cat;
      if (state.view === "cat" && cat && cat === state.cat && state.sub !== name) {
        setFocus(name);
        writeURL({ replace: true });
        renderCatChart(state.cat, { silent: true });
      }
      syncFocusUI();
    },
    onToggleWatch: (name) => {
      toggleWatch(name);
      views.renderCatNav(app);
      views.syncNavActive(app);
      if (state.view === "overview") views.renderOverviewWatch(app);
      if (state.view === "watch") views.renderWatch(app);
    },
    onCompare: (name) => {
      const res = toggleCompare(name);
      if (res.ok) {
        toast(res.added ? `已加入对比：${name}` : `已移出对比：${name}`, "info", 1800);
        if (state.view !== "cat") navigate("cat", { cat: app.subs?.[name]?.cat });
        else renderCatChart(state.cat);
      }
    },
  });
  initAllSubs(app, { ensureSubs });
  initQuality(app);

  try {
    await loadTaxonomyData();

    api.probeService().then((has) => {
      const btn = document.getElementById("btnRefresh");
      if (!btn) return;
      btn.hidden = false;
      btn.setAttribute("aria-disabled", String(!has));
      btn.classList.toggle("is-disabled", !has);
      btn.title = has
        ? "重新抓取最新数据（本地服务）"
        : "静态托管模式无法刷新：需要本地服务 127.0.0.1:5188（npm run dev）；数据文件由构建产出";
    });

    // sub= 在「大类视图」里表示聚焦（图表单系列 + 叠加），不自动弹抽屉
    if (state.sub && state.view !== "cat") setTimeout(() => openDetail(state.sub), 200);

    document.documentElement.setAttribute("data-ready", "1");
    document.body.classList.remove("is-loading");

    ensureMarketChart()
      .then(() => chart.repaintAll())
      .catch(() => {})
      .finally(() => scheduleDeferredData());
  } catch (e) {
    /* fatal 已在 loadTaxonomyData 里处理 */
  }
}

/* ==========================================================================
   分类口径切换（v2 ↔ 原看板）
   ========================================================================== */
const TAX_LABEL = { v2: "新版分类", legacy: "原看板口径" };

function setGlobalLoading(on, text = "") {
  const bar = document.getElementById("globalBar");
  const txt = document.getElementById("globalBarText");
  if (!bar) return;
  bar.hidden = !on;
  if (txt) txt.textContent = text;
  document.body.classList.toggle("is-switching", !!on);
  document.getElementById("main")?.setAttribute("aria-busy", on ? "true" : "false");
}

/** 清空与当前口径绑定的内存数据（含 charts 缓存键） */
function resetTaxonomyState() {
  app.meta = null;
  app.subs = null;
  app.index = null;
  app.market = null;
  app.tables = null;
  app.quality = null;
  app.cats = [];
  app.catMap = new Map();
  app.subsByCat = new Map();
  app.pinyin = new Map();
  app.stats = null;
  app.subsReady = false;
  app.indexReady = false;
  app.flowComplete = false;
  app.chartData.clear();
  subsPromise = null;
  indexPromise = null;
  prefetchStarted = false;
  state.calendar = [];
  state.rangeInfo = { from: "—", to: "—", days: 0, fromIdx: -1, toIdx: -1, preset: state.preset, isCustom: false };
  state.cat = null;
  state.sub = null;
  state.overlay = [];
  state.compare = [];
  state.focused = null;
  // 不销毁 ECharts 实例：切换期间旧图保持可见（只做变暗），新数据到齐后 setOption 覆盖，
  // 避免出现「切换瞬间空白」和重复初始化。
  chart.market.lastPayload = null;
  chart.main.lastPayload = null;
  const legend = document.getElementById("chartLegend");
  if (legend) legend.innerHTML = "";
}

async function switchTaxonomy(next, { silent = false } = {}) {
  if (next === state.taxonomy) return;
  const from = state.taxonomy;
  state.taxonomy = next;
  try {
    localStorage.setItem("ebbflow-taxonomy", next);
  } catch (e) {}
  api.setTaxonomy(next);
  api.clearCache();
  resetTaxonomyState();
  writeURL({ replace: true });
  syncTaxonomyUI();
  if (!silent) setGlobalLoading(true, `正在切换到${TAX_LABEL[next]}…`);
  try {
    await loadTaxonomyData();
    if (!silent) toast(`已切换到${TAX_LABEL[next]}`, "ok", 1800);
    ensureMarketChart()
      .then(() => chart.repaintAll())
      .catch(() => {})
      .finally(() => scheduleDeferredData());
  } catch (e) {
    console.error("[taxonomy]", e);
    toast(`${TAX_LABEL[next]}数据加载失败，已切回${TAX_LABEL[from]}`, "error", 4200);
    state.taxonomy = from;
    try {
      localStorage.setItem("ebbflow-taxonomy", from);
    } catch (err) {}
    api.setTaxonomy(from);
    api.clearCache();
    resetTaxonomyState();
    writeURL({ replace: true });
    syncTaxonomyUI();
    try {
      await loadTaxonomyData();
    } catch (err) {}
  } finally {
    setGlobalLoading(false);
  }
}

/** 口径切换控件的选中态 + <html data-taxonomy> */
function syncTaxonomyUI() {
  document.documentElement.setAttribute("data-taxonomy", state.taxonomy);
  document.querySelectorAll("[data-tax]").forEach((btn) => {
    const on = btn.dataset.tax === state.taxonomy;
    btn.setAttribute("aria-pressed", String(on));
    if (btn.classList.contains("popover-item")) btn.setAttribute("aria-checked", String(on));
  });
}

function fatal(err) {
  console.error("[ebbflow]", err);
  setDataBadge("error", "加载失败");
  const main = document.getElementById("main");
  if (!main) return;
  main.innerHTML = `<section class="card" style="margin-top:var(--sp-6)">
    <div class="card-body">
      <div class="state state--danger" style="padding:var(--sp-9) var(--sp-5)">
        <div class="state-ico" aria-hidden="true"><svg width="20" height="20"><use href="#i-alert"/></svg></div>
        <p class="state-title">数据加载失败</p>
        <p class="state-desc">${esc(err?.message || "未知错误")}<br>请确认 <code>data/</code> 目录存在（静态托管），或本地服务（127.0.0.1:5188）已启动；然后重试。</p>
        <button class="btn btn--primary btn--sm" type="button" id="fatalRetry">重新加载</button>
      </div>
    </div>
  </section>`;
  document.getElementById("fatalRetry")?.addEventListener("click", () => location.reload());
}

boot();
