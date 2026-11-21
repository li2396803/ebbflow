// 数值对比：tools/original-charts/*.js（原站） vs site/charts/*.js（复刻版）
// 统计 c1 / c2 / c3 差异分布，并检查同一 data 文件内部一致性：
//   · c1.series 必须与 c2.series 完全相同（c2 只是 percent:true 的同一份数据）
//   · c3.dates 必须是 c1.dates 的末尾连续交易日
import fs from "node:fs";
import path from "node:path";
import { parseChunk } from "../tools/parse-chunks.mjs";

const A_DIR = "tools/original-charts";
const B_DIR = "site/charts";
const EPS = 1e-9;

function stats() {
  return { points: 0, bothNull: 0, same: 0, le01: 0, le05: 0, gt05: 0, nullMismatch: 0, maxDiff: 0, examples: [] };
}
function add(s, name, date, va, vb) {
  s.points++;
  if (va == null && vb == null) { s.bothNull++; return; }
  if (va == null || vb == null) {
    s.nullMismatch++;
    if (s.examples.length < 8) s.examples.push(`${name} @${date}: 原=${va} 复=${vb} (null 不一致)`);
    return;
  }
  const d = Math.abs(va - vb);
  if (d <= EPS) { s.same++; return; }
  if (d > s.maxDiff) s.maxDiff = d;
  if (d <= 0.1 + 1e-12) s.le01++;
  else if (d <= 0.5 + 1e-12) s.le05++;
  else s.gt05++;
  if (s.examples.length < 8) s.examples.push(`${name} @${date}: 原=${va} 复=${vb} Δ=${d.toFixed(4)}`);
}
function fmt(s) {
  return `点数 ${s.points}｜完全相同 ${s.same}（${((s.same / s.points) * 100).toFixed(2)}%）｜|Δ|≤0.1 ${s.le01}｜0.1<|Δ|≤0.5 ${s.le05}｜>0.5 ${s.gt05}｜null 不一致 ${s.nullMismatch}｜空值 ${s.bothNull}｜max|Δ| ${s.maxDiff.toFixed(4)}`;
}

const files = fs.readdirSync(A_DIR).filter((f) => f.endsWith(".js")).sort();
const perCat = [];
const total = { c1: stats(), c2: stats(), c3: stats() };
const internalIssues = [];

for (const f of files) {
  const A = parseChunk(path.join(A_DIR, f));
  const ka = Object.keys(A)[0];
  const B = parseChunk(path.join(B_DIR, f));
  const kb = Object.keys(B)[0];
  if (ka !== kb) { internalIssues.push(`${f}: 大类键 ${ka} vs ${kb}`); continue; }
  const a = A[ka], b = B[kb];

  // 结构：日期数组、小类顺序
  if (a.c1.dates.join() !== b.c1.dates.join()) internalIssues.push(`${ka}: c1.dates 不一致`);
  const namesA = a.c1.series.map((s) => s.name);
  const namesB = b.c1.series.map((s) => s.name);
  if (namesA.join("|") !== namesB.join("|")) internalIssues.push(`${ka}: 小类集合/顺序不一致`);

  const catS = { key: ka, series: namesA.length, dates: a.c1.dates.length, c1: stats(), c3: stats() };

  for (const sa of a.c1.series) {
    const sb = b.c1.series.find((s) => s.name === sa.name);
    if (!sb) { internalIssues.push(`${ka}/${sa.name}: 复刻版缺失`); continue; }
    if (sa.color !== sb.color) internalIssues.push(`${ka}/${sa.name}: 颜色 ${sa.color} vs ${sb.color}`);
    for (let i = 0; i < sa.values.length; i++) {
      add(total.c1, sa.name, a.c1.dates[i], sa.values[i], sb.values[i]);
      add(catS.c1, sa.name, a.c1.dates[i], sa.values[i], sb.values[i]);
    }
  }

  // c2 与 c1 内部一致性（两边都要满足）
  for (const [side, d] of [["原站", a], ["复刻", b]]) {
    if (JSON.stringify(d.c1.series) !== JSON.stringify(d.c2.series))
      internalIssues.push(`${ka} ${side}: c1.series 与 c2.series 不同（应完全相同）`);
  }
  // c2 逐值对比（c2.series === c1.series 时数值必然相同，仍独立跑一遍统计）
  for (const sa of a.c2.series) {
    const sb = b.c2.series.find((s) => s.name === sa.name);
    if (!sb) continue;
    for (let i = 0; i < sa.values.length; i++) add(total.c2, sa.name, a.c2.dates[i], sa.values[i], sb.values[i]);
  }

  // c3
  const a3 = a.c3, b3 = b.c3;
  const tail = a.c1.dates.slice(-a3.dates.length).join();
  if (a3.dates.join() !== tail) internalIssues.push(`${ka}: 原站 c3.dates 不是 c1 末尾序列`);
  const tailB = b.c1.dates.slice(-b3.dates.length).join();
  if (b3.dates.join() !== tailB) internalIssues.push(`${ka}: 复刻版 c3.dates 不是 c1 末尾序列`);
  if (a3.dates.join() !== b3.dates.join()) internalIssues.push(`${ka}: c3.dates 两边不一致（原 ${a3.dates.join()} / 复 ${b3.dates.join()}）`);
  for (const sa of a3.series) {
    const sb = b3.series.find((s) => s.name === sa.name);
    if (!sb) { internalIssues.push(`${ka}/${sa.name}: c3 复刻版缺失`); continue; }
    for (let i = 0; i < sa.values.length; i++) {
      add(total.c3, sa.name, b3.dates[i], sa.values[i], sb.values[i]);
      add(catS.c3, sa.name, b3.dates[i], sa.values[i], sb.values[i]);
    }
  }
  perCat.push(catS);
}

console.log("=".repeat(78));
console.log("数值对比（原站副本 vs 复刻版）  文件数:", files.length);
console.log("=".repeat(78));
for (const c of perCat) {
  console.log(`\n${c.key}  小类 ${c.series} / 交易日 ${c.dates}`);
  console.log("  c1:", fmt(c.c1));
  console.log("  c3:", fmt(c.c3));
}
console.log("\n" + "-".repeat(78));
console.log("合计 c1:", fmt(total.c1));
console.log("合计 c2:", fmt(total.c2));
console.log("合计 c3:", fmt(total.c3));
console.log("\nc1 差异样例:");
total.c1.examples.forEach((e) => console.log("  " + e));
console.log("c3 差异样例:");
total.c3.examples.forEach((e) => console.log("  " + e));
console.log("\n内部一致性/结构问题:", internalIssues.length);
internalIssues.forEach((x) => console.log("  - " + x));

fs.writeFileSync(
  "verify/numbers-report.json",
  JSON.stringify({ files, total, perCat, internalIssues }, null, 2)
);
console.log("\n已写出 verify/numbers-report.json");
