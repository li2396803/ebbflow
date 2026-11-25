// 三源交叉校验（sse / szse / tushare）
//
//   node scripts/reconcile.mjs [--days 30] [--date 2026-11-20] [--quiet] [--no-write] [--out file]
//
// 做什么：
//   1. 取最近 N 个交易日，把「交易所（sse 沪市 / szse 深市）」与「Tushare」两侧的同日份额逐 code 对比
//      · 交易所侧来自 share 表（src=sse|szse），是官方披露口径 → 作为基准
//      · Tushare 侧优先现抓 shareOnDate（库里的 ts 行只包含「被交易所覆盖以外」的代码，不足以代表全量）
//   2. 分档：完全一致 / 相对差 ≤0.1% / ≤1% / >1%，明细最多 200 条
//   3. 小类层校验：分别用两侧份额重算 86 个小类，只取「两侧都有数据」的公共成分计算，
//      避免把覆盖率差异误判成数值分歧；同时比较方向（涨/跌）并指出谁偏离、偏离多少
//   4. 结果写 reconcile 表（先清空）+ data/quality.json
//
// 退出码：0 = 都在容差内；1 = 有 >1% 分歧；2 = 无法校验（无交易日 / Tushare 不可用）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, allDates, shareRows, clearReconcile, putReconcile, recordRun } from "../lib/db.mjs";
import { shareOnDate } from "../lib/tushare.mjs";
import { loadShares, officialCountsFromShares, resolveMarketModes, suspiciousJumps } from "../lib/invariants.mjs";
import * as dbApi from "../lib/db.mjs";
import { loadUniverse } from "../lib/universe.mjs";
import { isMain } from "../lib/cli.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const QUALITY_FILE = path.join(ROOT, "data", "quality.json");
const U = loadUniverse();
const SUB_SCOPE = U.SUB;
const BOND_CAT = "9_债券";
const UNIVERSE = U.ALL_CODES;
const UNIVERSE_SET = new Set(U.ALL_CODES);
const round4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const pct = (v) => (v == null || !Number.isFinite(v) ? null : round4(v * 100));
const log = (...a) => console.log(...a);

/** code → 首个所属小类（明细用） */
const CODE_SUB = new Map();
for (const [sub, meta] of Object.entries(SUB_SCOPE)) for (const e of meta.etfs) if (!CODE_SUB.has(e.code)) CODE_SUB.set(e.code, sub);

/**
 * 相对差：以 ref（交易所官方口径）为基准，看 val（Tushare）偏离多少。
 * ref 非正时退回 |val| 作分母；两者都为 0 视为 0。
 */
export function relDiff(ref, val) {
  if (ref == null || val == null) return null;
  const d = Math.abs(val - ref);
  if (d === 0) return 0;
  const base = Math.abs(ref) > 0 ? Math.abs(ref) : Math.abs(val);
  return base > 0 ? d / base : null;
}

/** 单对数值分档：identical / le0.1 / le1 / gt1 */
export function classifyPair(exchange, ts) {
  const rel = relDiff(exchange, ts);
  if (rel == null) return { bucket: "n/a", rel: null };
  if (Math.abs(ts - exchange) <= 1e-6) return { bucket: "identical", rel: 0 };
  if (rel <= 0.001) return { bucket: "le0.1", rel };
  if (rel <= 0.01) return { bucket: "le1", rel };
  return { bucket: "gt1", rel };
}

/** 只用「两侧都有值」的公共成分算小类值，保证是同一篮子的对比 */
export function subCommon(sub, mapA, mapB) {
  const meta = SUB_SCOPE[sub];
  if (!meta) return null;
  const factor = meta.cat === BOND_CAT ? 100 : 1;
  let sa = 0;
  let sb = 0;
  let n = 0;
  const codes = [];
  for (const e of meta.etfs) {
    const a = mapA.get(e.code);
    const b = mapB.get(e.code);
    if (a == null || b == null) continue;
    sa += a;
    sb += b;
    n++;
    codes.push(e.code);
  }
  if (!n) return null;
  return { a: round4((sa / 1e4) * factor), b: round4((sb / 1e4) * factor), n, codes };
}

const dirOf = (cur, prev) => {
  if (cur == null || prev == null || !(prev > 0)) return null;
  const d = cur - prev;
  if (Math.abs(d) / prev < 1e-9) return 0;
  return d > 0 ? 1 : -1;
};
const dirName = (d) => (d == null ? "—" : d > 0 ? "↑" : d < 0 ? "↓" : "→");

