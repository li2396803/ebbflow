import { test, assert, assertEq, skipNow, note } from "../framework.mjs";
import { openDb, shareMap } from "../../lib/db.mjs";
import { findGaps } from "../../lib/validate.mjs";
import { SUB } from "../../lib/taxonomy.mjs";

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
      if (!m) cache.set(d, (m = shareMap(db, d)));
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
          // 空值日：只有该小类当日确实一个成分都没有数据，才算「结构性空」，否则是真断裂
          const m = presentOn(r.date);
          if (meta.etfs.some((e) => m.get(e.code) != null)) bad.push({ sub, date: r.date });
          else structural++;
        }
      }
    }
    assertEq(bad.length, 0, `序列中间断裂 ${bad.length} 处：${JSON.stringify(bad.slice(0, 4))}`);
    if (structural) note(`序列断裂检查：${structural} 个空值日经核对是「该小类当日无成分数据」，放行`);
  } finally {
    db.close();
  }
});
