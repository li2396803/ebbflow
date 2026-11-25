// P0/P1 不变量：覆盖度闸门、口径一致性、数值自洽、可疑跳变、空结果判据、幂等、锁
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, assert, assertEq, assertClose, assertIncludes, skipNow } from "../framework.mjs";
import { coverageBand, axisDiagnostics, dayCoverage, tradingDates, putShares, markDaySource } from "../../lib/db.mjs";
import {
  resolveMarketModes,
  assessDay,
  suspiciousJumps,
  numericChecks,
  loadShares,
  loadSeries,
  officialCountsFromShares,
  BAND,
} from "../../lib/invariants.mjs";
import { recomputeAll, exportSeriesJson } from "../../lib/pipeline.mjs";
import { acquireLock, releaseLock, lockInfo, pidAlive } from "../../lib/lock.mjs";
import { tmpDb, seedDay, seedFunds, seedShareRows, weekdays } from "../helpers.mjs";
import { spawnSync } from "node:child_process";

const recs = (rows) => rows.map(([date, sh, sz]) => ({ date, sh, sz }));

/* ------------------------------ P0-1 覆盖度闸门 ------------------------------ */

test("覆盖度闸门：相对近 20 日中位数判断，不用写死的 300/800", () => {
  const days = weekdays("2026-01-05", 6);
  const base = days.map((d) => [d, 1000, 800]);
  const band = coverageBand(
    recs([
      ...base,
      ["2026-01-13", 600, 800], // 60% → 通过（边界）
      ["2026-01-14", 590, 800], // 59% → 判残
      ["2026-01-15", 1000, 800], // 恢复
      ["2026-01-16", 2500, 800], // 2.5 倍 → 判异常（重复计入/混口径）
    ])
  );
  assertEq(band.get("2026-01-13").ok, true, "60% 应通过");
  assertEq(band.get("2026-01-14").ok, false, "59% 应判覆盖不足");
  assertIncludes(band.get("2026-01-14").reasons, "sh_low", "原因应为 sh_low");
  assertEq(band.get("2026-01-16").ok, false, "2.5 倍应判异常");
  assertIncludes(band.get("2026-01-16").reasons, "sh_high", "原因应为 sh_high");
});

test("覆盖度闸门：阈值随历史缩放（同一相对口径在几百只/上千只规模下都成立）", () => {
  const days = weekdays("2026-02-02", 6);
  const small = coverageBand(
    recs([...days.map((d) => [d, 200, 150]), ["2026-02-10", 130, 150], ["2026-02-11", 100, 150]])
  );
  assertEq(small.get("2026-02-10").ok, true, "小规模 65% 应通过（不因绝对数 <300 被误杀）");
  assertEq(small.get("2026-02-11").ok, false, "小规模 50% 应判残");

  const big = coverageBand(
    recs([...days.map((d) => [d, 1000, 800]), ["2026-02-10", 650, 800], ["2026-02-11", 500, 800]])
  );
  assertEq(big.get("2026-02-10").ok, true, "大规模 65% 应通过");
  assertEq(big.get("2026-02-11").ok, false, "大规模 50% 应判残");
});

test("时间轴：覆盖残缺日不进轴，且给出原因（不让假暴跌进曲线）", () => {
  const { db, cleanup } = tmpDb("axis-band");
  try {
    const days = weekdays("2026-02-02", 8);
    for (const d of days.slice(0, 6)) seedDay(db, d, { sh: 1000, sz: 800 });
    seedDay(db, days[6], { sh: 300, sz: 800 }); // 沪市只剩 30%（事故 1 的形状）
    seedDay(db, days[7], { sh: 600, sz: 800 }); // 60% → 可以进轴

    const ax = axisDiagnostics(db);
    assertEq(ax.dates.includes(days[6]), false, "缺 70% 沪市数据的日子不应进轴");
    assertEq(ax.dates.includes(days[7]), true, "60% 的日子应进轴");
    const ex = ax.excluded.find((x) => x.date === days[6]);
    assert(ex, "被排除的日子必须出现在 excluded 里");
    assertIncludes(ex.reason, "sh_low", "排除原因应指明是沪市覆盖不足");
    assert(ex.medSh >= 1000, "应记录参考中位数，便于人工核对");
    assertEq(tradingDates(db).includes(days[6]), false, "tradingDates 必须与诊断一致");
  } finally {
    cleanup();
  }
});

/* --------------------------- P0-2 口径一致性 --------------------------- */

