// 把 SQLite 里的数据整理成前端/静态托管可直接消费的 JSON 载荷（契约 v3）
//
//   meta.json         站点元信息（含市场覆盖、指标单位、署名）
//   charts-<cat>.json 每个大类：dates + series[{name,color,shares,scale,flow}]（三指标并列）
//   tables.json       首页三张表 + 全部小类排行
//   subs.json         86 个小类明细（成分 ETF、净值覆盖、当前值）
//   market.json       全市场（沪深 + 按基金类型）走势
//   index.json        搜索索引（小类 + ETF，带拼音）
//   quality.json      三源交叉校验摘要（来自 data/quality.json）
import fs from "node:fs";
import path from "node:path";
import { loadUniverse } from "./universe.mjs";
import { projectRoot, readJsonFile } from "./cli.mjs";

const ROOT_DIR = projectRoot(import.meta.url);

const UNIVERSE = loadUniverse();
const SUB = UNIVERSE.SUB;
const CATS = UNIVERSE.CATS;
const ALL_CODES = UNIVERSE.ALL_CODES;
const BOND_CAT = "9_债券";
import { runtimeSignature, FINGERPRINT } from "./signature.mjs";
import { pinyinInitials } from "./pinyin.mjs";
import { recentWindow } from "./aggregate.mjs";
import { tradingDates, metaGet } from "./db.mjs";
import { PERIODS, periodWindows, createMetricContext, buildEtfRanges, lowCoverageSummary, dailyFlow } from "./metrics.mjs";

const r2p = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 100);
const isBondCat = (cat) => cat === BOND_CAT || cat === "bond";
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/** 读出 {dates, subs:{name:{shares[],scale[],flow[]}}} */
export function loadStore(db, { from, to, table = "series", universe } = {}) {
  const all = tradingDates(db);
  const dates = all.filter((d) => (!from || d >= from) && (!to || d <= to));
  const idx = new Map(dates.map((d, i) => [d, i]));
  const subs = {};
  const names = Object.keys(universe?.SUB ?? SUB);
  for (const name of names) subs[name] = { shares: [], scale: [], flow: [], coverage: [] };
  const tname = table === "series_v2" ? "series_v2" : "series";
  for (const r of db.prepare(`SELECT sub, date, val, scale, flow, coverage FROM ${tname}`).all()) {
    const i = idx.get(r.date);
    const s = subs[r.sub];
    if (i == null || !s) continue;
    s.shares[i] = r.val;
    s.scale[i] = r.scale;
    s.flow[i] = r.flow;
    s.coverage[i] = r.coverage;
  }
  // 对齐长度
  for (const s of Object.values(subs)) {
    for (const k of ["shares", "scale", "flow", "coverage"]) {
      while (s[k].length < dates.length) s[k].push(null);
    }
  }
  return { dates, subs };
}

const aligned = (arr, n) => {
  const out = new Array(n).fill(null);
  for (let i = 0; i < Math.min(arr.length, n); i++) out[i] = arr[i] ?? null;
  return out;
};

/**
 * 10 个大类 → charts-<cat>.json
 * v4.0.0：只输出「规模（亿元）」与「净申购（亿元/日）」，不再输出份额。
 */
export function buildCharts(store, U = { CATS, SUB }) {
  const n = store.dates.length;
  const out = {};
  for (const cat of U.CATS) {
    const series = cat.subs
      .filter((name) => store.subs[name]?.scale.some((v) => v != null))
      .map((name) => ({
        name,
        color: U.SUB[name]?.color || "#8b949e",
        scale: aligned(store.subs[name].scale, n).map(r1),
        flow: aligned(store.subs[name].flow, n).map(r1),
      }));
    out[cat.key] = { cat: cat.key, label: cat.label, color: cat.color, dates: store.dates, unit: "亿元", series };
  }
  return out;
}

/**
 * 首页表格与排行（v4：按「规模」排行，变化率 = 规模变化率，净申购单列）
 */
