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
export function ensureEcharts(timeout = 12000) {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (echartsReady) return echartsReady;
  echartsReady = new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      if (window.echarts) return resolve(window.echarts);
      if (performance.now() - t0 > timeout) return reject(new Error("图表库加载超时"));
      setTimeout(tick, 80);
    };
    tick();
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
export const main = {
  ec: null,
  el: null,
  shell: null,
  lastPayload: null,
  firstRender: true,
  labelsLayer: null,
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
  main.ec.on("rendered", scheduleLabels);
  main.ec.getZr().on("mouseup", scheduleLabels);

  const ro = new ResizeObserver(throttleRAF(() => {
    main.ec?.resize();
    scheduleLabels();
  }));
  ro.observe(el);

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
    paintEndLabels();
  });
}

/** 端点标签：在窗口末端对齐每个系列最新值，自动避让，不重叠 */
function paintEndLabels() {
  const layer = main.labelsLayer;
  const p = main.lastPayload;
  if (!layer) return;
  if (!p || !p.endLabels || !isDesktop() || p.mode === "bar") {
    layer.innerHTML = "";
    return;
  }
  const chart = main.ec;
  if (!chart || chart.isDisposed()) return;
  const [a, b] = readZoom();
  if (a == null) {
    layer.innerHTML = "";
    return;
  }
  const rect = chart.getModel()?.getComponent("grid")?.coordinateSystem?.getRect?.();
  if (!rect) return;
  const items = [];
  for (const s of p.endLabels) {
    if (s.value == null || !Number.isFinite(s.value)) continue;
    const y = chart.convertToPixel({ yAxisIndex: 0 }, s.value);
    if (!Number.isFinite(y)) continue;
    items.push({ name: s.name, value: s.value, color: s.color, y });
  }
  if (!items.length) {
    layer.innerHTML = "";
    return;
  }
  items.sort((m, n) => m.y - n.y);
  const GAP = 15;
  const top = rect.y + 6;
  const bottom = rect.y + rect.height - 2;
  for (let i = 0; i < items.length; i++) {
    if (i === 0) items[i].y = Math.max(top, items[i].y);
    else items[i].y = Math.max(items[i].y, items[i - 1].y + GAP);
  }
  const overflow = items[items.length - 1].y - bottom;
  if (overflow > 0) {
    for (let i = items.length - 1; i >= 0; i--) {
      items[i].y -= overflow;
      if (i > 0 && items[i].y - items[i - 1].y < GAP) items[i - 1].y = items[i].y - GAP;
    }
  }
  const right = rect.x + rect.width - 2;
  layer.innerHTML = items
    .map(
      (it) => `<span class="elab" style="top:${(it.y - 8).toFixed(1)}px;right:${Math.max(
        0,
        (layer.clientWidth || rect.x + rect.width) - right
      ).toFixed(1)}px;--c:${it.color}">
        <i class="elab-dot"></i><span class="elab-name">${esc(it.name)}</span><span class="elab-val">${esc(
        p.endLabelDigits === 1 ? cnum(it.value, 1) : cnum(it.value, Math.abs(it.value) >= 100 ? 0 : 1)
      )}</span>
      </span>`
    )
    .join("");
}

