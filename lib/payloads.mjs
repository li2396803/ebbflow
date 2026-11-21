// 把 DB 里的数据整理成前端/静态托管可直接消费的 JSON 载荷
// 约定：所有载荷都是纯数据（可 JSON.stringify），不含函数与 DB 句柄
import fs from "node:fs";
import path from "node:path";
import { CATS, SUB, BOND_CAT } from "./taxonomy.mjs";
import { runtimeSignature, FINGERPRINT } from "./signature.mjs";
import { recentWindow, windowChanges, catScale } from "./aggregate.mjs";
import { allDates, tradingDates, seriesOf, metaGet, navMap } from "./db.mjs";

const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);

/** 从 DB 读成 {dates, subs} 结构（与旧版 store 兼容，便于复用聚合函数） */
export function loadStore(db, { from, to } = {}) {
  const all = tradingDates(db);
  const dates = all.filter((d) => (!from || d >= from) && (!to || d <= to));
  const idx = new Map(dates.map((d, i) => [d, i]));
  const subs = {};
  for (const sub of Object.keys(SUB)) subs[sub] = new Array(dates.length).fill(null);
  const rows = db.prepare("SELECT sub, date, val FROM series").all();
  for (const { sub, date, val } of rows) {
    const i = idx.get(date);
    if (i != null && subs[sub]) subs[sub][i] = val;
  }
  return { dates, subs };
}

/** 近 N 日窗口内的百分比序列（基准 = 窗口首个有效值） */
function normalizeWindow(dates, values, winIdx) {
  const vals = winIdx.map((i) => values[i]);
  let base = null;
  for (const v of vals) if (v != null && v > 0) { base = v; break; }
  return vals.map((v) => (v == null || base == null ? null : r1((v / base) * 100)));
}

/** 长期归一（首个有效日 = 100），用于 c2 */
export function normalizeSeries(values) {
  let base = null;
  let baseAt = -1;
  for (let i = 0; i < values.length; i++) if (values[i] != null && values[i] > 0) { base = values[i]; baseAt = i; break; }
  return values.map((v, i) => (v == null || base == null || i < baseAt ? null : r1((v / base) * 100)));
}

export function buildCharts(db, store) {
  const winIdx = recentWindow(store.dates, 7);
  const out = {};
  for (const cat of CATS) {
    const series = cat.subs
      .filter((name) => store.subs[name]?.some((v) => v != null))
      .map((name) => ({ name, color: SUB[name].color, values: store.subs[name].map(r1) }));
    const c2 = series.map((s) => ({ ...s, values: normalizeSeries(store.subs[s.name]) }));
    const c3 = series.map((s) => ({ ...s, values: normalizeWindow(store.dates, store.subs[s.name], winIdx) }));
    out[cat.key] = {
      cat: cat.key,
      label: cat.label,
      color: cat.color,
      c1: { dates: store.dates, series },
      c2: { dates: store.dates, series: c2 },
      c3: { dates: winIdx.map((i) => store.dates[i]), series: c3 },
    };
  }
  return out;
}

export function buildTables(db, store) {
  const winIdx = recentWindow(store.dates, 7);
  const subsLite = buildSubs(db, store);
  const changes = windowChanges(store, winIdx);
  const byDelta = [...changes].sort((a, b) => b.delta - a.delta);
  return {
    window: {
      from: store.dates[winIdx[0]],
      to: store.dates.at(-1),
      days: winIdx.length,
    },
    cats: catScale(store, winIdx).map((r) => ({ key: r.key, label: r.label.replace("_", "."), now: r1(r.now), start: r1(r.start), pct: r2(r.pct) })),
    top: byDelta.slice(0, 5).map((r) => ({ sub: r.sub, cat: r.cat, delta: r1(r.delta), pct: r2(r.pct) })),
    bottom: byDelta.slice(-5).reverse().map((r) => ({ sub: r.sub, cat: r.cat, delta: r1(r.delta), pct: r2(r.pct) })),
    all: byDelta.map((r) => {
      const s = subsLite[r.sub] || {};
      return { sub: r.sub, cat: r.cat, delta: r1(r.delta), pct: r2(r.pct), first: r1(r.first), last: r1(r.last), scale: s.scale ?? null, flow: s.flow ?? null };
    }),
  };
}

