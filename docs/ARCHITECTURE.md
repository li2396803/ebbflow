# 架构说明 · ebbflow

本文回答三个问题：**数据从哪来、经过哪些模块、为什么这么设计**。
口径公式见 [`DATA.md`](DATA.md)，逐列字段见 [`DICTIONARY.md`](DICTIONARY.md)，
HTTP/JSON 契约见 [`API.md`](API.md)，本地开发指引见 [`DEVELOPING.md`](DEVELOPING.md)。

- 定位：ETF 细分行业资金流向看板 —— 默认 **v2** 口径（7 大类 / 72 小类 / 1903 只），
  兼容 **legacy** 口径（原看板 10 大类 / 88 小类 / 1614 只）；另有一份**全市场总览**（沪深全部场内 ETF）。
- 形态：一条离线可重建的数据管道 + 一份静态站点 + 一个本地服务。
- 数据源：**两个** —— 上交所（沪市官方口径）+ Tushare Pro（份额/净值/名录/行情，深市唯一来源）。
- 约束：**零运行时依赖**、原生 ESM、Node.js ≥ 22.5（用到内置 `node:sqlite`）。
- 许可：MIT。分类体系与看板形态源自 B 站 UP 主「生炸瓜」的作品，本项目为独立重写，见 [`../NOTICE.md`](../NOTICE.md)。

> **两套分类口径**（互不覆盖，页面可切换）：
> - **v2**（默认）：7 大类 / 72 小类 / 1903 只，指数类别 + 申万一级 + 主题骨架，数据在 `series_v2`。
> - **legacy**：10 大类 / 88 小类 / 1614 只，原看板 86 小类（773 只沪市）加深市归属，数据在 `series`。
>   编号 1–9 中 7 号拆成「消费」「医药」两个页签，所以 `CATS` 实际 10 项。
>
> 两套分别落在 `site/data/` 与 `site/data/legacy/`，接口前缀 `/api/*` 与 `/api/legacy/*`。

---

## 1. 端到端数据流

```
数据源（两个，能力互补）
  上交所 commonQuery  STAT_DATE=YYYY-MM-DD
    → 当日沪市全部 ETF 份额（万份，官方口径，可按日期回溯）
  Tushare Pro
    fund_share → 沪深两市每日份额（万份，4 位小数）；深市唯一来源
    fund_nav   → 单位净值（元/份），金额口径依赖
    fund_daily → 行情（收盘/涨跌/成交量/成交额），折溢价与换手率依赖
    fund_basic → 名录（名称/类型/上市日）
                    │
                    │  UA / Referer / 重试 / 限并发 / 令牌桶
                    ▼
   lib/sources.mjs（上交所）          lib/tushare.mjs（Tushare，限流与预算）
                    │
                    ▼
   lib/pipeline.mjs
     ① 合并落库：share 按 (code,date) 单行、来源优先级裁决
     ② 折算检测：detectShareEvents → event（拆分/合并）
     ③ 重算派生：series / series_v2 / market / market_type
                    │
                    ▼
   lib/db.mjs → data/etf.db（SQLite / WAL / node:sqlite，13 张表）
                    │
        ┌───────────┼──────────────────────┐
        ▼           ▼                      ▼
 lib/payloads.mjs  scripts/reconcile.mjs   scripts/verify-origin.mjs
 派生载荷           两口径交叉校验            与原站已发布序列对比
 meta/tables/      → data/quality.json      → data/validation-origin.json
 charts/subs/        （+ reconcile 表）
 index/market/
 quality
        │
        ▼
 lib/build/site.mjs
   写 site/data/*.json（含 charts-*、signature、lastrun、archive/）
   再写一套 legacy 子树 site/data/legacy/
   拷贝 web/ → site/、注入签名、清理陈旧产物
        │
   ┌────┴─────────────────────────┐
   ▼                              ▼
 静态托管（含 GitHub Pages）      server/app.mjs（/api/*，127.0.0.1:5188）
 前端取数：静态优先，API 兜底
```

同一份 `site/` 既能被任意静态服务器直接托管，也能在本地起服务看 —— 前端先 `fetch` 同目录
`data/*.json`，失败才回退 `/api/*`。这让「离线可看」和「本地可刷新」共用一套产物。

---

## 2. 模块职责

