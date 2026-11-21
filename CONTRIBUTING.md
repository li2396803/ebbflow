# 贡献指南

感谢你愿意花时间。这个项目是**一个人维护、零依赖、以数据准确性为第一目标**的小工具，
所以下面这些约定不是流程表演，而是让改动可验证、可回滚的 minimum。

- 参与本项目即表示你同意遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
- 提交（Pull Request）即表示你同意以 **MIT** 协议授权你的贡献。
- 遇到安全问题**不要**开公开 Issue，请走 [`SECURITY.md`](SECURITY.md)。

---

## 1. 可以贡献什么

**欢迎**

- 数据口径/校验规则的修正与补充测试（最有价值）
- 数据源接口变更导致的适配（交易所字段改名、Tushare 接口调整）
- 前端可用性、无障碍、移动端布局、性能
- 文档纠错：命令跑不通、字段说明与代码不符、Fork 步骤卡住
- 新增细分行业 / 成分 ETF（需附数据来源与影响说明）

**大概率不会被接受**

- 引入运行时依赖（React/Vue/axios/lodash…）—— 本项目刻意零依赖，前端用原生 JS
- 把数据抓取改成高频轮询、绕过限流、或多线程猛拉公共接口
- 提交 `data/etf.db`、`site/data/`、`.env`、`.run/` 等产物/密钥
- 手改 `data/series.json` 里的数值去「对齐」某个平台
- 与项目定位无关的功能（账户体系、荐股、交易接口、付费墙）
- 大范围纯格式改动（会掩盖真实 diff；格式化请单独提 PR 并说明）

---

## 2. 开发流程

```bash
# 1) Fork 并在自己的分支上工作
git clone https://github.com/<you>/etf-flow.git
cd etf-flow
git checkout -b fix/caliber-bond-multiplier

# 2) 环境：Node ≥ 22.5，无需 npm install（零依赖）
node -v
npm test

# 3) 改代码 → 自检 → 测试
node scripts/lint.mjs      # 或 npm run lint
npm test
npm run build              # 改了 web/ 或数据相关代码时

# 4) 提交（信息规范见 §4）
git add -A
git commit -m "fix(pipeline): 债券大类折算改为只作用于份额口径"

# 5) 推送并发起 PR（模板会自动出现）
git push origin fix/caliber-bond-multiplier
```

分支命名建议：`fix/…`、`feat/…`、`docs/…`、`data/…`、`ci/…`、`chore/…`。

PR 请**小而聚焦**：一个 PR 只做一件事。把「口径修正」和「前端重排」混在一起，review 成本会翻倍。

---

## 3. 代码风格

| 约定 | 说明 |
| --- | --- |
| 运行时依赖 | **零**。需要什么就用 Node 内置模块（`node:fs` / `node:sqlite` / `node:child_process`…） |
| 模块 | 原生 ESM（`import` / `export`），文件后缀 `.mjs`；不要 CommonJS |
| Node 版本 | ≥ 22.5（`node:sqlite`）。不要用需要更新版本才有的 API |
| 缩进/换行 | 2 空格、LF、文件末尾留一个换行（`.editorconfig` 已配置） |
| 注释 | **中文**，解释「为什么」而不是「是什么」；文件头写清职责与不变量 |
| 命名 | 变量/函数 `camelCase`，常量 `UPPER_SNAKE`，模块内私有函数不加前缀 |
| 数值 | 统一用 `round4`（库内）/ `round1`（展示）；不要各写一份 `toFixed` |
| 错误处理 | 抓取类失败要**记录并降级**（进 `warnings`），不要静默吞掉；数据类异常要抛错 |
| 日志 | `console.log` / `console.warn` 可以用；**禁止** `debugger`（lint 会拦） |
| 中文文案 | 界面与日志用简体中文；代码标识符用英文 |
| 自动生成的文件 | `lib/taxonomy.mjs`、`site/*` 不要手改（改生成器或 `web/`） |
| 提交产物 | 不要提交 `data/etf.db*`、`data/lastrun.json`、`site/data/`、`data/shares/`、`.env`、`.run/` |

几条容易踩的：

- **口径只在一处实现**：`lib/pipeline.mjs` 的 `recompute()`。不要在 `payloads.mjs` 或前端再算一遍。
- **`NULL` 不是 0**：没有数据就写 `NULL`。填 0 会伪造断崖，也会骗过连续性检查。
- **来源优先级**：交易所 > Tushare；低优先级不得覆盖高优先级。改这里等于改历史数据，必须写进 `CHANGELOG.md`。
- **抓取克制**：每日一次、并发 ≤ 6、Tushare 走令牌桶与预算。别为了跑得快把对方服务器当压力测试。

---

## 4. 提交信息规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<type>(<scope>): <简述>

