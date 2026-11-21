/* ==========================================================================
   views：总览 / 大类 / 自选 三个主视图的渲染
   --------------------------------------------------------------------------
   所有数字都来自「当前区间」派生（state.range + stats），
   因此图表缩放/框选、预设区间、表格筛选看到的是同一份口径。
   ========================================================================== */

import { big, cnum, dirCn, esc, fmtPct, fmtSigned, skeletonRows, sparkSVG, toneColor, isDark } from "./util.js";
import { PRESETS, METRICS, rankOf, state } from "./state.js";
import { marketRangeStats } from "./state.js";

/* ------------------------------ 共享小件 ------------------------------ */

export const catLabelOf = (app, key) => app?.catMap?.get(key)?.label || key || "";

const chipDir = (v, text, cls = "") =>
  `<span class="chip ${v > 0 ? "chip--up" : v < 0 ? "chip--down" : "chip--flat"} ${cls}">${esc(text)}</span>`;

const catColorOf = (app, key) => app?.catMap?.get(key)?.color || "#6B7280";

/** 债券类：份额是「面值 100 元」口径，不能和股票 ETF（1 元）直接比较 → 展示规模优先 */
const isBondCat = (key = "", label = "") => /bond|债券/i.test(`${key} ${label}`);

/** 用已加载的 charts 现算某个大类的「规模」区间序列（债券卡片/要点用） */
export function catScaleStats(app, key) {
  const payload = app?.getChart ? app.getChart(key) : null;
  const dates = payload?.dates;
  if (!dates?.length) return null;
  const names = new Set(app.subsByCat?.get(key) || []);
  const subs = (payload.series || []).filter((s) => names.has(s.name) && (s.scale || []).some((v) => v != null));
  if (!subs.length) return null;
  const a = idxInDates(dates, state.rangeInfo.from);
  const b = idxInDates(dates, state.rangeInfo.to);
  const n = Math.max(0, b - a + 1);
  if (!n) return null;
  const series = new Array(n).fill(null);
  for (const s of subs) {
    for (let i = 0; i < n; i++) {
      const v = s.scale[a + i];
      if (v == null) continue;
      series[i] = (series[i] || 0) + v;
    }
  }
  const first = series.find((v) => v != null);
  let last = null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) {
      last = series[i];
      break;
    }
  }
  if (first == null || last == null) return null;
  const delta = last - first;
  return { first, last, delta, pct: first ? (delta / Math.abs(first)) * 100 : null, series };
}

function idxInDates(dates, d) {
  const i = dates.indexOf(d);
  if (i >= 0) return i;
  let lo = 0;
  for (let k = 0; k < dates.length; k++) if (dates[k] <= d) lo = k;
  return lo;
}

function kpiDelta(v, pct, unitText = "") {
  const sign = v > 0 ? "+" : "";
  return `${chipDir(v, `${sign}${cnum(v, 1)}${unitText}`)}<span class="delta ${v > 0 ? "delta--up" : v < 0 ? "delta--down" : "delta--flat"}">${fmtPct(
    pct,
    2
  )}</span>`;
}

/* ============================ 左侧导航 ============================ */

export function renderCatNav(app) {
  const host = document.getElementById("catNav");
  if (!host) return;
  const cats = app.cats || [];
  const stats = app.stats;
  if (!cats.length) return;
  const activeCat = state.view === "cat" ? state.cat : null;
  const activeSub = state.sub;

  host.innerHTML = cats
    .map((c) => {
      const s = stats?.byCat?.get(c.key);
      const pct = s?.pct;
      const isActive = activeCat === c.key;
      const open = isActive ? "1" : "0";
      const subs = (app.subsByCat?.get(c.key) || []).slice();
      return `<div class="cat-nav ${isActive ? "is-active" : ""}" data-open="${open}" data-catgroup="${esc(c.key)}">
        <button class="cat-btn" type="button" data-cat-toggle="${esc(c.key)}" aria-expanded="${open === "1"}" aria-controls="cat-sub-${esc(c.key)}">
          <span class="cat-dot" style="--cat-color:${esc(c.color)}"></span>
          <span class="cat-name">${esc(c.label)}</span>
          <span class="cat-pct ${pct > 0 ? "up" : pct < 0 ? "down" : "flat"}">${pct == null ? "—" : fmtPct(pct, 1)}</span>
          <span class="cat-caret" aria-hidden="true"><svg><use href="#i-chevron-right"/></svg></span>
        </button>
        <div class="cat-subs" id="cat-sub-${esc(c.key)}">
          <div>
            <div class="cat-sublist">
              ${subs
                .map(
                  (name) => `<button class="sub-link ${name === activeSub ? "is-active" : ""}" type="button" data-navsub="${esc(
                    name
                  )}" data-sub="${esc(name)}" data-cat="${esc(c.key)}">
                    <span class="sl-name">${esc(name)}</span>
                    <span class="sl-val">${esc(fmtPct(stats?.byName?.get(name)?.pct, 1))}</span>
                  </button>`
                )
                .join("")}
            </div>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

export function syncNavActive(app) {
  document.querySelectorAll("[data-nav]").forEach((n) => {
    const v = n.dataset.nav;
    const active = v === state.view;
    n.classList.toggle("is-active", active);
    if (n.classList.contains("nav-item")) {
      if (active) n.setAttribute("aria-current", "page");
      else n.removeAttribute("aria-current");
    }
  });
  document.querySelectorAll(".tabbar-item[data-nav]").forEach((n) => {
    if (n.dataset.nav === state.view) n.setAttribute("aria-current", "page");
    else n.removeAttribute("aria-current");
  });
  document.querySelectorAll(".cat-nav").forEach((n) => {
    n.classList.toggle("is-active", n.dataset.catgroup === state.cat && state.view === "cat");
  });
  document.querySelectorAll(".sub-link").forEach((n) => {
    n.classList.toggle("is-active", n.dataset.sub === state.sub);
  });
  const wc = document.getElementById("watchCount");
  const tb = document.getElementById("tabWatchBadge");
  if (wc) {
    wc.textContent = String(state.watch.length);
    wc.hidden = state.watch.length === 0;
  }
  if (tb) {
    tb.textContent = String(state.watch.length);
    tb.hidden = state.watch.length === 0;
  }
}

/* ============================ 区间控件 ============================ */

export function renderRangeSegs() {
  const html = PRESETS.map(
    (p) =>
      `<button class="seg-btn" type="button" data-preset="${p.id}" data-preset-label="${p.label}" aria-pressed="${
        !state.custom && state.preset === p.id
      }"><span class="lbl-long">${p.label}</span><span class="lbl-short">${p.short || p.label}</span></button>`
  ).join("");
  for (const id of ["ovRanges", "chartRanges", "watchRanges"]) {
    const host = document.getElementById(id);
    if (host) host.innerHTML = html;
  }
  renderMetricSegs();
}

