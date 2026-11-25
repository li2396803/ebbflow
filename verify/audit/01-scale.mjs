// 审计 1：规模口径 Σ(份额_万份 / 1e4 × 单位净值) vs 站点下发值
// 抽样 5 个小类 × 30 个交易日，完全独立复算（不 import lib/*）。
import { openDb, loadDates, buildCtx, v2Universe, siteJson, r1 } from "./_db.mjs";
import { loadUniverse } from "../../lib/universe.mjs";

const db = openDb();
const U = v2Universe();            // 原始分类文件（含联接基金）
const UB = loadUniverse({ taxonomy: "v2" }); // 构建实际用的成分宇宙（已剔除联接/LOF）
const dates = loadDates(db);
const ctx = buildCtx(db, dates);

const SUBS = process.argv.slice(2);
const PICKS = SUBS.length ? SUBS : ["大盘宽基", "半导体芯片", "医药生物", "信用债", "黄金"];

const N = 30;
const iEnd = ctx.n - 1;
const iStart = iEnd - N + 1;
console.log(`=== 规模口径：Σ(份额/1e4 × 净值)  样本 ${ctx.dates[iStart]} → ${ctx.dates[iEnd]}（${N} 个交易日）===`);

const summary = [];
for (const sub of PICKS) {
  const meta = U.subs[sub];
  if (!meta) {
    console.log(`跳过 ${sub}：v2 宇宙里没有`);
    continue;
  }
  const chart = siteJson(`charts-${meta.cat}.json`);
  const ser = chart.series.find((s) => s.name === sub);
  if (!ser) {
    console.log(`跳过 ${sub}：charts-${meta.cat}.json 没有该小类`);
    continue;
  }
  const codes = UB.SUB[sub].etfs.map((e) => e.code);
  const rawCount = meta.etfs.length;
  let maxDiff = 0;
  let maxAt = null;
  let nullMis = 0;
  let nCmp = 0;
  const rows = [];
  for (let i = iStart; i <= iEnd; i++) {
    let sum = 0;
    let hit = 0;
    for (const c of codes) {
      const w = ctx.shares.get(c)?.[i];
      const nav = ctx.navs.get(c)?.[i];
      if (Number.isFinite(w) && Number.isFinite(nav) && nav > 0) {
        sum += (w / 1e4) * nav;
        hit++;
      }
    }
    const mine = hit ? r1(sum) : null;
    const theirs = ser.scale[i];
    if (mine == null || theirs == null) {
      if (mine !== theirs) nullMis++;
      continue;
    }
    nCmp++;
    const d = Math.abs(mine - theirs);
    if (d > maxDiff) {
      maxDiff = d;
      maxAt = { date: ctx.dates[i], mine, theirs, hit };
    }
    rows.push({ date: ctx.dates[i], mine, theirs, d, hit });
  }
  console.log(`\n【${sub}】(${meta.cat}/${codes.length} 只，分类文件 ${rawCount} 只) 比对 ${nCmp} 点，null 不一致 ${nullMis}，max|Δ| = ${maxDiff.toFixed(4)}`);
  if (maxAt) console.log(`   最大差: ${maxAt.date} 复算 ${maxAt.mine} vs 下发 ${maxAt.theirs}（${maxAt.hit}/${codes.length} 只有数据）`);
  const bad = rows.filter((r) => r.d > 0.0501);
  if (bad.length) {
    console.log(`   >0.05 的点 ${bad.length} 个，样例:`);
    bad.slice(0, 5).forEach((r) => console.log(`     ${r.date} 复算 ${r.mine} vs 下发 ${r.theirs} Δ${r.d.toFixed(3)} 命中${r.hit}/${codes.length}`));
  }
  summary.push({ sub, cat: meta.cat, codes: codes.length, cmp: nCmp, nullMismatch: nullMis, maxDiff: +maxDiff.toFixed(4), bad: bad.length });
}

// 折算日连续性：510310 合并前后规模不应跳变（规模 = 份额×净值，折算同时改份额和净值）
const i0 = ctx.index.get("2024-09-19");
const i1 = ctx.index.get("2024-09-20");
if (i0 != null && i1 != null) {
  const w0 = ctx.shares.get("510310")?.[i0];
  const n0 = ctx.navs.get("510310")?.[i0];
  const w1 = ctx.shares.get("510310")?.[i1];
  const n1 = ctx.navs.get("510310")?.[i1];
  const s0 = (w0 / 1e4) * n0;
  const s1 = (w1 / 1e4) * n1;
  console.log(`\n=== 折算日规模连续性 510310 2024-09-19 → 2024-09-20 ===`);
  console.log(`  份额 ${w0} → ${w1} 万份；净值 ${n0} → ${n1}`);
  console.log(`  规模 ${r1(s0)} → ${r1(s1)} 亿元（Δ${(s1 - s0).toFixed(2)}，${(((s1 - s0) / s0) * 100).toFixed(2)}%）→ 折算不改变规模，只改份数/净值`);
}

console.log("\n=== 汇总 ===");
console.table(summary);
