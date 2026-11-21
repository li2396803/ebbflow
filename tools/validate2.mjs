import fs from "node:fs";
import { parseChunk, parseIndexTaxonomy } from "./parse-chunks.mjs";
const num = (v) => parseFloat(String(v).replace(/,/g, ""));
const sse = new Map(JSON.parse(fs.readFileSync("/tmp/probe/sse_2026-11-20.json", "utf8")).map(r => [r.SEC_CODE.trim(), num(r.TOT_VOL)]));
const szse = new Map(JSON.parse(fs.readFileSync("data/_probe_szse.json", "utf8")).map(r => [r.code, r.gm]));
const tax = parseIndexTaxonomy("tools/original-index.html");
const site = {}, catOf = {};
for (const f of fs.readdirSync("site/charts")) {
  const D = parseChunk("site/charts/" + f); const cid = Object.keys(D)[0];
  for (const s of D[cid].c1.series) { site[s.name] = s.values.at(-1); catOf[s.name] = cid; }
}
const BOND = "9_债券";
const perCat = {};
let mismatch = [];
for (const [sub, list] of Object.entries(tax)) {
  let sum = 0;
  for (const e of list) {
    const c = e.slice(0, 6);
    sum += sse.get(c) ?? szse.get(c) ?? 0;
  }
  let v = sum / 1e4;
  if (catOf[sub] === BOND) v *= 100;
  v = Math.round(v * 10) / 10;
  const cat = catOf[sub];
  perCat[cat] = (perCat[cat] || 0) + v;
  if (Math.abs(v - site[sub]) > Math.max(0.15, site[sub] * 0.002)) mismatch.push({ sub, v, orig: site[sub], diff: +(v - site[sub]).toFixed(1) });
}
console.log("逐小类偏差:", mismatch.length, mismatch.slice(0, 6));
// 大类表
const big = { "1_宽基市场": 5635.9, "2_风格策略": 1302.0, "3_科技": 4631.1, "4_制造": 650.0, "5_能源": 393.9, "6_资源": 633.0, "8_金融地产": 2085.7, "9_债券": 15819.2 };
big["7_医药&消费"] = 2360.3;
const seven = (perCat["7_消费"] || 0) + (perCat["7_医药"] || 0);
console.log("大类核对:");
for (const [k, v] of Object.entries(big)) {
  const mine = k === "7_医药&消费" ? seven : perCat[k];
  console.log(`  ${k.padEnd(10)} 计算${mine.toFixed(1).padStart(9)}  原站${String(v).padStart(9)}  差${(mine - v).toFixed(1)}`);
}
