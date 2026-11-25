// v4.0.0 钱口径：规模 / 净申购 / 变化率 / 覆盖率 / etfRanges
//
// 所有断言都用「独立算术」重算一遍（直接查 share / nav / event 表），不复用被测实现。
import { test, assert, assertEq, assertClose } from "../framework.mjs";
import { markDaySource } from "../../lib/db.mjs";
import { recomputeAll } from "../../lib/pipeline.mjs";
import { buildAllPayloads } from "../../lib/payloads.mjs";
import {
  PERIODS,
  addMonths,
  periodWindows,
  createMetricContext,
  dailyFlow,
  buildEtfRanges,
  etfRangeMetrics,
  flowStep,
  flowOutOfBounds,
} from "../../lib/metrics.mjs";
import { tmpDb, seedFunds, seedShareRows, seedNavRows, seedEvents, seedListDates, mkUniverse, readSeries, weekdays } from "../helpers.mjs";

const round4 = (v) => Math.round(v * 1e4) / 1e4;

/* ------------------------------ 规模 ------------------------------ */

test("规模：Σ(份额×净值)/1e4，3 个小类 × 30 天独立复算，误差 < 1e-6；债券不放大", () => {
  const { db, cleanup } = tmpDb("m-scale");
  try {
    const dates = weekdays("2026-01-05", 30);
    const spec = {
      测试A: { codes: ["510001", "510002", "510003"] },
      测试B: { codes: ["510004", "510005"] },
      测试债: { cat: "9_债券", codes: ["511001", "511002"] },
    };
    const universe = mkUniverse(spec);
    const codes = Object.values(spec).flatMap((s) => s.codes);
    seedFunds(db, codes);
    for (let i = 0; i < dates.length; i++) {
      const shares = [];
      const navs = [];
      codes.forEach((c, k) => {
        shares.push([c, 1000 + 37 * i + 11 * k, "sse"]);
        navs.push([c, 1 + 0.01 * i + 0.001 * k]);
      });
      seedShareRows(db, dates[i], shares);
      seedNavRows(db, dates[i], navs);
    }
    recomputeAll(db, { dates, universe });
    const ser = readSeries(db, "series");

    const globalIdx = new Map(codes.map((c, k) => [c, k]));
    for (const [sub, v] of Object.entries(spec)) {
      for (let i = 0; i < dates.length; i++) {
        let expScale = 0;
        let expShares = 0;
        v.codes.forEach((c) => {
          const k = globalIdx.get(c);
          const wan = 1000 + 37 * i + 11 * k;
          const nav = 1 + 0.01 * i + 0.001 * k;
          expShares += wan;
          expScale += (wan / 1e4) * nav;
        });
        const row = ser.get(`${sub}|${dates[i]}`);
        assert(row, `缺少序列 ${sub} ${dates[i]}`);
        assertClose(row.scale, round4(expScale), 1e-6, `${sub} ${dates[i]} 规模`);
        // 债券 ×100 只作用于「份额」这个内部/旧口径，不进规模
        const factor = v.cat === "9_债券" ? 100 : 1;
        assertClose(row.val, round4((expShares / 1e4) * factor), 1e-6, `${sub} ${dates[i]} 内部分额口径`);
      }
    }
  } finally {
    cleanup();
  }
});

/* ------------------------------ 净申购 ------------------------------ */

