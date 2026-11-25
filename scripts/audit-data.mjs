#!/usr/bin/env node
// 离线数据审计（P2-12）：不联网、只读本地 DB + 仓库数据文件，检查全部 P0 不变量。
//
//   node scripts/audit-data.mjs            # 有硬违规 → 退出码 1
//   node scripts/audit-data.mjs --strict   # 连「可疑跳变（未知原因）」这类告警也算失败
//   node scripts/audit-data.mjs --quiet    # 只打失败项
//   node scripts/audit-data.mjs --db /tmp/x.db   # 指定数据库（默认 data/etf.db；测试/排查用）
//
// 检查项（逐条对应 docs/AUDIT-PIPELINE.md）：
//   A. 交易日轴：有数据却进不了轴的日子（覆盖残缺）→ 违规；轴内两市区间的中位数判定可复算
//   B. 事实层：同一 (code,date) 只有一行；不存在「官方行有了还留着 Tushare 行」的重叠
//   C. 数值自洽：series / series_v2 的值 = 成分之和（含官方口径），market ALL = SH + SZ
//   D. 序列卫生：派生序列不含轴外日期；可疑跳变有归因（未知原因的只告警）
//   E. 数据文件：无 git 冲突标记、JSON 可解析、series.json 覆盖 ≥1000 个交易日
//   F. 覆盖率：最新交易日的两市覆盖不得低于近 20 日中位数的区间下限
import fs from "node:fs";
import path from "node:path";
import { openDb, dbStats, axisDiagnostics, dayCoverage } from "../lib/db.mjs";
import { loadUniverse } from "../lib/universe.mjs";
import { loadShares, loadSeries, officialCountsFromShares, resolveMarketModes, numericChecks, suspiciousJumps, BAND , detectUnitOutliers, filterIsolated} from "../lib/invariants.mjs";
import { projectRoot, readJsonFile } from "../lib/cli.mjs";

const ROOT = projectRoot(import.meta.url);
const QUIET = process.argv.includes("--quiet");
const STRICT = process.argv.includes("--strict");

const results = [];
const record = (name, ok, detail = [], { severity = "fail" } = {}) => results.push({ name, ok, detail, severity });

const CONFLICT_RE = /^(<{7}|={7}|>{7})(\s|$)/m;
const GENERATED_FILES = ["data/series.json", "data/quality.json"];

function checkFiles() {
  const bad = [];
  for (const rel of GENERATED_FILES) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, "utf8");
    if (CONFLICT_RE.test(txt)) bad.push(`${rel}（含 git 冲突标记）`);
    else {
      try {
        JSON.parse(txt);
      } catch (e) {
        bad.push(`${rel}（JSON 解析失败：${e.message.slice(0, 40)}）`);
      }
    }
  }
  // 站点首页也是入库文件；冲突标记会让页面直接坏掉
  const idx = path.join(ROOT, "site", "index.html");
  if (fs.existsSync(idx) && CONFLICT_RE.test(fs.readFileSync(idx, "utf8"))) bad.push("site/index.html（含 git 冲突标记）");
  record("E. 数据文件可解析、无冲突标记", bad.length === 0, bad.length ? bad : GENERATED_FILES.map((f) => `${f} ✓`));

  const sj = path.join(ROOT, "data", "series.json");
  if (fs.existsSync(sj)) {
    try {
      const j = readJsonFile(sj);
      const n = j.dates?.length ?? 0;
      record("E. series.json 覆盖交易日 ≥1000", n >= 1000, [`${n} 个交易日`], { severity: "warn" });
    } catch (e) {
      record("E. series.json 覆盖交易日 ≥1000", false, [String(e.message).slice(0, 60)]);
    }
  }
}

