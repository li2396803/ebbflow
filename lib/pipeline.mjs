// 数据管道：多源摄取 → 合并落库 → 派生序列
//
// 合并策略（同一 code + date 只保留一行）：
//   交易所（sse/szse）优先级 1，Tushare（ts）优先级 2。
//   · 沪市：以交易所为准；交易所无当日数据时用 Tushare 补
//   · 深市：交易所只有最新一日，历史全部来自 Tushare
// 派生：小类值 = 成分 ETF 份额之和 ÷1e4（亿份），大类 9_债券 ×100；内部保留 4 位小数，展示取 1 位。
import fs from "node:fs";
import path from "node:path";
import { filterIsolated } from "./invariants.mjs";
import { openDb, putShares, putSharesBulk, putSeriesV2, putQuotes, allDates, tradingDates, shareMap, shareRows, navMap, daySources, markDaySource, putSeries, putMarket, putMarketType, putNav, metaSet, metaGet, recordRun, upsertFunds } from "./db.mjs";
import { loadUniverse as universeLoader } from "./universe.mjs";
import { isMain, projectRoot } from "./cli.mjs";
import { resolveMarketModes, officialCountsFromShares } from "./invariants.mjs";
import { makeSplitAdjuster, subCoverage, flowStep, flowOutOfBounds } from "./metrics.mjs";

const ROOT = projectRoot(import.meta.url);

const UNIVERSE = universeLoader({ taxonomy: "legacy" });
const SUB = UNIVERSE.SUB;
const CATS = UNIVERSE.CATS;
const ALL_CODES = UNIVERSE.ALL_CODES;
const BOND_CAT = "9_债券";
const isBondCat = (cat) => cat === BOND_CAT || cat === "bond"; // legacy 用 9_债券，v2 用 bond
import { fetchSseDay, candidateDates, mapLimit as sseMapLimit } from "./sources.mjs";
import { shareHistory, navHistory, fundBasic, mapLimit as tsMapLimit } from "./tushare.mjs";

const round4 = (v) => Math.round(v * 10000) / 10000;

/** 用 share 表重算全部细分行业序列，写入 series 表 */
/** 一次性把需要的份额与净值读进内存（比按日查询快一个数量级） */
function loadContext(db, { dates, codes }) {
  const dateSet = new Set(dates);
  const codeSet = new Set(codes);
  const shares = new Map(); // date -> Map(code, wan)
  for (const r of db.prepare("SELECT date, code, wan, src FROM share").all()) {
    if (!dateSet.has(r.date) || !codeSet.has(r.code)) continue;
    let m = shares.get(r.date);
    if (!m) shares.set(r.date, (m = new Map()));
    m.set(r.code, r);
  }
  const navs = new Map(); // date -> Map(code, nav)
  for (const r of db.prepare("SELECT code, date, nav FROM nav").all()) {
    if (!dateSet.has(r.date) || !codeSet.has(r.code)) continue;
    let m = navs.get(r.date);
    if (!m) navs.set(r.date, (m = new Map()));
    m.set(r.code, r.nav);
  }
  const daySrc = new Map();
  for (const r of db.prepare("SELECT date, has_sse, has_szse FROM dayinfo").all()) {
    if (dateSet.has(r.date)) daySrc.set(r.date, { sse: !!r.has_sse, szse: !!r.has_szse });
  }
  return { shares, navs, daySrc };
}

/**
 * 重算全部派生数据：
 *   series(sub,date,val,scale,flow)  —— 份额(亿份, 债券×100) / 规模(亿元) / 净流入(亿元)
 *   market(date,scope,shares,scale)  —— 沪深与合计（全部 ETF，自然单位）
 *   market_type(date,type,...)       —— 按基金类型
 */