<可选正文：为什么这么改、影响范围、验证方式>
<可选 footer：Refs #123 / BREAKING CHANGE: ...>
```

`type` 取值：

| type | 用途 |
| --- | --- |
| `feat` | 新功能 / 新能力 |
| `fix` | 修 bug（含数据口径错误） |
| `data` | 数据提交（通常是流水线自动产生，人工慎用） |
| `docs` | 文档 |
| `test` | 测试 |
| `refactor` | 重构（不改行为） |
| `perf` | 性能 |
| `ci` | 工作流 / 构建 |
| `chore` | 杂项（依赖、脚本、配置） |

`scope` 建议用模块名：`pipeline` / `taxonomy` / `sources` / `tushare` / `db` / `payloads` / `web` / `server` / `ci` / `docs`。

**真实示例**（取自本仓库历史，可直接照抄格式）：

```
fix(web): 静态托管时跳过 /api/status 探测，消除控制台 404 噪音
ci(daily): 用原生 git + rebase 重试替代 auto-commit action，避免与维护者推送竞态
chore(data): 自动更新站点数据
docs: 增加徽章与在线站点入口
```

要求：

- 标题 ≤ 72 字符，不以句号结尾，动词开头。
- 正文用中文写清「为什么」，涉及数值变化时**给出前后对比或影响的小类**。
- 破坏性变更（改口径、改载荷字段、改分类键名）必须在 footer 写 `BREAKING CHANGE:` 并同步 `CHANGELOG.md`。

---

## 5. 测试与自检

```bash
npm test                 # 10 个数据校验用例（离线）
node scripts/lint.mjs    # 仓库自检（离线）：debugger / 明文 token / 语法 / 占位符 / site 白名单 / series 长度
npm run build            # 改了 web/ 或数据相关代码时跑
```

- 修 bug：**先补一个会失败的用例**，再修到通过。
- 新功能：至少覆盖正常路径 + 一个边界（空数据、异常值、单侧缺失）。
- 测试框架是零依赖自研的（`tests/framework.mjs`），用法看现有用例即可：
  `test(name, fn)` + `assert` / `assertEq` / `assertClose` / `skip(reason)`。

---

## 6. 数据类 PR 的特殊要求

只要改动涉及**数据本身或数据口径**（`lib/pipeline.mjs`、`lib/db.mjs`、`lib/validate.mjs`、
`lib/taxonomy.mjs`、`scripts/*.mjs` 的口径部分），PR 描述里必须包含：

1. **`npm test` 的完整输出**（至少要能看出 `10 passed, 0 failed`）。
2. **`npm run reconcile` 的摘要输出**（最后几行，含 `ok` / `diverged` / `worstCode`）。
   - 没有 token 跑不了时，明确写「Tushare 不可用，退出码 2」并说明你如何替代验证。
3. **影响范围**：哪些小类/大类会变、变多少（给出 1–2 个具体数字），是否影响已发布的 `data/series.json`。
4. **数据来源**：交易所接口日期 / Tushare 接口名与调用日期；不要贴 token。
5. **如果是分类体系变更**：说明增删了哪些小类/代码，对既有小类是否有数值影响，
   是否需要重跑 `npm run backfill`，以及 `npm run verify:origin` 的对比结果。
6. **不要手改 `data/series.json` 的数值**。数据要由脚本产出；手工改值会让「可重建」这一前提失效，
   review 会直接打回。

示例（可直接粘贴到 PR 描述）：

```text
## 验证
$ npm test
... 10 passed, 0 failed, 0 skipped (812ms)

$ npm run reconcile -- --days 5
... 逐只比对 3730 对，一致 3730，>1% 0；小类 checked=430 inconsistent=0；ok=true

## 影响
- 「债券」大类：×100 只作用于份额口径，金额口径不变；series.val 无数值变化。
- 未改动 data/series.json。
```

---

## 7. Review 期望

- 维护者会尽量在 **3 个工作日内**给出第一次回应；纯文档修正通常当天。没有 SLA，请勿催促。
- 会被要求修改的常见点：缺测试、口径未写在 `CHANGELOG.md`、提交信息不合规、夹带了无关文件、
  引入了依赖、把 `NULL` 写成了 0。
- 合并方式：**squash merge**，最终提交信息以 PR 标题为准 —— 所以请把 PR 标题写成合规的提交信息。
- 如果你两周内无法继续跟进，维护者可能会接手收尾或关闭 PR；随时可以重开。

---

## 8. 文档与素材

- 用户向文档：`README.md`（只增不改已有章节）、`docs/DATA.md`、`docs/FORK.md`。
- 维护者向文档：`docs/ARCHITECTURE.md`、`docs/DEVELOPING.md`。
- 新增截图请压缩后放 `docs/`，并在 Markdown 里用相对路径引用。
- 文档里出现的命令必须**真实可跑**；没实测的请明确标注「未实测」。

---

再次感谢。哪怕只是把一处文档里跑不通的命令改对，也是在帮下一个 fork 的人省一小时。