test("口径一致：官方不完整时退回全部行（事故 2 同类路径不再归零/少算）", () => {
  const { db, cleanup } = tmpDb("mode");
  try {
    const dates = weekdays("2026-03-02", 6);
    const official = new Map();
    for (const d of dates) official.set(d, { sh: 900, sz: 0 });
    official.set(dates[5], { sh: 300, sz: 0 }); // 最后一天官方只抓到 1/3
    const modes = resolveMarketModes({ dates, official });
    assertEq(modes.get(dates[0]).sh, "official", "官方完整时用官方口径");
    assertEq(modes.get(dates[0]).sz, "all", "深市没有官方行 → 用全部行（Tushare）");
    assertEq(modes.get(dates[5]).sh, "all", "官方残缺时必须退回全部行");
    assertEq(modes.get(dates[5]).shIncomplete, true, "残缺要能被标记出来");
  } finally {
    cleanup();
  }
});

test("口径一致：subs 与 market 用同一份有效行（含官方缺失日）", () => {
  const { db, cleanup } = tmpDb("pipe-consistency");
  try {
    const dates = weekdays("2026-04-01", 2);
    const codes = Array.from({ length: 120 }, (_, i) => String(510000 + i));
    const subCodes = [codes[0], codes[1], "510900"];
    const universe = {
      CATS: [],
      SUB: { 测试小类: { cat: "1_宽基市场", color: "#000000", etfs: subCodes.map((code) => ({ code })) } },
    };
    seedFunds(db, [...codes, "510900"]);

    // 第 1 天：120 只沪市官方行 + 1 只只有 Tushare（官方快照没覆盖它）→ 官方口径应只认官方行
    seedShareRows(db, dates[0], [
      ...codes.map((c) => [c, 1000, "sse"]),
      ["510900", 5000, "ts"],
    ]);
    db.prepare("INSERT INTO dayinfo(date,has_sse,has_ts) VALUES(?,1,1) ON CONFLICT(date) DO UPDATE SET has_sse=1").run(dates[0]);
    // 第 2 天：官方一行都没有（接口坏了），只有 Tushare 全量 → 必须用 Tushare 兜底，不能算 0
    seedShareRows(db, dates[1], [
      [codes[0], 1000, "ts"],
      [codes[1], 1000, "ts"],
      ["510900", 5000, "ts"],
    ]);
    db.prepare("INSERT INTO dayinfo(date,has_sse,has_ts) VALUES(?,1,1) ON CONFLICT(date) DO UPDATE SET has_sse=1").run(dates[1]);

    db.exec("DELETE FROM series");
    db.exec("DELETE FROM market");
    db.exec("DELETE FROM market_type");
    recomputeAll(db, { dates, universe });
    const series = loadSeries(db, "series");
    const mkt = new Map(
      db.prepare("SELECT date, scope, shares, etfs FROM market").all().map((r) => [`${r.date}|${r.scope}`, r])
    );

    // 第 1 天：官方口径 → 510900 的 Tushare 行不计入；market 与 subs 必须一致
    assertClose(series.get(`测试小类|${dates[0]}`), (1000 + 1000) / 1e4, 1e-9, "官方口径下应只有两只（510900 被排除）");
    assertClose(mkt.get(`${dates[0]}|SH`).shares, (120 * 1000) / 1e4, 1e-9, "market SH 应同样只算官方行");
    assertEq(mkt.get(`${dates[0]}|SH`).etfs, 120, "market SH 只数应与 subs 用的行一致");

    // 第 2 天：官方缺失 → 用全部行（含 510900），不能归零
    assertClose(series.get(`测试小类|${dates[1]}`), (1000 + 1000 + 5000) / 1e4, 1e-9, "官方缺失日必须用 Tushare 兜底");
    assertEq(mkt.get(`${dates[1]}|SH`).etfs, 3, "market 也应使用同一份兜底行（3 只）");
    // ALL = SH + SZ 恒等
    const sh = mkt.get(`${dates[1]}|SH`).shares;
    const sz = mkt.get(`${dates[1]}|SZ`).shares;
    assertClose(mkt.get(`${dates[1]}|ALL`).shares, sh + sz, 1e-9, "ALL 必须等于 SH + SZ");
  } finally {
    cleanup();
  }
});

/* --------------------------- P0-4 数值自洽 --------------------------- */

