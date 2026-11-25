/* ==========================================================================
   detail：小类明细抽屉 / 全部小类表 / 数据质量弹层
   ========================================================================== */

import { cnum, download, esc, fmtPct, fmtSigned, skeletonRows, toCSV, toneColor, isDark, emptyState } from "./util.js";
import { flowEstimate, catLabelOf } from "./views.js";
import { attachQuotes, quoteEnabled } from "./quote.js";
import { rangeContext, decorateRows, endpointNote, APPROX_TIP } from "./etf-range.js";
import { rankOf, state } from "./state.js";
import { closeOverlay, openOverlay, toast } from "./ui.js";
import { createMiniChart } from "./chart.js";
import { load, loadAllCharts, catKeys } from "./api.js";

/* ==========================================================================
   小类明细
   ========================================================================== */

/** 标签前缀 → 中文维度简称（优先用 meta.tagDims，去掉「一级/类别/细分」后缀） */
const TAG_FALLBACK = { index: "指数", sw: "申万", csi: "中证", theme: "主题", region: "地区", factor: "因子", bond: "债券", commodity: "商品" };
function tagDim(prefix, dims) {
  const full = dims?.[prefix];
  if (full) return full.replace(/(一级|二级|类别|细分)$/, "");
  return TAG_FALLBACK[prefix] || prefix;
}

/** 把 ["sw:电子","csi:信息技术"] 渲染成 chip（最多 4 个，其余收进 +N） */
function renderTags(tags, dims, max = 4) {
  const list = (tags || []).filter(Boolean);
  if (!list.length) return "";
  const chips = list.slice(0, max).map((t) => {
    const i = String(t).indexOf(":");
    const prefix = i >= 0 ? t.slice(0, i) : "";
    const value = i >= 0 ? t.slice(i + 1) : t;
    const dim = prefix ? tagDim(prefix, dims) : "";
    return `<span class="tagchip" title="${esc(dim ? dim + "：" + value : value)}">${
      dim ? `<i>${esc(dim)}</i>` : ""
    }${esc(value)}</span>`;
  });
  const rest = list.slice(max);
  if (rest.length) {
    const all = rest
      .map((t) => {
        const i = String(t).indexOf(":");
        const prefix = i >= 0 ? t.slice(0, i) : "";
        const value = i >= 0 ? t.slice(i + 1) : t;
        return (prefix ? tagDim(prefix, dims) + "：" : "") + value;
      })
      .join("；");
    chips.push(`<span class="tagchip tagchip--more" title="${esc(all)}">+${rest.length}</span>`);
  }
  return `<span class="tagrow">${chips.join("")}</span>`;
}
let mini = null;
let current = null;
let etfSort = { key: "flowRange", dir: -1 };
let drawerRows = [];
let drawerTotalScale = 0;
let drawerSorted = [];
let drawerHooks = {};

/* ------------------------- 聚焦态内嵌成分表（复用抽屉表） ------------------------- */
const inlineTableState = new Map(); // subName → { key, dir, page }
const inlineRenderToken = new Map(); // subName → number（防止快速切换区间的异步竞态）
const SORT_LABEL = {
  code: "代码",
  name: "名称",
  price: "最新价",
  pctRange: "区间规模变化",
  flowRange: "区间净申购",
  scaleEnd: "期末规模",
  premiumEnd: "折溢价",
  weightPct: "占本类",
};

