# 架构说明 · etf-flow

本文回答三个问题：**数据从哪来、经过哪些模块、为什么这么设计**。
口径公式与字段级细节见 [`DATA.md`](DATA.md)，本地开发与改造指引见 [`DEVELOPING.md`](DEVELOPING.md)。

- 定位：ETF 细分行业资金流向看板 —— 9 个编号大类 / 86 个细分行业 / 773 只 ETF 成分；
  另有一份**全市场总览**（沪深全部场内 ETF，约 1953 只）。
- 形态：一条离线可重建的数据管道 + 一份静态站点 + 一个本地服务。
- 数据源：**两个** —— 上交所（沪市官方口径）+ Tushare Pro（深市唯一来源、沪市第二参照与净值）。
- 约束：**零运行时依赖**、原生 ESM、Node.js ≥ 22.5（用到内置 `node:sqlite`）。
- 许可：MIT。分类体系与看板形态源自 B 站 UP 主「生炸瓜」的作品，本项目为独立重写，见 [`../NOTICE.md`](../NOTICE.md)。

> 关于「9 个大类」的说明：页面按编号 1–9 分大类，其中 **7 号被拆成「消费」「医药」两个页签**，
> 所以 `lib/taxonomy.mjs` 里的 `CATS` 数组实际是 **10 项**。对外表述统一为「9 大类 · 86 个细分行业」。

---

## 1. 端到端数据流

