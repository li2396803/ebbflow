// 数据管道：多源摄取 → 合并落库 → 派生序列
//
// 合并策略（同一 code + date 只保留一行）：
//   交易所（sse/szse）优先级 1，Tushare（ts）优先级 2。
//   · 沪市：以交易所为准；交易所无当日数据时用 Tushare 补
//   · 深市：交易所只有最新一日，历史全部来自 Tushare
// 派生：小类值 = 成分 ETF 份额之和 ÷1e4（亿份），大类 9_债券 ×100；内部保留 4 位小数，展示取 1 位。
import fs from "node:fs";
import path from "node:path";
import { openDb, putShares, allDates, tradingDates, shareMap, shareRows, daySources, markDaySource, putSeries, metaSet, metaGet, recordRun, upsertFunds } from "./db.mjs";
import { ALL_CODES, SUB, CATS, BOND_CAT } from "./taxonomy.mjs";
import { fetchSseDay, candidateDates, mapLimit as sseMapLimit } from "./sources.mjs";
import { shareHistory, fundBasic, mapLimit as tsMapLimit } from "./tushare.mjs";

const round4 = (v) => Math.round(v * 10000) / 10000;

/** 用 share 表重算全部细分行业序列，写入 series 表 */
export function recompute(db, { dates } = {}) {
  const ds = dates ?? tradingDates(db);
  const rows = [];
  const subs = Object.entries(SUB).map(([sub, meta]) => ({
    sub,
    factor: meta.cat === BOND_CAT ? 100 : 1,
    codes: meta.etfs.map((e) => e.code),
    shCodes: new Set(meta.etfs.filter((e) => /^[569]/.test(e.code)).map((e) => e.code)),
  }));
  // 合并口径：某日若已有交易所该市场快照，则该市场只认交易所，不再叠加 Tushare 的补充行
  for (const d of ds) {
    const src = daySources(db, d);
    const byCode = new Map();
    for (const r of shareRows(db, d)) byCode.set(r.code, r);
    for (const s of subs) {
      let sum = 0, hit = 0;
      for (const code of s.codes) {
        const r = byCode.get(code);
        if (!r) continue;
        const isSh = s.shCodes.has(code);
        const official = isSh ? src.sse && r.src === "sse" : src.szse && r.src === "szse";
        if ((isSh ? src.sse : src.szse) && !official) continue; // 有交易所快照但这条是 Tushare 补的 → 不计入
        sum += r.wan; hit++;
      }
      rows.push([s.sub, d, hit ? round4((sum / 1e4) * s.factor) : null]);
    }
  }
  putSeries(db, rows);
  return rows.length;
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
export async function ingestTushareRange(db, { from, to, codes = ALL_CODES, onProgress, concurrency = 6, resume = true }) {
  const done = resume ? new Set(metaGet(db, "tsDone", [])) : new Set();
  const todo = codes.filter((c) => !done.has(c));
  let i = 0, written = 0;
  await tsMapLimit(todo, concurrency, async (code) => {
    const h = await shareHistory(code, from, to);
    if (!h.size) return;
    for (const [d, wan] of h) {
      written += putShares(db, d, { [code]: { wan, src: "ts" } });
      markDaySource(db, d, "ts");
    }
    done.add(code);
    if (done.size % 20 === 0) metaSet(db, "tsDone", [...done]);
    onProgress?.(++i, todo.length, code);
  });
  metaSet(db, "tsDone", [...done]);
  return { codes: todo.length, written, already: codes.length - todo.length };
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
export function rebuild(db) {
  db.exec("DELETE FROM series");
  const n = recompute(db);
  const stats = { seriesRows: n, dates: tradingDates(db).length };
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
  fs.writeFileSync(file, JSON.stringify({ dates, subs, meta: { exportedAt: new Date().toISOString() } }));
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