export function renderInlineEtfTable(app, subName, host) {
  if (!host) return Promise.resolve();
  const entry = app.subs?.[subName];
  if (!entry) {
    host.innerHTML = `<div class="state state--sm" style="padding:var(--sp-6) 0">
      <p class="state-title">成分 ETF 明细暂未收录</p>
      <p class="state-desc">当前数据包还没有这个小类的成分明细，补齐后会出现在这里。</p></div>`;
    return Promise.resolve();
  }
  const rows = entry.etfs || [];
  if (!rows.length) {
    host.innerHTML = `<div class="state state--sm" style="padding:var(--sp-6) 0"><p class="state-desc">该小类暂无成分 ETF</p></div>`;
    return Promise.resolve();
  }
  const st = inlineTableState.get(subName) || { key: "flowRange", dir: -1, page: 0 };
  // 旧版本默认按规模排序：迁移到新的「区间净申购」
  if (st.key === "scale" || st.key === "delta" || st.key === "shares") st.key = "flowRange";
  inlineTableState.set(subName, st);

  const token = (inlineRenderToken.get(subName) || 0) + 1;
  inlineRenderToken.set(subName, token);
  return (async () => {
    const ctx = await rangeContext(app, subName, rows);
    if (inlineRenderToken.get(subName) !== token) return; // 已有更新的渲染
    const decorated = decorateRows(rows, ctx);
    const sorted = sortEtfRows(decorated, st);
    const paged = sorted.length > 120;
    const pages = paged ? Math.ceil(sorted.length / 50) : 1;
    st.page = Math.min(st.page, pages - 1);
    const view = paged ? sorted.slice(st.page * 50, st.page * 50 + 50) : sorted;
    const approx = ctx?.mode !== "exact";
    const sortHead = (key, label, extra = "", numeric = true, note = "") =>
      `<th scope="col" data-isort="${key}" class="${extra}" aria-sort="${
        st.key === key ? (st.dir > 0 ? "ascending" : "descending") : "none"
      }" data-type="${numeric ? "num" : "text"}"><button type="button"><span class="th-label">${label}</span><span class="sort-ico"></span></button>${
        note
          ? `<span class="th-approx" tabindex="0" role="note" title="${esc(APPROX_TIP)}">${note}</span>`
          : ""
      }</th>`;
    const sortLabel = SORT_LABEL[st.key] || "所选列";

    host.innerHTML = `
    <div class="etf-inline">
      <div class="etf-inline-head">
        <span class="dim t-2xs">${rows.length} 只 · 按${sortLabel}${st.dir > 0 ? "升序" : "降序"}${
          paged ? ` · 第 ${st.page + 1}/${pages} 页` : ""
        }</span>
        <span class="etf-inline-actions">
          ${paged ? `<button class="btn btn--ghost btn--sm" type="button" data-ipage="-1" ${st.page === 0 ? "disabled" : ""}>上一页</button>
          <button class="btn btn--ghost btn--sm" type="button" data-ipage="1" ${st.page >= pages - 1 ? "disabled" : ""}>下一页</button>` : ""}
          <button class="btn btn--sm" type="button" data-icsv="1"><svg aria-hidden="true"><use href="#i-download"/></svg>CSV</button>
        </span>
      </div>
      <div class="table-scroll">
        <table class="dt dt--inline" id="tblFocusEtf">
          <thead><tr>
            ${sortHead("code", "代码", "t-2xs", false)}
            ${sortHead("name", "名称", "", false)}
            ${sortHead("price", quoteEnabled() ? "最新价" : "收盘价", "num col-price")}
            ${sortHead("pctRange", "区间规模变化", "num", true, approx ? "近似" : "")}
            ${sortHead("flowRange", "区间净申购", "num", true, approx ? "近似" : "")}
            ${sortHead("scaleEnd", "期末规模", "num", true, approx ? "近似" : "")}
            <th scope="col" class="num" title="区间终点为最新交易日时取快照，否则留空">折溢价</th>
            <th scope="col" class="num">占本类</th>
          </tr></thead>
          <tbody>${view.map((r) => etfRowHTML(r, 0, app)).join("")}</tbody>
        </table>
      </div>
    </div>`;

    // 按需实时报价：只取当前页可见代码（最多 40 个），失败静默保持静态收盘价
    attachQuotes(host.querySelector("#tblFocusEtf"), view.map((r) => r.code));

    host.onclick = (e) => {
      const th = /** @type {HTMLElement} */ (e.target).closest("th[data-isort]");
      if (th) {
        const key = /** @type {HTMLElement} */ (th).dataset.isort;
        const numeric = /** @type {HTMLElement} */ (th).dataset.type !== "text";
        st.dir = st.key === key ? -st.dir : numeric ? -1 : 1;
        st.key = key;
        st.page = 0;
        renderInlineEtfTable(app, subName, host);
        return;
      }
      const page = /** @type {HTMLElement} */ (e.target).closest("[data-ipage]");
      if (page) {
        st.page = Math.max(0, Math.min(pages - 1, st.page + Number(/** @type {HTMLElement} */ (page).dataset.ipage)));
        renderInlineEtfTable(app, subName, host);
        return;
      }
      if (/** @type {HTMLElement} */ (e.target).closest("[data-icsv]")) {
        const csv = toCSV([
          ["代码", "名称", "市场", "最新价(元)", "区间规模变化(%)", "区间净申购(亿元)", "期末规模(亿元)", "折溢价(%)", "占本类(%)"],
          ...sorted.map((r) => [
            r.code,
            r.name,
            r.market || "",
            r.price ?? "",
            r.pctRange != null ? r.pctRange.toFixed(2) : "",
            r.flowRange != null ? r.flowRange.toFixed(2) : "",
            r.scaleEnd != null ? r.scaleEnd.toFixed(2) : "",
            r.premiumEnd != null ? r.premiumEnd.toFixed(2) : "",
            r.weightPct != null ? r.weightPct.toFixed(2) : "",
          ]),
        ]);
        download(`${subName}-成分ETF-${state.rangeInfo.from}-${state.rangeInfo.to}.csv`, csv, "text/csv;charset=utf-8");
      }
    };
  })();
}

let opening = false;
let refreshTimer = 0;

/** stats / charts / 指标变化后，若抽屉开着则重绘（保留滚动位置） */
function scheduleRefresh() {
  if (!current || opening) return;
  const drawer = document.getElementById("drawer");
  if (drawer?.dataset.open !== "1") return;
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(async () => {
    if (!current || opening) return;
    const body = document.getElementById("drawerBody");
    const top = body ? body.scrollTop : 0;
    await openDetail(current);
    const body2 = document.getElementById("drawerBody");
    if (body2) body2.scrollTop = top;
  }, 120);
}

export function initDetail(app, hooks = {}) {
  drawerHooks = { app, ...hooks };
  // 区间变化时重建打开中的抽屉（KPI / 走势 / 成分表都跟着区间走）
  document.addEventListener("ebbflow:stats", scheduleRefresh);
  document.addEventListener("ebbflow:metric", scheduleRefresh);
  document.addEventListener("ebbflow:rangechange", () => {
    const drawer = document.getElementById("drawer");
    if (!current || drawer?.dataset.open !== "1") return;
    const body = document.getElementById("drawerBody");
    const top = body ? body.scrollTop : 0;
    openDetail(current).then(() => {
      if (body) body.scrollTop = top;
    });
  });
  document.getElementById("drawerClose")?.addEventListener("click", () => closeDetail());
  document.getElementById("drawerStar")?.addEventListener("click", () => {
    if (!current) return;
    const added = state.watch.includes(current) ? false : true;
    drawerHooks.onToggleWatch?.(current);
    if (current) syncStar();
    toast(added ? `已加入自选：${current}` : `已取消自选：${current}`, added ? "ok" : "info", 1800);
  });
  document.getElementById("drawerCompare")?.addEventListener("click", () => {
    if (!current) return;
    drawerHooks.onCompare?.(current);
  });
}

export async function openDetail(name) {
  if (opening) return;
  opening = true;
  try {
    await openDetailImpl(name);
  } finally {
    opening = false;
  }
}