test("数值自洽：小类 = Σ成分（债券 ×100），market ALL = SH + SZ，numericChecks 无残差", () => {
  const { db, cleanup } = tmpDb("numeric");
  try {
    const dates = weekdays("2026-05-04", 2);
    const codes = Array.from({ length: 120 }, (_, i) => String(510000 + i));
    const bondCodes = ["511380", "511180"];
    const universe = {
      CATS: [],
      SUB: {
        股票小类: { cat: "1_宽基市场", color: "#000000", etfs: [codes[0], codes[1]].map((code) => ({ code })) },
        债券小类: { cat: "9_债券", color: "#000000", etfs: bondCodes.map((code) => ({ code })) },
      },
    };
    seedFunds(db, [...codes, ...bondCodes]);
    for (const d of dates) {
      seedShareRows(db, d, [
        ...codes.map((c) => [c, 1000, "sse"]),
        [bondCodes[0], 30000, "sse"],
        [bondCodes[1], 20000, "sse"],
      ]);
      db.prepare("INSERT INTO dayinfo(date,has_sse) VALUES(?,1) ON CONFLICT(date) DO UPDATE SET has_sse=1").run(d);
    }
    db.exec("DELETE FROM series");
    db.exec("DELETE FROM market");
    db.exec("DELETE FROM market_type");
    recomputeAll(db, { dates, universe });

    const series = loadSeries(db, "series");
    assertClose(series.get(`股票小类|${dates[0]}`), 0.2, 1e-9, "2 只 ×1000 万份 = 0.2 亿份");
    assertClose(series.get(`债券小类|${dates[0]}`), 500, 1e-9, "债券小类 5 亿份 ×100");

    const shares = loadShares(db, dates);
    const modes = resolveMarketModes({ dates, official: officialCountsFromShares(shares) });
    const check = numericChecks({ universe, dates, sharesByDate: shares, stored: series, modes });
    assertEq(check.checked, 4, "2 小类 × 2 天 都应被检查");
    assertEq(check.mismatches.length, 0, `不应有残差：${JSON.stringify(check.mismatches.slice(0, 2))}`);

    const rows = db.prepare("SELECT date, scope, shares, etfs FROM market").all();
    for (const d of dates) {
      const pick = (s) => rows.find((r) => r.date === d && r.scope === s);
      assertClose(pick("ALL").shares, pick("SH").shares + pick("SZ").shares, 1e-9, "ALL = SH + SZ");
      assertEq(pick("ALL").etfs, pick("SH").etfs + pick("SZ").etfs, "只数也要自洽");
      assertClose(pick("SH").shares, (120 * 1000 + 50000) / 1e4, 1e-9, "market SH 含债券 ETF 的自然口径（不 ×100）");
    }
  } finally {
    cleanup();
  }
});

/* --------------------------- P0-3 可疑跳变归因 --------------------------- */

test("可疑跳变：能区分 份额折算 / 覆盖率变化 / 未知原因", () => {
  const mk = (tag) => tmpDb(`jump-${tag}`);
  const universe = {
    CATS: [],
    SUB: { 小类: { cat: "1_宽基市场", color: "#000000", etfs: ["510001", "510002", "510003"].map((code) => ({ code })) } },
  };
  const build = (db, days, rowsForDay) => {
    seedFunds(db, ["510001", "510002", "510003"]);
    for (const d of days) {
      seedShareRows(db, d, rowsForDay(d));
      db.prepare("INSERT INTO dayinfo(date,has_sse) VALUES(?,1) ON CONFLICT(date) DO UPDATE SET has_sse=1").run(d);
    }
    db.exec("DELETE FROM series");
    db.exec("DELETE FROM market");
    db.exec("DELETE FROM market_type");
    recomputeAll(db, { dates: days, universe });
  };

  // ① 折算：某只成分触发 2:1 拆分事件
  {
    const { db, cleanup } = mk("split");
    try {
      const days = weekdays("2026-06-01", 4);
      build(db, days, (d) => [
        ["510001", d === days[2] || d === days[3] ? 2000 : 1000, "sse"],
        ["510002", 1000, "sse"],
        ["510003", 1000, "sse"],
      ]);
      db.prepare("INSERT INTO event(code,date,kind,ratio) VALUES('510001',?,'split',2)").run(days[2]);
      const jumps = suspiciousJumps(db, { universe, table: "series", thresholdPct: 30 });
      assert(jumps.length >= 1, "应识别出跳变");
      assertIncludes(jumps[0].reasons, "split", "应归因为份额折算");
    } finally {
      cleanup();
    }
  }

  // ② 覆盖率：当天只剩 1 只成分有数据 → 归因为 coverage
  {
    const { db, cleanup } = mk("coverage");
    try {
      const days = weekdays("2026-06-01", 3);
      build(db, days, (d) => (d === days[1] ? [["510001", 1000, "sse"]] : [["510001", 1000, "sse"], ["510002", 1000, "sse"], ["510003", 1000, "sse"]]));
      const jumps = suspiciousJumps(db, { universe, table: "series", thresholdPct: 30 });
      assert(jumps.length >= 1, "应识别出跳变");
      assertIncludes(jumps[0].reasons, "coverage", "应归因为覆盖度变化");
    } finally {
      cleanup();
    }
  }

  // ③ 无任何证据 → unknown（warn 级，提醒人工核对）
  {
    const { db, cleanup } = mk("unknown");
    try {
      const days = weekdays("2026-06-01", 3);
      build(db, days, (d) => [
        ["510001", d === days[2] ? 4000 : 1000, "sse"],
        ["510002", 1000, "sse"],
        ["510003", 1000, "sse"],
      ]);
      const jumps = suspiciousJumps(db, { universe, table: "series", thresholdPct: 30 });
      assert(jumps.length >= 1, "应识别出跳变");
      assertIncludes(jumps[0].reasons, "unknown", "无证据时应标 unknown");
      assertEq(jumps[0].severity, "warn", "unknown 应为 warn 级");
    } finally {
      cleanup();
    }
  }
});

