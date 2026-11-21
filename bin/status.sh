#!/usr/bin/env bash
# 打印：进程状态 / 开机自启状态 / 最近一次更新信息 / 访问地址
# 用法：bin/status.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

PORT="${PORT:-5188}"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/server.pid"
MARK="$ROOT/data/last-run.json"
URL="http://localhost:$PORT"

echo "ETF 资金流向 · 本地运行状态"
echo "  项目目录：$ROOT"

# ---------- 进程 ----------
# 只认"第一个参数是 node、且命令行含 server.mjs"的进程，
# 避免误匹配命令行里恰好带着 "server.mjs" 字样的 bash/shell
is_our_server() {
  local p="$1"
  [ -n "${p:-}" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  ps -o command= -p "$p" 2>/dev/null |
    awk 'NR==1 { ok = ($1 ~ /(^|\/)node(js)?$/ && $0 ~ /server\.mjs/) } END { exit ok ? 0 : 1 }'
}

# 该 pid 是否正在监听我们关心的端口（没有 lsof 时退化为只看进程名）
listens_on_port() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -a -p "$1" -iTCP:"$2" -sTCP:LISTEN >/dev/null 2>&1
}

RUNNING_PID=""
if [ -f "$PID_FILE" ]; then
  P="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_our_server "$P"; then
    RUNNING_PID="$P"
  fi
fi
if [ -z "$RUNNING_PID" ] && command -v lsof >/dev/null 2>&1; then
  P="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
  if is_our_server "$P"; then
    RUNNING_PID="$P"
  fi
fi
if [ -z "$RUNNING_PID" ] && command -v pgrep >/dev/null 2>&1; then
  for P in $(pgrep -f "node .*/server\.mjs$" 2>/dev/null || true); do
    if is_our_server "$P" && listens_on_port "$P" "$PORT"; then
      RUNNING_PID="$P"
      break
    fi
  done
fi

if [ -n "$RUNNING_PID" ]; then
  echo "  进程状态：运行中（pid $RUNNING_PID）"
else
  echo "  进程状态：未运行（启动：bin/start.sh）"
fi

# ---------- 开机自启 ----------
if command -v launchctl >/dev/null 2>&1; then
  L_MAIN="未安装"
  L_DAILY="未安装"
  launchctl list 2>/dev/null | grep -q "com\.etfflow\.server" && L_MAIN="已加载"
  launchctl list 2>/dev/null | grep -q "com\.etfflow\.daily" && L_DAILY="已加载"
  echo "  开机自启：服务=$L_MAIN，每日更新=$L_DAILY"
fi

# ---------- 接口健康 ----------
if [ -n "$RUNNING_PID" ] && command -v curl >/dev/null 2>&1; then
  if BODY="$(curl -fsS --max-time 3 "$URL/api/status" 2>/dev/null)"; then
    echo "$BODY" | "$NODE_BIN" -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const j = JSON.parse(s);
          if (j.refreshing) console.log("  服务接口：可访问（正在刷新数据…）");
          else if (j.lastError) console.log("  服务接口：可访问（上次刷新失败：" + j.lastError + "）");
          else console.log("  服务接口：可访问");
        } catch {
          console.log("  服务接口：可访问（响应非 JSON）");
        }
      });
    '
  else
    echo "  服务接口：无响应（进程在但 HTTP 不通，看 .run/server.log）"
  fi
fi

# ---------- 最近一次更新 ----------
echo "  最近更新："
if [ -n "$NODE_BIN" ] && [ -f "$MARK" ]; then
  "$NODE_BIN" -e '
    const fs = require("fs");
    let m = null;
    try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    if (!m || !m.lastRunAt) {
      console.log("    还没有更新记录，先运行 bin/update.sh");
      process.exit(0);
    }
    const fmt = (s) => {
      const d = new Date(s);
      return isNaN(d.getTime()) ? String(s) : d.toLocaleString("zh-CN", { hour12: false });
    };
    console.log("    上次运行：  " + fmt(m.lastRunAt) + "（本次重算 " + (m.recomputed ?? "-") + " 个工作日的原始快照）");
    console.log("    最新交易日：" + (m.latestTradeDate ?? "-"));
    console.log("    数据规模：  " + (m.dates ?? "-") + " 个交易日 / " + (m.subs ?? "-") + " 个细分行业 / " + (m.charts ?? "-") + " 张图表");
    const last = m.latestTradeDate;
    if (last) {
      const days = Math.floor((Date.now() - new Date(last + "T00:00:00Z").getTime()) / 86400000);
      if (days > 3) console.log("    ⚠ 最新交易日距今约 " + days + " 天，数据可能没有刷新（周末/节假日除外）");
    }
  ' "$MARK"
else
  echo "    无记录（data/last-run.json 不存在）"
fi

# ---------- 访问地址 ----------
echo "  访问地址：$URL"
echo "  日志文件：$RUN_DIR/server.log"