async function openDetailImpl(name) {
  const app = drawerHooks.app;
  if (!app || !name) return;
  current = name;
  const drawer = document.getElementById("drawer");
  const mask = document.getElementById("drawerMask");
  if (drawer?.dataset.open !== "1") {
    openOverlay(mask, drawer, {
      onClose: () => {
        current = null;
        mini?.dispose();
        mini = null;
      },
    });
  }
  const title = document.getElementById("drawerTitle");
  if (title) title.textContent = name;
  const eyebrow = document.getElementById("drawerEyebrow");
  if (eyebrow) {
    const cat = app.subs?.[name]?.cat || app.stats?.byName?.get(name)?.cat;
    eyebrow.innerHTML = `<span class="cat-dot" style="background:${esc(
      toneColor(app.subs?.[name]?.color || app.stats?.byName?.get(name)?.color || "#888", isDark())
    )}"></span><span>${esc(cat ? catLabelOf(app, cat) : "")}</span>
      <span class="chip chip--line">${esc(state.rangeInfo.from)} → ${esc(state.rangeInfo.to)}</span>`;
  }
  syncStar();
  // 通知外层：打开了某个小类（大类视图里会同步「单系列聚焦」）
  try {
    drawerHooks.onOpen?.(name);
  } catch (e) {}

  // subs.json 是懒加载的：先给轻量占位，拿到数据后再渲染明细
  if (!app.subs) {
    const body = document.getElementById("drawerBody");
    if (body)
      body.innerHTML = `<div class="drawer-sec">
        <div class="sk" style="height:120px;border-radius:var(--r-md)"></div>
        <div class="sk" style="height:180px;border-radius:var(--r-md);margin-top:12px"></div>
      </div>
      <div class="state state--sm"><span class="spinner" aria-hidden="true"></span><p class="state-desc">正在加载成分数据（subs.json，约 1.9MB）…</p></div>`;
    try {
      await drawerHooks.ensureSubs?.();
    } catch (e) {
      if (body) body.innerHTML = emptyState("成分数据加载失败", "data/subs.json 未能加载，图表与总览不受影响。");
      return;
    }
  }
  if (current !== name) return;
  if (drawerHooks.ensureStatsFor) {
    try {
      await drawerHooks.ensureStatsFor(name);
    } catch (e) {}
  }
  if (current !== name) return;
  const stats = app.stats?.byName?.get(name);
  const entry = app.subs?.[name];
  if (!entry) {
    renderMissingDetail(app, name, stats);
    return;
  }
  renderDetail(app, name, stats, entry);
}

export function closeDetail() {
  const drawer = document.getElementById("drawer");
  if (drawer) closeOverlay(drawer);
}

function syncStar() {
  const btn = document.getElementById("drawerStar");
  if (!btn || !current) return;
  const on = state.watch.includes(current);
  btn.setAttribute("aria-pressed", String(on));
  btn.setAttribute("aria-label", on ? "取消自选" : "加入自选");
  btn.title = on ? "取消自选" : "加入自选";
}