/** 批量摄入某日全部 ETF 的行情（收盘价/成交额/成交量/涨跌幅） */
export async function ingestQuotes(db, { from, to, quiet = true } = {}) {
  const { call } = await import("./tushare.mjs");
  const dates = tradingDates(db).filter((d) => (!from || d >= from) && (!to || d <= to));
  let days = 0, rows = 0;
  for (const d of dates) {
    const dd = d.replace(/-/g, "");
    try {
      const r = await call("fund_daily", { trade_date: dd, market: "E" }, "ts_code,trade_date,close,pct_chg,vol,amount");
      const f = Object.fromEntries(r.fields.map((x, i) => [x, i]));
      const out = r.items.map((it) => ({
        code: String(it[f.ts_code]).slice(0, 6),
        date: d,
        close: it[f.close],
        pct_chg: it[f.pct_chg],
        vol: it[f.vol],
        amount: it[f.amount],
      })).filter((x) => x.close != null);
      putQuotes(db, out);
      days++; rows += out.length;
      if (!quiet && days % 50 === 0) console.log(`  行情 ${days}/${dates.length} 天，${rows} 行`);
    } catch (e) {
      if (!quiet) console.log(`  ${d} 行情失败：${String(e.message).slice(0, 60)}`);
    }
  }
  return { days, rows };
}

/** 常见份额折算比例（份额拆分/合并） */
const SPLIT_RATIOS = [2, 3, 4, 5, 8, 10, 0.5, 1 / 3, 0.25, 0.1, 0.2];

/**
 * 检测份额拆分/合并。
 *
 * 判定要点（避免把「某日快照残缺」误判成折算）：
 *   1. 相邻两日份额比值落在常见折算比例 ±3% 内；
 *   2. 而且**新水平要维持住**（次日相对当日变化在 ±15% 内）—— 真实折算会永久改变份额，
 *      数据缺失造成的假跳变次日会弹回原水平。
 */
export function detectShareEvents(db) {
  const rows = db.prepare("SELECT code, date, wan FROM share ORDER BY code, date").all();
  const byCode = new Map();
  for (const r of rows) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  const out = [];
  for (const [code, list] of byCode) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1].wan, cur = list[i].wan;
      if (!(prev > 0) || !(cur > 0)) continue;
      const ratio = cur / prev;
      const hit = SPLIT_RATIOS.find((k) => Math.abs(ratio / k - 1) <= 0.03);
      if (!hit) continue;
      // 必须维持：次日水平不回到折算前的量级
      const next = list[i + 1]?.wan;
      if (next != null && next > 0) {
        const stay = next / cur;
        if (stay > 1.6 || stay < 0.62) continue; // 弹回去了 → 数据缺失，不是折算
      }
      out.push({ code, date: list[i].date, kind: ratio > 1 ? "split" : "merge", ratio: Math.round(ratio * 1000) / 1000 });
    }
  }
  return out;
}

