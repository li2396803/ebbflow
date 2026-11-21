/* ==========================================================================
   detail：小类明细抽屉 / 全部小类表 / 数据质量弹层
   ========================================================================== */

import { cnum, download, esc, fmtPct, fmtSigned, skeletonRows, toCSV, toneColor, isDark, emptyState } from "./util.js";
import { flowEstimate, catLabelOf } from "./views.js";
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
let etfSort = { key: "scale", dir: -1 };
let drawerHooks = {};

/* ------------------------- 聚焦态内嵌成分表（复用抽屉表） ------------------------- */
const inlineTableState = new Map(); // subName → { key, dir, page }

export function renderInlineEtfTable(app, subName, host) {
  if (!host) return;
  const entry = app.subs?.[subName];
  if (!entry) {
    host.innerHTML = `<div class="state state--sm" style="padding:var(--sp-6) 0">
      <p class="state-title">成分 ETF 明细暂未收录</p>
      <p class="state-desc">当前数据包还没有这个小类的成分明细，补齐后会出现在这里。</p></div>`;
    return;
  }
  const rows = entry.etfs || [];
  if (!rows.length) {
    host.innerHTML = `<div class="state state--sm" style="padding:var(--sp-6) 0"><p class="state-desc">该小类暂无成分 ETF</p></div>`;
    return;
  }
  const st = inlineTableState.get(subName) || { key: "scale", dir: -1, page: 0 };
  inlineTableState.set(subName, st);
  const totalScale = rows.reduce((acc, r) => acc + (r.scale || 0), 0);
  const sorted = sortEtfRows(rows, st);
  const paged = sorted.length > 120;
  const pages = paged ? Math.ceil(sorted.length / 50) : 1;
  st.page = Math.min(st.page, pages - 1);
  const view = paged ? sorted.slice(st.page * 50, st.page * 50 + 50) : sorted;
  const sortHead = (key, label, extra = "", numeric = true) =>
    `<th scope="col" data-isort="${key}" class="${extra}" aria-sort="${
      st.key === key ? (st.dir > 0 ? "ascending" : "descending") : "none"
    }" data-type="${numeric ? "num" : "text"}"><button type="button">${label}<span class="sort-ico"></span></button></th>`;

  host.innerHTML = `
    <div class="etf-inline">
      <div class="etf-inline-head">
        <span class="dim t-2xs">${rows.length} 只 · 按${st.key === "scale" ? "规模" : "所选列"}${st.dir > 0 ? "升序" : "降序"}${
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
            ${sortHead("shares", "最新份额", "num")}
            ${sortHead("delta", "区间变化", "num")}
            ${sortHead("price", "收盘价", "num col-price")}
            ${sortHead("premium", "折溢价", "num")}
            ${sortHead("amount", "成交额", "num")}
            ${sortHead("nav", "净值", "num etf-nav")}
            ${sortHead("scale", "规模", "num")}
            ${sortHead("flow", "份额净申购", "num etf-flow")}
            <th scope="col" class="num">占本类</th>
          </tr></thead>
          <tbody>${view.map((r) => etfRowHTML(r, totalScale, app)).join("")}</tbody>
        </table>
      </div>
    </div>`;

  host.onclick = (e) => {
    const th = e.target.closest("th[data-isort]");
    if (th) {
      const key = th.dataset.isort;
      const numeric = th.dataset.type !== "text";
      st.dir = st.key === key ? -st.dir : numeric ? -1 : 1;
      st.key = key;
      st.page = 0;
      renderInlineEtfTable(app, subName, host);
      return;
    }
    const page = e.target.closest("[data-ipage]");
    if (page) {
      st.page = Math.max(0, Math.min(pages - 1, st.page + Number(page.dataset.ipage)));
      renderInlineEtfTable(app, subName, host);
      return;
    }
    if (e.target.closest("[data-icsv]")) {
      const csv = toCSV([
        ["代码", "名称", "市场", "最新份额(亿份)", "区间变化(亿份)", "收盘价", "折溢价(%)", "成交额(亿元)", "换手率(%)", "净值", "规模(亿元)", "份额净申购(亿元)", "占本类(%)"],
        ...sorted.map((r) => [
          r.code,
          r.name,
          r.market || "",
          r.shares ?? "",
          r.delta ?? "",
          r.price ?? "",
          r.premium ?? "",
          r.amount ?? "",
          r.turnover ?? "",
          r.nav ?? "",
          r.scale ?? "",
          r.flow ?? "",
          totalScale && r.scale != null ? ((r.scale / totalScale) * 100).toFixed(2) : "",
        ]),
      ]);
      download(`${subName}-成分ETF-${state.rangeInfo.from}-${state.rangeInfo.to}.csv`, csv, "text/csv;charset=utf-8");
    }
  };
}

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

