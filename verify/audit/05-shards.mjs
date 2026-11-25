// 审计 5：站点分片数据质量（site/data/etf-ranges/*.json、subs.json、charts-*.json）
//  A. 3 只 ETF：1y 的 chgPct / flow / scaleEnd 手工复算 vs 分片
//  B. etf-ranges 的 flow 用的是哪种折算实现（§5.5 修正是否覆盖到这里）
//  C. subs.json 里逐 ETF 的 flow 是「Δ份额×末日净值」还是「逐日净申购求和」
//  D. null 是否被写成 0；单位；四舍五入
import { openDb, loadDates, buildCtx, r1, r2, siteJson } from "./_db.mjs";
import { loadUniverse } from "../../lib/universe.mjs";
import { dailyFlows, sumRange, windowOf } from "./_flows.mjs";
import fs from "node:fs";

const db = openDb();
const dates = loadDates(db, "series_v2");
const ctx = buildCtx(db, dates);
const U = loadUniverse({ taxonomy: "v2" });
const w = windowOf(dates, 12);

const catOf = (code) => Object.entries(U.SUB).find(([, m]) => m.etfs.some((e) => e.code === code))?.[1].cat;

function manual(code) {
  const d = dailyFlows(ctx, code, "prev");
  const dBug = dailyFlows(ctx, code, "same");
  const sh = ctx.shares.get(code);
  const nv = ctx.navs.get(code);
  const s0 = (sh[w.i0] / 1e4) * nv[w.i0];
  const s1 = (sh[w.i1] / 1e4) * nv[w.i1];
  let nav = 0;
  for (let t = w.i0 + 1; t <= w.i1; t++) {
    const wp = sh[t - 1];
    const np = nv[t - 1];
    const nt = nv[t];
    if (Number.isFinite(wp) && Number.isFinite(np) && Number.isFinite(nt)) nav += (wp / 1e4) * (nt - np);
  }
  return {
    chgPct: r2(((s1 - s0) / s0) * 100),
    scaleEnd: r2(s1),
    flowInc: r2(sumRange(d, w.i0, w.i1)),
    flowExc: r2(sumRange(d, w.i0 + 1, w.i1)),
    flowBug: r2(sumRange(dBug, w.i0, w.i1)),
    navContrib: r2(nav),
    scaleStart: r2(s0),
  };
}

console.log("=".repeat(80));
console.log(`A. 3 只 ETF 的 1 年区间指标：手工复算 vs 分片（窗口 ${w.from} → ${w.to}）`);
const PICKS = ["510050", "510310", "518880"];
const shards = new Map();
for (const cat of U.CATS.map((c) => c.key)) {
  const f = `site/data/etf-ranges/${cat}.json`;
  if (fs.existsSync(f)) shards.set(cat, siteJson(`etf-ranges/${cat}.json`));
}
const rowsA = [];
for (const code of PICKS) {
  const cat = catOf(code);
  const shard = shards.get(cat);
  let shardV = null;
  for (const [, v] of Object.entries(shard?.subs ?? {})) {
    if (v?.["1y"]?.[code]) shardV = v["1y"][code];
  }
  const m = manual(code);
  rowsA.push({ code, cat, ...m, shard_chgPct: shardV?.chgPct, shard_flow: shardV?.flow, shard_scaleEnd: shardV?.scaleEnd });
}
console.table(rowsA);

