// 数据管道：多源摄取 → 合并落库 → 派生序列
//
// 合并策略（同一 code + date 只保留一行）：
//   交易所（sse/szse）优先级 1，Tushare（ts）优先级 2。
//   · 沪市：以交易所为准；交易所无当日数据时用 Tushare 补
//   · 深市：交易所只有最新一日，历史全部来自 Tushare
// 派生：小类值 = 成分 ETF 份额之和 ÷1e4（亿份），大类 9_债券 ×100；内部保留 4 位小数，展示取 1 位。
import fs from "node:fs";
import path from "node:path";
import { openDb, putShares, putSharesBulk, putSeriesV2, allDates, tradingDates, shareMap, shareRows, navMap, daySources, markDaySource, putSeries, putMarket, putMarketType, putNav, metaSet, metaGet, recordRun, upsertFunds } from "./db.mjs";
import { loadUniverse as universeLoader } from "./universe.mjs";

const UNIVERSE = universeLoader({ taxonomy: "legacy" });
const SUB = UNIVERSE.SUB;
const CATS = UNIVERSE.CATS;
const ALL_CODES = UNIVERSE.ALL_CODES;
const BOND_CAT = "9_债券";
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
export function recomputeAll(db, { dates, universe, legacy = true } = {}) {
  const U = universe ?? { SUB, CATS };
  const SUB_U = U.SUB;
  const CATS_U = U.CATS;
  const ds = dates ?? tradingDates(db);
  const subDefs = Object.entries(SUB_U).map(([sub, meta]) => ({
    sub,
    factor: meta.cat === BOND_CAT ? 100 : 1,
    codes: meta.etfs.map((e) => e.code),
    shCodes: new Set(meta.etfs.filter((e) => /^[569]/.test(e.code)).map((e) => e.code)),
  }));
  const funds = db.prepare("SELECT code, type, market FROM fund WHERE name LIKE '%ETF%'").all();
  const marketOf = new Map(funds.map((f) => [f.code, f.market === "SH" ? "SH" : "SZ"]));
  const typeOf = new Map(funds.map((f) => [f.code, f.type || "其他"]));

  const needed = new Set(funds.map((f) => f.code));
  for (const s of subDefs) for (const c of s.codes) needed.add(c);
  const ctx = loadContext(db, { dates: ds, codes: needed });

  const seriesRows = [];
  const mktRows = [];
  const typeRows = [];
  let prev = null;

  for (const d of ds) {
    const byCode = ctx.shares.get(d) ?? new Map();
    const navs = ctx.navs.get(d) ?? new Map();
    const src = ctx.daySrc.get(d) ?? { sse: false, szse: false };

    // —— 细分行业 ——
    for (const s of subDefs) {
      let sumShares = 0, hit = 0, sumScale = 0, scaleHit = 0, sumFlow = 0, flowHit = 0;
      for (const code of s.codes) {
        const r = byCode.get(code);
        if (!r) continue;
        const isSh = s.shCodes.has(code);
        const official = isSh ? src.sse && r.src === "sse" : src.szse && r.src === "szse";
        if ((isSh ? src.sse : src.szse) && !official) continue;
        sumShares += r.wan;
        hit++;
        const nav = navs.get(code);
        if (nav != null) {
          sumScale += (r.wan / 1e4) * nav;
          scaleHit++;
          const p = prev?.get(code);
          if (p != null && p > 0) {
            sumFlow += ((r.wan - p) / 1e4) * nav;
            flowHit++;
          }
        }
      }
      seriesRows.push([
        s.sub, d,
        hit ? round4((sumShares / 1e4) * s.factor) : null,
        scaleHit ? round4(sumScale) : null,
        flowHit ? round4(sumFlow) : null,
      ]);
    }

    // —— 全市场（全部 ETF）——
    const agg = { SH: { shares: 0, scale: 0, n: 0 }, SZ: { shares: 0, scale: 0, n: 0 } };
    const byType = new Map();
    for (const [code, r] of byCode) {
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

    prev = new Map([...byCode].map(([c, r]) => [c, r.wan]));
  }

  if (legacy) putSeries(db, seriesRows);
  else putSeriesV2(db, seriesRows);
  putMarket(db, mktRows);
  putMarketType(db, typeRows);
  return { seriesRows: seriesRows.length, marketRows: mktRows.length, typeRows: typeRows.length, dates: ds.length };
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
  const sharesDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "shares");
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
  const sj = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "series.json");
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
  upsertFunds(db, f.map((x) => ({ code: x.code, name: x.name, type: x.type })));
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
      db.exec("DELETE FROM series_v2");
      v2 = recomputeAll(db, { universe: U2, legacy: false });
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
