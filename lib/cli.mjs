// 跨平台命令行小工具：入口判断、项目根目录、调用本地可执行文件（Windows 兼容）
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const IS_WINDOWS = process.platform === "win32";

/**
 * 当前模块是否被直接执行（node xx.mjs）。
 * 不能用 `file://${process.argv[1]}` 拼接：Windows 下 argv[1] 是 `F:\dir\x.mjs`，
 * 拼出来是 `file://F:\dir\x.mjs`，与 import.meta.url 的 `file:///F:/dir/x.mjs` 永远不相等。
 */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

/** 读 UTF-8 文本并去掉 BOM：Windows 记事本 / PowerShell 重定向默认可能带 BOM，会让 JSON.parse 与首行正则失效 */
export function readUtf8(file) {
  const s = fs.readFileSync(file, "utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 读 JSON，容忍 BOM */
export function readJsonFile(file) {
  return JSON.parse(readUtf8(file));
}

/** 由 import.meta.url 求项目根目录（不要用 URL.pathname，Windows 会得到 /F:/...） */
export function projectRoot(metaUrl, depth = 2) {
  let dir = path.dirname(fileURLToPath(metaUrl));
  for (let i = 1; i < depth; i++) dir = path.dirname(dir);
  return dir;
}

/**
 * 调用 node_modules 里的可执行文件（vite 等）。
 * Windows 下 npm 生成的是 `vite.cmd`，直接 spawn 无扩展名会 ENOENT，所以：
 * · 优先用 node_modules/.bin/vite(.cmd)；
 * · Windows 需要 shell: true，才能执行 .cmd；
 * · 都找不到时退回 npx（同样处理扩展名）。
 */
function runOrHint(cmd, args, opts) {
  try {
    return execFileSync(cmd, args, opts);
  } catch (e) {
    const err = new Error(
      `${cmd} 执行失败：${e?.message || e}\n` +
        "提示：先运行 npm install（Windows 下 npm 生成的是 .cmd 包装，直接调用无扩展名会 ENOENT）。"
    );
    err.cause = e;
    throw err;
  }
}

export function runLocalBin(root, bin, args = [], opts = {}) {
  const candidates = IS_WINDOWS ? [`${bin}.cmd`, bin] : [bin];
  for (const name of candidates) {
    const p = path.join(root, "node_modules", ".bin", name);
    if (fs.existsSync(p)) {
      // Windows 用 shell 才能执行 .cmd；路径含空格时必须加引号，否则 cmd 会把路径截断
      const target = IS_WINDOWS && /\s/.test(p) ? `"${p}"` : p;
      return runOrHint(target, args, { stdio: "inherit", cwd: root, shell: IS_WINDOWS, ...opts });
    }
  }
  const npx = IS_WINDOWS ? "npx.cmd" : "npx";
  return runOrHint(npx, [bin, ...args], { stdio: "inherit", cwd: root, shell: IS_WINDOWS, ...opts });
}
