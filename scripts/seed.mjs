// 首次播种：从原站已发布的 charts/*.js 取回 5 年历史（沪深两市齐全），作为本地序列基线
import fs from "node:fs";
import path from "node:path";
import { parseChunk } from "../tools/parse-chunks.mjs";
import { writeC3Seed } from "../tools/make-c3-seed.mjs";
import { CATS } from "../lib/taxonomy.mjs";
import { loadSeries, saveSeries, ensureSubs, normalize } from "../lib/store.mjs";

const dir = process.argv[2] || "tools/original-charts"; // 原站副本，不是自己生成的 site/charts
const store = loadSeries();
ensureSubs(store, Object.values(CATS).flatMap((c) => c.subs));
const bySub = new Map();
let dates = null;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
  const D = parseChunk(path.join(dir, f));
  const key = Object.keys(D)[0];
  const c1 = D[key].c1;
  dates ??= c1.dates;
  if (c1.dates.length !== dates.length) throw new Error("日期长度不一致 " + key);
  for (const s of c1.series) bySub.set(s.name, s.values);
}
if (!dates) throw new Error("没有找到图表数据");
store.dates = [...dates];
for (const [name, values] of bySub) store.subs[name] = [...values];
store.meta.seededAt = new Date().toISOString();
store.meta.seedSource = "etf-flow-d0j.pages.dev/charts/*.js";
saveSeries(normalize(store));
writeC3Seed(dir, "data/c3-seed.json");
console.log(`播种完成：${store.dates.length} 个交易日 (${store.dates[0]} → ${store.dates.at(-1)})，${Object.keys(store.subs).length} 个细分行业`);
