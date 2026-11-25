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
    -- 本地与 CI 可能同时写（两个进程/两个终端）：WAL 允许单写多读，写冲突时等 5s 而不是立刻 SQLITE_BUSY
    PRAGMA busy_timeout = 5000;
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
  if (!cols("fund").includes("name_src")) db.exec("ALTER TABLE fund ADD COLUMN name_src TEXT");
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
  // v4.0.0：小类每日覆盖率（0..1），与聚合口径同源（含孤立披露剔除 / 官方口径过滤）
  if (!cols("series").includes("coverage")) db.exec("ALTER TABLE series ADD COLUMN coverage REAL");
  if (!cols("series_v2").includes("coverage")) db.exec("ALTER TABLE series_v2 ADD COLUMN coverage REAL");
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

/* ------------------------- 覆盖度 / 交易日轴 ------------------------- */

const MKT_EXPR = `COALESCE(f.market, CASE WHEN substr(s.code,1,1) IN ('5','6') THEN 'SH' ELSE 'SZ' END)`;

/**
 * 按日统计「有份额的标的只数」（分市场），用于覆盖度闸门。
 * `etfOnly:true` 时与 `market.etfs` 同一集合（名录里名称/类型含 ETF 的代码）。
 * @param {object} db
 * @param {{from?:string,to?:string,etfOnly?:boolean}} [opts]
 * @returns {Map<string,{sh:number,sz:number}>} 两市各自「有份额」的标的只数
 */
