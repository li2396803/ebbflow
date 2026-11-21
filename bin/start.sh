#!/usr/bin/env bash
# 后台启动本地服务（node server.mjs），pid 写入 .run/server.pid，日志追加到 .run/server.log
# 用法：bin/start.sh            默认端口 5188
#       PORT=8080 bin/start.sh  指定端口
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# launchd / 双击运行等最小 PATH 环境下也能找到 node
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "✗ 找不到 node，请先安装 Node.js 20 或更新版本" >&2
  exit 1
fi

PORT="${PORT:-5188}"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
ENTRY="$ROOT/server.mjs"

mkdir -p "$RUN_DIR"

if [ ! -f "$ENTRY" ]; then
  echo "✗ 缺少 $ENTRY，无法启动" >&2
  exit 1
fi

# 已在运行则直接返回（同一时刻只允许一个实例）
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "• 服务已在运行（pid $OLD_PID）→ http://localhost:$PORT"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# 端口占用的友好提示（不阻塞：交给 node 报错也会写进日志）
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "⚠ 端口 $PORT 已被占用："
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | tail -n +2 | awk '{print "    " $1 " pid=" $2}'
    echo "  可换端口启动：PORT=8080 bin/start.sh"
    exit 1
  fi
fi

echo "→ 启动 $NODE_BIN $ENTRY（端口 $PORT）"
PORT="$PORT" nohup "$NODE_BIN" "$ENTRY" >>"$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" >"$PID_FILE"

# 等待服务就绪：/api/status 可用即算成功（首次可能需要先刷新数据）
READY=0
for _ in $(seq 1 60); do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    break
  fi
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
      READY=1
      break
    fi
  else
    sleep 1
    READY=1
    break
  fi
  sleep 0.5
done

if ! kill -0 "$NEW_PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "✗ 启动失败，最近日志：" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  exit 1
fi

if [ "$READY" = "1" ]; then
  echo "✓ 已启动（pid $NEW_PID）→ http://localhost:$PORT"
else
  echo "⚠ 进程已启动（pid $NEW_PID），但 30 秒内未就绪，可能正在刷新数据"
  echo "  稍后查看：bin/status.sh    或    tail -f .run/server.log"
fi
echo "  日志：$LOG_FILE"
