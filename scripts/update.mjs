// 增量更新：沪深交易所 + Tushare 三源合并 → 重算序列 → 重建站点
//
// 口径：小类值 = 成分 ETF 份额之和 ÷1e4（亿份）；9_债券 ×100（债券 ETF 面值 100 元）。
// 优先级：交易所（官方披露）> Tushare（深市历史唯一来源 / 高精度参考）。
import fs from "node:fs";
import path from "node:path";
import { openDb, putShares, recordRun, metaSet, metaGet, dbStats, tradingDates } from "../lib/db.mjs";
import { fetchSseDay, candidateDates, mapLimit } from "../lib/sources.mjs";
import { shareOnDate, navOnDate, hasToken, bindBudget, callStats } from "../lib/tushare.mjs";
import { rebuild, refreshFunds, exportSeriesJson, ingestExchangeRange, ingestTushareRange, ingestTushareNav, ingestQuotes, detectShareEvents, etfCodes } from "../lib/pipeline.mjs";
import { putEvents } from "../lib/db.mjs";
import { putNav } from "../lib/db.mjs";
import { buildSite } from "../lib/build/site.mjs";
import { loadUniverse } from "../lib/universe.mjs";
import { isMain, projectRoot } from "../lib/cli.mjs";

const UNIVERSE = loadUniverse();
const SUB = UNIVERSE.SUB;
const CATS = UNIVERSE.CATS;

const ROOT = projectRoot(import.meta.url);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const LOCK = path.join(ROOT, "data", ".update.lock");

const LOCK_PID = path.join(LOCK, "pid");

/** 进程是否还活着（EPERM 说明存在但无权限 → 当作活着） */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * 抢更新锁。除了超时兜底，还看锁里记的 pid 是否还活着——
 * 被 Ctrl-C / SIGPIPE 杀掉的上一次运行会留下锁目录，以前要白等 15 分钟且没有任何提示。
 * @returns {{ok: boolean, reason?: string, holder?: number}}
 */
