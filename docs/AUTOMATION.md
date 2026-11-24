# 自动更新：现状与兜底方案

## 结论先行

GitHub Actions 的 `schedule`（cron）在本仓库**从未被派发过**，已确认是账号级问题，不是配置问题。
实测证据：

| 检查 | 结果 |
| --- | --- |
| `on.schedule` 在默认分支、YAML 合法、工作流 active | ✅ |
| 建库 3 天内的 `schedule` 运行 | **0 条**（`push` 59、`workflow_dispatch` 41） |
| 改名重注册（`daily.yml` → `update.yml`） | 无效 |
| 探针工作流 `*/5`（35 分钟） | 0 次 |
| **新建私有探针仓库 + `*/5` cron（22 分钟）** | **0 次 → 排除单仓库问题** |

结论：`push` / `workflow_dispatch` 都正常，唯独定时派发这条链路对这个账号不生效。

## 方案 A：外部心跳（推荐，无需开机）

GitHub 负责全部计算，只把「闹钟」外包。任何免费定时服务都行（cron-job.org、Cloudflare Worker…），
每个工作日发两次 POST：

```
POST https://api.github.com/repos/li2396803/ebbflow/actions/workflows/update.yml/dispatches
Authorization: Bearer <PAT>
Accept: application/vnd.github+json
body: {"ref":"master"}
```

- 时间：**22:00**（北京，深市当日快照已出）与 **08:00**（北京，沪市 T+1 发布后）
- PAT：fine-grained，**只选本仓库 + 只勾 `Actions: write`**，有效期按需（90 天）
- 本地验证：`GITHUB_TOKEN=xxx ./bin/ping-update.sh`（成功返回 204）

> 工作流本身不用改：它本来就有 `workflow_dispatch` 入口。

## 方案 B：本机闹钟（无需 token）

macOS 用仓库自带的 launchd 脚本：

```bash
./bin/install-autostart.sh      # 安装每天定时更新
launchctl list | grep ebbflow   # 确认已加载
```

Windows 用任务计划程序，见 `docs/WINDOWS.md`。
缺点：机器得开机联网。

## 方案 C：等 GitHub 修复

保留 `schedule` 配置不动（无害）。若某天调度器恢复，会自动接管，与 A/B 不冲突
（更新是幂等的，多跑只覆盖同样的值）。

## 数据新鲜度自检

```bash
node -e "const m=require('./site/data/meta.json');console.log('最新交易日', m.lastTradeDate)"
curl -s https://li2396803.github.io/ebbflow/data/meta.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('线上', JSON.parse(d).lastTradeDate))"
```

线上日期比最近交易日落后超过一天 → 说明闹钟没响，按上面任一方案补一次。
