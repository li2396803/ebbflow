# Fork 与自建部署

本仓库的每日数据更新依赖 **Tushare Pro**（数据源只有两个：上交所 + Tushare）。Fork 之后 **必须自己配一个 token**：
**GitHub Actions 会在第一步就检查它，缺失直接失败**（避免你拿到一份「只有沪市、没有金额口径」的半成品）。
下面的 6 步做完，你就会拥有一个「每天北京时间 16:30 自动更新 + 自动发布」的私有站点。

> 前提：Node.js ≥ 22.5（本地跑才需要），GitHub 账号，以及一个能注册 Tushare 的邮箱/手机号。
> 仓库是 public 时，GitHub Actions 与 Pages 对公开仓库免费；private 仓库开 Pages 需要付费套餐。

---

## 0. 先看这张总览

| 步骤 | 在哪做 | 产物 / 判据 |
| --- | --- | --- |
| ① Fork | GitHub 仓库页右上角 | 你名下出现 `your-name/etf-flow` |
| ② 拿 token | https://tushare.pro | 一串 40 位左右的 token |
| ③ 配 Secret | 仓库 Settings → Secrets and variables → Actions | 列表里出现 `TUSHARE_TOKEN` |
| ④ 开 Actions | 仓库 Actions 标签页 | 出现三条工作流，可手动运行 |
| ⑤ 手动跑一次 | Actions → Daily data update → Run workflow | 该次运行全绿，且产生一次数据提交 |
| ⑥ 开 Pages | Settings → Pages → Source = GitHub Actions | 站点 URL 可访问 |

---

## 1. Fork 仓库

1. 打开 <https://github.com/li2396803/etf-flow>。
2. 右上角 **Fork** → 选择自己的账号 → **Create fork**。
3. 建议同时把 fork 的 **default branch** 保持为 `master`（`daily.yml` 的部署条件写的是 `refs/heads/master`）。

拿到仓库后**先不要**急着开 Pages —— 没有数据和构建产物，Pages 只会显示 404。

```bash
git clone https://github.com/<你的账号>/etf-flow.git
cd etf-flow
node -v          # 需要 ≥ 22.5，推荐 22 LTS
npm test         # 先确认本地能跑通（10 个用例）
```

---

## 2. 注册 Tushare 并拿到 token

1. 打开 <https://tushare.pro>，注册并登录（需要手机号/邮箱验证）。
2. 进入 **个人主页 → 接口 TOKEN**（或直接打开 <https://tushare.pro/user/token>）。
3. 复制那串 token，**不要**贴进任何会被提交的文件、聊天记录或截图。

> Tushare 的部分接口有积分门槛，`fund_share` / `fund_nav` 的具体要求以官方文档为准。
> 如果调用返回权限类错误，先确认账号积分是否足够，再确认 token 是否复制完整。

验证 token 是否可用（可选，联网）：

```bash
TUSHARE_TOKEN=你的token node -e '
import("./lib/tushare.mjs").then(async (m) => {
  console.log("token 已读到：", m.hasToken());
  const one = await m.shareOnDate("2026-11-20");
  console.log("当日返回基金数：", one.size);
}).catch((e) => { console.error("调用失败：", e.message); process.exit(1); });
'
```

---

## 3. 把 token 配成仓库 Secret

1. 打开你的 fork → **Settings**。
2. 左侧 **Secrets and variables → Actions**。
3. 点 **New repository secret**。
4. Name 填 **`TUSHARE_TOKEN`**（必须一模一样的名字，工作流按这个名字读），Secret 填第 2 步的 token。
5. **Add secret**。列表里应该出现一条 `TUSHARE_TOKEN`，更新时间是刚刚。

> 这个值只对 Actions 可见，不会出现在日志里（GitHub 会自动打码）。仓库代码里也不会出现它。

### 3.1 本地开发也要一份（另存 `.env`）

```bash
cp .env.example .env
# 编辑 .env：TUSHARE_TOKEN=你的token
```

`.env` 已经在 `.gitignore` 里；`scripts/lint.mjs` 会检查它**没有被 git 跟踪**，也会扫描代码里的明文 token。

---

## 4. 开启 GitHub Actions

Fork 出来的仓库，工作流默认是**关闭**的：

