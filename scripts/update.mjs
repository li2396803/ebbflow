// 增量更新：沪深交易所 + Tushare 三源合并 → 重算序列 → 重建站点
//
// 口径：小类值 = 成分 ETF 份额之和 ÷1e4（亿份）；9_债券 ×100（债券 ETF 面值 100 元）。
// 优先级：交易所（官方披露）> Tushare（深市历史唯一来源 / 高精度参考）。
import fs from "node:fs";
import path from "node:path";
import { openDb, putShares, recordRun, metaSet, metaGet, dbStats } from "../lib/db.mjs";
import { SUB, CATS } from "../lib/taxonomy.mjs";
import { fetchSseDay, fetchSzseLatest, candidateDates, mapLimit } from "../lib/sources.mjs";
import { shareOnDate, hasToken } from "../lib/tushare.mjs";
import { rebuild, refreshFunds, exportSeriesJson } from "../lib/pipeline.mjs";
import { buildSite } from "../lib/build/site.mjs";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const LOCK = path.join(ROOT, "data", ".update.lock");

function acquire() {
  try {
    fs.mkdirSync(LOCK);
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(LOCK).mtimeMs > 15 * 60 * 1000) {
        fs.rmSync(LOCK, { recursive: true, force: true });
        fs.mkdirSync(LOCK);
        return true;
      }
    } catch {}
    return false;
  }
}
const release = () => fs.rmSync(LOCK, { recursive: true, force: true });

async function run({ quiet = false, lookback = 15 } = {}) {
  const t0 = Date.now();
  const db = openDb();
  const warn = [];

  // 1) 深交所：仅最新交易日快照（官方口径）
  let anchor = null;
  try {
    const sz = await fetchSzseLatest();
    anchor = sz.date;
    const entries = Object.fromEntries(Object.entries(sz.shares).map(([c, w]) => [c, { wan: w, src: "szse" }]));
    putShares(db, sz.date, entries);
    if (!quiet) log(`深交所 ${sz.date}：${Object.keys(sz.shares).length} 只`);
  } catch (e) {
    warn.push(`深交所抓取失败：${String(e.message || e).slice(0, 80)}`);
  }

  // 2) 上交所：最近 lookback 天逐日（非交易日返回空，自然跳过）
  const end = anchor ?? new Date().toISOString().slice(0, 10);
  const from = new Date(new Date(end + "T00:00:00Z").getTime() - lookback * 86400000).toISOString().slice(0, 10);
  const days = candidateDates(from, end);
  let sseDays = 0;
  await mapLimit(days, 4, async (d) => {
    try {
      const r = await fetchSseDay(d);
      if (!r) return;
      putShares(db, d, Object.fromEntries(Object.entries(r.shares).map(([c, w]) => [c, { wan: w, src: "sse" }])));
      sseDays++;
    } catch (e) {
      warn.push(`上交所 ${d} 失败`);
    }
  });
  if (!quiet) log(`上交所补到 ${sseDays} 个交易日`);

  // 3) Tushare：全市场当日（补交易所缺口；也是深市历史来源）
  if (hasToken()) {
    try {
      const m = await shareOnDate(end);
      putShares(db, end, Object.fromEntries([...m].map(([c, w]) => [c, { wan: w, src: "ts" }])));
      if (!quiet) log(`Tushare ${end}：${m.size} 只`);
    } catch (e) {
      warn.push(`Tushare 抓取失败：${String(e.message || e).slice(0, 80)}`);
    }
  } else {
    warn.push("未配置 TUSHARE_TOKEN，深市历史将不可用");
  }

  // 4) 基金名录（每周一次）
  const lastFunds = metaGet(db, "fundsAt", null);
  if (!lastFunds || Date.now() - new Date(lastFunds).getTime() > 7 * 86400000) {
    try {
      await refreshFunds(db);
      metaSet(db, "fundsAt", new Date().toISOString());
    } catch (e) {
      warn.push("基金名录刷新失败");
    }
  }

  // 5) 重算 + 构站
  const rc = rebuild(db);
  const info = buildSite(db, { warnings: warn });
  exportSeriesJson(db, path.join(ROOT, "data", "series.json"));
  metaSet(db, "updatedAt", new Date().toISOString());
  const stats = { ...dbStats(db), seriesRows: rc.seriesRows, site: info, ms: Date.now() - t0, warnings: warn };
  recordRun(db, { at: new Date().toISOString(), kind: "update", ok: true, stats });
  fs.writeFileSync(
    path.join(ROOT, "data", "lastrun.json"),
    JSON.stringify({ at: new Date().toISOString(), lastTradeDate: info.lastTradeDate, dates: info.dates, ms: stats.ms, warnings: warn })
  );
  if (!quiet) log(`完成：最新交易日 ${info.lastTradeDate}，${info.dates} 个交易日 / ${CATS.length} 个大类 / ${Object.keys(SUB).length} 个细分行业，用时 ${(stats.ms / 1000).toFixed(1)}s`);
  return { last: info.lastTradeDate, ...stats };
}

export async function update(opts = {}) {
  if (!acquire()) return { skipped: "locked" };
  try {
    return await run(opts);
  } finally {
    release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const li = process.argv.indexOf("--lookback");
  const lookback = li > 0 ? Number(process.argv[li + 1]) : Number(process.env.LOOKBACK || 15);
  update({ lookback }).catch((e) => {
    console.error("更新失败:", e);
    process.exit(1);
  });
}