/** 每个小类的成分 ETF 明细 + 自身历史 */
export function buildSubs(db, store) {
  const winIdx = recentWindow(store.dates, 7);
  const firstDate = store.dates[winIdx[0]];
  const lastDate = store.dates.at(-1);
  const firstMap = new Map(db.prepare("SELECT code, wan FROM share WHERE date=?").all(firstDate).map((r) => [r.code, r.wan]));
  const lastMap = new Map(db.prepare("SELECT code, wan FROM share WHERE date=?").all(lastDate).map((r) => [r.code, r.wan]));
  const firstNav = navMap(db, firstDate);
  const lastNav = navMap(db, lastDate);
  const out = {};
  for (const [name, meta] of Object.entries(SUB)) {
    const vals = store.subs[name] || [];
    // 金额口径：规模(亿元) = 份额(万份)/1e4 × 净值(元/份)；净流入(亿元) = Δ份额(万份)/1e4 × 当日净值
    let scale = 0, flow = 0, navHit = 0;
    const etfs = meta.etfs.map((e) => {
      const a = firstMap.get(e.code) ?? null;
      const b = lastMap.get(e.code) ?? null;
      const nav = lastNav.get(e.code) ?? lastNav.get(e.code) ?? null;
      const navA = firstNav.get(e.code) ?? null;
      const scaleE = b != null && nav != null ? r2((b / 1e4) * nav) : null;
      const flowE = a != null && b != null && nav != null ? r2(((b - a) / 1e4) * nav) : null;
      if (scaleE != null) { scale += scaleE; navHit++; }
      if (flowE != null) flow += flowE;
      return {
        code: e.code,
        name: e.name,
        shares: b == null ? null : r1(b / 1e4),
        delta: a != null && b != null ? r1((b - a) / 1e4) : null,
        nav: nav == null ? null : r2(nav),
        navPrev: navA == null ? null : r2(navA),
        scale: scaleE,
        flow: flowE,
      };
    });
    out[name] = {
      cat: meta.cat,
      color: meta.color,
      dates: store.dates,
      values: vals.map(r1),
      current: vals.at(-1) == null ? null : r1(vals.at(-1)),
      scale: navHit ? r2(scale) : null,
      flow: navHit ? r2(flow) : null,
      navCoverage: { hit: navHit, total: meta.etfs.length },
      etfs: etfs.sort((x, y) => (y.scale ?? y.shares ?? -1) - (x.scale ?? x.shares ?? -1)),
    };
  }
  return out;
}

/** 搜索索引：小类名 + ETF 代码/名称 → 所属小类 */
export function buildIndex(db) {
  const subs = Object.entries(SUB).map(([name, m]) => ({ name, cat: m.cat, label: CATS.find((c) => c.key === m.cat)?.label ?? m.cat }));
  const map = new Map();
  for (const [name, m] of Object.entries(SUB)) {
    for (const e of m.etfs) {
      const cur = map.get(e.code) ?? { code: e.code, name: e.name, subs: [] };
      cur.subs.push(name);
      map.set(e.code, cur);
    }
  }
  return { subs, etfs: [...map.values()] };
}

/** 数据质量摘要：优先读 reconcile 产出的 data/quality.json，适配成前端契约 */
export function buildQuality(db, qualityFile) {
  const file = qualityFile ?? path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "quality.json");
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}

  if (raw && raw.summary && raw.summary.compared) {
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
        dateAxis: raw.summary.dateAxis ?? null,
      },
      days: (raw.days ?? []).map((d) => ({
        date: d.date,
        count: d.mismatch?.count ?? 0,
        samples: (d.mismatch?.byCode ?? []).slice(0, 6).map((x) => `${x.code} 交易所=${x.exchange} / tushare=${x.ts}`),
        perSource: d.perSource ?? null,
        seriesInconsistent: (d.seriesCheck ?? []).filter((x) => x.inconsistent).length,
      })),
      detail: raw,
    };
  }

  // 回退：直接读 reconcile 表（只存了差异行）
  const rows = db.prepare("SELECT date, sub, code, a, b, note FROM reconcile").all();
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  return {
    generatedAt: metaGet(db, "reconcileAt", null),
    summary: { checked: 0, agree: 0, disagree: rows.length, source: "db-table" },
    days: [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, list]) => ({
      date,
      count: list.length,
      samples: list.slice(0, 6).map((r) => `${r.sub}/${r.code} ${r.a} vs ${r.b}`),
    })),
  };
}

export function buildMeta(db, store, extra = {}) {
  const winIdx = recentWindow(store.dates, 7);
  return {
    title: "ETF 细分行业资金流向",
    lastTradeDate: store.dates.at(-1) ?? null,
    range: { from: store.dates[0] ?? null, to: store.dates.at(-1) ?? null, days: store.dates.length },
    recent: { from: store.dates[winIdx[0]] ?? null, to: store.dates.at(-1) ?? null, days: winIdx.length },
    updatedAt: extra.updatedAt ?? metaGet(db, "updatedAt", null),
    sources: ["上交所", "深交所", "Tushare"],
    warnings: extra.warnings ?? [],
    counts: { subs: Object.keys(SUB).length, cats: CATS.length, etfs: new Set(Object.values(SUB).flatMap((m) => m.etfs.map((e) => e.code))).size },
    author: runtimeSignature().author,
    repo: runtimeSignature().repo,
    license: runtimeSignature().license,
    signature: FINGERPRINT,
    origin: runtimeSignature().origin,
    metrics: ["shares", "scale", "flow"],
    metricUnits: { shares: "亿份", scale: "亿元", flow: "亿元" },
  };
}

/** 一次性产出全部载荷 */
export function buildAllPayloads(db, { from, to, updatedAt, warnings } = {}) {
  const store = loadStore(db, { from, to });
  return {
    meta: buildMeta(db, store, { updatedAt, warnings }),
    charts: buildCharts(db, store),
    tables: buildTables(db, store),
    subs: buildSubs(db, store),
    index: buildIndex(db),
    quality: buildQuality(db),
  };
}
