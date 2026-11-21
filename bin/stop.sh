#!/usr/bin/env bash
# 优雅停止服务：先 SIGTERM，最多等 10 秒，仍在则 SIGKILL
# 用法：bin/stop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/server.pid"
PORT="${PORT:-5188}"

# 若服务由 launchd 托管，kill 掉会被 KeepAlive 立刻拉起，先提示
if command -v launchctl >/dev/null 2>&1; then
  if launchctl list 2>/dev/null | grep -q "com\.etfflow\.server"; then
    echo "⚠ 检测到开机自启任务 com.etfflow.server 已加载（KeepAlive=true）"
    echo "  直接 kill 会被 launchd 立刻重启，正确做法是：bin/uninstall-autostart.sh"
    echo "  仍然继续停止本次进程……"
  fi
fi

STOPPED=0

# 只认"第一个参数是 node、且命令行含 server.mjs"的进程，
# 避免误杀命令行里恰好带着 "server.mjs" 字样的 bash/shell
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

# 优雅停止单个 pid
stop_pid() {
  local pid="$1"
  echo "→ 停止服务（pid $pid）"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  echo "⚠ 10 秒内未退出，强制结束"
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.5
}

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_our_server "$PID"; then
    stop_pid "$PID"
    STOPPED=1
  fi
  rm -f "$PID_FILE"
fi

# 没有 pid 文件时兜底（例如 launchd 拉起的实例、或 pid 文件被删）：
# 先找占着端口的进程，再按进程名找
if [ "$STOPPED" = "0" ]; then
  PIDS=""
  if command -v lsof >/dev/null 2>&1; then
    P="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
    if is_our_server "$P"; then
      PIDS="$P"
    fi
  fi
  if [ -z "$PIDS" ] && command -v pgrep >/dev/null 2>&1; then
    for p in $(pgrep -f "node .*/server\.mjs$" 2>/dev/null || true); do
      if is_our_server "$p" && listens_on_port "$p" "$PORT"; then
        PIDS="$PIDS $p"
      fi
    done
  fi
  if [ -n "$PIDS" ]; then
    for p in $PIDS; do
      stop_pid "$p"
    done
    STOPPED=1
  fi
fi

if [ "$STOPPED" = "1" ]; then
  echo "✓ 已停止"
else
  echo "• 服务本来就没在运行"
fi