export function buildTables(store, U = { CATS, SUB }) {
  const winIdx = recentWindow(store.dates, 7);
  const first = winIdx[0];
  const last = store.dates.length - 1;
  const pick = (arr, i) => (arr?.[i] == null ? null : arr[i]);

  const rows = [];
  for (const cat of U.CATS) {
    for (const name of cat.subs) {
      const s = store.subs[name];
      if (!s) continue;
      const a = pick(s.scale, first);
      const b = pick(s.scale, last);
      if (b == null) continue;
      let flow = null;
      // 审计裁决 C1：窗口净申购不含期初当天（期初规模 = scale[first]，资金变动从 first+1 起算）
      for (let i = first + 1; i <= last; i++) {
        const v = s.flow?.[i];
        if (v != null) flow = (flow ?? 0) + v;
      }
      const pct = a != null && a > 0 ? ((b - a) / a) * 100 : null;
      rows.push({
        sub: name,
        cat: cat.key,
        delta: a == null ? null : r1(b - a), // 窗口内规模变化（亿元）
        pct: pct == null ? null : r2(pct), // 规模变化率（%）
        first: a == null ? null : r1(a),
        last: r1(b),
        scale: r1(b),
        scaleDelta: a == null ? null : r1(b - a),
        flow: flow == null ? null : r1(flow),
      });
    }
  }
  rows.sort((x, y) => (y.delta ?? -Infinity) - (x.delta ?? -Infinity));

  const catRows = U.CATS.map((cat) => {
    let now = null;
    let start = null;
    let flow = null;
    for (const name of cat.subs) {
      const s = store.subs[name];
      if (!s) continue;
      const b = pick(s.scale, last);
      const a = pick(s.scale, first);
      if (b != null) now = (now ?? 0) + b;
      if (a != null) start = (start ?? 0) + a;
      for (let i = first + 1; i <= last; i++) {
        const f = s.flow?.[i];
        if (f != null) flow = (flow ?? 0) + f;
      }
    }
    return {
      key: cat.key,
      label: cat.label.replace("_", "."),
      now: now == null ? null : r1(now),
      start: start == null ? null : r1(start),
      pct: start != null && start > 0 && now != null ? r2(((now - start) / start) * 100) : null,
      scale: now == null ? null : r1(now),
      flow: flow == null ? null : r1(flow),
    };
  });
  catRows.sort((a, b) => (b.now ?? -Infinity) - (a.now ?? -Infinity));

  return {
    window: { from: store.dates[first], to: store.dates[last], days: winIdx.length },
    cats: catRows,
    all: rows,
    top: rows.slice(0, 5),
    bottom: rows.slice(-5).reverse(),
  };
}

/** 组装 `etf-ranges/<cat>.json` 的内容（按大类分文件，一次加载只覆盖当前大类） */
export function buildEtfRangeFiles({ ranges, universe: U }) {
  const out = {};
  if (!ranges) return out;
  for (const cat of U.CATS) {
    const subs = {};
    for (const name of cat.subs) {
      const meta = U.SUB[name];
      if (!meta) continue;
      const perPeriod = {};
      for (const p of PERIODS) {
        const src = ranges[p] ?? {};
        const o = {};
        for (const e of meta.etfs) {
          const v = src[e.code];
          if (v) o[e.code] = v;
        }
        perPeriod[p] = o;
      }
      subs[name] = perPeriod;
    }
    out[cat.key] = { cat: cat.key, periods: PERIODS, unit: { chgPct: "%", flow: "亿元", scaleEnd: "亿元" }, subs };
  }
  return out;
}

