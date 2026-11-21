// 历史回补编排（只做编排与校验，落地写入一律走 lib/db.mjs 的 putShares）
//
//   node scripts/backfill.mjs [--from 2021-11-22] [--to today] [--source ts|sse|both]
//                             [--limit N] [--dry-run] [--concurrency 6] [--no-resume]
//
//   --source ts   : 按 ALL_CODES 逐只抓 Tushare 5 年份额（4 位小数），src='ts'
//   --source sse  : 按候选交易日逐日抓上交所快照（官方口径），src='sse'
//   --source both : 先 sse 再 ts（交易所优先级更高，先写 ts 也能被 sse 覆盖）
//
// 断点续跑：
//   · ts：每只基金完整写入后记入 meta['bf:tsDone']；重跑时跳过已完成 + 已有 ≥90% 覆盖的代码
//   · sse：某日已有 src='sse' 行则跳过
// 抓取克制：并发 ≤6（源模块自带重试），按天事务写入，只写有限正数，失败不落脏数据。
import { openDb, putShares, allDates, dbStats, metaSet, metaGet, recordRun } from "../lib/db.mjs";
import { ALL_CODES } from "../lib/taxonomy.mjs";
import { fetchSseDay, candidateDates, mapLimit as mapLimitSse } from "../lib/sources.mjs";
import { shareHistory, mapLimit as mapLimitTs } from "../lib/tushare.mjs";
import { coverageReport, coverageLine, validateSeries } from "../lib/validate.mjs";

const DEFAULT_FROM = "2021-11-22";
const BATCH = 40; // 每批基金数：按天聚合后一次性 putShares，减少事务数
const log = (...a) => console.log(...a);

/** 本地（Asia/Shanghai）今天 YYYY-MM-DD */
export function todayStr(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function parseArgs(argv) {
  const a = {
    from: DEFAULT_FROM,
    to: "today",
    source: "both",
    limit: 0,
    dryRun: false,
    concurrency: 6,
    resume: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--from") a.from = argv[++i];
    else if (k === "--to") a.to = argv[++i];
    else if (k === "--source") a.source = argv[++i];
    else if (k === "--limit") a.limit = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (k === "--concurrency") a.concurrency = Math.min(6, Math.max(1, parseInt(argv[++i], 10) || 6));
    else if (k === "--dry-run" || k === "--dryRun") a.dryRun = true;
    else if (k === "--no-resume") a.resume = false;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`未知参数 ${k}`);
  }
  if (!["ts", "sse", "both"].includes(a.source)) throw new Error(`--source 只能是 ts / sse / both（收到 ${a.source}）`);
  if (a.to === "today") a.to = todayStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.from) || !/^\d{4}-\d{2}-\d{2}$/.test(a.to))
    throw new Error(`日期格式应为 YYYY-MM-DD（收到 ${a.from} / ${a.to}）`);
  if (a.from > a.to) throw new Error(`--from ${a.from} 晚于 --to ${a.to}`);
  return a;
}

