// Tushare Pro 数据源（唯一深市来源 + 沪市第二来源）
//
//   接口：fund_share（每日份额，万份）/ fund_nav（单位净值）/ fund_basic（名录）
//
// 调用纪律（"限制抓取次数和频率"）：
//   · 全局令牌桶：默认 120 次/分钟（TUSHARE_RPM 可调），跨调用共享，不随并发放大
//   · 单次运行预算：默认 800 次（TUSHARE_MAX_CALLS_PER_RUN 可调），超出即停
//   · 每日预算：默认 4000 次（TUSHARE_DAILY_BUDGET 可调），计数持久化在 SQLite meta（ts:calls:<date>）
//   · 频率类错误自动退避重试（最多 4 次，指数退避 + 抖动）
//   · 所有抓取都是幂等 upsert；已有数据不要重复抓，调用方先用 needXxx 判断
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API = "http://api.tushare.pro";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RPM = Math.max(1, Number(process.env.TUSHARE_RPM || 120));
const MAX_PER_RUN = Math.max(1, Number(process.env.TUSHARE_MAX_CALLS_PER_RUN || 800));
const DAILY_BUDGET = Math.max(1, Number(process.env.TUSHARE_DAILY_BUDGET || 4000));
const MIN_INTERVAL = Math.ceil(60000 / RPM);

let cachedToken;
export function getToken() {
  if (cachedToken) return cachedToken;
  if (process.env.TUSHARE_TOKEN) return (cachedToken = process.env.TUSHARE_TOKEN.trim());
  try {
    // 去 BOM：Windows 编辑器可能把 .env 存成 UTF-8 BOM，首行会匹配不到
    const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8").replace(/^\uFEFF/, "");
    const m = env.match(/^\s*TUSHARE_TOKEN\s*=\s*(\S+)/m);
    if (m) return (cachedToken = m[1].trim());
  } catch {}
  throw new Error(
    "未配置 TUSHARE_TOKEN。请在项目根目录创建 .env 写入 TUSHARE_TOKEN=你的token，" +
      "或设置同名环境变量；GitHub Actions 里请配置同名 Secret。token 申请：https://tushare.pro/user/token"
  );
}
export function hasToken() {
  try {
    getToken();
    return true;
  } catch {
    return false;
  }
}

export function toTsCode(code) {
  const c = String(code).slice(0, 6);
  return c + (c.startsWith("5") || c.startsWith("6") || c.startsWith("9") ? ".SH" : ".SZ");
}
const ymd = (d) => String(d).replace(/-/g, "");
const dash = (d) => `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6, 8)}`;

/* --------------------------- 限流 / 预算 --------------------------- */

let nextSlot = 0;
let callsThisRun = 0;
let budgetDb = null;

/** 绑定 SQLite，用于持久化"当日调用次数" */
export function bindBudget(db) {
  budgetDb = db;
}
const today = () => new Date().toISOString().slice(0, 10);
function dailyUsed() {
  if (!budgetDb) return 0;
  try {
    const r = budgetDb.prepare("SELECT v FROM meta WHERE k=?").get(`ts:calls:${today()}`);
    return r ? Number(JSON.parse(r.v)) : 0;
  } catch {
    return 0;
  }
}
function bumpDaily(n = 1) {
  if (!budgetDb) return;
  const used = dailyUsed() + n;
  budgetDb
    .prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .run(`ts:calls:${today()}`, JSON.stringify(used));
}

export function callStats() {
  return { callsThisRun, dailyUsed: dailyUsed(), maxPerRun: MAX_PER_RUN, dailyBudget: DAILY_BUDGET, rpm: RPM };
}

async function gate() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_INTERVAL;
  if (at > now) await sleep(at - now);
}

function assertBudget() {
  if (callsThisRun >= MAX_PER_RUN) {
    throw new Error(`本次运行已达调用上限 ${MAX_PER_RUN} 次（TUSHARE_MAX_CALLS_PER_RUN 可调），请稍后重跑以断点续抓`);
  }
  if (dailyUsed() >= DAILY_BUDGET) {
    throw new Error(`今日调用已达预算 ${DAILY_BUDGET} 次（TUSHARE_DAILY_BUDGET 可调），明天再试或调高预算`);
  }
}

/* ----------------------------- API 调用 ----------------------------- */

const RETRYABLE = /每分钟|每小时|频率|timeout|请稍|limit|最多访问|超限/i;

