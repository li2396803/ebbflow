/* ==========================================================================
   detail：小类明细抽屉 / 全部小类表 / 数据质量弹层
   ========================================================================== */

import { cnum, download, esc, fmtPct, fmtSigned, toCSV, toneColor, isDark, emptyState } from "./util.js";
import { flowEstimate, catLabelOf } from "./views.js";
import { rankOf, state } from "./state.js";
import { closeOverlay, openOverlay, toast } from "./ui.js";
import { createMiniChart } from "./chart.js";
import { load, loadAllCharts, catKeys } from "./api.js";

/* ==========================================================================
   小类明细
   ========================================================================== */
let mini = null;
let current = null;
let etfSort = { key: "scale", dir: -1 };
let drawerHooks = {};

export function initDetail(app, hooks = {}) {
  drawerHooks = { app, ...hooks };
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

export function openDetail(name) {
  const app = drawerHooks.app;
  if (!app || !name) return;
  const stats = app.stats?.byName?.get(name);
  const entry = app.subs?.[name];
  if (!stats && !entry) {
    toast("没有找到该小类", "error");
    return;
  }
  current = name;
  const drawer = document.getElementById("drawer");
  const mask = document.getElementById("drawerMask");
  renderDetail(app, name, stats, entry);
  if (drawer?.dataset.open !== "1") openOverlay(mask, drawer, { onClose: () => { current = null; mini?.dispose(); mini = null; } });
  syncStar();
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
  const flow = app.flowOf ? app.flowOf(name, s) : flowEstimate(s);
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
        <div><dt>最新份额</dt><dd class="num">${esc(cnum(s?.last, 1))}<span class="unit">亿份</span></dd></div>
        <div><dt>规模（估算）</dt><dd class="num">${s?.scale != null ? esc(cnum(s.scale, 1)) : "—"}<span class="unit">亿元</span></dd></div>
        <div><dt>区间变化</dt><dd class="num ${s?.pct > 0 ? "up" : s?.pct < 0 ? "down" : "flat"}">${esc(fmtPct(s?.pct, 2))}</dd></div>
        <div><dt>区间净流入${app.chartData?.has(s?.cat || entry?.cat) ? "" : "（估算）"}</dt><dd class="num ${flow > 0 ? "up" : flow < 0 ? "down" : "flat"}">${esc(fmtSigned(flow, 1))}<span class="unit">亿元</span></dd></div>
      </dl>
      <p class="t-2xs dim" style="margin-top:2px">份额变化 ${esc(fmtSigned(s?.delta, 1))} 亿份 ｜ 成分 ETF ${rows.length} 只${
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
              <th scope="col" data-esort="code" aria-sort="none"><button type="button">代码<span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="name" aria-sort="none"><button type="button">名称<span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="shares" class="num" aria-sort="none"><button type="button">份额<span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="delta" class="num" aria-sort="none"><button type="button">近期变化<span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="nav" class="num etf-nav" aria-sort="none"><button type="button">净值<span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="scale" class="num" aria-sort="descending"><button type="button">规模<span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="flow" class="num etf-flow" aria-sort="none"><button type="button">净流入<span class="sort-ico"></span></button></th>
              <th scope="col" class="num">占本类</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="t-2xs faint">「近期变化 / 净流入」沿用数据管线的近一周窗口口径；「份额 / 规模 / 净值」为最新交易日快照。净流入按当日净值折算，部分已退市成分无净值时不计入（见上方净值覆盖）。</p>
    </section>`;

  renderEtfTable(rows, totalScale);

  // 迷你走势
  mini?.dispose();
  mini = createMiniChart(document.getElementById(miniId), {
    dates: state.rangeInfo.fromIdx >= 0 ? state.calendar.slice(state.rangeInfo.fromIdx, state.rangeInfo.toIdx + 1) : [],
    values: s?.series || [],
    color,
    unit: "亿份",
    name,
  });

  body.querySelectorAll("[data-esort]").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.esort;
      etfSort = { key: k, dir: etfSort.key === k ? -etfSort.dir : k === "name" || k === "code" ? 1 : -1 };
      renderEtfTable(rows, totalScale);
    });
  });

  document.getElementById("etfCsv")?.addEventListener("click", () => {
    const header = ["代码", "名称", "市场", "份额(亿份)", "近期变化(亿份)", "净值(元)", "规模(亿元)", "净流入(亿元)", "占本类规模"];
    const data = rows.map((r) => [
      r.code,
      r.name,
      r.market || "",
      r.shares ?? "",
      r.delta ?? "",
      r.nav ?? "",
      r.scale ?? "",
      r.flow ?? "",
      totalScale && r.scale != null ? ((r.scale / totalScale) * 100).toFixed(2) + "%" : "",
    ]);
    download(`${name}-成分ETF-${state.rangeInfo.to || ""}.csv`, toCSV([header, ...data]));
    toast("已导出成分 ETF CSV", "ok");
  });

  document.getElementById("seriesCsv")?.addEventListener("click", () => {
    const dates = state.calendar.slice(state.rangeInfo.fromIdx, state.rangeInfo.toIdx + 1);
    const header = ["日期", `${name}份额(亿份)`];
    const data = (s?.series || []).map((v, i) => [dates[i], v ?? ""]);
    download(`${name}-份额-${state.rangeInfo.from}-${state.rangeInfo.to}.csv`, toCSV([header, ...data]));
    toast("已导出走势 CSV", "ok");
  });
}

function renderEtfTable(rows, totalScale) {
  const tbody = document.querySelector("#tblEtf tbody");
  if (!tbody) return;
  const { key, dir } = etfSort;
  const sorted = rows.slice().sort((a, b) => {
    if (key === "code" || key === "name") return dir * String(a[key] || "").localeCompare(String(b[key] || ""), "zh-CN");
    return dir * ((a[key] ?? -Infinity) - (b[key] ?? -Infinity));
  });
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="state state--sm"><p class="state-desc">该小类暂无成分 ETF 明细</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = sorted
    .map((r) => {
      const share = totalScale && r.scale != null ? (r.scale / totalScale) * 100 : null;
      return `<tr>
        <td class="mono t-2xs">${esc(r.code)}</td>
        <td><span class="truncate" style="max-width:15ch;display:inline-block" title="${esc(r.name)}">${esc(r.name)}</span>
          <span class="chip chip--sm chip--line" style="margin-left:4px">${esc(r.market || "—")}</span></td>
        <td class="num">${esc(cnum(r.shares, 1))}</td>
        <td class="num ${r.delta > 0 ? "up" : r.delta < 0 ? "down" : "flat"}">${esc(fmtSigned(r.delta, 1))}</td>
        <td class="num etf-nav">${r.nav != null ? esc(cnum(r.nav, 3)) : "—"}</td>
        <td class="num">${r.scale != null ? esc(cnum(r.scale, 1)) : "—"}</td>
        <td class="num etf-flow ${r.flow > 0 ? "up" : r.flow < 0 ? "down" : "flat"}">${r.flow != null ? esc(fmtSigned(r.flow, 1)) : "—"}</td>
        <td class="num"><span class="barcell"><span class="barcell-track"><span class="barcell-fill" style="width:${share ? Math.min(100, share * 3).toFixed(1) : 0}%"></span></span><span class="barcell-val">${share != null ? share.toFixed(1) + "%" : "—"}</span></span></td>
      </tr>`;
    })
    .join("");
  document.querySelectorAll("#tblEtf th[data-esort]").forEach((th) => {
    if (th.dataset.esort === key) th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
}

/* ==========================================================================
   全部 86 个小类
   ========================================================================== */
let allHooks = {};
let allCache = null; // 金额口径的补充数据 { name: {first,last,delta,pct} }

export function initAllSubs(app, hooks) {
  allHooks = { app, ...hooks };
  const mask = document.getElementById("allMask");
  document.getElementById("allClose")?.addEventListener("click", () => closeOverlay(mask.querySelector(".modal")));
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
  document.getElementById("allMetric")?.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    state.allMetric = b.dataset.m;
    document.querySelectorAll("#allMetric [data-m]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (state.allMetric === "scale" && !allCache) await prepareScaleData();
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
  renderAllTable();
  if (state.allMetric === "scale" && !allCache) await prepareScaleData();
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
    toast("金额序列加载失败，已回退到份额口径", "error");
    state.allMetric = "shares";
    document.querySelectorAll("#allMetric [data-m]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.m === "shares")));
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
  const isScale = state.allMetric === "scale" && allCache;
  let rows = stats.subs.map((s) => {
    const extra = isScale ? allCache.get(s.name) : null;
    const first = extra ? extra.first : s.first;
    const last = extra ? extra.last : s.last;
    const delta = extra ? extra.delta : s.delta;
    const pct = extra ? extra.pct : s.pct;
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
  const unit = state.allMetric === "scale" ? "亿元" : "亿份";
  if (count) count.textContent = `共 ${rows.length} 个小类 · 单位 ${unit} · ${rangeTextShort()}`;
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
  const unit = state.allMetric === "scale" ? "亿元" : "亿份";
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
  download(`全部小类-${state.rangeInfo.from}-${state.rangeInfo.to}-${state.allMetric}.csv`, toCSV([header, ...data]));
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
      <span>校验口径：把「成分 ETF 份额之和」与交易所披露的同名小类口径对比，容差外记为差异。差异通常来自停牌、净值缺失或成分变更，属正常现象。${
        s.worstSub?.sub ? `本轮偏离最大的小类：${esc(s.worstSub.sub)}（${esc(s.worstSub.note || "")}）。` : ""
      }</span>
    </div>
    <div class="drawer-sec-head"><h3>逐日差异</h3><span class="t-2xs dim">生成于 ${esc((q.generatedAt || "").slice(0, 19).replace("T", " "))}</span></div>
    <div class="table-wrap" style="border:1px solid var(--line);border-radius:var(--r-md)">
      <table class="dt dt--dense" style="table-layout:fixed;width:100%">
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
