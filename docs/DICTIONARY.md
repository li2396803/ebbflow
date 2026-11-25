# 数据字典（SQLite）· ebbflow

本文档描述本地缓存库 `data/etf.db` 的**表、列、来源与更新频率**。
载荷 / API 字段见 [`API.md`](API.md)；口径公式与已知偏差见 [`DATA.md`](DATA.md)；分类体系见 [`CLASSIFICATION.md`](CLASSIFICATION.md)。

- 引擎：Node.js 内置 `node:sqlite`（`DatabaseSync`），**零依赖**。
- 模式：`PRAGMA journal_mode=WAL`、`synchronous=NORMAL`；多数表 `WITHOUT ROWID`（复合主键，省一次索引跳转）。
- 位置：`data/etf.db`（**不入 git**，可由接口重建；CI 用 `actions/cache` 或 Release 种子传递）。
- 时间基准：所有 `date` 都是 `YYYY-MM-DD` 字符串（Asia/Shanghai 的自然日）。
- 数值：`REAL`；「万份」「亿份」「亿元」等单位见各列说明。

> 行数会随每日更新变化，本文**不把行数当契约**。要查当前规模，用：
>
> ```bash
> node -e '
> const { DatabaseSync } = require("node:sqlite");
> const db = new DatabaseSync("data/etf.db", { readOnly: true });
> for (const t of ["fund","share","nav","quote","series","series_v2","market","market_type","event","reconcile","run","dayinfo","meta"]) {
>   const c = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
>   console.log(t.padEnd(12), c);
> }
> db.close();'
> ```

---

## v4.0.0 变更（重要）

| 字段 | 状态 | 说明 |
| --- | --- | --- |
| `subs[name].values` | **已下线**（恒为 `null`，附 `valuesDeprecated: true`） | 旧的「份额（亿份）」序列；份额不再对外展示（不可跨标的相加） |
| `subs[name].flowSeries` | 新增 | 逐日净申购（亿元/日），区间求和用 |
| `subs[name].coverage` | 新增 | 逐日覆盖率（0..1，有数据成分数/成分总数），<0.6 为低覆盖 |
| `subs[name].scaleSeries` | **不下发**（`scaleSeriesSource: "charts"`） | 规模序列统一从 `charts-<cat>.json` 的 `series[].scale` 取，避免重复传输 |
| `subs[name].currentScale` | 新增 | 末日内部分额值对应的规模（亿元） |
| `subs[name].etfRangesFile` | 新增 | 指向 `etf-ranges/<cat>.json`，内含每只 ETF 的预设区间精确指标 |
| `charts-<cat>.json` | 口径变更 | `series[]` 由 `name,color,shares` 改为 `name,color,scale,flow`，`unit: "亿元"` |
| `tables` | 口径变更 | 排行改按「区间规模变化额」，`pct` 为规模变化率，类目行为 Σ 小类规模 |

口径定义见 [METRICS.md](METRICS.md)；`docs/METRICS.md` §5 是实现说明（覆盖率同源、区间净申购含期初当天、月末对齐、缺值写 null）。


## 1. 表总览

| 表 | 角色 | 粒度（主键） | 写入者 | 更新频率 |
| --- | --- | --- | --- | --- |
| `fund` | 名录（维度） | `code` | `lib/db.mjs::upsertFunds`（Tushare `fund_basic`） | 每周（`update` 检查 `fundsAt`）或回补前 |
| `share` | **原始事实**：份额 | `(code, date)` | `putShares` / `putSharesBulk` | 每交易日增量；历史靠 `backfill` |
| `nav` | **原始事实**：单位净值 | `(code, date)` | `putNav`（Tushare `fund_nav`） | 每交易日 |
| `quote` | **原始事实**：行情 | `(code, date)` | `putQuotes`（Tushare `fund_daily`） | 每交易日增量（`update` 第 2.6 步）+ 历史回补 |
| `series` | 派生：legacy 口径序列 | `(sub, date)` | `recomputeAll(legacy)` | 每次 `rebuild` / `update` 全量重算 |
| `series_v2` | 派生：v2 口径序列 | `(sub, date)` | `recomputeAll(universe=v2, legacy=false)` | 同上 |
| `market` | 派生：全市场聚合 | `(date, scope)` | `recomputeAll` | 同上 |
| `market_type` | 派生：按基金类型聚合 | `(date, type)` | `recomputeAll` | 同上 |
| `event` | 派生：份额拆分/合并事件 | `(code, date, kind)` | `detectShareEvents` + `putEvents` | 每交易日重算（`update` 第 2.6 步） |
| `reconcile` | 质量：交叉校验明细 | 无主键（rowid 表） | `scripts/reconcile.mjs` | 每次校验前清空重写 |
| `run` | 运行台账 | 自增 `id` | `recordRun` | 每次 update/backfill/recompute/reconcile |
| `dayinfo` | 覆盖标记 | `date` | `markDaySource` | 抓取时 |
| `meta` | 键值状态 | `k` | `metaSet` | 各流程按需 |