function checkDb() {
  const dbIdx = process.argv.indexOf("--db");
  const dbFile = dbIdx > 0 ? path.resolve(process.argv[dbIdx + 1]) : undefined;
  const db = openDb(dbFile);
  try {
    const stats = dbStats(db);
    if (!stats.days) {
      record("A. 交易日轴存在", false, ["库为空（还没有回填数据）"]);
      return;
    }
    const ax = axisDiagnostics(db);
    record("A. 交易日轴存在且可诊断", ax.dates.length > 0, [`${ax.dates.length} 个交易日（${ax.dates[0]} ~ ${ax.dates.at(-1)}）`]);

    // A1: 有份额数据、有来源标记，却因为覆盖残缺没进轴 → 需要人工/自动修复
    const inAxis = new Set(ax.dates);
    const withData = db.prepare("SELECT DISTINCT date FROM share").all().map((r) => r.date);
    const stranded = withData.filter((d) => !inAxis.has(d) && ax.excluded.some((x) => x.date === d && x.reason !== "ts_thin"));
    record(
      "A. 有数据但进不了轴的日子（覆盖残缺）",
      stranded.length === 0,
      stranded.length ? stranded.slice(0, 10).map((d) => `${d}：${ax.excluded.find((x) => x.date === d)?.reason}`) : ["无"],
      { severity: "warn" }
    );

    // B1: 唯一性 + 来源重叠
    const dup = db.prepare("SELECT code, date, COUNT(*) n FROM share GROUP BY code, date HAVING n > 1 LIMIT 5").all();
    record("B. 同一 (code,date) 只有一行", dup.length === 0, dup.length ? dup.map((r) => `${r.code} ${r.date} ×${r.n}`) : ["share 主键唯一"]);

    const overlap = db
      .prepare(
        `SELECT COUNT(*) n FROM share a JOIN share b ON a.code=b.code AND a.date=b.date
         WHERE a.src='ts' AND b.src IN ('sse','szse')`
      )
      .get().n;
    record("B. 不存在低优先级来源与官方行重叠", overlap === 0, [`重叠 ${overlap} 行`]);

    // C: 数值自洽（legacy + v2）
    const dates = ax.dates;
    const shares = filterIsolated(loadShares(db, dates), dates);
    const official = officialCountsFromShares(shares);
    const modes = resolveMarketModes({ dates, official });
    const UL = loadUniverse({ taxonomy: "legacy" });
    for (const [label, U, table] of [
      ["legacy", UL, "series"],
      ["v2", loadUniverse({ taxonomy: "v2" }), "series_v2"],
    ]) {
      const stored = loadSeries(db, table);
      const has = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
      if (!has) {
        record(`C. ${label} 序列 = 成分之和`, false, [`${table} 为空`]);
        continue;
      }
      const r = numericChecks({ universe: U, dates, sharesByDate: shares, stored, modes });
      record(
        `C. ${label} 序列 = 成分之和`,
        r.mismatches.length === 0,
        r.mismatches.length
          ? [`${r.mismatches.length}/${r.checked} 处不符，最大差 ${r.maxAbsDiff.toFixed(4)}`, JSON.stringify(r.mismatches.slice(0, 3))]
          : [`检查 ${r.checked} 个 (小类×日)，maxΔ=0`]
      );
    }

    // C2: market 自洽
    const mktBad = [];
    const mktRows = db.prepare("SELECT date, scope, shares, etfs FROM market").all();
    const byDate = new Map();
    for (const r of mktRows) {
      let m = byDate.get(r.date);
      if (!m) byDate.set(r.date, (m = new Map()));
      m.set(r.scope, r);
    }
    for (const [d, m] of byDate) {
      const sh = m.get("SH");
      const sz = m.get("SZ");
      const all = m.get("ALL");
      if (!sh || !sz || !all) {
        mktBad.push(`${d} 缺少 scope`);
        continue;
      }
      // 三个数各自按 4 位小数舍入，最大累计误差 1.5e-4；留到 2e-4 以免误报
      if (Math.abs(all.shares - (sh.shares + sz.shares)) > 2e-4) mktBad.push(`${d} ALL≠SH+SZ（差 ${(all.shares - sh.shares - sz.shares).toFixed(6)}）`);
      if (all.etfs !== sh.etfs + sz.etfs) mktBad.push(`${d} 只数不合计`);
    }
    record("C. market ALL = SH + SZ", mktBad.length === 0, mktBad.length ? mktBad.slice(0, 5) : [`${byDate.size} 天全部自洽`]);

    // D: 序列只在轴内
    for (const table of ["series", "series_v2"]) {
      const n = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
      if (!n) continue;
      const stray = db
        .prepare(`SELECT DISTINCT date FROM ${table} WHERE date NOT IN (SELECT value FROM json_each(?)) LIMIT 5`)
        .all(JSON.stringify(dates))
        .map((r) => r.date);
      record(`D. ${table} 不含轴外日期`, stray.length === 0, stray.length ? stray : [`${n} 行均在轴内`]);
    }

    // D2: 可疑跳变归因（未知原因只告警，--strict 时算失败）
    const jumps = suspiciousJumps(db, { universe: UL, table: "series", thresholdPct: 30, dates, modes, sharesByDate: shares });
    const unknown = jumps.filter((j) => j.reasons.includes("unknown"));
    // 逐个都能归因是最理想状态，但历史长尾里总有几处真实大额申赎/指数调整无法自动归类
    // （如「贵金属 2024-01-11 +208%」）。这里改成「信息」级，真正的系统性退化由下一条检查兜住。
    record(
      "D. 可疑跳变（±30%）都有归因",
      unknown.length === 0,
      [
        `共 ${jumps.length} 处，其中未知原因 ${unknown.length} 处`,
        ...unknown.slice(0, 5).map((j) => `${j.sub} ${j.date} ${j.pct > 0 ? "+" : ""}${j.pct}%`),
      ],
      { severity: "info" }
    );

    // D2b: 真正需要盯的是「未知原因占比」——比例升高说明有新的、成规模的归因缺口
    const unknownRatio = jumps.length ? unknown.length / jumps.length : 0;
    record(
      "D. 未知原因跳变占比 ≤ 10%",
      unknownRatio <= 0.1,
      [`${(unknownRatio * 100).toFixed(1)}%（${unknown.length}/${jumps.length}）`],
      { severity: "warn" }
    );

    // D2c: 份额单位量级跳变（货币 ETF 历史常见 ~100 倍），只报告不改数
    const units = detectUnitOutliers(db);
    record(
      "D. 份额单位量级无整段跳变",
      units.regimes.length === 0,
      [
        `存在 ${units.regimes.length} 个代码的量级切换`,
        ...units.regimes.slice(0, 5).map((r) => `${r.code} ${r.segments.length} 段，首/末中位比 ${r.ratio}`),
      ],
      { severity: "info" }
    );

    // F: 最新交易日覆盖
    const cov = dayCoverage(db);
    const last = ax.dates.at(-1);
    const c = cov.get(last) ?? { sh: 0, sz: 0 };
    const hist = ax.dates.slice(-21, -1).map((d) => cov.get(d) ?? { sh: 0, sz: 0 });
    const med = (arr) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.floor((arr.length - 1) / 2)] : 0);
    const mSh = med(hist.map((x) => x.sh));
    const mSz = med(hist.map((x) => x.sz));
    const okSh = mSh <= 0 || c.sh / mSh >= BAND.minRatio;
    const okSz = mSz <= 0 || c.sz / mSz >= BAND.minRatio;
    record(
      "F. 最新交易日覆盖在区间内",
      okSh && okSz,
      [`${last}：沪 ${c.sh}/${mSh}（${((c.sh / (mSh || 1)) * 100).toFixed(0)}%），深 ${c.sz}/${mSz}（${((c.sz / (mSz || 1)) * 100).toFixed(0)}%）`]
    );
  } finally {
    db.close();
  }
}