/* ---------------------------- option 构造 ---------------------------- */
function baseOption(p) {
  const t = tokens();
  const dates = p.dates;
  const isBar = p.mode === "bar";
  const showSlider = isDesktop() && !p.compare;
  const [a, b] = p.zoom;

  const series = p.series.map((s, i) => {
    const color = toneColor(s.color, t.dark);
    const dim = p.focused && p.focused !== s.name;
    const opacity = dim ? 0.13 : 1;
    if (isBar) {
      return {
        name: s.name,
        type: "bar",
        data: s.values,
        barMaxWidth: 7,
        barGap: "12%",
        barCategoryGap: "38%",
        sampling: "lttb",
        itemStyle: {
          color: (params) => (params.value >= 0 ? t.up : t.down),
          opacity: dim ? 0.18 : 0.95,
          borderRadius: [1, 1, 0, 0],
        },
        emphasis: { focus: "series", itemStyle: { opacity: 1 } },
        blur: { itemStyle: { opacity: 0.12 } },
        z: p.focused === s.name ? 4 : 2,
        animation: false,
      };
    }
    return {
      name: s.name,
      type: "line",
      data: s.values,
      showSymbol: false,
      symbol: "circle",
      symbolSize: 5,
      connectNulls: false,
      smooth: 0.12,
      sampling: "lttb",
      lineStyle: { width: p.focused === s.name ? 2.4 : 1.7, color, opacity },
      itemStyle: { color, opacity },
      emphasis: { focus: "series", lineStyle: { width: 2.6 }, itemStyle: { opacity: 1 } },
      blur: { lineStyle: { opacity: 0.12 }, itemStyle: { opacity: 0.12 } },
      areaStyle:
        p.area && p.series.length <= 3
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
      z: p.focused === s.name ? 4 : 2,
      animation: false,
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
      zoomOnMouseWheel: true,
      moveOnMouseMove: true,
      moveOnMouseWheel: false,
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
      right: 26,
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
      boundaryGap: isBar,
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
    yAxis: {
      type: p.log ? "log" : "value",
      logBase: 10,
      scale: p.zero !== true && !p.log,
      splitNumber: p.log ? 5 : 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: t.ink4,
        fontSize: AXIS_FONT,
        margin: 8,
        formatter: (v) => axisNum(v),
      },
      splitLine: { lineStyle: { color: t.grid, type: [3, 3] } },
      axisPointer: { label: { show: false } },
    },
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
      color: x.color || toneColor(p.series.find((s) => s.name === x.seriesName)?.color || "#888", tokens().dark),
    }));
  if (!rows.length) return "";
  rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const sum = rows.reduce((s, r) => s + r.value, 0);
  const unit = p.unit || "";
  const isPct = p.unit === "%";
  const maxRows = 12;
  const shown = rows.slice(0, isDesktop() ? maxRows : 8);

  const body = shown
    .map((r) => {
      const active = p.focused === r.name ? " is-active" : "";
      let right = "";
      let rightCls = "";
      if (p.secondary) {
        // 第二列：变化率（相对区间起点）/ 原始值
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
      const val = isPct ? fmtPct(r.value, 2) : p.mode === "bar" ? cnum(r.value, 2) : cnum(r.value, 1);
      return `<div class="ec-tip-row${active}">
        <span class="ec-tip-swatch" style="--c:${r.color}"></span>
        <span class="ec-tip-name">${esc(r.name)}</span>
        <span class="ec-tip-val">${esc(val)}</span>
        <span class="ec-tip-pct ${rightCls}">${esc(right)}</span>
      </div>`;
    })
    .join("");

  const rest = rows.length - shown.length;
  const sumTxt = p.secondary?.type === "pct"
    ? ""
    : p.mode === "bar"
      ? `合计 ${cnum(sum, 1)}`
      : p.compare
        ? ""
        : `合计 ${isPct ? "" : cnum(sum, 1)}`;

  return `<div class="ec-tip">
    <div class="ec-tip-head">
      <span class="ec-tip-date">${esc(date)}</span>
      <span class="ec-tip-sum">${esc(sumTxt)}${unit && !isPct ? " " + esc(unit) : ""}</span>
    </div>
    <div class="ec-tip-body">${body}${rest > 0 ? `<div class="ec-tip-more">另有 ${rest} 项…</div>` : ""}</div>
    ${p.footNote ? `<div class="ec-tip-foot"><span>${esc(p.footNote)}</span><span>${p.focused ? "已聚焦：" + esc(p.focused) : ""}</span></div>` : ""}
  </div>`;
}

/** 渲染主图；p: { dates, series, mode, unit, zoom:[a,b], focused, compare, secondary, footNote, endLabels } */
export function renderMain(p) {
  if (!main.ec) return;
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
