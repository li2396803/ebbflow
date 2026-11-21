// SQLite 存储层（node:sqlite，零依赖）
//
//   fund      场内基金名录
//   share     (code,date) → 份额（万份）+ 来源；同一代码同日只保留优先级最高的来源
//   series    (sub,date)  → 细分行业派生值（亿份，4 位小数）
//   reconcile 多源交叉校验结果
//   run       每次抓取/重算的运行记录
//
// 优先级：交易所（sse；szse 为历史遗留）= 1 > tushare = 2。
// 交易所是官方披露口径；深市自 v3 起没有交易所历史数据，由 Tushare 提供。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DB_FILE = path.join(ROOT, "data", "etf.db");
const SRC_PRIORITY = { sse: 1, szse: 1, ts: 2 };

export function openDb(file = DB_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS fund(code TEXT PRIMARY KEY, name TEXT, type TEXT, market TEXT);
    CREATE TABLE IF NOT EXISTS share(
      code TEXT NOT NULL, date TEXT NOT NULL, wan REAL NOT NULL, src TEXT NOT NULL,
      PRIMARY KEY(code, date)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_share_date ON share(date);
    CREATE TABLE IF NOT EXISTS series(
      sub TEXT NOT NULL, date TEXT NOT NULL, val REAL,
      PRIMARY KEY(sub, date)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS nav(
      code TEXT NOT NULL, date TEXT NOT NULL, nav REAL,
      PRIMARY KEY(code, date)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS reconcile(
      date TEXT NOT NULL, sub TEXT NOT NULL, code TEXT, a REAL, b REAL, note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reconcile_date ON reconcile(date);
    CREATE TABLE IF NOT EXISTS dayinfo(
      date TEXT PRIMARY KEY, has_sse INTEGER DEFAULT 0, has_szse INTEGER DEFAULT 0, has_ts INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS run(
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT, ok INTEGER, stats TEXT, err TEXT
    );
  `);
  // 演进式迁移（幂等）
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  if (!cols("series").includes("scale")) db.exec("ALTER TABLE series ADD COLUMN scale REAL");
  if (!cols("series").includes("flow")) db.exec("ALTER TABLE series ADD COLUMN flow REAL");
  if (!cols("fund").includes("list_date")) db.exec("ALTER TABLE fund ADD COLUMN list_date TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS quote(
      code TEXT NOT NULL, date TEXT NOT NULL,
      close REAL, pct_chg REAL, vol REAL, amount REAL,
      PRIMARY KEY(code, date)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS event(
      code TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, ratio REAL,
      PRIMARY KEY(code, date, kind)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS series_v2(
      sub TEXT NOT NULL, date TEXT NOT NULL, val REAL, scale REAL, flow REAL,
      PRIMARY KEY(sub, date)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS market(
      date TEXT NOT NULL, scope TEXT NOT NULL, shares REAL, scale REAL, etfs INTEGER,
      PRIMARY KEY(date, scope)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS market_type(
      date TEXT NOT NULL, type TEXT NOT NULL, shares REAL, scale REAL, etfs INTEGER,
      PRIMARY KEY(date, type)
    ) WITHOUT ROWID;
  `);
  return db;
}

const PRIO = (src) => SRC_PRIORITY[src] ?? 9;

/** 批量写入单只基金的整段历史（无逐行 SELECT，比 putShares 快一个数量级） */
export function putSharesBulk(db, code, dateWanMap, src = "ts") {
  const put = db.prepare(
    `INSERT INTO share(code,date,wan,src) VALUES(?,?,?,?)
     ON CONFLICT(code,date) DO UPDATE SET wan=excluded.wan, src=excluded.src
     WHERE (CASE excluded.src WHEN 'sse' THEN 1 WHEN 'szse' THEN 1 ELSE 2 END)
        <= (CASE share.src  WHEN 'sse' THEN 1 WHEN 'szse' THEN 1 ELSE 2 END)`
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const [date, wan] of dateWanMap) {
      if (wan == null || !Number.isFinite(wan) || wan <= 0) continue;
      put.run(code, date, wan, src);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

/** 写入某交易日的份额；返回实际写入/更新的条数 */
export function putShares(db, date, entries) {
  const get = db.prepare("SELECT src FROM share WHERE code=? AND date=?");
  const put = db.prepare(
    "INSERT INTO share(code,date,wan,src) VALUES(?,?,?,?) ON CONFLICT(code,date) DO UPDATE SET wan=excluded.wan, src=excluded.src"
  );
  let n = 0;
  const tx = () => {
    for (const [code, raw] of Object.entries(entries)) {
      const isObj = raw != null && typeof raw === "object";
      const val = isObj ? raw.wan : raw;
      const src = isObj ? raw.src : entries.__src || "ts";
      if (val == null || !Number.isFinite(val)) continue;
      const prev = get.get(code, date);
      const prevPrio = prev ? PRIO(prev.src) : 99;
      if (PRIO(src) > prevPrio) continue; // 已有更高优先级来源
      if (prev && Math.abs(prevPrio - PRIO(src)) < 1e-9) {
        // 同优先级：更新数值（同一来源重抓）
      }
      put.run(code, date, val, src);
      n++;
    }
  };
  db.exec("BEGIN");
  try {
    tx();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

/** 标记某交易日有哪些来源的快照（决定合并口径） */
export function markDaySource(db, date, src) {
  const col = src === "sse" ? "has_sse" : src === "szse" ? "has_szse" : "has_ts";
  db.prepare(
    `INSERT INTO dayinfo(date,${col}) VALUES(?,1)
     ON CONFLICT(date) DO UPDATE SET ${col}=1`
  ).run(date);
}

export function daySources(db, date) {
  const r = db.prepare("SELECT has_sse, has_szse, has_ts FROM dayinfo WHERE date=?").get(date);
  return r ? { sse: !!r.has_sse, szse: !!r.has_szse, ts: !!r.has_ts } : { sse: false, szse: false, ts: false };
}

/** 真正的交易日：以交易所（上交所）当日有快照为准，天然排除 Tushare 的季末/月末非交易日披露 */
export function tradingDates(db) {
  return db.prepare("SELECT date FROM dayinfo WHERE has_sse=1 ORDER BY date").all().map((r) => r.date);
}

export function allDates(db) {
  return db.prepare("SELECT DISTINCT date FROM share ORDER BY date").all().map((r) => r.date);
}

export function shareMap(db, date) {
  const out = new Map();
  for (const r of db.prepare("SELECT code, wan FROM share WHERE date=?").all(date)) out.set(r.code, r.wan);
  return out;
}

export function shareRows(db, date) {
  return db.prepare("SELECT code, wan, src FROM share WHERE date=?").all(date);
}

/** 某代码的份额历史：Map<date, 万份> */
export function historyOf(db, code) {
  const out = new Map();
  for (const r of db.prepare("SELECT date, wan FROM share WHERE code=? ORDER BY date").all(code)) out.set(r.date, r.wan);
  return out;
}

/** 写入净值（元/份） */
export function putNav(db, rows) {
  const put = db.prepare(
    "INSERT INTO nav(code,date,nav) VALUES(?,?,?) ON CONFLICT(code,date) DO UPDATE SET nav=excluded.nav"
  );
  db.exec("BEGIN");
  try {
    for (const [code, date, nav] of rows) put.run(code, date, nav);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 某日净值：Map<code, nav> */
export function navMap(db, date) {
  const out = new Map();
  for (const r of db.prepare("SELECT code, nav FROM nav WHERE date=?").all(date)) out.set(r.code, r.nav);
  return out;
}

export function navDates(db) {
  return db.prepare("SELECT COUNT(DISTINCT date) n FROM nav").get().n;
}

export function putSeries(db, rows) {
  const put = db.prepare(
    "INSERT INTO series(sub,date,val,scale,flow) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(sub,date) DO UPDATE SET val=excluded.val, scale=excluded.scale, flow=excluded.flow"
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const [sub, date, val] = r;
      put.run(sub, date, val, r[3] ?? null, r[4] ?? null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function putMarket(db, rows) {
  const put = db.prepare(
    "INSERT INTO market(date,scope,shares,scale,etfs) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(date,scope) DO UPDATE SET shares=excluded.shares, scale=excluded.scale, etfs=excluded.etfs"
  );
  db.exec("BEGIN");
  try {
    for (const [date, scope, shares, scale, etfs] of rows) put.run(date, scope, shares, scale, etfs);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function putMarketType(db, rows) {
  const put = db.prepare(
    "INSERT INTO market_type(date,type,shares,scale,etfs) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(date,type) DO UPDATE SET shares=excluded.shares, scale=excluded.scale, etfs=excluded.etfs"
  );
  db.exec("BEGIN");
  try {
    for (const [date, type, shares, scale, etfs] of rows) put.run(date, type, shares, scale, etfs);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function navOf(db, code) {
  const out = new Map();
  for (const r of db.prepare("SELECT date, nav FROM nav WHERE code=?").all(code)) out.set(r.date, r.nav);
  return out;
}

/** 写入 v2 口径的序列（与 series 分开存，避免两套分类互相覆盖） */
export function putSeriesV2(db, rows) {
  const put = db.prepare(
    "INSERT INTO series_v2(sub,date,val,scale,flow) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(sub,date) DO UPDATE SET val=excluded.val, scale=excluded.scale, flow=excluded.flow"
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) put.run(r[0], r[1], r[2] ?? null, r[3] ?? null, r[4] ?? null);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 份额拆分/合并等事件（用于修正净流入、给前端打标） */
export function putEvents(db, rows) {
  const put = db.prepare(
    "INSERT INTO event(code,date,kind,ratio) VALUES(?,?,?,?) ON CONFLICT(code,date,kind) DO UPDATE SET ratio=excluded.ratio"
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) put.run(r.code, r.date, r.kind, r.ratio ?? null);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function eventsOf(db, { from, to } = {}) {
  if (from && to) return db.prepare("SELECT code,date,kind,ratio FROM event WHERE date BETWEEN ? AND ? ORDER BY date").all(from, to);
  return db.prepare("SELECT code,date,kind,ratio FROM event ORDER BY date").all();
}

export function seriesV2Of(db, sub) {
  return db.prepare("SELECT date, val, scale, flow FROM series_v2 WHERE sub=? ORDER BY date").all(sub);
}

export function seriesOf(db, sub) {
  return db.prepare("SELECT date, val FROM series WHERE sub=? ORDER BY date").all(sub);
}

export function metaSet(db, k, v) {
  db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, JSON.stringify(v));
}
export function metaGet(db, k, dflt = null) {
  const r = db.prepare("SELECT v FROM meta WHERE k=?").get(k);
  return r ? JSON.parse(r.v) : dflt;
}

export function recordRun(db, { at, kind, ok, stats, err }) {
  db.prepare("INSERT INTO run(at,kind,ok,stats,err) VALUES(?,?,?,?,?)").run(
    at, kind ?? null, ok ? 1 : 0, stats ? JSON.stringify(stats) : null, err ?? null
  );
}

export function lastRun(db) {
  return db.prepare("SELECT * FROM run ORDER BY id DESC LIMIT 1").get() ?? null;
}

export function upsertFunds(db, funds) {
  const put = db.prepare(
    "INSERT INTO fund(code,name,type,market,list_date) VALUES(?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, type=excluded.type, market=excluded.market, list_date=COALESCE(excluded.list_date, fund.list_date)"
  );
  db.exec("BEGIN");
  try {
    for (const f of funds) {
      const d = f.list_date ? `${String(f.list_date).slice(0, 4)}-${String(f.list_date).slice(4, 6)}-${String(f.list_date).slice(6, 8)}` : null;
      put.run(f.code, f.name, f.type ?? null, f.code.startsWith("5") || f.code.startsWith("6") ? "SH" : "SZ", d);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function dbStats(db) {
  const one = (sql) => db.prepare(sql).get()?.n ?? 0;
  return {
    funds: one("SELECT COUNT(*) n FROM fund"),
    codes: one("SELECT COUNT(DISTINCT code) n FROM share"),
    days: one("SELECT COUNT(DISTINCT date) n FROM share"),
    rows: one("SELECT COUNT(*) n FROM share"),
    series: one("SELECT COUNT(*) n FROM series"),
    navRows: one("SELECT COUNT(*) n FROM nav"),
    marketDays: one("SELECT COUNT(DISTINCT date) n FROM market"),
    from: db.prepare("SELECT MIN(date) d FROM share").get()?.d ?? null,
    to: db.prepare("SELECT MAX(date) d FROM share").get()?.d ?? null,
  };
}

export function clearAllSourceFlags(db) {
  db.exec("UPDATE dayinfo SET has_sse=0, has_szse=0, has_ts=0");
}

export function clearReconcile(db) {
  db.exec("DELETE FROM reconcile");
}
export function putReconcile(db, rows) {
  const put = db.prepare("INSERT INTO reconcile(date,sub,code,a,b,note) VALUES(?,?,?,?,?,?)");
  db.exec("BEGIN");
  try {
    for (const r of rows) put.run(r.date, r.sub, r.code ?? null, r.a ?? null, r.b ?? null, r.note ?? null);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}


/** 行情（收盘价/成交额/成交量/涨跌幅）：用于折溢价、成交额、换手率 */
export function putQuotes(db, rows) {
  const put = db.prepare(
    "INSERT INTO quote(code,date,close,pct_chg,vol,amount) VALUES(?,?,?,?,?,?) " +
      "ON CONFLICT(code,date) DO UPDATE SET close=excluded.close, pct_chg=excluded.pct_chg, vol=excluded.vol, amount=excluded.amount"
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) put.run(r.code, r.date, r.close ?? null, r.pct_chg ?? null, r.vol ?? null, r.amount ?? null);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function quoteMap(db, date) {
  return new Map(db.prepare("SELECT code, close, pct_chg, vol, amount FROM quote WHERE date=?").all(date).map((r) => [r.code, r]));
}

export function quoteDates(db) {
  return db.prepare("SELECT DISTINCT date FROM quote ORDER BY date").all().map((r) => r.date);
}
