#!/usr/bin/env node
// 生成物冲突自动重建（P1-10）
//
//   node scripts/repair-generated.mjs            # 等价 --check：发现冲突标记就退出 1
//   node scripts/repair-generated.mjs --fix      # 能重建的就重建，重建不了的明确报错
//
// 背景：data/series.json、data/quality.json、site/* 都是「生成物」，
// 一旦被 git 合并冲突（出现过 `<<<<<<<` 被提交进仓库的事故），JSON 会整体失效。
// 处理原则：
//   · 能由本地数据确定性重建的 → 直接重建（series.json ← series 表；validation-origin.json 需要原站副本）
//   · 由联网流水线产生的（quality.json）→ 先尝试取 git 里的完整版本；再不行就写合法占位并提示下次 reconcile 覆盖
//   · 无法安全重建的（site/index.html 等前端产物）→ 只报错，不猜测，交给 npm run build
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot, readJsonFile } from "../lib/cli.mjs";
import { openDb, tradingDates } from "../lib/db.mjs";
import { exportSeriesJson } from "../lib/pipeline.mjs";

// --root 指定项目根目录（测试用；默认按脚本位置推断）
const rootIdx = process.argv.indexOf("--root");
const ROOT = rootIdx > 0 ? path.resolve(process.argv[rootIdx + 1]) : projectRoot(import.meta.url);
const FIX = process.argv.includes("--fix");
const CONFLICT_RE = /^(<{7}|={7}|>{7})(\s|$)/m;

const FILES = [
  { rel: "data/series.json", kind: "series" },
  { rel: "data/quality.json", kind: "quality" },
  { rel: "data/validation-origin.json", kind: "origin" },
  { rel: "site/index.html", kind: "html" },
];

function conflictLines(txt) {
  const out = [];
  txt.split("\n").forEach((line, i) => {
    if (/^(<{7}|={7}|>{7})(\s|$)/.test(line)) out.push(`${i + 1}: ${line.slice(0, 40)}`);
  });
  return out;
}

function scan() {
  const hits = [];
  for (const f of FILES) {
    const abs = path.join(ROOT, f.rel);
    if (!fs.existsSync(abs)) continue;
    const txt = fs.readFileSync(abs, "utf8");
    if (CONFLICT_RE.test(txt)) hits.push({ ...f, lines: conflictLines(txt).slice(0, 3) });
  }
  return hits;
}

/** 从 git 取一个文件的完整版本（当前索引/HEAD），用于无法本地重建的生成物 */
function fromGit(rel) {
  for (const spec of [`HEAD:${rel}`, `:${rel}`]) {
    const r = spawnSync("git", ["show", spec], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && r.stdout && !CONFLICT_RE.test(r.stdout)) {
      try {
        JSON.parse(r.stdout);
        return r.stdout;
      } catch {
        /* 不是合法 JSON，继续尝试下一个来源 */
      }
    }
  }
  return null;
}

function writeAtomic(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
}

const hits = scan();
if (!hits.length) {
  console.log("✓ 生成物无 git 冲突标记（data/series.json / data/quality.json / data/validation-origin.json / site/index.html）");
  process.exit(0);
}

console.log(`✗ 发现 ${hits.length} 个生成物带 git 冲突标记：`);
for (const h of hits) console.log(`  · ${h.rel}  ${h.lines.join(" | ")}`);

if (!FIX) {
  console.log("\n处理：node scripts/repair-generated.mjs --fix（能重建的会自动重建）");
  process.exit(1);
}

// —— --fix ——
let db = null;
const getDb = () => {
  if (db) return db;
  try {
    db = openDb(path.join(ROOT, "data", "etf.db"));
    return db;
  } catch {
    return null;
  }
};

const fixed = [];
const failed = [];
for (const h of hits) {
  const abs = path.join(ROOT, h.rel);
  if (h.kind === "series") {
    const d = getDb();
    const days = d ? tradingDates(d).length : 0;
    if (d && days >= 1000) {
      if (exportSeriesJson(d, abs)) {
        fixed.push(`${h.rel}（从数据库重建：${days} 个交易日）`);
        continue;
      }
      failed.push(`${h.rel}（重建被拒：导出结果明显短于文件现有内容）`);
      continue;
    }
    const backup = fromGit(h.rel);
    if (backup) {
      writeAtomic(abs, backup);
      fixed.push(`${h.rel}（本地库不足 ${days} 个交易日，已从 git 恢复）`);
      continue;
    }
    failed.push(`${h.rel}（本地库可用交易日 ${days} < 1000，且 git 里没有完整版本）`);
    continue;
  }
  if (h.kind === "quality" || h.kind === "origin") {
    const backup = fromGit(h.rel);
    if (backup) {
      writeAtomic(abs, backup);
      fixed.push(`${h.rel}（已从 git 恢复完整版本，下一次流水线会覆盖）`);
      continue;
    }
    if (h.kind === "quality") {
      // reconcile 每次都会重写这个文件；这里只写一个合法占位，避免站点读到坏 JSON
      const stub = {
        generatedAt: new Date().toISOString(),
        days: [],
        summary: { compared: { both: 0, identical: 0, le0_1: 0, le1: 0, gt1: 0, onlyExchange: 0, onlyTs: 0 }, note: "冲突后重建的占位文件，等待下一次 reconcile 覆盖" },
      };
      writeAtomic(abs, JSON.stringify(stub));
      fixed.push(`${h.rel}（git 无完整版本，已写合法占位，下次 reconcile 覆盖）`);
      continue;
    }
    failed.push(`${h.rel}（git 里没有完整版本；请重跑 npm run verify:origin）`);
    continue;
  }
  failed.push(`${h.rel}（前端产物无法离线重建；请重跑 npm run build）`);
}

for (const f of fixed) console.log(`  ✓ ${f}`);
for (const f of failed) console.log(`  ✗ ${f}`);
try {
  db?.close();
} catch {}
if (failed.length) {
  console.log(`\n✗ ${failed.length} 个文件需要人工处理`);
  process.exit(1);
}
console.log(`\n✓ 已修复 ${fixed.length} 个文件；再跑一次 --check 确认`);
process.exit(0);