function renderDetail(app, name, s, entry) {
  const eyebrow = document.getElementById("drawerEyebrow");
  const title = document.getElementById("drawerTitle");
  const body = document.getElementById("drawerBody");
  const cat = app.catMap?.get(s?.cat || entry?.cat);
  const color = toneColor(s?.color || entry?.color || "#888", isDark());
  if (eyebrow) {
    eyebrow.innerHTML = `<span class="cat-dot" style="background:${esc(color)}"></span>
      <span>${esc(cat ? cat.label : s?.cat || "—")}</span>
      <span class="chip chip--line">${esc(state.rangeInfo.from)} → ${esc(state.rangeInfo.to)}</span>`;
  }
  if (title) title.textContent = name;
  if (!body) return;

  const rank = rankOf(app.stats, name, "pct");
  const flow = s && Number.isFinite(+s.flow) ? (app.flowOf ? app.flowOf(name, s) : flowEstimate(s)) : null;
  const nav = entry?.navCoverage;
  const rows = entry?.etfs || [];
  const totalScale = rows.reduce((acc, r) => acc + (r.scale || 0), 0) || s?.scale || 0;

  const miniId = `mini-${Math.random().toString(36).slice(2, 7)}`;
  body.innerHTML = `
    <section class="drawer-sec">
      <div class="drawer-sec-head">
        <h3>区间表现</h3>
        <span class="chip ${s?.pct > 0 ? "chip--up" : s?.pct < 0 ? "chip--down" : "chip--flat"}">${
          rank ? `排名 ${rank.rank}/${rank.total}` : "无排名"
        }</span>
      </div>
      <dl class="kpi-mini">
        <div><dt>最新规模</dt><dd class="num">${
          s?.last == null ? "—" : `${esc(cnum(s.last, 1))}<span class="unit">亿元</span>`
        }</dd></div>
        <div><dt>区间起点规模</dt><dd class="num">${
          s?.first == null ? "—" : `${esc(cnum(s.first, 1))}<span class="unit">亿元</span>`
        }</dd></div>
        <div><dt>区间变化</dt><dd class="num ${s?.pct > 0 ? "up" : s?.pct < 0 ? "down" : "flat"}">${esc(fmtPct(s?.pct, 2))}</dd></div>
        <div><dt>区间净申购</dt><dd class="num ${
          flow == null ? "" : flow > 0 ? "up" : flow < 0 ? "down" : "flat"
        }">${flow == null ? "—" : esc(fmtSigned(flow, 1))}${flow == null ? "" : `<span class="unit">亿元</span>`}</dd></div>
      </dl>
      <p class="t-2xs dim" style="margin-top:2px">规模变化 ${esc(fmtSigned(s?.delta, 1))} 亿元 ｜ 成分 ETF ${rows.length} 只${
        nav ? ` ｜ 净值覆盖 ${nav.hit}/${nav.total}` : ""
      }</p>
    </section>

    <section class="drawer-sec">
      <div class="drawer-sec-head">
        <h3>自身走势</h3>
        <span class="t-2xs dim">${esc(state.rangeInfo.days)} 个交易日</span>
      </div>
      <div class="chart--sm" id="${miniId}" style="height:180px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md)"></div>
    </section>

    <section class="drawer-sec">
      <div class="drawer-sec-head">
        <h3>成分 ETF</h3>
        <div style="display:flex;gap:6px">
          <button class="btn btn--sm" type="button" id="etfCsv">
            <svg aria-hidden="true"><use href="#i-download"/></svg>CSV
          </button>
          <button class="btn btn--sm" type="button" id="seriesCsv">
            <svg aria-hidden="true"><use href="#i-download"/></svg>走势
          </button>
        </div>
      </div>
      <div class="table-wrap" style="max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-md)">
        <table class="dt dt--dense" id="tblEtf">
          <thead>
            <tr>
              <th scope="col" data-esort="code" aria-sort="none"><button type="button"><span class="th-label">代码</span><span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="name" aria-sort="none"><button type="button"><span class="th-label">名称</span><span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="price" class="num col-price" aria-sort="none"><button type="button"><span class="th-label">最新价</span><span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="pctRange" class="num" aria-sort="none"><button type="button"><span class="th-label">区间规模变化</span><span class="sort-ico"></span></button><span class="th-approx" tabindex="0" role="note" title="小类级规模日序列 × 该 ETF 当前规模权重估算（自定义区间无精确值）">近似</span></th>
              <th scope="col" data-esort="flowRange" class="num" aria-sort="descending"><button type="button"><span class="th-label">区间净申购</span><span class="sort-ico"></span></button><span class="th-approx" tabindex="0" role="note" title="小类级规模日序列 × 该 ETF 当前规模权重估算（自定义区间无精确值）">近似</span></th>
              <th scope="col" data-esort="scaleEnd" class="num" aria-sort="none"><button type="button"><span class="th-label">期末规模</span><span class="sort-ico"></span></button><span class="th-approx" tabindex="0" role="note" title="小类级规模日序列 × 该 ETF 当前规模权重估算（自定义区间无精确值）">近似</span></th>
              <th scope="col" data-esort="premiumEnd" class="num" aria-sort="none" title="区间终点为最新交易日时取快照，否则留空"><button type="button"><span class="th-label">折溢价</span><span class="sort-ico"></span></button></th>
              <th scope="col" class="num">占本类</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="t-2xs faint" id="etfRangeNote">区间列跟随上方区间：<b>区间规模变化</b> / <b>区间净申购</b> / <b>期末规模</b>；区间净申购按区间内交易日逐日累加，不含期初当天（期初当天属于上一区间）。端点为低覆盖日时会向前取最近达标日（tooltip 注明实际日期）；「最新价 / 折溢价」为最新交易日快照，折溢价仅在区间终点=最新交易日时展示。</p>
    </section>`;

  drawerRows = rows;
  drawerTotalScale = totalScale;
  syncPriceHeaderLabel(body);
  renderEtfTable(rows, totalScale);

  // 迷你走势
  mini?.dispose();
  mini = createMiniChart(document.getElementById(miniId), {
    dates: state.rangeInfo.fromIdx >= 0 ? state.calendar.slice(state.rangeInfo.fromIdx, state.rangeInfo.toIdx + 1) : [],
    values: s?.series || [],
    color,
    unit: "亿元",
    name,
  });

  body.querySelectorAll("[data-esort]").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.esort;
      etfSort = { key: k, dir: etfSort.key === k ? -etfSort.dir : k === "name" || k === "code" ? 1 : -1 };
      renderEtfTable();
    });
  });

  document.getElementById("etfCsv")?.addEventListener("click", () => {
    const header = ["代码", "名称", "市场", "最新价(元)", "区间规模变化(%)", "区间净申购(亿元)", "期末规模(亿元)", "折溢价(%)", "占本类(%)"];
    const data = drawerSorted.map((r) => [
      r.code,
      r.name,
      r.market || "",
      r.price ?? "",
      r.pctRange != null ? r.pctRange.toFixed(2) : "",
      r.flowRange != null ? r.flowRange.toFixed(2) : "",
      r.scaleEnd != null ? r.scaleEnd.toFixed(2) : "",
      r.premiumEnd != null ? r.premiumEnd.toFixed(2) : "",
      r.weightPct != null ? r.weightPct.toFixed(2) : "",
    ]);
    download(`${name}-成分ETF-${state.rangeInfo.from}-${state.rangeInfo.to}.csv`, toCSV([header, ...data]));
    toast("已导出成分 ETF CSV（区间列由小类级估算）", "ok");
  });

  document.getElementById("seriesCsv")?.addEventListener("click", () => {
    const dates = state.calendar.slice(state.rangeInfo.fromIdx, state.rangeInfo.toIdx + 1);
    const header = ["日期", `${name}规模(亿元)`];
    const data = (s?.series || []).map((v, i) => [dates[i], v ?? ""]);
    download(`${name}-规模-${state.rangeInfo.from}-${state.rangeInfo.to}.csv`, toCSV([header, ...data]));
    toast("已导出走势 CSV", "ok");
  });
}

/** 只有区间统计、没有成分 ETF 明细（数据管线尚未产出该小类的 subs 条目） */
function renderMissingDetail(app, name, s) {
  const body = document.getElementById("drawerBody");
  if (!body) return;
  const rank = s ? rankOf(app.stats, name, "pct") : null;
  const flow = s && Number.isFinite(+s.flow) ? (app.flowOf ? app.flowOf(name, s) : flowEstimate(s)) : null;
  body.innerHTML = `
    <section class="drawer-sec">
      <div class="drawer-sec-head">
        <h3>区间表现</h3>
        ${s ? `<span class="chip ${s.pct > 0 ? "chip--up" : s.pct < 0 ? "chip--down" : "chip--flat"}">${rank ? `排名 ${rank.rank}/${rank.total}` : "无排名"}</span>` : ""}
      </div>
      ${
        s
          ? `<dl class="kpi-mini">
              <div><dt>最新规模</dt><dd class="num">${s.last == null ? "—" : `${esc(cnum(s.last, 1))}<span class="unit">亿元</span>`}</dd></div>
              <div><dt>区间起点规模</dt><dd class="num">${s.first == null ? "—" : `${esc(cnum(s.first, 1))}<span class="unit">亿元</span>`}</dd></div>
              <div><dt>区间变化</dt><dd class="num ${s.pct > 0 ? "up" : s.pct < 0 ? "down" : "flat"}">${esc(fmtPct(s.pct, 2))}</dd></div>
              <div><dt>区间净申购</dt><dd class="num ${
                flow == null ? "" : flow > 0 ? "up" : flow < 0 ? "down" : "flat"
              }">${flow == null ? "—" : esc(fmtSigned(flow, 1))}${flow == null ? "" : `<span class="unit">亿元</span>`}</dd></div>
            </dl>`
          : ""
      }
    </section>
    <div class="state" style="padding:var(--sp-7) var(--sp-4)">
      <div class="state-ico" aria-hidden="true"><svg width="18" height="18"><use href="#i-info"/></svg></div>
      <p class="state-title">成分 ETF 明细暂未收录</p>
      <p class="state-desc">当前数据包（subs.json）里还没有这个小类的成分明细${
        s ? "，但区间统计是按已收录成分算的，可以正常参考" : ""
      }。数据管线补齐后这里会自动出现。</p>
      <button class="btn btn--sm" type="button" data-goto-cat="${esc(app.subs?.[name]?.cat || "")}">返回该大类</button>
    </div>`;
  const back = body.querySelector("[data-goto-cat]");
  const cat = app.stats?.byName?.get(name)?.cat;
  if (back && cat) back.addEventListener("click", () => { closeOverlay(document.getElementById("drawer")); drawerHooks.onGoCat?.(cat); });
  else back?.remove();
}

