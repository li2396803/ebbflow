# 开发指南

面向想改代码的人。口径与字段见 [`DATA.md`](DATA.md)，架构与设计取舍见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

---

## 1. 环境

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 22.5** | 用到内置 `node:sqlite`；`.nvmrc` 已写 `22`，`nvm use` 即可 |
| 依赖 | **零** | `dependencies` / `devDependencies` 均为空，不需要 `npm install` |
| 系统 | macOS / Linux 均可 | 只有 `bin/install-autostart.sh`（launchd）是 macOS 专属 |
| 网络 | 仅更新数据时需要 | `npm run build` / `npm test` / `npm run lint` 全离线 |

```bash
nvm use                 # 或自行安装 Node ≥ 22.5
node -v                 # v22.x 或更高
node -e 'console.log(Object.keys(require("node:sqlite")))'   # 应打印 sqlite 的导出
```

---

## 2. 第一次跑起来

```bash
npm test                       # 数据校验测试，全离线，应先全绿
cp .env.example .env           # 想跑联网更新才需要，填 TUSHARE_TOKEN
npm run build                  # 用 data/series.json 冷启动一个可看的 site/（无需联网）
npm start                      # http://127.0.0.1:5188
```

- 只有 `data/series.json` 时，站点能出曲线与规模，但**成分明细为空**（那需要真实的 `share` / `nav` 数据）。
- 想要完整数据：`npm run update`（增量）或 `npm run backfill`（全量，耗时较长、可断点续跑）。

常用命令一览（详见 README §4）：

```bash
npm start            # 本地服务（默认 5188；PORT=8080 换端口；--no-refresh 关自动刷新）
npm run update       # 增量更新：交易所 + Tushare → 重算 → 构站
npm run build        # 只重建 site/，不联网
npm run backfill     # 全量回补（--from/--to/--source/--limit/--dry-run/--concurrency/--no-resume）
npm run reconcile    # 两口径交叉校验（交易所 vs Tushare）→ data/quality.json
npm run verify:origin# 与原站已发布序列逐点对比
npm test             # 10 个数据校验用例
npm run lint         # 仓库自检（脚本为 node scripts/lint.mjs；入口若尚未加入 package.json，直接跑后者）
```

---

## 3. 目录导览：想改什么，去哪里

| 你想改 | 去这里 | 注意 |
| --- | --- | --- |
| 分类体系（大类/小类/成分 ETF/配色） | `lib/taxonomy.mjs` | **自动生成**，见 §4 |
| 份额口径、派生序列 | `lib/pipeline.mjs` 的 `recompute()` | 口径的唯一实现处 |
| 债券 ×100、四舍五入 | `lib/pipeline.mjs`、`lib/aggregate.mjs` | 改了两边都要同步 |
| 数据校验规则/阈值 | `lib/validate.mjs` 的 `DEFAULTS` | 改阈值要同步改测试 |
| 交易所接口 | `lib/sources.mjs` | 只有上交所（v3 起不再直连深交所）；UA/Referer/翻页/重试都在这 |
| Tushare 接口、限流与预算 | `lib/tushare.mjs` | 别把令牌桶拆掉 |
| 来源优先级 | `lib/db.mjs` 的 `putShares()` | 改优先级会改变已发布数值，需记录 |
| 前端契约（`meta/charts/tables/subs/market/index/quality`） | `lib/payloads.mjs` | 改字段属于破坏性变更 |
| 站点构建（写 `site/`） | `lib/build/site.mjs` | 产物目录，勿手改 |
| 页面/交互/样式 | `web/`（`index.html` / `app.js` / `styles.css`） | 改完要 `npm run build` 才进 `site/` |
| API | `server/app.mjs` | 只绑 `127.0.0.1`，无鉴权 |
| 定时与 CI | `.github/workflows/*.yml`、`launchd/`、`bin/*.sh` | 改 workflow 先过 `actionlint` |
| 测试 | `tests/cases/*.mjs` | 框架在 `tests/framework.mjs`（零依赖） |

生成物与本地缓存（**都不要提交**）：`site/`（除四个静态源文件）、`site/data/`、`data/etf.db*`、`data/lastrun.json`、`data/shares/`、`.run/`、`.env`。

---

## 4. 改一处 taxonomy 会怎样

`lib/taxonomy.mjs` 是**由 `tools/gen-taxonomy.mjs` 自动生成**的（文件头已注明「请勿手改」）。
它导出四个东西：

| 导出 | 内容 | 被谁依赖 |
| --- | --- | --- |
| `CATS` | 10 项大类（9 个编号大类；7 号拆成消费/医药） | 图表分组、页签、`buildCharts`、`buildTables` |
| `SUB` | 86 个小类 → `{ cat, color, etfs: [{code, name}] }` | 口径计算、明细抽屉、索引、校验 |
| `ALL_CODES` | 773 个去重后的 ETF 代码 | 回补、校验宇宙、Tushare 逐只抓取 |
| `BOND_CAT` | `"9_债券"` | ×100 折算的判定 |

