/* ==========================================================================
   chart：ECharts 编排（主图 / 市场图 / 迷你图 / 端点标签）
   --------------------------------------------------------------------------
   设计要点：
   · 主图持有「全历史」数据，dataZoom 的窗口 = 全局区间 → 拖动滑块即改区间，
     所有表格/KPI 跟着变；这比"先切片再画"更接近 TradingView 的手感。
   · 切换指标/区间复用同一个实例（only setOption），只有主题变化才重建。
   · frame 数据 1212×10：sampling='lttb'，动画只在首次入场，保障切换 < 200ms。
   · 端点标签用 HTML 覆盖层绘制（比 ECharts endLabel 更好控制不重叠）。
   ========================================================================== */

import { axisNum, cnum, esc, fmtPct, isDesktop, prefersReducedMotion, toneColor, throttleRAF } from "./util.js";

let echartsReady = null;
/**
 * 按需加载 echarts（约 1MB）：
 * · 页面 <head> 只用 preload 预热，不阻塞首屏解析与 KPI 文本
 * · 第一次真正要画图时才注入 <script>，加载完成后 resolve window.echarts
 */
export function ensureEcharts(timeout = 20000) {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (echartsReady) return echartsReady;
  echartsReady = new Promise((resolve, reject) => {
    let settled = false;
    const ok = () => {
      if (settled) return;
      if (window.echarts) {
        settled = true;
        performance.mark("ebbflow:echarts-ready");
        resolve(window.echarts);
      } else reject(new Error("图表库不可用"));
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      echartsReady = null;
      reject(new Error("图表库加载失败（echarts.min.js）"));
    };
    const existing = Array.from(document.scripts).find((s) => /echarts\.min\.js/.test(s.src));
    if (existing) {
      existing.addEventListener("load", ok);
      existing.addEventListener("error", fail);
      if (window.echarts) ok();
      return;
    }
    const script = document.createElement("script");
    script.src = new URL("echarts.min.js", document.baseURI).href;
    script.async = true;
    script.onload = ok;
    script.onerror = fail;
    document.head.append(script);
    setTimeout(() => {
      if (!settled && !window.echarts) fail();
    }, timeout);
  });
  return echartsReady;
}

export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    ink: v("--ink"),
    ink2: v("--ink-2"),
    ink3: v("--ink-3"),
    ink4: v("--ink-4"),
    line: v("--line"),
    lineStrong: v("--line-strong"),
    surface: v("--surface"),
    surface2: v("--surface-2"),
    surface3: v("--surface-3"),
    accent: v("--accent"),
    up: v("--up"),
    down: v("--down"),
    flat: v("--flat"),
    grid: v("--grid-line"),
    gridStrong: v("--grid-line-strong"),
    area: v("--chart-area"),
    dark: document.documentElement.getAttribute("data-theme") === "dark",
  };
}

const AXIS_FONT = 10;

/* ==========================================================================
   主图
   ========================================================================== */
export let activeLabelName = null;

export const main = {
  ec: null,
  el: null,
  shell: null,
  lastPayload: null,
  firstRender: true,
  labelsLayer: null,
  paneLayer: null,
  scheduled: false,
  brushOn: false,
};

/**
 * @param {HTMLElement} el 图表容器
 * @param {object} hooks { onRangeChange(from,to,source), onReset(), onToggleBrush() }
 */
export async function initMain(el, hooks = {}) {
  const echarts = await ensureEcharts();
  main.el = el;
  main.shell = el.closest(".chart-shell") || el;
  main.ec = echarts.init(el, null, { renderer: "canvas", useDirtyRect: true });
  main.hooks = hooks;

  // 端点标签覆盖层
  const layer = document.createElement("div");
  layer.className = "endlabel-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2;overflow:hidden";
  main.shell.append(layer);
  main.labelsLayer = layer;

  // 分面标题层（左上角小字）
  const paneLayer = document.createElement("div");
  paneLayer.className = "pane-title-layer";
  paneLayer.setAttribute("aria-hidden", "true");
  main.shell.append(paneLayer);
  main.paneLayer = paneLayer;

  main.ec.on("datazoom", () => {
    const [a, b] = readZoom();
    if (a == null) return;
    const dates = main.lastPayload?.dates;
    if (!dates?.length) return;
    const from = dates[a];
    const to = dates[b];
    if (!from || !to || a === b) return;
    main.hooks.onRangeChange?.(from, to, "zoom");
    scheduleLabels();
    setTimeout(scheduleLabels, 120);
  });

  main.ec.on("brushEnd", (params) => {
    const area = params?.areas?.[0];
    const range = area?.coordRange;
    if (!range) return;
    const dates = main.lastPayload?.dates;
    let [a, b] = range;
    if (typeof a === "string") a = dates.indexOf(a);
    if (typeof b === "string") b = dates.indexOf(b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    if (a > b) [a, b] = [b, a];
    if (b - a < 1) return;
    main.ec.dispatchAction({ type: "brush", areas: [] });
    main.hooks.onRangeChange?.(dates[a], dates[b], "brush");
  });

  main.ec.on("dblclick", () => main.hooks.onReset?.());
  // 有些情况下（内部 dataZoom 拦截）实例级 dblclick 不稳定，用 zrender 层兜底
  main.ec.getZr().on("dblclick", () => main.hooks.onReset?.());
  // 曲线 hover/点击 → 对应端点标签高亮
  main.ec.on("mouseover", (params) => {
    if (params.componentType !== "series") return;
    const name = params.seriesName;
    main.labelsLayer?.querySelectorAll(".elab").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.name === name);
    });
  });
  main.ec.on("globalout", () => {
    main.labelsLayer?.querySelectorAll(".elab").forEach((el) => el.classList.remove("is-active"));
  });

  // 曲线 hover → 端点标签高亮（用 zrender 坐标反查最近的线，避免依赖 series 级 hover 语义）
  const onZrMove = throttleRAF((e) => {
    const p = main.lastPayload;
    const layer = main.labelsLayer;
    if (!p || !layer || !main.ec) return;
    const pt = [e.offsetX, e.offsetY];
    let active = null;
    try {
      if (main.ec.containPixel({ gridIndex: 0 }, pt)) {
        const idx = Math.round(main.ec.convertFromPixel({ gridIndex: 0 }, pt)[0]);
        let best = 16;
        (p.series || []).forEach((s, i) => {
          if (s.kind === "bar") return;
          const v = s.values?.[idx];
          if (v == null || !Number.isFinite(+v)) return;
          const y = main.ec.convertToPixel({ yAxisIndex: Number.isInteger(s.axis) ? s.axis : 0 }, +v);
          if (!Number.isFinite(y)) return;
          const d = Math.abs(y - pt[1]);
          if (d < best) {
            best = d;
            active = s.name;
          }
        });
      }
    } catch (err) {
      active = null;
    }
    activeLabelName = active;
    layer.querySelectorAll(".elab").forEach((el) => el.classList.toggle("is-active", el.dataset.name === active));
  });
  main.ec.getZr().on("mousemove", onZrMove);
  main.ec.getZr().on("globalout", () => {
    activeLabelName = null;
    main.labelsLayer?.querySelectorAll(".elab").forEach((el) => el.classList.remove("is-active"));
  });

  main.ec.on("rendered", scheduleLabels);
  main.ec.getZr().on("mouseup", scheduleLabels);

  const ro = new ResizeObserver(throttleRAF(() => {
    main.ec?.resize();
    scheduleLabels();
  }));
  ro.observe(el);

  // 滚轮交给页面滚动：在捕获阶段截住 wheel，不让 zrender 的漫游控制器看到它
  // （inside dataZoom 只保留双指缩放；鼠标滚轮/拖拽一律不修改区间）
  main.shell.addEventListener(
    "wheel",
    (e) => {
      e.stopPropagation();
    },
    { capture: true, passive: true }
  );

  return main.ec;
}

