// 只用本地数据重建站点（不联网）
// 冷启动：若本地还没 SQLite 缓存，用仓库自带的 data/series.json 引导出一个可展示的站点
import fs from "node:fs";
import path from "node:path";
import { openDb, dbStats, putSeries, metaSet } from "../lib/db.mjs";
import { buildSite } from "../lib/build/site.mjs";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const db = openDb();
let s = dbStats(db);

if (!s.series && fs.existsSync(path.join(ROOT, "data", "series.json"))) {
  const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "series.json"), "utf8"));
  const rows = [];
  for (const [sub, vals] of Object.entries(legacy.subs)) {
    for (let i = 0; i < legacy.dates.length; i++) if (vals[i] != null) rows.push([sub, legacy.dates[i], vals[i]]);
  }
  putSeries(db, rows);
  for (const d of legacy.dates) db.prepare("INSERT OR IGNORE INTO dayinfo(date, has_sse) VALUES(?, 1)").run(d);
  metaSet(db, "bootstrappedFrom", "data/series.json");
  console.log(`冷启动：已用 data/series.json 引导 ${rows.length} 条序列（${legacy.dates.length} 个交易日）`);
  s = dbStats(db);
}

if (!s.days && !s.series) {
  console.error("没有可用数据：请先运行 npm run update（联网抓取）或 npm run backfill（全量回补）");
  process.exit(1);
}
const info = buildSite(db);
console.log("站点已重建：", info);
