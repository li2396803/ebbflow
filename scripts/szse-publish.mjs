// 在国内网络下抓深交所快照，落成小文件供云端使用（云端 runner 在境外，被 szse.cn 拦截）。
// 用法：node scripts/szse-publish.mjs [YYYY-MM-DD]   （省略则抓最新报告日；给日期则走历史接口）
import fs from "node:fs";
import path from "node:path";
import { fetchSzseSnapshot, fetchSzseHistory } from "../lib/sources.mjs";
import { projectRoot, isMain } from "../lib/cli.mjs";

const ROOT = projectRoot(import.meta.url);
const DIR = path.join(ROOT, "data", "szse");

/** 抓某日（或不传则最新）的深市份额，写入 data/szse/<date>.json */
export async function publishSzse(date) {
  // 先试快照（当天/最新报告日），日期不匹配再走历史接口（历史接口当天往往还没数据）
  let r = null;
  try {
    const snap = await fetchSzseSnapshot();
    if (!date || snap.date === date) r = snap;
  } catch {}
  if (!r && date) r = await fetchSzseHistory(date);
  if (!r || !Object.keys(r.shares || {}).length) throw new Error("深交所未返回数据");
  const out = { date: r.date, count: Object.keys(r.shares).length, shares: r.shares };
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${out.date}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  return { file, date: out.date, count: out.count };
}

/** 读取并清理过期文件（保留最近 N 天） */
export function loadSzseFeeds(keep = 10) {
  const map = new Map();
  try {
    const files = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
        if (j?.date && j?.shares) map.set(j.date, j.shares);
      } catch {}
    }
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      if (map.has(f.replace(".json", ""))) continue; // 刚读到的保留
    }
  } catch {}
  return map;
}

if (isMain(import.meta.url)) {
  const arg = process.argv[2];
  const r = await publishSzse(arg);
  console.log(`已发布深交所快照：${r.date}，${r.count} 只 → ${path.relative(ROOT, r.file)}`);
}