function readZoom() {
  if (!main.ec) return [null, null];
  const opt = main.ec.getOption();
  const dz = Array.isArray(opt.dataZoom) ? opt.dataZoom[0] : null;
  const dates = main.lastPayload?.dates || [];
  const n = dates.length;
  if (!dz || !n) return [null, null];
  const toIdx = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
    if (typeof v === "string") {
      const i = dates.indexOf(v);
      return i >= 0 ? i : null;
    }
    return null;
  };
  let a = toIdx(dz.startValue);
  let b = toIdx(dz.endValue);
  if (a == null && typeof dz.start === "number") a = Math.round((dz.start / 100) * (n - 1));
  if (b == null && typeof dz.end === "number") b = Math.round((dz.end / 100) * (n - 1));
  if (a == null || b == null) return [null, null];
  a = Math.max(0, Math.min(n - 1, a));
  b = Math.max(0, Math.min(n - 1, b));
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

function scheduleLabels() {
  if (main.scheduled) return;
  main.scheduled = true;
  requestAnimationFrame(() => {
    main.scheduled = false;
    paintPaneTitles();
    paintEndLabels();
  });
}

/**
 * 端点标签：画在 grid 右侧的 gutter 里（绘图区之外），按 y 值排布并保证 ≥8px 间距。
 * · 竖直放不下时按 |值| 保留 6 条，其余收进「+N 查看全部」入口（点击 → 明细抽屉）
 * · 移动端（<768px）不画，交给 tooltip
 */
const ELAB_GAP = 8;
const ELAB_H = 16;

function paintEndLabels() {
  const layer = main.labelsLayer;
  const p = main.lastPayload;
  if (!layer) return;
  // 聚焦模式：每条线都有自己的彩色坐标轴 + 图例数值，不再画右侧端点标注与引线
  if (p && p.focusMode) {
    layer.innerHTML = "";
    return;
  }
  const labelsFor = p && (p.layout === "panes" ? p.paneEndLabels : p.endLabels);
  if (!p || !labelsFor || !isDesktop() || !(p.series || []).some((x) => x.kind !== "bar")) {
    layer.innerHTML = "";
    return;
  }
  const chart = main.ec;
  if (!chart || chart.isDisposed()) return;
  const rect = chart.getModel()?.getComponent("grid")?.coordinateSystem?.getRect?.();
  if (!rect) return;

  const seen = new Set();
  const items = [];
  for (const s of labelsFor) {
    if (s.value == null || !Number.isFinite(s.value) || seen.has(s.name)) continue;
    seen.add(s.name);
    const y = chart.convertToPixel({ yAxisIndex: Number.isInteger(s.axis) ? s.axis : 0 }, s.value);
    if (!Number.isFinite(y)) continue;
    items.push({ name: s.name, value: s.value, color: s.color, y });
  }
  if (!items.length) {
    layer.innerHTML = "";
    return;
  }

  // 竖直可用高度 → 能放几条
  const top = rect.y + 2;
  const bottom = rect.y + rect.height - 2;
  const capacity = Math.max(1, Math.floor((bottom - top) / (ELAB_H + ELAB_GAP)) + 1);
  let shown = items;
  let hidden = 0;
  if (items.length > capacity) {
    const keep = Math.min(6, capacity);
    shown = items.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, keep);
    hidden = items.length - shown.length;
  }

  // 按 y 排布：经典「向下撑开 + 越界后自底向上收敛」，保证相邻 ≥ ELAB_H+8、且全部落在绘图区内
  shown.sort((a, b) => a.y - b.y);
  const step = ELAB_H + ELAB_GAP;
  const maxY = bottom - ELAB_H;
  const clampY = (v) => Math.min(Math.max(v, top), maxY);
  const desired = shown.map((it) => clampY(it.y - ELAB_H / 2));
  shown.forEach((it, i) => {
    it.tickY = Math.round(it.y); // 曲线真实末端 y（避让前）
  });
  const placed = desired.slice();
  for (let i = 1; i < placed.length; i++) placed[i] = Math.max(placed[i], placed[i - 1] + step);
  if (placed.length && placed[placed.length - 1] > maxY) {
    placed[placed.length - 1] = maxY;
    for (let i = placed.length - 2; i >= 0; i--) placed[i] = Math.min(desired[i], placed[i + 1] - step);
  }
  shown.forEach((it, i) => {
    it.y = placed[i];
  });

  const gutterOff = p.layout === "panes" ? p.paneLabelGutterOffset || 0 : p.labelGutterOffset || 0;
  const left = Math.round(rect.x + rect.width + 8 + gutterOff);
  const maxW = Math.max(56, Math.round((layer.clientWidth || left + 100) - left - 6));
  const html = shown
    .map(
      (it) => `<i class="elab-tick" style="left:${left - 7}px;top:${Math.round(it.tickY)}px;--c:${it.color}"></i>
      <span class="elab${activeLabelName === it.name ? " is-active" : ""}" data-name="${esc(it.name)}" style="left:${left}px;top:${Math.round(it.y)}px;max-width:${maxW}px;--c:${it.color}">
        <i class="elab-dot"></i><span class="elab-name">${esc(it.name)}</span><span class="elab-val">${esc(
        p.endLabelDigits === 1 ? cnum(it.value, 1) : cnum(it.value, Math.abs(it.value) >= 100 ? 0 : 1)
      )}</span>
      </span>`
    )
    .join("");
  const more =
    hidden > 0
      ? `<button class="elab-more" type="button" data-more-labels="1" style="left:${left}px;top:${Math.round(
          Math.min(bottom - 2, rect.y + rect.height - 18)
        )}px;max-width:${maxW}px" title="还有 ${hidden} 条未显示，点击查看全部端点数值">+${hidden} 查看全部</button>`
      : "";
  layer.innerHTML = html + more;

  // 引线：从曲线末端水平引到标签，标签被避让时加折点（颜色 = 线色）
  const svgNS = "http://www.w3.org/2000/svg";
  const lines = document.createElementNS(svgNS, "svg");
  lines.setAttribute("class", "elab-lines");
  lines.setAttribute("aria-hidden", "true");
  const x0 = Math.round(rect.x + rect.width);
  const x1 = left - 2;
  lines.innerHTML = shown
    .map((it) => {
      const y0 = Math.round(it.tickY);
      const y1 = Math.round(it.y + ELAB_H / 2);
      const color = it.color || "currentColor";
      const pts =
        Math.abs(y1 - y0) < 1.5
          ? `${x0},${y0} ${x1},${y0}`
          : `${x0},${y0} ${x1 - 7},${y0} ${x1 - 7},${y1} ${x1},${y1}`;
      return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" opacity="0.85"/>`;
    })
    .join("");
  layer.prepend(lines);

  // 标签 hover → 高亮对应曲线（其余降到 18%）
  const ec = main.ec;
  const seriesIndexOf = (name) => (p.series || []).findIndex((x) => x.name === name);
  layer.querySelectorAll(".elab").forEach((el) => {
    const name = el.dataset.name;
    el.addEventListener("mouseenter", () => {
      const i = seriesIndexOf(name);
      if (i < 0) return;
      el.classList.add("is-active");
      ec.dispatchAction({ type: "downplay" });
      ec.dispatchAction({ type: "highlight", seriesIndex: i, dataIndex: (p.dates || []).length - 1 });
    });
    el.addEventListener("mouseleave", () => el.classList.remove("is-active"));
    el.addEventListener("mouseout", () => ec.dispatchAction({ type: "downplay" }));
  });

  const btn = layer.querySelector("[data-more-labels]");
  if (btn) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      showEndLabelList(items, left, rect);
    });
  }
}

