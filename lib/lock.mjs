// 更新互斥锁：目录锁 + pid 存活检测（可单测，不依赖网络/数据库）
//
// 设计要点（对应事故复盘里的"CI 与本地并发""被 Ctrl-C 杀掉的残留锁"）：
//   · 目录原子创建（mkdir 是原子操作，跨平台可用），锁内写 `pid` 与 `startedAt`
//   · 持有进程已死 → 立刻清理；没有 pid 文件的旧格式锁 → 超过 legacyStaleMs 按残留处理
//   · 持有进程仍活着 → 拒绝，并给出 pid 与已持有时长，而不是白等到超时
//   · 只做「同机互斥」；跨机（CI 与本地同时跑）靠 GitHub Actions 的 concurrency group，
//     真正防写坏数据库的是 SQLite 的 WAL + busy_timeout（见 lib/db.mjs）
import fs from "node:fs";
import path from "node:path";

export const LOCK_DIR = path.join("data", ".update.lock");

/** 进程是否还活着（EPERM 说明存在但无权限 → 当作活着） */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function lockPath(root) {
  return path.join(root, LOCK_DIR);
}

/**
 * 读锁状态（不修改任何东西）。
 * @returns {{held:boolean, pid:number|null, ageMs:number|null, alive:boolean|null, startedAt:string|null}}
 */
export function lockInfo(root, now = Date.now()) {
  const dir = lockPath(root);
  let ageMs = null;
  try {
    ageMs = Math.max(0, now - fs.statSync(dir).mtimeMs);
  } catch {
    return { held: false, pid: null, ageMs: null, alive: null, startedAt: null };
  }
  let pid = null;
  let startedAt = null;
  try {
    const raw = fs.readFileSync(path.join(dir, "pid"), "utf8").trim();
    const n = Number(raw);
    pid = Number.isInteger(n) && n > 0 ? n : null;
  } catch {}
  try {
    startedAt = fs.readFileSync(path.join(dir, "startedAt"), "utf8").trim() || null;
  } catch {}
  return { held: true, pid, ageMs, alive: pid == null ? null : pidAlive(pid), startedAt };
}

/**
 * 抢锁。
 * @param {string} root 项目根目录
 * @param {{pid?:number, now?:number, staleMs?:number, legacyStaleMs?:number}} [opts]
 * @returns {{ok:boolean, reason?:string, holder?:number|null, cleaned?:string|null}}
 */
export function acquireLock(root, opts = {}) {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? 15 * 60 * 1000;
  const legacyStaleMs = opts.legacyStaleMs ?? 2 * 60 * 1000;
  const dir = lockPath(root);

  const create = () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true }); // 父目录（data/）可能还不存在；dirname 不能用 recursive，否则失去原子性
    fs.mkdirSync(dir);
    try {
      fs.writeFileSync(path.join(dir, "pid"), String(pid));
      fs.writeFileSync(path.join(dir, "startedAt"), new Date(now).toISOString());
    } catch {}
  };

  try {
    create();
    return { ok: true };
  } catch {
    const info = lockInfo(root, now);
    const dead = info.pid != null && info.alive === false;
    // 没有 pid 文件的旧格式锁：只要不是刚创建（可能正被写），就按残留处理
    const legacyStale = info.pid == null && (info.ageMs ?? 0) > legacyStaleMs;
    const expired = (info.ageMs ?? 0) > staleMs;
    if (dead || legacyStale || expired) {
      let cleaned = dead ? `持有进程 ${info.pid} 已不存在` : legacyStale ? "旧格式锁残留" : `锁已超过 ${Math.round(staleMs / 60000)} 分钟`;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        create();
        return { ok: true, cleaned };
      } catch {
        return { ok: false, reason: "另一个更新刚好抢先启动", holder: info.pid ?? null };
      }
    }
    const heldSec = info.ageMs == null ? "?" : Math.round(info.ageMs / 1000);
    return {
      ok: false,
      reason: `另一个更新正在进行中（pid=${info.pid ?? "未知"}，已持有 ${heldSec}s）`,
      holder: info.pid ?? null,
    };
  }
}

/** 释放锁；失败只告警不抛（Windows 下杀软/索引可能短暂占用目录句柄） */
export function releaseLock(root, warn = () => {}) {
  try {
    fs.rmSync(lockPath(root), { recursive: true, force: true });
    return true;
  } catch (e) {
    warn(`[lock] 释放失败（可手动删除 ${lockPath(root)}）：${e?.message || e}`);
    return false;
  }
}
