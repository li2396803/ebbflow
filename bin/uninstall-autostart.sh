#!/usr/bin/env bash
# 卸载开机自启 + 每日定时更新（macOS LaunchAgent）
#   只删除 ~/Library/LaunchAgents 下的 com.etfflow.*.plist，不动项目文件和数据
# 用法：bin/uninstall-autostart.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

AGENTS="$HOME/Library/LaunchAgents"
REMOVED=0

for label in com.etfflow.server com.etfflow.daily; do
  PLIST="$AGENTS/$label.plist"
  if [ -f "$PLIST" ]; then
    echo "→ 卸载 $label"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    REMOVED=1
  elif launchctl list 2>/dev/null | grep -q "$label"; then
    echo "→ $label 已加载但找不到 plist，尝试按标签卸载"
    launchctl remove "$label" >/dev/null 2>&1 || true
    REMOVED=1
  else
    echo "• $label 未安装"
  fi
done

echo ""
if [ "$REMOVED" = "1" ]; then
  echo "✓ 已卸载（服务进程随任务卸载而停止）"
else
  echo "• 没有需要卸载的任务"
fi
echo "  项目文件与数据均保留；如需彻底清理，删除 .run/ 即可"
echo "  手动启动：bin/start.sh    查看：bin/status.sh"
