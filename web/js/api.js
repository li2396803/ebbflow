// @ts-check
/* ==========================================================================
   api：数据加载（静态 JSON 优先 → 本地服务 API 兜底）、缓存、并发去重
   --------------------------------------------------------------------------
   静态托管（GitHub Pages 子路径）下必须用相对路径 data/xxx.json 才能工作；
   本地服务（127.0.0.1:5188）则可以直接走 /api/*（数据更新更及时）。
   两条路都失败 → 抛出 ApiError，由上层渲染错误态，绝不白屏。
   ========================================================================== */

const STATIC_DIR = "data";
// 相对路径：本地服务在站点根（/api），GitHub Pages 子路径（如 /ebbflow/api）也能正确拼接
const API_PREFIX = "api";

/** 当前分类口径对应的数据子目录：v2 → ""（data/），legacy → "legacy"（data/legacy/） */
let TAX_BASE = "";
const KEY_SETS = { "": [], legacy: [] };
export function setTaxonomy(taxonomy) {
  TAX_BASE = taxonomy === "legacy" ? "legacy" : "";
}
export const taxonomyBase = () => TAX_BASE;

/**
 * 本地服务探测：默认端口 5188（node server.mjs）才探测，静态托管（Pages）直接跳过，
 * 避免每次打开站点都产生一次 /api/status 404。特殊端口可用 ?api=1 强制探测。
 */
function mayHaveService() {
  try {
    if (new URLSearchParams(location.search).has("api")) return true;
  } catch {}
  return location.port === "5188";
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
const RETRY_DELAY = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------------
   JSON 解析：大文件交给 Worker，主线程不长任务
   -------------------------------------------------------------------------- */
let parseWorker = null;
let parseSeq = 0;
const parsePending = new Map();
const PARSE_TIMEOUT = 5000;
const PARSE_WORKER_THRESHOLD = 64 * 1024; // 64KB 以下直接解析，省掉 postMessage 往返

function failParseWorker(reason) {
  for (const [id, entry] of parsePending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    parsePending.delete(id);
  }
  if (parseWorker) {
    parseWorker.terminate();
    parseWorker = null;
  }
}

function getParseWorker() {
  if (parseWorker) return parseWorker;
  if (typeof Worker === "undefined") return null;
  try {
    parseWorker = new Worker(new URL("./parse-worker.js", import.meta.url), { type: "module" });
    parseWorker.onmessage = (event) => {
      const { id, ok, data, error } = event.data || {};
      const entry = parsePending.get(id);
      if (!entry) return;
      parsePending.delete(id);
      clearTimeout(entry.timer);
      if (ok) entry.resolve(data);
      else entry.reject(new Error(error || "JSON 解析失败"));
    };
    parseWorker.onerror = () => failParseWorker("parse worker error");
  } catch (e) {
    parseWorker = null;
  }
  return parseWorker;
}

/** 解析 JSON 文本：优先 Worker，失败/超时回退主线程 */
async function parseJSONText(text) {
  if (typeof text !== "string") return text;
  if (text.length < PARSE_WORKER_THRESHOLD) return JSON.parse(text);
  const worker = getParseWorker();
  if (!worker) return JSON.parse(text);
  const id = ++parseSeq;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        parsePending.delete(id);
        failParseWorker("parse timeout");
        reject(new Error("parse timeout"));
      }, PARSE_TIMEOUT);
      parsePending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, text });
    });
  } catch (e) {
    return JSON.parse(text);
  }
}