/** 「查看全部」：列出所有系列的端点值与区间变化，点任意一行打开该小类明细抽屉 */
function showEndLabelList(items, left, rect) {
  const layer = main.labelsLayer;
  if (!layer) return;
  layer.querySelector(".elab-list")?.remove();
  const p = main.lastPayload || {};
  const rows = items
    .slice()
    .sort((a, b) => b.y - a.y)
    .map(
      (it) => `<button class="elab-li" type="button" data-pick-series="${esc(it.name)}">
        <i class="elab-dot" style="--c:${it.color}"></i>
        <span class="elab-li-name">${esc(it.name)}</span>
        <span class="elab-li-val">${esc(p.endLabelDigits === 1 ? cnum(it.value, 1) : cnum(it.value, Math.abs(it.value) >= 100 ? 0 : 1))}</span>
      </button>`
    )
    .join("");
  const box = document.createElement("div");
  box.className = "elab-list";
  box.style.left = `${Math.max(8, Math.round(left - 176))}px`;
  box.style.top = `${Math.round(rect.y + 4)}px`;
  box.style.maxHeight = `${Math.round(rect.height - 8)}px`;
  box.innerHTML = `<div class="elab-list-head">端点数值 · 点一行看明细</div><div class="elab-list-body">${rows}</div>`;
  layer.append(box);
  box.addEventListener("click", (e) => {
    const row = e.target.closest("[data-pick-series]");
    if (!row) return;
    box.remove();
    document.dispatchEvent(new CustomEvent("etf:pick-series", { detail: { name: row.dataset.pickSeries } }));
  });
  const closeOnce = (ev) => {
    if (box.contains(ev.target)) return;
    box.remove();
    document.removeEventListener("pointerdown", closeOnce, true);
  };
  setTimeout(() => document.addEventListener("pointerdown", closeOnce, true), 0);
}

/* ---------------------------- option 构造 ---------------------------- */
function yAxisOption(a, index, t, p) {
  const isPct = a.role === "pct";
  const isFlow = a.role === "flow";
  const useLog = !!p.log && index === 0 && !isPct && !isFlow;
  return {
    type: useLog ? "log" : "value",
    logBase: 10,
    position: a.position || "left",
    offset: a.offset || 0,
    // 金额轴按数据自适应；份额净申购含正负、变化率含 0，都强制包含 0
    scale: !isFlow && !isPct && !p.log,
    splitNumber: 4,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: {
      color: t.ink4,
      fontSize: AXIS_FONT,
      margin: 6,
      formatter: isPct ? (v) => `${Number.isFinite(+v) ? +(+v).toFixed(1) : v}%` : (v) => axisNum(v),
    },
    splitLine: index === 0 ? { lineStyle: { color: t.grid, type: [3, 3] } } : { show: false },
    axisPointer: { label: { show: false } },
    name: a.name || "",
    nameTextStyle: { color: t.ink4, fontSize: AXIS_FONT, padding: [0, 0, 0, 0] },
  };
}

/** 给分面轴算「好看」的刻度边界（保证含 0，避免 ECharts 用数据端点当刻度） */
function niceBounds(vals, split, includeZero = false) {
  const fin = vals.filter((v) => Number.isFinite(+v)).map(Number);
  if (!fin.length) return { min: 0, max: 1, interval: 1 };
  let lo = Math.min(...fin);
  let hi = Math.max(...fin);
  if (includeZero) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else {
      lo = Math.min(0, lo);
      hi = Math.max(0, hi);
    }
  }
  const rough = (hi - lo) / Math.max(1, split);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const candidates = [1, 2, 2.5, 5, 10].map((k) => k * mag);
  // 取「不小于 rough 的最小 nice 值」：刻度数不超 split+1，也避免数据端点当刻度
  const step = candidates.find((c) => c >= rough - 1e-9) || candidates[candidates.length - 1];
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, interval: step };
}

