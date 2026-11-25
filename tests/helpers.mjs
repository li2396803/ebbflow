// 测试用公共工具：临时库、构造份额快照
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../lib/db.mjs";
import { ALL_CODES, SUB } from "../lib/taxonomy.mjs";

const TMP_BASE = path.join(os.tmpdir(), "ebbflow-tests");

/** 建一个临时 DB（不碰 data/etf.db），返回 {db, file, cleanup} */
export function tmpDb(tag = "t") {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const file = path.join(TMP_BASE, `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`);
  const db = openDb(file);
  const cleanup = () => {
    try {
      db.close();
    } catch {}
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
  };
  return { db, file, cleanup };
}

/** 全部 773 只标的都给同一个值 */
export function flatShares(wan = 1000) {
  const m = new Map();
  for (const c of ALL_CODES) m.set(c, wan);
  return m;
}

/** 某小类的全部成分代码 */
export function subCodes(sub) {
  return SUB[sub].etfs.map((e) => e.code);
}

/** 造一批基金名录行（默认按代码前缀定市场，名称带 ETF 才会被「全市场」统计） */
export function seedFunds(db, codes, { etf = true } = {}) {
  const put = db.prepare("INSERT OR REPLACE INTO fund(code,name,type,market) VALUES(?,?,?,?)");
  db.exec("BEGIN");
  try {
    for (const code of codes) put.run(code, etf ? `测试${code}ETF` : `测试${code}`, "股票型", /^[56]/.test(code) ? "SH" : "SZ");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 直接把一天的数据写进 share 表（绕过优先级，用于构造测试场景） */
export function seedShareRows(db, date, rows) {
  const put = db.prepare(
    "INSERT INTO share(code,date,wan,src) VALUES(?,?,?,?) ON CONFLICT(code,date) DO UPDATE SET wan=excluded.wan, src=excluded.src"
  );
  db.exec("BEGIN");
  try {
    for (const [code, wan, src] of rows) put.run(code, date, wan, src || "sse");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 生成连续日期（跳过周末，和 candidateDates 同规则） */
export function weekdays(from, n) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** 造一个「覆盖 N 只沪市 + M 只深市」的交易日，并可指定当天的来源标记 */
export function seedDay(db, date, { sh, sz, src = "sse", flags = { sse: true }, value = 100 } = {}) {
  const rows = [];
  for (let i = 0; i < sh; i++) rows.push([String(510000 + i), value, src]);
  for (let i = 0; i < sz; i++) rows.push([String(159000 + i), value, src === "sse" ? "ts" : src]);
  seedShareRows(db, date, rows);
  seedFunds(db, rows.map((r) => r[0]));
  const putInfo = db.prepare(
    "INSERT INTO dayinfo(date,has_sse,has_szse,has_ts) VALUES(?,?,?,?) ON CONFLICT(date) DO UPDATE SET has_sse=excluded.has_sse, has_szse=excluded.has_szse, has_ts=excluded.has_ts"
  );
  putInfo.run(date, flags.sse ? 1 : 0, flags.szse ? 1 : 0, flags.ts ? 1 : 0);
  return rows.length;
}

/** 写入净值行：[[code, nav], ...] */
export function seedNavRows(db, date, rows) {
  const put = db.prepare("INSERT INTO nav(code,date,nav) VALUES(?,?,?) ON CONFLICT(code,date) DO UPDATE SET nav=excluded.nav");
  db.exec("BEGIN");
  try {
    for (const [code, nav] of rows) put.run(code, date, nav);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 写入份额折算事件：[{code,date,kind,ratio}] */
export function seedEvents(db, rows) {
  const put = db.prepare("INSERT INTO event(code,date,kind,ratio) VALUES(?,?,?,?) ON CONFLICT(code,date,kind) DO UPDATE SET ratio=excluded.ratio");
  db.exec("BEGIN");
  try {
    for (const r of rows) put.run(r.code, r.date, r.kind ?? "split", r.ratio);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 设置上市日期：{code: 'YYYY-MM-DD'} */
export function seedListDates(db, map) {
  const upd = db.prepare("UPDATE fund SET list_date=? WHERE code=?");
  db.exec("BEGIN");
  try {
    for (const [code, d] of Object.entries(map)) upd.run(d, code);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 造一个小宇宙：{ 小类名: {cat, codes:[]} } → universe */
export function mkUniverse(spec) {
  const SUB = {};
  for (const [name, v] of Object.entries(spec)) {
    SUB[name] = { cat: v.cat ?? "1_宽基市场", color: v.color ?? "#000000", etfs: v.codes.map((code) => ({ code })) };
  }
  const CATS = Object.keys(spec).length ? [{ key: "1_宽基市场", label: "1.测试", color: "#000000", subs: Object.keys(SUB) }] : [];
  return { CATS, SUB };
}

/** 直接查 series 表：Map<'sub|date', {val,scale,flow,coverage}> */
export function readSeries(db, table = "series") {
  const out = new Map();
  for (const r of db.prepare(`SELECT sub,date,val,scale,flow,coverage FROM ${table}`).all()) out.set(`${r.sub}|${r.date}`, r);
  return out;
}
