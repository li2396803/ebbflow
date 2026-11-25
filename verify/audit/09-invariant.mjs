// 审计 9（第二轮）：不变量 −scale_{t−1} ≤ flow_t ≤ scale_t 的覆盖度检验
//   A. 用修正口径扫全部 (ETF×日)：是否误伤（合法清仓被报）
//   B. 用旧实现（E1）扫同一批点：是否能抓到
//   C. 找极端案例（|flow| 接近规模）说明边界为什么不能写死 |flow| ≤ scale_t
//   D. 盲区：合并日的大额假流出是否落在边界内
import { openDb, loadDates, buildCtx, adjustFactor, r4 } from "./_db.mjs";
import { loadUniverse } from "../../lib/universe.mjs";
import { dailyFlows } from "./_flows.mjs";

const db = openDb();
const dates = loadDates(db, "series_v2");
const ctx = buildCtx(db, dates);
const U = loadUniverse({ taxonomy: "v2" });
const codes = [...new Set(Object.values(U.SUB).flatMap((m) => m.etfs.map((e) => e.code)))];

function bound(flow, scalePrev, scaleEnd, tolerance = 1e-6) {
  if (!Number.isFinite(flow)) return false;
  const pad = 1e-9 + tolerance * Math.max(Math.abs(scalePrev || 0), Math.abs(scaleEnd || 0), 1);
  return flow > scaleEnd + pad || flow < -scalePrev - pad;
}

const badNew = [];
const extremes = [];
let n = 0;
let nOld = 0;
const oldBad = [];

for (const code of codes) {
  const sh = ctx.shares.get(code);
  const nv = ctx.navs.get(code);
  if (!sh || !nv) continue;
  const good = dailyFlows(ctx, code, "day");
  const old = dailyFlows(ctx, code, "prev"); // v4.0.0 的 m_t 缩放实现
  for (let i = 1; i < dates.length; i++) {
    const w = sh[i];
    const p = sh[i - 1];
    const nav = nv[i];
    if (!Number.isFinite(w) || !Number.isFinite(p) || !Number.isFinite(nav) || !(nav > 0)) continue;
    const sPrev = (p / 1e4) * nav;
    const sEnd = (w / 1e4) * nav;
    const f = good[i];
    if (Number.isFinite(f)) {
      n++;
      if (bound(f, sPrev, sEnd)) badNew.push({ code, date: dates[i], flow: r4(f), sPrev: r4(sPrev), sEnd: r4(sEnd) });
      if (sPrev > 0) {
        const ratio = f / sPrev;
        if (Math.abs(ratio) > 0.9) extremes.push({ code, date: dates[i], flow: r4(f), sPrev: r4(sPrev), ratio: +ratio.toFixed(2) });
      }
    }
    const fo = old[i];
    if (Number.isFinite(fo)) {
      nOld++;
      if (bound(fo, sPrev, sEnd)) oldBad.push({ code, date: dates[i], flow: r4(fo), sPrev: r4(sPrev), sEnd: r4(sEnd) });
    }
  }
}

console.log("=".repeat(76));
console.log(`A. 修正口径：扫描 ${n} 个 (ETF×日)（宇宙 ${codes.length} 只 ETF）`);
console.log(`   越界 ${badNew.length} 个` + (badNew.length ? "：" : "（不误伤 ✅）"));
badNew.slice(0, 5).forEach((x) => console.log(`     ${x.code} ${x.date} flow ${x.flow} ∈ [${-x.sPrev}, ${x.sEnd}]`));

console.log("\n" + "=".repeat(76));
console.log(`B. 旧实现（E1：最新单位 × 当日净值）：扫描 ${nOld} 个点，越界 ${oldBad.length} 个`);
oldBad.sort((a, b) => Math.abs(b.flow) - Math.abs(a.flow));
console.log("   被抓住的最大 5 例：");
oldBad.slice(0, 5).forEach((x) => console.log(`     ${x.code} ${x.date} flow ${x.flow} ∈ [${-x.sPrev}, ${x.sEnd}]`));

console.log("\n" + "=".repeat(76));
console.log(`C. 合法极端值（|flow| / scale_{t−1} > 0.9）共 ${extremes.length} 个，样例：`);
extremes.sort((a, b) => Math.abs(b.ratio) - Math.abs(a.ratio));
console.table(extremes.slice(0, 8));
console.log("   → 这些是真实大额申赎；若用 |flow| ≤ scale_t 会把它们全部误报（如赎回 90% 时 |flow|=9×scale_t）");

console.log("\n" + "=".repeat(76));
console.log("D. 盲区检验：旧实现在「合并日」的假流出是否落在边界内");
const mergeCases = [];
for (const [code, evs] of ctx.events) {
  for (const e of evs) {
    const i = ctx.index.get(e.date);
    if (i == null || i < 1) continue;
    const sh = ctx.shares.get(code);
    const nv = ctx.navs.get(code);
    const w = sh?.[i], p = sh?.[i - 1], nav = nv?.[i];
    if (![w, p, nav].every(Number.isFinite) || !(nav > 0)) continue;
    const sPrev = (p / 1e4) * nav;
    const sEnd = (w / 1e4) * nav;
    const fo = (w * adjustFactor(ctx, code, dates[i]) - p * adjustFactor(ctx, code, dates[i - 1])) / 1e4 * nav;
    const other = (w - p) / 1e4 * nav; // 完全不折算的"最坏实现"
    const caught = bound(fo, sPrev, sEnd);
    const caughtWorst = bound(other, sPrev, sEnd);
    if (!caught && Math.abs(fo - other) > 1e-9) mergeCases.push({ code, date: e.date, ratio: e.ratio, flowOld: r4(fo), worst: r4(other), sPrev: r4(sPrev), sEnd: r4(sEnd), caught });
  }
}
console.log(`   事件日中，旧实现虽错但未被不变量抓住的：${mergeCases.filter((x) => x.flowOld !== 0).length} 个（样例）`);
console.table(mergeCases.filter((x) => Math.abs(x.flowOld) > 1).slice(0, 6));