/** 分面标题（左上角小字） */
function paintPaneTitles() {
  const layer = main.paneLayer;
  const p = main.lastPayload;
  if (!layer) return;
  if (!p || ((!p.titles || !p.titles.length) && (!p.axes || !p.axes.length)) || !main.ec || main.ec.isDisposed()) {
    layer.innerHTML = "";
    return;
  }
  const chart = main.ec;
  const parts = [];
  const rect = chart.getModel()?.getComponent("grid", 0)?.coordinateSystem?.getRect?.();
  if (!rect) {
    layer.innerHTML = "";
    return;
  }
  if (p.layout !== "axes") {
  for (const item of p.titles || []) {
    const r = chart.getModel()?.getComponent("grid", item.pane)?.coordinateSystem?.getRect?.();
    if (!r) continue;
    parts.push(`<span class="pane-title" style="left:${Math.round(r.x)}px;top:${Math.round(r.y) - 16}px">${esc(item.text)}</span>`);
  }
  }
  // 聚焦多轴：仅 1-2 条轴时显示角标（≥3 条轴时靠彩色刻度 + 图例，避免顶部拥挤）
  if (p.layout === "panes" || (p.axes || []).length > 2) {
    layer.innerHTML = parts.join("");
    return;
  }
  for (const ax of p.axes || []) {
    const off = ax.offset || 0;
    const row = Math.floor(off / 56);
    const y = Math.round(rect.y - 12 - row * 12);
    if (ax.position === "right") {
      parts.push(
        `<span class="axis-cap axis-cap--right" style="left:${Math.round(rect.x + rect.width + 6 + off)}px;top:${y}px;--c:${ax.color}">${esc(
          ax.name
        )}</span>`
      );
    } else {
      // 左轴标题左对齐放在绘图区左上，避免长单位名被容器裁掉
      parts.push(
        `<span class="axis-cap axis-cap--left" style="left:${Math.round(rect.x + 2 + off)}px;top:${y}px;--c:${ax.color}">${esc(
          ax.name
        )}</span>`
      );
    }
  }
  layer.innerHTML = parts.join("");
}

/** 分面 tooltip：无论 hover 哪一栏，都列出当天全部已选指标 */
function focusTooltip(p, params) {
  const idx = params?.[0]?.dataIndex;
  if (idx == null) return "";
  const date = p.dates?.[idx] || "";
  const rows = (p.series || []).map((s) => {
    const v = s.values?.[idx];
    const unit = s.unit || "";
    const txt =
      v == null || !Number.isFinite(+v)
        ? "—"
        : unit === "%"
          ? `${(+v).toFixed(2)}${esc(unit)}`
          : `${axisNum(v)}<span class="ec-tip-unit">${esc(unit)}</span>`;
    const color = s.kind === "bar" ? (v >= 0 ? "var(--up)" : "var(--down)") : s.color;
    return `<div class="ec-tip-row"><span class="ec-tip-name"><i class="ec-tip-dot" style="--c:${color}"></i>${esc(
      s.name
    )}</span><span class="ec-tip-val">${txt}</span></div>`;
  });
  return `<div class="ec-tip">
    <div class="ec-tip-head"><span class="ec-tip-date">${esc(date)}</span><span class="ec-tip-sum">${esc(
      p.footNote || ""
    )}</span></div>
    <div class="ec-tip-body">${rows.join("")}</div>
  </div>`;
}

/** 聚焦态：多栏（small multiples）配置 */
function axesFocusOption(p) {
  const t = tokens();
  const mobile = !isDesktop();
  const [za, zb] = p.zoom || [0, (p.dates?.length || 1) - 1];
  const grid = {
    left: p.gridLeft ?? 14,
    right: p.gridRight ?? 120,
    top: 28,
    bottom: mobile ? 30 : 58,
    containLabel: true,
  };
  const xAxis = {
    type: "category",
    gridIndex: 0,
    data: p.dates,
    boundaryGap: true,
    axisLine: { lineStyle: { color: t.line } },
    axisTick: { show: true, length: 4, lineStyle: { color: t.line } },
    axisLabel: { color: t.ink4, fontSize: AXIS_FONT, hideOverlap: true, margin: 8 },
    splitLine: { show: false },
    axisPointer: { label: { show: false } },
  };
  const yAxes = (p.axes || []).map((ax, i) => {
    const vals = (p.series || [])
      .filter((s) => s.axis === i)
      .flatMap((s) => (s.values || []).slice(za, zb + 1));
    const includeZero = ax.kind === "flow" || ax.kind === "pct";
    const b = niceBounds(vals, 4, includeZero);
    const compact = (v) => {
      const n = +v;
      if (!Number.isFinite(n)) return `${v}`;
      if (Math.abs(n) >= 1000) {
        const k = n / 1000;
        return `${(Math.abs(k) >= 10 ? k.toFixed(0) : k.toFixed(1)).replace(/\.0$/, "")}k`;
      }
      return `${Math.round(n)}`;
    };
    return {
      type: "value",
      position: ax.position,
      offset: ax.offset || 0,
      name: "",
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: ax.color,
        fontSize: AXIS_FONT,
        margin: 6,
        formatter: ax.kind === "pct" ? (v) => `${compact(v)}%` : compact,
      },
      splitLine: { show: i === 0, lineStyle: { color: t.grid, type: [3, 3] } },
      scale: true,
      min: b.min,
      max: b.max,
      interval: b.interval,
      z: 3,
    };
  });
  const series = (p.series || []).map((s) => {
    const base = {
      name: s.name,
      xAxisIndex: 0,
      yAxisIndex: s.axis,
      data: s.values,
      animation: false,
      unit: s.unit,
      z: s.kind === "bar" ? 2 : 3,
    };
    const baseline = s.baseline
      ? {
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: t.lineStrong, width: 1 },
            data: [{ yAxis: 0 }],
          },
        }
      : {};
    if (s.kind === "bar") {
      return {
        ...base,
        type: "bar",
        barMaxWidth: mobile ? 10 : 16,
        barCategoryGap: "30%",
        itemStyle: {
          color: (par) => (par.value >= 0 ? t.up : t.down),
          opacity: 0.9,
          borderRadius: [1, 1, 0, 0],
        },
        emphasis: { focus: "series", itemStyle: { opacity: 1 } },
        ...baseline,
      };
    }
    return {
      ...base,
      type: "line",
      showSymbol: false,
      sampling: "lttb",
      smooth: 0.12,
      connectNulls: false,
      lineStyle: { width: 1.8, color: s.color },
      itemStyle: { color: s.color },
      emphasis: { focus: "series", lineStyle: { width: 2.6 } },
      ...baseline,
    };
  });
  const dz = [
    {
      type: "inside",
      xAxisIndex: 0,
      filterMode: "filter",
      zoomOnMouseWheel: false,
      moveOnMouseWheel: false,
      moveOnMouseMove: false,
      startValue: p.dates[za] ?? p.dates[0],
      endValue: p.dates[zb] ?? p.dates[p.dates.length - 1],
    },
  ];
  if (!mobile) {
    dz.push({
      type: "slider",
      xAxisIndex: 0,
      filterMode: "filter",
      height: 16,
      bottom: 6,
      startValue: p.dates[za] ?? p.dates[0],
      endValue: p.dates[zb] ?? p.dates[p.dates.length - 1],
      brushSelect: false,
      borderColor: "transparent",
      backgroundColor: t.dark ? "rgba(255,255,255,0.03)" : "rgba(16,19,26,0.035)",
      fillerColor: t.area,
      handleSize: "100%",
      handleStyle: { color: t.surface, borderColor: t.accent, borderWidth: 1.2, shadowBlur: 3, shadowColor: "rgba(0,0,0,.18)" },
      moveHandleStyle: { color: t.lineStrong, opacity: 0.7 },
      emphasis: { handleStyle: { borderColor: t.accent }, moveHandleStyle: { color: t.accent } },
      dataBackground: { lineStyle: { color: t.lineStrong, opacity: 0.9, width: 1 }, areaStyle: { color: t.surface3, opacity: 0.9 } },
    });
  }
  return {
    animation: false,
    grid,
    xAxis,
    yAxis: yAxes,
    series,
    dataZoom: dz,
    axisPointer: { label: { show: false }, lineStyle: { color: t.lineStrong } },
    tooltip: {
      trigger: "axis",
      appendToBody: true,
      className: "ec-tip",
      axisPointer: { type: "cross", lineStyle: { color: t.lineStrong }, crossStyle: { color: t.lineStrong } },
      formatter: (params) => focusTooltip(p, params),
    },
    toolbox: { show: false },
    legend: { show: false },
    brush: {
      xAxisIndex: 0,
      brushMode: "lineX",
      transformable: false,
      removeOnClick: true,
      throttleType: "debounce",
      throttleDelay: 120,
      inBrush: { opacity: 1 },
      outOfBrush: { opacity: 0.4 },
    },
  };
}