数据流（箭头表示「谁写谁」）：

```
上交所 commonQuery ─┐
Tushare fund_share ─┴→ share ─┐
Tushare fund_nav ─────────────┼→ nav ──┐
Tushare fund_daily ───────────┼→ quote ┤
Tushare fund_basic ─→ fund ───┘        │
                              event ◄───┤（detectShareEvents，人工触发）
                                       ▼
                          recomputeAll（lib/pipeline.mjs）
                    ┌──────────────┬──────────────┬──────────────┐
                    ▼              ▼              ▼              ▼
                 series        series_v2       market       market_type
                    │              │
                    ▼              ▼
             lib/payloads.mjs → site/data/*.json（+ legacy/ 子目录）
```

---

## 2. `fund` — 场内基金名录

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `code` | TEXT PK | 否 | 6 位代码（`5/6` 开头记 `SH`，其余 `SZ`） |
| `name` | TEXT | 是 | 基金简称（Tushare `fund_basic.name`，展示时会截断） |
| `type` | TEXT | 是 | 基金类型：股票型 / 混合型 / 债券型 / 货币型 / REITs / 其他 |
| `market` | TEXT | 是 | `SH` / `SZ`，由代码前缀推断（不是 Tushare 字段） |
| `list_date` | TEXT | 是 | 上市日 `YYYY-MM-DD`，用于剔除「上市首日」造成的假净流入 |

- **来源**：Tushare `fund_basic`（`market="E"`），字段 `ts_code,name,fund_type,list_date`。
- **更新频率**：`update` 每 7 天刷新一次（`meta.fundsAt`）；全量回补前若名录过少也会刷新。
- **用途**：ETF 判定（名称含 `ETF`）、全市场按市场/类型聚合、成分明细的市场标注、上市日。
- 名录里既有 ETF 也有 LOF/REITs 等；**全市场聚合只用名称含 `ETF` 的行**。

## 3. `share` — 每日份额（事实层，最重要）

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `code` | TEXT | 否 | 6 位代码 |
| `date` | TEXT | 否 | 交易日 |
| `wan` | REAL | 否 | 份额，**万份**；`putSharesBulk` 只写有限正数，`putShares` 只校验有限数值 |
| `src` | TEXT | 否 | 来源：`sse`（上交所官方）、`ts`（Tushare）；旧库可能残留 `szse` |

- 主键 `(code, date)`，`WITHOUT ROWID`；索引 `idx_share_date(date)` 支撑「按日取全市场」。
- **来源优先级**：`sse`/`szse` = 1，`ts` = 2。同一 `(code,date)` 只保留一行：
  低优先级**不会覆盖**高优先级；同来源重抓幂等覆盖（`putShares` 逐条判断，`putSharesBulk` 用 SQL `WHERE` 判断）。
- **更新频率**：每交易日增量 —— Tushare 当日全市场（沪深）+ 上交所近 15 日（官方口径优先）。
  历史由 `npm run backfill`（或 CI 冷启动的种子库）补齐。
- 交易日轴不完全由它决定：`tradingDates()` 取的是 `dayinfo.has_sse=1` 的日期（见 §8），
  因为 Tushare 在季末/月末的非交易日也会披露份额，那些日期不进入看板序列。

```sql
-- 某日各来源覆盖
SELECT src, COUNT(*) FROM share WHERE date = '2026-11-20' GROUP BY src;
-- 某只基金的份额历史
SELECT date, wan FROM share WHERE code = '510050' ORDER BY date DESC LIMIT 5;
```

## 4. `nav` — 单位净值

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `code` | TEXT | 否 | 6 位代码 |
| `date` | TEXT | 否 | 净值日期 |
| `nav` | REAL | 是 | 单位净值（元/份） |