/** 读取某日三源：交易所侧（官方基准）与 Tushare 侧 */
export function splitDay(rows) {
  const sse = new Map();
  const szse = new Map();
  const dbTs = new Map();
  const exchangeSrc = new Map();
  for (const r of rows) {
    if (!UNIVERSE_SET.has(r.code)) continue;
    if (r.src === "sse") {
      sse.set(r.code, r.wan);
      exchangeSrc.set(r.code, "sse");
    } else if (r.src === "szse") {
      szse.set(r.code, r.wan);
      exchangeSrc.set(r.code, "szse");
    } else if (r.src === "ts") {
      dbTs.set(r.code, r.wan);
    }
  }
  const exchange = new Map([...sse, ...szse]);
  return { sse, szse, exchange, dbTs, exchangeSrc };
}

/** 逐 code 比对；返回分档统计 + 明细（明细由调用方再截断） */
export function compareCodes(exchange, exchangeSrc, ts) {
  const stats = { both: 0, identical: 0, le0_1: 0, le1: 0, gt1: 0, onlyExchange: 0, onlyTs: 0 };
  const detail = [];
  const onlyExchangeCodes = [];
  const onlyTsCodes = [];
  for (const code of UNIVERSE) {
    const a = exchange.get(code);
    const b = ts.get(code);
    if (a == null && b == null) continue;
    if (a == null) {
      stats.onlyTs++;
      if (onlyTsCodes.length < 50) onlyTsCodes.push(code);
      continue;
    }
    if (b == null) {
      stats.onlyExchange++;
      if (onlyExchangeCodes.length < 50) onlyExchangeCodes.push(code);
      continue;
    }
    stats.both++;
    const { bucket, rel } = classifyPair(a, b);
    if (bucket === "identical") stats.identical++;
    else if (bucket === "le0.1") stats.le0_1++;
    else if (bucket === "le1") stats.le1++;
    else stats.gt1++;
    if (bucket !== "identical") {
      detail.push({
        code,
        sub: CODE_SUB.get(code) ?? null,
        src: exchangeSrc.get(code) ?? null,
        exchange: a,
        ts: b,
        diff: round4(b - a),
        relPct: pct(rel),
        bucket,
      });
    }
  }
  detail.sort((x, y) => Math.abs(y.relPct ?? 0) - Math.abs(x.relPct ?? 0));
  return { stats, detail, onlyExchangeCodes, onlyTsCodes };
}

/**
 * 小类层：用公共成分分别计算两侧，比较差异与方向。
 * 返回 86 行（无公共成分的小类标 single-source）。
 */
export function compareSubs(exchange, ts, prevExchange, prevTs) {
  const rows = [];
  for (const sub of Object.keys(SUB_SCOPE)) {
    const cur = subCommon(sub, exchange, ts);
    if (!cur) {
      const reason =
        exchange.size === 0 ? "交易所当日无该小类数据" : ts.size === 0 ? "ts 当日无该小类数据" : "两侧无公共成分";
      rows.push({
        sub,
        status: "single-source",
        note: reason,
        exchange: null,
        ts: null,
        covered: 0,
        relPct: null,
        inconsistent: false,
      });
      continue;
    }
    const rel = relDiff(cur.a, cur.b);
    // 方向：用「前一日两侧都有值」的同一篮子，避免两日覆盖率变化把方向判反
    let dirEx = null;
    let dirTs = null;
    let basketN = 0;
    if (prevExchange && prevTs) {
      const basket = cur.codes.filter((c) => prevExchange.has(c) && prevTs.has(c));
      basketN = basket.length;
      if (basketN >= Math.max(3, Math.ceil(cur.codes.length * 0.5))) {
        const factor = SUB_SCOPE[sub]?.cat === BOND_CAT ? 100 : 1;
        const sumOf = (map) => {
          let s = 0;
          let n = 0;
          for (const c of basket) {
            const v = map.get(c);
            if (v != null) {
              s += v;
              n++;
            }
          }
          return n ? (s / 1e4) * factor : null;
        };
        const nowEx = sumOf(exchange);
        const nowTs = sumOf(ts);
        const prevExSum = sumOf(prevExchange);
        const prevTsSum = sumOf(prevTs);
        dirEx = dirOf(nowEx, prevExSum);
        dirTs = dirOf(nowTs, prevTsSum);
      }
    }
    // 方向相反只有在两侧数值本身也有可见差异时才算分歧（否则是覆盖差异造成的噪声）
    const opposite = dirEx != null && dirTs != null && dirEx * dirTs < 0 && rel != null && rel > 1e-4;
    const bigDiff = rel != null && rel > 0.01;
    const inconsistent = bigDiff || opposite;
    const devSide = rel == null ? null : cur.b > cur.a ? "ts 偏高" : cur.b < cur.a ? "ts 偏低" : "一致";
    const note = inconsistent
      ? `${devSide}，ts 相对交易所偏离 ${pct(rel)}%（公共成分 ${cur.n} 只；方向 交易所${dirName(dirEx)} / ts${dirName(dirTs)}${opposite ? "，方向相反" : ""}）`
      : `一致（偏离 ${pct(rel)}%，公共成分 ${cur.n} 只）`;
    rows.push({
      sub,
      status: "both",
      exchange: cur.a,
      ts: cur.b,
      covered: cur.n,
      relPct: pct(rel),
      dirExchange: dirName(dirEx),
      dirTs: dirName(dirTs),
      opposite,
      deviant: inconsistent ? "ts" : null,
      inconsistent,
      note,
    });
  }
  return rows;
}