export function dayCoverage(db, { from, to, etfOnly = false } = {}) {
  const where = [];
  const args = [];
  if (from) {
    where.push("s.date >= ?");
    args.push(from);
  }
  if (to) {
    where.push("s.date <= ?");
    args.push(to);
  }
  // 不联表时用代码前缀判市场（与 fund.market 的写入规则一致），比 LEFT JOIN 快 3 倍以上。
  // 注意：只做「总数」一个聚合。实测在 125 万行的 share 表上，每多一个聚合列就要 +1.7s
  // （SQLite 需要按行读 src 文本），所以「官方行只数」不在这里算 —— 由调用方按需（少量日期）统计。
  const mkt = etfOnly ? MKT_EXPR : `CASE WHEN substr(s.code,1,1) IN ('5','6') THEN 'SH' ELSE 'SZ' END`;
  const join = etfOnly
    ? "JOIN fund f ON f.code=s.code AND (f.name LIKE '%ETF%' OR f.type LIKE '%ETF%')"
    : "";
  const sql =
    `SELECT s.date AS date,` +
    ` SUM(CASE WHEN ${mkt}='SH' THEN 1 ELSE 0 END) AS sh,` +
    ` COUNT(*) AS n` +
    ` FROM share s ${join}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` GROUP BY s.date`;
  const out = new Map();
  for (const r of db.prepare(sql).all(...args)) {
    const sh = r.sh ?? 0;
    out.set(r.date, { sh, sz: (r.n ?? 0) - sh });
  }
  return out;
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/**
 * 覆盖度区间判定（纯函数，可单测）：
 * 相对「最近 window 个已接受交易日的覆盖中位数」判断，**不写死绝对只数**。
 * 这样 2021 年只有 300 只 ETF 时不会误判，2026 年 950 只时也不会放过「只剩 300 只」的残缺日。
 *
 * @param {Array<{date:string, sh:number, sz:number}>} records 按日期升序
 * @param {{window?:number,minRatio?:number,maxRatio?:number,minWindow?:number}} [opts]
 * @returns {Map<string,{ok:boolean,reasons:string[],sh:number,sz:number,medSh:number|null,medSz:number|null,ratioSh:number|null,ratioSz:number|null}>}
 */
export function coverageBand(records, opts = {}) {
  const window = opts.window ?? 20;
  const minRatio = opts.minRatio ?? 0.6;
  const maxRatio = opts.maxRatio ?? 2;
  const minWindow = opts.minWindow ?? 5;
  const out = new Map();
  const accepted = [];
  for (const r of records) {
    const hist = accepted.slice(-window);
    const medSh = median(hist.map((h) => h.sh));
    const medSz = median(hist.map((h) => h.sz));
    const reasons = [];
    let ok = true;
    const judge = (cur, med, label) => {
      // 该市场历史中位数为 0（早期还没有深市数据）→ 不做相对判断
      if (med == null || med <= 0) return null;
      const ratio = cur / med;
      if (ratio < minRatio) {
        ok = false;
        reasons.push(`${label}_low`);
      } else if (ratio > maxRatio) {
        ok = false;
        reasons.push(`${label}_high`);
      }
      return ratio;
    };
    let ratioSh = null;
    let ratioSz = null;
    if (hist.length >= minWindow) {
      ratioSh = judge(r.sh, medSh, "sh");
      ratioSz = judge(r.sz, medSz, "sz");
    }
    const rec = { ok, reasons, sh: r.sh, sz: r.sz, medSh, medSz, ratioSh, ratioSz };
    out.set(r.date, rec);
    if (ok) accepted.push(r);
  }
  return out;
}

/**
 * 交易日轴诊断：既给出最终轴，也给出被排除的日期与原因（便于告警/审计）。
 *
 * 规则：
 *   1. 沪市官方快照到位（`dayinfo.has_sse=1`）→ 候选
 *   2. 沪市缺失但 Tushare 全量覆盖（有行情 + 只数达阈值）→ 候选（接口坏了也不冻结时间轴）
 *   3. 候选日还要过覆盖度闸门：只数相对近 N 个已接受交易日的中位数要在 [minRatio, maxRatio] 内；
 *      不满足 → 不进轴（数据残缺，宁缺毋滥）并给出原因，由调用方告警 + 尝试修复
 * 窗口不足（历史开头 < minWindow 天）时退化为 `minTsCodes` 绝对阈值，避免冷启动误杀。
 *
 * @param {object} db
 * @param {{minTsCodes?:number,window?:number,minRatio?:number,maxRatio?:number,minWindow?:number}} [opts]
 * @returns {{dates:string[], excluded:Array<{date:string,reason:string,sh?:number,sz?:number,medSh?:number|null,medSz?:number|null}>}}
 */
export function axisDiagnostics(db, opts = {}) {
  const minTsCodes = opts.minTsCodes ?? 800;
  const rows = db
    .prepare("SELECT date, has_sse, has_szse, has_ts FROM dayinfo WHERE has_sse=1 OR has_szse=1 OR has_ts=1 ORDER BY date")
    .all();
  if (!rows.length) return { dates: [], excluded: [] };
  const cov = dayCoverage(db);
  const quoteDates = new Set(db.prepare("SELECT DISTINCT date FROM quote").all().map((r) => r.date));
  // 净值覆盖：没有净值的日子算不出规模/净申购，进轴只会在图尾留一个断点
  const navCount = new Map(db.prepare("SELECT date, COUNT(*) n FROM nav GROUP BY date").all().map((r) => [r.date, r.n]));

  const candidates = [];
  for (const r of rows) {
    const c = cov.get(r.date) ?? { sh: 0, sz: 0 };
    const total = c.sh + c.sz;
    let via = "none";
    if (r.has_sse) via = "sse";
    else if (r.has_ts && quoteDates.has(r.date) && total >= minTsCodes) via = "ts";
    else if (r.has_ts) via = "ts-thin";
    candidates.push({ date: r.date, sh: c.sh, sz: c.sz, via, nav: navCount.get(r.date) ?? 0 });
  }

  const band = coverageBand(
    candidates.map((c) => ({ date: c.date, sh: c.sh, sz: c.sz })),
    { window: opts.window, minRatio: opts.minRatio, maxRatio: opts.maxRatio, minWindow: opts.minWindow }
  );

  const dates = [];
  const excluded = [];
  for (const c of candidates) {
    if (c.via === "none") continue;
    if (c.via === "ts-thin") {
      excluded.push({ date: c.date, reason: "ts_thin", sh: c.sh, sz: c.sz });
      continue;
    }
    // 净值覆盖闸门：份额齐但净值没出齐的日子（常见于当天晚上），规模与净申购都是空，
    // 进轴只会让曲线尾部多一个断点——视为"还没出齐"，等下一次运行。
    // 只有该库存在净值数据时才启用净值闸门（测试夹具/冷启动库可能完全没有 nav）
    const needNav = Math.max(1, Math.round((c.sh + c.sz) * 0.5)); // 相对比例，不写死绝对数
    if (navCount.size > 0 && c.nav < needNav) {
      excluded.push({ date: c.date, reason: "nav_thin", sh: c.sh, sz: c.sz, nav: c.nav, needNav });
      continue;
    }
    const b = band.get(c.date);
    if (!b || b.ok) dates.push(c.date);
    else excluded.push({ date: c.date, reason: b.reasons.join("+"), sh: c.sh, sz: c.sz, medSh: b.medSh, medSz: b.medSz });
  }
  return { dates, excluded };
}

/**
 * 真正的交易日（规则见 axisDiagnostics）。
 * @param {object} db
 * @param {number} [minTsCodes] 走 Tushare 退路 / 窗口不足时要求的最少标的数
 */
export function tradingDates(db, minTsCodes = 800) {
  return axisDiagnostics(db, { minTsCodes }).dates;
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
    "INSERT INTO series(sub,date,val,scale,flow,coverage) VALUES(?,?,?,?,?,?) " +
      "ON CONFLICT(sub,date) DO UPDATE SET val=excluded.val, scale=excluded.scale, flow=excluded.flow, coverage=excluded.coverage"
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const [sub, date, val] = r;
      put.run(sub, date, val, r[3] ?? null, r[4] ?? null, r[5] ?? null);
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
    "INSERT INTO series_v2(sub,date,val,scale,flow,coverage) VALUES(?,?,?,?,?,?) " +
      "ON CONFLICT(sub,date) DO UPDATE SET val=excluded.val, scale=excluded.scale, flow=excluded.flow, coverage=excluded.coverage"
  );
  db.exec("BEGIN");
  try {
    for (const r of rows) put.run(r[0], r[1], r[2] ?? null, r[3] ?? null, r[4] ?? null, r[5] ?? null);
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
    "INSERT INTO fund(code,name,type,market,list_date,name_src) VALUES(?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET " +
      // 交易所给的名字优先（name_src='sse'/'szse'）；Tushare 只补空缺，或补上更完整的名字
      "name=CASE WHEN fund.name IS NULL OR fund.name='' OR fund.name_src IS NULL OR fund.name_src='ts' THEN excluded.name ELSE fund.name END, " +
      "name_src=CASE WHEN fund.name_src IN ('sse','szse') THEN fund.name_src ELSE excluded.name_src END, " +
      "type=excluded.type, market=excluded.market, list_date=COALESCE(excluded.list_date, fund.list_date)"
  );
  db.exec("BEGIN");
  try {
    for (const f of funds) {
      const d = f.list_date ? `${String(f.list_date).slice(0, 4)}-${String(f.list_date).slice(4, 6)}-${String(f.list_date).slice(6, 8)}` : null;
      put.run(f.code, f.name, f.type ?? null, f.code.startsWith("5") || f.code.startsWith("6") ? "SH" : "SZ", d, "ts");
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


/**
 * 用交易所披露的名称更新名录。
 * 交易所简称质量不一：深交所给的是「港股通金融ETF鹏华」这种可读名，
 * 上交所会压成「300ETF」「半导体」。所以加一道守卫：
 * 已有 Tushare 全称且明显更完整时保留全称，其余情况采用交易所名。
 * @param {Map<string,string>} names  code -> 交易所名称
 * @param {"sse"|"szse"} src
 * @returns {{updated:number, kept:number}}
 */
/**
 * 用交易所披露的名称**补空缺**（只填空值，不覆盖已有名称）。
 * 名录以 Tushare 那份为准；交易所名只用来覆盖「还没进名录」的新代码。
 * @param {Map<string,string>} names  code -> 交易所名称
 * @param {"sse"|"szse"} src
 * @returns {{filled:number}}
 */
export function fillFundNames(db, names, src) {
  const sel = db.prepare("SELECT name FROM fund WHERE code=?");
  const upd = db.prepare("UPDATE fund SET name=?, name_src=? WHERE code=? AND (name IS NULL OR name='')");
  const ins = db.prepare("INSERT INTO fund(code,name,market,name_src) VALUES(?,?,?,?)");
  let filled = 0;
  db.exec("BEGIN");
  try {
    for (const [code, raw] of names) {
      const name = String(raw ?? "").trim();
      if (!/^\d{6}$/.test(code) || !name) continue;
      const cur = sel.get(code);
      if (!cur) {
        ins.run(code, name, /^[569]/.test(code) ? "SH" : "SZ", src);
        filled++;
      } else if (!cur.name) {
        upd.run(name, src, code);
        filled++;
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { filled };
}
