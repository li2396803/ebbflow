// 交易所优先 + 哨兵：接口为空时不能把时间轴冻住
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, assertEq, assert } from "../framework.mjs";
import { openDb, putShares, markDaySource, tradingDates } from "../../lib/db.mjs";

function tmpDb(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ebbflow-${tag}-`));
  const file = path.join(dir, "t.db");
  return { db: openDb(file), dir };
}

test("时间轴：沪市官方有数据的日子一定算交易日", () => {
  const { db, dir } = tmpDb("axis-sse");
  try {
    db.prepare("INSERT INTO fund(code,name,market) VALUES('510300','x','SH')").run();
    putShares(db, "2026-11-19", { "510300": { wan: 100, src: "sse" } });
    markDaySource(db, "2026-11-19", "sse");
    assertEq(tradingDates(db).includes("2026-11-19"), true);
  } finally {
    db.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("时间轴：交易所接口挂了但有 Tushare 全量覆盖时，仍算交易日（不冻结）", () => {
  const { db, dir } = tmpDb("axis-ts");
  try {
    const codes = Array.from({ length: 900 }, (_, i) => String(510000 + i));
    for (const c of codes) db.prepare("INSERT INTO fund(code,name,market) VALUES(?,?,'SH')").run(c, "x");
    const rows = Object.fromEntries(codes.map((c) => [c, { wan: 100, src: "ts" }]));
    putShares(db, "2026-11-24", rows);
    db.prepare("INSERT INTO quote(code,date,close,amount) VALUES('510300','2026-11-24',1,1)").run();
    markDaySource(db, "2026-11-24", "ts");
    assertEq(tradingDates(db).includes("2026-11-24"), true, "900 只 + 有行情，应认定为交易日");

    // 季末披露日：覆盖同样够，但没有行情 → 不是交易日
    const rows2 = Object.fromEntries(codes.map((c) => [c, { wan: 100, src: "ts" }]));
    putShares(db, "2023-09-30", rows2);
    markDaySource(db, "2023-09-30", "ts");
    assertEq(tradingDates(db).includes("2023-09-30"), false, "季末披露日无行情，不应算交易日");
  } finally {
    db.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("时间轴：Tushare 只有零星几只的日子不算交易日（防部分日污染）", () => {
  const { db, dir } = tmpDb("axis-partial");
  try {
    const codes = Array.from({ length: 99 }, (_, i) => String(510000 + i));
    for (const c of codes) db.prepare("INSERT INTO fund(code,name,market) VALUES(?,?,'SH')").run(c, "x");
    putShares(db, "2026-11-25", Object.fromEntries(codes.map((c) => [c, { wan: 100, src: "ts" }])));
    markDaySource(db, "2026-11-25", "ts");
    assertEq(tradingDates(db).includes("2026-11-25"), false, "99 只 < 阈值，不应认定为交易日");
  } finally {
    db.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
