/* ==========================================================================
   util：DOM / 格式化 / CSV / 迷你图 / 颜色 / 事件小工具
   约定：所有对外字符串一律先 esc()，避免 XSS；数字统一走 tabular-nums 类。
   ========================================================================== */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const esc = (v) =>
  v == null
    ? ""
    : String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 创建元素（轻量版本，属性支持 data-* / aria-* / style / class） */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const html = (strings, ...vals) =>
  strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i] == null ? "" : String(vals[i])) : ""), "");

export const isDesktop = () => window.matchMedia("(min-width: 769px)").matches;
export const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
  document.documentElement.getAttribute("data-motion") === "off";

/* ---------------------------- 数字格式化 ---------------------------- */
const MINUS = "-"; // 用 ASCII 连字符，保证复制/导出与 Excel 兼容

export function fmt(v, dp = 1) {
  if (v == null || !Number.isFinite(+v)) return "—";
  return Number(v).toLocaleString("zh-CN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtSigned(v, dp = 1) {
  if (v == null || !Number.isFinite(+v)) return "—";
  const s = fmt(Math.abs(v), dp);
  return (v > 0 ? "+" : v < 0 ? MINUS : "") + s;
}

export function fmtPct(v, dp = 2) {
  if (v == null || !Number.isFinite(+v)) return "—";
  return (v > 0 ? "+" : v < 0 ? MINUS : "") + Math.abs(v).toFixed(dp) + "%";
}

/** 亿 → 万亿 自动降级；返回 { num, unit, dp } */
export function big(v, unit = "亿") {
  if (v == null || !Number.isFinite(+v)) return { num: "—", unit: "", dp: 0 };
  const a = Math.abs(v);
  if (a >= 10000) return { num: fmt(v / 10000, 2), unit: "万" + unit, dp: 2 };
  if (a >= 100) return { num: fmt(v, 1), unit, dp: 1 };
  return { num: fmt(v, 1), unit, dp: 1 };
}

/** 坐标轴刻度：紧凑、带万亿换算、去掉多余小数 */
export function axisNum(v) {
  if (v == null || !Number.isFinite(+v)) return "";
  const a = Math.abs(v);
  if (a >= 10000) {
    const n = v / 10000;
    return (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, "")) + "万亿";
  }
  if (a >= 1000) return fmt(v, 0);
  if (a >= 10) return fmt(v, 0);
  if (a >= 1) return fmt(v, 1);
  if (a === 0) return "0";
  return v.toFixed(2);
}

/** 表格单元格用的紧凑数字（不换单位，只加千分位） */
export const cnum = (v, dp = 1) => (v == null || !Number.isFinite(+v) ? "—" : fmt(v, dp));

export const clsDir = (v) => (v == null ? "flat" : v > 0 ? "up" : v < 0 ? "down" : "flat");
export const dirCn = (v) => (v > 0 ? "增加" : v < 0 ? "减少" : "持平");

/* ---------------------------- 日期 ---------------------------- */
export const ymd = (s) => (typeof s === "string" ? s.slice(0, 10) : "");
export const mdCn = (s) => {
  const [y, m, d] = ymd(s).split("-");
  return y ? `${Number(m)}/${Number(d)}` : "";
};
export const ymdCn = (s) => {
  const [y, m, d] = ymd(s).split("-");
  return y ? `${y}-${m}-${d}` : "";
};
export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addMonths(dateStr, n) {
  const [y, m, d] = ymd(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, d));
  const p = (v) => String(v).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/* ---------------------------- 事件 / 时序 ---------------------------- */
export function debounce(fn, wait = 120) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