export async function call(apiName, params = {}, fields = "", { tries = 4, retryBaseMs = 1500 } = {}) {
  const token = getToken();
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    assertBudget();
    await gate();
    callsThisRun++;
    bumpDaily(1);
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30000);
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_name: apiName, token, params, fields }),
        signal: ctl.signal,
      });
      clearTimeout(t);
      const j = await res.json();
      if (j.code === 0) return j.data ?? { fields: [], items: [] };
      const msg = String(j.msg || "");
      if (RETRYABLE.test(msg)) {
        lastErr = new Error(`${apiName}: ${msg}`);
        await sleep(retryBaseMs * (attempt + 1) + Math.random() * 400);
        continue;
      }
      throw new Error(`${apiName}: ${msg}`);
    } catch (e) {
      lastErr = e;
      if (attempt === tries - 1) break;
      await sleep(retryBaseMs * (attempt + 1));
    }
  }
  throw lastErr;
}

/* ------------------------------ 业务封装 ------------------------------ */

/** 场内基金名录（含市场与类型），用于确定需要补全的代码集合 */
export async function fundBasic() {
  const d = await call("fund_basic", { market: "E" }, "ts_code,name,fund_type,status,list_date");
  const idx = Object.fromEntries(d.fields.map((f, i) => [f, i]));
  return d.items.map((row) => {
    const tsCode = String(row[idx.ts_code]);
    const code = tsCode.slice(0, 6);
    return {
      tsCode,
      code,
      name: row[idx.name],
      type: row[idx.fund_type],
      status: row[idx.status],
      list_date: row[idx.list_date] ?? null,
      market: tsCode.endsWith(".SH") ? "SH" : "SZ",
    };
  });
}

/** 单只基金全历史份额：Map<'YYYY-MM-DD', 万份> */
export async function shareHistory(code, startDate, endDate) {
  const d = await call("fund_share", { ts_code: toTsCode(code), start_date: ymd(startDate), end_date: ymd(endDate) }, "trade_date,fd_share");
  const out = new Map();
  for (const [dt, v] of d.items) if (v != null && v > 0) out.set(dash(dt), v);
  return out;
}

/** 单只基金全历史净值：Map<'YYYY-MM-DD', 元/份> */
export async function navHistory(code, startDate, endDate) {
  const d = await call("fund_nav", { ts_code: toTsCode(code), start_date: ymd(startDate), end_date: ymd(endDate) }, "nav_date,unit_nav");
  const out = new Map();
  for (const [dt, v] of d.items) if (v != null && v > 0) out.set(dash(dt), v);
  return out;
}

/** 某交易日全市场（沪深场内）单位净值：Map<code, 元/份>（1 次调用覆盖全市场） */
export async function navOnDate(date) {
  // 必须翻页：fund_nav 按日期返回的是「全部基金」（含场外），单次只给前若干条，
  // 不翻页会静默截断——实测 2026-11-20 就因此漏掉 513050（中概互联网ETF）的净值，
  // 导致「互联网」小类规模从 385 亿塌成 6 亿。
  const items = [];
  const PAGE = 5000;
  for (let offset = 0; offset < 200000; offset += PAGE) {
    const d = await call("fund_nav", { nav_date: ymd(date), offset, limit: PAGE }, "ts_code,nav_date,unit_nav");
    const part = d.items ?? [];
    items.push(...part);
    if (part.length < PAGE) break;
  }
  const d = { items };
  const out = new Map();
  for (const [ts, , v] of d.items) {
    const t = String(ts);
    if (!t.endsWith(".SH") && !t.endsWith(".SZ")) continue; // 只取场内
    if (v != null && v > 0) out.set(t.slice(0, 6), v);
  }
  return out;
}

/** 某交易日全市场（沪深）份额：Map<code, 万份> */
export async function shareOnDate(date) {
  const items = [];
  const PAGE = 5000;
  for (let offset = 0; offset < 200000; offset += PAGE) {
    const d = await call("fund_share", { trade_date: ymd(date), offset, limit: PAGE }, "ts_code,fd_share");
    const part = d.items ?? [];
    items.push(...part);
    if (part.length < PAGE) break;
  }
  const d = { items };
  const out = new Map();
  for (const [ts, v] of d.items) if (v != null && v > 0) out.set(String(ts).slice(0, 6), v);
  return out;
}

/** 并发（受全局令牌桶约束，并发数只是流水线深度） */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = await fn(items[k], k);
        } catch (e) {
          out[k] = { error: String(e?.message || e) };
        }
      }
    })
  );
  return out;
}