改动的影响面（按传播顺序）：

```
taxonomy
  ├─► series 的键（sub 名）──► data/series.json 的 subs 键 ──► 前端图表/表格
  ├─► ALL_CODES 数量 ──► 回补范围、validate 的宇宙、测试断言（86/773）
  ├─► 配色 ──► 图表颜色与页签色（纯展示）
  └─► cat 归属 ──► 大类聚合、页签分组、BOND_CAT 判定
```

**最小改动流程**：

1. 改 `tools/gen-taxonomy.mjs`（或其数据来源），重新生成 `lib/taxonomy.mjs`；
2. `npm test` —— `tests/cases/taxonomy.mjs` 会校验小类数、代码唯一性、结构完整性；
3. `npm run build` 看页面是否正常（新增小类若没有历史数据，曲线会是空的）；
4. 需要历史就 `npm run backfill -- --source ts`（或 `both`）把新成分补进来；
5. `npm run verify:origin` 确认没把既有小类改坏；
6. 在 `CHANGELOG.md` 记录「分类体系变更」及其对已发布数值的影响。

> ⚠️ 重命名 / 删除某个 `sub` 是**破坏性变更**：旧 `series` 行会变成孤儿，`data/series.json` 的键也会变。
> 如果确实要改，最好同时提供一次性迁移（或接受历史曲线断裂并在文档里注明）。

---

## 5. 如何加一个细分行业

1. 在生成器里给目标大类加一项：`{ 名称, cat, color, etfs: [{ code, name }, ...] }`。
   - `code` 必须是 6 位、且在该 ETF 真实上市的市场；`name` 用简称（前端会截断）。
   - 同一只 ETF 可以出现在多个小类里（`ALL_CODES` 会自动去重）。
2. 重新生成 `lib/taxonomy.mjs`，确认 `Object.keys(SUB).length` 增加、`ALL_CODES` 没有重复。
3. 联网补齐数据：
   ```bash
   npm run update                      # 增量（近 15 天）
   # 需要更长的历史：
   npm run backfill -- --source ts --from 2021-11-22
   ```
4. `npm run build`，在页面上确认：页签里出现新小类、抽屉里有成分表、曲线有值。
5. `npm test`：`taxonomy` 用例会检查数量与结构，`series` 用例会检查连续性 —— 新小类如果只有
   最近几天数据，可能触发「中间断裂」告警，属预期（历史还没回补）。
6. 提交 PR，并在描述里写清：新增了哪些代码、对既有小类是否有数值影响、是否已回补。

---

## 6. 如何加一个数据源

以「加一个交易所/第三方源」为例，需要同时动五处，缺一处就会出现「数据进了库但看板不对」：

> 现状是**两个**数据源（上交所 + Tushare，深市由 Tushare 承担）。再加第三个之前先想清楚它补的是什么缺口。

1. **取数**：新增 `lib/<source>.mjs`，只暴露「按日/按只取份额」的纯函数，带重试与限并发；
   token 一律从环境变量或 `.env` 读，**不要写进代码**。
2. **优先级**：在 `lib/db.mjs` 的 `putShares()` 里给新 `src` 定优先级。
   交易所官方口径应高于第三方；低优先级不得覆盖高优先级。
3. **就绪标记**：更新 `dayinfo` 的 `has_*` 列，让增量更新知道哪天已经抓过。
4. **校验口径**：在 `scripts/reconcile.mjs` 里把它作为「交易所侧」或「Tushare 侧」的对侧参与比对，
   否则 `data/quality.json` 会假装一切正常。
5. **测试**：`tests/cases/db-priority.mjs` 加优先级用例；`rules.mjs` 加异常数据用例。

另外记得：

- 抓取频率要克制（本项目默认每日一次、并发 ≤ 6、Tushare 有令牌桶与预算），别给公共接口加压力；
- 新来源的字段单位必须换算到「万份」再入库（口径见 `DATA.md` §1）；
- 在 `docs/DATA.md` 的能力矩阵与 `README.md` 的数据源表里补一行。

---

## 7. 前端改动

- 源码在 `web/`，**不要直接改 `site/`**（那是构建产物，下次 `npm run build` 会被覆盖）。
- 构站会把 `web/` 里非 `_`、非 `.` 开头的文件拷进 `site/`，并把 `site/data/*.json` 写好；
  同时把 `<!--__SIGNATURE__-->`、`__REPO__`、`__LICENSE__` 这些占位符替换成真实值。
- 取数策略是「静态优先、API 兜底」：先 `fetch("data/xxx.json")`，失败再打 `/api/xxx`。
  新增数据文件时，两条路径都要能读到（`server/app.mjs` 里补一个路由，或在静态文件里兜住）。
