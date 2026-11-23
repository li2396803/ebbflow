// 跨平台回归：Windows 首次启动相关的三处坑（入口判断、空库 payload、路径推导）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, assert, assertEq } from "../framework.mjs";
import { isMain, projectRoot } from "../../lib/cli.mjs";

test("跨平台：入口判断在 Windows 路径下也能识别直接执行", () => {
  // 正例：本文件的 URL 与解析后的 argv[1] 一致
  const self = pathToFileURL(path.resolve(fileURLToPath(import.meta.url))).href;
  assertEq(self, import.meta.url, "路径解析应幂等");

  // 通过临时改写 argv[1] 模拟「直接执行本文件」与「被别的入口 import」两种情形
  const saved = process.argv[1];
  try {
    process.argv[1] = fileURLToPath(import.meta.url);
    assertEq(isMain(import.meta.url), true, "argv[1] 指向自身时应判定为入口");

    process.argv[1] = path.join(os.tmpdir(), "not-this-file.mjs");
    assertEq(isMain(import.meta.url), false, "argv[1] 指向别的文件时应判定为非入口");

    process.argv[1] = "";
    assertEq(isMain(import.meta.url), false, "没有 argv[1]（如被 import）时应判定为非入口");
  } finally {
    process.argv[1] = saved;
  }
});

test("跨平台：projectRoot 不依赖 URL.pathname（Windows 会得到 /F:/…）", () => {
  const root = projectRoot(pathToFileURL(path.join(os.tmpdir(), "a", "scripts", "x.mjs")).href);
  assertEq(root, path.join(os.tmpdir(), "a"), "应回退两级目录");
  assert(root.startsWith(os.tmpdir()), "根目录应为真实文件系统路径");
  assert(!root.startsWith("/C:") && !root.startsWith("/F:"), "不应出现 /盘符: 形式的伪路径");
});

test("空库：payload 生成不抛异常，且标记 initialized=false", async () => {
  const { openDb } = await import("../../lib/db.mjs");
  const { buildAllPayloads } = await import("../../lib/payloads.mjs");
  const { loadUniverse } = await import("../../lib/universe.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ebbflow-empty-"));
  const file = path.join(dir, "empty.db");
  const db = openDb(file);
  try {
    const p = buildAllPayloads(db, { universe: loadUniverse({ taxonomy: "v2" }) });
    assertEq(p.meta.initialized, false, "空库应标记 initialized=false");
    assertEq(p.meta.lastTradeDate, null, "空库没有最新交易日");
    assertEq(p.meta.counts.etfs > 0, true, "分类口径本身仍然可用（用于展示有哪些小类）");
    assertEq(p.market, null, "空库不产出市场聚合");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