export async function openDetail(name) {
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
        <div><dt>区间份额净申购${app.chartData?.has(s?.cat || entry?.cat) ? "" : "（估算）"}</dt><dd class="num ${flow > 0 ? "up" : flow < 0 ? "down" : "flat"}">${esc(fmtSigned(flow, 1))}<span class="unit">亿元</span></dd></div>
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
              <th scope="col" data-esort="delta" class="num" aria-sort="none"><button type="button">区间变化<span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="price" class="num col-price" aria-sort="none"><button type="button">收盘价<span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="premium" class="num" aria-sort="none"><button type="button">折溢价<span class="sort-ico"></span></button><span class="th-info" tabindex="0" role="note" title="折溢价 =（收盘价 − 单位净值）/ 单位净值；>0 溢价、<0 折价" aria-label="折溢价 =（收盘价 − 单位净值）/ 单位净值">i</span></th>
              <th scope="col" data-esort="amount" class="num" aria-sort="none"><button type="button">成交额<span class="sort-ico"></span></button><span class="th-info" tabindex="0" role="note" title="成交额（亿元），鼠标悬停单元格可看换手率（成交额 / 规模）" aria-label="成交额（亿元），悬停可看换手率">i</span></th>
              <th scope="col" data-esort="nav" class="num etf-nav" aria-sort="none"><button type="button">净值<span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="scale" class="num" aria-sort="descending"><button type="button">规模<span class="sort-ico"></span></button></th>
              <th scope="col" data-esort="flow" class="num etf-flow" aria-sort="none"><button type="button">份额净申购<span class="sort-ico"></span></button><span class="th-info" tabindex="0" role="note" title="份额拆分/合并已从份额净申购中剔除" aria-label="份额拆分/合并已从份额净申购中剔除">i</span></th>
              <th scope="col" class="num">占本类</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="t-2xs faint">「近期变化 / 份额净申购」沿用数据管线的近一周窗口口径；「份额 / 规模 / 净值」为最新交易日快照。份额净申购按当日净值折算，部分已退市成分无净值时不计入（见上方净值覆盖）；份额拆分/合并已从份额净申购中剔除。</p>
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
    const header = ["代码", "名称", "市场", "份额(亿份)", "区间变化(亿份)", "收盘价(元)", "折溢价(%)", "成交额(亿元)", "换手率(%)", "净值(元)", "规模(亿元)", "份额净申购(亿元)", "占本类规模"];
    const data = rows.map((r) => [
      r.code,
      r.name,
      r.market || "",
      r.shares ?? "",
      r.delta ?? "",
      r.price ?? "",
      r.premium ?? "",
      r.amount ?? "",
      r.turnover ?? "",
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

/** 只有区间统计、没有成分 ETF 明细（数据管线尚未产出该小类的 subs 条目） */
function renderMissingDetail(app, name, s) {
  const body = document.getElementById("drawerBody");
  if (!body) return;
  const rank = s ? rankOf(app.stats, name, "pct") : null;
  const flow = s ? (app.flowOf ? app.flowOf(name, s) : flowEstimate(s)) : 0;
  body.innerHTML = `
    <section class="drawer-sec">
      <div class="drawer-sec-head">
        <h3>区间表现</h3>
        ${s ? `<span class="chip ${s.pct > 0 ? "chip--up" : s.pct < 0 ? "chip--down" : "chip--flat"}">${rank ? `排名 ${rank.rank}/${rank.total}` : "无排名"}</span>` : ""}
      </div>
      ${
        s
          ? `<dl class="kpi-mini">
              <div><dt>最新份额</dt><dd class="num">${esc(cnum(s.last, 1))}<span class="unit">亿份</span></dd></div>
              <div><dt>规模（估算）</dt><dd class="num">${s.scale != null ? esc(cnum(s.scale, 1)) : "—"}<span class="unit">亿元</span></dd></div>
              <div><dt>区间变化</dt><dd class="num ${s.pct > 0 ? "up" : s.pct < 0 ? "down" : "flat"}">${esc(fmtPct(s.pct, 2))}</dd></div>
              <div><dt>区间份额净申购</dt><dd class="num ${flow > 0 ? "up" : flow < 0 ? "down" : "flat"}">${esc(fmtSigned(flow, 1))}<span class="unit">亿元</span></dd></div>
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
  const share = totalScale && r.scale != null ? (r.scale / totalScale) * 100 : null;
  const prem = r.premium;
  const premCls = prem == null ? "flat" : prem > 0.3 ? "up" : prem < -0.3 ? "down" : "flat";
  const premStrong = prem != null && Math.abs(prem) > 2 ? " is-strong" : "";
  const turnover = r.turnover == null ? "" : `换手率 ${cnum(r.turnover, 2)}%`;
  return `<tr>
    <td class="mono t-2xs">${esc(r.code)}</td>
    <td class="etf-name-cell">
      <span class="truncate" style="max-width:15ch;display:inline-block" title="${esc(r.name)}">${esc(r.name)}</span>
      <span class="chip chip--sm chip--line" style="margin-left:4px">${esc(r.market || "—")}</span>
      ${renderTags(r.tags, app?.meta?.tagDims)}
    </td>
    <td class="num">${esc(cnum(r.shares, 1))}</td>
    <td class="num ${r.delta > 0 ? "up" : r.delta < 0 ? "down" : "flat"}">${esc(fmtSigned(r.delta, 1))}</td>
    <td class="num col-price">${r.price != null ? esc(cnum(r.price, 3)) : "—"}</td>
    <td class="num ${premCls}${premStrong}" title="（收盘价 − 单位净值）/ 单位净值${prem != null ? ` = ${prem.toFixed(2)}%` : ""}">${prem != null ? esc(fmtSigned(prem, 2)) + "%" : "—"}</td>
    <td class="num" title="${esc(turnover)}">${r.amount != null ? esc(cnum(r.amount, 1)) : "—"}</td>
    <td class="num etf-nav">${r.nav != null ? esc(cnum(r.nav, 3)) : "—"}</td>
    <td class="num">${r.scale != null ? esc(cnum(r.scale, 1)) : "—"}</td>
    <td class="num etf-flow ${r.flow > 0 ? "up" : r.flow < 0 ? "down" : "flat"}">${r.flow != null ? esc(fmtSigned(r.flow, 1)) : "—"}</td>
    <td class="num"><span class="barcell"><span class="barcell-track"><span class="barcell-fill" style="width:${share ? Math.min(100, share * 3).toFixed(1) : 0}%"></span></span><span class="barcell-val">${share != null ? share.toFixed(1) + "%" : "—"}</span></span></td>
  </tr>`;
}
export function sortEtfRows(rows, { key, dir }) {
  return rows.slice().sort((a, b) => {
    if (key === "code" || key === "name") return dir * String(a[key] || "").localeCompare(String(b[key] || ""), "zh-CN");
    return dir * ((a[key] ?? -Infinity) - (b[key] ?? -Infinity));
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
    tbody.innerHTML = `<tr><td colspan="11"><div class="state state--sm"><p class="state-desc">该小类暂无成分 ETF 明细</p></div></td></tr>`;
    return;
  }
  const app = drawerHooks.app;
  tbody.innerHTML = sorted.map((r) => etfRowHTML(r, totalScale, app)).join("");
  document.querySelectorAll("#tblEtf th[data-esort]").forEach((th) => {
    if (th.dataset.esort === key) th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
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
    "份额(亿份)", "规模(亿元)", "折溢价(%)", "成交额(亿元)", "换手率(%)", "上市日",
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
        e.shares ?? "",
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
