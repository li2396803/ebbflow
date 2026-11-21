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
import { CATS, SUB, BOND_CAT } from "./taxonomy.mjs";
import { runtimeSignature, FINGERPRINT } from "./signature.mjs";
import { pinyinInitials } from "./pinyin.mjs";
import { recentWindow, windowChanges, catScale } from "./aggregate.mjs";
import { tradingDates, metaGet } from "./db.mjs";

const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/** 读出 {dates, subs:{name:{shares[],scale[],flow[]}}} */
export function loadStore(db, { from, to } = {}) {
  const all = tradingDates(db);
  const dates = all.filter((d) => (!from || d >= from) && (!to || d <= to));
  const idx = new Map(dates.map((d, i) => [d, i]));
  const subs = {};
  for (const name of Object.keys(SUB)) subs[name] = { shares: [], scale: [], flow: [] };
  for (const r of db.prepare("SELECT sub, date, val, scale, flow FROM series").all()) {
    const i = idx.get(r.date);
    const s = subs[r.sub];
    if (i == null || !s) continue;
    s.shares[i] = r.val;
    s.scale[i] = r.scale;
    s.flow[i] = r.flow;
  }
  // 对齐长度
  for (const s of Object.values(subs)) {
    for (const k of ["shares", "scale", "flow"]) {
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

/** 10 个大类 → charts-<cat>.json */
export function buildCharts(store) {
  const n = store.dates.length;
  const out = {};
  for (const cat of CATS) {
    const series = cat.subs
      .filter((name) => store.subs[name]?.shares.some((v) => v != null))
      .map((name) => ({
        name,
        color: SUB[name].color,
        shares: aligned(store.subs[name].shares, n).map(r1),
        scale: aligned(store.subs[name].scale, n).map(r1),
        flow: aligned(store.subs[name].flow, n).map(r1),
      }));
    out[cat.key] = { cat: cat.key, label: cat.label, color: cat.color, dates: store.dates, series };
  }
  return out;
}

/** 首页表格与排行 */
export function buildTables(store) {
  const winIdx = recentWindow(store.dates, 7);
  const first = winIdx[0];
  const last = store.dates.length - 1;
  const pick = (arr, i) => (arr?.[i] == null ? null : arr[i]);

  // 以「份额」为主排序，同时给出规模与净流入口径
  const storeLike = { dates: store.dates, subs: {} };
  for (const [name, s] of Object.entries(store.subs)) storeLike.subs[name] = s.shares;
  const changes = windowChanges(storeLike, winIdx);

  const byDelta = [...changes].sort((a, b) => b.delta - a.delta);
  const rows = byDelta.map((r) => {
    const s = store.subs[r.sub];
    let flowSum = 0, flowOk = false;
    for (let i = first; i <= last; i++) {
      const v = s?.flow?.[i];
      if (v != null) { flowSum += v; flowOk = true; }
    }
    return {
      sub: r.sub,
      cat: r.cat,
      delta: r1(r.delta),
      pct: r2(r.pct),
      first: r1(r.first),
      last: r1(r.last),
      scale: r1(pick(s?.scale, last)),
      scaleDelta: (() => {
        const a = pick(s?.scale, first);
        const b = pick(s?.scale, last);
        return a != null && b != null ? r1(b - a) : null;
      })(),
      flow: flowOk ? r1(flowSum) : null,
    };
  });

  const catRows = catScale(storeLike, winIdx).map((r) => {
    const subs = CATS.find((c) => c.key === r.key)?.subs ?? [];
    let scaleNow = null, flowSum = null;
    for (const name of subs) {
      const s = store.subs[name];
      const sc = pick(s?.scale, last);
      if (sc != null) scaleNow = (scaleNow ?? 0) + sc;
      for (let i = first; i <= last; i++) {
        const f = s?.flow?.[i];
        if (f != null) flowSum = (flowSum ?? 0) + f;
      }
    }
    return {
      key: r.key,
      label: r.label.replace("_", "."),
      now: r1(r.now),
      start: r1(r.start),
      pct: r2(r.pct),
      scale: scaleNow == null ? null : r1(scaleNow),
      flow: flowSum == null ? null : r1(flowSum),
    };
  });

  return {
    window: { from: store.dates[first], to: store.dates[last], days: winIdx.length },
    cats: catRows,
    all: rows,
    top: rows.slice(0, 5),
    bottom: rows.slice(-5).reverse(),
  };
}

/** 86 个小类明细 */
export function buildSubs(db, store) {
  const winIdx = recentWindow(store.dates, 7);
  const firstDate = store.dates[winIdx[0]];
  const lastDate = store.dates.at(-1);
  const q = (d) => new Map(db.prepare("SELECT code, wan FROM share WHERE date=?").all(d).map((r) => [r.code, r.wan]));
  const firstMap = q(firstDate);
  const lastMap = q(lastDate);
  const navRow = (d) => new Map(db.prepare("SELECT code, nav FROM nav WHERE date=?").all(d).map((r) => [r.code, r.nav]));
  const lastNav = navRow(lastDate);
  const marketOf = new Map(db.prepare("SELECT code, market FROM fund").all().map((r) => [r.code, r.market]));

  const out = {};
  for (const [name, meta] of Object.entries(SUB)) {
    const s = store.subs[name];
    let scale = 0, scaleHit = 0, flow = 0, flowHit = 0;
    const etfs = meta.etfs.map((e) => {
      const a = firstMap.get(e.code) ?? null;
      const b = lastMap.get(e.code) ?? null;
      const nav = lastNav.get(e.code) ?? null;
      const factor = meta.cat === BOND_CAT ? 100 : 1;
      const scaleE = b != null && nav != null ? (b / 1e4) * nav : null;
      const flowE = a != null && b != null && nav != null ? ((b - a) / 1e4) * nav : null;
      if (scaleE != null) { scale += scaleE; scaleHit++; }
      if (flowE != null) { flow += flowE; flowHit++; }
      return {
        code: e.code,
        name: e.name,
        market: marketOf.get(e.code) || (/^[569]/.test(e.code) ? "SH" : "SZ"),
        shares: b == null ? null : r2((b / 1e4) * factor),
        delta: a != null && b != null ? r2(((b - a) / 1e4) * factor) : null,
        nav: nav == null ? null : r2(nav),
        scale: scaleE == null ? null : r2(scaleE),
        flow: flowE == null ? null : r2(flowE),
      };
    }).sort((x, y) => (y.scale ?? y.shares ?? -1) - (x.scale ?? x.shares ?? -1));

    out[name] = {
      cat: meta.cat,
      color: meta.color,
      dates: store.dates,
      // 只带「份额」序列（抽屉小图用）；规模/净流入可从 charts-<cat>.json 取，避免 subs.json 膨胀
      values: aligned(s.shares, store.dates.length).map(r1),
      current: s.shares.at(-1) == null ? null : r1(s.shares.at(-1)),
      scale: scaleHit ? r2(scale) : null,
      flow: flowHit ? r2(flow) : null,
      navCoverage: { hit: scaleHit, total: meta.etfs.length },
      etfs,
    };
  }
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
export function buildIndex(db) {
  const subs = Object.entries(SUB).map(([name, m]) => ({
    name,
    cat: m.cat,
    label: CATS.find((c) => c.key === m.cat)?.label ?? m.cat,
    pinyin: pinyinInitials(name),
  }));
  const marketOf = new Map(db.prepare("SELECT code, market FROM fund").all().map((r) => [r.code, r.market]));
  const map = new Map();
  for (const [name, m] of Object.entries(SUB)) {
    for (const e of m.etfs) {
      const cur = map.get(e.code) ?? { code: e.code, name: e.name, market: marketOf.get(e.code) || (/^[569]/.test(e.code) ? "SH" : "SZ"), subs: [] };
      cur.subs.push(name);
      map.set(e.code, cur);
    }
  }
  return { subs, etfs: [...map.values()] };
}

/** 数据质量（透传 reconcile 产物，适配前端契约） */
export function buildQuality(db, qualityFile) {
  const file = qualityFile ?? path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "quality.json");
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
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
      detail: raw,
    };
  }
  return { generatedAt: metaGet(db, "reconcileAt", null), summary: { checked: 0, agree: 0, disagree: 0 }, days: [] };
}

/** meta */
export function buildMeta(db, store, extra = {}) {
  const winIdx = recentWindow(store.dates, 7);
  const sig = runtimeSignature();
  const shCount = db.prepare("SELECT COUNT(*) n FROM fund WHERE name LIKE '%ETF%' AND market='SH'").get().n;
  const szCount = db.prepare("SELECT COUNT(*) n FROM fund WHERE name LIKE '%ETF%' AND market='SZ'").get().n;
  const covered = (market) => {
    const d = store.dates.at(-1);
    return db.prepare("SELECT COUNT(*) n FROM share s JOIN fund f ON f.code=s.code WHERE s.date=? AND f.market=? AND f.name LIKE '%ETF%'").get(d, market).n;
  };
  return {
    title: "ETF 细分行业资金流向",
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
    categories: CATS.map((c) => ({ key: c.key, label: c.label, color: c.color, subs: c.subs.length })),
    metrics: ["shares", "scale", "flow"],
    metricUnits: { shares: "亿份", scale: "亿元", flow: "亿元" },
    counts: {
      subs: Object.keys(SUB).length,
      cats: CATS.length,
      etfs: new Set(Object.values(SUB).flatMap((m) => m.etfs.map((e) => e.code))).size,
    },
    markets: {
      sh: { etfs: shCount, covered: covered("SH") },
      sz: { etfs: szCount, covered: covered("SZ") },
    },
    warnings: extra.warnings ?? [],
  };
}

/** 一次性产出全部载荷 */
export function buildAllPayloads(db, { from, to, updatedAt, warnings } = {}) {
  const store = loadStore(db, { from, to });
  return {
    meta: buildMeta(db, store, { updatedAt, warnings }),
    charts: buildCharts(store),
    tables: buildTables(store),
    subs: buildSubs(db, store),
    market: buildMarket(db, store),
    index: buildIndex(db),
    quality: buildQuality(db),
  };
}