export function recomputeAll(db, { dates, universe, legacy = true } = {}) {
  const U = universe ?? { SUB, CATS };
  const SUB_U = U.SUB;
  const CATS_U = U.CATS;
  const ds = dates ?? tradingDates(db);
  // 只用「场内 ETF」统计全市场：交易所快照里还混着 REITs / LOF / 普通指数基金，
  // 一并加总会把 REITs 与 LOF 当成 ETF，口径就不对了。
  const etfSet = new Set();
  try {
    for (const r of db.prepare("SELECT code, name, type FROM fund").all()) {
      if (/ETF/i.test(r.name || "") || /ETF/i.test(r.type || "")) etfSet.add(r.code);
    }
  } catch {
    /* 没有 fund 表时退化为不过滤 */
  }
  const isEtf = (code) => (etfSet.size ? etfSet.has(code) : true);

  // 上市首日：新发基金会一次性进几亿份，这不是申赎，不能算净流入
  const listDate = new Map();
  try {
    for (const r of db.prepare("SELECT code, list_date FROM fund WHERE list_date IS NOT NULL").all()) listDate.set(r.code, r.list_date);
  } catch {}
  const isListingDay = (code, d) => listDate.get(code) === d;

  // 份额折算（拆分/合并）会让「份额差」失真：把历史份额换算到当前份额单位后再作差。
  // 实现提到 lib/metrics.mjs（与 etfRanges/审计共用同一份算术，避免两套口径各算各的）。
  const eventsByCode = new Map();
  try {
    for (const e of db.prepare("SELECT code, date, ratio FROM event").all()) {
      let list = eventsByCode.get(e.code);
      if (!list) eventsByCode.set(e.code, (list = []));
      list.push({ date: e.date, ratio: e.ratio });
    }
  } catch {
    /* 没有 event 表时跳过 */
  }
  const adjust = makeSplitAdjuster(eventsByCode);

  const subDefs = Object.entries(SUB_U).map(([sub, meta]) => ({
    sub,
    factor: isBondCat(meta.cat) ? 100 : 1,
    codes: meta.etfs.map((e) => e.code),
    shCodes: new Set(meta.etfs.filter((e) => /^[569]/.test(e.code)).map((e) => e.code)),
  }));
  const funds = db.prepare("SELECT code, type, market FROM fund WHERE name LIKE '%ETF%'").all();
  const marketOf = new Map(funds.map((f) => [f.code, f.market === "SH" ? "SH" : "SZ"]));
  const typeOf = new Map(funds.map((f) => [f.code, f.type || "其他"]));

  const needed = new Set(funds.map((f) => f.code));
  for (const s of subDefs) for (const c of s.codes) needed.add(c);
  const ctx = loadContext(db, { dates: ds, codes: needed });

  // 口径模式：某天某市场的官方快照是否完整（完整 → 只认官方行；缺失/残缺 → 用全部可用行兜底）。
  // 这是 subs / market / market_type / flow 四条路径**共用**的唯一判据 —— 以前 subs 路径自己
  // 按「有标记就只认官方行」过滤，market 路径不过滤，同一天两处口径不一致，也制造了"官方只抓回一半
  // 就把 Tushare 兜底行全丢掉"的假暴跌（见 docs/AUDIT-PIPELINE.md P0-2）。
  const modes = resolveMarketModes({ dates: ds, official: officialCountsFromShares(ctx.shares) });
  const mixedDays = [];

  const seriesRows = [];
  const mktRows = [];
  const typeRows = [];
  // E1 不变量：单只 ETF 单日 |flow| ≤ 当日规模；违反即记录（不静默通过）
  const flowAnomalies = [];
  let prev = null;

  // 组成分连续性过滤（孤立披露不算成分，见 lib/invariants.mjs::filterIsolated）
  const sharesFiltered = filterIsolated(ctx.shares, ds);
  // 覆盖率与聚合同源：被 filterIsolated 剔除的、官方口径日被丢弃的行，都不计入命中
  const covBySub = subCoverage({ universe: U, dates: ds, sharesByDate: sharesFiltered, modes });

  for (let di = 0; di < ds.length; di++) {
    const d = ds[di];
    const byCode = sharesFiltered.get(d) ?? new Map();
    const navs = ctx.navs.get(d) ?? new Map();
    const mode = modes.get(d) ?? { sh: "all", sz: "all" };

    // 按市场口径筛出「当日有效行」：官方口径下只认官方行，否则全部可用行。
    // subs / market / market_type / flow 全部只用这一份，保证四处口径一致。
    const eff = new Map();
    for (const [code, r] of byCode) {
      const isSh = /^[56]/.test(code);
      const officialRow = isSh ? r.src === "sse" : r.src === "szse";
      const useOfficial = isSh ? mode.sh === "official" : mode.sz === "official";
      if (useOfficial && !officialRow) continue;
      eff.set(code, r);
    }
    // 只有「当天本该有官方数据（dayinfo 标记）却退回全部行」才算混源，需要告警；
    // 深市没有官方历史（无 szse 标记）本来就该用 Tushare，不算异常。
    const srcFlags = ctx.daySrc.get(d) ?? { sse: false, szse: false };
    if ((srcFlags.sse && mode.sh === "all") || (srcFlags.szse && mode.sz === "all")) {
      mixedDays.push({
        date: d,
        sh: mode.sh,
        sz: mode.sz,
        officialSh: mode.officialSh,
        officialSz: mode.officialSz,
        shIncomplete: mode.shIncomplete,
        szIncomplete: mode.szIncomplete,
      });
    }

    // —— 细分行业 ——
    for (const s of subDefs) {
      let sumShares = 0, hit = 0, sumScale = 0, scaleHit = 0, sumFlow = 0, flowHit = 0;
      for (const code of s.codes) {
        const r = eff.get(code);
        if (!r) continue;
        sumShares += r.wan;
        hit++;
        const nav = navs.get(code);
        if (nav != null) {
          sumScale += (r.wan / 1e4) * nav;
          scaleHit++;
          const p = prev?.get(code);
          if (p != null && p > 0 && !isListingDay(code, d)) {
            // 折算还原（审计 E1）：必须折回**当日份额单位**再乘当日净值，
            // 即 flow = (w − p·m_{t−1}/m_t) / 1e4 × nav_t。
            // 用 (w·m_t − p·m_{t−1}) 会把历史流量整体放大 m_t 倍（159219 曾报 −23.36 亿 / 真实 −0.99 亿）。
            const prevDate = di > 0 ? ds[di - 1] : d;
            const mt = adjust(code, d, 1);
            const mp = adjust(code, prevDate, 1);
            const f = flowStep(r.wan, p, nav, mt, mp);
            if (f != null) {
              sumFlow += f;
              flowHit++;
              const scalePrev = (p / 1e4) * nav;
              const scaleEnd = (r.wan / 1e4) * nav;
              if (flowOutOfBounds(f, scalePrev, scaleEnd) && flowAnomalies.length < 50) {
                flowAnomalies.push({
                  code,
                  date: d,
                  flow: Math.round(f * 1e4) / 1e4,
                  scalePrev: Math.round(scalePrev * 1e4) / 1e4,
                  scaleEnd: Math.round(scaleEnd * 1e4) / 1e4,
                });
              }
            }
          }
        }
      }
      seriesRows.push([
        s.sub, d,
        hit ? round4((sumShares / 1e4) * s.factor) : null,
        scaleHit ? round4(sumScale) : null,
        flowHit ? round4(sumFlow) : null,
        covBySub.get(s.sub)?.[di] ?? null,
      ]);
    }

    // —— 全市场（全部 ETF）——
    const agg = { SH: { shares: 0, scale: 0, n: 0 }, SZ: { shares: 0, scale: 0, n: 0 } };
    const byType = new Map();
    for (const [code, r] of eff) {
      if (!isEtf(code)) continue;
      const mkt = marketOf.get(code);
      if (!mkt) continue; // 不在 ETF 名录里的忽略
      const nav = navs.get(code);
      const sh = r.wan / 1e4;
      const sc = nav != null ? sh * nav : 0;
      agg[mkt].shares += sh;
      agg[mkt].scale += sc;
      agg[mkt].n++;
      const t = typeOf.get(code);
      const cur = byType.get(t) ?? { shares: 0, scale: 0, n: 0 };
      cur.shares += sh;
      cur.scale += sc;
      cur.n++;
      byType.set(t, cur);
    }
    mktRows.push([d, "SH", round4(agg.SH.shares), round4(agg.SH.scale), agg.SH.n]);
    mktRows.push([d, "SZ", round4(agg.SZ.shares), round4(agg.SZ.scale), agg.SZ.n]);
    mktRows.push([d, "ALL", round4(agg.SH.shares + agg.SZ.shares), round4(agg.SH.scale + agg.SZ.scale), agg.SH.n + agg.SZ.n]);
    for (const [t, v] of byType) typeRows.push([d, t, round4(v.shares), round4(v.scale), v.n]);

    // 净流入的前值也取「同一口径的有效行」，否则口径切换当天会算出一个假申购
    prev = new Map([...eff].map(([c, r]) => [c, r.wan]));
  }

  if (legacy) putSeries(db, seriesRows);
  else putSeriesV2(db, seriesRows);
  putMarket(db, mktRows);
  putMarketType(db, typeRows);
  return {
    seriesRows: seriesRows.length,
    marketRows: mktRows.length,
    typeRows: typeRows.length,
    dates: ds.length,
    mixedDays: mixedDays.length,
    mixedSample: mixedDays.slice(0, 5),
    flowAnomalies: flowAnomalies.length,
    flowAnomalySample: flowAnomalies.slice(0, 5),
  };
}