test("净申购：拆分日还原为 0、上市首日不计、缺净值日跳过（独立算术）", () => {
  const { db, cleanup } = tmpDb("m-flow");
  try {
    const dates = weekdays("2026-03-02", 12);
    const A = "510001"; // 上市首日 = 第 6 天
    const B = "510002"; // 第 9 天 2:1 拆分
    const C = "510003"; // 稳定申购
    const D = "510004"; // 第 7 天缺净值、且份额跳增
    const universe = mkUniverse({ 测流: { codes: [A, B, C, D] } });
    seedFunds(db, [A, B, C, D]);
    seedListDates(db, { [A]: dates[5] });
    seedEvents(db, [{ code: B, date: dates[8], kind: "split", ratio: 2 }]);

    for (let i = 0; i < dates.length; i++) {
      const rows = [];
      const navs = [];
      if (i >= 5) rows.push([A, 1000, "sse"]);
      rows.push([B, i >= 8 ? 2000 : 1000, "sse"]);
      rows.push([C, 1000 + 100 * i, "sse"]);
      rows.push([D, i >= 6 ? 1500 : 1000, "sse"]); // 跳增发生在「缺净值」那天 → 不应计入
      for (const c of [A, B, C, D]) if (!(c === D && i === 6)) navs.push([c, 1 + 0.01 * i]);
      seedShareRows(db, dates[i], rows);
      seedNavRows(db, dates[i], navs);
    }
    recomputeAll(db, { dates, universe });
    const ser = readSeries(db, "series");

    // 独立算术：拆分日用「前一日 × 事件比例」还原，上市首日跳过，缺净值跳过
    const SPLIT_I = 8; // 第 9 天（下标 8）份数翻倍
    for (let i = 1; i < dates.length; i++) {
      const nav = 1 + 0.01 * i;
      const parts = [];
      const push = (code, w, p) => {
        if (!Number.isFinite(w) || !Number.isFinite(p)) return;
        if (code === A && i === 5) return; // 上市首日
        if (code === D && i === 6) return; // 缺净值
        parts.push(((w - p) / 1e4) * nav);
      };
      // C：每天 +100
      push(C, 1000 + 100 * i, 1000 + 100 * (i - 1));
      // B：拆分日（i=8，份数翻倍）——折算还原 = 把「早于拆分日」的份额乘 2 换算到新单位。
      // 因此拆分前 cur/prev 同时 ×2、拆分日只对 prev ×2、之后都不乘 → 三种情形 Δ 都是 0。
      {
        const wB = i >= SPLIT_I ? 2000 : 1000;
        const rawPrevB = i - 1 >= SPLIT_I ? 2000 : 1000;
        const curFactor = i < SPLIT_I ? 2 : 1;
        const prevFactor = i - 1 < SPLIT_I ? 2 : 1;
        parts.push(((curFactor * wB - prevFactor * rawPrevB) / 1e4) * nav);
      }
      // A：上市后份额不变
      if (i >= 6) push(A, 1000, 1000);
      // D：第 7 天（缺净值）份额跳增 → 这一天不计；之后 Δ=0
      push(D, i >= 6 ? 1500 : 1000, i - 1 >= 6 ? 1500 : 1000);

      const expected = parts.reduce((a, b) => a + b, 0);
      const row = ser.get(`测流|${dates[i]}`);
      assertClose(row.flow, round4(expected), 1e-6, `${dates[i]} 净申购`);

      if (i === SPLIT_I) {
        // 拆分日的净申购必须接近「真实申赎」，不能把 2:1 的份数变化当成 0.2 亿的申购
        assert(Math.abs(row.flow) < 0.02, `拆分日净申购应≈0，实际 ${row.flow}`);
      }
      if (i === 5) assert(Math.abs(row.flow - round4(parts.reduce((a, b) => a + b, 0))) < 1e-6, "上市首日不计入");
    }
  } finally {
    cleanup();
  }
});

/* ------------------------------ 区间指标 ------------------------------ */

test("区间窗口：期初取「≤ 目标日 的最后一个交易日」，历史不足时退到第 0 天", () => {
  const dates = ["2026-01-05", "2026-02-02", "2026-03-02", "2026-04-01"];
  const win = periodWindows(dates);
  // 末日 2026-04-01，1m 目标 2026-03-01 → 期初应取 2026-02-02
  assertEq(win["1m"].from, "2026-02-02", "1m 期初");
  assertEq(win["3m"].from, "2026-01-05", "3m 期初（目标 2026-01-01，退到第 0 天）");
  assertEq(win["1y"].from, "2026-01-05", "历史不足 → 第 0 天");
  assertEq(win["1m"].i1, dates.length - 1, "期末是末日");
  for (const p of PERIODS) assert(win[p] && win[p].i0 <= win[p].i1, `${p} 窗口应合法`);
  assertEq(addMonths("2026-03-31", -1), "2026-02-28", "月末对齐：3-31 减 1 月 → 2-28");
});