| 模块 | 职责 | 不做什么 |
| --- | --- | --- |
| `lib/sources.mjs` | 上交所逐日快照、候选交易日生成、限并发工具 | 不写库、不算口径；不直连深交所 |
| `lib/tushare.mjs` | `fund_share` / `fund_nav` / `fund_daily` / `fund_basic`；token 读取、令牌桶、单次/每日预算、退避重试 | 不做业务聚合 |
| `lib/db.mjs` | 建表与幂等迁移、来源优先级合并、各表读写、运行记录、统计 | 不含分类知识（除按类型分组） |
| `lib/taxonomy.mjs` | **原看板基线**：10 大类 / 86 小类 / 773 只沪市成分（冻结，`verify:origin` 依赖） | 不含深市与 v2 分类 |
| `lib/universe.mjs` | 把基线 + 深市归属合并成 legacy 宇宙（88/1614）；也负责加载 v2 分类（`classification-v2.json`） | 不抓数 |
| `lib/pipeline.mjs` | 抓取编排、合并落库、折算检测、`recomputeAll()` 重算派生表 | 不生成站点载荷 |
| `lib/aggregate.mjs` | 窗口/排行/大类聚合工具（`recentWindow`/`windowChanges`/`catScale`） | 不做抓取、不写库 |
| `lib/validate.mjs` | 数据质量规则：单只跳变、小类跳变、覆盖度骤降、零负值、序列断裂 | 只读：不修数 |
| `lib/payloads.mjs` | 把库切成前端契约：`meta/charts/tables/subs/market/index/quality` | 不写文件（除读 `quality.json`/`tags-v2.json`） |
| `lib/pinyin.mjs` | 小类名拼音首字母（搜索索引） | — |
| `lib/signature.mjs` | 项目身份常量、HTML 注入、运行时签名 | — |
| `lib/build/site.mjs` | 构站：写 `site/data/`（含 legacy 子树与 archive）、拷贝 `web/`、注入签名 | 不联网 |
| `scripts/update.mjs` | 增量更新入口（`update({lookback})`）：份额/净值/行情/事件 → 重算 → 构站，带互斥锁 | 不处理历史全量 |
| `scripts/backfill.mjs` | 份额全量回补（`--source ts\|sse\|both`，断点续跑） | 不构站 |
| `scripts/backfill-quotes.mjs` | 行情历史回补（`npm run quotes`；按日 `fund_daily`，跳过已有日期） | 不改份额 |
| `scripts/build.mjs` | 离线重建 `site/`；无 DB 时用 `data/series.json` 冷启动 | 不联网 |
| `scripts/reconcile.mjs` | 两口径交叉校验 → `data/quality.json` + `reconcile` 表，退出码 0/1/2 | 不改原始数据 |
| `scripts/verify-origin.mjs` | 用自建数据复算，与原站已发布序列逐点对比 | 不改原站副本 |
| `scripts/classify.mjs` / `tag-v2.mjs` / `palette-v2.mjs` | 生成 v2 分类、多维标签、配色（产物在 `data/`） | 不参与每日更新 |
| `scripts/lint.mjs` | 仓库自检（debugger/密钥/语法/占位符/产物边界/数据底座） | 不检查业务口径 |
| `scripts/publish-db-seed.sh` | 把 `data/etf.db` 压成 Release 种子，供 CI 冷启动 | — |
| `server/app.mjs` | 静态托管 + `/api/*`（含 `/api/legacy/*`）+ 过期自检与自动刷新 | 无鉴权，只绑 `127.0.0.1` |
| `web/` | 前端源码（原生 JS + 本地 `echarts.min.js`） | 不含数据 |

---

## 3. 存储模型

`data/etf.db` 是**本地缓存**，不进 git，可由接口重建（见 §8）。13 张表：

| 表 | 粒度 | 角色 |
| --- | --- | --- |
| `fund` | `code` | 名录（名称、类型、市场、上市日） |
| `share` | `(code, date)` | **原始份额**（万份）+ 来源 `sse`/`ts`（旧库可能残留 `szse`） |
| `nav` | `(code, date)` | 单位净值（元/份） |
| `quote` | `(code, date)` | 行情：收盘价、涨跌幅、成交量（手）、成交额（千元） |
| `series` | `(sub, date)` | legacy 派生序列：份额（亿份）/ 规模（亿元）/ 净申购（亿元） |
| `series_v2` | `(sub, date)` | v2 派生序列（同上三列） |
| `market` | `(date, scope)` | 全市场聚合，`scope ∈ SH/SZ/ALL`（自然口径） |
| `market_type` | `(date, type)` | 按基金类型聚合 |
| `event` | `(code, date, kind)` | 份额拆分/合并事件（`ratio` 为折算比例） |
| `reconcile` | 无主键 | 交叉校验明细（每次清空重写） |
| `run` | 自增 `id` | 运行台账（kind/ok/stats/err） |
| `dayinfo` | `date` | 当日来源覆盖标记；`has_sse=1` 定义交易日轴 |
| `meta` | `k` | 键值状态（回补断点、Tushare 调用计数、更新时间等） |