/** 兼容旧调用 */
export function recompute(db, opts) {
  return recomputeAll(db, opts).seriesRows;
}

/** 上交所历史回补：逐日抓全市场规模 */
export async function ingestExchangeRange(db, { from, to, onProgress, concurrency = 4 }) {
  const days = candidateDates(from, to);
  let n = 0, skipped = 0;
  const results = await sseMapLimit(days, concurrency, async (d) => {
    const r = await fetchSseDay(d);
    if (!r) { skipped++; return null; }
    const entries = Object.fromEntries(Object.entries(r.shares).map(([c, w]) => [c, { wan: w, src: "sse" }]));
    n += putShares(db, d, entries);
    markDaySource(db, d, "sse");
    onProgress?.(n, days.length);
    return d;
  });
  return { days: days.length, written: n, skipped, ok: results.filter(Boolean).length };
}

/** Tushare 历史回补：按基金逐只抓 5 年 */
export async function ingestTushareRange(db, { from, to, codes = ALL_CODES, onProgress, concurrency = 4, resume = true }) {
  const done = resume ? new Set(metaGet(db, "tsDone", [])) : new Set();
  const todo = codes.filter((c) => !done.has(c));
  let i = 0, written = 0, failed = 0;
  await tsMapLimit(todo, concurrency, async (code) => {
    try {
      const h = await shareHistory(code, from, to);
      written += putSharesBulk(db, code, h, "ts");
      for (const d of h.keys()) markDaySource(db, d, "ts");
      done.add(code);
      if (done.size % 50 === 0) metaSet(db, "tsDone", [...done]);
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[tushare] ${code} 份额抓取失败：${String(e.message).slice(0, 80)}`);
    }
    onProgress?.(++i, todo.length, code);
  });
  metaSet(db, "tsDone", [...done]);
  return { codes: todo.length, written, already: codes.length - todo.length, failed };
}

/** Tushare 净值回补（金额口径依赖） */
export async function ingestTushareNav(db, { from, to, codes = ALL_CODES, onProgress, concurrency = 4, resume = true }) {
  const done = resume ? new Set(metaGet(db, "navDone", [])) : new Set();
  const todo = codes.filter((c) => !done.has(c));
  let i = 0, rows = 0, failed = 0;
  await tsMapLimit(todo, concurrency, async (code) => {
    try {
      const h = await navHistory(code, from, to);
      if (h.size) putNav(db, [...h].map(([d, v]) => [code, d, v]));
      rows += h.size;
      done.add(code);
      if (done.size % 50 === 0) metaSet(db, "navDone", [...done]);
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[tushare] ${code} 净值抓取失败：${String(e.message).slice(0, 80)}`);
    }
    onProgress?.(++i, todo.length, code);
  });
  metaSet(db, "navDone", [...done]);
  return { codes: todo.length, rows, already: codes.length - todo.length, failed };
}