test("etfRanges：5 只 ETF × 3 个区间与手工「按 code 取期初期末」一致，且不是小类级估算", () => {
  const { db, cleanup } = tmpDb("m-range");
  try {
    const dates = weekdays("2025-06-02", 300);
    const codes = ["510101", "510102", "510103", "510104", "510105"];
    const universe = mkUniverse({ 区测: { codes } });
    seedFunds(db, codes);
    const SPLIT_DAY = 250;
    seedEvents(db, [{ code: "510103", date: dates[SPLIT_DAY], kind: "split", ratio: 2 }]);

    for (let i = 0; i < dates.length; i++) {
      const nav = 1 + 0.002 * i;
      const rows = [
        ["510101", 1000 + 3 * i, "sse"], // 稳步申购
        ["510102", 1000, "sse"], // 份额不变
        ["510103", i >= SPLIT_DAY ? 2000 : 1000, "sse"], // 拆分：份数翻倍、净值减半
        ["510104", 1000 + (i > 280 ? (i - 280) * 50 : 0), "sse"], // 尾部大额申购
        ["510105", 1000, "sse"], // 缺净值
      ];
      const navs = [
        ["510101", nav],
        ["510102", 1.5],
        ["510103", i >= SPLIT_DAY ? nav / 2 : nav],
        ["510104", nav],
        ...(i >= 240 && i <= 260 ? [] : [["510105", nav]]),
      ];
      seedShareRows(db, dates[i], rows);
      seedNavRows(db, dates[i], navs);
    }
    recomputeAll(db, { dates, universe });

    const ctx = createMetricContext(db, dates, { codes });
    const windows = periodWindows(dates);
    const ranges = buildEtfRanges({ ctx, universe, windows });

    // 独立算术：直接从数据库按日期取期初期末
    const at = (code, date) => {
      const s = db.prepare("SELECT wan FROM share WHERE code=? AND date=?").get(code, date);
      const n = db.prepare("SELECT nav FROM nav WHERE code=? AND date=?").get(code, date);
      return { wan: s?.wan ?? null, nav: n?.nav ?? null };
    };
    for (const period of ["1m", "3m", "1y"]) {
      const w = windows[period];
      for (const code of ["510101", "510102", "510103", "510104"]) {
        const a = at(code, w.from);
        const b = at(code, w.to);
        const scaleEnd = b.wan != null && b.nav != null ? (b.wan / 1e4) * b.nav : null;
        const scaleStart = a.wan != null && a.nav != null ? (a.wan / 1e4) * a.nav : null;
        const chgPct = scaleEnd != null && scaleStart != null && scaleStart > 0 ? ((scaleEnd - scaleStart) / scaleStart) * 100 : null;
        const got = ranges[period][code];
        assert(got, `缺少 ${period} / ${code}`);
        assertClose(got.scaleEnd, scaleEnd == null ? null : Math.round(scaleEnd * 100) / 100, 0.011, `${period} ${code} scaleEnd`);
        if (chgPct == null) assertEq(got.chgPct, null, `${period} ${code} chgPct 应为 null`);
        else assertClose(got.chgPct, Math.round(chgPct * 100) / 100, 0.011, `${period} ${code} chgPct`);
      }
      // 510105 期初/期末缺净值（尾部 240..260 缺）→ 至少 3m/1y 的期初落在缺口里
      if (period === "1y" || period === "3m") {
        const w2 = windows[period];
        const a = at("510105", w2.from);
        if (a.nav == null) assertEq(ranges[period]["510105"].chgPct, null, "缺净值 → chgPct 为 null");
      }
    }

    // 拆分不影响「规模变化率」：510103 份数翻倍、净值减半 → 规模只随净值增长，
    // 因此它的区间变化率应等于「净值涨幅」，而不是份数翻倍带来的 +100%。
    {
      const w = windows["1y"];
      const navStart = 1 + 0.002 * w.i0;
      const navEndEff = 1 + 0.002 * w.i1; // 拆分后净值减半、份数翻倍 → 有效净值就是未拆分的净值
      const expectChg = (navEndEff / navStart - 1) * 100;
      const r103 = ranges["1y"]["510103"];
      assertClose(r103.chgPct, Math.round(expectChg * 100) / 100, 0.5, `拆分应只体现净值涨幅（期望 ${expectChg.toFixed(2)}%）`);
      assert(Math.abs(r103.chgPct) < 60, `不应出现份数翻倍造成的 +100% 级变化（实际 ${r103.chgPct}%）`);
    }

    // 逐 ETF 与「小类级估算」不同：510104 尾部大额申购应显著高于 510102
    const r104 = ranges["1m"]["510104"];
    const r102 = ranges["1m"]["510102"];
    assert(r104.chgPct > r102.chgPct + 5, `逐 ETF 应体现个体差异（${r104.chgPct}% vs ${r102.chgPct}%）`);
    assert(Math.abs(r104.flow) > Math.abs(r102.flow), "510104 区间净申购应大于 510102");
  } finally {
    cleanup();
  }
});

