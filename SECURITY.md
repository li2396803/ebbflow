# 安全策略

## 支持范围

本项目是单人维护的小工具，**只维护主干（`master`）上的最新代码**：

| 版本 | 是否接受安全修复 |
| --- | --- |
| `master` 最新提交（v3.x 开发线） | ✅ |
| 已发布的旧版本标签（v1.x / v2.x） | ❌ 请先升级到最新 `master` |
| Fork 出来的个人副本 | ❌ 请联系该 fork 的维护者 |

项目**零运行时依赖**（`dependencies` 与 `devDependencies` 均为空），所以不存在「依赖 CVE 升级」这条常见路径；
主要风险集中在**凭据管理**、**服务暴露**、**前端注入**与**数据源合规**四块。

---

## 如何报告漏洞

**请不要开公开 Issue。** 公开披露会让正在使用本项目的部署在补丁发布前暴露。

优先使用 GitHub 的私密通道：

1. 打开 <https://github.com/li2396803/etf-flow/security>；
2. 点 **Report a vulnerability**（GitHub Security Advisory）；
3. 写清：影响版本/提交、复现步骤、影响面、你建议的修复方向（可选）。

如果你无法使用上面的通道，可以开一个 Issue，但**标题只写「请求私下联系：安全问题」**，
不要在正文里描述细节，维护者会尽快联系你。

我们尽量做到：

- **3 个工作日内**确认收到（人工维护，无 SLA）；
- 7 个工作日内给出初步评估与修复计划；
- 修复发布后，如果你愿意，会在 `CHANGELOG.md` 里致谢（默认匿名）。

### 哪些算安全问题

- 本地服务（`server/app.mjs`）的路径穿越、任意文件读取、注入
- 前端 XSS（例如把数据源返回的字符串直接拼进 `innerHTML`）
- 凭据泄露：`.env` / `TUSHARE_TOKEN` / GitHub Secret 被写入仓库或日志
- 构站/发布流程可被投毒（workflow 权限过大、`pull_request_target` 误用等）
- 数据源接口的误用导致他人凭据或数据被暴露

### 哪些**不算**安全问题（请走对应渠道）

| 情况 | 去哪里 |
| --- | --- |
| 数据数值不对、与原站/其他平台不一致 | 数据问题模板（`.github/ISSUE_TEMPLATE/data_issue.yml`） |
| 部署/配置跑不起来、报错 | Issue（bug 模板）或 `docs/` 自查 |
| 「这个 token 能不能借我用」 | 不发。请自己注册 Tushare |
| 站点能不能商用/是否构成投资建议 | 见 `README.md` 的免责声明与 `LICENSE`（MIT） |
| GitHub 平台本身的问题 | GitHub Support |

---

## 敏感信息（TUSHARE_TOKEN）

### 设计上的约定

- token 只允许存在于两处：**本地 `.env`**（已 gitignore）或 **GitHub Actions Secret**。
- 代码从 `process.env.TUSHARE_TOKEN` 读取，其次读项目根 `.env`；**任何情况下都不写回磁盘、不打印**。
- `scripts/lint.mjs` 会扫描「可能被提交的文件」，命中 `TUSHARE_TOKEN=` 后接 30+ 位字符就判失败，
  并检查 `.env` 是否被 git 跟踪。
- CI 日志里 GitHub 会自动对 Secret 打码；但**你自己 `echo` 出来的 token 不会**（不要这么做）。

### 如果你不小心提交了 token

按顺序做完，不要只删文件就算了（历史里还在）：

```bash
# 1) 立刻让旧 token 失效：去 https://tushare.pro/user/token 重置/重新生成
#    （这一步最重要 —— 只要它还有效，写进历史就等于公开）

# 2) 更新 GitHub Secret：Settings → Secrets and variables → Actions → TUSHARE_TOKEN → Update

# 3) 从工作区与历史里移除
git rm --cached .env                 # 若只是被误 add
# 若已提交进历史，用 git-filter-repo（推荐）或 BFG 重写：
#   git filter-repo --path .env --invert-paths
#   git push --force --all
#   git push --force --tags

# 4) 通知 GitHub 清理缓存与 fork：
#    - 联系 GitHub Support 请求清理不可达对象缓存（重写历史上传后仍可能被缓存）
#    - 若仓库已被 fork，提醒 fork 的维护者同步（fork 不会自动跟随历史重写）

# 5) 复查
node scripts/lint.mjs        # 应显示「没有明文 TUSHARE_TOKEN」
git log -p --all -S 'TUSHARE_TOKEN=' | head    # 确认历史里没有残留
```

> 经验：token 一旦被推到公开仓库，**视为已泄露**。重置 token 是唯一可靠的补救，
> 清理历史只是为了让后来 clone 的人看不到。

### 其它凭据

- 本项目的服务**没有鉴权**，也不接受任何用户凭据；不要把 `server/` 部署到公网。
- 不要提交 `.run/`（可能含日志里的 URL 与错误详情）、`data/lastrun.json`、`data/etf.db`（可能含调用计数）。

---

## 数据源合规

本项目只是**数据的搬运与聚合**，不对数据源做二次分发承诺：

- **抓取频率**：每日一次增量、并发 ≤ 6、Tushare 走令牌桶（默认 120 次/分钟）与预算（单次 800 / 每日 4000）。
  请勿改成高频轮询、并发轰炸或绕过限流；这是项目能长期免费运行的前提。
- **服务条款**：使用 Tushare Pro 需遵守其[服务条款](https://tushare.pro/)；交易所公开接口按其使用要求访问。
  **不要把 Tushare 的原始数据做成公开的下载站或数据服务**（这通常超出其授权范围）。
- **账号安全**：一个账号一个 token；不要把 token 分享给他人，也不要在多台机器上共用同一份 `.env` 副本。
- **免责**：数据仅供参考，不构成投资建议；因数据延迟、缺失或口径差异导致的决策后果由使用者承担。

---

## 部署侧建议

- 服务只绑 `127.0.0.1`（默认如此），不要改成 `0.0.0.0`，也不要做公网端口映射。
- 静态站点可以公开托管（GitHub Pages 即可），但**不要**把本地 `.env`、`data/etf.db` 一起发布。
- 如果要长期自建：把 token 放进运行环境的 secret（systemd `EnvironmentFile` / launchd plist 权限 600），
  不要在 `bash` 里明文 `export` 后忘了历史记录。
