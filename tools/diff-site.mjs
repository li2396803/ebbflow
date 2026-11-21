// 逐值对比：我生成的站点数据 vs 原站
import fs from "node:fs";
import { parseChunk } from "./parse-chunks.mjs";

let total = 0, diff = 0, maxd = 0;
const samples = [];
for (const f of fs.readdirSync("tools/original-charts")) {
  const A = parseChunk("tools/original-charts/" + f);
  const ka = Object.keys(A)[0];
  const B = parseChunk("site/charts/" + f);
  const kb = Object.keys(B)[0];
  if (ka !== kb) throw new Error("大类键不一致");
  const a = A[ka].c1, b = B[kb].c1;
  if (a.dates.length !== b.dates.length) console.log(`${ka} 日期长度 ${a.dates.length} vs ${b.dates.length}`);
  const aNames = a.series.map((s) => s.name).join("|"), bNames = b.series.map((s) => s.name).join("|");
  if (aNames !== bNames) console.log(`${ka} 小类集合不一致\n  原:${aNames}\n  我:${bNames}`);
  for (const sa of a.series) {
    const sb = b.series.find((s) => s.name === sa.name);
    if (!sb) continue;
    if (sa.color !== sb.color) console.log(`${sa.name} 颜色 ${sa.color} vs ${sb.color}`);
    for (let i = 0; i < sa.values.length; i++) {
      const va = sa.values[i], vb = sb.values[i];
      if (va == null && vb == null) continue;
      total++;
      if (va == null || vb == null || Math.abs(va - vb) > 1e-9) {
        diff++;
        const d = Math.abs((va ?? 0) - (vb ?? 0));
        if (d > maxd) maxd = d;
        if (samples.length < 6) samples.push(`${sa.name} @${a.dates[i]}: 原${va} 我${vb}`);
      }
    }
  }
  // c3
  const a3 = A[ka].c3, b3 = B[kb].c3;
  if (a3.dates.join() !== b3.dates.join()) console.log(`${ka} c3 日期 ${a3.dates.join()} vs ${b3.dates.join()}`);
  for (const sa of a3.series) {
    const sb = b3.series.find((s) => s.name === sa.name);
    if (!sb) { console.log(`${ka} c3 缺 ${sa.name}`); continue; }
    for (let i = 0; i < sa.values.length; i++) {
      if (Math.abs(sa.values[i] - sb.values[i]) > 1e-9) console.log(`c3 ${sa.name}[${i}] 原${sa.values[i]} 我${sb.values[i]}`);
    }
  }
}
console.log(`\n对比 ${total} 个数据点，差异 ${diff} 个，最大偏差 ${maxd}`);
samples.forEach((s) => console.log("  " + s));
