import { test, assertEq } from "../framework.mjs";
import { putShares, shareMap, shareRows } from "../../lib/db.mjs";
import { tmpDb } from "../helpers.mjs";

test("DB 优先级：交易所（sse/szse）优先于 ts，且不可被 ts 回写覆盖", () => {
  const { db, cleanup } = tmpDb("prio");
  try {
    // ① 先写 ts 再写 sse → 最终是 sse
    const d1 = "2026-01-05";
    putShares(db, d1, { 510300: { wan: 100, src: "ts" } });
    putShares(db, d1, { 510300: { wan: 101, src: "sse" } });
    assertEq(shareMap(db, d1).get("510300"), 101, "sse 应覆盖同日 ts");

    // ② 再用 ts 回写 → 仍是 sse（低优先级不覆盖高优先级）
    putShares(db, d1, { 510300: { wan: 999, src: "ts" } });
    assertEq(shareMap(db, d1).get("510300"), 101, "ts 不得覆盖已存在的 sse");

    // ③ 反向顺序（先 sse 后 ts）→ 保持 sse
    const d2 = "2026-01-06";
    putShares(db, d2, { 510300: { wan: 200, src: "sse" } });
    putShares(db, d2, { 510300: { wan: 201, src: "ts" } });
    assertEq(shareMap(db, d2).get("510300"), 200, "先 sse 后 ts 仍应是 sse");

    // ④ 同源重抓允许更新数值
    putShares(db, d2, { 510300: { wan: 202, src: "sse" } });
    assertEq(shareMap(db, d2).get("510300"), 202, "同源重抓应更新数值");

    // ⑤ 纯数字条目默认 src=ts（且不影响已有的 sse 行）
    const d3 = "2026-01-07";
    putShares(db, d3, { 510300: 300 });
    const row = shareRows(db, d3).find((r) => r.code === "510300");
    assertEq(row.src, "ts", "纯数字条目默认来源");
    assertEq(row.wan, 300, "纯数字条目数值");

    // ⑥ 深市快照与 sse 同优先级：可互相更新，但都高于 ts
    const d4 = "2026-01-08";
    putShares(db, d4, { 159915: { wan: 1, src: "ts" } });
    putShares(db, d4, { 159915: { wan: 2, src: "szse" } });
    assertEq(shareMap(db, d4).get("159915"), 2, "szse 应覆盖 ts");
    putShares(db, d4, { 159915: { wan: 3, src: "ts" } });
    assertEq(shareMap(db, d4).get("159915"), 2, "ts 不得覆盖 szse");

    // ⑦ 非法数值不写库
    putShares(db, d4, { 510500: { wan: NaN, src: "sse" }, 510600: { wan: null, src: "sse" } });
    assertEq(shareMap(db, d4).has("510500"), false, "NaN 不应写库");
    assertEq(shareMap(db, d4).has("510600"), false, "null 不应写库");
  } finally {
    cleanup();
  }
});