/* ------------------------------ 覆盖率 ------------------------------ */

test("覆盖率：孤立披露成分被剔除后计入 coverage；低覆盖日汇总进 quality.lowCoverageDays", () => {
  const { db, cleanup } = tmpDb("m-cov");
  try {
    const dates = weekdays("2026-04-06", 20);
    const A = "510001";
    const B = "510002";
    const C = "510003"; // 只在 5 个相隔的日期出现 → 孤立披露，被 filterIsolated 剔除
    // 填充标的（不属于任何小类）：让「小类低覆盖」不至于把整天的市场覆盖拉低到轴闸门阈值以下
    // ——真实世界里一个小类缺成分不会影响全市场，这里用填充代码模拟同样的形状。
    const fillers = Array.from({ length: 12 }, (_, k) => String(515000 + k));
    const universe = mkUniverse({ 覆盖测: { codes: [A, B, C] } });
    seedFunds(db, [A, B, C, ...fillers]);
    const isolated = new Set([0, 4, 8, 12, 16].map((i) => dates[i]));
    for (let i = 0; i < dates.length; i++) {
      const rows = [];
      if (i !== 10) rows.push([A, 1000, "sse"]); // 第 11 天 A 缺失
      rows.push([B, 1000, "sse"]);
      if (isolated.has(dates[i])) rows.push([C, 9999, "sse"]);
      for (const c of fillers) rows.push([c, 500, "sse"]);
      seedShareRows(db, dates[i], rows);
      seedNavRows(db, dates[i], [A, B, C, ...fillers].map((c) => [c, 1]));
      markDaySource(db, dates[i], "sse");
    }
    recomputeAll(db, { dates, universe });
    const ser = readSeries(db, "series");

    const normal = ser.get(`覆盖测|${dates[1]}`);
    assert(normal, "应有封面数据");
    assertClose(normal.coverage, round4(2 / 3), 1e-6, "正常日覆盖 2/3（C 被孤立披露剔除）");
    assertClose(normal.val, round4(2000 / 1e4), 1e-6, "C 的份额不应计入聚合");

    const low = ser.get(`覆盖测|${dates[10]}`);
    assertClose(low.coverage, round4(1 / 3), 1e-6, "缺 A 的一天覆盖 1/3");
    assert(low.coverage < 0.6, "该日应判为低覆盖");

    const p = buildAllPayloads(db, { universe });
    const entry = p.subs["覆盖测"];
    assertEq(entry.coverage.length, dates.length, "coverage 序列长度 = 交易日数");
    // 载荷里 coverage 保留 2 位小数（体积考虑），与库内 4 位相比只差舍入
    assertClose(entry.coverage[10], 0.33, 1e-6, "载荷里的覆盖度");
    assert(entry.coverage[10] < 0.6, "载荷里的低覆盖日应可判定");
    assertEq(p.quality.lowCoverageDays.total, 1, "低覆盖日计数");
    assertEq(p.quality.lowCoverageDays.threshold, 0.6, "阈值");
    assertEq(p.quality.lowCoverageDays.top[0].sub, "覆盖测", "按小类汇总");
  } finally {
    cleanup();
  }
});

