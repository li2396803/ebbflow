// 从原站副本提取「近 7 日变化率」已发布值，作为播种期的短期曲线基线
// 原因：长期序列只有 1 位小数，直接据此做比值会把小量级细分行业的变化抹平；
// 原站是按未取整的份额算的，因此播种期内直接沿用它的百分比更忠实。
import fs from "node:fs";
import path from "node:path";
import { parseChunk } from "./parse-chunks.mjs";

export function writeC3Seed(dir = "tools/original-charts", outFile = "data/c3-seed.json") {
  const dates = new Set();
  const subs = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const D = parseChunk(path.join(dir, f));
    const c3 = D[Object.keys(D)[0]].c3;
    c3.dates.forEach((d) => dates.add(d));
    for (const s of c3.series) subs[s.name] = s.values.map((v) => (v == null ? null : Math.round(v * 10) / 10));
  }
  const out = { dates: [...dates].sort(), windowLen: dates.size, subs };
  fs.writeFileSync(outFile, JSON.stringify(out));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = writeC3Seed();
  console.log("c3 基线：", out.dates.join(","), "|", Object.keys(out.subs).length, "个细分行业");
}