- 主键 `(code, date)`，`WITHOUT ROWID`。
- **来源**：Tushare `fund_nav`（`unit_nav`）。
- **更新频率**：每交易日（`update` 取当日全市场净值；`ingestTushareNav` 负责历史回补，断点记 `meta.navDone`）。
- **注意**：净值日期集合比份额日期多（Tushare 会披露非交易日净值 / 季末披露），
  取用时按**当日精确匹配**，不做插值、不前向填充。缺净值的成分不计入 `scale`/`flow`。

## 5. `quote` — 行情（收盘价/成交额/成交量/涨跌幅）

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `code` | TEXT | 否 | 6 位代码 |
| `date` | TEXT | 否 | 交易日 |
| `close` | REAL | 是 | 收盘价（元） |
| `pct_chg` | REAL | 是 | 当日涨跌幅（**百分数数值**，`0.59` = +0.59%） |
| `vol` | REAL | 是 | 成交量（**手**，1 手 = 100 份） |
| `amount` | REAL | 是 | 成交额（**千元**） |

- 主键 `(code, date)`，`WITHOUT ROWID`。
- **来源**：Tushare `fund_daily`（按 `trade_date` 一次取全市场）。
- **更新频率**：每交易日增量 —— `scripts/update.mjs` 第 2.6 步调用 `ingestQuotes()` 补当日行情；
  更早的历史用 `npm run quotes`（`scripts/backfill-quotes.mjs`，可传 `--days` / `--from` / `--to`）回补，进度记 `meta.quotesAt`。
- **用途**：`subs[].etfs[]` 的 `price / premium（折溢价）/ pctChg / amount / turnover`。
  未回补的日期这些字段为 `null`（其余口径不受影响）。
- 单位校验：`amount ≈ close × vol / 10`（千元 = 元 × 手 × 100 / 1000）。

## 6. `series` — legacy 口径派生序列

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `sub` | TEXT | 否 | 小类名（legacy 88 个，与 `series.json` 的键一致） |
| `date` | TEXT | 否 | 交易日 |
| `val` | REAL | 是 | **主口径值（亿份，4 位小数）**；legacy 的 `9_债券` 已 ×100 |
| `scale` | REAL | 是 | 规模（亿元，4 位小数）= Σ 份额×净值 |
| `flow` | REAL | 是 | 净申购（亿元，4 位小数/日）；已剔除拆分合并与上市首日 |

- 主键 `(sub, date)`，`WITHOUT ROWID`。
- **来源**：派生。由 `recomputeAll()`（`lib/pipeline.mjs`）从 `share` + `nav` + `event` 算出。
- **更新频率**：每次 `rebuild` / `npm run update` **全量重算**（先 `DELETE FROM series` 再批量写）。
- 该表只服务于 **legacy 口径**（原看板兼容 / 回归校验）；默认展示用 `series_v2`。
- 同时会导出到 `data/series.json`（冷启动与回归基线）。

## 7. `series_v2` — v2 口径派生序列

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `sub` | TEXT | 否 | 小类名（v2，72 个；如 `大盘宽基`、`科创债`） |
| `date` | TEXT | 否 | 交易日 |
| `val` | REAL | 是 | 份额（亿份，4 位小数）；债券小类 ×100（v3.8.0 起与 legacy 一致） |
| `scale` | REAL | 是 | 规模（亿元） |
| `flow` | REAL | 是 | 净申购（亿元/日） |

- 主键 `(sub, date)`，`WITHOUT ROWID`。
- **来源**：派生（v2 分类宇宙，见 `data/classification-v2.json`）。
- **更新频率**：每次 `rebuild` 全量重算；`lib/build/site.mjs` 在构建时若发现条数明显少于
  「小类数 × 交易日」，会就地重算一次（自愈）。
- **与 `series` 互不覆盖**：两套分类的 `sub` 命名不同、语义不同，各自独立成表，
  默认/legacy 由目录与端点区分，切换口径不会串数据。

## 8. `market` — 全市场聚合

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `date` | TEXT | 否 | 交易日 |
| `scope` | TEXT | 否 | `SH` / `SZ` / `ALL` |
| `shares` | REAL | 是 | 份额合计（**亿份，自然口径**，不债券 ×100） |
| `scale` | REAL | 是 | 规模合计（亿元；缺净值的成分只计份额） |
| `etfs` | INTEGER | 是 | 当日有份额数据的 ETF 只数 |

