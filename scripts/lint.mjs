#!/usr/bin/env node
// 仓库自检（零依赖）——  `npm run lint`
//
// 只做"提交前应该自动拦住"的几件事，不替代 `npm test`（后者校验数据口径）。
// 全部用 Node 原生能力实现：fs / path / child_process(spawnSync)。没有第三方依赖，
// 也不需要联网（git 命令只在本地跑）。
//
// 检查项：
//   1. 无裸 `debugger`（lib/ scripts/ server/）
//   2. 无明文 TUSHARE_TOKEN（扫描"可能被提交"的文件）+ .env 未被 git 跟踪
//   3. 全部 .mjs 通过 `node --check`
//   4. web/index.html 保留构站占位符（__SIGNATURE__ / __REPO__ / __LICENSE__）
//   5. site/ 的入库文件在白名单内（构建产物不夹带私货）
//   6. data/series.json 的 dates 长度 ≥ 1000（冷启动与回归的数据底座）
//
// 输出：✓ 通过 / ✗ 失败 / ⊘ 跳过（环境不具备，不计失败），失败合计 > 0 时退出码 1。
//
// 用法：
//   node scripts/lint.mjs          # 全量自检
//   node scripts/lint.mjs --quiet  # 只打失败项与汇总
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const QUIET = process.argv.includes("--quiet");

/* ------------------------------- 基础设施 ------------------------------- */

const results = [];

/** 跑一条检查。fn 返回 {detail?: string[]} 或抛错；抛错即失败。 */
function check(name, fn, { skipReason = null } = {}) {
  if (skipReason) {
    results.push({ ok: "skip", name, detail: [skipReason] });
    return;
  }
  try {
    const r = fn() ?? {};
    results.push({ ok: true, name, detail: r.detail ?? [] });
  } catch (e) {
    const msg = String(e?.message ?? e);
    const detail = msg.split("\n").filter(Boolean).slice(0, 20);
    results.push({ ok: false, name, detail });
  }
}

const rel = (p) => (path.isAbsolute(p) ? path.relative(ROOT, p) : path.relative(ROOT, path.join(ROOT, p)));

/** 同步执行命令，返回 { status, stdout, stderr, error } */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? null };
}

const hasGit = run("git", ["rev-parse", "--is-inside-work-tree"]).status === 0;