/** 成分 ETF 行内容（抽屉表与聚焦内嵌表共用） */
export function etfRowHTML(r, totalScale, app) {
  const code = esc(r.code);
  const prem = r.premiumEnd;
  const premCls = prem == null ? "flat" : prem > 0.3 ? "up" : prem < -0.3 ? "down" : "flat";
  const premStrong = prem != null && Math.abs(prem) > 2 ? " is-strong" : "";
  const pctCls = r.pctRange == null ? "flat" : r.pctRange > 0 ? "up" : r.pctRange < 0 ? "down" : "flat";
  const flowCls = r.flowRange == null ? "flat" : r.flowRange > 0 ? "up" : r.flowRange < 0 ? "down" : "flat";
  const share = r.weightPct;
  return `<tr>
    <td class="mono t-2xs">${code}</td>
    <td class="etf-name-cell">
      <span class="truncate" style="max-width:15ch;display:inline-block" title="${esc(r.name)}">${esc(r.name)}</span>
      <span class="chip chip--sm chip--line" style="margin-left:4px">${esc(r.market || "—")}</span>
      ${renderTags(r.tags, app?.meta?.tagDims)}
    </td>
    <td class="num col-price" data-code="${code}">${r.price != null ? esc(cnum(r.price, 3)) : "—"}</td>
    <td class="num ${pctCls}" title="${
      r.approx
        ? `估算：小类级区间规模变化 × 该 ETF 当前规模权重${r.endpointNote ? "；" + r.endpointNote : ""}`
        : "区间规模变化（ETF 精确值）"
    }">${r.pctRange != null ? esc(fmtSigned(r.pctRange, 2)) + "%" : "—"}</td>
    <td class="num ${flowCls}" title="${
      r.approx ? `估算：小类级区间净申购 × 该 ETF 当前规模权重${r.endpointNote ? "；" + r.endpointNote : ""}` : "区间净申购（ETF 精确值）"
    }">${r.flowRange != null ? esc(fmtSigned(r.flowRange, 1)) : "—"}</td>
    <td class="num" title="${r.approx ? "估算：小类期末规模 × 该 ETF 当前规模权重" : "期末规模（ETF 精确值）"}">${
      r.scaleEnd != null ? esc(cnum(r.scaleEnd, 1)) : "—"
    }</td>
    <td class="num ${premCls}${premStrong}"${
      prem == null && r.premium != null
        ? ' title="区间终点不是最新交易日，没有逐日期末折溢价（不编造）"'
        : ` title="（收盘价 − 单位净值）/ 单位净值${prem != null ? ` = ${prem.toFixed(2)}%` : ""}"`
    }>${prem != null ? esc(fmtSigned(prem, 2)) + "%" : "—"}</td>
    <td class="num"><span class="barcell"><span class="barcell-track"><span class="barcell-fill" style="width:${
      share != null ? Math.min(100, share * 3).toFixed(1) : 0
    }%"></span></span><span class="barcell-val">${share != null ? share.toFixed(1) + "%" : "—"}</span></span></td>
  </tr>`;
}
export function sortEtfRows(rows, { key, dir }) {
  const read = (r) => {
    if (key === "code" || key === "name") return String(r[key] || "");
    const raw = r[key];
    if (raw == null || !Number.isFinite(raw)) return null;
    // 「区间净申购」按绝对值排序：默认降序时把流入/流出最大的排前面
    return key === "flowRange" ? Math.abs(raw) : raw;
  };
  return rows.slice().sort((a, b) => {
    const av = read(a);
    const bv = read(b);
    if (typeof av === "string") return dir * av.localeCompare(/** @type {string} */ (bv), "zh-CN");
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // 空值始终排最后
    if (bv == null) return -1;
    return dir * (av - /** @type {number} */ (bv));
  });
}

let drawerRenderToken = 0;
/** 静态托管没有报价后端：列头用「收盘价」，避免「最新价」的误导 */
function syncPriceHeaderLabel(scope = document) {
  if (quoteEnabled()) return;
  const label = scope.querySelector('#tblEtf th[data-esort="price"] .th-label, #tblFocusEtf th[data-isort="price"] .th-label');
  if (label) label.textContent = "收盘价";
}