1. 打开 fork 的 **Actions** 标签页。
2. 如果看到「Workflows aren't being run on this forked repository」，点 **I understand my workflows, go ahead and enable them**。
3. 左侧应出现三条工作流：
   - **Daily data update**（`daily.yml`）—— 定时更新 + 测试 + 提交 + 发布 Pages
   - **CI**（`ci.yml`）—— push/PR 跑测试与构建
   - **Pages**（`pages.yml`）—— 手动部署（可选通道）

补充：

- 如果你是 **public fork**，`daily.yml` 里的 `permissions: contents: write` 足够它自己提交数据；
  如果你给 `master` 开了分支保护，需要允许 Actions 推送，否则提交步骤会失败。
- 定时任务在整点/半点附近会排队，**实际触发可能比 16:30 晚几分钟到几十分钟**，属正常现象。
- 仓库长期无活动时，GitHub 可能暂停定时工作流；在 Actions 页面点一次 **Enable workflow** 即可恢复。

---

## 5. 手动跑一次，确认整条链路通

1. **Actions → Daily data update → Run workflow**。
2. 分支选 `master`，`lookback` 保持默认 `15`，点 **Run workflow**。
3. 观察这次运行：
   - `检查 TUSHARE_TOKEN`：应显示「TUSHARE_TOKEN 已配置（长度 N）」；
   - `增量更新数据`：输出 `update() → {...}`，没有抛错；
   - `跑数据校验测试`：`10 passed, 0 failed`；
   - `提交站点数据`：打印一次 `chore(data): 自动更新站点数据`（首次运行一定会提交）；
   - `deploy` job：`发布到 GitHub Pages` 成功。

### 5.1 没有 token 会怎样（务必读）

工作流的第一步就是 **`检查 TUSHARE_TOKEN`**，缺失时**直接失败**，不会「静默只更沪市」：

```
::error title=缺少 TUSHARE_TOKEN::这是 fork 出来的仓库，需要你自己配置 Tushare 密钥。
::error::步骤：① https://tushare.pro 注册并复制 token ② Settings → Secrets and variables → Actions
          → New repository secret ③ Name 填 TUSHARE_TOKEN，Value 粘贴 token ④ 重新运行本工作流。
          详见 docs/FORK.md
```

| 场景 | 表现 |
| --- | --- |
| Secrets 里没配 `TUSHARE_TOKEN` | 工作流在第一步 `::error::` 后 `exit 1`，job 变红。这是刻意的：fork 的人必须知道「没有密钥就没有完整数据」 |
| 本地没配 `.env` | `npm run update` 仍能跑（不中止），但只有沪市交易所口径，`warn` 里记一条「未配置 TUSHARE_TOKEN，深市数据将不可用」；`npm run reconcile` 需要 Tushare，以**退出码 2**（无法校验）结束 |
| token 失效 / 权限不足 | `lib/tushare.mjs` 在 4 次退避重试后抛错，该步骤失败；错误信息里带接口名与服务端 msg，先看它 |
| 触发限流 / 超出预算 | 明确报错并停止（令牌桶 120 次/分钟、单次 800 次、每日 4000 次，可用 `TUSHARE_RPM` / `TUSHARE_MAX_CALLS_PER_RUN` / `TUSHARE_DAILY_BUDGET` 调整）；重跑会从断点继续 |

也就是说：**本地缺 token 只是数据不全，CI 缺 token 会直接变红**。想要完整效果就必须配。

### 5.2 首次运行特别慢是正常的

新 fork 的 SQLite 缓存是空的，`update()` 发现历史不足 200 个交易日会自动做一次**全量回补**
（`fund_share` 逐只抓 5 年 + 上交所逐日抓）。这一次可能要十几分钟到几十分钟，之后每天就是秒级增量。
如果超时（工作流设置了 `timeout-minutes: 40`），可以手动跑第二次 —— 回补是断点续跑的。

---

## 6. 开启 GitHub Pages

1. 你的 fork → **Settings → Pages**。
2. **Build and deployment → Source** 选 **GitHub Actions**（不要选 “Deploy from a branch”）。
3. 回到 **Actions**，等 `Daily data update` 的 `deploy` job 完成，或手动跑一次 **Pages** 工作流。
4. 站点地址：`https://<你的账号>.github.io/etf-flow/`。

