#!/usr/bin/env bash
# 安装开机自启 + 每日定时更新（macOS LaunchAgent）
#   · com.etfflow.server：登录即启动服务，崩溃自动拉起（KeepAlive）
#   · com.etfflow.daily ：每个工作日 16:10 跑一次增量更新
#
# 用法：bin/install-autostart.sh
#       bin/install-autostart.sh --dry-run   只渲染 + 校验，不写入 ~/Library/LaunchAgents、不加载
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      echo "用法：$0 [--dry-run]"
      exit 0
      ;;
    *)
      echo "未知参数：$arg（可用 --dry-run）" >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || die "此脚本只适用于 macOS（LaunchAgent）"
[ -n "$NODE_BIN" ] || die "找不到 node，请先安装 Node.js 20 或更新版本"

NODE_VER="$("$NODE_BIN" -v)"; NODE_VER="${NODE_VER#v}"
NODE_MAJOR="${NODE_VER%%.*}"
[ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null || die "node 版本过低（$NODE_VER），需要 20 或更新版本"
[ -f "$ROOT/server.mjs" ] || die "缺少 server.mjs，无法安装服务"
[ -f "$ROOT/bin/update.sh" ] || die "缺少 bin/update.sh，无法安装定时任务"

AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$ROOT/.run"
if [ "$DRY_RUN" = "0" ]; then
  mkdir -p "$AGENTS"
else
  AGENTS="$(mktemp -d "${TMPDIR:-/tmp}/etfflow-agents.XXXXXX")"
  say "• dry-run：渲染到临时目录 $AGENTS"
fi

# ---------- 渲染模板（路径可能含空格，用 node 做替换 + XML 转义，不拼 shell 字符串）----------
render() {
  local tpl="$1" dst="$2"
  [ -f "$tpl" ] || die "缺少模板 $tpl"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const path = require("path");
    const { execFileSync } = require("child_process");
    const [tpl, dst, root, node] = process.argv.slice(1);
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let s = fs.readFileSync(tpl, "utf8");
    s = s
      .replace(/__PATH__/g, esc(root))
      .replace(/__NODE__/g, esc(node))
      .replace(/__NODEDIR__/g, esc(path.dirname(node)));
    const left = (s.match(/__(PATH|NODE|NODEDIR)__/g) || []).length;
    if (left) {
      console.error("模板里还有 " + left + " 个未替换的占位符：" + dst);
      process.exit(1);
    }
    fs.writeFileSync(dst, s);
    // plutil 是系统自带，做结构校验（外部命令用 argv 传路径，含空格也安全）
    execFileSync("/usr/bin/plutil", ["-lint", dst], { stdio: "pipe" });
  ' "$tpl" "$dst" "$ROOT" "$NODE_BIN"
}

install_one() {
  local label="$1" src="$2" dst="$AGENTS/$1.plist"
  say "→ $label"
  render "$src" "$dst" || die "$label 渲染/校验失败"
  say "  模板校验通过：$(/usr/bin/plutil -lint "$dst")"
  if [ "$DRY_RUN" = "1" ]; then
    say "  （dry-run 跳过 launchctl）"
    return 0
  fi
  # 重复安装：先卸载旧的再加载
  launchctl unload "$dst" >/dev/null 2>&1 || true
  if launchctl load -w "$dst" 2>/dev/null; then
    say "  已加载：$dst"
  else
    die "$label 加载失败，可手动执行：launchctl load -w \"$dst\""
  fi
}

install_one "com.etfflow.server" "$ROOT/launchd/com.etfflow.server.plist"
install_one "com.etfflow.daily" "$ROOT/launchd/com.etfflow.daily.plist"

say ""
if [ "$DRY_RUN" = "1" ]; then
  say "✓ dry-run 完成：模板可正确渲染并通过 plutil 校验（未改动系统）"
  say "  渲染结果：$AGENTS"
  exit 0
fi

say "✓ 安装完成"
say "  开机自启服务：com.etfflow.server（登录后自动跑，崩溃自动重启）"
say "  每日更新任务：com.etfflow.daily（工作日 16:10，日志 .run/update.log）"
say ""
say "  查看状态：bin/status.sh"
say "  访问地址：http://localhost:5188"
say "  卸载：    bin/uninstall-autostart.sh"
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:5188 -sTCP:LISTEN >/dev/null 2>&1; then
  say ""
  say "  ⚠ 端口 5188 已被占用（可能是 bin/start.sh 起的实例）："
  lsof -nP -iTCP:5188 -sTCP:LISTEN | tail -n +2 | awk '{print "    " $1 " pid=" $2}'
  say "    两个实例会争抢端口。建议停掉手动实例：bin/stop.sh"
fi