/** 86 个小类明细（v4：规模/净申购/覆盖率 + 每只 ETF 的区间精确指标） */
export function buildSubs(db, store, U = { CATS, SUB }, TAGS = {}, extra = {}) {
  // 体积开关：flow（默认：只带 flowSeries，规模序列以 charts-<cat>.json 为唯一来源） /
  //          all（scale+flow 都带，subs.json 会到 1.48×）/ none（两条都不带）
  // 依据：charts 里已有逐日规模序列，subs 再存一份是纯重复；flow 模式实测 170KB（0.76×）。
  const seriesMode = extra.seriesMode ?? "flow";
  // 名称以 fund 表为准：交易所优先写入后，分类快照里的旧名字可能已过时
  const fundName = new Map(db.prepare("SELECT code, name FROM fund WHERE name IS NOT NULL AND name != ''").all().map((r) => [r.code, r.name]));
  const winIdx = recentWindow(store.dates, 7);
  const firstDate = store.dates[winIdx[0]];
  const lastDate = store.dates.at(-1);
  if (!firstDate || !lastDate) return { __dates: store.dates }; // 空库：没有任何小类可输出
  const q = (d) => new Map(db.prepare("SELECT code, wan FROM share WHERE date=?").all(d).map((r) => [r.code, r.wan]));
  const firstMap = q(firstDate);
  const lastMap = q(lastDate);
  const navRow = (d) => new Map(db.prepare("SELECT code, nav FROM nav WHERE date=?").all(d).map((r) => [r.code, r.nav]));
  const lastNav = navRow(lastDate);
  // 行情：收盘价 → 折溢价、成交额、换手率；上市日期 → 标记新发
  const qrow = (d) => new Map(db.prepare("SELECT code, close, pct_chg, amount FROM quote WHERE date=?").all(d).map((r) => [r.code, r]));
  const lastQuote = qrow(lastDate);
  const listDate = new Map(db.prepare("SELECT code, list_date FROM fund").all().map((r) => [r.code, r.list_date]));
  const marketOf = new Map(db.prepare("SELECT code, market FROM fund").all().map((r) => [r.code, r.market]));

  // 逐 ETF 窗口净申购：与 etfRanges 同一个 dailyFlow，且同样排除期初当天（裁决 C1）
  const nDates = store.dates.length;
  const winStart = Math.min((winIdx[0] ?? 0) + 1, Math.max(0, nDates - 1));
  const flowMemo = new Map();
  const windowFlowFor = (code) => {
    if (flowMemo.has(code)) return flowMemo.get(code);
    let v = null;
    if (extra.ctx) {
      const daily = dailyFlow(extra.ctx, code);
      let sum = null;
      for (let i = winStart; i < nDates; i++) {
        const f = daily[i];
        if (Number.isFinite(f)) sum = (sum ?? 0) + f;
      }
      v = sum;
    }
    flowMemo.set(code, v);
    return v;
  };

  const out = {};
  for (const [name, meta] of Object.entries(U.SUB)) {
    const s = store.subs[name];
    if (!s) continue; // 该小类在当前库里没有序列（数据不全），跳过而不是崩掉
    let scale = 0, scaleHit = 0, flow = 0, flowHit = 0;
    const etfs = meta.etfs.map((e) => {
      const a = firstMap.get(e.code) ?? null;
      const b = lastMap.get(e.code) ?? null;
      const nav = lastNav.get(e.code) ?? null;
      const factor = isBondCat(meta.cat) ? 100 : 1;
      const q = lastQuote.get(e.code);
      const price = q?.close ?? null;
      const premium = price != null && nav != null && nav > 0 ? r2p((price - nav) / nav) : null;
      const amountYi = q?.amount != null ? r2(q.amount / 1e5) : null; // 千元 → 亿元
      const scaleE = b != null && nav != null ? (b / 1e4) * nav : null;
      // E3：逐 ETF 净申购必须是「逐日净申购求和」（与 etfRanges 同一个 dailyFlow），
      // 不能用 Δ份额 × 末日净值近似（607/1649 只会差 >0.02 亿，最大 54.65 亿）。
      const flowE = windowFlowFor(e.code);
      if (scaleE != null) { scale += scaleE; scaleHit++; }
      if (flowE != null) { flow += flowE; flowHit++; }
      return {
        code: e.code,
        name: fundName.get(e.code) || e.name,
        tags: TAGS[e.code] ?? [],
        market: marketOf.get(e.code) || (/^[569]/.test(e.code) ? "SH" : "SZ"),
        // v4：份额字段（shares/delta）不再对外展示，逐 ETF 的区间指标看 etfRanges
        nav: nav == null ? null : r2(nav),
        price: price == null ? null : r2(price),
        premium,
        pctChg: q?.pct_chg ?? null,
        amount: amountYi,
        turnover: amountYi != null && scaleE != null && scaleE > 0 ? r2p(amountYi / scaleE) : null,
        listDate: listDate.get(e.code) ?? null,
        scale: scaleE == null ? null : r2(scaleE),
        flow: flowE == null ? null : r2(flowE),
      };
    }).sort((x, y) => (y.scale ?? y.shares ?? -1) - (x.scale ?? x.shares ?? -1));

    // v4 主指标：规模 / 净申购 / 覆盖率（逐日，长度 = __dates）
    const scaleSeries = aligned(s.scale, store.dates.length).map(r1);
    const flowSeries = aligned(s.flow, store.dates.length).map(r1);
    const coverage = aligned(s.coverage, store.dates.length).map((v) => (v == null ? null : Math.round(v * 100) / 100));
    const lastIdx = store.dates.length - 1;
    let windowFlow = null;
    // 裁决 C1：窗口净申购不含期初当天
    for (let i = winStart; i <= lastIdx; i++) {
      const v = flowSeries[i];
      if (v != null) windowFlow = (windowFlow ?? 0) + v;
    }
    out[name] = {
      cat: meta.cat,
      color: meta.color,
      // 交易轴只存一份（顶层 __dates）；这里不再重复
      // v4 契约：规模序列的唯一来源是 charts-<cat>.json；subs 默认只带净申购序列
      ...(seriesMode === "all" ? { scaleSeries } : {}),
      ...(seriesMode === "none" ? {} : { flowSeries }),
      scaleSeriesSource: seriesMode === "all" ? null : "charts",
      coverage,
      // 旧字段保留一个版本：values 置空（份额不再是展示口径），下个版本删除
      values: null,
      valuesDeprecated: true,
      // current 保留现有语义（末日内部分额值，亿份）；currentScale 是 v4 的「当前规模」（亿元）
      current: s.shares.at(-1) == null ? null : r1(s.shares.at(-1)),
      // currentScale / scale 仍从库内规模序列取（不依赖是否下发 scaleSeries）
      currentScale: scaleSeries[lastIdx] ?? null,
      scale: scaleSeries[lastIdx] ?? null,
      flow: windowFlow == null ? null : r2(windowFlow),
      navCoverage: { hit: scaleHit, total: meta.etfs.length },
      etfs,
      // 每只 ETF 的区间精确指标：拆到独立文件（subs.json 体积预算 1.35×，见 buildEtfRangeFiles）
      etfRanges: null,
      etfRangesFile: `etf-ranges/${meta.cat}.json`,
    };
  }
  // 交易日轴只存一份（每个小类各存一份会重复 72 次）
  out.__dates = store.dates;
  return out;
}