> **幂等迁移**：`series.scale/flow`、`fund.list_date` 用 `ALTER TABLE ... ADD COLUMN`；
> `quote`/`event`/`series_v2`/`market`/`market_type` 用 `CREATE TABLE IF NOT EXISTS`。
> 打开旧库即自动升级，不需要清库；`szse` 历史行保留读取兼容。

逐列含义、来源、更新频率见 [`DICTIONARY.md`](DICTIONARY.md)。

---

## 4. 为什么这么设计

### 4.1 来源优先级：交易所 > Tushare

同一 `code + date` 全库只保留一行，写入时按优先级裁决：

| 来源 | 优先级 | 理由 |
| --- | --- | --- |
| `sse` | 1（高） | 交易所官方披露的登记份额，是这一天的权威口径 |
| `ts` | 2（低） | 第三方加工数据，用于补深市、补缺、精度参照、净值与行情 |

低优先级**不会覆盖**已存在的高优先级数据；同来源重抓则幂等覆盖。
所以「先写 Tushare 再抓到交易所」是安全的，反过来也不会把官方值冲掉 ——
增量更新因此是**与顺序无关**的操作，失败重跑不会污染数据。

### 4.2 深市数据全部来自 Tushare

- 上交所接口带 `STAT_DATE`，能按日期回溯任意历史交易日 → 沪市历史可直接重建。
- 深交所官方接口只有「当前规模」一份快照、**没有历史**，每天存一份也只能积累未来数据，
  因此 v3 起**不再调用**（`scripts/update.mjs` 无调用点；`lib/sources.mjs` 里的旧函数是死代码）。
- 深市份额与净值统一走 Tushare `fund_share` / `fund_nav`；行情走 `fund_daily`。
- 结论：数据源只有两个 —— **上交所（沪市官方口径）+ Tushare（深市唯一来源、沪市第二参照）**；
  交叉校验相应变成「沪市两口径比对」。

### 4.3 交易日轴 = 交易所出快照的日子

`tradingDates()` 取的是 `dayinfo.has_sse = 1` 的日期，而不是日历推算，也不是 `share` 里出现过的所有日期：

- 不需要维护节假日表：非交易日上交所返回空，自然不会落库。
- 天然排除 Tushare 在季末/非交易日的披露（这些行仍在 `share` 里，但不进入序列轴）。
- 某个交易日整体抓取失败时会**显式缺席**，而不是被填成 0（填 0 会伪造断崖）；
  代价是可能出现结构性缺口，所以 `lib/validate.mjs` 有 `findGaps()` 专门检测。
- 回补时用 `candidateDates(from, to)` 跳过周末生成候选，再由空结果过滤节假日，不漏调休交易日。

### 4.4 内部 4 位小数、展示 1 位；债券 ×100

- 交易所给整数万份、Tushare 给 4 位小数；库内统一 4 位，避免「先舍入再跨小类相加」放大误差。
- 展示层统一 1 位（`round1`），图表与表格读数一致。
- **债券小类 ×100**：债券 ETF 面值 100 元/份，不折算会和其他小类差两个量级。
  legacy 判 `9_债券`、v2 判 `bond`，统一走 `isBondCat()`（v3.8.0 修复了 v2 漏乘）。

### 4.5 净申购为什么要修正（`event` + 上市首日）

`flow` 是「份额净申购」而不是「份额变化 × 净值」的裸结果，因为有两类假跳变：

1. **份额拆分/合并**（如 1:2）：份额瞬间翻倍，裸差值会被算成巨额申购。
   `detectShareEvents()` 用「比例落在常见折算比例 ±3%」+「新水平要维持住（次日 ±15%）」两条规则识别，
   写入 `event`；重算时把历史份额换算到当前份额单位再相减。
2. **上市首日**：新发基金一次性进几亿份，那是一级募集，不是日常申赎 → 按 `fund.list_date` 剔除当日。

两条修正都只作用于 `flow`，**份额水位本身仍按披露原值展示**。

### 4.6 两套分类并存：不覆盖、不混算