export function throttleRAF(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

export const once = (fn) => {
  let done = false;
  return (...a) => {
    if (done) return;
    done = true;
    fn(...a);
  };
};

/* ---------------------------- CSV / 下载 / 复制 ---------------------------- */
export function toCSV(rows) {
  const body = rows
    .map((r) =>
      r
        .map((cell) => {
          const s = cell == null ? "" : String(cell);
          return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join(",")
    )
    .join("\r\n");
  return "\ufeff" + body; // BOM：Excel 打开中文不乱码
}

export function download(filename, text, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    /* 继续走兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

/** 表格 → TSV（复制到 Excel/飞书可直接粘） */
export const toTSV = (rows) => rows.map((r) => r.map((c) => (c == null ? "" : String(c))).join("\t")).join("\n");

/* ---------------------------- 迷你图（纯 SVG） ---------------------------- */
/** 等距抽样（保留首尾），用于 sparkline 与 tooltip 之外的轻量渲染 */
export function sampleSeries(values, maxPoints = 90) {
  const n = values.length;
  if (n <= maxPoints) return values.map((v, i) => [i, v]);
  const step = (n - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * step);
    out.push([idx, values[idx]]);
  }
  return out;
}

/**
 * 生成 sparkline 的 SVG 片段。
 * @param {number[]} values 序列（可含 null）
 * @param {object} opt { w,h,color,area,stroke,min,max,baseline }
 */
export function sparkSVG(values, opt = {}) {
  const w = opt.w || 100;
  const h = opt.h || 28;
  const pad = 1.5;
  const pts = sampleSeries(values, opt.points || 90);
  const nums = pts.map((p) => p[1]).filter((v) => v != null && Number.isFinite(v));
  if (nums.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  let lo = opt.min != null ? opt.min : Math.min(...nums);
  let hi = opt.max != null ? opt.max : Math.max(...nums);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const sx = (i) => pad + (i / (pts.length - 1 || 1)) * (w - pad * 2);
  const sy = (v) => pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2);
  const color = opt.color || "currentColor";
  let line = "";
  let area = "";
  let seg = [];
  const segs = [];
  for (const [i, v] of pts) {
    if (v == null || !Number.isFinite(v)) {
      if (seg.length) segs.push(seg);
      seg = [];
      continue;
    }
    seg.push([sx(i), sy(v)]);
  }
  if (seg.length) segs.push(seg);
  for (const s of segs) {
    if (s.length < 2) continue;
    line += "M" + s.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L");
  }
  const last = segs[segs.length - 1];
  if (last && last.length > 1) {
    const first = last[0];
    const end = last[last.length - 1];
    area = `M${first[0].toFixed(1)} ${h - pad}L${last
      .map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1))
      .join("L")}L${end[0].toFixed(1)} ${h - pad}Z`;
  }
  const strokeW = opt.stroke || 1.5;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    ${opt.area ? `<path d="${area}" fill="${color}" class="spark-area" stroke="none"></path>` : ""}
    <path d="${line}" fill="none" stroke="${color}" stroke-width="${strokeW}" class="spark-line"></path>
    ${opt.dot !== false && last && last.length ? `<circle cx="${last[last.length - 1][0].toFixed(1)}" cy="${last[last.length - 1][1].toFixed(1)}" r="2" fill="${color}"></circle>` : ""}
  </svg>`;
}

/* ---------------------------- 颜色 ---------------------------- */
const hex2rgb = (hex) => {
  const h = String(hex || "").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [120, 130, 150];
};
const rgb2hex = (r, g, b) =>
  "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");

export const luminance = (hex) => {
  const [r, g, b] = hex2rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const isDark = () => {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

/** 深色主题下把数据色提亮，浅色主题下压暗过亮的色，保证可辨识 */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(v * 255);
  };
  return rgb2hex(f(0), f(8), f(4));
}

// CIE Lab：深色主题统一抬 L*、浅色主题统一压 L*，尽量守住同大类内的 ΔE
function rgbToLab(r, g, b) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

function labToHex(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t) => (t > 0.2069 ? t * t * t : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const R = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  const G = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  const B = X * 0.0557 + Y * -0.204 + Z * 1.057;
  const gamma = (c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return clamp(Math.round(v * 255), 0, 255);
  };
  return rgb2hex(gamma(R), gamma(G), gamma(B));
}

export function toneColor(hex, dark = isDark()) {
  // 保证对背景 ≥3:1 的同时，用 Lab 的 L* 平移而不是混白/压暗，尽量不压缩同大类内 ΔE
  const bgLum = dark ? 0.0041 : 1; // #0b0c0f / #ffffff
  const contrastOf = (h) => {
    const a = luminance(h);
    const hi = Math.max(a, bgLum), lo = Math.min(a, bgLum);
    return (hi + 0.05) / (lo + 0.05);
  };
  if (contrastOf(hex) >= 3.02) return hex;
  const [r, g, b] = hex2rgb(hex);
  const [L, a, bb] = rgbToLab(r, g, b);
  let out = hex;
  let shift = 0;
  for (let i = 0; i < 30 && contrastOf(out) < 3.02; i++) {
    shift += dark ? 2.4 : -2.4;
    out = labToHex(clamp(L + shift, 0, 100), a, bb);
    if (L + shift <= 0 || L + shift >= 100) break;
  }
  return out;
}

export const cssVar = (name, root = document.documentElement) =>
  getComputedStyle(root).getPropertyValue(name).trim();

/** 给数值型 span 上色（涨红跌绿，0 灰） */
export function dirSpan(v, text, extra = "") {
  return `<span class="${extra} ${clsDir(v)}">${esc(text)}</span>`;
}

/* ---------------------------- 占位 ---------------------------- */
export function skeletonRows(cols, rows = 3) {
  return Array.from({ length: rows })
    .map(
      () =>
        `<tr>${Array.from({ length: cols })
          .map((_, i) => `<td><span class="sk sk-line" style="width:${i === 0 ? 60 : 42}%;display:inline-block"></span></td>`)
          .join("")}</tr>`
    )
    .join("");
}

export function emptyState(title, desc, action = "") {
  return `<div class="state">
    <div class="state-ico" aria-hidden="true"><svg width="20" height="20"><use href="#i-info"/></svg></div>
    <p class="state-title">${esc(title)}</p>
    <p class="state-desc">${esc(desc)}</p>
    ${action}
  </div>`;
}

/** 简单焦点陷阱：返回释放函数 */
export function trapFocus(container) {
  const sel =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const items = $$(sel, container).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  container.addEventListener("keydown", onKey);
  return () => container.removeEventListener("keydown", onKey);
}