说明：

- `daily.yml` 在构建完成后**直接**把这次的 `site/` 发布到 Pages，不需要把 `site/data/` 提交进 git。
- 首次部署后 DNS/证书可能要等一两分钟；`Settings → Pages` 会显示 “Your site is live at …”。
- 如果 404：先确认 Pages 的 Source 是 **GitHub Actions**，再确认 `deploy` job 成功，最后看
  `Settings → Environments → github-pages` 是否在等审批。

---

## 7. 不想用 Actions？纯本地路线

```bash
cp .env.example .env            # 填 TUSHARE_TOKEN
npm run backfill                # 首次全量回补（联网，约 20 分钟量级，可断点续跑）
npm start                       # 打开 http://127.0.0.1:5188
npm run build                   # 只重建 site/（离线）
```

macOS 想让它常驻 + 定时更新：

```bash
bin/install-autostart.sh --dry-run   # 先看渲染出来的 plist
bin/install-autostart.sh             # 真装：登录自启 + 每工作日 16:10 更新
bin/status.sh                        # 一屏看进程 / 自启 / 库规模 / 最近更新
```

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| Actions 页面没有工作流 | fork 后未启用；点 “I understand my workflows…” |
| 每天都没有新提交 | 数据本来就没变化（节假日）；看运行日志里 `提交站点数据` 那一步的输出 |
| 工作流第一步就红 | 没配 `TUSHARE_TOKEN` Secret（报错里会写明注册与配置路径） |
| 站点打开是空白/无图表 | `site/data/` 没生成。本地先 `npm run build`；CI 里看 `上传 Pages 产物` 之前是否成功构建 |
| `npm run update` 报锁 | 上一次更新还没结束（`data/.update.lock`）。等它结束，或确认没有进程后删掉该目录 |
| `npm test` 失败 | 十有八九是 `data/series.json` 被改坏或库为空。`git checkout data/series.json` 后重试 |
| reconcile 退出码 2 | 无法校验：无交易日或 Tushare 不可用（多半是 token / 积分 / 网络） |
| Pages 404 但 Actions 绿 | Source 没设成 GitHub Actions，或等首次部署完成 |
| 想改站点文案/图表 | 改 `web/`，然后 `npm run build`；`site/` 是产物，不要手改 |

---

## 9. 安全与合规清单（fork 后请对照）

- [ ] `TUSHARE_TOKEN` 只存在于 **GitHub Secret** 与本地 `.env`，没有进过任何提交
- [ ] `.env` 没有被 `git add`（`node scripts/lint.mjs` 会帮你查）
- [ ] 没有把 `data/etf.db`、`site/data/`、`.run/` 提交上去（都在 `.gitignore` 里）
- [ ] 保留 `LICENSE` 与 `NOTICE.md`（MIT 要求保留版权与许可声明；溯源说明见 `NOTICE.md`）
- [ ] 没有把 Tushare 的原始数据做成公开的「数据下载站」（遵守其服务条款）
- [ ] 没有把服务暴露到公网（`server/app.mjs` 只绑 `127.0.0.1`，无鉴权）

---

## 本文的核对状态

- 仓库状态：`gh api` 实测为 public、MIT、`homepage = https://li2396803.github.io/etf-flow/`，
  站点返回 HTTP 200（2026-11-21）。
- 工作流行为：逐行对照 `.github/workflows/daily.yml`、`ci.yml`、`pages.yml`；
  secret 名、`::error::` 缺密钥即失败的逻辑、超时、`refs/heads/master` 条件均来自源码。
- 数据源口径（两源、深市由 Tushare 承担）：依据维护者 2026-11-21 的变更说明。
- 第 2 步的 token 验证命令：结构与本仓库 `lib/tushare.mjs` 的导出一致，**未用真实 token 实跑**（本机不打印密钥）。
- 第 5、6 步的界面路径按 GitHub 当前 UI 描述；**未在 fork 上实跑**（需要另一个账号的仓库）。
- `bin/install-autostart.sh --dry-run`、`npm run backfill` 等命令未在本轮复跑，行为按源码与 README 记录描述。