async function renderEtfTable(rows = drawerRows, totalScale = drawerTotalScale) {
  const tbody = document.querySelector("#tblEtf tbody");
  if (!tbody) return;
  const app = drawerHooks.app;
  const name = current;
  const token = ++drawerRenderToken;
  const ctx = name ? await rangeContext(app, name, rows) : null;
  if (token !== drawerRenderToken || current !== name) return;
  const approx = ctx?.mode !== "exact";
  document.querySelectorAll("#tblEtf .th-approx").forEach((el) => {
    /** @type {HTMLElement} */ (el).hidden = !approx;
  });
  const note = document.getElementById("etfRangeNote");
  if (note) {
    const ep = ctx?.endpointsAdjusted ? `；${endpointNote(ctx)}` : "";
    note.innerHTML = approx
      ? `区间列按「小类级规模 × 该 ETF 当前规模权重」估算（表头标「近似」）：<b>区间规模变化</b> = 小类期初→期末规模变化率，<b>区间净申购</b> = 小类区间净申购 × 权重（不含期初当天），<b>期末规模</b> = 小类期末规模 × 权重${ep}。`
      : `区间列为后端按 ETF 逐日数据计算的<b>精确值</b>（预设区间）：区间规模变化 / 区间净申购（不含期初当天）/ 期末规模。自定义区间无精确值时自动回退为估算并标「近似」。`;
  }
  const decorated = decorateRows(rows, ctx);
  const sorted = sortEtfRows(decorated, etfSort);
  drawerSorted = sorted;
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="state state--sm"><p class="state-desc">该小类暂无成分 ETF 明细</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = sorted.map((r) => etfRowHTML(r, 0, app)).join("");
  // 抽屉表：成分通常 ≤40；失败静默，保留静态价格
  attachQuotes(document.getElementById("tblEtf"), sorted.slice(0, 40).map((r) => r.code));
  document.querySelectorAll("#tblEtf th[data-esort]").forEach((th) => {
    const el = /** @type {HTMLElement} */ (th);
    if (el.dataset.esort === etfSort.key) el.setAttribute("aria-sort", etfSort.dir > 0 ? "ascending" : "descending");
    else el.removeAttribute("aria-sort");
  });
}

/* ==========================================================================
   全部小类（数量从 meta.counts 读，不再写死）
   ========================================================================== */
let allHooks = {};
let allCache = null; // 金额口径的补充数据 { name: {first,last,delta,pct} }

/** 导出全部成分 ETF 的多维标签清单（数据源 subs.json） */
export async function exportAllEtfs() {
  const btn = document.getElementById("btnExportEtfs");
  const app = allHooks.app;
  if (!app?.subs) {
    try {
      await allHooks.ensureSubs?.();
    } catch (e) {
      toast("成分数据尚未就绪，请稍后再试", "error", 2600);
      return;
    }
  }
  const subs = app?.subs || {};
  const dims = app?.meta?.tagDims || {};
  const prefixCols = [
    ["sw", "申万一级"],
    ["csi", "中证一级"],
    ["index", "指数类别"],
    ["theme", "主题"],
    ["region", "地区"],
    ["factor", "因子"],
  ];
  const header = [
    "代码", "名称", "大类", "小类", "市场",
    ...prefixCols.map(([, label]) => label),
    "规模(亿元)", "折溢价(%)", "成交额(亿元)", "换手率(%)", "上市日",
  ];
  const rows = [];
  for (const [subName, sub] of Object.entries(subs)) {
    const catLabel = app?.catMap?.get(sub.cat)?.label || sub.cat || "";
    for (const e of sub.etfs || []) {
      const tagMap = {};
      for (const t of e.tags || []) {
        const i = String(t).indexOf(":");
        if (i > 0) tagMap[String(t).slice(0, i)] = String(t).slice(i + 1);
      }
      rows.push([
        e.code,
        e.name,
        catLabel,
        subName,
        e.market || "",
        ...prefixCols.map(([p]) => tagMap[p] || ""),
        e.scale ?? "",
        e.premium ?? "",
        e.amount ?? "",
        e.turnover ?? "",
        e.listDate ?? "",
      ]);
    }
  }
  if (!rows.length) {
    toast("没有可导出的 ETF 数据", "info", 2200);
    return;
  }
  download(`Ebbflow-ETF清单-${state.taxonomy}-${state.rangeInfo.to || ""}.csv`, toCSV([header, ...rows]), "text/csv;charset=utf-8");
  toast(`已导出 ${rows.length} 只 ETF（含多维标签）`, "ok", 2600);
  btn?.blur();
}

export function initAllSubs(app, hooks) {
  allHooks = { app, ...hooks };
  const mask = document.getElementById("allMask");
  document.getElementById("allClose")?.addEventListener("click", () => closeOverlay(mask.querySelector(".modal")));
  document.getElementById("btnExportEtfs")?.addEventListener("click", () => exportAllEtfs());
  document.getElementById("btnAllSubsNav")?.addEventListener("click", () => openAllSubs());
  document.getElementById("btnAllSubsFromGrid")?.addEventListener("click", () => openAllSubs());
  document.getElementById("allSearch")?.addEventListener("input", (e) => {
    state.allQuery = e.target.value;
    renderAllTable();
  });
  document.getElementById("allSign")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sign]");
    if (!b) return;
    state.allSign = b.dataset.sign;
    document.querySelectorAll("#allSign [data-sign]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderAllTable();
  });
  document.getElementById("allCsv")?.addEventListener("click", exportAllCsv);
  document.querySelectorAll("#tblAll thead th[data-sort-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.sortKey;
      state.allSort = { key: k, dir: state.allSort.key === k ? -state.allSort.dir : th.dataset.type === "text" ? 1 : -1 };
      renderAllTable();
    });
  });
  document.getElementById("tblAll")?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-sub]");
    if (!tr) return;
    openDetail(tr.dataset.sub);
  });
  document.getElementById("tblAll")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-sub]");
    if (!tr) return;
    e.preventDefault();
    openDetail(tr.dataset.sub);
  });
}