/** 网络错误/超时重试一次（300ms 退避）；HTTP 4xx 不重试（没意义） */
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
        return await parseJSONText(text);
      } catch (e) {
        throw new Error("返回内容不是 JSON");
      }
    }
    return await parseJSONText(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

/** key → 静态文件名 / API 路径（两套口径各自独立目录） */
function paths(key) {
  const dir = TAX_BASE ? `${STATIC_DIR}/${TAX_BASE}` : STATIC_DIR;
  const api = TAX_BASE ? `${API_PREFIX}/${TAX_BASE}` : API_PREFIX;
  if (key.startsWith("charts:")) {
    const cat = key.slice(7);
    return { static: `${dir}/charts-${encodeURIComponent(cat)}.json`, api: `${api}/charts/${encodeURIComponent(cat)}` };
  }
  return { static: `${dir}/${key}.json`, api: `${api}/${key}` };
}

/**
 * 按 key 载入数据（带缓存与并发去重）。
 * @param {string} key meta|tables|subs|index|quality|market|charts:<catKey>
 */
export function load(key) {
  // 缓存键带上口径，避免两套 taxonomy 串数据
  const base = TAX_BASE;
  // 防御：另一个口径的 catKey 不要用当前目录去请求（切口径瞬间的延迟调用会产生 404）
  if (key.startsWith("charts:")) {
    const cat = key.slice(7);
    const mine = KEY_SETS[base] || [];
    const other = KEY_SETS[base === "legacy" ? "" : "legacy"] || [];
    const invalid = (mine.length && !mine.includes(cat)) || (!mine.length && other.includes(cat));
    if (invalid) {
      return Promise.reject(new ApiError(`小类 ${cat} 不属于当前分类口径`, { stale: true, key }));
    }
  }
  const cacheKey = base ? `${base}::${key}` : key;
  if (cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey));
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const { static: staticUrl, api: apiUrl } = paths(key);
  const p = (async () => {
    const attempt = async (url) => {
      try {
        return await getJSON(url);
      } catch (e) {
        if (e?.name === "AbortError" || /HTTP 4/.test(String(e?.message))) throw e;
        // 网络错误 / 超时：退避 300ms 重试一次
        await sleep(RETRY_DELAY);
        return await getJSON(url);
      }
    };
    let staticErr = null;
    try {
      const data = await attempt(staticUrl);
      if (!data || typeof data !== "object") throw new Error("空数据");
      if (base !== TAX_BASE) throw new ApiError("已切换分类口径，丢弃过期响应", { stale: true, key });
      net.mode = net.mode === "live" ? "live" : "static";
      cache.set(cacheKey, data);
      return data;
    } catch (e) {
      if (e?.detail?.stale) throw e;
      staticErr = e;
    }
    try {
      const data = await attempt(apiUrl);
      if (!data || typeof data !== "object") throw new Error("空数据");
      if (base !== TAX_BASE) throw new ApiError("已切换分类口径，丢弃过期响应", { stale: true, key });
      net.mode = "live";
      cache.set(cacheKey, data);
      return data;
    } catch (apiErr) {
      if (apiErr?.detail?.stale) throw apiErr;
      const msg = `无法加载 ${key}：静态(${staticErr?.message || "失败"}) / 服务(${apiErr?.message || "失败"})`;
      net.lastError = msg;
      errors.push({ key, staticUrl, apiUrl, staticErr: staticErr?.message, apiErr: apiErr?.message });
      if (!net.mode) net.mode = "error";
      throw new ApiError(msg, { key, staticUrl, apiUrl });
    }
  })();
  inflight.set(cacheKey, p);
  // 无论成功失败都要清掉 inflight：失败的 Promise 留在 map 里会让后续所有调用复用同一个 rejection
  p.finally(() => {
    if (inflight.get(cacheKey) === p) inflight.delete(cacheKey);
  }).catch(() => {});
  return p;
}

export const isStale = (e) => !!(e && e.detail && e.detail.stale);

export const peek = (key) => cache.get(TAX_BASE ? `${TAX_BASE}::${key}` : key);
export const isLoaded = (key) => cache.has(TAX_BASE ? `${TAX_BASE}::${key}` : key);
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
  KEY_SETS[TAX_BASE] = Array.from(CAT_KEYS.keys());
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
