/* ==========================================================================
   api：数据加载（静态 JSON 优先 → 本地服务 API 兜底）、缓存、并发去重
   --------------------------------------------------------------------------
   静态托管（GitHub Pages 子路径）下必须用相对路径 data/xxx.json 才能工作；
   本地服务（127.0.0.1:5188）则可以直接走 /api/*（数据更新更及时）。
   两条路都失败 → 抛出 ApiError，由上层渲染错误态，绝不白屏。
   ========================================================================== */

const STATIC_DIR = "data";
// 相对路径：本地服务在站点根（/api），GitHub Pages 子路径（/etf-flow/api）也能正确拼接
const API_PREFIX = "api";

/** 只有本机/文件协议才可能跑着本地服务；静态托管时直接跳过探测，避免控制台 404 噪音 */
function mayHaveService() {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "" || location.protocol === "file:";
}

const cache = new Map(); // key -> data
const inflight = new Map(); // key -> Promise
const errors = []; // 失败记录（用于错误态与诊断）

export const net = {
  /** 'static' | 'live' | 'error' | null */
  mode: null,
  lastError: "",
  /** 本地服务能力探测：/api/status 是否可达（决定「刷新」按钮是否可用） */
  hasService: false,
};

export class ApiError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "ApiError";
    this.detail = detail;
  }
}

const TIMEOUT = 15000;

async function getJSON(url, { timeout = TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-cache",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (!/json|javascript/i.test(type)) {
      // 有些静态服务器会把 404 页面以 200 返回 text/html，这里识别并当作失败
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error("返回内容不是 JSON");
      }
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** key → 静态文件名 / API 路径 */
function paths(key) {
  if (key.startsWith("charts:")) {
    const cat = key.slice(7);
    return { static: `${STATIC_DIR}/charts-${encodeURIComponent(cat)}.json`, api: `${API_PREFIX}/charts/${encodeURIComponent(cat)}` };
  }
  return { static: `${STATIC_DIR}/${key}.json`, api: `${API_PREFIX}/${key}` };
}

/**
 * 按 key 载入数据（带缓存与并发去重）。
 * @param {string} key meta|tables|subs|index|quality|market|charts:<catKey>
 */
export function load(key) {
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (inflight.has(key)) return inflight.get(key);
  const { static: staticUrl, api: apiUrl } = paths(key);
  const p = (async () => {
    let staticErr = null;
    try {
      const data = await getJSON(staticUrl);
      if (!data || typeof data !== "object") throw new Error("空数据");
      net.mode = net.mode === "live" ? "live" : "static";
      cache.set(key, data);
      return data;
    } catch (e) {
      staticErr = e;
    }
    try {
      const data = await getJSON(apiUrl);
      if (!data || typeof data !== "object") throw new Error("空数据");
      net.mode = "live";
      cache.set(key, data);
      return data;
    } catch (apiErr) {
      const msg = `无法加载 ${key}：静态(${staticErr?.message || "失败"}) / 服务(${apiErr?.message || "失败"})`;
      net.lastError = msg;
      errors.push({ key, staticUrl, apiUrl, staticErr: staticErr?.message, apiErr: apiErr?.message });
      if (!net.mode) net.mode = "error";
      throw new ApiError(msg, { key, staticUrl, apiUrl });
    }
  })();
  inflight.set(key, p);
  p.catch(() => {}).finally(() => inflight.delete(key));
  return p;
}

export const peek = (key) => cache.get(key);
export const isLoaded = (key) => cache.has(key);
export const failures = () => errors.slice();

/** 探测本地服务（用于刷新按钮/数据源徽标） */
export async function probeService() {
  if (!mayHaveService()) {
    net.hasService = false;
    return false;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${API_PREFIX}/status`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    net.hasService = res.ok;
  } catch (e) {
    net.hasService = false;
  }
  return net.hasService;
}

/** 触发后端增量更新（仅本地服务可用） */
export async function refresh() {
  const res = await fetch(`${API_PREFIX}/refresh`, { method: "POST", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`刷新失败：HTTP ${res.status}`);
  return res.json();
}

/** 清空缓存（refresh 后重新拉取） */
export function clearCache() {
  cache.clear();
  inflight.clear();
}

const CAT_KEYS = new Map();

/** 记录大类 key 列表（来自 tables.cats，用于「全部小类」金额口径的按需加载） */
export function rememberCatKeys(keys) {
  CAT_KEYS.clear();
  for (const k of keys) CAT_KEYS.set(k, true);
}

export const catKeys = () => Array.from(CAT_KEYS.keys());

/** 并行加载全部大类的图表（金额口径 / 全局对比才需要，约 1.2–1.7MB） */
export async function loadAllCharts(onProgress) {
  const keys = catKeys();
  let done = 0;
  const out = {};
  await Promise.all(
    keys.map(async (k) => {
      try {
        out[k] = await load(`charts:${k}`);
      } catch (e) {
        out[k] = null;
      } finally {
        done += 1;
        onProgress?.(done, keys.length);
      }
    })
  );
  return out;
}
