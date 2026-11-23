// 记录两家交易所「何时能看到某个交易日的数据」，用于摸清真实发布时间（尤其周五 → 周一）。
// 每次运行只追加一行，写入 data/publish-log.json（随数据一起提交）。
import fs from "node:fs";
import path from "node:path";
import { fetchSseDay, fetchSzseSnapshot, candidateDates } from "../lib/sources.mjs";
import { projectRoot, isMain } from "../lib/cli.mjs";

const ROOT = projectRoot(import.meta.url);
const LOG = path.join(ROOT, "data", "publish-log.json");

function readLog() {
  try {
    const j = JSON.parse(fs.readFileSync(LOG, "utf8"));
    return Array.isArray(j.probes) ? j : { probes: [] };
  } catch {
    return { probes: [] };
  }
}

/** @returns {Promise<object>} 本次探测结果 */
export async function probeOnce(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const days = candidateDates(
    new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10),
    today
  );
  const sse = {};
  for (const d of days) {
    try {
      const r = await fetchSseDay(d);
      sse[d] = r ? Object.keys(r.shares).length : 0;
    } catch {
      sse[d] = -1;
    }
  }
  let szse = { date: null, count: 0 };
  try {
    const z = await fetchSzseSnapshot();
    szse = { date: z.date, count: Object.keys(z.shares).length };
  } catch {}
  const at = now.toISOString().replace("T", " ").slice(0, 19) + "Z";
  return { at, sse, szse };
}

if (isMain(import.meta.url)) {
  const entry = await probeOnce();
  const log = readLog();
  log.probes.push(entry);
  // 只保留最近 400 条，避免文件无限增长
  if (log.probes.length > 400) log.probes = log.probes.slice(-400);
  fs.writeFileSync(LOG, JSON.stringify(log) + "\n");
  console.log("已记录：", entry.at, "| 深交所报告日", entry.szse.date, entry.szse.count, "只");
  const days = Object.keys(entry.sse);
  console.log("上交所可用天数：", days.map((d) => `${d.slice(5)}=${entry.sse[d]}`).join(" "));
}