/** Tushare 阶段：逐只抓全历史，按天聚合后写库 */
export async function backfillTushare(db, { from, to, limit = 0, dryRun = false, concurrency = 6, resume = true, quiet = false } = {}) {
  const datesInRange = allDates(db).filter((d) => d >= from && d <= to);
  const totalDates = datesInRange.length;
  // 断点续跑：本工具自己的进度 + lib/pipeline.mjs 的 tsDone（同一语义，取并集避免重复抓）
  const doneSet = new Set(
    resume ? [...(metaGet(db, "bf:tsDone", []) ?? []), ...(metaGet(db, "tsDone", []) ?? [])] : []
  );
  const countTs = db.prepare("SELECT COUNT(*) AS n FROM share WHERE code=? AND src='ts' AND date>=? AND date<=?");
  const isCovered = (code) => {
    if (doneSet.has(code)) return true;
    if (!resume || !totalDates) return false;
    // 库内 ts 行已覆盖区间 ≥90% 的交易日 → 视为补过（新发基金上市晚，首轮会重抓一次，之后记入 meta 就不再抓）
    return (countTs.get(code, from, to)?.n ?? 0) >= Math.floor(totalDates * 0.9);
  };

  const todo = ALL_CODES.filter((c) => !isCovered(c));
  const picked = limit ? todo.slice(0, limit) : todo;
  const stats = {
    from,
    to,
    codes: ALL_CODES.length,
    already: ALL_CODES.length - todo.length,
    todo: todo.length,
    picked: picked.length,
    written: 0,
    codesDone: 0,
    skippedZero: 0,
    skippedNonTrading: 0,
    errors: [],
  };
  if (!quiet) {
    log(`[ts] 区间 ${from} ~ ${to}（库内 ${totalDates} 个交易日）｜${ALL_CODES.length} 只基金：已完成 ${stats.already}，待补 ${stats.todo}${limit ? `，本次限 ${stats.picked}` : ""}`);
  }
  if (dryRun) {
    if (!quiet) log(`[ts] dry-run：计划 ${Math.ceil(picked.length / BATCH)} 批 × 并发 ${concurrency}，不抓取、不写库`);
    return stats;
  }

  const batchCount = Math.ceil(picked.length / BATCH);
  let batchNo = 0;
  for (let i = 0; i < picked.length; i += BATCH) {
    const batch = picked.slice(i, i + BATCH);
    batchNo++;
    const results = await mapLimitTs(batch, Math.min(concurrency, batch.length), async (code) => {
      const hist = await shareHistory(code, from, to);
      return { code, hist };
    });

    // 同批结果按天聚合：一天一次 putShares（事务内），避免每只基金每天一次事务
    const perDay = new Map();
    for (const r of results) {
      if (!r || r.error) {
        if (r?.error) stats.errors.push(r.error);
        continue;
      }
      let ok = 0;
      for (const [d, wan] of r.hist) {
        if (!Number.isFinite(wan) || wan <= 0) {
          stats.skippedZero++;
          continue;
        }
        // Tushare 偶尔会给出周末/季末的「报告期」行，写进 share 会污染交易日轴 → 丢弃
        const w = new Date(`${d}T00:00:00Z`).getUTCDay();
        if (w === 0 || w === 6) {
          stats.skippedNonTrading++;
          continue;
        }
        let m = perDay.get(d);
        if (!m) perDay.set(d, (m = {}));
        m[r.code] = { wan, src: "ts" };
        ok++;
      }
      // 抓取成功就记完成（返回空集说明该基金在区间内没有披露，属正常，不必每次重抓）
      doneSet.add(r.code);
      stats.codesDone++;
    }
    for (const [d, entries] of perDay) stats.written += putShares(db, d, entries);
    metaSet(db, "bf:tsDone", [...doneSet]);

    const pct = Math.round((Math.min(i + BATCH, picked.length) / Math.max(1, picked.length)) * 100);
    if (!quiet && (batchNo === batchCount || batchNo <= 3 || batchNo % Math.max(1, Math.floor(batchCount / 8)) === 0)) {
      log(`[ts] 批次 ${batchNo}/${batchCount}（${pct}%）写入 ${stats.written} 行，完成 ${stats.codesDone} 只，失败 ${stats.errors.length}`);
    }
  }
  // 抓取失败的代码不写入，只在运行记录里留痕
  if (!quiet && stats.skippedZero) log(`[ts] 跳过非正份额 ${stats.skippedZero} 个、周末/非交易日 ${stats.skippedNonTrading} 个`);
  if (stats.errors.length && !quiet) log(`[ts] 失败 ${stats.errors.length} 只（未写库，可重跑续传）：${stats.errors.slice(0, 3).join(" | ")}`);
  return stats;
}