export function renderMetricSegs(focusMode = false) {
  const host = document.getElementById("chartMetrics");
  if (host) {
    host.innerHTML = METRICS.map((m) => {
      const primary = state.metric === m.id;
      const overlaid = focusMode && state.overlay.includes(m.id);
      const cls = ["seg-btn"];
      if (primary) cls.push("is-primary");
      if (overlaid) cls.push("is-overlay");
      const title = focusMode
        ? primary
          ? "主指标（决定左轴单位）；再点一次循环切换到下一个指标"
          : overlaid
            ? "再点一次取消叠加"
            : "点击叠加这个指标"
        : "";
      return `<button class="${cls.join(" ")}" type="button" data-metric="${m.id}" aria-pressed="${
        primary || overlaid
      }" ${title ? `title="${esc(title)}"` : ""}><span class="seg-mark" aria-hidden="true"></span>${m.label}</button>`;
    }).join("");
  }
  const norm = document.getElementById("chartNorm");
  if (norm) norm.hidden = state.metric !== "pct";
  norm?.querySelectorAll("[data-norm]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.norm === state.norm)));
}

/* ============================ 区间摘要 ============================ */

export function rangeText(app) {
  const r = state.rangeInfo || { from: "—", to: "—", days: 0 };
  return `${r.from} → ${r.to} · ${r.days} 个交易日`;
}

/* ============================ 总览 ============================ */

export function renderOverview(app) {
  const r = state.rangeInfo;
  const stats = app.stats;
  const meta = app.meta || {};
  const host = document.getElementById("ovSub");
  if (host) {
    host.innerHTML = [
      `<span class="vh-optional">${esc(meta.title || "ETF 细分行业资金流向")}</span>`,
      `<span class="chip chip--line">数据截至 ${esc(meta.lastTradeDate || "—")}</span>`,
      `<span class="chip chip--line">${esc(rangeText(app))}</span>`,
      meta.counts ? `<span class="chip chip--line vh-optional">${meta.counts.subs} 小类 / ${meta.counts.etfs} 只 ETF</span>` : "",
    ]
      .filter(Boolean)
      .join("");
  }

  renderOverviewKpis(app);
  renderMarketBlock(app);
  renderCatGrid(app);
  renderTopTables(app);
  renderOverviewWatch(app);
}

function totalSeries(app) {
  const r = state.rangeInfo;
  const mkt = app.market;
  if (mkt?.total?.shares?.length) {
    const slice = (arr) => (Array.isArray(arr) ? arr.slice(r.fromIdx, r.toIdx + 1) : []);
    return { shares: slice(mkt.total.shares), scale: slice(mkt.total.scale), fromMarket: true };
  }
  // 兜底：用各大类份额序列相加
  const n = Math.max(0, r.toIdx - r.fromIdx + 1);
  const shares = new Array(n).fill(0);
  for (const c of app.stats?.cats || []) {
    for (let i = 0; i < n; i++) shares[i] += c.series[i] || 0;
  }
  return { shares, scale: null, fromMarket: false };
}

function renderOverviewKpis(app) {
  const host = document.getElementById("ovKpis");
  if (!host) return;
  const ready = !!app.subsReady;
  const r = state.rangeInfo;
  const stats = app.stats;
  const t = totalSeries(app);
  const pick = (arr) => {
    if (!arr?.length) return { first: null, last: null, delta: null, pct: null };
    const first = arr.find((v) => v != null && Number.isFinite(+v));
    let last = null;
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && Number.isFinite(+arr[i])) { last = +arr[i]; break; }
    if (first == null || last == null) return { first: null, last: null, delta: null, pct: null };
    const delta = last - +first;
    return { first: +first, last, delta, pct: +first ? (delta / Math.abs(+first)) * 100 : null };
  };
  const sh = pick(t.shares);
  const sc = pick(t.scale);
  const flowOne = (x) => (app.flowOf ? app.flowOf(x.name, x) : flowEstimate(x));
  const flowEst = (stats?.subs || []).reduce((s, x) => s + flowOne(x), 0);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const up = getComputedStyle(document.documentElement).getPropertyValue("--up").trim();
  const down = getComputedStyle(document.documentElement).getPropertyValue("--down").trim();

  const pending = `<span class="dim">数据加载中…</span>`;
  const card = (label, num, unit, foot, spark, color, info) => `<div class="kpi">
      <div class="kpi-top"><span class="kpi-label"><span class="kpi-dot" style="background:${color}"></span>${esc(label)}${
        info ? `<span class="th-info" tabindex="0" role="note" title="${esc(info)}" aria-label="${esc(info)}">i</span>` : ""
      }</span></div>
      <div class="kpi-val num">${esc(num)}<span class="unit">${esc(unit)}</span></div>
      <div class="kpi-foot">${foot}</div>
      ${spark ? `<div class="kpi-spark">${spark}</div>` : ""}
    </div>`;

  const fmtBig = (v, unit) => {
    if (v == null) return { num: "—", unit: "" };
    return big(v, unit);
  };
  const b1 = fmtBig(sc.last, "亿元");
  const bSh = fmtBig(sh.last, "亿份");
  const catFlows = (app.stats?.cats || []).map((c) => ({
    key: c.key,
    flow: app.catFlowOf ? app.catFlowOf(c.key) : (app.subsByCat?.get(c.key) || []).reduce((acc, n) => acc + flowOne(app.stats?.byName?.get(n)), 0),
  }));
  const catIn = catFlows.filter((c) => c.flow > 0).length;
  const catFlowSum = catFlows.reduce((acc, c) => acc + c.flow, 0);
  const cumulativeScale = [];
  if (t.scale?.length) {
    const base = t.scale.find((v) => v != null) ?? 0;
    for (const v of t.scale) cumulativeScale.push(v == null ? null : v - base);
  }

  host.innerHTML = [
    card(
      "全市场规模",
      b1.num,
      b1.unit,
      `<span class="dim">份额 ${esc(bSh.num)} ${esc(bSh.unit)}</span>
       <span class="chip chip--line chip--sm" title="份额（份数）跨资产不可直接相加：债券 ETF 面值 100 元、股票 ETF 约 1 元，加总没有经济含义；规模（亿元）才是可比口径">份数不可直接相加</span>`,
      t.scale ? sparkSVG(t.scale, { w: 160, h: 44, color: accent, area: true }) : "",
      "var(--accent)"
    ),
    card(
      "区间规模变化",
      sc.delta != null ? fmtSigned(Math.abs(sc.delta) >= 10000 ? sc.delta / 10000 : sc.delta, Math.abs(sc.delta) >= 10000 ? 2 : 1) : "—",
      sc.delta != null && Math.abs(sc.delta) >= 10000 ? "万亿元" : "亿元",
      !ready
        ? pending
        : sc.pct != null
          ? `<span class="delta ${sc.delta > 0 ? "delta--up" : sc.delta < 0 ? "delta--down" : "delta--flat"}">${fmtPct(sc.pct, 2)}</span><span class="dim">相对区间起点 · ${r.days} 个交易日</span>`
          : `<span class="dim">暂无区间数据</span>`,
      cumulativeScale.length ? sparkSVG(cumulativeScale, { w: 160, h: 44, color: sc.delta >= 0 ? up : down, area: true }) : "",
      sc.delta >= 0 ? "var(--up)" : "var(--down)"
    ),
    card(
      !ready ? "区间份额净申购" : app.flowComplete ? "区间份额净申购" : "区间份额净申购（估算）",
      ready ? fmtSigned(flowEst, 1) : "—",
      "亿元",
      !ready
        ? pending
        : app.flowComplete
          ? `<span class="dim">逐日份额净申购累加</span><span class="chip chip--line chip--sm" title="口径：按当日单位净值折算的每日份额净申购逐日累加；份额拆分/合并已剔除">口径</span>`
          : `<span class="dim">Δ份额 × 最新净值近似</span><span class="chip chip--line chip--sm" title="口径：区间份额变化量 × 最新单位净值（近似）；全量图表加载完成后会自动切换为每日份额净申购求和">估算</span>`,
      "",
      "var(--ink-3)",
      "份额净申购＝成分 ETF 份额变动×净值（估算）。ETF 在二级市场买卖不改变份额，只有一级申购赎回才改变，因此该指标反映的是一级申赎，不等于二级成交额。"
    ),
    card(
      "大类分化",
      ready && app.cats.length ? `${catIn}/${app.cats.length}` : "—",
      "类份额净申购",
      ready
        ? `<span class="dim">份额净申购合计</span><span class="delta ${catFlowSum > 0 ? "delta--up" : catFlowSum < 0 ? "delta--down" : "delta--flat"}">${esc(fmtSigned(catFlowSum, 1))} 亿元</span>`
        : pending,
      "",
      "var(--ink-3)"
    ),
  ].join("");
}

