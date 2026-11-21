import { test, assertEq, skipNow, note } from "../framework.mjs";
import { openDb, shareMap } from "../../lib/db.mjs";
import { SUB } from "../../lib/taxonomy.mjs";

// 口径：0 < 值 < 1e6（亿份）。历史遗留的 0 只允许出现在「该小类当日一个成分都没有数据」的日期，
// 否则说明把「无数据」写成了 0，会污染曲线；最近 20 个交易日则严格要求 0 < 值。
test("数值范围：0 ≤ 小类值 < 1e6，零值必须可解释且最近交易日不得为零", () => {
  const db = openDb();
  try {
    const rows = db.prepare("SELECT sub, date, val FROM series").all();
    if (!rows.length) skipNow("series 表为空（数据库还没回补/重算）");

    const bad = [];
    const zeros = [];
    for (const r of rows) {
      if (r.val == null) continue;
      if (!Number.isFinite(r.val) || r.val < 0 || r.val >= 1e6) bad.push({ sub: r.sub, date: r.date, val: r.val });
      if (r.val === 0) zeros.push(r);
    }
    assertEq(bad.length, 0, `数值越界 ${bad.length} 处（要求 0 ≤ v < 1e6）：${JSON.stringify(bad.slice(0, 4))}`);

    // 零值可解释性：当日该小类必须有成分份额，否则 0 只是「无数据」的错误写法
    const cache = new Map();
    const presentOn = (d) => {
      let m = cache.get(d);
      if (!m) cache.set(d, (m = shareMap(db, d)));
      return m;
    };
    const unexplained = [];
    for (const z of zeros) {
      const meta = SUB[z.sub];
      if (!meta) unexplained.push({ ...z, reason: "未知小类" });
      else if (meta.etfs.some((e) => presentOn(z.date).get(e.code) != null)) unexplained.push(z);
    }
    assertEq(unexplained.length, 0, `零值但有成分数据 ${unexplained.length} 处：${JSON.stringify(unexplained.slice(0, 4))}`);

    // 最近 20 个有数据的交易日：严格 0 < v
    const dates = [...new Set(rows.filter((r) => r.val != null).map((r) => r.date))].sort();
    const recent = new Set(dates.slice(-20));
    const recentZeros = zeros.filter((z) => recent.has(z.date));
    assertEq(recentZeros.length, 0, `最近 20 个交易日出现零值 ${recentZeros.length} 处：${JSON.stringify(recentZeros.slice(0, 4))}`);

    if (zeros.length) note(`数值范围：${zeros.length} 个零值经核对均为「该小类当日无成分数据」的历史遗留（重算时应写 null）`);
    if (dates.length) note(`数值范围：最新交易日 ${dates.at(-1)}，共 ${dates.length} 个有数据交易日，${SUB ? Object.keys(SUB).length : 0} 个小类`);
  } finally {
    db.close();
  }
});