- 原看板基线（`lib/taxonomy.mjs`，773 只沪市）**冻结**，`verify:origin` 依赖它做回归；
  legacy 宇宙在它之上叠加深市归属（`data/universe.json`，88 小类 / 1614 只）。
- v2 是另一套骨架（指数类别 + 申万一级 + 主题，`data/classification-v2.json`，72 小类 / 1903 只）。
- 两套各写自己的表（`series` / `series_v2`）与目录（`data/` / `data/legacy/`），
  默认口径由「`series_v2` 是否覆盖 ≥ 1000 个交易日」决定，切换不会串数据。
- 代价：所有展示都要带「当前口径」概念（`meta.taxonomy`），文档与 UI 需要反复说明。

### 4.7 零运行时依赖

- 少一层供应链风险：没有 `node_modules` 就没有 lockfile 漂移与间接依赖 CVE。
- `node:sqlite` 覆盖了需要的存储能力（WAL、事务、预编译语句），不必引 better-sqlite3。
- 前端同理：ECharts 用 `site/echarts.min.js` 本地副本，不引 CDN，断网可看。
- CI 的安装步骤只是兜底（有 lockfile 才 `npm ci`），实际不下载任何包。

### 4.8 静态优先、API 兜底

- 站点要能「双击 `site/index.html` 就看」→ 取数必须走同目录相对路径的静态 JSON。
- 本地服务要能「刷新后立刻看到」→ 需要 `/api/*`。
- 两者共存：前端先试静态文件，失败再打 API。同一份代码，两种部署（GitHub Pages 直接可用）。
- 首屏：构站把 `web/js` 下所有模块写成 `<link rel="modulepreload">`，消除 ESM 串行发现的请求瀑布。
- 传输：本地服务对 JSON/JS/CSS 预压缩，优先 brotli，回退 gzip；静态文件自带 `ETag`，命中返回 304。
- `subs.json` 的日期轴提到顶层 `__dates`，前端加载时剥离，避免被当作小类混入列表与搜索。

### 4.9 `site/data/` 是产物，不入库

- 载荷可由「库 + 构建脚本」确定性重建；入库只会让 git 历史每天膨胀几 MB。
- 所以 `daily.yml` 构建完直接发布 Pages，不依赖入库的 `site/data/`；
  本地用 `npm run build`（无库时用 `data/series.json` 冷启动）。
- `data/series.json` 是例外：**冷启动底座 + 回归基线**，必须入库（`scripts/lint.mjs` 检查 ≥ 1000 个交易日）。

---

## 5. 载荷与构建产物

`lib/payloads.mjs` 产出七类载荷；`lib/build/site.mjs` 写盘时再补 `signature.json`、`lastrun.json`，
并复制出一套 legacy 子树与每日快照：

| 产物 | 文件 | 内容 |
| --- | --- | --- |
| `meta` | `meta.json` | 最新交易日、区间/窗口、口径（`taxonomy`）、计数、沪深覆盖、指标单位、告警 |
| `tables` | `tables.json` | 窗口大类汇总、全量小类排行、增幅/降幅 Top5 |
| `charts` | `charts-<catKey>.json` | 每个大类的 `dates + series[{name,color,shares[],scale[],flow[]}]`（v3 起不再服务端归一） |
| `subs` | `subs.json` | 小类明细：份额序列、规模、净申购、`navCoverage`、成分 ETF（含行情/折溢价/换手率/标签） |
| `index` | `index.json` | 搜索索引（小类 + ETF，带拼音首字母） |
| `market` | `market.json` | 全市场总览：`total/sh/sz` 的份额与规模、`byType`；**自然口径不 ×100** |
| `quality` | `quality.json` | 交叉校验摘要 + 完整 `detail` |
| 身份 | `signature.json` | project/version/author/repo/fingerprint/origin |
| 运行 | `lastrun.json` | 本次构建时间、最新交易日、耗时 |
| 快照 | `archive/<YYYY-MM-DD>.json` | 每日轻量快照（口径/计数/大类表/全市场），保留最近 120 个交易日 |
| legacy 子树 | `legacy/…` | 同构的一整套（含自己的 `archive/`），供切换口径与 `/api/legacy/*` |

字段级契约（类型/单位/可空/错误码）见 [`API.md`](API.md)。

---

## 6. 自动化拓扑