/** 全市场走势与结构 */
export function buildMarket(db, store) {
  const m = new Map();
  for (const r of db.prepare("SELECT date, scope, shares, scale, etfs FROM market").all()) {
    if (!m.has(r.scope)) m.set(r.scope, { shares: [], scale: [], etfs: [] });
    m.get(r.scope).dates ??= [];
    m.get(r.scope).dates.push(r.date);
    m.get(r.scope).shares.push(r1(r.shares));
    m.get(r.scope).scale.push(r1(r.scale));
    m.get(r.scope).etfs.push(r.etfs);
  }
  // 完整性判断：既要覆盖足够多的交易日，也要深市真的有数据（否则总量会看起来偏低）
  const allRows = m.get("ALL")?.shares ?? [];
  const szRows = m.get("SZ")?.shares ?? [];
  const szNonZero = szRows.filter((v) => v != null && v > 0).length;
  if (allRows.length < 1000 || szNonZero < 500) return null;
  const sh = m.get("SH") ?? { shares: [], scale: [], etfs: [] };
  const sz = m.get("SZ") ?? { shares: [], scale: [], etfs: [] };
  const all = m.get("ALL") ?? { shares: [], scale: [], etfs: [] };
  const lastDate = store.dates.at(-1);
  const byType = db
    .prepare("SELECT type, shares, scale, etfs FROM market_type WHERE date=? ORDER BY scale DESC")
    .all(lastDate)
    .map((r) => ({ type: r.type, shares: r1(r.shares), scale: r1(r.scale), etfs: r.etfs }));
  return {
    dates: store.dates,
    sh: { shares: aligned(sh.shares, store.dates.length), scale: aligned(sh.scale, store.dates.length), etfs: sh.etfs.at(-1) ?? 0 },
    sz: { shares: aligned(sz.shares, store.dates.length), scale: aligned(sz.scale, store.dates.length), etfs: sz.etfs.at(-1) ?? 0 },
    total: { shares: aligned(all.shares, store.dates.length), scale: aligned(all.scale, store.dates.length), etfs: all.etfs.at(-1) ?? 0 },
    byType,
    asOf: lastDate,
    unit: { shares: "亿份", scale: "亿元" },
    note: "全市场口径统计全部场内 ETF（含深市），不做债券 ×100 折算，与细分行业页的「份额」口径不同。",
  };
}

