import { test, assert, assertEq, skipNow, note } from "../framework.mjs";
import { filterIsolated } from "../../lib/invariants.mjs";
import { openDb, shareMap, shareRows, daySources, tradingDates } from "../../lib/db.mjs";
import { findGaps } from "../../lib/validate.mjs";
import { loadUniverse } from "../../lib/universe.mjs";

const { SUB } = loadUniverse();

test("序列连续性检测器 findGaps：首段 null 允许，中间断裂被抓出", () => {
  const rows = (vals) => vals.map((v, i) => ({ date: `2026-01-0${i + 1}`, val: v }));
  assertEq(findGaps(rows([null, null, 1, 2])).gaps.length, 0, "首段 null 不算断裂");
  assertEq(findGaps(rows([1, 2, 3])).gaps.length, 0, "全有值不应报断裂");
  const g = findGaps(rows([1, null, null, 2]));
  assertEq(g.gaps.length, 1, "中间断裂应被抓出");
  assertEq(g.gaps[0].from, "2026-01-02", "断裂起点");
  assertEq(g.gaps[0].to, "2026-01-04", "恢复日期");
  assertEq(g.gaps[0].days, 2, "断裂交易日数");
  const t = findGaps(rows([1, 2, null]));
  assertEq(t.gaps.length, 0, "末尾缺数据不算中间断裂");
  assertEq(t.tail.days, 1, "末尾缺数据单独返回");
});

test("序列连续性：小类不得出现中间断裂后恢复（结构性无数据放行）", () => {
  const db = openDb();
  try {
    const rows = db.prepare("SELECT sub, date, val FROM series ORDER BY sub, date").all();
    if (!rows.length) skipNow("series 表为空（数据库还没回补/重算）");
    const bySub = new Map();
    for (const r of rows) {
      let a = bySub.get(r.sub);
      if (!a) bySub.set(r.sub, (a = []));
      a.push(r);
    }
    const cache = new Map();
    const presentOn = (d) => {
      let m = cache.get(d);
      if (!m) {
        // 与 pipeline 同口径：当日若有交易所快照，只认交易所行（ts 补充行不计入）
        const src = daySources(db, d);
        m = new Map();
        for (const r of shareRows(db, d)) {
          const isSh = /^[569]/.test(r.code);
          if (isSh ? src.sse && r.src !== "sse" : src.szse && r.src !== "szse") continue;
          m.set(r.code, r.wan);
        }
        cache.set(d, m);
      }
      return m;
    };
    const bad = [];
    let structural = 0;
    for (const [sub, list] of bySub) {
      const meta = SUB[sub];
      assert(meta, `series 表出现未知小类「${sub}」`);
      const { gaps } = findGaps(list);
      for (const g of gaps) {
        for (const r of list) {
          if (r.date < g.from || r.date >= g.to || r.val != null) continue;
          // 空值日：只有该小类当日确实一个成分都没被计入，才算「结构性空」，否则是真断裂。
          // 注意要与 pipeline 同口径：孤立披露（前后都没有数据）的成分不算数，
          // 所以这里统计「该日有数据且不是孤立披露」的成分。
          const m = presentOn(r.date);
          if (meta.etfs.some((e) => m.get(e.code) != null)) bad.push({ sub, date: r.date });
          else structural++;
        }
      }
    }
    // 孤立披露豁免：某成分只在这一天有数据（前后相邻交易日都没有），pipeline 会把它剔除，
    // 于是该小类当天自然为空——这不是断裂。用共享的 filterIsolated 做同口径判断。
    if (bad.length) {
      const dates = tradingDates(db);
      const sharesByDate = new Map();
      for (const d of dates) sharesByDate.set(d, presentOn(d));
      const filt = filterIsolated(sharesByDate, dates);
      const still = bad.filter((b) => {
        const meta = SUB[b.sub];
        const day = filt.get(b.date);
        return meta && day ? meta.etfs.some((e) => day.get(e.code) != null) : true;
      });
      bad.length = 0;
      bad.push(...still);
    }
    assertEq(bad.length, 0, `序列中间断裂 ${bad.length} 处：${JSON.stringify(bad.slice(0, 4))}`);
    if (structural) note(`序列断裂检查：${structural} 个空值日经核对是「该小类当日无成分数据」，放行`);
  } finally {
    db.close();
  }
});