- 主键 `(date, scope)`，`WITHOUT ROWID`；每个交易日 3 行。
- **口径**：统计名录里**全部场内 ETF（沪深）**，不是 72/88 个分类里的成分；
  交易所快照里混着的 REITs / LOF / 普通指数基金会按名称过滤掉。
- **更新频率**：每次 `rebuild` 全量重算。
- 载荷：`market.json`（`total` / `sh` / `sz` / `byType`）。

## 9. `market_type` — 按基金类型聚合

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `date` | TEXT | 否 | 交易日 |
| `type` | TEXT | 否 | 基金类型（股票型 / 债券型 / 货币型 / 混合型 / REITs / 其他） |
| `shares` | REAL | 是 | 份额合计（亿份） |
| `scale` | REAL | 是 | 规模合计（亿元） |
| `etfs` | INTEGER | 是 | 只数 |

- 主键 `(date, type)`，`WITHOUT ROWID`；每交易日行数 = 当日出现的类型数。
- 载荷里只输出**最新交易日**的类型分布（`market.byType`）。

## 10. `event` — 份额拆分 / 合并（净流入口径修正）

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `code` | TEXT | 否 | 6 位代码 |
| `date` | TEXT | 否 | 事件发生日（份额跳变当天） |
| `kind` | TEXT | 否 | `split`（拆分，份额变大）/ `merge`（合并，份额变小） |
| `ratio` | REAL | 是 | 折算比例（当日份额 ÷ 前一日份额，3 位小数） |

- 主键 `(code, date, kind)`，`WITHOUT ROWID`。
- **来源**：派生。`detectShareEvents()`（`lib/pipeline.mjs`）扫描 `share` 表得到候选：
  1. 相邻两日份额比值落在常见比例（2/3/4/5/8/10 及其倒数）±3% 内；
  2. **新水平要维持住**（次日相对当日变化在 ±15% 内），排除「快照残缺」造成的假跳变。
- **写入**：`putEvents()`；`scripts/update.mjs` 第 2.6 步每日执行「检测 + 写入」，
  需要时也可以单独重跑（`detectShareEvents()` → `putEvents()`）。
- **用途**：`recomputeAll()` 计算 `flow` 时，把事件之前的历史份额换算到当前份额单位后再做差，
  避免拆分/合并被当成巨额申赎。**份额水位（`series.val` / 载荷里的 `shares`）仍按原始披露值展示。**
- 现有规模：254 起（`split` 166 / `merge` 88），日期范围 2021-11-26 ~ 2026-11-05。

## 11. `reconcile` — 交叉校验明细

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `date` | TEXT | 否 | 交易日 |
| `sub` | TEXT | 否 | 小类名（小类层校验） |
| `code` | TEXT | 是 | 代码（逐只校验时；汇总行可为空） |
| `a` | REAL | 是 | 交易所侧（`src=sse`）数值 |
| `b` | REAL | 是 | Tushare 侧数值 |
| `note` | TEXT | 是 | 说明（偏离比例、方向等） |

- 无自增主键列；索引 `idx_reconcile_date(date)`。
- **写入**：`scripts/reconcile.mjs` —— **每次先 `DELETE FROM reconcile` 再写**，最多保留 5000 行。
  因此它只反映「最近一次校验」，不是历史台账（历史看 `run` 表与 `data/quality.json`）。
- 校验针对**沪市两口径**（交易所 vs Tushare）；深市无交易所侧，不进入逐只比对。
- 退出码：`0` 全部在容差内 / `1` 有 >1% 分歧 / `2` 无法校验。

## 12. `run` — 运行台账

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | 否 | 自增 |
| `at` | TEXT | 否 | ISO 时间戳 |
| `kind` | TEXT | 是 | `update` / `recompute` / `reconcile` / `backfill:sse` / `backfill:ts` |
| `ok` | INTEGER | 是 | 1 成功 / 0 失败 |
| `stats` | TEXT | 是 | JSON 字符串：行数、耗时、Tushare 调用统计等 |
| `err` | TEXT | 是 | 失败原因 |

- **用途**：排查「哪次更新、跑了多久、写成什么样」。`lastRun()` 取最后一条。
- **更新频率**：每次更新/重算/校验追加一行。