/** 搜索索引 */
export function buildIndex(db, U = { CATS, SUB }) {
  const fundNameOf = new Map(db.prepare("SELECT code, name FROM fund WHERE name IS NOT NULL AND name != ''").all().map((r) => [r.code, r.name]));
  const subs = Object.entries(U.SUB).map(([name, m]) => ({
    name,
    cat: m.cat,
    label: U.CATS.find((c) => c.key === m.cat)?.label ?? m.cat,
    pinyin: pinyinInitials(name),
  }));
  const marketOf = new Map(db.prepare("SELECT code, market FROM fund").all().map((r) => [r.code, r.market]));
  const map = new Map();
  for (const [name, m] of Object.entries(U.SUB)) {
    for (const e of m.etfs) {
      const cur = map.get(e.code) ?? { code: e.code, name: fundNameOf.get(e.code) || e.name, market: marketOf.get(e.code) || (/^[569]/.test(e.code) ? "SH" : "SZ"), subs: [] };
      cur.subs.push(name);
      map.set(e.code, cur);
    }
  }
  return { subs, etfs: [...map.values()] };
}

/** 数据质量（透传 reconcile 产物，适配前端契约） */
export function buildQuality(db, qualityFile, store = null) {
  const file = qualityFile ?? path.join(ROOT_DIR, "data", "quality.json");
  let raw = null;
  try {
    raw = readJsonFile(file);
  } catch {}
  if (raw?.summary?.compared) {
    const c = raw.summary.compared;
    const bad = (c.le0_1 ?? 0) + (c.le1 ?? 0) + (c.gt1 ?? 0);
    return {
      generatedAt: raw.generatedAt ?? raw.summary.generatedAt ?? null,
      summary: {
        checked: c.both ?? 0,
        agree: c.identical ?? 0,
        disagree: bad,
        onlyExchange: c.onlyExchange ?? 0,
        onlyTs: c.onlyTs ?? 0,
        onlyTsExpected: c.onlyTsExpected ?? 0,
        rates: raw.summary.rates ?? null,
        subs: raw.summary.subs ?? null,
        worstSub: raw.summary.worstSub ?? null,
        ok: raw.summary.ok ?? null,
        range: raw.summary.range ?? null,
      },
      days: (raw.days ?? []).map((d) => ({
        date: d.date,
        count: d.mismatch?.count ?? 0,
        samples: (d.mismatch?.byCode ?? []).slice(0, 6).map((x) => `${x.code} 交易所=${x.exchange} / tushare=${x.ts}`),
      })),
      // 可疑跳变（份额折算 / 覆盖率变化 / 新成分 / 未知）：来自 data/quality.json，供"为什么这天跳了"查询
      jumps: raw.jumps ?? null,
      // 低覆盖日汇总（coverage < 0.6）：前端据此把区间指标的首尾向前取最近达标日
      lowCoverageDays: store ? lowCoverageSummary(new Map(Object.entries(store.subs).map(([n, s]) => [n, s.coverage]))) : null,
      detail: raw,
    };
  }
  return {
    generatedAt: metaGet(db, "reconcileAt", null),
    summary: { checked: 0, agree: 0, disagree: 0 },
    days: [],
    lowCoverageDays: store ? lowCoverageSummary(new Map(Object.entries(store.subs).map(([n, s]) => [n, s.coverage]))) : null,
  };
}

