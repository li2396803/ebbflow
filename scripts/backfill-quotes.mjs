// 回补 ETF 行情（收盘价/成交额/成交量/涨跌幅），用于折溢价率、成交额、换手率。
// 每个交易日 1 次 fund_daily 调用（全市场），1212 天 ≈ 1212 次，按 TUSHARE_RPM 限速。
// 用法：node scripts/backfill-quotes.mjs [--from 2021-11-22] [--to 2026-11-20] [--days 250]
import { openDb, metaGet, metaSet, tradingDates } from "../lib/db.mjs";
import { ingestQuotes } from "../lib/pipeline.mjs";
import { bindBudget, hasToken, callStats } from "../lib/tushare.mjs";

const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};

const db = openDb();
bindBudget(db);
if (!hasToken()) {
  console.error("缺少 TUSHARE_TOKEN（放在 .env 或环境变量）");
  process.exit(1);
}

const all = tradingDates(db);
let dates;
if (arg("--days")) dates = all.slice(-Number(arg("--days")));
else dates = all.filter((d) => (!arg("--from") || d >= arg("--from")) && (!arg("--to") || d <= arg("--to")));

const have = new Set(db.prepare("SELECT DISTINCT date FROM quote").all().map((r) => r.date));
const todo = dates.filter((d) => !have.has(d));
console.log(`行情回补：需处理 ${todo.length} 天（已有 ${have.size} 天），从 ${todo[0] ?? "-"} 到 ${todo.at(-1) ?? "-"}`);
if (!todo.length) process.exit(0);

const t0 = Date.now();
const r = await ingestQuotes(db, { from: todo[0], to: todo.at(-1), quiet: false });
console.log(`完成：${r.days} 天 / ${r.rows} 行，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s，调用 ${JSON.stringify(callStats())}`);
metaSet(db, "quotesAt", new Date().toISOString());