```sql
SELECT id, at, kind, ok, substr(stats,1,120) FROM run ORDER BY id DESC LIMIT 5;
```

## 13. `dayinfo` — 当日来源覆盖标记

| 列 | 类型 | 可空 | 含义 |
| --- | --- | --- | --- |
| `date` | TEXT PK | 否 | 日期 |
| `has_sse` | INTEGER | 是 | 当日有上交所快照（=1） |
| `has_szse` | INTEGER | 是 | 当日有深交所快照（历史遗留，v3 起不再写入） |
| `has_ts` | INTEGER | 是 | 当日有 Tushare 数据 |

- **关键作用**：`tradingDates()` = `SELECT date FROM dayinfo WHERE has_sse=1`。
  交易所（上交所）有快照的日期才算「交易日」，天然排除 Tushare 的季末/非交易日披露。
  序列轴、窗口、统计口径全部基于它。
- 合并口径也依赖它：某市场当日有交易所快照时，该市场只认交易所行，不再叠加 Tushare 补的行。

## 14. `meta` — 键值状态

`k` 主键，`v` 为 **JSON 字符串**（`JSON.parse` 后才是真实类型）。

| 键 | 值类型 | 写入者 | 含义 |
| --- | --- | --- | --- |
| `updatedAt` | string(ISO) | `update` | 最近一次更新完成时间 |
| `fundsAt` | string(ISO) | `update` | 名录最近刷新时间（7 天节流） |
| `historyComplete` | string(ISO) | `update` | 历史已完整（交易日/标的数/净值行数达标），跳过自动回补 |
| `tsDone` | string[] | `ingestTushareRange` | 份额回补已完成的代码（断点续跑） |
| `navDone` | string[] | `ingestTushareNav` | 净值回补已完成的代码 |
| `bf:tsDone` | string[] | `scripts/backfill.mjs` | backfill 自己的份额断点（与 `tsDone` 取并集） |
| `bf:sseEmpty` | string[] | `scripts/backfill.mjs` | 上交所返回空的日期（节假日/未披露），后续不再重抓 |
| `ts:calls:<YYYY-MM-DD>` | number | `lib/tushare.mjs` | 当日 Tushare 调用次数（每日预算 `TUSHARE_DAILY_BUDGET`） |
| `quotesAt` | string(ISO) | `scripts/backfill-quotes.mjs` | 行情最近回补时间 |
| `reconcileAt` | string(ISO) | —（保留） | `buildQuality` 会读；当前未写入，缺失时为 `null` |

```sql
SELECT k, substr(v,1,80) FROM meta ORDER BY k;
```

---

## 15. 派生口径（写库时的计算规则）

| 产物 | 公式 | 备注 |
| --- | --- | --- |
| `series.val` / `series_v2.val` | `Σ 成分份额(万份) / 1e4 × factor` | `factor`：债券大类 100，其余 1（legacy 判据 `cat === "9_债券"`） |
| `series.scale` | `Σ (份额/1e4) × 当日净值` | 缺净值的成分跳过 |
| `series.flow` | `Σ (adjWan_t − adjWan_{t−1}) / 1e4 × 当日净值` | `adjWan` 按 `event` 归一到当前份额单位；跳过上市首日；缺净值/缺前一日份额则不计 |
| `market.shares` | `Σ 全部 ETF 份额(万份)/1e4` | 自然口径，**不** ×100 |
| `market.scale` | `Σ 份额×净值` | 缺净值只计份额 |
| `market_type.*` | 同上，按 `fund.type` 分组 | — |
| `event.ratio` | `share_t / share_{t−1}` | 3 位小数 |

合并优先级（同一 `(code,date)`）：`sse`（=1）> `ts`（=2）；`szse` 仅历史遗留（=1）。

---

## 16. 常见查询

```sql
-- 1) 最新交易日与序列轴长度
SELECT MAX(date) FROM series_v2;

-- 2) 某小类的最近 10 天（三指标）
SELECT date, val, scale, flow FROM series_v2 WHERE sub = '大盘宽基' ORDER BY date DESC LIMIT 10;

-- 3) 全市场最新一日
SELECT * FROM market WHERE date = (SELECT MAX(date) FROM market) ORDER BY scope;

-- 4) 某日各来源覆盖（确认深市是否只来自 Tushare）
SELECT src, COUNT(*) FROM share WHERE date = '2026-11-20' GROUP BY src;

-- 5) 拆分/合并事件最多的代码
SELECT code, COUNT(*) c FROM event GROUP BY code ORDER BY c DESC LIMIT 5;

-- 6) 最近几次运行
SELECT id, at, kind, ok FROM run ORDER BY id DESC LIMIT 10;
```