/** 需要补全的 ETF 代码（名录里名称含 ETF 的场内基金） */
export function etfCodes(db) {
  return db.prepare("SELECT code FROM fund WHERE name LIKE '%ETF%' ORDER BY code").all().map((r) => r.code);
}

/** 从旧版 data/series.json + data/shares/*.json 迁移（一次性） */
export function importLegacy(db) {
  let days = 0, seriesRows = 0;
  const sharesDir = path.join(ROOT, "data", "shares");
  if (fs.existsSync(sharesDir)) {
    for (const f of fs.readdirSync(sharesDir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const j = JSON.parse(fs.readFileSync(path.join(sharesDir, f), "utf8"));
      const sse = j.sse ? Object.fromEntries(Object.entries(j.sse).map(([c, w]) => [c, { wan: w, src: "sse" }])) : {};
      const szse = j.szse ? Object.fromEntries(Object.entries(j.szse).map(([c, w]) => [c, { wan: w, src: "szse" }])) : {};
      if (Object.keys(sse).length) { putShares(db, m[1], sse); markDaySource(db, m[1], "sse"); }
      if (Object.keys(szse).length) { putShares(db, m[1], szse); markDaySource(db, m[1], "szse"); }
      days++;
    }
  }
  const sj = path.join(ROOT, "data", "series.json");
  if (fs.existsSync(sj)) {
    const s = JSON.parse(fs.readFileSync(sj, "utf8"));
    const rows = [];
    for (const [sub, vals] of Object.entries(s.subs)) {
      for (let k = 0; k < s.dates.length; k++) if (vals[k] != null) rows.push([sub, s.dates[k], vals[k]]);
    }
    putSeries(db, rows);
    seriesRows = rows.length;
  }
  return { days, seriesRows };
}

/** 刷新基金名录 */
export async function refreshFunds(db) {
  const f = await fundBasic();
  upsertFunds(db, f.map((x) => ({ code: x.code, name: x.name, type: x.type, list_date: x.list_date })));
  return f.length;
}

/** 清空派生数据后重建 */
function require_universe() {
  return { loadUniverse: universeLoader };
}

export function rebuild(db) {
  db.exec("DELETE FROM series");
  db.exec("DELETE FROM market");
  db.exec("DELETE FROM market_type");
  const stats = recomputeAll(db);
  // v2 口径（指数类别 + 申万一级）：只有生成了 v2 分类才计算
  let v2 = null;
  try {
    const { loadUniverse } = require_universe();
    const U2 = loadUniverse({ taxonomy: "v2" });
    if (U2.stats?.taxonomy === "v2") {
      // 先备份：重算失败时回滚，避免留下空表让站点「静默回落 legacy」
      const backup = db.prepare("SELECT sub, date, val, scale, flow, coverage FROM series_v2").all();
      try {
        db.exec("DELETE FROM series_v2");
        v2 = recomputeAll(db, { universe: U2, legacy: false });
      } catch (e) {
        if (backup.length) {
          db.exec("DELETE FROM series_v2");
          const put = db.prepare("INSERT OR REPLACE INTO series_v2(sub,date,val,scale,flow,coverage) VALUES(?,?,?,?,?,?)");
          for (const r of backup) put.run(r.sub, r.date, r.val ?? null, r.scale ?? null, r.flow ?? null, r.coverage ?? null);
        }
        v2 = { error: String(e.message || e).slice(0, 80), rolledBack: backup.length };
        console.warn(`[recompute] v2 口径重算失败，已回滚 ${backup.length} 行：${v2.error}`);
      }
    }
  } catch (e) {
    v2 = { skipped: String(e.message || e).slice(0, 60) };
  }
  if (v2) stats.v2 = v2;
  recordRun(db, { at: new Date().toISOString(), kind: "recompute", ok: true, stats });
  return stats;
}

/** 把 DB 的序列导出成旧版 series.json（兼容/备份） */
export function exportSeriesJson(db, file) {
  const dates = tradingDates(db);
  const subs = {};
  for (const sub of Object.keys(SUB)) subs[sub] = new Array(dates.length).fill(null);
  const idx = new Map(dates.map((d, i) => [d, i]));
  for (const r of db.prepare("SELECT sub, date, val FROM series").all()) {
    const i = idx.get(r.date);
    if (i != null && subs[r.sub]) subs[r.sub][i] = r.val;
  }
  // 防御：若本次导出的历史明显短于已有文件，拒绝覆盖（防止 CI 空库把仓库里的数据改坏）
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    if (old.dates?.length && dates.length < old.dates.length * 0.5) {
      console.warn(`[exportSeriesJson] 本次 ${dates.length} 个交易日，远少于已有 ${old.dates.length} 个，已跳过覆盖`);
      return false;
    }
  } catch {}
  // 写成确定性的结构（键排序 + 不含时间戳），保证「数据没变就不产生提交」
  const ordered = Object.fromEntries(Object.keys(subs).sort().map((k) => [k, subs[k]]));
  fs.writeFileSync(file, JSON.stringify({ dates, subs: ordered }));
  return true;
}

if (isMain(import.meta.url)) {
  const cmd = process.argv[2] || "rebuild";
  const db = openDb();
  if (cmd === "import") {
    console.log(importLegacy(db));
  } else if (cmd === "rebuild") {
    console.log(rebuild(db));
  } else if (cmd === "export") {
    exportSeriesJson(db, "data/series.json");
    console.log("exported");
  }
}
