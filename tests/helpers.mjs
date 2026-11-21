// 测试用公共工具：临时库、构造份额快照
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../lib/db.mjs";
import { ALL_CODES, SUB } from "../lib/taxonomy.mjs";

const TMP_BASE = path.join(os.tmpdir(), "ebbflow-tests");

/** 建一个临时 DB（不碰 data/etf.db），返回 {db, file, cleanup} */
export function tmpDb(tag = "t") {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const file = path.join(TMP_BASE, `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`);
  const db = openDb(file);
  const cleanup = () => {
    try {
      db.close();
    } catch {}
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
  };
  return { db, file, cleanup };
}

/** 全部 773 只标的都给同一个值 */
export function flatShares(wan = 1000) {
  const m = new Map();
  for (const c of ALL_CODES) m.set(c, wan);
  return m;
}

/** 某小类的全部成分代码 */
export function subCodes(sub) {
  return SUB[sub].etfs.map((e) => e.code);
}