/** git 输出按 NUL 切分（路径可能含空格/中文） */
function gitPaths(args) {
  const r = run("git", args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${(r.stderr || r.error || "").trim()}`);
  return r.stdout.split("\0").filter(Boolean);
}

/**
 * 可能被提交的文件 = 已跟踪文件 + 未跟踪但未被忽略的文件。
 *
 * 刻意不扫 gitignored 的文件（典型是本地 `.env`、`data/etf.db`）：
 * 自检的目的是"别把密钥提交上去"，不是"别在本机保存密钥"——
 * 真正的 `.env` 里有真 token 是设计意图，扫它只会让每个人本地都失败。
 * 若 `.env` 被强制加进 git，它就会出现在这里的列表里并被第 2 项抓住。
 *
 * 不是 git 仓库时（例如解压出来的 tarball）退化为遍历目录，
 * 同样跳过 `.env` / 本地缓存 / 产物目录，尽量不漏扫源码。
 */
function candidateFiles() {
  if (!hasGit) {
    const skipDir = new Set([".git", "node_modules", ".run", "_shots", "_mock", "data", "site"]);
    const out = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!skipDir.has(ent.name)) walk(p);
        } else if (ent.name !== ".env" && !ent.name.startsWith(".env.")) {
          out.push(path.relative(ROOT, p));
        }
      }
    };
    walk(ROOT);
    return out.sort();
  }
  const tracked = gitPaths(["ls-files", "-z"]);
  const untracked = gitPaths(["ls-files", "-o", "--exclude-standard", "-z"]);
  return [...new Set([...tracked, ...untracked])].sort();
}

const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|db|sqlite3?|zip|gz|tgz|mp4|webm|pdf)$/i;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/* ------------------------------ 代码文本工具 ------------------------------ */

/**
 * 把注释、字符串、正则字面量的内容替换成空格（保留换行），
 * 用于"只看真正会执行的 token"。足够应付本仓库的代码风格；不是完整的 JS 词法分析器。
 *
 * 正则字面量靠「前一个有意义字符」判断：出现在 `( , = : [ ! & | ? { ; + - * % < > ~ ^`
 * 之后的 `/` 视为正则开头（除法 `a / b`、`(x) / 2` 的斜杠前面是标识符或右括号，不会误判）。
 */
function stripCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  let quote = null;
  let lastSignificant = "";
  const REGEX_PREV = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += src[i] === "\n" ? "\n" : " ";
        out += n === "\n" ? "\n" : " ";
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        out += " ";
        lastSignificant = '"';
        i++;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += " ";
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      out += "  ";
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (c === "/" && (lastSignificant === "" || REGEX_PREV.has(lastSignificant))) {
      // 正则字面量：跳到未转义的 `/`，字符组 [...] 内的 `/` 不算结束
      i++;
      out += " ";
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") {
          out += src[i + 1] === "\n" ? "\n" : " ";
          out += " ";
          i += 2;
          continue;
        }
        if (ch === "\n") break; // 非法正则，放弃并交回主循环
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        if (ch === "/" && !inClass) {
          out += " ";
          i++;
          break;
        }
        out += " ";
        i++;
      }
      lastSignificant = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out;
}

/** 目录下所有 .mjs（递归，跳过 node_modules / .git / 产物目录） */
function walkFiles(dir, ext, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, ext, acc);
    else if (ent.name.endsWith(ext)) acc.push(p);
  }
  return acc;
}

const mask = (s) => (s.length <= 6 ? "***" : `${s.slice(0, 3)}…${s.slice(-2)}（${s.length} 位，已打码）`);

/* -------------------------------- 检查项 -------------------------------- */

// 1) 裸 debugger
check("lib/ scripts/ server/ 里没有裸 debugger", () => {
  const dirs = ["lib", "scripts", "server"];
  const hits = [];
  for (const d of dirs) {
    for (const file of walkFiles(path.join(ROOT, d), ".mjs")) {
      const code = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
      code.split("\n").forEach((line, i) => {
        if (/(^|[^\w$.])debugger(?![$\w])/.test(line)) hits.push(`${rel(file)}:${i + 1}`);
      });
    }
  }
  if (hits.length) throw new Error(`发现 debugger 语句（提交前请删掉）：\n${hits.join("\n")}`);
  return { detail: [`扫描 ${dirs.map((d) => d + "/").join(" ")} 共 ${dirs.flatMap((d) => walkFiles(path.join(ROOT, d), ".mjs")).length} 个 .mjs`] };
});

// 2a) 明文 token
check('没有明文 TUSHARE_TOKEN（前面是 "=" 或 ":" 的 30+ 位 token 形态）', () => {
  const files = candidateFiles();
  if (!files.length) throw new Error("拿不到文件列表（不是 git 仓库？），无法扫描");
  // Tushare token 形如 40 位十六进制；这里放宽到 30+ 位字母数字，
  // 既覆盖真 token，也不会误伤 `your_token_here` 这类占位符（< 30 位）。
  const patterns = [
    { re: /TUSHARE_TOKEN\s*[=:]\s*["']?([A-Za-z0-9][A-Za-z0-9_.\-]{29,})/g, why: "TUSHARE_TOKEN 赋值" },
    { re: /["']?(?:token|api_?key|secret)["']?\s*[:=]\s*["']([A-Za-z0-9]{32,})["']/gi, why: "疑似密钥字段" },
  ];
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (BINARY_EXT.test(f)) continue;
    const abs = path.join(ROOT, f);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) continue;
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    scanned++;
    for (const { re, why } of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const line = text.slice(0, m.index).split("\n").length;
        hits.push(`${f}:${line}  ${why} → ${mask(m[1])}`);
      }
    }
  }
  if (hits.length) {
    throw new Error(
      `疑似明文密钥（共 ${hits.length} 处）：\n${hits.join("\n")}\n` +
        "处理：从文件里删掉，改用 .env（已 gitignore）或 GitHub Actions Secret。若已提交过，见 SECURITY.md 的轮换流程。"
    );
  }
  return { detail: [`扫描 ${scanned} 个文本文件（已跟踪 + 未跟踪但未忽略；跳过二进制与 >4MB 文件）`] };
});

// 2b) .env 未被跟踪
check(
  ".env 没有被 git 跟踪",
  () => {
    const tracked = gitPaths(["ls-files", "-z"]);
    const bad = tracked.filter((p) => path.basename(p) === ".env" || p === ".env");
    if (bad.length) throw new Error(`.env 已被 git 跟踪：${bad.join(", ")}\n执行：git rm --cached .env，并确认 .gitignore 里有 .env`);
    return { detail: [".gitignore 已包含 .env"] };
  },
  { skipReason: hasGit ? null : "不是 git 仓库，无法判断跟踪状态" }
);

// 3) node --check
check("全部 .mjs 通过 node --check（语法错误 = 一提交就炸）", () => {
  const files = walkFiles(ROOT, ".mjs").filter((f) => !f.includes(`${path.sep}node_modules${path.sep}`));
  const bad = [];
  for (const f of files) {
    const r = run(process.execPath, ["--check", f]);
    if (r.status !== 0) {
      const first = (r.stderr || r.error?.message || "未知错误").split("\n").find((l) => l.trim()) ?? "";
      bad.push(`${rel(f)}: ${first.trim()}`);
    }
  }
  if (bad.length) throw new Error(`语法检查失败 ${bad.length} 个：\n${bad.join("\n")}`);
  return { detail: [`${files.length} 个文件全部通过`] };
});

// 4) 前端占位符
check("web/index.html 保留构站占位符（__SIGNATURE__ / __REPO__ / __LICENSE__）", () => {
  const file = path.join(ROOT, "web", "index.html");
  if (!fs.existsSync(file)) throw new Error("缺少 web/index.html");
  const html = fs.readFileSync(file, "utf8");
  const required = [
    { token: "<!--__SIGNATURE__-->", why: "构站时注入签名/元信息的锚点（lib/signature.mjs）" },
    { token: "__REPO__", why: "仓库地址占位（顶栏与页脚）" },
    { token: "__LICENSE__", why: "协议名占位（页脚）" },
  ];
  const missing = required.filter((r) => !html.includes(r.token));
  if (missing.length) {
    throw new Error(missing.map((m) => `缺少 ${m.token} —— ${m.why}`).join("\n"));
  }
  const count = (t) => html.split(t).length - 1;
  return {
    detail: required.map((r) => `${r.token} × ${count(r.token)}`),
  };
});

// 5) site/ 入库白名单
check(
  "site/ 入库文件只在白名单内（index.html、css/*、js/*、echarts.min.js）",
  () => {
    const allowed = new Set(["site/index.html", "site/echarts.min.js"]);
    const allowedPrefix = ["site/css/", "site/js/", "site/assets/"]; // 前端源码构建产物
    const tracked = gitPaths(["ls-files", "-z", "site"]);
    const extra = tracked.filter((p) => !allowed.has(p) && !allowedPrefix.some((pre) => p.startsWith(pre)));
    if (extra.length) {
      throw new Error(
        `site/ 下出现了不该入库的文件（构建产物请留在本地，已在 .gitignore 里）：\n${extra.join("\n")}\n` +
          "如果确实要新增静态资源，请同步更新本检查的白名单。"
      );
    }
    return { detail: [`已跟踪 ${tracked.length} 个：${tracked.join(", ") || "（无）"}`] };
  },
  { skipReason: hasGit ? null : "不是 git 仓库，读不到 git ls-files site" }
);

// 6) series.json 数据底座
check("data/series.json 的 dates 长度 ≥ 1000", () => {
  const file = path.join(ROOT, "data", "series.json");
  if (!fs.existsSync(file)) throw new Error("缺少 data/series.json（冷启动与回归校验都依赖它）");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`data/series.json 不是合法 JSON：${e.message}`);
  }
  if (!Array.isArray(data.dates)) throw new Error("data/series.json 缺少 dates 数组");
  const n = data.dates.length;
  if (n < 1000) throw new Error(`dates 只有 ${n} 天，少于 1000 —— 数据疑似被截断，别提交`);
  const subs = data.subs && typeof data.subs === "object" ? Object.keys(data.subs).length : 0;
  if (!subs) throw new Error("data/series.json 缺少 subs（小类 → 序列）");
  return { detail: [`${n} 个交易日（${data.dates[0]} ~ ${data.dates.at(-1)}），${subs} 个细分行业`] };
});

/* --------------------------------- 汇总 --------------------------------- */

const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === "skip");
const passed = results.filter((r) => r.ok === true);

const icon = (s) => (s === true ? "✓" : s === false ? "✗" : "⊘");

if (!QUIET) {
  console.log(`\nEbbflow 仓库自检  ·  ${ROOT}`);
  console.log(`node ${process.version}  ·  ${results.length} 项检查\n`);
}
for (const r of results) {
  if (QUIET && r.ok === true) continue;
  console.log(`${icon(r.ok)} ${r.name}`);
  if (r.ok !== true || !QUIET) for (const d of r.detail) console.log(`    ${d}`);
}

console.log("");
if (failed.length) {
  console.log(`✗ ${failed.length} 项失败，${passed.length} 项通过${skipped.length ? `，${skipped.length} 项跳过` : ""}`);
  console.log("  失败项：");
  for (const f of failed) console.log(`    · ${f.name}`);
  process.exit(1);
}
console.log(`✓ ${passed.length} 项全部通过${skipped.length ? `（${skipped.length} 项跳过：${skipped.map((s) => s.name).join("、")}）` : ""}`);
process.exit(0);
