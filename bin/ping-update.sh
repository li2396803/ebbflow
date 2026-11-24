#!/usr/bin/env bash
# 手动/外部定时触发一次云端更新（等价于网页上点 "Run workflow"）
# 用法：GITHUB_TOKEN=xxx ./bin/ping-update.sh
#   GITHUB_TOKEN 需要 fine-grained PAT：只选本仓库，只勾 Actions: write
set -euo pipefail
REPO="${REPO:-li2396803/ebbflow}"
WF="${WF:-update.yml}"
REF="${REF:-master}"
: "${GITHUB_TOKEN:?请设置 GITHUB_TOKEN（fine-grained PAT，Actions: write）}"
code=$(curl -sS -o /tmp/ping.out -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/actions/workflows/${WF}/dispatches" \
  -d "{\"ref\":\"${REF}\"}")
if [ "$code" = "204" ]; then
  echo "已触发 ${REPO} ${WF} @ ${REF}"
else
  echo "触发失败 HTTP ${code}"; cat /tmp/ping.out; exit 1
fi
