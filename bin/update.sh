#!/usr/bin/env bash
# 跑一次增量更新（深交所快照 + 上交所近 15 日 + Tushare 当日 → 重算序列 → 重建 site/），并打印摘要
# v2：入口改为 `npm run update`（= node scripts/update.mjs），全流程输出同时写进 .run/update.log
# 失败会重试一次；带锁，避免与定时任务/服务自动刷新重叠
# 用法：bin/update.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# launchd / 双击运行等最小 PATH 环境下也能找到 node / npm
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "✗ 找不到 node，请先安装 Node.js 22.5 或更新版本（需要内置 node:sqlite）" >&2
  exit 1
fi

# npm 优先用 PATH 里的；没有就找 node 同目录下的那个（launchd 下常见）
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
if [ -z "$NPM_BIN" ] && [ -x "$(dirname "$NODE_BIN")/npm" ]; then
  NPM_BIN="$(dirname "$NODE_BIN")/npm"
fi
if [ -z "$NPM_BIN" ]; then
  echo "✗ 找不到 npm（node 在 $NODE_BIN），请确认 npm 与 node 装在一起" >&2
  exit 1
fi

RUN_DIR="$ROOT/.run"
LOCK_DIR="$RUN_DIR/update.lock"
LOG_FILE="$RUN_DIR/update.log"
# v2 的标记文件名是 data/lastrun.json；data/last-run.json 是 v1 遗留，两种都读
MARK_V2="$ROOT/data/lastrun.json"
MARK_V1="$ROOT/data/last-run.json"
mkdir -p "$RUN_DIR"

# ---------- 日志：整个流程的输出同时写进 .run/update.log（超过 2MB 先截断到最近 500 行）----------
if [ -f "$LOG_FILE" ] && [ "$(wc -c <"$LOG_FILE" | tr -d ' ')" -gt 2000000 ]; then
  tail -n 500 "$LOG_FILE" >"$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi
echo "──── $(date '+%Y-%m-%d %H:%M:%S') bin/update.sh 开始 ────" >>"$LOG_FILE"

# launchd 的 StandardOutPath 已经把 stdout/stderr 写进同一个日志，
# 这种情况下再 tee 就会每行出现两遍，所以先看 fd 1 指向哪
stdout_already_logged() {
  command -v lsof >/dev/null 2>&1 || return 1
  local target
  target="$(lsof -p $$ -a -d 1 -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  [ "${target:-}" = "$LOG_FILE" ]
}
if stdout_already_logged; then
  echo "（stdout 已由父进程写入 $LOG_FILE，本次不重复 tee）"
else
  exec > >(tee -a "$LOG_FILE") 2>&1
fi

# ---------- 互斥锁（进程已死则视为残留锁，自动清理）----------
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  HOLDER="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "${HOLDER:-}" ] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "• 已有一个更新在运行（pid $HOLDER），本次跳过"
    exit 0
  fi
  echo "• 清理残留锁"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi
echo $$ >"$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

# ---------- 执行（网络抖动时重试一次）----------
run_once() {
  "$NPM_BIN" run update --silent
}

# 标记文件里取「本次运行时间」：v2 用 at，v1 用 lastRunAt
read_mark_time() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    for (const f of process.argv.slice(1)) {
      try {
        const m = JSON.parse(fs.readFileSync(f, "utf8"));
        const t = m.at || m.lastRunAt || "";
        if (t) return process.stdout.write(String(t));
      } catch {}
    }
  ' "$MARK_V2" "$MARK_V1" 2>/dev/null || true
}

BEFORE="$(read_mark_time)"
echo "→ 开始更新：$(date '+%Y-%m-%d %H:%M:%S')"
if run_once; then
  OK=1
else
  echo "⚠ 第一次更新失败，5 秒后重试一次……" >&2
  sleep 5
  if run_once; then
    OK=1
  else
    OK=0
  fi
fi

if [ "$OK" != "1" ]; then
  echo "✗ 更新失败（已重试一次）。常见原因：交易所接口暂时不可用 / 断网 / TUSHARE_TOKEN 失效。" >&2
  echo "  本地已有数据不会受影响，重跑 bin/update.sh 或稍后再试。日志：$LOG_FILE" >&2
  exit 1
fi

AFTER="$(read_mark_time)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "⚠ 这次没有产生新的更新记录（多半是本地服务正在同时刷新数据，update.mjs 直接跳过了）。"
  echo "  已有数据与站点未受影响；稍后重跑即可。"
fi

# ---------- 摘要 ----------
echo
echo "──────── 更新摘要 ────────"
MARK=""
for f in "$MARK_V2" "$MARK_V1"; do
  if [ -f "$f" ]; then
    MARK="$f"
    break
  fi
done

if [ -n "$MARK" ]; then
  "$NODE_BIN" -e '
    const fs = require("fs");
    let m = null;
    try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    if (!m) { console.log("（读不到 " + process.argv[1] + "）"); process.exit(0); }
    // v2: {at,lastTradeDate,dates,ms,warnings}；v1: {lastRunAt,latestTradeDate,recomputed,dates,subs,charts}
    const fmt = (s) => {
      if (!s) return "-";
      const d = new Date(s);
      return isNaN(d.getTime()) ? String(s) : d.toLocaleString("zh-CN", { hour12: false });
    };
    const last = m.lastTradeDate || m.latestTradeDate || "-";
    const ms = Number.isFinite(m.ms) ? "（用时 " + (m.ms / 1000).toFixed(1) + "s）" : "";
    console.log("  上次运行：  " + fmt(m.at || m.lastRunAt) + ms);
    console.log("  最新交易日：" + last + (m.recomputed != null ? "（本次重算 " + m.recomputed + " 天）" : ""));
    console.log("  数据规模：  " + (m.dates ?? "-") + " 个交易日");
    if (m.warnings && m.warnings.length) console.log("  告警：      " + m.warnings.join(" | "));
  ' "$MARK"
else
  echo "  （没有生成 data/lastrun.json）"
fi
echo "  站点已重建：site/index.html（+ site/data/*.json）"
echo "  本地服务若在运行，刷新浏览器即可看到新数据：http://localhost:${PORT:-5188}"
echo "  日志：$LOG_FILE"