export async function openAllSubs(opts = {}) {
  const mask = document.getElementById("allMask");
  if (!mask) return;
  if (opts.sign) {
    state.allSign = opts.sign;
    document.querySelectorAll("#allSign [data-sign]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.sign === opts.sign)));
  }
  openOverlay(mask, mask.querySelector(".modal"), { initialFocus: "#allSearch" });
  if (!allHooks.app?.subsReady) {
    const tbody = document.querySelector("#tblAll tbody");
    if (tbody) tbody.innerHTML = skeletonRows(8, 10);
    const count = document.getElementById("allCount");
    if (count) count.textContent = `正在加载 ${allHooks.app?.meta?.counts?.subs ?? "全部"} 个小类的区间数据…`;
    try {
      await allHooks.ensureSubs?.();
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8">${emptyState("数据加载失败", "data/subs.json 未能加载，请稍后重试。")}</td></tr>`;
      return;
    }
  }
  renderAllTable();
  if (!allHooks.app?.subsReady) await allHooks.ensureSubs?.().catch(() => {});
}

/** 金额口径：按需拉全部大类 charts（约 1.2–1.7MB），计算区间 scale 变化 */
async function prepareScaleData() {
  const app = allHooks.app;
  const sub = document.getElementById("allSub");
  const n = catKeys().length || 10;
  if (sub) sub.textContent = `正在加载全量金额序列（0/${n} 个数据文件）…`;
  const charts = await loadAllCharts((done, total) => {
    if (sub) sub.textContent = `正在加载全量金额序列（${done}/${total} 个数据文件）…`;
  });
  allCache = new Map();
  const r = state.rangeInfo;
  for (const [catKey, payload] of Object.entries(charts)) {
    if (!payload?.series) continue;
    for (const s of payload.series) {
      const arr = s.scale || [];
      if (!arr.length) continue;
      const first = firstInRange(arr, r.fromIdx, r.toIdx);
      const last = lastInRange(arr, r.fromIdx, r.toIdx);
      if (first == null || last == null) continue;
      const delta = last - first;
      allCache.set(s.name, { first, last, delta, pct: first ? (delta / Math.abs(first)) * 100 : null, ok: true });
    }
  }
  if (sub) sub.textContent = `金额口径 · ${rangeTextShort()} · 已加载 ${allCache.size} 个小类`;
  if (!allCache.size) {
    toast("规模序列加载失败，请稍后重试", "error");
  }
}

const rangeTextShort = () => `${state.rangeInfo.from} → ${state.rangeInfo.to} · ${state.rangeInfo.days} 个交易日`;

function firstInRange(arr, a, b) {
  for (let i = a; i <= b; i++) if (arr[i] != null && Number.isFinite(+arr[i])) return +arr[i];
  return null;
}
function lastInRange(arr, a, b) {
  for (let i = b; i >= a; i--) if (arr[i] != null && Number.isFinite(+arr[i])) return +arr[i];
  return null;
}

function allRows() {
  const app = allHooks.app;
  const stats = app?.stats;
  if (!stats) return [];
  const q = state.allQuery.trim().toLowerCase();
  let rows = stats.subs.map((s) => {
    const first = s.first;
    const last = s.last;
    const delta = s.delta;
    const pct = s.pct;
    const catTotal = stats.byCat.get(s.cat)?.last || 0;
    return {
      sub: s.name,
      cat: s.cat,
      catLabel: catLabelOf(app, s.cat),
      color: s.color,
      first,
      last,
      delta,
      pct,
      share: catTotal ? (s.last / catTotal) * 100 : null,
      scale: s.scale,
    };
  });
  if (q) {
    const pin = app.pinyin?.subs?.get ? app.pinyin.subs.get : null;
    rows = rows.filter((r) => {
      if (r.sub.toLowerCase().includes(q)) return true;
      const py = app.pinyinOf?.(r.sub) || "";
      return py.toLowerCase().includes(q);
    });
  }
  if (state.allSign === "in") rows = rows.filter((r) => r.delta > 0);
  if (state.allSign === "out") rows = rows.filter((r) => r.delta < 0);
  const { key, dir } = state.allSort;
  rows.sort((a, b) => {
    if (key === "sub" || key === "cat") return dir * String(a[key]).localeCompare(String(b[key]), "zh-CN");
    return dir * ((a[key] ?? -Infinity) - (b[key] ?? -Infinity));
  });
  return rows;
}

function renderAllTable() {
  const tbl = document.getElementById("tblAll");
  if (!tbl) return;
  const tbody = tbl.querySelector("tbody");
  const rows = allRows();
  const count = document.getElementById("allCount");
  const unit = "亿元";
  if (count) {
    const total = allHooks.app?.meta?.counts?.subs;
    count.textContent = `共 ${rows.length} 个小类有区间数据${total && total !== rows.length ? `（口径共 ${total} 个）` : ""} · 单位 ${unit} · ${rangeTextShort()}`;
  }
  const ths = tbl.querySelectorAll("thead th[data-sort-key]");
  ths.forEach((th) => {
    const k = th.dataset.sortKey;
    const btn = th.querySelector("button");
    if (btn && !btn.dataset.base) btn.dataset.base = btn.textContent.replace(/（.*）$/, "").trim();
    if (btn) {
      const extra = k === "delta" ? `（${unit}）` : k === "pct" ? "（%）" : "";
      btn.textContent = btn.dataset.base + extra;
      btn.appendChild(Object.assign(document.createElement("span"), { className: "sort-ico" }));
    }
    if (k === state.allSort.key) th.setAttribute("aria-sort", state.allSort.dir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8">${emptyState("没有匹配的小类", "换个关键词，或把筛选切回「全部」。")}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r, i) => `<tr data-sub="${esc(r.sub)}" data-cat="${esc(r.cat)}" tabindex="0">
      <td class="dim t-2xs">${i + 1}</td>
      <td><span class="cell-name"><span class="cat-dot" style="background:${esc(toneColor(r.color || "#888", isDark()))}"></span>${esc(r.sub)}</span></td>
      <td><span class="t-2xs dim">${esc(r.catLabel)}</span></td>
      <td class="num">${esc(cnum(r.first, 1))}</td>
      <td class="num">${esc(cnum(r.last, 1))}</td>
      <td class="num ${r.delta > 0 ? "up" : r.delta < 0 ? "down" : "flat"}">${esc(fmtSigned(r.delta, 1))}</td>
      <td class="num ${r.pct > 0 ? "up" : r.pct < 0 ? "down" : "flat"}">${esc(fmtPct(r.pct, 2))}</td>
      <td class="num">${r.share != null ? r.share.toFixed(1) + "%" : "—"}</td>
    </tr>`
    )
    .join("");
}

function exportAllCsv() {
  const rows = allRows();
  const unit = "亿元";
  const header = ["细分行业", "大类", `区间起点(${unit})`, `区间终点(${unit})`, `变化量(${unit})`, "变化率(%)", "本类占比(%)"];
  const data = rows.map((r) => [
    r.sub,
    r.catLabel,
    r.first ?? "",
    r.last ?? "",
    r.delta ?? "",
    r.pct != null ? r.pct.toFixed(2) : "",
    r.share != null ? r.share.toFixed(2) : "",
  ]);
  download(`全部小类-${state.rangeInfo.from}-${state.rangeInfo.to}.csv`, toCSV([header, ...data]));
  toast("已导出全部小类 CSV", "ok");
}

/* ==========================================================================
   数据质量
   ========================================================================== */
export function initQuality(app) {
  const mask = document.getElementById("qMask");
  const open = () => openQuality(app);
  document.getElementById("btnQuality")?.addEventListener("click", open);
  document.getElementById("btnQuality2")?.addEventListener("click", open);
  document.getElementById("qClose")?.addEventListener("click", () => closeOverlay(mask.querySelector(".modal")));
  document.getElementById("qDownload")?.addEventListener("click", () => {
    if (!app.quality) return;
    download("quality.json", JSON.stringify(app.quality, null, 2), "application/json");
  });
}

export async function openQuality(app) {
  const mask = document.getElementById("qMask");
  const body = document.getElementById("qBody");
  const foot = document.getElementById("qFoot");
  if (!mask || !body) return;
  openOverlay(mask, mask.querySelector(".modal"));
  if (app.quality) {
    renderQuality(app.quality);
    return;
  }
  body.innerHTML = `<div class="state"><span class="spinner" aria-hidden="true"></span><p class="state-desc">正在加载校验报告…</p></div>`;
  try {
    const q = await load("quality");
    app.quality = q;
    renderQuality(q);
  } catch (e) {
    body.innerHTML = emptyState("校验报告不可用", "quality.json 未能加载。该文件只影响质量面板，不影响行情与图表。");
    if (foot) foot.textContent = "—";
  }
}

function renderQuality(q) {
  const body = document.getElementById("qBody");
  const foot = document.getElementById("qFoot");
  if (!body) return;
  const s = q.summary || {};
  const days = Array.isArray(q.days) ? q.days : [];
  const bad = days.filter((d) => d.count > 0);
  const rate = s.checked ? ((s.agree ?? 0) / s.checked) * 100 : null;
  body.innerHTML = `
    <div class="grid grid--2" style="gap:var(--sp-3)">
      <div class="kpi" style="padding:var(--sp-3) var(--sp-4)">
        <div class="kpi-label">校验一致率</div>
        <div class="kpi-val num" style="font-size:var(--fs-xl)">${rate != null ? rate.toFixed(2) : "—"}<span class="unit">%</span></div>
        <div class="kpi-foot">${esc(cnum(s.agree, 0))} / ${esc(cnum(s.checked, 0))} 条通过</div>
      </div>
      <div class="kpi" style="padding:var(--sp-3) var(--sp-4)">
        <div class="kpi-label">存在差异的交易日</div>
        <div class="kpi-val num" style="font-size:var(--fs-xl)">${bad.length}<span class="unit">天</span></div>
        <div class="kpi-foot">共校验 ${days.length} 天 · ${esc(
          cnum(typeof s.subs === "object" ? s.subs?.checked : s.subs, 0)
        )} 组小类口径</div>
      </div>
    </div>
    <div class="filterbar" style="margin:var(--sp-3) 0;gap:var(--sp-2)">
      <span class="chip ${s.ok ? "chip--up" : "chip--warn"}">${s.ok ? "三源校验通过" : "存在分歧"}</span>
      <span class="chip chip--line">仅交易所 ${esc(cnum(s.onlyExchange, 0))}</span>
      <span class="chip chip--line">仅 Tushare ${esc(cnum(s.onlyTs, 0))}</span>
      ${
        s.rates
          ? `<span class="chip chip--line">完全一致 ${esc(((s.rates.identical || 0) * 100).toFixed(2))}%</span>`
          : ""
      }
      ${s.range ? `<span class="chip chip--line">校验区间 ${esc(s.range[0])} ~ ${esc(s.range[1])}</span>` : ""}
    </div>
    <div class="notice" style="margin:0 0 var(--sp-3)">
      <svg aria-hidden="true"><use href="#i-info"/></svg>
      <span>校验口径：把「成分 ETF 合计（按份额×净值折算）」与交易所披露的同名小类口径对比，容差外记为差异。差异通常来自停牌、净值缺失或成分变更，属正常现象。${
        s.worstSub?.sub ? `本轮偏离最大的小类：${esc(s.worstSub.sub)}（${esc(s.worstSub.note || "")}）。` : ""
      }</span>
    </div>
    <div class="drawer-sec-head"><h3>逐日差异</h3><span class="t-2xs dim">生成于 ${esc((q.generatedAt || "").slice(0, 19).replace("T", " "))}</span></div>
    <div class="table-wrap" style="border:1px solid var(--line);border-radius:var(--r-md)">
      <table class="dt dt--dense" id="tblQuality" style="table-layout:fixed;width:100%">
        <thead><tr><th scope="col" style="width:96px">日期</th><th class="num" scope="col" style="width:76px">差异条数</th><th scope="col">样例</th></tr></thead>
        <tbody>
          ${
            days.length
              ? days
                  .slice()
                  .reverse()
                  .map(
                    (d) => `<tr>
              <td class="mono t-2xs">${esc(d.date)}</td>
              <td class="num ${d.count ? "warn" : "dim"}">${d.count ? `<strong>${d.count}</strong>` : "0"}</td>
              <td class="t-2xs dim" style="white-space:normal;word-break:break-word;line-height:1.5">${esc(
                (d.samples || []).slice(0, 3).join("；") || "—"
              )}</td>
            </tr>`
                  )
                  .join("")
              : `<tr><td colspan="3">${emptyState("没有差异记录", "该数据包未提供逐日差异，或最近区间完全一致。")}</td></tr>`
          }
        </tbody>
      </table>
    </div>`;
  if (foot) {
    foot.textContent = `数据生成 ${esc((q.generatedAt || "").slice(0, 10))} · 差异 ${esc(cnum(s.disagree, 0))} 条`;
  }
}