/** 分面布局：主图（份额/规模双轴）+ 份额净申购 + 变化率，共享 X 轴与十字光标 */
function panesFocusOption(p) {
  const t = tokens();
  const mobile = !isDesktop();
  const [za, zb] = p.zoom || [0, (p.dates?.length || 1) - 1];
  const H = main.el?.clientHeight || 520;
  const n = p.panes.length;
  const gap = mobile ? 18 : 36;
  const topPad = 22;
  const bottomPad = mobile ? 30 : 58;
  const usable = Math.max(110 * n, H - topPad - bottomPad - gap * (n - 1));
  let top = topPad;
  const grids = p.panes.map((pane, i) => {
    const h = usable * (pane.fraction ?? 1 / n);
    const g = { left: 14, right: p.paneGridRight, top: Math.round(top), height: Math.round(h), containLabel: true };
    top += h + gap;
    return g;
  });
  const allX = p.panes.map((_, i) => i);
  const xAxes = p.panes.map((pane, i) => ({
    type: "category",
    gridIndex: i,
    data: p.dates,
    boundaryGap: true,
    axisLine: { lineStyle: { color: t.line } },
    axisTick: { show: i === n - 1, length: 4, lineStyle: { color: t.line } },
    axisLabel: { show: i === n - 1, color: t.ink4, fontSize: AXIS_FONT, hideOverlap: true, margin: 8 },
    splitLine: { show: false },
    axisPointer: { label: { show: false } },
  }));
  const yAxes = p.paneAxes.map((ax, i) => {
    const paneH = grids[ax.pane]?.height ?? 999;
    const vals = (p.series || [])
      .filter((s) => s.metricId === ax.metric)
      .flatMap((s) => (s.values || []).slice(za, zb + 1));
    const includeZero = ax.kind === "flow" || ax.kind === "pct";
    const b = niceBounds(vals, paneH < 120 ? 2 : 4, includeZero);
    const compact = (v) => {
      const num = +v;
      if (!Number.isFinite(num)) return `${v}`;
      if (Math.abs(num) >= 1000) {
        const k = num / 1000;
        return `${(Math.abs(k) >= 10 ? k.toFixed(0) : k.toFixed(1)).replace(/\.0$/, "")}k`;
      }
      return `${Math.round(num)}`;
    };
    return {
      type: "value",
      gridIndex: ax.pane,
      position: ax.position,
      name: "",
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: ax.color,
        fontSize: AXIS_FONT,
        margin: 6,
        formatter: ax.kind === "pct" ? (v) => `${compact(v)}%` : compact,
      },
      splitLine: { show: i === 0 || ax.position === "left", lineStyle: { color: t.grid, type: [3, 3] } },
      splitNumber: paneH < 120 ? 2 : 4,
      scale: true,
      min: b.min,
      max: b.max,
      interval: b.interval,
      z: 3,
    };
  });
  const series = (p.series || []).map((s) => {
    const base = {
      name: s.name,
      xAxisIndex: s.pane,
      yAxisIndex: s.paneAxis,
      data: s.values,
      animation: false,
      unit: s.unit,
      z: s.kind === "bar" ? 2 : 3,
    };
    const baseline = s.baseline
      ? {
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: t.lineStrong, width: 1 },
            data: [{ yAxis: 0 }],
          },
        }
      : {};
    if (s.kind === "bar") {
      return {
        ...base,
        type: "bar",
        barMaxWidth: mobile ? 10 : 16,
        barCategoryGap: "30%",
        itemStyle: {
          color: (par) => (par.value >= 0 ? t.up : t.down),
          opacity: 0.9,
          borderRadius: [1, 1, 0, 0],
        },
        emphasis: { focus: "series", itemStyle: { opacity: 1 } },
        ...baseline,
      };
    }
    return {
      ...base,
      type: "line",
      showSymbol: false,
      sampling: "lttb",
      smooth: 0.12,
      connectNulls: false,
      lineStyle: { width: 1.8, color: s.color },
      itemStyle: { color: s.color },
      emphasis: { focus: "series", lineStyle: { width: 2.6 } },
      ...baseline,
    };
  });
  const dz = [
    {
      type: "inside",
      xAxisIndex: allX,
      filterMode: "filter",
      zoomOnMouseWheel: false,
      moveOnMouseWheel: false,
      moveOnMouseMove: false,
      startValue: p.dates[za] ?? p.dates[0],
      endValue: p.dates[zb] ?? p.dates[p.dates.length - 1],
    },
  ];
  if (!mobile) {
    dz.push({
      type: "slider",
      xAxisIndex: allX,
      filterMode: "filter",
      height: 16,
      bottom: 6,
      startValue: p.dates[za] ?? p.dates[0],
      endValue: p.dates[zb] ?? p.dates[p.dates.length - 1],
      brushSelect: false,
      borderColor: "transparent",
      backgroundColor: t.dark ? "rgba(255,255,255,0.03)" : "rgba(16,19,26,0.035)",
      fillerColor: t.area,
      handleSize: "100%",
      handleStyle: { color: t.surface, borderColor: t.accent, borderWidth: 1.2, shadowBlur: 3, shadowColor: "rgba(0,0,0,.18)" },
      moveHandleStyle: { color: t.lineStrong, opacity: 0.7 },
      emphasis: { handleStyle: { borderColor: t.accent }, moveHandleStyle: { color: t.accent } },
      dataBackground: { lineStyle: { color: t.lineStrong, opacity: 0.9, width: 1 }, areaStyle: { color: t.surface3, opacity: 0.9 } },
    });
  }
  return {
    animation: false,
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    series,
    dataZoom: dz,
    axisPointer: { link: [{ xAxisIndex: "all" }], label: { show: false }, lineStyle: { color: t.lineStrong } },
    tooltip: {
      trigger: "axis",
      appendToBody: true,
      className: "ec-tip",
      axisPointer: { type: "cross", lineStyle: { color: t.lineStrong }, crossStyle: { color: t.lineStrong } },
      formatter: (params) => focusTooltip(p, params),
    },
    toolbox: { show: false },
    legend: { show: false },
    brush: {
      xAxisIndex: allX,
      brushMode: "lineX",
      transformable: false,
      removeOnClick: true,
      throttleType: "debounce",
      throttleDelay: 120,
      inBrush: { opacity: 1 },
      outOfBrush: { opacity: 0.4 },
    },
  };
}

