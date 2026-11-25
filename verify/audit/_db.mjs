// 审计共用：只读打开 etf.db，加载份额/净值/事件/上市日，v2 分类宇宙
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

export function openDb(file = "data/etf.db") {
  return new DatabaseSync(file, { readOnly: true });
}

export function loadDates(db, table = "series_v2") {
  return db
    .prepare(`SELECT DISTINCT date FROM ${table} ORDER BY date`)
    .all()
    .map((r) => r.date);
}

export function v2Universe() {
  return JSON.parse(fs.readFileSync("data/classification-v2.json", "utf8"));
}

export function siteJson(rel) {
  return JSON.parse(fs.readFileSync(`site/data/${rel}`, "utf8"));
}

/** 把 share/nav/event/fund 读成按日期下标索引的定长数组（NaN = 缺失） */
export function buildCtx(db, dates) {
  const n = dates.length;
  const index = new Map(dates.map((d, i) => [d, i]));
  const shares = new Map();
  const navs = new Map();
  const ensure = (m, code) => {
    let a = m.get(code);
    if (!a) {
      a = new Float64Array(n).fill(NaN);
      m.set(code, a);
    }
    return a;
  };
  for (const r of db.prepare("SELECT code, date, wan FROM share").all()) {
    const i = index.get(r.date);
    if (i != null) ensure(shares, r.code)[i] = r.wan;
  }
  for (const r of db.prepare("SELECT code, date, nav FROM nav").all()) {
    const i = index.get(r.date);
    if (i != null) ensure(navs, r.code)[i] = r.nav;
  }
  const events = new Map();
  for (const r of db.prepare("SELECT code, date, kind, ratio FROM event").all()) {
    let l = events.get(r.code);
    if (!l) events.set(r.code, (l = []));
    l.push({ date: r.date, kind: r.kind, ratio: r.ratio });
  }
  const listDate = new Map();
  for (const r of db.prepare("SELECT code, list_date FROM fund WHERE list_date IS NOT NULL").all()) listDate.set(r.code, r.list_date);
  return { dates, n, index, shares, navs, events, listDate };
}

/**
 * 独立实现的折算因子：把「date 当日的份额」换算到「最新份额单位」。
 * 与 lib/metrics.mjs::makeSplitAdjuster 语义一致（乘上 date 之后所有事件的 ratio）。
 */
export function adjustFactor(ctx, code, date) {
  const list = ctx.events.get(code);
  if (!list || !list.length) return 1;
  const d = new Date(date + "T00:00:00Z").getTime();
  let f = 1;
  for (const e of list) {
    if (new Date(e.date + "T00:00:00Z").getTime() > d && e.ratio > 0) f *= e.ratio;
  }
  return f;
}

export const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
export const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
export const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
