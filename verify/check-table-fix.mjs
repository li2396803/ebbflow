// 修复复核专用：逐列比对首页「各大类规模」表（原站 vs 复刻版）
// 用途：确认「当前总规模」列是否 9/9 一致、「区间首日规模」与「变动比例」的偏差量级。
import fs from "node:fs";

const dec = (s) => String(s).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();

function firstTableRows(file) {
  const html = fs.readFileSync(file, "utf8");
  const grid = html.match(/<div class="tbl-grid">([\s\S]*?)<\/div>\s*<div class="tabs"/)[1];
  const sec = grid.match(/<section[^>]*>([\s\S]*?)<\/section>/)[1];
  const thead = (sec.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || "";
  const cols = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => dec(m[1]));
  const tbody = (sec.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || "";
  const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => dec(c[1]))
  );
  return { cols, rows };
}

const A = firstTableRows("tools/original-index.html");
const B = firstTableRows("site/index.html");

console.log("列名 原:", JSON.stringify(A.cols));
console.log("列名 复:", JSON.stringify(B.cols));
console.log(`\n${"大类".padEnd(12)} ${"当前总规模".padStart(20)} ${"区间首日规模".padStart(22)} ${"变动比例".padStart(20)}`);
let nowBad = 0;
let maxStart = 0;
let maxPct = 0;
const n = Math.max(A.rows.length, B.rows.length);
for (let i = 0; i < n; i++) {
  const a = A.rows[i] || [];
  const b = B.rows[i] || [];
  const [la, na, sa, pa] = a;
  const [lb, nb, sb, pb] = b;
  const dNow = Math.abs(parseFloat(na) - parseFloat(nb));
  const dStart = Math.abs(parseFloat(sa) - parseFloat(sb));
  const dPct = Math.abs(parseFloat(pa) - parseFloat(pb));
  if (!(la === lb) || !(dNow < 1e-9)) nowBad++;
  maxStart = Math.max(maxStart, dStart);
  maxPct = Math.max(maxPct, dPct);
  const f = (x) => (Number.isFinite(x) ? x.toFixed(2) : "-");
  console.log(
    `${(lb || "-").padEnd(12)} ${`${nb} / ${na} Δ${f(dNow)}`.padStart(20)} ${`${sb} / ${sa} Δ${f(dStart)}`.padStart(22)} ${`${pb} / ${pa} Δ${f(dPct)}`.padStart(20)}`
  );
}
console.log(`\n行数 原 ${A.rows.length} / 复 ${B.rows.length}`);
console.log(`当前总规模列不一致行数: ${nowBad} / ${n}（含行标签不一致）`);
console.log(`区间首日规模列 max|Δ| = ${maxStart.toFixed(2)}   变动比例列 max|Δ| = ${maxPct.toFixed(2)} pp`);