console.log("\n=== 差异判定（chgPct / scaleEnd 应完全一致；flow 允许「含/不含期初」与「折算实现」两种差）===");
for (const r of rowsA) {
  const dChg = r.shard_chgPct == null ? null : Math.abs(r.shard_chgPct - r.chgPct);
  const dScale = r.shard_scaleEnd == null ? null : Math.abs(r.shard_scaleEnd - r.scaleEnd);
  const flowKind =
    r.shard_flow == null
      ? "分片 null"
      : Math.abs(r.shard_flow - r.flowInc) < 0.02
        ? "含期初/正确折算"
        : Math.abs(r.shard_flow - r.flowExc) < 0.02
          ? "不含期初/正确折算"
          : Math.abs(r.shard_flow - r.flowBug) < 0.05
            ? "含期初+旧折算实现(bug)"
            : "无法归类";
  console.log(`  ${r.code}(${r.cat}): chgPct Δ${dChg?.toFixed(2)}pp | scaleEnd Δ${dScale?.toFixed(2)} 亿 | flow 分片 ${r.shard_flow} vs 手工 含期初 ${r.flowInc}/不含 ${r.flowExc}/旧实现 ${r.flowBug} → ${flowKind}`);
}

console.log("\n" + "=".repeat(80));
console.log("B. etf-ranges 全量：flow 采用哪种折算实现（逐 ETF × 6 区间）");
let stat = { inc: 0, exc: 0, bug: 0, other: 0, nullv: 0, total: 0 };
const bugList = [];
for (const [cat, shard] of shards) {
  for (const [sub, per] of Object.entries(shard.subs ?? {})) {
    for (const [p, map] of Object.entries(per)) {
      const pw = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "3y": 36, "5y": 60 }[p];
      const win = windowOf(dates, pw);
      for (const [code, v] of Object.entries(map)) {
        stat.total++;
        if (v?.flow == null) { stat.nullv++; continue; }
        const d = dailyFlows(ctx, code, "prev");
        const dbg = dailyFlows(ctx, code, "same");
        const inc = sumRange(d, win.i0, win.i1);
        const exc = sumRange(d, win.i0 + 1, win.i1);
        const bug = sumRange(dbg, win.i0, win.i1);
        if (inc != null && Math.abs(v.flow - inc) < 0.05) stat.inc++;
        else if (exc != null && Math.abs(v.flow - exc) < 0.05) stat.exc++;
        else if (bug != null && Math.abs(v.flow - bug) < 0.05) { stat.bug++; if (bugList.length < 8) bugList.push({ cat, sub, p, code, shard: v.flow, correct: r2(inc), diff: r2(v.flow - inc) }); }
        else stat.other++;
      }
    }
  }
}
console.log(`  总条目 ${stat.total}：含期初+正确折算 ${stat.inc}；不含期初 ${stat.exc}；**含期初+旧折算(bug) ${stat.bug}**；无法归类 ${stat.other}；null ${stat.nullv}`);
console.log("  bug 样例（分片值 vs 正确复算）：");
console.table(bugList);

console.log("\n" + "=".repeat(80));
console.log("C. subs.json 逐 ETF 的 flow 口径（7 日窗口）");
const subs = siteJson("subs.json");
const win7 = { i0: dates.length - 6, i1: dates.length - 1 };
let same = 0, diff = 0, maxd = 0, maxEx = null, n = 0;
for (const [sub, meta] of Object.entries(U.SUB)) {
  const entry = subs[sub];
  if (!entry?.etfs) continue;
  for (const e of entry.etfs) {
    if (e.flow == null) continue;
    const sh = ctx.shares.get(e.code);
    const nv = ctx.navs.get(e.code);
    const a = sh?.[win7.i0];
    const b = sh?.[win7.i1];
    const nav = nv?.[win7.i1];
    if (![a, b, nav].every(Number.isFinite)) continue;
    const approx = ((b - a) / 1e4) * nav; // payloads.mjs 的公式
    const d = dailyFlows(ctx, e.code, "prev");
    const exactInc = sumRange(d, win7.i0, win7.i1);
    n++;
    if (Math.abs(e.flow - approx) < 0.02) same++;
    if (exactInc != null) {
      const dd = Math.abs(e.flow - exactInc);
      if (dd > 0.02) {
        diff++;
        if (dd > maxd) { maxd = dd; maxEx = { sub, code: e.code, shard: e.flow, exact: r2(exactInc), approx: r2(approx) }; }
      }
    }
  }
}
console.log(`  可校验 ETF ${n} 只：分片值 == 「Δ份额×末日净值」 的 ${same} 只 (${((same / n) * 100).toFixed(1)}%)`);
console.log(`  与「逐日净申购求和」差 >0.02 亿 的 ${diff} 只；最大差 ${maxd.toFixed(2)} 亿`);
console.log(`  最大例：${maxEx?.sub}/${maxEx?.code} 分片 ${maxEx?.shard}，逐日和 ${maxEx?.exact}，Δ份额×末日净值 ${maxEx?.approx}`);
console.log("  → 两种口径在 7 日窗口通常很接近，但语义不同（契约 §二 定义是逐日求和），且折算日会明显失真");