- 本地联调：

  ```bash
  npm run build && npm start      # 静态 + API 都在
  python3 -m http.server -d site 8000   # 只测静态（不装任何依赖；访问 :8000）
  ```

- 改了 `web/index.html` 的占位符会导致构站后签名注入失效，`scripts/lint.mjs` 会拦住。

---

## 8. 调试技巧

### 8.1 `/api/status`：先看它，别猜

```bash
npm start
curl -s localhost:5188/api/status | python3 -m json.tool
```

里面能看到：最近一次更新的时间与结果、数据是否过期、是否正在刷新、库的规模。
页面打不开图时，第一步永远是看这里。

### 8.2 `data/quality.json`：数据可信吗

`summary.ok === true` 才算「交易所与 Tushare 两个口径对得上」；否则看 `summary.worstCode` / `worstSub` 与 `days[].mismatch.byCode`。
字段说明见 `DATA.md` §5。

### 8.3 直接查库（只读）

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/etf.db", { readOnly: true });
console.log(db.prepare("SELECT * FROM run ORDER BY id DESC LIMIT 3").all());
console.log(db.prepare("SELECT * FROM series WHERE sub=? ORDER BY date DESC LIMIT 3").all("科创板宽基"));
db.close();
'
```

`run` 表是「哪次更新、成功没、跑了多久」的黑匣子；`series` 是看板真正的数据源。

### 8.4 `npm run verify:origin`：独立实现能不能复现原站

对比结果写 `data/validation-origin.json`。若只有 `2026-08-25`、`2026-10-28` 两天不一致，那是原站冻结
（见 `DATA.md` §7），不是 bug。

### 8.5 自检与语法

```bash
node scripts/lint.mjs          # 或 npm run lint
node --check lib/pipeline.mjs  # 单文件语法检查
npm test                       # 数据层回归
```

`lint` 会检查：裸 `debugger`、明文 token、`.mjs` 语法、`web/index.html` 占位符、
`site/` 入库白名单、`data/series.json` 的交易日数。

### 8.6 日志

- 本地服务：`bin/start.sh` 起的话日志在 `.run/server.log`；
- 定时更新：`.run/update.log`（`bin/update.sh` 写入，超 2MB 自动截断）；
- GitHub Actions：运行详情页 + 失败时上传的 `update-log` artifact。

### 8.7 常见坑

| 症状 | 先查 |
| --- | --- |
| `npm run update` 立刻返回 `{ skipped: "locked" }` | `data/.update.lock` 残留（另一个更新在跑或上次被 kill） |
| 页面数字全 0 / 空 | 库为空走了冷启动；`npm run update` 或 `backfill` |
| 只有沪市数据、金额口径没有 | 没配 `TUSHARE_TOKEN` |
| `npm run build` 退出码 1 | 库里没有数据，且 `data/series.json` 也缺失/被改坏 |
| 图表端点重叠/被裁切 | 前端问题，改 `web/app.js` 的 `labelLayout`/`grid`，别动数据 |

---

## 9. 提交前检查清单

```bash
npm test            # 必须全绿
node scripts/lint.mjs   # 必须全绿
npm run build       # 改了 web/ 或数据相关代码才需要
git status --short  # 确认没有 .env / data/etf.db / site/data 之类
```

- 提交信息用 Conventional Commits（见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)）。
- 只改数据、不改代码的 PR，请附 `npm test` 与 `npm run reconcile` 的输出。
- 不要提交 `data/etf.db`、`site/data/`、`.env`、`.run/`。

---

## 本文的核对状态

- 环境要求、命令清单：对照 `package.json`、`.nvmrc`、`README.md` §4。
- 「改 taxonomy 的影响面」「加数据源要动的五处」：对照 `lib/*.mjs` 的引用关系逐条确认。
- 调试命令中的 SQL 与 `/api/status`：按 `lib/db.mjs` 表结构与 `server/app.mjs` 路由编写；
  SQL 片段已只读实跑，`/api/status` 未在本文中实跑（需起服务）。
- `node scripts/lint.mjs` 实跑通过（7 项，见下）：
  ```
  ✓ lib/ scripts/ server/ 里没有裸 debugger
  ✓ 没有明文 TUSHARE_TOKEN（前面是 "=" 或 ":" 的 30+ 位 token 形态）
  ✓ .env 没有被 git 跟踪
  ✓ 全部 .mjs 通过 node --check
  ✓ web/index.html 保留构站占位符（__SIGNATURE__ / __REPO__ / __LICENSE__）
  ✓ site/ 入库文件只在白名单内
  ✓ data/series.json 的 dates 长度 ≥ 1000
  ✓ 7 项全部通过
  ```
- **未实跑**：`npm start`、`npm run update`、`npm run backfill`、`npm run reconcile`、`npm run verify:origin`、
  `npm run build`（这些会启动服务或改写 `data/`、`site/`）；相关描述按源码与仓库既有产物核对。