function baseOption(p) {
  if (p.focusMode) return p.layout === "panes" ? panesFocusOption(p) : axesFocusOption(p);
  const t = tokens();
  const dates = p.dates;
  const showSlider = isDesktop() && !p.compare;
  const [a, b] = p.zoom;
  const axes = p.axes && p.axes.length ? p.axes : [{ role: "amount", position: "left" }];

  const series = p.series.map((s, i) => {
    const color = toneColor(s.color, t.dark);
    const axisIndex = Number.isInteger(s.axis) ? s.axis : 0;
    const unit = s.unit || p.unit || "";
    const dim = p.focused && p.focused !== s.name && p.series.length > 1 && !p.mixed ? true : false;
    const opacity = dim ? 0.13 : 1;
    if (s.kind === "bar") {
      return {
        name: s.name,
        type: "bar",
        data: s.values,
        yAxisIndex: axisIndex,
        barMaxWidth: p.mixed ? 7 : 9,
        barGap: "12%",
        barCategoryGap: "38%",
        itemStyle: {
          color: (params) => (params.value >= 0 ? t.up : t.down),
          opacity: p.mixed ? 0.42 : 0.95,
          borderRadius: [1, 1, 0, 0],
        },
        emphasis: { focus: "series", itemStyle: { opacity: 1 } },
        blur: { itemStyle: { opacity: 0.12 } },
        // 柱子放底层，避免压住折线
        z: p.mixed ? 1 : 4,
        animation: false,
        unit,
      };
    }
    return {
      name: s.name,
      type: "line",
      data: s.values,
      yAxisIndex: axisIndex,
      showSymbol: false,
      symbol: "circle",
      symbolSize: 5,
      connectNulls: false,
      smooth: 0.12,
      sampling: "lttb",
      triggerLineEvent: true,
      lineStyle: {
        width: (p.focused === s.name ? 2.4 : 1.7) * (p.mixed ? 1.05 : 1),
        color,
        opacity,
        type: s.dash ? [5, 3] : "solid",
      },
      itemStyle: { color, opacity },
      emphasis: { focus: "series", lineStyle: { width: 2.6 }, itemStyle: { opacity: 1 } },
      blur: { lineStyle: { opacity: 0.12 }, itemStyle: { opacity: 0.12 } },
      areaStyle:
        p.area && p.series.length <= 3 && !p.mixed
          ? {
              opacity: 0.1,
              color: {
                type: "linear",
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color },
                  { offset: 1, color: "rgba(0,0,0,0)" },
                ],
              },
            }
          : undefined,
      z: p.focused === s.name ? 4 : 3,
      animation: false,
      unit,
    };
  });

  const endIdx = b ?? dates.length - 1;
  const zoomCfg = [
    {
      type: "inside",
      xAxisIndex: 0,
      filterMode: "filter",
      startValue: dates[a] ?? dates[0],
      endValue: dates[endIdx] ?? dates[dates.length - 1],
      // 鼠标漫游全部关闭：滚轮用于页面滚动、拖拽用于选中文本/滚动，
      // 区间只能通过「预设 / 底部滑块 / 框选 / 双击复位」修改；触摸端保留双指缩放。
      zoomOnMouseWheel: false,
      moveOnMouseMove: false,
      moveOnMouseWheel: false,
      moveOnMouseDrag: false,
      zoomOnPinch: true,
      throttle: 60,
    },
  ];
  if (showSlider) {
    zoomCfg.push({
      type: "slider",
      xAxisIndex: 0,
      filterMode: "filter",
      height: 20,
      bottom: 6,
      startValue: dates[a] ?? dates[0],
      endValue: dates[endIdx] ?? dates[dates.length - 1],
      brushSelect: true,
      borderColor: "transparent",
      backgroundColor: t.dark ? "rgba(255,255,255,0.03)" : "rgba(16,19,26,0.035)",
      fillerColor: t.area,
      handleSize: "100%",
      handleStyle: { color: t.surface, borderColor: t.accent, borderWidth: 1.2, shadowBlur: 3, shadowColor: "rgba(0,0,0,.18)" },
      moveHandleStyle: { color: t.lineStrong, opacity: 0.7 },
      emphasis: { handleStyle: { borderColor: t.accent }, moveHandleStyle: { color: t.accent } },
      dataBackground: {
        lineStyle: { color: t.lineStrong, opacity: 0.9, width: 1 },
        areaStyle: { color: t.surface3, opacity: 0.9 },
      },
      selectedDataBackground: {
        lineStyle: { color: t.accent, opacity: 0.55, width: 1 },
        areaStyle: { color: t.area, opacity: 1 },
      },
      textStyle: { color: t.ink4, fontSize: 9 },
      labelFormatter: (v) => (typeof v === "string" ? v.slice(2, 7) : ""),
      showDetail: false,
    });
  }

  return {
    animation: false,
    // 不启用 toolbox：brush 组件存在时 ECharts 会自动挂一组选择图标，这里显式关掉
    toolbox: { show: false },
    textStyle: { fontFamily: getComputedStyle(document.body).fontFamily, color: t.ink2 },
    grid: {
      left: 4,
      // 右侧 = 端点标签 gutter + 每个右侧坐标轴预留宽度（多轴时逐层外扩）
      right: p.gridRight ?? 108,
      top: 14,
      bottom: showSlider ? 44 : 22,
      containLabel: true,
    },
    tooltip: {
      trigger: "axis",
      triggerOn: isDesktop() ? "mousemove|click" : "click",
      confine: true,
      appendToBody: true,
      className: "ec-tip",
      borderWidth: 0,
      padding: 0,
      backgroundColor: "transparent",
      axisPointer: {
        type: "line",
        lineStyle: { color: t.gridStrong, width: 1, type: [4, 4] },
        z: 0,
      },
      formatter: (params) => tooltipHTML(params, p),
    },
    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: p.series.some((x) => x.kind === "bar") && !p.series.some((x) => x.kind === "line"),
      axisLine: { lineStyle: { color: t.line } },
      axisTick: { show: false },
      axisLabel: {
        color: t.ink4,
        fontSize: AXIS_FONT,
        margin: 10,
        hideOverlap: true,
        formatter: (val, idx) => xLabel(val, idx, dates),
      },
      splitLine: { show: false },
      axisPointer: { label: { show: false } },
      animation: false,
    },
    yAxis: axes.map((a, i) => yAxisOption(a, i, t, p)),
    dataZoom: zoomCfg,
    brush: {
      xAxisIndex: 0,
      brushMode: "lineX",
      transformable: false,
      removeOnClick: true,
      throttleType: "debounce",
      throttleDelay: 120,
      inBrush: { opacity: 1 },
      outOfBrush: { opacity: 0.4 },
    },
    series,
  };
}