```
数据源（两个，能力互补）
  上交所 commonQuery  STAT_DATE=YYYY-MM-DD
    → 当日沪市全部 ETF 份额（万份，官方口径，可按日期回溯）
  Tushare Pro  fund_share / fund_nav / fund_basic
    → 沪深两市每日份额（万份，4 位小数）+ 单位净值；深市数据的唯一来源
                    │
                    │  UA / Referer / 重试 / 限并发 / 令牌桶
                    ▼
   lib/sources.mjs（上交所公开接口）      lib/tushare.mjs（Tushare，限流与预算）
                    │
                    ▼
   lib/pipeline.mjs  ① 合并落库（code+date 单行，按来源优先级裁决）
                     ② 重算派生序列 + 全市场聚合（口径在这里）
                    │
                    ▼
   lib/db.mjs  →  data/etf.db  （SQLite / WAL / node:sqlite）
                    │
        ┌───────────┼──────────────────────┐
        ▼           ▼                      ▼
 lib/payloads.mjs  scripts/reconcile.mjs       scripts/verify-origin.mjs
 派生站点载荷       两口径交叉校验               与原站已发布序列对比
 meta/charts/      → data/quality.json         → data/validation-origin.json
 tables/subs/      （+ reconcile 表）
 market/index/
 quality
        │
        ▼
 lib/build/site.mjs   拷贝 web/ → site/，写 site/data/*.json，注入签名
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
| `lib/sources.mjs` | 上交所逐日快照、候选交易日生成、限并发工具 | 不写库、不算口径；**不直连深交所**（v3 起已移除） |
| `lib/tushare.mjs` | `fund_share` / `fund_nav` / `fund_basic`，token 读取、令牌桶限流、单次/每日预算、频率类错误退避 | 不做业务聚合 |
| `lib/db.mjs` | 建表与演进式迁移、来源优先级合并（`putShares`）、序列与全市场聚合读写、运行记录、统计 | 不含分类知识（除全市场聚合的类型分组） |
| `lib/taxonomy.mjs` | 分类体系：大类 / 小类 / 成分 ETF / 配色（自动生成，不手改） | 不含数据 |
| `lib/pipeline.mjs` | 编排抓取 → 合并落库 → 重算 `series` 与全市场聚合；必要时自动全量回补 | 不生成站点载荷 |
| `lib/aggregate.mjs` | v1 遗留的聚合/窗口函数 | 主流程已不再依赖（见 §8） |
| `lib/validate.mjs` | 数据质量规则：单只跳变、小类跳变、覆盖度骤降、零负值、序列断裂 | 只读：不修数、不写库 |
| `lib/payloads.mjs` | 把库里的数据切成前端契约：`meta/charts/tables/subs/market/index/quality` | 不碰文件系统（除读 `quality.json`） |
| `lib/build/site.mjs` | 构站：写 `site/data/*.json`（原子写）、拷贝 `web/`、注入签名、清 v1 遗留目录 | 不联网 |
| `lib/signature.mjs` | 项目身份常量与 HTML 注入 | — |
| `scripts/update.mjs` | 增量更新入口（`update({lookback})`），带进程内互斥锁 | 不处理历史全量 |
| `scripts/backfill.mjs` | 全量回补编排，断点续跑、`--dry-run`、`--limit` | 不构站 |
| `scripts/build.mjs` | 离线重建 `site/`；无 DB 时用 `data/series.json` 冷启动 | 不联网 |
| `scripts/reconcile.mjs` | 两口径交叉校验（交易所 vs Tushare）→ `data/quality.json` + `reconcile` 表，退出码 0/1/2 | 不改原始数据 |
| `scripts/verify-origin.mjs` | 用自建数据复算，与原站已发布图表序列逐点对比 | 不改原站副本 |
| `server/app.mjs` | 静态托管 + `/api/*` + 过期自检与自动刷新 | 无鉴权，只绑 `127.0.0.1` |
| `lib/build` 之外：`web/` | 前端源码（原生 JS + 本地 `echarts.min.js`） | 不含数据 |

---

## 3. 存储模型

`data/etf.db` 是**本地缓存**，不进 git，可由接口重建（见 §7）。表结构：

| 表 | 主键 / 说明 | 用途 |
| --- | --- | --- |
| `fund` | `code` 唯一 | ETF 名录（名称、类型、市场），用于展示与全市场聚合 |
| `share` | `(code, date)` 唯一，含 `wan`、`src` | 原始份额（万份）。`src` ∈ `sse` / `ts`（旧库可能残留 `szse`） |
| `nav` | `(code, date)` 唯一 | 单位净值，金额口径（规模/净流入）依赖它 |
| `series` | `(sub, date)` 唯一 | 派生序列：`val`（亿份）、`scale`（规模，亿元）、`flow`（净流入，亿元） |
| `market` | `(date, scope)`，`scope ∈ SH/SZ/ALL` | 全市场聚合（统计名录里全部场内 ETF，不只 773 只） |
| `market_type` | `(date, type)` | 按基金类型（股票型/债券型/货币型/其他）聚合 |
| `dayinfo` | `date` | 当日各来源是否就绪 |
| `reconcile` | 自增 | 交叉校验明细（最多保留 5000 行） |
| `run` | 自增 | 运行记录（kind / ok / stats / err） |
| `meta` | `k` | 零碎状态：回补断点、Tushare 调用计数、更新时间等 |

> **旧库兼容**：v3 之前抓过深交所快照的库里会残留 `src='szse'` 的 `share` 行，
> `dayinfo.has_szse` 也可能为 1。这些是历史数据，新流程不再写入；读取侧（`recompute`）仍按
> 「该市场有官方快照则优先官方」的逻辑兼容，所以旧库可以直接继续用，不需要清库。
>
> **演进式迁移**：`series.scale` / `series.flow` 与 `market` / `market_type` 通过
> `ALTER TABLE ... ADD COLUMN` 与 `CREATE TABLE IF NOT EXISTS` 幂等添加，打开旧库即自动升级。

---

## 4. 为什么这么设计

### 4.1 来源优先级：交易所 > Tushare

同一 `code + date` 全库只保留一行。写入时按优先级裁决：

| 来源 | 优先级 | 理由 |
| --- | --- | --- |
| `sse` | 1（高） | 交易所官方披露的登记份额，是这一天的权威口径 |
| `ts` | 2（低） | 第三方加工数据，用于补深市、补缺、精度参照与净值 |

低优先级**不会覆盖**已存在的高优先级数据；同来源重抓则幂等覆盖。
因此「先写 Tushare 再抓到交易所」是安全的，反过来也不会把官方值冲掉。
这样增量更新就变成**与顺序无关**的操作，失败重跑不会污染数据。

### 4.2 深市数据全部来自 Tushare

- 上交所接口带 `STAT_DATE`，能按日期回溯任意历史交易日 → 沪市历史可以直接重建。
- 深交所官方接口只有「当前规模」一份快照，**没有历史**：每天存一份也只能积累未来的数据，
  用来做历史序列没有意义。因此 v3 起**不再调用深交所接口**（`scripts/update.mjs` 的调用点已移除；
  `lib/sources.mjs` 里残留的旧函数属待清理的死代码，不参与任何流程），
  深市份额与净值统一由 Tushare 的 `fund_share` / `fund_nav` 提供。
- 分类体系的 773 只成分全部是沪市代码（`5xxxxx`），所以**看板的小类/大类数值不受深市影响**；
  深市数据用于**全市场总览**（`market.json`：沪深两市合计与按类型分布）。
- 结论：数据源只有两个 —— **上交所（沪市官方口径）+ Tushare（深市唯一来源、沪市第二参照）**。
  交叉校验相应变成「沪市两口径比对」：交易所 vs Tushare。

### 4.3 交易日轴 = 有数据的日子

`tradingDates()` 取的是 `share` 表里出现过的日期，而不是日历推算或外部交易日历：

- 不需要维护节假日表，非交易日接口返回空，自然不会落库；
- 某个交易日整体抓取失败时会**显式缺席**，而不是被填成 0（填 0 会让曲线出现假的断崖）；
- 代价是序列可能出现「结构性缺口」，所以 `lib/validate.mjs` 专门有 `findGaps()` 检测断裂。

回补时用 `candidateDates(from, to)` 先跳过周末生成候选，再由接口空结果过滤节假日 ——
节流的同时不会漏掉调休交易日。

### 4.4 内部 4 位小数，展示 1 位

- 交易所给的是整数万份，Tushare 给 4 位小数万份；统一在库内按 4 位小数保存，
  避免「先四舍五入再跨 86 个小类相加」把误差放大。
- 小类值量级从几亿份到上千亿份不等，4 位小数既保留小量级的有效位，又不至于让 JSON 膨胀。
- 展示层统一 1 位小数（`round1`），图表与表格的读数保持一致。
- **债券大类 ×100** 是唯一的特殊折算：债券 ETF 面值 100 元/份，不折算的话它和其他大类不可比
  （详见 [`DATA.md` §1](DATA.md)）。

### 4.5 零运行时依赖

- 少一层供应链风险：没有 `node_modules` 就没有 lockfile 漂移、没有间接依赖的 CVE 噪音。
- `node:sqlite` 已能覆盖本项目需要的存储能力（WAL、事务、预编译语句），不必引 better-sqlite3。
- CI 里的安装步骤只是兜底（有 lockfile 才 `npm ci`），实际不下载任何包，跑得快也稳。
- 前端同理：ECharts 以 `site/echarts.min.js` 本地副本提供，不引 CDN，断网也能看。

### 4.6 静态优先、API 兜底

- 站点要能「双击 `site/index.html` 就能看」—— 这要求取数走同目录相对路径的静态 JSON。
- 本地服务要能「刷新数据后立刻看到」—— 这要求有 `/api/*`。
- 两者共存的办法就是：前端先试静态文件，404 了再打 API。同一份代码，两种部署。

### 4.7 `site/data/` 是产物，不入库

- 载荷 JSON 可由「库 + 构建脚本」确定性重建，入库只会让 git 历史每天膨胀几 MB。
- 代价是「仓库自带的 `site/` 单独拿去托管会没有数据」，所以：
  - 本地用 `npm run build`（无库时自动用 `data/series.json` 冷启动）；
  - CI 里由 `daily.yml` 构建后直接发布 Pages，不依赖入库的 `site/data/`。
- `data/series.json` 是例外：它是**冷启动底座 + 回归基线**，必须入库（`scripts/lint.mjs` 会检查它 ≥ 1000 个交易日）。

---

## 5. 载荷契约

`lib/payloads.mjs` 产出的七类载荷，写入 `site/data/` 并由 `/api/*` 以同样形状返回：

| 载荷 | 文件 | 内容 |
| --- | --- | --- |
| `meta` | `meta.json` | 最新交易日、区间与交易日数、规模计数、来源（`上交所`、`Tushare`）、指标单位、沪深两市 ETF 数与覆盖数、告警、`signature` |
| `charts` | `charts-<大类key>.json` | 每个大类三份序列：`c1` 绝对值（亿份）、`c2` 长期归一（首个有效日 = 100）、`c3` 近 7 日窗口归一（窗口首日 = 100） |
| `tables` | `tables.json` | 首页三张表：大类规模与区间变动、增幅前 5、降幅前 5，外加全量排行 |
| `subs` | `subs.json` | 每个细分行业的成分 ETF 明细（份额、规模、净流入、净值覆盖率）与自身历史 |
| `market` | `market.json` | 全市场总览：`total` / `sh` / `sz` 的份额与规模序列、最新 ETF 只数、`byType`（按基金类型）；**不做债券 ×100 折算** |
| `index` | `index.json` | 搜索索引：小类 → 大类，代码 → 所属小类（反向索引，含拼音首字母） |
| `quality` | `quality.json` | 交叉校验摘要（由 `data/quality.json` 适配而来） |

`market.json` 与细分行业页的口径不同：它统计**全部场内 ETF（沪深，约 1953 只）**，
而 `subs`/`series` 只统计分类体系里的 773 只沪市成分。两个数字不可直接相加或互相比较。

前端契约的稳定性靠两点保证：载荷字段由 `lib/payloads.mjs` 单点定义；`tests/cases/*` 覆盖口径与数值范围。
改动载荷字段属于**破坏性变更**，需要在 `CHANGELOG.md` 里记一笔。

---

## 6. 自动化拓扑

| 触发 | 位置 | 做什么 |
| --- | --- | --- |
| 每个工作日 UTC 08:30（≈ 北京 16:30） | `.github/workflows/daily.yml` | 恢复 SQLite 缓存 → 增量更新 → `npm test` → 交叉校验（容错）→ 提交 `site/` 与 `data/*.json` → 发布 Pages |
| push 任意分支 / PR | `.github/workflows/ci.yml` | `npm test` → 有 DB 缓存时离线 `npm run build` → 校验 `site/data/meta.json` |
| 手动 | `.github/workflows/pages.yml` | 先构建再部署（不依赖每日流水线的独立通道） |
| 手动 / 登录自启（macOS） | `launchd/` + `bin/*.sh` | 本机定时更新与服务常驻 |

两条更新线（Actions 与 launchd）走同一个 `update()`，天然幂等；各自的锁保证不会同时写库。
`data/etf.db` 靠 `actions/cache` 跨 run 传递，保存前会 `PRAGMA wal_checkpoint(TRUNCATE)`，
否则 WAL 里的最新事务会随缓存丢失。

---

## 7. 失败与降级

| 场景 | 行为 |
| --- | --- |
| Actions 里没有 `TUSHARE_TOKEN` | **直接失败**：第一步「检查 TUSHARE_TOKEN」打印 `::error::`（提示 fork 需自填密钥，并给出注册与配置路径）后 `exit 1`。宁可红，也不要「静默只更新沪市」 |
| 本地没有 `TUSHARE_TOKEN` | `npm run update` 仍能跑：`warn` 记录「深市数据不可用」，只更新沪市交易所口径；`npm run reconcile` 需要 Tushare，会以**退出码 2**（无法校验）结束 |
| 某个交易所接口失败 | 记入 `warnings` 并继续；该日数据缺席而非填 0，`npm test` 与 `validate` 会发现断裂 |
| Tushare 触发频率/额度限制 | 令牌桶 + 指数退避重试（最多 4 次）；超出单次/每日预算**明确报错并停止**，重跑可断点续抓 |
| 两个更新同时跑 | `data/.update.lock` 互斥，后来者返回 `{ skipped: "locked" }`；CI 把它当失败处理，绝不「没更新却提交」 |
| 库为空 | `npm run build` 用 `data/series.json` 冷启动（曲线与规模可看，成分明细为空）；`npm run update` 会自动全量回补 |
| Pages 未启用 | 部署步骤纯手动；`daily.yml` 的构建产物仍可作为 Actions artifact 下载 |
| 原站数据冻结 | 不从原站取数，`verify-origin` 只用来解释差异（见 `DATA.md` §7） |

---

## 8. 已知技术债

1. **`lib/aggregate.mjs` 是 v1 遗留**（聚合与窗口函数），主流程已不再调用；删除前需确认没有外部脚本依赖。
2. **分类编号在 7 上复用**（`7_消费` / `7_医药`），导致「9 个大类 / 10 个 `CATS` 项」的表述需要每次都解释一次。改编号会波及 `data/series.json` 的键，属于破坏性变更。
3. **`data/subs.json` 约 1.9MB**：86 个小类各自带一份日期数组，日期可提到顶层复用（前端需同步改）。
4. **`site/data/` 不入库**，所以「clone 下来直接静态托管」这条路走不通，必须先构建；文档里已反复提示。
5. **单实例、无鉴权、只绑 `127.0.0.1`**：设计目标是本机自用，不要暴露到公网。
6. **旧库里的 `src='szse'` 行**是 v3 之前的历史数据，新流程不再产生；清理与否不影响数值，但会让「来源统计」里多出一档。
7. **两套口径并存**（773 只分类成分 vs 约 1953 只全市场 ETF）：文档、载荷与界面上都要靠 `note`/`unit` 字段反复说明，容易误读。

---

## 本文的核对状态

- 模块职责表、表结构、载荷字段：对照 `lib/*.mjs`、`server/app.mjs`、`lib/build/site.mjs` 源码逐条核对（2026-11-21）。
  其中 `market`/`market_type` 表、`series.scale/flow` 列、`market.json` 载荷均已在源码与只读库中确认存在。
- 数据源口径（两源、深市由 Tushare 承担、`::error::` 缺失密钥即失败）：依据维护者 2026-11-21 的变更说明与
  `.github/workflows/daily.yml` 的步骤内容。
- 数据规模：只读打开 `data/etf.db` 实测（份额行、序列行、交易日数），复现方式见 `DATA.md` §8。
- 自动化行为：对照三个 workflow 文件与 `bin/*.sh`；**未实际触发** GitHub Actions。
- `node scripts/lint.mjs`：实跑通过（7 项，输出见 `DEVELOPING.md` 末尾）。
- 未复跑：`npm run update` / `backfill` / `reconcile` / `build` / `verify:origin`（会改写 `data/`、`site/`，协同时避免互相踩踏）；相关描述以源码与既有 `data/quality.json` 为准。
