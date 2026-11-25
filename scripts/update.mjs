// 增量更新：沪深交易所 + Tushare 三源合并 → 重算序列 → 重建站点
//
// 口径：小类值 = 成分 ETF 份额之和 ÷1e4（亿份）；9_债券 ×100（债券 ETF 面值 100 元）。
// 优先级：交易所（官方披露）> Tushare（深市历史唯一来源 / 高精度参考）。
import fs from "node:fs";
import path from "node:path";
import { openDb, putShares, recordRun, metaSet, metaGet, dbStats, tradingDates, axisDiagnostics, dayCoverage, coverageBand } from "../lib/db.mjs";
import { fetchSseDay, fetchSzseSnapshot, fetchSzseHistory, candidateDates, mapLimit } from "../lib/sources.mjs";
import { shareOnDate, navOnDate, hasToken, bindBudget, callStats } from "../lib/tushare.mjs";
import { acquireLock, releaseLock, lockInfo } from "../lib/lock.mjs";
import { assessDay, BAND } from "../lib/invariants.mjs";
import { rebuild, refreshFunds, exportSeriesJson, ingestExchangeRange, ingestTushareRange, ingestTushareNav, ingestQuotes, detectShareEvents, etfCodes } from "../lib/pipeline.mjs";
import { putEvents, markDaySource, fillFundNames } from "../lib/db.mjs";
import { putNav } from "../lib/db.mjs";
import { buildSite } from "../lib/build/site.mjs";
import { loadUniverse } from "../lib/universe.mjs";
import { isMain, projectRoot } from "../lib/cli.mjs";

const UNIVERSE = loadUniverse();
const SUB = UNIVERSE.SUB;
const CATS = UNIVERSE.CATS;

const ROOT = projectRoot(import.meta.url);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 冷启动（库里还没有历史）时，判断「当天出齐了吗」没有中位数可用，退化为绝对下限。
// 依据：2021 年沪深 ETF 合计约 1100 只，2026 年约 1750 只；500 是明显偏低但仍能排除
// 「1 / 32 / 99 行」这类残缺响应的安全下限（docs/AUDIT-PIPELINE.md P1-7）。
const COLD_START_MIN_CODES = 500;

/** 近 20 个交易日的覆盖中位数（沪深合计只数）；库里没有历史时返回 null */
function recentCoverageMedian(db) {
  try {
    const axis = tradingDates(db).slice(-20);
    if (!axis.length) return null;
    const cov = dayCoverage(db);
    const totals = axis
      .map((d) => {
        const c = cov.get(d);
        return c ? c.sh + c.sz : 0;
      })
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    if (!totals.length) return null;
    return totals[Math.floor((totals.length - 1) / 2)];
  } catch {
    return null;
  }
}

/**
 * 抢更新锁（实现在 lib/lock.mjs，可单测）：
 *   · 持有进程已死 / 旧格式残留 / 超过 15 分钟 → 清理后继续
 *   · 持有进程还活着 → 拒绝，并说明 pid 与已持有时长（而不是静默跳过）
 */