function xLabel(val, idx, dates) {
  const s = String(val || "");
  if (!s) return "";
  const [y, m, d] = s.split("-");
  // 首尾与 1 月显示年份，其余显示月/日，避免拥挤
  if (idx === 0 || idx === dates.length - 1 || (m === "01" && d <= "05")) return `${y.slice(2)}-${m}`;
  return `${Number(m)}/${Number(d)}`;
}

function tooltipHTML(params, p) {
  const arr = Array.isArray(params) ? params : [params];
  if (!arr.length) return "";
  const date = arr[0].axisValue || "";
  const rows = arr
    .filter((x) => x.value != null && Number.isFinite(+x.value))
    .map((x) => ({
      name: x.seriesName,
      value: +x.value,
      type: x.seriesType,
      color: x.color || toneColor(p.series.find((s) => s.name === x.seriesName)?.color || "#888", tokens().dark),
      unit: p.unitOf?.[x.seriesName] || p.unit || "",
    }));
  if (!rows.length) return "";
  rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const sameUnit = !p.mixed && new Set(rows.map((r) => r.unit)).size <= 1;
  const sum = rows.reduce((s, r) => s + r.value, 0);
  const unit = p.unit || "";
  const maxRows = 12;
  const shown = rows.slice(0, isDesktop() ? maxRows : 8);

  const fmtVal = (r) =>
    r.unit === "%" ? fmtPct(r.value, 2) : r.type === "bar" ? cnum(r.value, 2) : cnum(r.value, 1);

  const body = shown
    .map((r) => {
      const active = p.focused === r.name ? " is-active" : "";
      let right = "";
      let rightCls = "";
      if (p.secondary && p.series.length > 1) {
        if (p.secondary.type === "pct") {
          const v = p.secondary.map?.[r.name];
          if (Number.isFinite(v)) {
            right = fmtPct(v, 1);
            rightCls = v > 0 ? "up" : v < 0 ? "down" : "";
          }
        } else if (p.secondary.type === "value") {
          const v = p.secondary.map?.[r.name];
          if (Number.isFinite(v)) right = cnum(v, Math.abs(v) >= 100 ? 0 : 1);
        }
      }
      return `<div class="ec-tip-row${active}">
        <span class="ec-tip-swatch" style="--c:${r.color}"></span>
        <span class="ec-tip-name">${esc(r.name)}</span>
        <span class="ec-tip-val">${esc(fmtVal(r))}${r.unit && r.unit !== "%" ? `<span class="ec-tip-unit">${esc(r.unit)}</span>` : ""}</span>
        <span class="ec-tip-pct ${rightCls}">${esc(right)}</span>
      </div>`;
    })
    .join("");

  const rest = rows.length - shown.length;
  const sumTxt = sameUnit
    ? unit === "%"
      ? ""
      : `合计 ${cnum(sum, 1)}${rows.some((r) => r.type === "bar") ? "" : ""}`
    : "";

  return `<div class="ec-tip">
    <div class="ec-tip-head">
      <span class="ec-tip-date">${esc(date)}</span>
      <span class="ec-tip-sum">${esc(sumTxt)}</span>
    </div>
    <div class="ec-tip-body">${body}${rest > 0 ? `<div class="ec-tip-more">另有 ${rest} 项…</div>` : ""}</div>
    ${p.footNote ? `<div class="ec-tip-foot"><span>${esc(p.footNote)}</span><span>${p.focused ? "已聚焦：" + esc(p.focused) : ""}</span></div>` : ""}
  </div>`;
}

/** 渲染主图；p: { dates, series, mode, unit, zoom:[a,b], focused, compare, secondary, footNote, endLabels } */
export function renderMain(p) {
  if (!main.ec) return;
  // 图窗自适应：按布局与指标数量给画布高度
  const wantedH = p?.focusMode ? (p.layout === "panes" ? p.heightPanes : p.heightAxes) : p?.height;
  if (wantedH && main.el) {
    const next = `${wantedH}px`;
    if (main.el.style.height !== next) {
      main.el.style.height = next;
      try {
        main.ec.resize();
      } catch (e) {}
    }
  }
  main.lastPayload = p;
  // 先收起 tooltip：避免 setOption 重建时 ECharts 内部仍在定位已移除的浮层（会抛 null.offsetWidth）
  try {
    main.ec.dispatchAction({ type: "hideTip" });
  } catch (e) {}
  const opt = baseOption(p);
  main.ec.setOption(opt, { replaceMerge: ["series", "yAxis", "xAxis", "dataZoom", "grid", "tooltip", "toolbox"], lazyUpdate: true });
  main.firstRender = false;
  scheduleLabels();
}

export function setBrushMode(on) {
  if (!main.ec) return;
  main.brushOn = on;
  try {
    main.ec.dispatchAction({
      type: "takeGlobalCursor",
      key: "brush",
      brushOption: on ? { brushType: "lineX" } : { brushType: "false" },
    });
    if (!on) main.ec.dispatchAction({ type: "brush", areas: [] });
  } catch (e) {
    /* 某些版本对 brushType:false 不支持，忽略 */
  }
}

export function clearBrush() {
  try {
    main.ec?.dispatchAction({ type: "brush", areas: [] });
  } catch (e) {}
}

export function resizeMain() {
  main.ec?.resize();
  scheduleLabels();
}

export function disposeMain() {
  try {
    main.ec?.dispose();
  } catch (e) {}
  main.ec = null;
}