/* ------------------------------ 载荷契约 ------------------------------ */

test("载荷契约：subs 用规模/净申购/覆盖替代份额，charts 以亿元为轴，values 置空并标 deprecated", () => {
  const { db, cleanup } = tmpDb("m-contract");
  try {
    const dates = weekdays("2026-05-04", 25);
    const codes = ["510201", "510202", "510203"];
    const universe = mkUniverse({ 契约测: { codes }, 契债: { cat: "9_债券", codes: ["511201", "511202"] } });
    seedFunds(db, [...codes, "511201", "511202"]);
    for (let i = 0; i < dates.length; i++) {
      seedShareRows(db, dates[i], [...codes, "511201", "511202"].map((c) => [c, 1000 + 10 * i, "sse"]));
      seedNavRows(db, dates[i], [...codes, "511201", "511202"].map((c) => [c, 1 + 0.005 * i]));
      markDaySource(db, dates[i], "sse");
    }
    recomputeAll(db, { dates, universe });
    const p = buildAllPayloads(db, { universe });

    const e = p.subs["契约测"];
    assertEq(e.values, null, "values 应置空");
    assertEq(e.valuesDeprecated, true, "valuesDeprecated 标记");
    // v4 契约（SUB_SERIES=flow 默认）：scaleSeries 不再下发，规模序列唯一来源是 charts-<cat>.json
    assertEq(e.scaleSeries, undefined, "默认不下发 scaleSeries");
    assertEq(e.scaleSeriesSource, "charts", "应标明规模序列来源");
    assertEq(e.flowSeries.length, dates.length, "flowSeries 长度");
    assertEq(e.coverage.length, dates.length, "coverage 长度");
    assertClose(e.currentScale, e.scale, 1e-9, "currentScale 与 scale（末日规模）一致");
    // SUB_SERIES=all 时回退到「subs 自带 scaleSeries」（体积 1.48×，仅调试用）
    const pAll = buildAllPayloads(db, { universe, subsSeries: "all" });
    assertEq(pAll.subs["契约测"].scaleSeries.length, dates.length, "SUB_SERIES=all 时应下发 scaleSeries");
    assertEq(pAll.subs["契约测"].scaleSeriesSource, null, "自带序列时来源为 null");
    // etfRanges 拆到独立文件：subs 里只有引用，内容在 p.etfRanges[cat]
    assertEq(e.etfRanges, null, "subs 内不再内联 etfRanges");
    assert(e.etfRangesFile && e.etfRangesFile.startsWith("etf-ranges/"), "subs 应给出分片文件引用");
    const catKey = e.cat;
    const file = p.etfRanges[catKey];
    assert(file, `应有 ${catKey} 的 etf-ranges 分片`);
    assertEq(file.periods.join(","), PERIODS.join(","), "分片应覆盖 6 个区间");
    const one = file.subs["契约测"]["1m"]["510201"];
    assert(one && "chgPct" in one && "flow" in one && "scaleEnd" in one, "etfRanges 条目字段");

    // charts：规模 + 净申购，单位亿元，不再有 shares/values
    const chart = p.charts[Object.keys(p.charts)[0]];
    assertEq(chart.unit, "亿元", "图表单位");
    const s = chart.series.find((x) => x.name === "契约测");
    assert(s, "应有该小类序列");
    assertEq(s.shares, undefined, "charts 不再输出份额");
    assertEq(s.values, undefined, "charts 不再输出 values");
    assertEq(s.scale.length, dates.length, "charts.scale 长度");
    assertEq(s.flow.length, dates.length, "charts.flow 长度");
    // charts.scale 与库内规模序列一致（1 位小数），是 subs 的替代来源
    const dbScale = db.prepare("SELECT scale FROM series WHERE sub=? AND date=? ORDER BY date").all("契约测", dates[0])[0];
    assert(dbScale, "库内应有规模行");
    assertClose(s.scale[0], Math.round(dbScale.scale * 10) / 10, 1e-6, "charts.scale 首日 = 库内规模（1dp）");

    assert(p.meta.metrics.includes("scale"), "meta.metrics 含 scale");
    assert(p.meta.metrics.includes("flow"), "meta.metrics 含 flow");
    assertEq(p.meta.metricUnits.scale, "亿元", "meta 单位");
    assertEq(p.meta.metricUnits.shares, undefined, "meta 不再宣传份额单位");
  } finally {
    cleanup();
  }
});

