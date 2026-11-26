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
    const counts = dates.map((d) => ({ d, n: db.prepare("SELECT COUNT(*) n FROM nav WHERE date=?").get(d).n }));
    if (!counts.length) return { todo: 0, filled: 0 };
    const med = counts.map((x) => x.n).sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    let todo = counts.filter((x) => x.n < med * 0.9).map((x) => x.d);
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