/* ==========================================================================
   市场总览图（沪深 + 合计）
   ========================================================================== */
export const market = { ec: null, el: null, lastPayload: null };

export async function initMarket(el) {
  const echarts = await ensureEcharts();
  market.el = el;
  market.ec = echarts.init(el, null, { renderer: "canvas", useDirtyRect: true });
  const ro = new ResizeObserver(throttleRAF(() => market.ec?.resize()));
  ro.observe(el);
  return market.ec;
}

export function renderMarket(p) {
  market.lastPayload = p;
  if (!market.ec) return;
  try {
    market.ec.dispatchAction({ type: "hideTip" });
  } catch (e) {}
  const t = tokens();
  const dates = p.dates;
  const unit = p.unit;
  const colorA = t.accent;
  const colorB = toneColor("#0E9C9C", t.dark);
  const colorT = t.ink3;
  const mk = (name, data, color, extra = {}) => ({
    name,
    type: "line",
    data,
    showSymbol: false,
    symbol: "circle",
    symbolSize: 4,
    smooth: 0.15,
    sampling: "lttb",
    connectNulls: true,
    lineStyle: { width: extra.width || 1.8, color, type: extra.dash ? [4, 3] : "solid" },
    itemStyle: { color },
    emphasis: { focus: "series" },
    areaStyle: extra.area
      ? {
          opacity: 0.11,
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color },
              { offset: 1, color: "rgba(0,0,0,0)" },
            ],
          },
        }
      : undefined,
    animation: false,
  });

  const series = [
    mk("沪市", p.sh, colorA, { area: true }),
    mk("深市", p.sz, colorB, { area: true }),
    mk("合计", p.total, colorT, { dash: true, width: 1.4 }),
  ];

  market.ec.setOption(
    {
      animation: false,
      grid: { left: 2, right: 8, top: 10, bottom: 4, containLabel: true },
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
      tooltip: {
        trigger: "axis",
        confine: true,
        appendToBody: true,
        className: "ec-tip",
        borderWidth: 0,
        padding: 0,
        backgroundColor: "transparent",
        axisPointer: { type: "line", lineStyle: { color: t.gridStrong, type: [4, 4] } },
        formatter: (params) => {
          const rows = (Array.isArray(params) ? params : []).filter((x) => x.value != null);
          const d = rows[0]?.axisValue || "";
          return `<div class="ec-tip"><div class="ec-tip-head"><span class="ec-tip-date">${esc(d)}</span><span class="ec-tip-sum">${esc(unit)}</span></div><div class="ec-tip-body">${rows
            .map(
              (r) =>
                `<div class="ec-tip-row"><span class="ec-tip-swatch" style="--c:${r.color}"></span><span class="ec-tip-name">${esc(
                  r.seriesName
                )}</span><span class="ec-tip-val">${esc(cnum(r.value, 1))}</span><span class="ec-tip-pct"></span></div>`
            )
            .join("")}</div></div>`;
        },
      },
      xAxis: {
        type: "category",
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: t.line } },
        axisTick: { show: false },
        axisLabel: { color: t.ink4, fontSize: AXIS_FONT, hideOverlap: true, formatter: (v, i) => xLabel(v, i, dates) },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitNumber: 3,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.ink4, fontSize: AXIS_FONT, formatter: (v) => axisNum(v) },
        splitLine: { lineStyle: { color: t.grid, type: [3, 3] } },
      },
      series,
    },
    { replaceMerge: ["series", "yAxis", "xAxis"] }
  );
}

export function resizeMarket() {
  market.ec?.resize();
}

/* ==========================================================================
   迷你图（抽屉/对比用）
   ========================================================================== */
export function createMiniChart(el, opts = {}) {
  let ec = null;
  let disposed = false;
  ensureEcharts()
    .then((echarts) => {
      if (disposed || !el.isConnected) return;
      ec = echarts.init(el, null, { renderer: "canvas", useDidUpdate: true });
      const ro = new ResizeObserver(throttleRAF(() => ec?.resize()));
      ro.observe(el);
      update(opts);
    })
    .catch(() => {});
  function update(p = {}) {
    if (!ec) {
      Object.assign(opts, p);
      return;
    }
    const t = tokens();
    const dates = p.dates || opts.dates || [];
    const values = p.values || opts.values || [];
    const color = toneColor(p.color || opts.color || t.accent, t.dark);
    ec.setOption(
      {
        animation: false,
        grid: { left: 0, right: 0, top: 6, bottom: 0, containLabel: false },
        tooltip: {
          trigger: "axis",
          confine: true,
          appendToBody: true,
          className: "ec-tip",
          borderWidth: 0,
          padding: 0,
          backgroundColor: "transparent",
          axisPointer: { type: "line", lineStyle: { color: t.gridStrong, type: [3, 3] } },
          formatter: (params) => {
            const r = (params || [])[0];
            if (!r) return "";
            return `<div class="ec-tip"><div class="ec-tip-head"><span class="ec-tip-date">${esc(r.axisValue)}</span><span class="ec-tip-sum">${esc(p.unit || "")}</span></div><div class="ec-tip-body"><div class="ec-tip-row"><span class="ec-tip-swatch" style="--c:${color}"></span><span class="ec-tip-name">${esc(r.seriesName || "")}</span><span class="ec-tip-val">${esc(cnum(r.value, 1))}</span></div></div></div>`;
          },
        },
        xAxis: {
          type: "category",
          data: dates,
          boundaryGap: false,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false },
        },
        series: [
          {
            name: p.name || opts.name || "",
            type: "line",
            data: values,
            showSymbol: false,
            smooth: 0.12,
            sampling: "lttb",
      triggerLineEvent: true,
            connectNulls: true,
            lineStyle: { width: 1.8, color },
            itemStyle: { color },
            areaStyle: {
              opacity: 0.12,
              color: {
                type: "linear",
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color },
                  { offset: 1, color: "rgba(0,0,0,0)" },
                ],
              },
            },
          },
        ],
      },
      { replaceMerge: ["series"] }
    );
  }
  return {
    update,
    dispose() {
      disposed = true;
      try {
        ec?.dispose();
      } catch (e) {}
      ec = null;
    },
    resize: () => ec?.resize(),
  };
}

/** 收起所有图表浮层（切视图/切大类时调用，避免 ECharts 定位已隐藏容器的浮层） */
export function hideTooltips() {
  for (const c of [main.ec, market.ec]) {
    try {
      c?.dispatchAction({ type: "hideTip" });
    } catch (e) {}
  }
}

/** 主题切换后重建配色（不重建实例，直接覆盖 option） */
export function repaintAll() {
  if (main.lastPayload) renderMain({ ...main.lastPayload });
  if (market.lastPayload) renderMarket(market.lastPayload);
}
