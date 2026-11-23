// @ts-check
/* ==========================================================================
   quote：按需实时报价（仅本地服务/自建后端可用）
   --------------------------------------------------------------------------
   · 后端：GET /api/quote?codes=159915,510300（最多 40 个 6 位代码）
     深市 realtime=true（交易所实时），沪市 realtime=false（最近收盘）
   · 静态托管（GitHub Pages / 任意静态服务器）没有后端：默认不启用、不请求，
     表格保持原样（收盘价列），不产生 404。
   · 启用条件（满足其一）：端口 5188（node server.mjs）/ <meta name="ebbflow-api">
     / URL 带 ?api=1（自建部署或自测用）。404/明确不可用后写入 sessionStorage，
     本次会话不再请求。
   ========================================================================== */
import { cnum, esc } from "./util.js";

const TTL = 60_000; // 同一代码 60s 内复用
const FAIL_BACKOFF = 30_000;
const OFF_KEY = "ebbflow-quote:off";

/** @type {Map<string, {price:number, at?:string, market?:string, realtime?:boolean, ts:number}>} */
const codeCache = new Map();
/** @type {Map<string, Promise<Map<string, any> | null>>} */
const inflight = new Map();
let lastFail = 0;

function metaEnabled() {
  const m = document.querySelector('meta[name="ebbflow-api"]');
  if (!m) return null;
  return m.getAttribute("content") !== "off";
}

/** 是否启用实时报价（静态站点默认 false，且不发任何请求） */
export function quoteEnabled() {
  try {
    if (new URLSearchParams(location.search).has("api")) return true;
  } catch {}
  const meta = metaEnabled();
  if (meta === false) return false;
  if (meta === true) return true;
  try {
    if (sessionStorage.getItem(OFF_KEY) === "1") return false;
  } catch {
    /* file:// 等场景可能禁用 storage：按未禁用处理 */
  }
  return location.port === "5188";
}

function disable(reason) {
  try {
    sessionStorage.setItem(OFF_KEY, "1");
  } catch {}
  if (reason) console.info("[ebbflow] 实时报价不可用，已禁用：", reason);
}

/**
 * 拉取报价：命中缓存（60s）直接返回；失败静默返回 null。
 * @param {string[]} codes
 * @returns {Promise<Map<string, any> | null>}
 */
export function loadQuotes(codes) {
  if (!quoteEnabled()) return Promise.resolve(null);
  const now = Date.now();
  if (now - lastFail < FAIL_BACKOFF) return Promise.resolve(null);
  const uniq = [...new Set((codes || []).filter((c) => /^\d{6}$/.test(c)))].slice(0, 40);
  if (!uniq.length) return Promise.resolve(null);

  const allCached = uniq.every((c) => codeCache.has(c) && now - codeCache.get(c).ts < TTL);
  if (allCached) return Promise.resolve(pick(uniq));

  const key = uniq.slice().sort().join(",");
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const res = await fetch(`/api/quote?codes=${uniq.join(",")}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 404) {
        disable("HTTP 404");
        return null;
      }
      if (!res.ok) {
        lastFail = Date.now();
        return null;
      }
      const data = await res.json();
      const quotes = data && data.quotes ? data.quotes : {};
      for (const [code, q] of Object.entries(quotes)) {
        if (!q || typeof q.price !== "number" || !Number.isFinite(q.price)) continue;
        codeCache.set(code, {
          price: q.price,
          at: typeof q.at === "string" ? q.at : "",
          market: typeof q.market === "string" ? q.market : "",
          realtime: !!q.realtime,
          ts: Date.now(),
        });
      }
      return pick(uniq);
    } catch (e) {
      // 网络错误：静默；30s 内不重复打
      lastFail = Date.now();
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

function pick(codes) {
  const out = new Map();
  for (const c of codes) {
    const q = codeCache.get(c);
    if (q) out.set(c, q);
  }
  return out;
}

/** "2026-11-20 15:30" / "2026-11-20" → "11-20" */
function mmdd(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(at || "");
  return m ? `${m[2]}-${m[3]}` : "";
}

/**
 * 用报价刷新一张 ETF 表的「最新价」列：
 * · 命中报价的单元格追加「实时」角标或收盘日期
 * · 列头从「收盘价」改为「最新价」，右侧显示汇总角标
 * · 无可用报价时保持原样（不重命名、不加角标）
 * @param {HTMLTableElement|null} table
 * @param {string[]} codes
 */
export async function attachQuotes(table, codes) {
  if (!table || !quoteEnabled()) return;
  const list = [...new Set((codes || []).filter((c) => /^\d{6}$/.test(c)))].slice(0, 40);
  if (!list.length) return;
  const map = await loadQuotes(list);
  if (!map || !map.size) return;

  const th = table.querySelector('th[data-esort="price"], th[data-isort="price"]');
  const label = th?.querySelector(".th-label");
  if (label) label.textContent = "最新价";

  let live = 0;
  let close = 0;
  let closeAt = "";
  for (const q of map.values()) {
    if (q.realtime) live += 1;
    else {
      close += 1;
      if (!closeAt) closeAt = q.at || "";
    }
  }
  if (th) {
    let badge = /** @type {HTMLElement|null} */ (th.querySelector(".q-badge"));
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "q-badge";
      th.append(badge);
    }
    if (live) {
      badge.className = "q-badge q-badge--live";
      badge.innerHTML = `<span class="q-dot" aria-hidden="true"></span>实时`;
      badge.title = close ? "深市为交易所实时价；沪市为最近收盘价" : "深市交易所实时价";
    } else {
      badge.className = "q-badge";
      badge.textContent = `${mmdd(closeAt)} 收盘`;
      badge.title = "最近收盘价（沪市官方实时接口不对公网开放）";
    }
  }

  for (const td of table.querySelectorAll("td.col-price[data-code]")) {
    const code = /** @type {HTMLElement} */ (td).dataset.code;
    const q = code ? map.get(code) : null;
    if (!q) continue;
    const tag = q.realtime
      ? `<span class="q-tag q-tag--live" title="深市实时 ${esc(q.at || "")}">实时</span>`
      : `<span class="q-tag q-tag--close" title="最近收盘 ${esc(q.at || "")}">${esc(mmdd(q.at) || "收盘")}</span>`;
    const cell = /** @type {HTMLElement} */ (td);
    cell.innerHTML = `<span class="q-val">${cnum(q.price, 3)}</span>${tag}`;
    cell.title = q.realtime ? `实时 ${q.at || ""}` : `收盘 ${q.at || ""}`;
  }
}