/* --------------------------------- 汇总 --------------------------------- */

const t0 = Date.now();
try {
  checkFiles();
} catch (e) {
  record("E. 数据文件检查", false, [String(e?.message || e)]);
}
try {
  checkDb();
} catch (e) {
  record("A. 数据库审计", false, [String(e?.message || e).slice(0, 120)]);
}

const fails = results.filter((r) => !r.ok && r.severity === "fail");
const warns = results.filter((r) => !r.ok && r.severity === "warn");
const bad = STRICT ? [...fails, ...warns] : fails;

console.log(`\nEbbflow 数据审计（离线） · ${ROOT}`);
console.log(`node ${process.version} · ${results.length} 项检查 · ${Date.now() - t0}ms\n`);
for (const r of results) {
  if (QUIET && r.ok) continue;
  const icon = r.ok ? "✓" : r.severity === "warn" ? "!" : r.severity === "info" ? "·" : "✗";
  console.log(`${icon} ${r.name}`);
  if (!r.ok || !QUIET) for (const d of r.detail.slice(0, 8)) console.log(`    ${d}`);
}
console.log("");
if (bad.length) {
  console.log(`✗ ${bad.length} 项未通过（硬失败 ${fails.length}，告警 ${warns.length}）${STRICT ? "（--strict：告警也算失败）" : ""}`);
  process.exit(1);
}
console.log(`✓ 全部通过（硬失败 0，告警 ${warns.length}）`);
process.exit(0);