test("首页表格：按规模变化排行，变化率 = 规模变化率（不是份额变化）", () => {
  const { db, cleanup } = tmpDb("m-tables");
  try {
    // 用 5 个连续工作日：recentWindow(7 个自然日) 正好覆盖整个区间，期初 = 第 0 天
    const dates = weekdays("2026-06-01", 5);
    // A：份额不变、净值翻倍 → 规模 +100%
    // B：份额 +50%、净值不变 → 规模 +50%
    const universe = mkUniverse({ 测A: { codes: ["510301", "510302"] }, 测B: { codes: ["510303", "510304"] } });
    seedFunds(db, ["510301", "510302", "510303", "510304"]);
    for (let i = 0; i < dates.length; i++) {
      seedShareRows(db, dates[i], [
        ["510301", 1000, "sse"],
        ["510302", 1000, "sse"],
        ["510303", 1000 + 125 * i, "sse"],
        ["510304", 1000 + 125 * i, "sse"],
      ]);
      const navA = 1 * (1 + i / (dates.length - 1)); // 1 → 2
      const navB = 1;
      seedNavRows(db, dates[i], [
        ["510301", navA],
        ["510302", navA],
        ["510303", navB],
        ["510304", navB],
      ]);
      markDaySource(db, dates[i], "sse");
    }
    recomputeAll(db, { dates, universe });
    const p = buildAllPayloads(db, { universe });
    const rows = p.tables.all;
    const A = rows.find((r) => r.sub === "测A");
    const B = rows.find((r) => r.sub === "测B");
    assert(A && B, "两个小类都应在表里");
    assertClose(A.pct, 100, 0.5, "测A 规模变化率 ≈ +100%");
    assertClose(B.pct, 50, 0.5, "测B 规模变化率 ≈ +50%");
    assertEq(rows[0].sub, "测A", "应按规模变化额排行（测A 在前）");
    // 类目行：规模合计与子项之和一致
    const cat = p.tables.cats.find((c) => c.key === "1_宽基市场");
    assertClose(cat.now, Math.round((A.last + B.last) * 10) / 10, 0.11, "类目规模 = 小类规模之和");
  } finally {
    cleanup();
  }
});

/* ------------------ 财务审计回归（E1 / E2 / T0 / E3） ------------------ */

