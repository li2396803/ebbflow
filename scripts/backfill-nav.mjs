// 回补被截断的按日净值（历史包袱：navOnDate 曾未翻页，466 天数据不全）。
// 用法：node scripts/backfill-nav.mjs [--days N]   （默认全部可疑日）
import { openDb, putNav } from "../lib/db.mjs";
import { navOnDate, bindBudget } from "../lib/tushare.mjs";

const LIMIT = (() => {
  const i = process.argv.indexOf("--days");
  return i > 0 ? Number(process.argv[i + 1]) : 0;
})();

export async function backfillNav({ maxDays = LIMIT, log = console.log } = {}) {
  bindBudget?.();
  const db = openDb();
  try {
    const dates = db.prepare("SELECT DISTINCT date FROM dayinfo WHERE has_sse=1 ORDER BY date").all().map((r) => r.date);
    if (!dates.length) {
      log("⚠ 数据库是空的（没有 dayinfo）——多半是缓存没恢复成功，回补无法进行");
      return { todo: 0, filled: 0, empty: true };
    }
    // 判据：不是看「当天净值总行数」（总数够，也可能缺关键代码——513050 就是这么漏的），
    // 而是看「当天有多少 ETF 成分缺净值」。
    const etfCodes = db.prepare("SELECT code FROM fund WHERE name LIKE '%ETF%' OR type LIKE '%ETF%'").all().map((r) => r.code);
    const etfSet = new Set(etfCodes);
    const med = (() => {
      const counts = dates.map((d) => db.prepare("SELECT COUNT(*) n FROM nav WHERE date=?").get(d).n).sort((a, b) => a - b);
      return counts[Math.floor(counts.length / 2)];
    })();
    let todo = [];
    for (const d of dates) {
      const have = new Set(db.prepare("SELECT code FROM nav WHERE date=?").all(d).map((r) => r.code));
      let missing = 0;
      let totalEtf = 0;
      for (const c of etfSet) {
        totalEtf++;
        if (!have.has(c)) missing++;
      }
      if (totalEtf && missing / totalEtf > 0.02) todo.push(d);
    }
    if (maxDays > 0) todo = todo.slice(0, maxDays);
    let filled = 0;
    let done = 0;
    for (const d of todo) {
      try {
        const m = await navOnDate(d);
        if (m.size) {
          putNav(db, [...m].map(([c, v]) => [c, d, v]));
          filled += m.size;
        }
        done++;
      } catch (e) {
        if (/上限/.test(String(e.message))) break;
      }
    }
    log(`净值回补：中位数 ${med} 行 / 待补 ${todo.length} 天 / 补写 ${filled} 行`);
    return { todo: todo.length, done, filled, median: med };
  } finally {
    db.close();
  }
}

if (process.argv[1] && /backfill-nav\.mjs$/.test(process.argv[1])) {
  await backfillNav();
}