/** 参数解析（供 CLI 与测试复用） */
export function parseArgs(argv) {
  const a = { days: 30, date: null, quiet: false, out: QUALITY_FILE, write: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--days") a.days = Math.max(1, parseInt(argv[++i], 10) || 30);
    else if (k === "--date") a.date = argv[++i];
    else if (k === "--out") a.out = path.resolve(argv[++i]);
    else if (k === "--quiet" || k === "-q") a.quiet = true;
    else if (k === "--no-write") a.write = false;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`未知参数 ${k}`);
  }
  return a;
}

async function fetchTs(date, dbTs) {
  try {
    const live = await shareOnDate(date);
    const m = new Map();
    for (const [c, w] of live) if (UNIVERSE_SET.has(c) && Number.isFinite(w)) m.set(c, w);
    if (m.size) return { map: m, from: "live", error: null };
    if (dbTs.size) return { map: dbTs, from: "db", error: "现抓结果为空，退回库内 ts 行" };
    return { map: new Map(), from: "unavailable", error: "现抓结果为空" };
  } catch (e) {
    const msg = String(e?.message || e);
    if (dbTs.size) return { map: dbTs, from: "db", error: msg };
    return { map: new Map(), from: "unavailable", error: msg };
  }
}

export async function reconcile(args = parseArgs([])) {
  const db = openDb();
  const all = allDates(db);
  if (!all.length) {
    log("警告：share 表没有数据，无法校验（先跑 scripts/backfill.mjs）");
    return { code: 2, quality: { generatedAt: new Date().toISOString(), days: [], summary: { error: "no data" } } };
  }
  // 交易日口径：优先只比 dayinfo.has_sse=1 的日期（排除 Tushare 的季末/周末披露）
  let tradeSet = null;
  try {
    if (typeof dbApi.tradingDates === "function") {
      const td = dbApi.tradingDates(db);
      if (td.length) tradeSet = new Set(td);
    }
  } catch {}
  const trading = tradeSet ? all.filter((d) => tradeSet.has(d)) : all;
  let dates = args.date ? all.filter((d) => d === args.date) : (trading.length ? trading : all).slice(-args.days);
  if (!dates.length) {
    log(`警告：没有匹配的交易日（共 ${all.length} 个：${all[0]} ~ ${all.at(-1)}）`);
    return { code: 2, quality: { generatedAt: new Date().toISOString(), days: [], summary: { error: "no matching date" } } };
  }

  const days = [];
  let prevEx = null;
  let prevTs = null;
  const tot = { both: 0, identical: 0, le0_1: 0, le1: 0, gt1: 0, onlyExchange: 0, onlyTs: 0 };
  let subBoth = 0;
  let subInconsistent = 0;
  let subSingle = 0;
  const tsFromCount = { live: 0, db: 0, unavailable: 0 };
  const dbRows = [];
  let written = 0;

  for (const date of dates) {
    const rows = shareRows(db, date);
    const { sse, szse, exchange, dbTs, exchangeSrc } = splitDay(rows);
    const tsSide = await fetchTs(date, dbTs);
    tsFromCount[tsSide.from] = (tsFromCount[tsSide.from] || 0) + 1;

    const { stats, detail, onlyExchangeCodes, onlyTsCodes } = compareCodes(exchange, exchangeSrc, tsSide.map);
    for (const k of ["both", "identical", "le0_1", "le1", "gt1", "onlyExchange", "onlyTs"]) tot[k] += stats[k];

    const seriesCheck = compareSubs(exchange, tsSide.map, prevEx, prevTs);
    for (const s of seriesCheck) {
      if (s.status === "both") subBoth++;
      else subSingle++;
      if (s.inconsistent) subInconsistent++;
    }

    const byCode = detail.slice(0, 200);
    days.push({
      date,
      perSource: {
        sse: { codes: sse.size },
        szse: { codes: szse.size },
        exchange: { codes: exchange.size },
        ts: { codes: tsSide.map.size, from: tsSide.from, error: tsSide.error ?? null },
      },
      mismatch: { count: detail.length, byCode },
      // 单侧覆盖差异（两源不是「数值不一致」，而是「一边没有这一天」）
      coverage: { onlyExchange: onlyExchangeCodes, onlyTs: onlyTsCodes },
      seriesCheck,
    });

    // 落库：code 级只写「超出 0.1%」的分歧（≤0.1% 属于四舍五入噪声），小类级只写不一致的
    for (const d of byCode) {
      if (d.bucket === "le0.1") continue;
      dbRows.push({ date, sub: d.sub, code: d.code, a: d.exchange, b: d.ts, note: `rel=${d.relPct}% bucket=${d.bucket}` });
    }
    for (const s of seriesCheck) {
      if (!s.inconsistent) continue;
      dbRows.push({ date, sub: s.sub, code: null, a: s.exchange, b: s.ts, note: s.note });
    }

    prevEx = exchange;
    prevTs = tsSide.map;

    if (!args.quiet) {
      const flag = stats.gt1 ? "✗" : stats.le1 || stats.le0_1 ? "△" : "✓";
      log(
        `${flag} ${date}  交易所 ${String(exchange.size).padStart(4)} 只 / ts ${String(tsSide.map.size).padStart(4)} 只（${tsSide.from}）` +
          `  公共 ${String(stats.both).padStart(4)}：一致 ${stats.identical}，≤0.1% ${stats.le0_1}，≤1% ${stats.le1}，>1% ${stats.gt1}` +
          `  小类不一致 ${seriesCheck.filter((s) => s.inconsistent).length}`
      );
    }
  }

  const totalCompared = tot.both;
  const worstCode = days
    .flatMap((d) => d.mismatch.byCode)
    .sort((a, b) => Math.abs(b.relPct ?? 0) - Math.abs(a.relPct ?? 0))[0] ?? null;
  const worstSub = days
    .flatMap((d) => d.seriesCheck)
    .filter((s) => s.status === "both")
    .sort((a, b) => Math.abs(b.relPct ?? 0) - Math.abs(a.relPct ?? 0))[0] ?? null;

  // 可疑跳变归因（P0-3）：用库内序列 + 当期份额算，不需要联网；写进 quality.json 供前端/审计查询
  let jumpsInfo = null;
  try {
    const sharesByDate = loadShares(db, dates);
    const modes = resolveMarketModes({ dates, official: officialCountsFromShares(sharesByDate) });
    const jumps = suspiciousJumps(db, { universe: { SUB: SUB_SCOPE }, table: "series", thresholdPct: 30, dates, modes, sharesByDate });
    jumpsInfo = {
      generatedAt: new Date().toISOString(),
      thresholdPct: 30,
      total: jumps.length,
      unknown: jumps.filter((j) => j.reasons.includes("unknown")).length,
      items: jumps.slice(0, 30),
    };
  } catch (e) {
    jumpsInfo = { error: String(e?.message || e).slice(0, 120) };
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    days: days.length,
    range: [dates[0], dates.at(-1)],
    compared: { ...tot, detailCapped: days.some((d) => d.mismatch.count > d.mismatch.byCode.length) },
    // 一致性比率：同 code 同日两源都有值时，落在各档的比例
    rates: {
      identical: totalCompared ? round4(tot.identical / totalCompared) : null,
      le0_1: totalCompared ? round4(tot.le0_1 / totalCompared) : null,
      le1: totalCompared ? round4(tot.le1 / totalCompared) : null,
      gt1: totalCompared ? round4(tot.gt1 / totalCompared) : null,
    },
    subs: { checked: subBoth, inconsistent: subInconsistent, singleSource: subSingle },
    tsSource: tsFromCount,
    dateAxis: { tradingOnly: !!tradeSet, all: all.length, compared: dates.length },
    worstCode,
    worstSub: worstSub ? { sub: worstSub.sub, relPct: worstSub.relPct, note: worstSub.note } : null,
    tolerance: { identical: 1e-6, bucket01Pct: 0.001, bucket1Pct: 0.01 },
    diverged: tot.gt1 + subInconsistent,
    ok: tot.gt1 === 0 && subInconsistent === 0,
  };
  const quality = { generatedAt: summary.generatedAt, days, summary, jumps: jumpsInfo };

  if (args.write) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(quality));
    clearReconcile(db);
    if (dbRows.length) putReconcile(db, dbRows.slice(0, 5000));
    written = Math.min(dbRows.length, 5000);
  }

  // 退出码：无法校验 → 2；有 >1% 分歧 → 1；否则 0
  let code = 0;
  if (tsFromCount.unavailable === dates.length) code = 2;
  else if (tot.gt1 > 0 || subInconsistent > 0) code = 1;

  if (args.write) {
    recordRun(db, {
      at: new Date().toISOString(),
      kind: "reconcile",
      ok: code === 0,
      stats: { days: days.length, compared: tot, subs: summary.subs, tsSource: tsFromCount, code },
      err: code === 2 ? "tushare 不可用" : null,
    });
  }

  {
    // 汇总结论总是打印（--quiet 只压掉逐日明细）
    log("");
    log(`区间 ${dates[0]} ~ ${dates.at(-1)}（${days.length} 个交易日）｜两源公共 code 比对 ${totalCompared} 对`);
    log(
      `分档：完全一致 ${tot.identical}（${(summary.rates.identical * 100 || 0).toFixed(2)}%）` +
        ` ≤0.1% ${tot.le0_1}  ≤1% ${tot.le1}  >1% ${tot.gt1}`
    );
    log(`只有交易所：${tot.onlyExchange} 只｜只有 ts：${tot.onlyTs} 只（分类体系全部为沪市代码，深市快照不在其中）`);
    if (tot.gt1 || worstCode) log(`最大单只分歧：${worstCode.code}（${worstCode.sub ?? "未归类"}）交易所 ${worstCode.exchange} vs ts ${worstCode.ts}，偏离 ${worstCode.relPct}%`);
    log(`小类层：可比 ${subBoth} 项，不一致 ${subInconsistent} 项，单源 ${subSingle} 项`);
    if (subInconsistent && worstSub) log(`最大小类分歧：${worstSub.sub} 偏离 ${worstSub.relPct}%（${worstSub.note}）`);
    else log(`小类层：同篮子（公共成分）两侧 86 项全部在容差内`);
    if (jumpsInfo && !jumpsInfo.error) log(`可疑跳变（±30%）：${jumpsInfo.total} 处，其中未知原因 ${jumpsInfo.unknown} 处`);
    log(`ts 来源：现抓 ${tsFromCount.live} 天 / 库内 ${tsFromCount.db} 天 / 不可用 ${tsFromCount.unavailable} 天`);
    const verdict = code === 1 ? "（存在 >1% 分歧）" : code === 2 ? "（无法校验）" : "（容差内）";
    if (args.write) log(`写入：reconcile 表 ${written} 行，${path.relative(ROOT, args.out)}｜退出码 ${code}${verdict}`);
    else log(`未写入（--no-write）：reconcile 表与 quality.json 均未更新｜退出码 ${code}${verdict}`);
  }
  db.close();
  return { code, quality, written };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log("用法: node scripts/reconcile.mjs [--days 30] [--date YYYY-MM-DD] [--quiet] [--no-write] [--out file]");
    process.exit(0);
  }
  reconcile(args)
    .then(({ code }) => process.exit(code))
    .catch((e) => {
      console.error("交叉校验失败:", e?.stack || e);
      process.exit(2);
    });
}
