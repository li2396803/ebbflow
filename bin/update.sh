#!/usr/bin/env bash
# 跑一次增量更新（抓交易所 → 重算 86 个细分行业 → 重建 site/），并打印摘要
# 失败会重试一次；带锁，避免与定时任务/服务自动刷新重叠
# 用法：bin/update.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "✗ 找不到 node，请先安装 Node.js 20 或更新版本" >&2
  exit 1
fi

RUN_DIR="$ROOT/.run"
LOCK_DIR="$RUN_DIR/update.lock"
MARK="$ROOT/data/last-run.json"
mkdir -p "$RUN_DIR"

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
  "$NODE_BIN" scripts/update.mjs
}

# 记录更新前的 lastRunAt，用于识别"本次其实没跑成"（update.mjs 自带进程内锁，可能直接跳过）
read_mark_time() {
  "$NODE_BIN" -e '
    try {
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(m.lastRunAt || ""));
    } catch {}
  ' "$MARK" 2>/dev/null || true
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
  echo "✗ 更新失败（已重试一次）。常见原因：交易所接口暂时不可用 / 断网。" >&2
  echo "  本地已有数据不会受影响，重跑 bin/update.sh 或稍后再试。" >&2
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
if [ -f "$MARK" ]; then
  "$NODE_BIN" -e '
    const fs = require("fs");
    let m = null;
    try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    if (!m) { console.log("（读不到 data/last-run.json）"); process.exit(0); }
    const fmt = (s) => {
      const d = new Date(s);
      return isNaN(d.getTime()) ? String(s) : d.toLocaleString("zh-CN", { hour12: false });
    };
    console.log("  上次运行：  " + fmt(m.lastRunAt));
    console.log("  最新交易日：" + (m.latestTradeDate ?? "-") + "（本次重算 " + (m.recomputed ?? "-") + " 天）");
    console.log("  数据规模：  " + (m.dates ?? "-") + " 个交易日 / " + (m.subs ?? "-") + " 个细分行业 / " + (m.charts ?? "-") + " 张图表");
  ' "$MARK"
else
  echo "  （没有生成 data/last-run.json）"
fi
echo "  站点已重建：site/index.html"
echo "  本地服务若在运行，刷新浏览器即可看到新数据：http://localhost:${PORT:-5188}"