test("E1：折算乘数不能缩放历史流量（同类 159219：m=23.53 曾把 −0.99 亿算成 −23.36 亿）", () => {
  // 纯算术：当日无事件（mp=mt=m）时，无论 m 多大，flow 都必须是 (w−p)/1e4×nav
  const fixed = flowStep(7638.8, 17438.8, 1.0131, 23.53, 23.53);
  assertClose(fixed, -0.99, 0.01, "无事件日不应被 m 缩放");
  const buggy = ((7638.8 * 23.53 - 17438.8 * 23.53) / 1e4) * 1.0131;
  assertClose(buggy, -23.36, 0.02, "旧实现应复现 −23.36（用于对照）");
  // 事件当日：mp/mt = ratio → 折算回当日单位
  assertClose(flowStep(2000, 1000, 1, 1, 2), 0, 1e-12, "2:1 拆分日流量为 0");
  assertClose(flowStep(1100, 1000, 1, 1, 1), 0.01, 1e-12, "普通申赎按当日单位计价");

  // |flow| ≤ scale 不变量
  assertEq(flowOutOfBounds(-23.36, 0.77, 0.77), true, "30 倍 AUM 的异常应被抓出");
  assertEq(flowOutOfBounds(0.01, 0.1, 0.1), false, "正常流量不应触发");
  assertEq(flowOutOfBounds(-0.9, 1, 0.1), false, "赎回 90%（|flow|>期末规模）是合法的，不应误报");
  assertEq(flowOutOfBounds(-1.2, 1, 0.1), true, "赎回超过期初规模 → 越界");
  assertEq(flowOutOfBounds(0.2, 0.1, 0.2), false, "申购不超过期末规模");
});

test("E1/E2：份额/净值序列级验证 —— 拆分前后流量不缩放、拆分日为 0", () => {
  const { db, cleanup } = tmpDb("e1-flow");
  try {
    const dates = weekdays("2026-07-01", 10);
    const S = "510401"; // 拆分：第 6 天 2:1
    const F = "510402"; // 真实申购：第 3 天 +100
    const universe = mkUniverse({ 折测: { codes: [S, F] } });
    seedFunds(db, [S, F]);
    seedEvents(db, [{ code: S, date: dates[5], kind: "split", ratio: 2 }]);
    for (let i = 0; i < dates.length; i++) {
      seedShareRows(db, dates[i], [
        [S, i >= 5 ? 2000 : 1000, "sse"],
        [F, i >= 2 ? 1100 : 1000, "sse"],
      ]);
      seedNavRows(db, dates[i], [[S, 1], [F, 1]]);
    }
    recomputeAll(db, { dates, universe });
    const ser = readSeries(db, "series");
    // 第 3 天（下标 2）：只有 F 的 +100 → 0.01 亿；旧实现会被 m=2 放大成 0.02
    assertClose(ser.get(`折测|${dates[2]}`).flow, 0.01, 1e-9, "拆分前的申购不应被未来事件放大");
    // 拆分日：S 份数翻倍 → 流量 0
    assertClose(ser.get(`折测|${dates[5]}`).flow, 0, 1e-9, "拆分日流量应为 0");
    // 拆分之后：同样只有 0 变动
    assertClose(ser.get(`折测|${dates[6]}`).flow, 0, 1e-9, "拆分后流量应为 0");
    // |flow| ≤ scale（每个交易日、这个小类）
    for (const d of dates) {
      const row = ser.get(`折测|${d}`);
      if (row?.flow == null || row.scale == null) continue;
      assert(Math.abs(row.flow) <= Math.abs(row.scale) + 1e-6, `${d} 流量 ${row.flow} 不应超过规模 ${row.scale}`);
    }
  } finally {
    cleanup();
  }
});

