// 增量更新：抓取最新交易日 → 落盘原始快照 → 计算各细分行业 → 重新生成站点
//
// 口径（与原站一致）：
//   每个细分行业 = 其包含全部 ETF 当日份额之和（万份 → 亿份）
//   大类「9.债券」份额 ×100（债券 ETF 面值 100 元，原站即按此折算）
//
// 深交所只发布“最新交易日”快照、没有历史接口，因此：
//   · 某交易日只有在沪深两市数据齐全时才会被重算；
//   · 历史基线来自首次播种（原站已发布的 5 年序列），不会被只有沪市的半份数据覆盖；
//   · 漏跑的日子用最近一次深交所快照做前值填充，并在快照文件里标记 estimated。
import fs from "node:fs";
import path from "node:path";
import { fetchSseDay, fetchSzseLatest, candidateDates, mapLimit } from "../lib/sources.mjs";
import { SUB, CATS } from "../lib/taxonomy.mjs";
import { computeDay } from "../lib/aggregate.mjs";
import { loadSeries, saveSeries, loadDayShares, saveDayShares, upsertDay, ensureSubs, ROOT } from "../lib/store.mjs";
import { buildSite, trimToFiveYears } from "../lib/build.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const SUB_NAMES = Object.keys(SUB);
const MARK = path.join(ROOT, "data", "last-run.json");
const merged = (day) => ({ ...(day?.sse || {}), ...(day?.szse || {}) });

function persist(date, market, shares, extra = {}) {
  const cur = loadDayShares(date) || {};
  const next = { ...cur, ...extra, [market]: { ...(cur[market] || {}), ...shares } };
  saveDayShares(date, next);
  return next;
}

const LOCK = path.join(ROOT, "data", ".update.lock");
function acquireLock() {
  try {
    fs.mkdirSync(LOCK);
    fs.writeFileSync(path.join(LOCK, "pid"), String(process.pid));
    return true;
  } catch {
    // 超时保护：锁超过 15 分钟视为残留
    try {
      const age = Date.now() - fs.statSync(LOCK).mtimeMs;
      if (age > 15 * 60 * 1000) {
        fs.rmSync(LOCK, { recursive: true, force: true });
        fs.mkdirSync(LOCK);
        return true;
      }
    } catch {}
    return false;
  }
}
const releaseLock = () => fs.rmSync(LOCK, { recursive: true, force: true });

export async function update({ quiet = false } = {}) {
  if (!acquireLock()) {
    if (!quiet) log("已有更新在进行中，跳过本次");
    return { skipped: true };
  }
  try {
    return await runUpdate({ quiet });
  } finally {
    releaseLock();
  }
}

async function runUpdate({ quiet = false } = {}) {
  const store = loadSeries();
  ensureSubs(store, SUB_NAMES);
  if (!store.dates.length) throw new Error("本地还没有数据，请先运行 npm run seed");

  const sz = await fetchSzseLatest();
  if (!quiet) log(`深交所 报告日 ${sz.date}，${Object.keys(sz.shares).length} 个标的`);
  persist(sz.date, "szse", sz.shares, { szseFetchedAt: new Date().toISOString() });
  const anchor = sz.date;

  const from = new Date(anchor + "T00:00:00Z");
  from.setUTCDate(from.getUTCDate() - 15);
  const cands = candidateDates(from.toISOString().slice(0, 10), anchor);

  await mapLimit(cands, 4, async (d) => {
    const day = loadDayShares(d) || {};
    if (day.sse) return { d };
    const r = await fetchSseDay(d);
    if (!r) return { d, skip: "非交易日" };
    persist(d, "sse", r.shares, { sseFetchedAt: new Date().toISOString() });
    return { d };
  });

  let recomputed = 0;
  const days = [...cands].sort();
  for (const d of days) {
    const day = loadDayShares(d);
    if (!day?.sse || !day?.szse) continue;
    upsertDay(store, d, computeDay(SUB_NAMES, merged(day)));
    recomputed++;
  }

  const latestSz = days.filter((d) => loadDayShares(d)?.szse).at(-1);
  if (latestSz) {
    const szShares = loadDayShares(latestSz).szse;
    for (const d of days) {
      const idx = store.dates.indexOf(d);
      const has = idx >= 0 && store.subs[SUB_NAMES[0]][idx] != null;
      if (has) continue;
      const day = loadDayShares(d);
      if (!day?.sse) continue;
      persist(d, "szse", szShares, { estimated: true });
      upsertDay(store, d, computeDay(SUB_NAMES, merged(loadDayShares(d))));
      if (!quiet) log(`⚠ ${d} 深交所数据缺失，已用 ${latestSz} 快照近似填充`);
    }
  }

  trimToFiveYears(store);
  saveSeries(store);
  const info = buildSite(store);
  const last = store.dates.at(-1);
  fs.writeFileSync(MARK, JSON.stringify({ lastRunAt: new Date().toISOString(), latestTradeDate: last, recomputed, ...info }));
  if (!quiet) log(`完成：最新交易日 ${last}（本次重算 ${recomputed} 天），${info.dates} 个交易日 / ${CATS.length} 个大类`);
  return { last, recomputed, ...info };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  update().catch((e) => {
    console.error("更新失败:", e);
    process.exit(1);
  });
}
