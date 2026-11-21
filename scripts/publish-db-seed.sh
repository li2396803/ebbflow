#!/usr/bin/env bash
# 把当前 data/etf.db 压缩后发布成 GitHub Release 资产（tag: db-seed），
# 让 fork 出来的仓库在 CI 冷启动时直接下载种子，不必等 30 分钟全量回补。
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${REPO:-li2396803/ebbflow}"
TAG="${TAG:-db-seed}"

[ -f data/etf.db ] || { echo "缺少 data/etf.db"; exit 1; }

# WAL 先落盘，避免快照丢最新事务
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("data/etf.db");d.exec("PRAGMA wal_checkpoint(TRUNCATE)");d.close()'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gzip -9 -c data/etf.db > "$TMP/etf-db.sqlite.gz"
SIZE=$(du -h "$TMP/etf-db.sqlite.gz" | cut -f1)

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$TMP/etf-db.sqlite.gz" --repo "$REPO" --clobber
else
  gh release create "$TAG" --repo "$REPO" --title "数据库种子（供 CI 冷启动）" \
    --notes "自动生成：把 data/etf.db 压缩后供 GitHub Actions 冷启动下载，避免 30 分钟全量回补。含全部历史份额/净值/行情。" \
    "$TMP/etf-db.sqlite.gz"
fi
echo "已发布数据库种子（$SIZE）到 $REPO@$TAG"