/** meta */
export function buildMeta(db, store, extra = {}, U = { CATS, SUB }) {
  const winIdx = recentWindow(store.dates, 7);
  const sig = runtimeSignature();
  const shCount = db.prepare("SELECT COUNT(*) n FROM fund WHERE name LIKE '%ETF%' AND market='SH'").get().n;
  const szCount = db.prepare("SELECT COUNT(*) n FROM fund WHERE name LIKE '%ETF%' AND market='SZ'").get().n;
  const covered = (market) => {
    const d = store.dates.at(-1);
    if (!d) return 0; // 空库（首次启动、还没回补）时直接返回 0，避免把 undefined 绑定给 SQLite
    return (
      db
        .prepare("SELECT COUNT(*) n FROM share s JOIN fund f ON f.code=s.code WHERE s.date=? AND f.market=? AND f.name LIKE '%ETF%'")
        .get(d, market)?.n ?? 0
    );
  };
  return {
    title: "ETF 细分行业资金流向",
    // 空库（首次启动、还没回补）时为 false，前端据此显示「先回补数据」提示
    initialized: store.dates.length > 0,
    lastTradeDate: store.dates.at(-1) ?? null,
    range: { from: store.dates[0] ?? null, to: store.dates.at(-1) ?? null, days: store.dates.length },
    recent: { from: store.dates[winIdx[0]] ?? null, to: store.dates.at(-1) ?? null, days: winIdx.length },
    updatedAt: extra.updatedAt ?? metaGet(db, "updatedAt", null),
    author: sig.author,
    repo: sig.repo,
    license: sig.license,
    signature: FINGERPRINT,
    origin: sig.origin,
    sources: ["上交所", "Tushare"],
    // 规范的大类清单（10 个，与 charts-<key>.json 的 key 一一对应）
    taxonomy: U.stats?.taxonomy ?? "legacy",
    tagDims: { index: "指数类别", sw: "申万一级", csi: "中证一级", theme: "主题", region: "地区", factor: "因子", bond: "债券细分", commodity: "商品细分" },
    categories: U.CATS.map((c) => ({ key: c.key, label: c.label, color: c.color, subs: c.subs.length })),
    // v4.0.0 起对外只有「规模 / 净申购 / 变化率」；份额仅存于库内用于计算净申购
    metrics: ["scale", "flow", "chg"],
    metricUnits: { scale: "亿元", flow: "亿元", chg: "%" },
    deprecated: { shares: "v4 起不再展示（内部仅用于计算净申购），subs[].values 已置空" },
    counts: {
      subs: Object.keys(U.SUB).length,
      cats: U.CATS.length,
      etfs: new Set(Object.values(U.SUB).flatMap((m) => m.etfs.map((e) => e.code))).size,
    },
    markets: {
      sh: { etfs: shCount, covered: covered("SH") },
      sz: { etfs: szCount, covered: covered("SZ") },
    },
    warnings: extra.warnings ?? [],
  };
}

/** 一次性产出全部载荷 */
/** 多维标签（data/tags-v2.json）：一只 ETF 可同时属于多个视角，这里按代码索引 */
function loadTags() {
  try {
    const f = path.join(ROOT_DIR, "data", "tags-v2.json");
    const j = readJsonFile(f);
    return j.tags ?? {};
  } catch {
    return {};
  }
}

export function buildAllPayloads(db, { from, to, updatedAt, warnings, universe, table, metricCtx, subsSeries = "flow" } = {}) {
  const U = universe ?? { CATS, SUB, stats: { taxonomy: "legacy" } };
  const tname = table ?? (U.stats?.taxonomy === "v2" ? "series_v2" : "series");
  const store = loadStore(db, { from, to, table: tname, universe: U });
  const tags = loadTags();

  // v4：每只 ETF 的区间精确指标。上下文（份额/净值定长数组）可由调用方传入，
  // 让 v2 与 legacy 两棵树共用一份（加载 1.25M 行约 4s，重复两次很浪费）。
  let ranges = null;
  let ctx = null;
  if (store.dates.length) {
    const codes = new Set(Object.values(U.SUB).flatMap((m) => m.etfs.map((e) => e.code)));
    const reuse =
      metricCtx &&
      metricCtx.dates.length === store.dates.length &&
      metricCtx.dates[0] === store.dates[0] &&
      metricCtx.dates[store.dates.length - 1] === store.dates[store.dates.length - 1];
    ctx = reuse ? metricCtx : createMetricContext(db, store.dates, { codes });
    ranges = buildEtfRanges({ ctx, universe: U, windows: periodWindows(store.dates) });
  }

  return {
    meta: buildMeta(db, store, { updatedAt, warnings }, U),
    charts: buildCharts(store, U),
    tables: buildTables(store, U),
    subs: buildSubs(db, store, U, tags, { ctx, seriesMode: subsSeries }),
    market: buildMarket(db, store),
    index: buildIndex(db, U),
    quality: buildQuality(db, undefined, store),
    // 逐 ETF 区间指标：按大类拆文件（页面只加载当前大类那一份）
    etfRanges: buildEtfRangeFiles({ ranges, universe: U }),
  };
}