function acquire() {
  const r = acquireLock(ROOT);
  if (r.ok) {
    if (r.cleaned) log(`清理残留锁（${r.cleaned}）后继续`);
    return { ok: true };
  }
  const info = lockInfo(ROOT);
  return { ok: false, reason: r.reason, holder: r.holder ?? info.pid ?? null };
}
const release = () => releaseLock(ROOT, (msg) => console.warn(msg));

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

  const tTs0 = Date.now();
  // 1) Tushare：全市场（沪深）最近交易日快照 —— 深市唯一来源，沪市用于补齐交易所缺口
  //    「有数据」≠「出齐了」：实测遇到过当天只返回 1 / 32 / 99 / 1775 行。
  //    判据：只数 ≥ max(冷启动下限, 近 20 个交易日中位数 × minRatio) 才算完整；
  //    未出齐的日子**不写库、不标 has_ts、不当作 anchor**（否则残缺日会进时间轴 → 假暴跌）。
  let anchor = null;
  const tsSnapshot = { date: null, rows: null, expected: null, skipped: [] };
  if (hasToken()) {
    try {
      const expected = recentCoverageMedian(db);
      tsSnapshot.expected = expected;
      const floor = Math.max(COLD_START_MIN_CODES, Math.round((expected ?? 0) * BAND.minRatio));
      const probe = new Date();
      for (let back = 0; back < 10 && !anchor; back++) {
        const d = new Date(probe.getTime() - back * 86400000).toISOString().slice(0, 10);
        if ([0, 6].includes(new Date(d + "T00:00:00Z").getUTCDay())) continue;
        const m = await shareOnDate(d);
        if (!m.size) {
          tsSnapshot.skipped.push({ date: d, rows: 0, state: "empty" });
          continue;
        }
        const state = assessDay({ rows: m.size, expected: floor, minRatio: 1 });
        if (state !== "ok") {
          tsSnapshot.skipped.push({ date: d, rows: m.size, state });
          warn.push(`Tushare ${d} 仅 ${m.size} 只（< ${floor}，视为未出齐），不作为当日基准`);
          continue;
        }
        anchor = d;
        tsSnapshot.date = d;
        tsSnapshot.rows = m.size;
        putShares(db, d, Object.fromEntries([...m].map(([c, w]) => [c, { wan: w, src: "ts" }])));
        markDaySource(db, d, "ts"); // 标记了才算「当日有 Tushare 全量」，时间轴才敢用它兜底
        const navs = await navOnDate(d);
        if (navs.size) putNav(db, [...navs].map(([c, v]) => [c, d, v]));
        if (!quiet) log(`Tushare ${d}：份额 ${m.size} 只 / 净值 ${navs.size} 只（沪深全市场）`);
      }
      if (!anchor) warn.push("Tushare 近 10 天没有一天出齐（或全部为空），深市数据本次无法更新");
    } catch (e) {
      warn.push(`Tushare 抓取失败：${String(e.message || e).slice(0, 90)}`);
    }
  } else {
    warn.push("未配置 TUSHARE_TOKEN：深市数据不可用，仅能更新沪市");
  }

  const tsMs = Date.now() - tTs0;
  const tSse0 = Date.now();
  // 2) 上交所：最近 lookback 天逐日（沪市官方口径，优先于 Tushare）
  // 注意：窗口上界必须取「今天（北京）」，不能取 Tushare 的 anchor ——
  // Tushare 当天数据往往晚上才齐，anchor 会停在旧日期，导致交易所那边永远看不到新的一天。
  const bjNow = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const end = [anchor ?? bjNow, bjNow].sort().pop();
  const from = new Date(new Date(end + "T00:00:00Z").getTime() - lookback * 86400000).toISOString().slice(0, 10);
  const days = candidateDates(from, end);
  // 深交所写入：供「完整性闸门自愈」与「2.1 深交所快照」两处共用（以前定义在闸门之后，
  // 闸门里的调用会抛 ReferenceError 并被空 catch 吞掉，等于自愈路径一直是死的）。
  const szseWrite = (date, shares, tag) => {
    if (!date || !shares) return null;
    const n = Object.keys(shares).length;
    if (n < 100) return null;
    putShares(db, date, Object.fromEntries(Object.entries(shares).map(([c, w]) => [c, { wan: w, src: "szse" }])));
    markDaySource(db, date, "szse");
    if (!quiet) log(`深交所${tag} ${date}：${n} 只`);
    return { date, count: n };
  };
  let sseDays = 0;
  const sseNames = new Map();
  await mapLimit(days, 4, async (d) => {
    try {
      const r = await fetchSseDay(d);
      if (!r) return;
      for (const [c, nm] of Object.entries(r.names ?? {})) if (!sseNames.has(c)) sseNames.set(c, nm);
      putShares(db, d, Object.fromEntries(Object.entries(r.shares).map(([c, w]) => [c, { wan: w, src: "sse" }])));
      markDaySource(db, d, "sse"); // 交易日轴依赖这个标志，漏了会让新的一天永远进不了轴
      sseDays++;
    } catch (e) {
      warn.push(`上交所 ${d} 失败`);
    }
  });
  if (!quiet) log(`上交所补到 ${sseDays} 个交易日`);

  const sseMs = Date.now() - tSse0;
  // 2.05) 完整性闸门（P0-1）：进时间轴的每一天，两市覆盖都要在「近 20 个交易日中位数」的合理区间内。
  //       判据不写死 300/800：宽度随历史自动缩放，2021 年只有几百只时不误杀、2026 年 1700 只时不放过残缺日。
  //       不满足 → 先自动修复（Tushare 全天 → 深交所历史接口），仍不满足 → 不进轴 + 显式告警。
  const gate = { checked: days.length, repaired: [], excluded: [], alerts: [] };
  {
    let ax = axisDiagnostics(db);
    const failing = days.filter((d) => !ax.dates.includes(d));
    const repairFloor = Math.max(COLD_START_MIN_CODES, Math.round((recentCoverageMedian(db) ?? 0) * BAND.minRatio));
    for (const d of failing) {
      const ex = ax.excluded.find((x) => x.date === d);
      if (!ex) continue; // 没有来源标记 / 当天还没数据：交给下一次运行
      if (ex.reason === "ts_thin") continue; // 沪市还没到，深市先入库等着被激活
      // 修复尝试 1：Tushare 全市场当日（1 次请求、最稳；交易所数据某天没抓到就补不回来）
      try {
        const m = await shareOnDate(d);
        if (m.size >= repairFloor) {
          putShares(db, d, Object.fromEntries([...m].map(([c, w]) => [c, { wan: w, src: "ts" }])));
          markDaySource(db, d, "ts");
          gate.repaired.push({ date: d, via: "ts", rows: m.size });
          if (!quiet) log(`${d} 缺口已用 Tushare 补齐：${m.size} 只`);
          continue;
        }
      } catch {}
      // 修复尝试 2：深交所历史接口（同一份数据的另一个入口）
      try {
        const r = await fetchSzseHistory(d);
        const n = r ? Object.keys(r.shares ?? {}).length : 0;
        if (n >= 100) {
          szseWrite(r.date, r.shares, "历史补");
          gate.repaired.push({ date: d, via: "szse", rows: n });
          continue;
        }
      } catch {}
    }

    // 修复后再判一次：仍不合格的写进告警，并保证它不会进轴
    ax = axisDiagnostics(db);
    for (const d of days) {
      const ex = ax.excluded.find((x) => x.date === d);
      if (!ex || ax.dates.includes(d)) continue;
      if (ex.reason === "ts_thin") continue;
      gate.excluded.push({ date: d, reason: ex.reason, sh: ex.sh, sz: ex.sz, medSh: ex.medSh, medSz: ex.medSz });
      const msg = `${d} 覆盖不足（${ex.reason}：沪 ${ex.sh} / 深 ${ex.sz}，近 20 日中位数 ${ex.medSh ?? "-"}/${ex.medSz ?? "-"}），暂不纳入时间轴`;
      gate.alerts.push(msg);
      warn.push(msg);
      if (!quiet) log(`⚠ ${msg}`);
    }
  }

  if (sseNames.size) {
    try {
      const r = fillFundNames(db, sseNames, "sse");
      if (!quiet && r.filled) log(`沪市名称补缺：${r.filled} 只（名录未收录的新代码）`);
    } catch (e) {
      warn.push("沪市名称写入失败");
    }
  }

  const tSzse0 = Date.now();
  // 2.1) 深交所：官方接口只给「最新报告日」一档，正好够日常增量（历史由 Tushare 回补）
  //      实测深交所比上交所更早放出当日数据（21:30 已有，上交所仍需更晚），所以这里单独抓。
  let szseInfo = null;
  // 先试快照；失败或报告日不对，再按日期查历史接口（同一份数据的另一个入口，runner 上偶发网络失败时很关键）
  try {
    const snap = await fetchSzseSnapshot();
    const n = Object.keys(snap.shares).length;
    // 报告日要落在本次窗口内，且不能比已知最新交易日还旧，避免把陈旧快照写回去
    const knownLatest = tradingDates(db).at(-1) ?? "";
    if (snap.date && n > 100 && snap.date >= from && snap.date >= knownLatest) {
      szseWrite(snap.date, snap.shares, "快照");
      if (snap.names) {
        try {
          const r = fillFundNames(db, new Map(Object.entries(snap.names)), "szse");
          if (!quiet && r.filled) log(`深市名称补缺：${r.filled} 只（名录未收录的新代码）`);
        } catch {}
      }
      // 深交所自带上市日期：补上 Tushare 名录还没覆盖的新基金（用于"上市首日不计净申购"）
      if (snap.listDates) {
        const upd = db.prepare("UPDATE fund SET list_date=? WHERE code=? AND (list_date IS NULL OR list_date='')");
        for (const [c, d] of Object.entries(snap.listDates)) upd.run(d, c);
      }
      szseInfo = { date: snap.date, count: n };
      if (!quiet) log(`深交所快照 ${snap.date}：${n} 只`);
    } else if (!quiet) {
      log(`深交所快照跳过（报告日 ${snap.date || "未知"}，${n} 只）`);
    }
  } catch (e) {
    warn.push("深交所快照失败：" + String(e.message || e).slice(0, 60));
    // 兜底：按日期走历史接口，把当天（以及昨天）补上
    for (const d of [end, ...days.slice(-3).reverse()]) {
      try {
        const r = await fetchSzseHistory(d);
        if (r && szseWrite(r.date, r.shares, "历史")) break;
      } catch {}
    }
  }


  const szseMs = Date.now() - tSzse0;
  // 2.2) 哨兵：交易所接口「坏了」和「今天没数据」表现一样——都是 200 + 空结果。
  //      判据：交易所对某日返回 0 行，而 Tushare 同日有大量数据 → 是接口变了，不是市场没开。
  //      命中就用 Tushare 补上，别让站点空一天，同时留下警告。
  if (hasToken() && sseDays === 0 && days.length) {
    const floor = Math.max(COLD_START_MIN_CODES, Math.round((recentCoverageMedian(db) ?? 0) * BAND.minRatio));
    let suspect = null;
    for (const d of [...days].reverse().slice(0, 3)) {
      try {
        const r = await shareOnDate(d);
        const n = r ? Object.keys(r).length : 0;
        if (n >= floor) { suspect = { date: d, rows: r }; break; }
      } catch {}
    }
    if (suspect) {
      const { date: d, rows } = suspect;
      putShares(db, d, Object.fromEntries(Object.entries(rows).map(([c, w]) => [c, { wan: w, src: "ts" }])));
      markDaySource(db, d, "ts");
      warn.push(`交易所接口疑似异常：${d} 上交所返回 0 行，Tushare 有 ${Object.keys(rows).length} 只，已用 Tushare 兜底`);
      if (!quiet) log(`⚠ 上交所接口疑似异常（${d} 返回空但 Tushare 有数据），已兜底`);
    }
  }

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

  const tQuotes0 = Date.now();
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

  const quotesMs = Date.now() - tQuotes0;
  // 3) 基金名录（每周一次；名称以这份为准，交易所只补空缺）
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
  // 结构化运行台账（P2-11）：每个源的耗时/行数/覆盖 + 闸门结果 + 告警，便于事后定位
  const stats = {
    ...dbStats(db),
    seriesRows: rc.seriesRows,
    marketRows: rc.marketRows,
    mixedDays: rc.mixedDays ?? 0,
    site: info,
    ms: Date.now() - t0,
    tushare: callStats(),
    sources: {
      ts: { ms: tsMs, date: tsSnapshot.date, rows: tsSnapshot.rows, expected: tsSnapshot.expected, skipped: tsSnapshot.skipped },
      sse: { ms: sseMs, days: sseDays, requested: days.length },
      szse: { ms: szseMs, info: szseInfo },
      quotes: { ms: quotesMs },
    },
    gate,
    alerts: warn.map((m) => ({ severity: "warn", message: m })),
    warnings: warn,
  };
  recordRun(db, { at: new Date().toISOString(), kind: "update", ok: true, stats });
  const lastrun = {
    at: new Date().toISOString(),
    lastTradeDate: info.lastTradeDate,
    dates: info.dates,
    ms: stats.ms,
    sources: stats.sources,
    gate: { repaired: gate.repaired.length, excluded: gate.excluded.length },
    mixedDays: stats.mixedDays,
    warnings: warn,
  };
  fs.writeFileSync(path.join(ROOT, "data", "lastrun.json"), JSON.stringify(lastrun));
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
