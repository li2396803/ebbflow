#!/usr/bin/env node
// 重算历史归档（site/data/archive、site/data/legacy/archive）
//
// 背景：archive 快照是「每天构建时的轻量看板」，字段里含 cats.flow / cats.pct。
// 口径修正（v4.0.1：净申购折算乘数、区间不含期初）后，旧快照里的 flow/pct 已经过时；
// 而 `npm run build` 只会重写「最新交易日」那一份，历史文件不会自动更新。
//
//   node scripts/rebuild-archive.mjs [--days 120]
//
// 只读数据库，重写两套归档目录（v2 与 legacy），并清理超出保留期的文件。
import fs from "node:fs";
import path from "node:path";
import { openDb, tradingDates } from "../lib/db.mjs";
import { loadUniverse } from "../lib/universe.mjs";
import { loadStore, buildTables } from "../lib/payloads.mjs";
import { projectRoot } from "../lib/cli.mjs";

const ROOT = projectRoot(import.meta.url);
const KEEP = (() => {
  const i = process.argv.indexOf("--days");
  return i > 0 ? Math.max(1, Number(process.argv[i + 1]) || 120) : 120;
})();

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** 重算一棵口径树的归档；返回写入条数 */
function rebuildTree(db, { taxonomy, dir }) {
  const U = loadUniverse({ taxonomy });
  const store = loadStore(db, { universe: U, table: taxonomy === "v2" ? "series_v2" : "series" });
  const dates = store.dates;
  if (!dates.length) return { written: 0, kept: 0 };
  const start = Math.max(0, dates.length - KEEP);
  const etfs = new Set(Object.values(U.SUB).flatMap((m) => m.etfs.map((e) => e.code)));
  const counts = { subs: Object.keys(U.SUB).length, cats: U.CATS.length, etfs: etfs.size };
  const categories = U.CATS.map((c) => ({ key: c.key, label: c.label, color: c.color, subs: c.subs.length }));
  const mkt = new Map(
    db
      .prepare("SELECT date, scope, shares, scale FROM market")
      .all()
      .map((r) => [`${r.date}|${r.scope}`, r])
  );
  const typeStmt = db.prepare("SELECT type, shares, scale, etfs FROM market_type WHERE date=? ORDER BY scale DESC");

  const keep = new Set();
  let written = 0;
  for (let i = start; i < dates.length; i++) {
    const d = dates[i];
    // 只把「当天为止」的窗口交给 buildTables，得到与当天构建一致的排行
    const sliced = { dates: dates.slice(0, i + 1), subs: {} };
    for (const [name, s] of Object.entries(store.subs)) {
      sliced.subs[name] = {
        shares: s.shares.slice(0, i + 1),
        scale: s.scale.slice(0, i + 1),
        flow: s.flow.slice(0, i + 1),
        coverage: s.coverage.slice(0, i + 1),
      };
    }
    const tables = buildTables(sliced, U);
    const total = mkt.get(`${d}|ALL`);
    const snap = {
      date: d,
      taxonomy,
      counts,
      categories,
      cats: tables.cats,
      market: total
        ? {
            date: d,
            total: { shares: total.shares, scale: total.scale },
            byType: typeStmt.all(d).map((r) => ({ type: r.type, shares: r.shares, scale: r.scale, etfs: r.etfs })),
          }
        : null,
    };
    const name = `${d}.json`;
    keep.add(name);
    writeAtomic(path.join(dir, name), JSON.stringify(snap));
    written++;
  }
  // 清理过期/多余文件
  let removed = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && !keep.has(f)) {
        fs.rmSync(path.join(dir, f), { force: true });
        removed++;
      }
    }
  }
  return { written, removed, from: dates[start], to: dates.at(-1) };
}

const db = openDb();
try {
  const v2 = rebuildTree(db, { taxonomy: "v2", dir: path.join(ROOT, "site", "data", "archive") });
  const legacy = rebuildTree(db, { taxonomy: "legacy", dir: path.join(ROOT, "site", "data", "legacy", "archive") });
  console.log(`归档重算：v2 ${JSON.stringify(v2)}`);
  console.log(`归档重算：legacy ${JSON.stringify(legacy)}`);
} finally {
  db.close();
}
