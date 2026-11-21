// Tushare Pro 数据源（第二数据源）：
//   fund_share  —— 场内基金每日份额（万份，4 位小数），可按 ts_code 回溯 5 年，深市历史唯一来源
//   fund_basic  —— 场内基金名录
//   fund_daily  —— 场内基金日线（用于成交/涨跌辅助信息）
// token 读取顺序：process.env.TUSHARE_TOKEN → 项目根 .env
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API = "http://api.tushare.pro";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cachedToken;
export function getToken() {
  if (cachedToken) return cachedToken;
  if (process.env.TUSHARE_TOKEN) return (cachedToken = process.env.TUSHARE_TOKEN.trim());
  try {
    const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    const m = env.match(/^\s*TUSHARE_TOKEN\s*=\s*(\S+)/m);
    if (m) return (cachedToken = m[1].trim());
  } catch {}
  throw new Error("未配置 TUSHARE_TOKEN：请在项目根目录的 .env 里写入，或设置同名环境变量");
}

export function hasToken() {
  try {
    getToken();
    return true;
  } catch {
    return false;
  }
}

/** 把 6 位代码转成 tushare 的 ts_code */
export function toTsCode(code) {
  const c = String(code).slice(0, 6);
  return c + (c.startsWith("5") || c.startsWith("6") || c.startsWith("9") ? ".SH" : ".SZ");
}

const ymd = (d) => d.replace(/-/g, "");
const dash = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/** 带重试的 API 调用（Tushare 用 HTTP 200 + body.code 表达错误） */
export async function call(apiName, params = {}, fields = "", { tries = 4 } = {}) {
  const token = getToken();
  let lastErr;
  for (let i = 0; i < tries; i++) {
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
      // 频率限制类错误：退避重试
      const msg = String(j.msg || "");
      if (/每分钟|每小时|频率|timeout|请稍|limit/i.test(msg)) {
        await sleep(1200 * (i + 1));
        lastErr = new Error(`${apiName}: ${msg}`);
        continue;
      }
      throw new Error(`${apiName}: ${msg}`);
    } catch (e) {
      lastErr = e;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

/** 场内基金名录：[{code, name, type, market}] */
export async function fundBasic() {
  const d = await call("fund_basic", { market: "E" }, "ts_code,name,fund_type,status");
  const idx = Object.fromEntries(d.fields.map((f, i) => [f, i]));
  return d.items.map((row) => ({
    tsCode: row[idx.ts_code],
    code: String(row[idx.ts_code]).slice(0, 6),
    name: row[idx.name],
    type: row[idx.fund_type],
    status: row[idx.status],
  }));
}

/** 单只基金全历史份额：Map<'YYYY-MM-DD', 万份> */
export async function shareHistory(code, startDate, endDate) {
  const d = await call(
    "fund_share",
    { ts_code: toTsCode(code), start_date: ymd(startDate), end_date: ymd(endDate) },
    "trade_date,fd_share"
  );
  const out = new Map();
  for (const [dt, v] of d.items) if (v != null) out.set(dash(String(dt)), v);
  return out;
}

/** 某交易日的全市场份额：Map<code, 万份> */
export async function shareOnDate(date) {
  const d = await call("fund_share", { trade_date: ymd(date) }, "ts_code,fd_share");
  const out = new Map();
  for (const [ts, v] of d.items) if (v != null) out.set(String(ts).slice(0, 6), v);
  return out;
}

/** 单只基金历史净值：Map<'YYYY-MM-DD', 元/份> */
export async function navHistory(code, startDate, endDate) {
  const d = await call(
    "fund_nav",
    { ts_code: toTsCode(code), start_date: ymd(startDate), end_date: ymd(endDate) },
    "nav_date,unit_nav"
  );
  const out = new Map();
  for (const [dt, v] of d.items) if (v != null) out.set(dash(String(dt)), v);
  return out;
}

/** 并发批量 */
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