| 触发 | 位置 | 做什么 |
| --- | --- | --- |
| 每个工作日 UTC 08:30（≈ 北京 16:30） | `.github/workflows/daily.yml` | 恢复 SQLite 缓存/种子 → 增量更新（份额+净值+行情+事件）→ `npm test` → 交叉校验（容错）→ 提交 `site/` 与 `data/*.json` → 发布 Pages |
| push 任意分支 / PR | `.github/workflows/ci.yml` | `npm test` → 有 DB 时离线 `npm run build` → 校验 `site/data/meta.json` |
| 手动 | `.github/workflows/pages.yml` | 先构建再部署（独立通道） |
| 手动 / 登录自启（macOS） | `launchd/` + `bin/*.sh` | 本机定时更新与服务常驻 |

两条更新线（Actions 与 launchd）走同一个 `update()`，天然幂等；各自的锁保证不会同时写库。
`data/etf.db` 靠 `actions/cache` 跨 run 传递（或从 Release 的 `db-seed` 下载），
保存前 `PRAGMA wal_checkpoint(TRUNCATE)`，否则 WAL 里的最新事务会随缓存丢失。

---

## 7. 失败与降级

| 场景 | 行为 |
| --- | --- |
| Actions 里没有 `TUSHARE_TOKEN` | **直接失败**：第一步打印 `::error::`（提示 fork 需自填密钥）后 `exit 1`。宁可红，也不静默只更新沪市 |
| 本地没有 `TUSHARE_TOKEN` | `npm run update` 仍能跑：`warn` 记录深市不可用，只更新沪市口径；`reconcile` 需要 Tushare，以**退出码 2**（无法校验）结束 |
| 交易所接口失败 | 记入 `warnings` 并继续；该日数据缺席而非填 0，`validate` 与测试会发现断裂 |
| Tushare 限流/超预算 | 令牌桶 + 指数退避（最多 4 次）；超出单次/每日预算明确报错并停止，重跑断点续抓 |
| 行情/折算检测失败 | 各自 `warn` 后继续（不影响份额主口径），下次更新会重试 |
| 两个更新同时跑 | `data/.update.lock` 互斥，后来者返回 `{ skipped: "locked" }`；CI 视其为失败 |
| 库为空 | `npm run build` 用 `data/series.json` 冷启动（曲线可看、成分明细为空）；`npm run update` 会自动全量回补 |
| `market` 数据不足 | 不生成 `market.json`，`meta.warnings` 提示，`/api/market` 返回 404 `market not ready` |
| 原站数据冻结 | 不从原站取数，`verify-origin` 只用来解释差异（见 `DATA.md` §7） |

---

## 8. 已知技术债

1. **`lib/taxonomy.mjs` 与 `universe.mjs` 双层**：基线冻结 + 运行时合并，读代码要来回看两个文件；
   基线不能动（回归校验依赖），深市归属只能叠在上面。
2. **legacy 编号在 7 上复用**（`7_消费` / `7_医药`），「9 大类 / 10 个 CATS 项」需要每次解释；
   改编号会波及 `data/series.json` 的键，属破坏性变更。
3. **`subs.json` 约 2.1MB**：每个小类各自带一份日期数组，日期可提到顶层复用（前端需同步改）。
4. **`site/data/` 不入库**：clone 下来不能直接静态托管，必须先构建。
5. **单实例、无鉴权、只绑 `127.0.0.1`**：设计为本机自用，不要暴露公网。
6. **旧库的 `src='szse'` 行**：历史数据，新流程不再产生；不影响数值，但来源统计会多一档。
7. **行情历史覆盖不全**：每日增量只补当天，更早日期依赖 `backfill-quotes.mjs`；未覆盖日期的行情字段为 `null`。
8. **两套口径长期并存**：文档、载荷、UI 都要带「口径」概念，误读成本高。

---

## 本文的核对状态

- 模块职责、表结构、载荷与产物：对照 `lib/*.mjs`、`lib/build/site.mjs`、`server/app.mjs` 源码逐条核对（2026-11-21）。
- 数据源两源、深市由 Tushare、缺密钥即失败：对照 `scripts/update.mjs`、`.github/workflows/daily.yml`。
- v3.8.0 的三处修复（`isBondCat` 统一、`fund.list_date` 迁移、`update` 接行情/事件）已在源码确认（提交 `d23203a`）。
- 两套口径规模（7/72/1903、10/88/1614）：`loadUniverse()` 实测。
- 自动化行为：对照三个 workflow 与 `bin/*.sh`；**未实际触发** GitHub Actions。
- **未复跑**：`npm run update` / `backfill` / `reconcile` / `build` / `verify:origin`（会联网并改写 `data/`、`site/`）。