/* -------------------------- P1-6/7 空结果与未出齐 -------------------------- */

test("空结果判据：200+空 与 本当没有数据 可区分", () => {
  assertEq(assessDay({ rows: 0, expected: 1700 }), "empty_suspect", "对照源有数据而本源 0 行 → 接口可疑");
  assertEq(assessDay({ rows: 0, expected: null }), "empty_expected", "无对照时 0 行按节日/无数据处");
  assertEq(assessDay({ rows: 1775, expected: 1700 }), "ok", "出齐");
  assertEq(assessDay({ rows: 99, expected: 1700 }), "partial", "只有 99 行 → 未出齐");
  assertEq(assessDay({ rows: 1, expected: 1700 }), "partial", "只有 1 行 → 未出齐");
});

test("Tushare 未出齐识别：1/32/99 行不当作完整日，1775 行才算", () => {
  const { db, cleanup } = tmpDb("ts-partial");
  try {
    // 历史：近 20 个交易日每天 1700 只（官方 940 / 深市 760）
    const days = weekdays("2026-07-01", 20);
    for (const d of days) {
      seedShareRows(db, d, [
        ...Array.from({ length: 940 }, (_, i) => [String(510000 + i), 100, "sse"]),
        ...Array.from({ length: 760 }, (_, i) => [String(159000 + i), 100, "ts"]),
      ]);
      markDaySource(db, d, "sse");
    }
    const cov = dayCoverage(db);
    const med = days.map((d) => cov.get(d).sh + cov.get(d).sz).sort((a, b) => a - b)[10];
    assertEq(med, 1700, "中位数应为 1700");
    for (const n of [1, 32, 99]) {
      assertEq(assessDay({ rows: n, expected: med }), "partial", `${n} 行应判未出齐`);
    }
    assertEq(assessDay({ rows: 1775, expected: med }), "ok", "1775 行应判完整");
  } finally {
    cleanup();
  }
});

/* ------------------------------ P1-8 幂等 ------------------------------ */

test("幂等：同一份数据重算两次，series/market 与导出的 JSON 完全一致", () => {
  const { db, file, cleanup } = tmpDb("idem");
  const json = path.join(path.dirname(file), `${path.basename(file, ".db")}-series.json`);
  try {
    const dates = weekdays("2026-08-03", 3);
    const codes = Array.from({ length: 120 }, (_, i) => String(510000 + i));
    const universe = { CATS: [], SUB: { 小类: { cat: "1_宽基市场", color: "#000000", etfs: codes.slice(0, 2).map((code) => ({ code })) } } };
    seedFunds(db, codes);
    for (const d of dates) {
      seedShareRows(db, d, [
        ...codes.map((c, i) => [c, 1000 + i, "sse"]),
      ]);
      markDaySource(db, d, "sse");
    }
    const snap = () =>
      JSON.stringify({
        series: db.prepare("SELECT sub,date,val,scale,flow FROM series ORDER BY sub,date").all(),
        market: db.prepare("SELECT date,scope,shares,scale,etfs FROM market ORDER BY date,scope").all(),
        type: db.prepare("SELECT date,type,shares,scale,etfs FROM market_type ORDER BY date,type").all(),
      });
    recomputeAll(db, { dates, universe });
    const a = snap();
    recomputeAll(db, { dates, universe });
    const b = snap();
    assertEq(a, b, "两次重算的数据库内容应完全一致");

    assertEq(exportSeriesJson(db, json), true, "第一次导出应成功");
    const first = fs.readFileSync(json, "utf8");
    assertEq(exportSeriesJson(db, json), true, "第二次导出应成功");
    assertEq(fs.readFileSync(json, "utf8"), first, "两次导出的文件应字节级一致（不含时间戳）");
  } finally {
    cleanup();
    try {
      fs.rmSync(json, { force: true });
    } catch {}
  }
});