---

## 17. 维护注意与已修复问题

### 17.1 已修复（v3.8.0 · 提交 `d23203a`）

| 问题 | 现象 | 修复方式 |
| --- | --- | --- |
| 新库缺 `fund.list_date` 列 | 空库首次刷新名录报 `table fund has no column named list_date`；`buildSubs()` 也会失败 | `openDb()` 迁移段加幂等 `ALTER TABLE fund ADD COLUMN list_date TEXT`（与 `series.scale/flow` 同写法） |
| v2 债券小类未 ×100 | 同一小类的「小类值」与「成分明细合计」差约 100 倍 | `recomputeAll()` 的 factor 改用 `isBondCat()`，同时认 legacy `9_债券` 与 v2 `bond` |
| `event` / `quote` 不在每日流程 | 新拆分/合并不会进 `event`（`flow` 假跳变）；行情只有手动脚本会写 | `scripts/update.mjs` 第 2.6 步每日执行 `ingestQuotes()` + `detectShareEvents()` + `putEvents()` |
| `server/app.mjs` 的 `get payloads()` 调用未定义函数 | 一旦访问该 getter 抛 `ReferenceError` | 改为 `return payloadsFallback()` |

验证方式：空库启动后 `PRAGMA table_info(fund)` 含 `list_date`；`subs["科创债"].current` 与成分合计比值 1.00；
`npm run update` 日志出现「行情：N 天 / M 行」「份额折算事件：K 起」。

### 17.2 重建窗口内可能读到空表

`rebuild()` 先 `DELETE FROM series / market / market_type`（以及 `series_v2`），再批量重算写入。
两个步骤之间是已提交状态，**并发读者可能读到 0 行**（WAL 下单连接事务快照内不会）。
用 `run` 表里 `kind='recompute'` 的时间戳判断是否刚重建过；自己的脚本建议先 `BEGIN` 读事务再查多表。

### 17.3 旧库的 `src='szse'` 行

v3 起不再写深交所快照，但旧库可能残留 `src='szse'`（及其 `dayinfo.has_szse=1`）。
读取侧仍兼容（按「该市场有官方快照则优先官方」处理），不影响数值；
如需清理：`DELETE FROM share WHERE src='szse'; UPDATE dayinfo SET has_szse=0;`。

### 17.4 `reconcile` 表是「最新一次」而非历史

每次校验前清空。要留档请另存 `data/quality.json`（每日流水线会提交）。

### 17.5 行情历史仍不完整

每日增量只补「当日」，更早的日期依赖 `scripts/backfill-quotes.mjs`。当前约 297 个交易日有行情；
未覆盖日期的 `subs[].etfs[]` 行情字段为 `null`，其余口径不受影响。

## 本文的核对状态

- 表结构与列类型：只读打开 `data/etf.db` 的 `sqlite_master` + `PRAGMA table_info` 实测（2026-11-21 20:4x）。
- 写入者与更新频率：对照 `lib/db.mjs`、`lib/pipeline.mjs`、`scripts/update.mjs`、`scripts/backfill*.mjs`、
  `scripts/reconcile.mjs`。
- 事件规则与 254 起：对照 `lib/pipeline.mjs::detectShareEvents` 与 `docs/CLASSIFICATION.md` §12，
  并在 `event` 表实测（`split` 166 / `merge` 88）。
- `quote` 单位：用 `close × vol / 10 ≈ amount`（误差 0.4%）实测确认。
- 行数：本文刻意不写死（并发重建期间会瞬时变化），只给自查命令。
- **v3.8.0 修复已在源码与产物中复核**（`isBondCat` 统一、`fund.list_date` 迁移、`update` 接行情/事件、
  `payloadsFallback()`）；债券比值用 `site/data/subs.json` 复测为 1.00。
- **未实跑**：`npm run update` / `backfill` / `reconcile`（会联网并改写 `data/`）；相关行为按源码与既有
  `run` 表记录描述。