/** 上交所阶段：逐日抓全市场快照 */
export async function backfillSse(db, { from, to, limit = 0, dryRun = false, concurrency = 4, resume = true, quiet = false } = {}) {
  const cands = candidateDates(from, to);
  const hasSse = db.prepare("SELECT 1 AS x FROM share WHERE date=? AND src='sse' LIMIT 1");
  // 已确认为空（节假日/无披露）的日期记在 meta，避免每次重跑都白请求一遍
  const emptySet = new Set(resume ? metaGet(db, "bf:sseEmpty", []) ?? [] : []);
  const todo = resume ? cands.filter((d) => !hasSse.get(d) && !emptySet.has(d)) : cands;
  const picked = limit ? todo.slice(0, limit) : todo;
  const stats = {
    from,
    to,
    candidates: cands.length,
    already: cands.length - todo.length,
    todo: todo.length,
    picked: picked.length,
    days: 0,
    written: 0,
    empty: 0,
    emptyDates: [],
    errors: [],
  };
  if (!quiet) {
    log(`[sse] 区间 ${from} ~ ${to}｜候选交易日 ${cands.length}：已有/已知空 ${stats.already}，待抓 ${stats.todo}${limit ? `，本次限 ${stats.picked}` : ""}`);
  }
  if (dryRun) {
    if (!quiet) log(`[sse] dry-run：计划 ${picked.length} 次请求 × 并发 ${concurrency}，不抓取、不写库`);
    return stats;
  }
  let n = 0;
  const results = await mapLimitSse(picked, Math.min(concurrency, Math.max(1, picked.length)), async (d) => {
    n++;
    const r = await fetchSseDay(d); // 源模块内含重试；抛错会被 mapLimit 收进 {error}
    if (!r) {
      stats.empty++; // 非交易日/该日无数据
      stats.emptyDates.push(d);
      return d;
    }
    const entries = {};
    for (const [code, wan] of Object.entries(r.shares)) {
      if (Number.isFinite(wan) && wan > 0) entries[code] = { wan, src: "sse" };
    }
    if (!Object.keys(entries).length) {
      stats.empty++;
      return d;
    }
    stats.written += putShares(db, d, entries);
    stats.days++;
    if (!quiet && (n === picked.length || n <= 2 || n % Math.max(1, Math.floor(picked.length / 8)) === 0)) {
      log(`[sse] ${n}/${picked.length} 日：已写入 ${stats.days} 天 / ${stats.written} 行，空 ${stats.empty}`);
    }
    return d;
  });
  for (const r of results) if (r && r.error) stats.errors.push(String(r.error));
  if (stats.emptyDates.length) {
    metaSet(db, "bf:sseEmpty", [...new Set([...emptySet, ...stats.emptyDates])].sort());
    if (!quiet)
      log(
        `[sse] 空结果 ${stats.emptyDates.length} 天（节假日/未披露，已记入 meta bf:sseEmpty，后续不再重抓）：` +
          `${stats.emptyDates.slice(0, 5).join(",")}`
      );
  }
  if (stats.errors.length && !quiet) log(`[sse] 失败 ${stats.errors.length} 天（未写库，可重跑续传）：${stats.errors.slice(0, 3).join(" | ")}`);
  return stats;
}

/** 收尾：库概览 + 覆盖率摘要 + 序列体检（各一行） */
export function report(db, { quiet = false } = {}) {
  const s = dbStats(db);
  const cov = coverageReport(db);
  const series = validateSeries(db, undefined, { maxIssues: 20 });
  const byKind = Object.entries(series.byKind ?? {}).map(([k, n]) => `${k}×${n}`).join(" ") || "无";
  if (!quiet) {
    log(`库概览：${s.days} 个交易日（${s.from} ~ ${s.to}）｜${s.codes} 只标的 / ${s.rows} 份额行｜series ${s.series} 行`);
    log(`覆盖率：${coverageLine(cov)}`);
    log(`序列体检：${series.level}（扫描 ${series.scanned.points} 点，异常 ${byKind}${series.truncated ? "，已截断" : ""}）`);
  }
  return { dbStats: s, coverage: cov, series };
}

export async function backfill(args) {
  const db = openDb();
  const started = Date.now();
  const all = {};
  let ok = true;
  let err = null;
  try {
    if (args.source === "sse" || args.source === "both") {
      all.sse = await backfillSse(db, { ...args });
      if (all.sse.errors.length && !all.sse.days) ok = false;
    }
    if (args.source === "ts" || args.source === "both") {
      all.ts = await backfillTushare(db, { ...args });
      if (all.ts.errors.length && !all.ts.codesDone) ok = false;
    }
    if (!args.dryRun) report(db, args);
  } catch (e) {
    ok = false;
    err = String(e?.message || e);
    log(`回补失败：${err}`);
  } finally {
    const stats = { ...all, ms: Date.now() - started, dryRun: args.dryRun, from: args.from, to: args.to };
    if (!args.dryRun) {
      recordRun(db, { at: new Date().toISOString(), kind: `backfill:${args.source}`, ok, stats, err });
    }
    db.close();
  }
  return { ok, stats: all, err };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message));
    process.exit(2);
  }
  if (args.help) {
    log("用法: node scripts/backfill.mjs [--from 2021-11-22] [--to today] [--source ts|sse|both] [--limit N] [--dry-run] [--concurrency 6] [--no-resume]");
    process.exit(0);
  }
  backfill(args)
    .then(({ ok }) => process.exit(ok ? 0 : 1))
    .catch((e) => {
      console.error("回补失败:", e?.stack || e);
      process.exit(1);
    });
}