console.log("\n" + "=".repeat(80));
console.log("D. null / 单位 / 舍入");
// D1: 分片里的 null 与 0
let zeros = { chgPct: 0, flow: 0, scaleEnd: 0 };
let nulls = { chgPct: 0, flow: 0, scaleEnd: 0 };
for (const [, shard] of shards) {
  for (const per of Object.values(shard.subs ?? {})) {
    for (const map of Object.values(per)) {
      for (const v of Object.values(map)) {
        for (const k of ["chgPct", "flow", "scaleEnd"]) {
          if (v?.[k] == null) nulls[k]++;
          else if (v[k] === 0) zeros[k]++;
        }
      }
    }
  }
}
console.log(`  etf-ranges 字段统计：null chgPct/flow/scaleEnd = ${nulls.chgPct}/${nulls.flow}/${nulls.scaleEnd}；恰好为 0 的 = ${zeros.chgPct}/${zeros.flow}/${zeros.scaleEnd}`);
console.log("  （flow 恰好 0 是可能的真实值；scaleEnd=0 或 chgPct=0 需要看是否缺净值被写成 0）");

// D2: 单位校验：取 510050 最新一天的 scaleEnd 与 份额×净值 对照
const sh050 = ctx.shares.get("510050");
const nv050 = ctx.navs.get("510050");
console.log(`  单位抽检 510050 ${dates.at(-1)}: 份额 ${sh050.at(-1)} 万份 / 1e4 = ${(sh050.at(-1) / 1e4).toFixed(2)} 亿份 × 净值 ${nv050.at(-1)} = ${r2((sh050.at(-1) / 1e4) * nv050.at(-1))} 亿元`);
console.log(`  etf-ranges 510050 1y scaleEnd = ${rowsA.find((r) => r.code === "510050")?.shard_scaleEnd}；subs.json 510050 scale = ${subs["大盘宽基"].etfs.find((e) => e.code === "510050")?.scale}`);

// D3: charts-*.json 与 series_v2 的一致性（规模 1 位小数、flow 1 位小数）
const chart = siteJson("charts-broad.json");
let maxScale = 0, maxFlow = 0, cmp = 0;
for (const ser of chart.series) {
  const dbRows = db.prepare("SELECT date, scale, flow FROM series_v2 WHERE sub=?").all(ser.name);
  const byDate = new Map(dbRows.map((r) => [r.date, r]));
  for (let i = 0; i < chart.dates.length; i++) {
    const r = byDate.get(chart.dates[i]);
    if (!r) continue;
    cmp++;
    if (r.scale != null && ser.scale[i] != null) maxScale = Math.max(maxScale, Math.abs(r1(r.scale) - ser.scale[i]));
    if (r.flow != null && ser.flow[i] != null) maxFlow = Math.max(maxFlow, Math.abs(r1(r.flow) - ser.flow[i]));
  }
}
console.log(`  charts-broad.json vs series_v2：比对 ${cmp} 个 (小类×日)，scale 最大差 ${maxScale.toFixed(2)}，flow 最大差 ${maxFlow.toFixed(2)}（1 位小数舍入，应 ≤0.05）`);