function acquire() {
  const tryCreate = () => {
    fs.mkdirSync(LOCK);
    try { fs.writeFileSync(LOCK_PID, String(process.pid)); } catch {}
  };
  try {
    tryCreate();
    return { ok: true };
  } catch {
    let holder = null;
    let ageMs = 0;
    // 两件事分开读：缺 pid 文件（旧格式/被中断）不该让「锁年龄」也算不出来
    try { holder = Number(fs.readFileSync(LOCK_PID, "utf8").trim()) || null; } catch {}
    try { ageMs = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { ageMs = 0; }

    const dead = holder ? !pidAlive(holder) : false;
    // 没有 pid 文件的是旧格式锁：只要不是刚刚创建（可能正被写），就按残留处理
    const legacyStale = !holder && ageMs > 2 * 60 * 1000;
    const stale = ageMs > 15 * 60 * 1000 || legacyStale;
    if (dead || stale) {
      fs.rmSync(LOCK, { recursive: true, force: true });
      try {
        tryCreate();
        log(`清理残留锁（${dead ? `持有进程 ${holder} 已不存在` : "超过 15 分钟"}）后继续`);
        return { ok: true };
      } catch {
        return { ok: false, reason: "另一个更新刚好抢先启动", holder };
      }
    }
    return { ok: false, reason: `另一个更新正在进行中（pid=${holder ?? "未知"}）`, holder };
  }
}
const release = () => {
  // Windows 下杀软/索引可能短暂占用目录句柄，rmSync 会抛 EPERM；释放失败不应盖住更新结果
  try {
    fs.rmSync(LOCK, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[lock] 释放失败（可手动删除 ${LOCK}）：${e?.message || e}`);
  }
};

/** 历史是否完整：交易日数、标的数（沪深全覆盖）、净值行数三个维度都要够 */
function historyComplete(db) {
  if (metaGet(db, "historyComplete", null)) return true;
  const dates = tradingDates(db).length;
  const codes = db.prepare("SELECT COUNT(DISTINCT code) n FROM share").get()?.n ?? 0;
  const navRows = db.prepare("SELECT COUNT(*) n FROM nav").get()?.n ?? 0;
  const ok = dates >= 200 && codes >= 1500 && navRows >= 500000;
  if (ok) metaSet(db, "historyComplete", new Date().toISOString());
  return ok;
}

/** 历史不完整（新库/CI 首次运行/深市缺失）时自动做一次全量回补 */
async function ensureHistory(db, warn, quiet) {
  if (historyComplete(db)) return null;
  const have = tradingDates(db).length;
  const codesHave = db.prepare("SELECT COUNT(DISTINCT code) n FROM share").get()?.n ?? 0;
  const navRows = db.prepare("SELECT COUNT(*) n FROM nav").get()?.n ?? 0;
  if (!quiet) log(`历史不完整（交易日 ${have} / 标的 ${codesHave} / 净值行 ${navRows}），执行全量回补…`);
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 5 * 365 * 86400000).toISOString().slice(0, 10);

  const sse = await ingestExchangeRange(db, { from, to, onProgress: (n) => { if (!quiet && n % 30000 < 1000) process.stdout.write("."); } });
  if (!quiet) log(`\n上交所回补：${sse.ok} 个交易日 / 写入 ${sse.written} 行`);
  if (hasToken()) {
    // 名录为空时先拉名录，否则 etfCodes() 是空数组，回补会「0 只」
    const fundCount = db.prepare("SELECT COUNT(*) n FROM fund").get()?.n ?? 0;
    if (fundCount < 100) {
      try {
        await refreshFunds(db);
        metaSet(db, "fundsAt", new Date().toISOString());
        if (!quiet) log(`名录已刷新：${db.prepare("SELECT COUNT(*) n FROM fund").get()?.n ?? 0} 只`);
      } catch (e) {
        warn.push("名录刷新失败，回补可能不完整");
      }
    }
    const codes = etfCodes(db);
    const ts = await ingestTushareRange(db, { from, to, codes, resume: true });
    if (!quiet) log(`Tushare 份额回补：${ts.codes} 只 / 写入 ${ts.written} 行`);
    const nv = await ingestTushareNav(db, { from, to, codes, resume: true });
    if (!quiet) log(`Tushare 净值回补：${nv.codes} 只 / 写入 ${nv.rows} 行`);
  }
  return { sse, have };
}

async function run({ quiet = false, lookback = 15 } = {}) {
  const t0 = Date.now();
  const db = openDb();
  bindBudget(db);
  const warn = [];

  try {
    await ensureHistory(db, warn, quiet);
  } catch (e) {
    warn.push(`历史自动回补失败：${String(e.message || e).slice(0, 80)}`);
  }

  // 1) Tushare：全市场（沪深）最近交易日快照 —— 深市唯一来源，沪市用于补齐交易所缺口
  let anchor = null;
  if (hasToken()) {
    try {
      const probe = new Date();
      for (let back = 0; back < 10 && !anchor; back++) {
        const d = new Date(probe.getTime() - back * 86400000).toISOString().slice(0, 10);
        if ([0, 6].includes(new Date(d + "T00:00:00Z").getUTCDay())) continue;
        const m = await shareOnDate(d);
        if (m.size) {
          anchor = d;
          putShares(db, d, Object.fromEntries([...m].map(([c, w]) => [c, { wan: w, src: "ts" }])));
          const navs = await navOnDate(d);
          if (navs.size) putNav(db, [...navs].map(([c, v]) => [c, d, v]));
          if (!quiet) log(`Tushare ${d}：份额 ${m.size} 只 / 净值 ${navs.size} 只（沪深全市场）`);
        }
      }
    } catch (e) {
      warn.push(`Tushare 抓取失败：${String(e.message || e).slice(0, 90)}`);
    }
  } else {
    warn.push("未配置 TUSHARE_TOKEN：深市数据不可用，仅能更新沪市");
  }

  // 2) 上交所：最近 lookback 天逐日（沪市官方口径，优先于 Tushare）
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


  // 2.5) 兜底：SQLite 里的派生序列若还不完整，用仓库自带的 data/series.json 补上（只补缺的日期）
  try {
    const have = db.prepare("SELECT COUNT(DISTINCT date) n FROM series").get()?.n ?? 0;
    const file = path.join(ROOT, "data", "series.json");
    if (have < 1000 && fs.existsSync(file)) {
      const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
      const known = new Set(db.prepare("SELECT DISTINCT date FROM series").all().map((r) => r.date));
      const rows = [];
      for (const [sub, vals] of Object.entries(legacy.subs)) {
        for (let i = 0; i < legacy.dates.length; i++) {
          const d = legacy.dates[i];
          if (vals[i] == null || known.has(d)) continue;
          rows.push([sub, d, vals[i]]);
        }
      }
      if (rows.length) {
        const { putSeries } = await import("../lib/db.mjs");
        putSeries(db, rows);
        warn.push(`派生序列不完整，已用 data/series.json 补齐 ${rows.length} 条`);
      }
    }
  } catch (e) {
    warn.push("序列兜底失败：" + String(e.message || e).slice(0, 60));
  }

  // 2.6) 行情（收盘价/成交额）与份额折算事件：每天增量维护，供折溢价/成交额/净流入修正使用
  try {
    const q = await ingestQuotes(db, { from, to: end, quiet: true });
    if (!quiet && q.days) log(`行情：${q.days} 天 / ${q.rows} 行`);
  } catch (e) {
    warn.push("行情更新失败：" + String(e.message || e).slice(0, 60));
  }
  try {
    const evs = detectShareEvents(db);
    putEvents(db, evs);
    if (!quiet) log(`份额折算事件：${evs.length} 起`);
  } catch (e) {
    warn.push("折算检测失败：" + String(e.message || e).slice(0, 60));
  }

  // 3) 基金名录（每周一次）
  const lastFunds = metaGet(db, "fundsAt", null);
  if (!lastFunds || Date.now() - new Date(lastFunds).getTime() > 7 * 86400000) {
    try {
      await refreshFunds(db);
      metaSet(db, "fundsAt", new Date().toISOString());
    } catch (e) {
      warn.push("基金名录刷新失败");
    }
  }

  // 4) 重算 + 构站
  const rc = rebuild(db);
  const info = buildSite(db, { warnings: warn });
  exportSeriesJson(db, path.join(ROOT, "data", "series.json"));
  metaSet(db, "updatedAt", new Date().toISOString());
  const stats = { ...dbStats(db), seriesRows: rc.seriesRows, marketRows: rc.marketRows, site: info, ms: Date.now() - t0, tushare: callStats(), warnings: warn };
  recordRun(db, { at: new Date().toISOString(), kind: "update", ok: true, stats });
  fs.writeFileSync(
    path.join(ROOT, "data", "lastrun.json"),
    JSON.stringify({ at: new Date().toISOString(), lastTradeDate: info.lastTradeDate, dates: info.dates, ms: stats.ms, warnings: warn })
  );
  if (!quiet) log(`完成：最新交易日 ${info.lastTradeDate}，${info.dates} 个交易日 / ${CATS.length} 个大类 / ${Object.keys(SUB).length} 个细分行业，用时 ${(stats.ms / 1000).toFixed(1)}s`);
  return { last: info.lastTradeDate, ...stats };
}

export async function update(opts = {}) {
  const lock = acquire();
  if (!lock.ok) return { skipped: lock.reason || "locked", holder: lock.holder ?? null };
  try {
    return await run(opts);
  } finally {
    release();
  }
}

if (isMain(import.meta.url)) {
  const li = process.argv.indexOf("--lookback");
  const lookback = li > 0 ? Number(process.argv[li + 1]) : Number(process.env.LOOKBACK || 15);
  update({ lookback })
    .then((r) => {
      // 被锁跳过时必须显式说明，否则用户只看到「退出码 0、什么都没发生」
      if (r?.skipped) {
        log(`已跳过：${r.skipped}`);
        process.exitCode = 0;
      }
    })
    .catch((e) => {
      console.error("更新失败:", e);
      process.exit(1);
    });
}