/* ------------------------------ P1-9 锁 ------------------------------ */

test("锁：活进程持有 → 拒绝；死进程/旧格式残留 → 自动清理", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ebbflow-lock-"));
  const lockDir = path.join(root, "data", ".update.lock");
  try {
    const a = acquireLock(root);
    assertEq(a.ok, true, "第一次抢锁应成功");
    const b = acquireLock(root);
    assertEq(b.ok, false, "同进程重复抢锁应被拒绝（pid 仍活着）");
    assertEq(lockInfo(root).alive, true, "锁内 pid 应被判定为活着的进程");
    releaseLock(root);
    assertEq(lockInfo(root).held, false, "释放后不应持有");

    // 死进程留下的锁
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "pid"), "999999");
    assertEq(pidAlive(999999), false, "999999 不应是活进程");
    const c = acquireLock(root);
    assertEq(c.ok, true, "死进程的锁应被自动清理");
    assert(c.cleaned && c.cleaned.includes("已不存在"), "应说明清理原因");
    releaseLock(root);

    // 旧格式（无 pid 文件）且已过期的锁
    fs.mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockDir, old, old);
    const d = acquireLock(root);
    assertEq(d.ok, true, "过期旧格式锁应被清理");
    releaseLock(root);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

/* ------------------------- 轴与序列对齐（数据卫生） ------------------------- */

test("轴与序列对齐：派生序列不包含非交易日 / 被闸门排除的日子", () => {
  const { db, cleanup } = tmpDb("axis-series");
  try {
    const days = weekdays("2026-09-01", 7);
    const codes = Array.from({ length: 120 }, (_, i) => String(510000 + i));
    const universe = { CATS: [], SUB: { 小类: { cat: "1_宽基市场", color: "#000000", etfs: codes.slice(0, 2).map((code) => ({ code })) } } };
    seedFunds(db, codes);
    for (const d of days.slice(0, 6)) {
      seedShareRows(db, d, codes.map((c) => [c, 1000, "sse"]));
      markDaySource(db, d, "sse");
    }
    // 残缺日：只有 10 只，且被标记为有官方数据（应被闸门挡在轴外）
    seedShareRows(db, days[6], codes.slice(0, 10).map((c) => [c, 1000, "sse"]));
    markDaySource(db, days[6], "sse");

    const axis = tradingDates(db);
    assertEq(axis.includes(days[6]), false, "残缺日不应进轴");

    db.exec("DELETE FROM series");
    db.exec("DELETE FROM market");
    db.exec("DELETE FROM market_type");
    recomputeAll(db, { dates: axis, universe });

    const bad = db.prepare("SELECT DISTINCT date FROM series").all().map((r) => r.date).filter((d) => !axis.includes(d));
    assertEq(bad.length, 0, `序列里不应有轴外日期：${bad.slice(0, 3).join(",")}`);
  } finally {
    cleanup();
  }
});

/* --------------------- P1-10 生成物冲突：检测与重建 --------------------- */

test("生成物冲突：能检出 <<<<<<< 标记，且不会把坏文件静默当成好数据", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ebbflow-repair-"));
  const rel = path.join(root, "data", "series.json");
  const script = path.join(process.cwd(), "scripts", "repair-generated.mjs");
  const run = (...args) => spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
  try {
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.writeFileSync(rel, '{\n<<<<<<< HEAD\n"dates": [],\n=======\n"dates": ["2026-01-05"],\n>>>>>>> origin/master\n}\n');

    const check = run();
    assertEq(check.status, 1, "含冲突标记时 --check 应退出 1");
    assertIncludes(check.stdout, "series.json", "应指出具体文件");

    // --fix 在既没有可用数据库、git 也拿不到完整版本时，必须明确失败，而不是写出半截 JSON
    const fix = run("--fix");
    assertEq(fix.status, 1, "--fix 无法重建时应退出 1");
    assertIncludes(fix.stdout, "需要人工处理", "应提示需要人工处理");
    assert(fs.readFileSync(rel, "utf8").includes("<<<<<<<"), "无法重建时不应改写原文件");

    // 干净的 JSON 应通过
    fs.writeFileSync(rel, JSON.stringify({ dates: ["2026-01-05"], subs: { a: [1] } }));
    const ok = run();
    assertEq(ok.status, 0, "干净文件应退出 0");
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});