/** 区间份额净申购估算：Δ份额 × 最新单位净值（scale/shares 得到加权净值） */
export function flowEstimate(subStat) {
  if (!subStat) return 0;
  const nav = subStat.scale != null && subStat.last ? subStat.scale / subStat.last : null;
  if (!nav || !Number.isFinite(nav)) return subStat.flow || 0;
  return subStat.delta * nav;
}

function renderMarketBlock(app) {
  const loading = document.getElementById("mktLoading");
  const mkt = app.market;
  const legend = document.getElementById("mktLegend");
  const seg = document.getElementById("mktMetric");
  if (seg) {
    seg.querySelectorAll("[data-m]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.m === state.marketMetric)));
  }
  if (!mkt) {
    if (loading) loading.hidden = true;
    const host = document.getElementById("mktWrap");
    if (host && !host.querySelector(".chart-empty")) {
      // 用覆盖层而不是替换 innerHTML：保留 canvas，切回有数据的口径时可直接复用实例
      const div = document.createElement("div");
      div.className = "chart-empty";
      div.innerHTML = `<div class="state"><div class="state-ico" aria-hidden="true"><svg width="18" height="18"><use href="#i-chart"/></svg></div>
        <p class="state-title">市场总览数据未提供</p>
        <p class="state-desc">当前数据包没有 market.json（全市场沪深拆分）。其余功能不受影响，可与数据管线确认后再试。</p></div>`;
      host.append(div);
    }
    if (legend) legend.hidden = true;
    document.getElementById("typeBars")?.replaceChildren();
    const te = document.getElementById("typeEmpty");
    if (te) te.hidden = false;
    return;
  }
  document.getElementById("mktWrap")?.querySelector(".chart-empty")?.remove();
  if (legend) legend.hidden = false;
  const ms = marketRangeStats(mkt, state.rangeInfo);
  if (!ms) return;
  const key = state.marketMetric === "scale" ? "scale" : "shares";
  const picks = ms[key];
  const unit = key === "scale" ? mkt.unit?.scale || "亿元" : mkt.unit?.shares || "亿份";
  app.onMarketRender?.({
    dates: ms.dates,
    sh: ms.sh[key],
    sz: ms.sz[key],
    total: picks.series,
    unit,
  });
  const sub = document.getElementById("mktSub");
  if (sub) {
    const etfs = mkt.total?.etfs ? `全市场 ${mkt.total.etfs} 只 ETF` : "";
    sub.textContent = [key === "scale" ? "规模" : "份额", etfs, mkt.asOf ? `截至 ${mkt.asOf}` : ""].filter(Boolean).join(" · ");
  }
  const note = document.getElementById("mktNote");
  if (note) {
    const szLast = ms.sz[key]?.at?.(-1);
    const stale = key === "scale" && (!szLast || szLast === 0);
    note.innerHTML = `${mkt.note ? esc(mkt.note) : ""}${
      stale ? `<span class="chip chip--warn" style="margin-left:8px">深市规模待补齐</span>` : ""
    }`;
  }
  renderTypeBars(app, mkt);
}

function renderTypeBars(app, mkt) {
  const host = document.getElementById("typeBars");
  const empty = document.getElementById("typeEmpty");
  if (!host) return;
  const list = Array.isArray(mkt.byType) ? mkt.byType.slice() : [];
  if (!list.length) {
    host.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  const key = state.marketMetric === "scale" ? "scale" : "shares";
  const total = list.reduce((s, x) => s + (x[key] || 0), 0) || 1;
  const sorted = list.sort((a, b) => (b[key] || 0) - (a[key] || 0));
  host.innerHTML = sorted
    .map((x, i) => {
      const v = x[key] || 0;
      const pct = (v / total) * 100;
      return `<div class="typebar-row" title="${esc(x.type)}：${cnum(v, 1)}（${pct.toFixed(1)}%），${x.etfs || "—"} 只 ETF">
        <span class="typebar-name">${esc(x.type)}</span>
        <span class="typebar-track"><span class="typebar-fill" style="width:${Math.max(2, pct).toFixed(1)}%;opacity:${(0.92 - i * 0.1).toFixed(2)}"></span></span>
        <span class="typebar-val">${pct.toFixed(1)}%</span>
      </div>`;
    })
    .join("");
}

function renderCatGrid(app) {
  const host = document.getElementById("catGrid");
  if (!host) return;
  const stats = app.stats;
  if (!app.subsReady) {
    host.innerHTML = (app.cats || [])
      .map(
        (c) => `<div class="catcard" aria-hidden="true" style="--cat-color:${esc(c.color || "#888")}">
          <span class="catcard-top">
            <span class="cat-dot" style="background:${esc(c.color || "#888")}"></span>
            <span class="catcard-name">${esc(c.label)}</span>
            <span class="catcard-count">${c.subs ?? "—"} 小类</span>
          </span>
          <span class="catcard-mid"><span class="sk" style="width:72px;height:20px"></span><span class="sk" style="width:64px;height:18px"></span></span>
          <span class="sk" style="height:26px;margin-top:2px"></span>
          <span class="catcard-foot"><span class="sk sk-line" style="width:60px"></span><span class="sk sk-line" style="width:28px"></span></span>
        </div>`
      )
      .join("");
    return;
  }
  host.innerHTML = (app.cats || [])
    .map((c) => {
      const bond = isBondCat(c.key, c.label);
      let s = stats?.byCat?.get(c.key);
      const scaleSum = (app.subsByCat?.get(c.key) || []).reduce((acc, name) => acc + (stats?.byName?.get(name)?.scale || 0), 0);
      let bondScale = null;
      if (bond) {
        bondScale = catScaleStats(app, c.key);
        if (bondScale) s = { ...s, pct: bondScale.pct, delta: bondScale.delta, series: bondScale.series, count: s?.count ?? 0 };
      }
      const pct = s?.pct;
      const unit = bond ? "亿元" : "亿份";
      const color = toneColor(c.color, isDark());
      return `<button class="catcard" type="button" data-cat="${esc(c.key)}" style="--cat-color:${esc(c.color)}" aria-label="${esc(
        c.label
      )}：区间变化 ${fmtPct(pct, 2)}">
        <span class="catcard-top">
          <span class="cat-dot" style="background:${esc(color)}"></span>
          <span class="catcard-name">${esc(c.label)}</span>
          <span class="catcard-count" ${c.subs && s?.count != null && s.count !== c.subs ? `title="口径 ${c.subs} 个小类，当前有区间数据 ${s.count} 个"` : ""}>${
            c.subs && s?.count != null && s.count !== c.subs ? `${s.count}/${c.subs}` : (s?.count ?? c.subs ?? "—")
          } 小类</span>
        </span>
        <span class="catcard-mid">
          <span class="catcard-val">${fmtPct(pct, 2)}</span>
          <span class="chip ${(s?.delta || 0) > 0 ? "chip--up" : (s?.delta || 0) < 0 ? "chip--down" : "chip--flat"}">${esc(
        fmtSigned(s?.delta, 1)
      )} ${unit}</span>
        </span>
        <span class="catcard-spark" aria-hidden="true">${
          s ? sparkSVG(s.series, { w: 220, h: 26, color, area: true, stroke: 1.4 }) : ""
        }</span>
        <span class="catcard-foot">
          ${
            bond
              ? `<span>规模口径 ${bondScale ? cnum(bondScale.last, 0) + " 亿" : scaleSum ? cnum(scaleSum, 0) + " 亿" : "—"}</span><span class="chip chip--line chip--sm" title="债券 ETF 份额为面值 100 元口径，跨资产相加无意义，本卡按规模展示">面值口径</span>`
              : `<span>规模 ${scaleSum ? cnum(scaleSum, 0) + " 亿" : "—"}</span><span>${esc(dirCn(s?.delta))}</span>`
          }
        </span>
      </button>`;
    })
    .join("");
}

function topRows(app, dir, n = 8) {
  const subs = (app.stats?.subs || []).filter((s) => Number.isFinite(s.delta));
  const sorted = subs.slice().sort((a, b) => (dir === "in" ? b.delta - a.delta : a.delta - b.delta));
  const base = dir === "in" ? sorted.slice(0, n) : sorted.slice(-n);
  const sort = state.topSort[dir] || { key: "delta", dir: dir === "in" ? -1 : 1 };
  const list = base.slice().sort((a, b) => {
    if (sort.key === "name") return sort.dir * String(a.name).localeCompare(String(b.name), "zh-CN");
    return sort.dir * ((a[sort.key] ?? -Infinity) - (b[sort.key] ?? -Infinity));
  });
  return list;
}

function renderTopTables(app) {
  for (const [id, dir] of [["tblTopIn", "in"], ["tblTopOut", "out"]]) {
    const tbl = document.getElementById(id);
    if (!tbl) continue;
    const tbody = tbl.querySelector("tbody");
    if (!app.subsReady) {
      tbody.innerHTML = skeletonRows(5, 8);
      continue;
    }
    const rows = topRows(app, dir, 8);
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="state state--sm"><p class="state-desc">当前区间没有可比较的数据</p></div></td></tr>`;
      continue;
    }
    const sort = state.topSort[dir] || { key: "delta", dir: dir === "in" ? -1 : 1 };
    tbl.querySelectorAll("thead th[data-sort-key]").forEach((th) => {
      if (th.dataset.sortKey === sort.key) th.setAttribute("aria-sort", sort.dir > 0 ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
    tbody.innerHTML = rows
      .map((s, i) => {
        const c = toneColor(app.subsByCat ? catColorOf(app, s.cat) : "#888", isDark());
        return `<tr data-sub="${esc(s.name)}" data-cat="${esc(s.cat)}" tabindex="0">
        <td>${i + 1}</td>
        <td><span class="cell-name"><span class="cat-dot" style="background:${esc(c)}"></span>${esc(s.name)}</span></td>
        <td class="num ${s.delta > 0 ? "up" : s.delta < 0 ? "down" : "flat"}">${esc(fmtSigned(s.delta, 1))}</td>
        <td class="num ${s.pct > 0 ? "up" : s.pct < 0 ? "down" : "flat"}">${esc(fmtPct(s.pct, 2))}</td>
        <td class="num" aria-hidden="true">${sparkSVG(s.series, { w: 76, h: 22, color: s.delta >= 0 ? "var(--up)" : "var(--down)", stroke: 1.3 })}</td>
      </tr>`;
      })
      .join("");
  }
  const sub = document.getElementById("topInSub");
  if (sub) sub.textContent = `${rangeText(app)} · 按份额差排序`;
  const sub2 = document.getElementById("topOutSub");
  if (sub2) sub2.textContent = `负值为净赎回 · ${rangeText(app)}`;
}

export function renderOverviewWatch(app) {
  const card = document.getElementById("ovWatchCard");
  const grid = document.getElementById("ovWatchGrid");
  if (!card || !grid) return;
  const names = state.watch.filter((n) => !app.subs || app.subs[n]);
  if (!names.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  if (!app.subsReady) {
    grid.innerHTML = state.watch
      .slice(0, 3)
      .map(
        () => `<div class="watchcard" aria-hidden="true">
        <div class="watchcard-head"><div class="watchcard-title"><span class="sk sk-line" style="width:80px"></span></div></div>
        <div class="sk" style="height:22px;width:110px"></div>
        <div class="sk" style="height:40px"></div>
      </div>`
      )
      .join("");
    return;
  }
  grid.innerHTML = names.slice(0, 3).map((n) => watchCardHTML(app, n)).join("");
}

/* ============================ 自选 ============================ */

export function watchCardHTML(app, name) {
  const s = app.stats?.byName?.get(name);
  const cat = esc(catLabelOf(app, s?.cat || app.subs?.[name]?.cat));
  const color = toneColor(s?.color || app.subs?.[name]?.color || "#888", isDark());
  const pct = s?.pct;
  return `<article class="watchcard" data-sub="${esc(name)}" data-cat="${esc(s?.cat || app.subs?.[name]?.cat || "")}">
    <div class="watchcard-head">
      <div class="watchcard-title">
        <b>${esc(name)}</b>
        <span>${cat}</span>
      </div>
      <div class="watchcard-actions">
        <button class="star-btn" type="button" data-unwatch="${esc(name)}" aria-pressed="true" aria-label="取消自选 ${esc(name)}" title="取消自选">
          <svg aria-hidden="true"><use href="#i-star"/></svg>
        </button>
      </div>
    </div>
    <div class="watchcard-val">
      <span><b>${esc(cnum(s?.last, 1))}</b><span class="unit dim t-2xs"> 亿份</span></span>
      <span class="delta ${pct > 0 ? "delta--up" : pct < 0 ? "delta--down" : "delta--flat"}">${fmtPct(pct, 2)}</span>
    </div>
    <div class="watchcard-spark" aria-hidden="true">${s ? sparkSVG(s.series, { w: 260, h: 40, color, area: true }) : ""}</div>
    <div class="watchcard-foot">
      <span>规模 ${s?.scale != null ? cnum(s.scale, 0) + " 亿" : "—"}</span>
      <button class="linkbtn" type="button" data-sub="${esc(name)}" data-cat="${esc(s?.cat || "")}">明细 ›</button>
    </div>
  </article>`;
}

export function renderWatch(app) {
  const body = document.getElementById("watchBody");
  const kpis = document.getElementById("watchKpis");
  const sub = document.getElementById("watchSub");
  if (!body) return;
  const watchNames = state.watch.filter((n) => !app.subs || app.subs[n]);
  const missing = state.watch.length - watchNames.length;
  if (sub) {
    sub.textContent = `${watchNames.length} 个小类 · ${rangeText(app)} · 保存在本地浏览器${
      missing > 0 ? ` · 另有 ${missing} 个暂无数据或不在当前分类口径下` : ""
    }`;
  }
  if (watchNames.length && !app.subsReady) {
    if (kpis) kpis.innerHTML = Array.from({ length: 4 }).map(() => `<div class="kpi" aria-hidden="true"><div class="sk sk-line" style="width:70px"></div><div class="sk" style="height:26px;width:110px;margin:8px 0"></div><div class="sk sk-line" style="width:120px"></div></div>`).join("");
    body.innerHTML = `<div class="watchgrid">${state.watch
      .map(
        () => `<div class="watchcard" aria-hidden="true"><div class="watchcard-head"><div class="watchcard-title"><span class="sk sk-line" style="width:90px"></span></div></div><div class="sk" style="height:22px;width:110px"></div><div class="sk" style="height:40px"></div><div class="sk sk-line" style="width:70%"></div></div>`
      )
      .join("")}</div>`;
    return;
  }
  if (!watchNames.length) {
    if (kpis) kpis.innerHTML = "";
    body.innerHTML = `<div class="card"><div class="card-body">
      <div class="state" style="padding:var(--sp-9) var(--sp-5)">
        <div class="state-ico" aria-hidden="true"><svg width="20" height="20"><use href="#i-star-line"/></svg></div>
        <p class="state-title">还没有自选</p>
        <p class="state-desc">在任意小类（左侧导航、表格行、搜索面板或详情抽屉）点击 ☆ 就能把它加入自选。自选只保存在本机浏览器，不上传任何数据。</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px">
          <button class="btn btn--primary btn--sm" type="button" data-nav="overview">去总览挑几个</button>
          <button class="btn btn--sm" type="button" id="watchEmptySearch">搜索小类</button>
        </div>
      </div>
    </div></div>`;
    return;
  }
  const stats = watchNames.map((n) => app.stats?.byName?.get(n)).filter(Boolean);
  const sumShares = stats.reduce((s, x) => s + (x.last || 0), 0);
  const sumScale = stats.reduce((s, x) => s + (x.scale || 0), 0);
  const flow = stats.reduce((s, x) => s + (app.flowOf ? app.flowOf(x.name, x) : flowEstimate(x)), 0);
  const avgPct = stats.length ? stats.reduce((s, x) => s + (x.pct || 0), 0) / stats.length : null;
  if (kpis) {
    kpis.innerHTML = [
      kpiCard("自选数量", String(state.watch.length), "个", `<span class="dim">已覆盖 ${new Set(stats.map((s) => s.cat)).size} 个大类</span>`),
      kpiCard("合计份额", cnum(sumShares, 1), "亿份", `<span class="dim">${rangeText(app)}</span>`),
      kpiCard("合计规模", sumScale ? cnum(sumScale, 0) : "—", "亿元", `<span class="dim">按最新净值估算</span>`),
      kpiCard(
        "平均区间变化",
        fmtPct(avgPct, 2),
        "",
        `<span class="delta ${flow > 0 ? "delta--up" : flow < 0 ? "delta--down" : "delta--flat"}">${esc(fmtSigned(flow, 1))} 亿元</span><span class="dim">${
          app.flowComplete ? "区间份额净申购" : "份额净申购估算"
        }</span>`,
        avgPct != null ? (avgPct >= 0 ? "var(--up)" : "var(--down)") : undefined
      ),
    ].join("");
  }
  body.innerHTML = `<div class="watchgrid">${watchNames.map((n) => watchCardHTML(app, n)).join("")}</div>
    ${
      missing > 0
        ? `<p class="notice" style="margin-top:var(--sp-4)"><svg aria-hidden="true"><use href="#i-info"/></svg><span>有 ${missing} 个自选小类不在当前「${state.taxonomy === "legacy" ? "原看板口径" : "新版分类"}」下，已自动隐藏；切回另一套口径可以看到它们。</span></p>`
        : ""
    }
    <p class="notice" style="margin-top:var(--sp-4)">
      <svg aria-hidden="true"><use href="#i-info"/></svg>
      <span>${
        app.flowComplete
          ? "「区间份额净申购」为区间内每日份额净申购（Δ份额 × 当日单位净值）之和；已退市或缺少净值的成分不计入。不等同于交易所口径的申赎金额。"
          : "「区间份额净申购」为区间份额变化量乘以该小类最新单位净值的估算值；全量图表加载完成后会自动切换为每日份额净申购求和。不等同于交易所口径的申赎金额。"
      }</span>
    </p>`;
}

function kpiCard(label, num, unit, foot, dot) {
  return `<div class="kpi">
    <div class="kpi-top"><span class="kpi-label"><span class="kpi-dot" style="background:${dot || "var(--accent)"}"></span>${esc(
    label
  )}</span></div>
    <div class="kpi-val num">${esc(num)}<span class="unit">${esc(unit)}</span></div>
    <div class="kpi-foot">${foot}</div>
  </div>`;
}

/* ============================ 大类视图 ============================ */

export function renderCategory(app, opts = {}) {
  const cat = state.cat;
  const key = cat || app.cats?.[0]?.key;
  const c = app.catMap?.get(key);
  if (!c) return;
  const title = document.getElementById("catTitle");
  const sub = document.getElementById("catSub");
  const summary = app.stats?.byCat?.get(key);
  if (title) title.textContent = c.label;
  if (sub) {
    const flow = app.catFlowOf ? app.catFlowOf(key) : (app.subsByCat?.get(key) || []).reduce((s, n) => s + flowEstimate(app.stats?.byName?.get(n)), 0);
    sub.innerHTML = [
      `<span class="chip chip--line">${esc(rangeText(app))}</span>`,
      `<span>${app.subsReady ? (summary?.count ?? "—") : (c.subs ?? "—")} 个细分行业</span>`,
      `<span class="delta ${summary?.pct > 0 ? "delta--up" : summary?.pct < 0 ? "delta--down" : "delta--flat"}">${fmtPct(
        summary?.pct,
        2
      )}</span>`,
      `<span class="dim">区间份额净申购${app.chartData?.has(key) ? "" : "（估算）"} ${esc(fmtSigned(flow, 1))} 亿元</span>`,
      state.sub && (app.subsByCat?.get(key) || []).includes(state.sub)
        ? `<span class="chip chip--accent">聚焦 · ${esc(state.sub)}</span>`
        : "",
      state.compare.length
        ? `<span class="chip chip--accent">对比 ${esc(state.compare.join(" vs "))}<button class="rc-x" type="button" data-clear-compare="1" aria-label="退出对比" title="退出对比" style="width:16px;height:16px;margin-left:2px"><svg width="9" height="9"><use href="#i-close"/></svg></button></span>`
        : "",
    ].join("");
  }
  const sub2 = document.getElementById("catTableSub");
  if (sub2) sub2.textContent = `${rangeText(app)} · 点击表头排序 · 点击行看明细`;
  const note = document.getElementById("chartNoteRange");
  if (note) note.textContent = `当前区间 ${rangeText(app)}`;

  renderCatTable(app, key);
  renderCatSide(app, key);
  if (!app.subsReady) {
    const t = document.getElementById("tblCat")?.querySelector("tbody");
    if (t) t.innerHTML = skeletonRows(6, 8);
    const k = document.getElementById("catKpis");
    if (k)
      k.innerHTML = Array.from({ length: 4 })
        .map(() => `<div><dt><span class="sk sk-line" style="width:64px"></span></dt><dd><span class="sk" style="display:block;height:22px;width:80px;margin-top:4px"></span></dd></div>`)
        .join("");
    document.getElementById("catTopIn").innerHTML = "";
    document.getElementById("catTopOut").innerHTML = "";
  }
  if (opts.chart !== false) app.onCategoryRender?.(key);
}

function renderCatTable(app, key) {
  const tbl = document.getElementById("tblCat");
  if (!tbl) return;
  const tbody = tbl.querySelector("tbody");
  const names = app.subsByCat?.get(key) || [];
  const rows = names
    .map((n) => app.stats?.byName?.get(n))
    .filter(Boolean)
    .map((s) => ({ ...s, name: s.name }));
  const { key: sortKey, dir } = state.catSort;
  rows.sort((a, b) => {
    if (sortKey === "name") return dir * String(a.name).localeCompare(String(b.name), "zh-CN");
    const av = a[sortKey] ?? -Infinity;
    const bv = b[sortKey] ?? -Infinity;
    return dir * (av - bv);
  });
  tbody.innerHTML = rows
    .map((s) => {
      const color = toneColor(s.color, isDark());
      return `<tr data-sub="${esc(s.name)}" data-cat="${esc(s.cat)}" tabindex="0">
      <td><span class="cell-name"><span class="cat-dot" style="background:${esc(color)}"></span>${esc(s.name)}</span></td>
      <td class="num">${esc(cnum(s.last, 1))}</td>
      <td class="num ${s.delta > 0 ? "up" : s.delta < 0 ? "down" : "flat"}">${esc(fmtSigned(s.delta, 1))}</td>
      <td class="num ${s.pct > 0 ? "up" : s.pct < 0 ? "down" : "flat"}">${esc(fmtPct(s.pct, 2))}</td>
      <td class="num">${s.scale != null ? esc(cnum(s.scale, 1)) : "—"}</td>
      <td class="num">${sparkSVG(s.series, { w: 76, h: 22, color, stroke: 1.3 })}</td>
    </tr>`;
    })
    .join("");
  tbl.querySelectorAll("thead th[data-sort-key]").forEach((th) => {
    const k = th.dataset.sortKey;
    if (k === sortKey) th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
}

function renderCatSide(app, key) {
  const kpis = document.getElementById("catKpis");
  const names = app.subsByCat?.get(key) || [];
  const stats = names.map((n) => app.stats?.byName?.get(n)).filter(Boolean);
  const first = stats.reduce((s, x) => s + (x.first || 0), 0);
  const last = stats.reduce((s, x) => s + (x.last || 0), 0);
  const flow = stats.reduce((s, x) => s + (app.flowOf ? app.flowOf(x.name, x) : flowEstimate(x)), 0);
  const pct = first ? ((last - first) / Math.abs(first)) * 100 : null;
  if (kpis) {
    kpis.innerHTML = `<div><dt>区间起点份额</dt><dd class="num">${esc(cnum(first, 1))}<span class="unit">亿份</span></dd></div>
      <div><dt>区间终点份额</dt><dd class="num">${esc(cnum(last, 1))}<span class="unit">亿份</span></dd></div>
      <div><dt>区间变化率</dt><dd class="num ${pct > 0 ? "up" : pct < 0 ? "down" : "flat"}">${esc(fmtPct(pct, 2))}</dd></div>
      <div><dt>区间份额净申购</dt><dd class="num ${flow > 0 ? "up" : flow < 0 ? "down" : "flat"}">${esc(fmtSigned(flow, 1))}<span class="unit">亿元</span></dd></div>`;
  }
  const renderRank = (hostId, dir) => {
    const host = document.getElementById(hostId);
    if (!host) return;
    const sorted = stats.slice().sort((a, b) => (dir === "in" ? b.delta - a.delta : a.delta - b.delta));
    const list = dir === "in" ? sorted.filter((s) => s.delta > 0).slice(0, 3) : sorted.filter((s) => s.delta < 0).slice(0, 3);
    if (!list.length) {
      host.innerHTML = `<p class="t-2xs dim" style="padding:6px 12px">该区间无${dir === "in" ? "份额净申购" : "净流出"}的小类</p>`;
      return;
    }
    host.innerHTML = list
      .map(
        (s, i) => `<button class="rankrow" type="button" data-sub="${esc(s.name)}" data-cat="${esc(s.cat)}">
        <span class="rankrow-idx">${i + 1}</span>
        <span class="cat-dot" style="background:${esc(toneColor(s.color, isDark()))}"></span>
        <span class="rankrow-name">${esc(s.name)}</span>
        <span class="rankrow-val ${s.delta > 0 ? "up" : "down"}">${esc(fmtSigned(s.delta, 1))}</span>
      </button>`
      )
      .join("");
  };
  renderRank("catTopIn", "in");
  renderRank("catTopOut", "out");
}

/* ============================ 图表图例 ============================ */

/** 聚焦态图例：主指标只展示；叠加项可点击单独开关（带单位） */
export function renderFocusLegend(items, onToggle, onExit) {
  const host = document.getElementById("chartLegend");
  if (!host) return;
  host.innerHTML = (items || [])
    .map((it) => {
      const dot = it.kind === "bar" ? "lc-dot lc-dot--flow" : "lc-dot";
      const val = it.value == null ? "" : `<span class="lc-val">${esc(cnum(it.value, 1))}</span>`;
      const inner = `<span class="${dot}"${it.kind === "bar" ? "" : ` style="--lc:${toneColor(it.color, isDark())}"`}></span>
        <span class="lc-name">${esc(it.label)}</span><span class="lc-unit">${esc(it.unit)}</span>${val}`;
      return it.toggle
        ? `<button class="legend-chip legend-chip--ov" type="button" data-overlay-toggle="${esc(it.id)}" aria-pressed="true" title="点击移除叠加">${inner}</button>`
        : `<button class="legend-chip legend-chip--main" type="button" data-exit-focus="1" aria-current="true" title="主指标；点击恢复该大类全部小类">${inner}<span class="lc-hint">· 点此返回大类</span></button>`;
    })
    .join("");
  host.onclick = (e) => {
    const ov = e.target.closest("[data-overlay-toggle]");
    if (ov) {
      onToggle(ov.dataset.overlayToggle);
      return;
    }
    if (e.target.closest("[data-exit-focus]")) onExit?.();
  };
}

export function renderLegend(series, focused, onFocus) {
  const host = document.getElementById("chartLegend");
  if (!host) return;
  if (!series.length) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML =
    `<button class="legend-chip legend-chip--all" type="button" data-focus="" aria-pressed="${!focused}">全部</button>` +
    series
      .map(
        (s) => `<button class="legend-chip" type="button" data-focus="${esc(s.name)}" aria-pressed="${focused === s.name}" style="--lc:${esc(
          toneColor(s.color, isDark())
        )}" title="${esc(s.name)}：点击聚焦，双击只看该系列">
          <span class="lc-dot"></span><span class="lc-name">${esc(s.name)}</span>
          <span class="lc-val">${esc(s.endValue == null ? "" : cnum(s.endValue, 1))}</span>
        </button>`
      )
      .join("");
  host.onclick = (e) => {
    const b = e.target.closest("[data-focus]");
    if (!b) return;
    onFocus(b.dataset.focus || null);
  };
}