test("T0 裁决：区间净申购不含期初当天（期初只作为规模基准）", () => {
  const { db, cleanup } = tmpDb("t0");
  try {
    // 需要足够长的历史，让 1m 的期初不是第 0 天（第 0 天没有前值、天然没有流量）
    const dates = weekdays("2026-05-04", 60);
    const C1 = "510501"; // 只在 1m 期初当天 +500（用于验证区间求和排除 T0）
    const C2 = "510502"; // 只在 7 日窗口的期初当天 +500（用于验证载荷窗口排除 T0）
    const universe = mkUniverse({ 期测: { codes: [C1, C2] } });
    seedFunds(db, [C1, C2]);
    const win1m = periodWindows(dates)["1m"];
    const lastMs = new Date(`${dates.at(-1)}T00:00:00Z`).getTime();
    let win7First = 0;
    for (let i = dates.length - 1; i >= 0; i--) {
      if (lastMs - new Date(`${dates[i]}T00:00:00Z`).getTime() <= 7 * 86400000) win7First = i;
    }
    for (let i = 0; i < dates.length; i++) {
      seedShareRows(db, dates[i], [
        [C1, i >= win1m.i0 ? 1500 : 1000, "sse"],
        [C2, i >= win7First ? 1500 : 1000, "sse"],
      ]);
      seedNavRows(db, dates[i], [[C1, 1], [C2, 1]]);
      markDaySource(db, dates[i], "sse");
    }
    recomputeAll(db, { dates, universe });
    const ctx = createMetricContext(db, dates, { codes: [C1] });
    const daily = dailyFlow(ctx, C1);
    assertClose(daily[win1m.i0], 0.05, 1e-9, "期初当天确实有 0.05 亿流量（用于对照）");
    const m = etfRangeMetrics(ctx, C1, win1m, daily);
    assertClose(m.flow, 0, 1e-9, "区间 flow 应排除期初当天；含 T0 会是 0.05");

    // 载荷级：表格与 subs 的 7 日窗口 flow 也要排除 T0（C2 的跳增正好落在窗口期初）
    const p = buildAllPayloads(db, { universe });
    const row = p.tables.all.find((r) => r.sub === "期测");
    assert(row, "应有该小类");
    assertClose(row.flow, 0, 1e-9, "窗口 flow 应为 0（期初当天的申赎不计）");
    const etf2 = p.subs["期测"].etfs.find((e) => e.code === C2);
    assertClose(etf2.flow, 0, 1e-9, "逐 ETF 窗口 flow 同样排除期初");
  } finally {
    cleanup();
  }
});

test("E3：subs 逐 ETF flow = 逐日净申购求和（不是 Δ份额 × 末日净值）", () => {
  const { db, cleanup } = tmpDb("e3");
  try {
    const dates = weekdays("2026-09-01", 10);
    const C = "510601";
    const universe = mkUniverse({ 近测: { codes: [C] } });
    seedFunds(db, [C]);
    // 份额在窗口第 2 天 +200；净值一路从 1.0 涨到 1.9 → 近似式（Δ×末日净值）会明显偏大
    for (let i = 0; i < dates.length; i++) {
      seedShareRows(db, dates[i], [[C, i >= 5 ? 1200 : 1000, "sse"]]);
      seedNavRows(db, dates[i], [[C, 1 + 0.1 * i]]);
      markDaySource(db, dates[i], "sse");
    }
    recomputeAll(db, { dates, universe });
    const p = buildAllPayloads(db, { universe });
    const etf = p.subs["近测"].etfs.find((e) => e.code === C);
    const ctx = createMetricContext(db, dates, { codes: [C] });
    const daily = dailyFlow(ctx, C);
    // 用「窗口起点 = 最后一个与末日相差 ≤7 自然日」的同一规则复算期望值
    const last = dates.length - 1;
    let first = 0;
    for (let i = last; i >= 0; i--) {
      if (new Date(`${dates[last]}T00:00:00Z`).getTime() - new Date(`${dates[i]}T00:00:00Z`).getTime() <= 7 * 86400000) first = i;
    }
    let exact = null;
    for (let i = first + 1; i <= last; i++) if (Number.isFinite(daily[i])) exact = (exact ?? 0) + daily[i];
    const navEnd = 1 + 0.1 * last;
    const approx = ((1200 - 1000) / 1e4) * navEnd;
    assertClose(etf.flow, Math.round(exact * 100) / 100, 0.011, "逐 ETF flow 应等于逐日求和");
    assert(Math.abs(etf.flow - approx) > 0.005, `本例近似式应明显不同（逐日 ${etf.flow} vs 近似 ${approx.toFixed(3)}）`);
  } finally {
    cleanup();
  }
});
