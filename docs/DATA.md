# 数据说明 · 口径、字段与质量

本文是数据侧的「字典 + 说明书」。架构与模块职责见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

一句话：**看板展示的是「份额（亿份）」，不是金额**；金额口径的「规模 / 净流入」是按净值折算的估算值。
两者都标注了单位和大致误差来源，请勿混用。

---

## 1. 口径

### 1.1 细分行业值（主口径）

```
细分行业值(亿份) = Σ 该小类成分 ETF 当日份额(万份) ÷ 1e4
大类「9_债券」    = 上面的值 × 100        # 债券 ETF 面值 100 元/份，跟随原站折算口径
```

- 单位：**亿份**。交易所给的是「万份」，除以 1e4 得亿份。
- 库内精度：**4 位小数**（`series.val`）；展示取 1 位小数。
- 没有成分数据的日子写 `NULL`，**不写 0**：0 会伪造出「份额归零」的断崖。
- 若某小类当天一个成分都没数据 → `NULL`（不是 0）。

### 1.2 为什么债券要 ×100

债券 ETF 面值 100 元/份，股票 ETF 通常 1 元/份。同样「1 亿份」，债券对应的资金量是 100 倍。
不折算的话债券大类的「亿份」和其他大类不在一个量级，跨大类的规模对比与排行会失真。
×100 后各列数量级对齐 —— 这是原站的口径，本项目保持一致。

> 注意：×100 **只作用于份额口径**。金额口径（规模/净流入）本身已按净值折算，不再乘。

### 1.3 金额口径（估算）

```
规模(亿元)  = Σ 成分 ETF [ 份额(万份) ÷ 1e4 × 当日单位净值(元/份) ]
净流入(亿元) = Σ 成分 ETF [ (当日份额 − 上一交易日份额)(万份) ÷ 1e4 × 当日单位净值 ]
```

- 净值来自 Tushare `fund_nav`；缺净值的成分不进金额合计（份额口径不受影响）。
- 「净流入」是**近似值**：严格口径要按申赎清单/折溢价拆解，这里只做「Δ份额 × 当日净值」。
  它回答的是「这一周钱大概往哪边挪」，不是精确的申赎金额。
- 覆盖率与缺失成分会在前端抽屉里标注（`navCoverage`）。

### 1.4 归一化序列（图表用，不是数据本身）

`lib/payloads.mjs` 在**展示层**做两种归一，不改库里的值：

| 序列 | 基准 | 含义 |
| --- | --- | --- |
| `c2` 长期 | 该小类首个有效日 = 100 | 长期趋势（与原站一致：切窗口后重新归一） |
| `c3` 近 7 日 | 窗口内首个有效值 = 100 | 「最近一周谁在动」 |

因此 `c2`/`c3` 的起点永远是 100，**不是绝对涨跌**。要绝对量请看 `c1`（亿份）。

---

## 2. 数据源能力矩阵

本项目只有**两个**数据源。深交所官方接口只有「当前规模」一份快照、无法回溯历史，
v3 起已**不再调用**（`scripts/update.mjs` 的调用点已移除），深市数据统一走 Tushare。

| 来源 | 接口 | 字段 | 单位 | 可回溯 | 在本项目中的角色 |
| --- | --- | --- | --- | --- | --- |
| 上交所 | `query.sse.com.cn/commonQuery.do`，`sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L`，`STAT_DATE=YYYY-MM-DD` | `TOT_VOL` | 万份（整数） | ✅ 任意历史交易日 | 沪市主数据源（官方口径）；日常近 15 日增量 + 全量回补 |
| Tushare Pro | `fund_share`（按 `ts_code` 或 `trade_date`） | `fd_share` | 万份，4 位小数 | ✅ 一般 5 年以上（受账号积分限制） | **深市唯一来源**；沪市补缺与第二参照 |
| Tushare Pro | `fund_nav` | `unit_nav` | 元/份 | ✅ | 金额口径（规模/净流入） |
| Tushare Pro | `fund_basic` | 名称/类型/市场 | — | — | 刷新 `fund` 名录（每周一次） |

### 2.1 覆盖范围：两套口径

| 口径 | 范围 | 用在哪 | 载荷 |
| --- | --- | --- | --- |
| 分类体系 | 86 个小类、773 只成分 ETF（**全部沪市** `5xxxxx`） | 细分行业曲线、大类汇总、排行、明细抽屉 | `charts` / `tables` / `subs` |
| 全市场 | 沪深**全部场内 ETF（约 1953 只）** | 全市场总览（沪深合计与按基金类型分布） | `market` |

两套口径的数字**不可互相比较或相加**：全市场统计所有 ETF，分类体系只统计被选中的 773 只沪市成分。
`market.json` 里的 `note` / `unit` 字段会再次提示这一点。

抓取纪律（`lib/tushare.mjs`）：

| 参数 | 默认 | 环境变量 | 作用 |
| --- | --- | --- | --- |
| 每分钟调用上限 | 120 | `TUSHARE_RPM` | 全局令牌桶，跨并发共享，不随并发放大 |
| 单次运行预算 | 800 | `TUSHARE_MAX_CALLS_PER_RUN` | 超出即停并报错，重跑可断点续抓 |
| 每日预算 | 4000 | `TUSHARE_DAILY_BUDGET` | 计数持久化在 `meta.ts:calls:<date>`，跨进程累计 |
| 重试 | 4 次 | — | 频率类错误指数退避 + 抖动 |

交易所侧：并发 ≤ 6、请求带浏览器 UA 与 Referer、单次增量只回溯最近 15 天。
**请勿改成高频轮询** —— 这是对公共接口的基本礼貌，也是本项目能长期免费运行的前提。

---

## 3. 字段字典

数据库 `data/etf.db`（SQLite，WAL，`node:sqlite`）。`data/etf.db` 不进 git，可由接口重建。

### 3.1 `fund` — ETF 名录

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `code` | TEXT PK | 6 位基金代码 |
| `name` | TEXT | 基金简称（截断显示用） |
| `type` | TEXT | 基金类型（股票型 / 债券型 / 货币型 / 其他） |
| `market` | TEXT | `SH` / `SZ`（由代码前缀与名录推断） |

### 3.2 `share` — 原始份额（事实层）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `code` | TEXT | 6 位代码 |
| `date` | TEXT | `YYYY-MM-DD` |
| `wan` | REAL | 份额，单位**万份**；只接受有限正数 |
| `src` | TEXT | 来源：`sse` / `ts`，写入时按优先级裁决（旧库里可能残留 `szse`） |

主键 `(code, date)`：同一只基金同一天只有一行。索引 `idx_share_date(date)` 支撑按日读取。

### 3.3 `nav` — 单位净值

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `code` | TEXT | 6 位代码 |
| `date` | TEXT | 净值日期 |
| `nav` | REAL | 单位净值（元/份） |

主键 `(code, date)`。**净值可能早于/晚于份额日期**：取用时按当日精确匹配，不做插值。

### 3.4 `series` — 派生序列（看板数值）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `sub` | TEXT | 细分行业名（键与 `lib/taxonomy.mjs` 的 `SUB` 一致） |
| `date` | TEXT | 交易日 |
| `val` | REAL | 主口径值（亿份，4 位小数；债券大类已 ×100） |
| `scale` | REAL | 规模（亿元，估算）= Σ 份额 × 当日净值 |
| `flow` | REAL | 净流入（亿元，估算）= Σ Δ份额 × 当日净值 |

主键 `(sub, date)`。**这是看板唯一的数值来源**：前端不读 `share`，只读 `series`（经载荷转换）。

### 3.5 `dayinfo` — 当日来源就绪情况

| 列 | 说明 |
| --- | --- |
| `date` | 交易日（PK） |
| `has_sse` / `has_szse` / `has_ts` | 该日各来源是否已入库（0/1）；`has_szse` 仅为旧库兼容保留 |

用于判断「某天是不是真的没有数据」以及增量更新时跳过已完成的来源。

### 3.6 `reconcile` / `run` / `meta`

| 表 | 关键列 | 用途 |
| --- | --- | --- |
| `reconcile` | `date, sub, code, a, b, note` | 交叉校验明细（每次重建前清空，最多保留 5000 行） |
| `run` | `at, kind, ok, stats, err` | 运行记录，排查「哪次更新失败/跑了多久」 |
| `meta` | `k, v` | 零碎状态：`bf:tsDone`（回补断点）、`navDone`（净值断点）、`ts:calls:<date>`（当日调用数）、`updatedAt`、`fundsAt` 等 |

### 3.7 `market` / `market_type` — 全市场聚合

- `market(date, scope, shares, scale, etfs)`：`scope ∈ SH / SZ / ALL`。
  与 `series` 的区别：`series` 只统计分类体系里的 773 只沪市成分，
  `market` 统计名录里**全部场内 ETF（沪深，约 1953 只）**。
- `market_type(date, type, shares, scale, etfs)`：按基金类型（股票型 / 债券型 / 货币型 / 其他）聚合。

这两张表服务于**全市场总览**（`market.json`），**不改变** 773 只成分的看板数值；
且**不做债券 ×100 折算**（那是细分行业页的展示口径）。

---

## 4. 数据质量规则

规则实现在 `lib/validate.mjs`（只读，不修数）。默认阈值：

| 规则 | 阈值 | 级别 | 含义 |
| --- | --- | --- | --- |
| 单只份额环比 | > 1.5× 或 < 1/1.5 | warn | 疑似拆分/合并/数据错位 |
| 单只份额环比 | ≥ 3× | error | 规范要求 >5× 报错，这里默认更严（可传 `errorMult: 5` 放宽） |
| 数量级异常 | ≥ 100× | error | 单位换算错误 |
| 小类环比 | ±20%（债券 ±30%） | warn | 成分调整或数据源切换 |
| 覆盖度骤降 | 相比前一日标的数下降 > 10% | warn | 接口漏抓 |
| 单只份额上限 | 1e8 万份（= 1 万亿份） | error | 明显异常 |
| 零/负值 | 任何 ≤ 0 | error | 份额不可能是非正数 |
| 序列断裂 | 中间出现 `NULL` 后恢复 | warn/error | 由 `findGaps()` 检测，结构性无数据可放行 |

`npm test` 覆盖了上述规则的代表性用例（跳变、白名单、覆盖度骤降、断裂检测、口径与优先级），
任何一条规则被改坏都会让 CI 变红。

---

## 5. 交叉校验（沪市两口径）

数据源只剩两个，所以校验比较的是**同一天的两种口径**：交易所（`src=sse`，官方披露）
vs Tushare（`src=ts`，第三方加工，优先现抓、拿不到才用库里的行）。
深市没有交易所侧可比，因此不在逐只比对范围内 —— 它的质量靠 Tushare 自身与范围校验兜底。

`npm run reconcile` 做两件事：

1. **逐只比**：同一交易日，「交易所侧（`src=sse`）」vs「Tushare 侧」，
   按相对差分档：完全一致（< 1e-6）/ ≤ 0.1% / ≤ 1% / > 1%。
2. **小类层再比**：分别用两侧份额重算 86 个小类，但**只用两侧都有值的公共成分**（`covered`），
   避免把「覆盖率差异」误判成「数值分歧」；同时比较方向并指出谁偏离。

**退出码**：`0` 都在容差内 / `1` 存在 >1% 分歧 / `2` 无法校验（无交易日或 Tushare 不可用）。

> 旧库里若还留着 `src='szse'` 的历史行，校验侧仍会把它并入「交易所侧」参与比对 —— 这是兼容行为，
> 不影响新数据的判断（新流程不会产生 `szse` 行）。

产出 `data/quality.json`，关键字段：

| 字段 | 含义 |
| --- | --- |
| `summary.compared.both` | 两侧都有值的 code-day 对数（如 746 只 × 5 天 = 3730） |
| `summary.compared.identical / le0_1 / le1 / gt1` | 分档计数 |
| `summary.subs.checked / inconsistent` | 小类层可比项 / 不一致项 |
| `summary.tsSource` | Tushare 数据来源：`live` / `db` / `unavailable` |
| `summary.dateAxis` | 交易日轴口径（`tradingOnly`）与参与比对的日数 |
| `summary.worstCode / worstSub` | 最大分歧对象及说明 |
| `summary.ok` | 全部通过为 `true` |
| `days[]` | 逐日明细：`perSource`、`mismatch.byCode[]`、`seriesCheck[]` |

**出现分歧时的处理顺序**：先看 `onlyExchange`/`onlyTs`（覆盖率问题）→ 再看是否是精度差（小盘 ETF 常见）
→ 再看是否有半天口径差（Tushare 修正过历史）→ 最后怀疑没更新（对照 `run` 表与 `.run/update.log`）。
**原则：不改数。** 手改 `series` 会让「数据可重建」这个前提失效。要么重跑更新让它自然收敛，要么记录在案。

---

## 6. 数据文件

| 文件 | 入库 | 说明 |
| --- | --- | --- |
| `data/etf.db` | ❌ gitignore | SQLite 本地缓存，可重建 |
| `data/series.json` | ✅ | 冷启动底座 + 回归基线（`{ dates: [...], subs: { 小类: [值…] } }`），当前 1212 个交易日 |
| `data/quality.json` | ✅ | 最近一次交叉校验结果（每日流水线刷新） |
| `data/validation-origin.json` | ✅ | `npm run verify:origin` 的对比结果 |
| `data/lastrun.json` | ❌ gitignore | 本机最近一次更新标记（服务据此判断是否过期） |
| `data/shares/<date>.json` | ❌ gitignore | v1 遗留的每日原始快照，主流程不再写入 |
| `site/data/*.json` | ❌ gitignore | 站点载荷，构建产物；其中 `market.json` 是全市场总览（沪深 + 按类型），与细分行业口径不同 |

`data/series.json` 必须保留 ≥ 1000 个交易日 —— 这是「新克隆也能直接出图」与「回归校验有基线」的双重前提，
`scripts/lint.mjs` 会强制检查。

---

## 7. 已知偏差与解释

> 这一节是「读数之前应该知道的事」。遇到和别的平台对不上，先来这里对一遍。

1. **原站有 2 个交易日的数据是冻结的**：`2026-08-25` 与 `2026-10-28`，原站所有小类数值与前一日完全相同
   （疑似抓取失败后沿用旧值）。本项目从交易所重抓，得到真实值，所以这两天的曲线会与原站不同 ——
   **这是我们更准，不是回归**。核对方式：`npm run verify:origin`。
2. **`501307` 是永久空成分**：Tushare 只有 18 个季末披露、交易所交易日无数据，对「港红利股息」贡献恒为 0。
   保留它不影响数值，属于分类体系的既定事实。
3. **净值覆盖率约 96%**：最近 250 个净值日里，773 只成分平均只有约 96% 有当日净值
   （口径不同会略有浮动）。缺净值的成分不计入「规模 / 净流入」，份额口径不受影响。
4. **`nav` 表里有少量非交易日行**：例如 `2026-03-08`（周日）只有 1 行净值。这是数据源侧的脏点，
   **不进入序列轴**（序列轴只取 `share` 出现过的日期），也不影响任何展示数值。
   重跑回补会再次写回，不建议手工清理。
5. **份额 ≠ 资金流**：份额是「份数」，不是金额。折算后的「净流入」是 `Δ份额 × 当日净值` 的近似值，
   不含折溢价与申赎清单效应。
6. **看板仍只覆盖沪市 773 只成分**：深市数据现在由 Tushare 提供，但只进入**全市场总览**（`market.json`），
   不进入小类/大类数值。要纳入深市需先扩 `lib/taxonomy.mjs` 的成分表（见 `DEVELOPING.md`）。
7. **两套口径别混用**：`market.json` 统计全部场内 ETF（约 1953 只，沪深），`subs`/`series` 只统计 773 只沪市成分；
   后者对债券大类做了 ×100 折算，前者没有。
8. **债券大类 ×100**：跨大类比规模时务必记得这是折算口径，不是真实份额。
9. **精度差异**：交易所给整数万份、Tushare 给 4 位小数。小量级 ETF 容易出现 ≤1% 的相对差，
   属于正常范围（`reconcile` 的 0.1%/1% 分档就是为此设计的）。
10. **旧库里的 `src='szse'` 行**：v3 之前抓的深交所快照，新流程不再写入。不影响任何展示数值，
    清理与否都可以（清理请用 `DELETE FROM share WHERE src='szse'`，重跑回补不会再产生）。

---

## 8. 自查命令（只读，可随时跑）

```bash
# 1) 库规模与时间范围（只读打开，不会写库）
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/etf.db", { readOnly: true });
const q = (s) => db.prepare(s).get();
console.log("名录", q("SELECT COUNT(*) c FROM fund").c,
            "有份额", q("SELECT COUNT(DISTINCT code) c FROM share").c,
            "交易日", q("SELECT COUNT(DISTINCT date) c FROM share").c,
            "序列行", q("SELECT COUNT(*) c FROM series").c);
console.log("序列区间", q("SELECT MIN(date) a FROM series").a, "~", q("SELECT MAX(date) b FROM series").b);
db.close();
'

# 2) 某一天各来源覆盖
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/etf.db", { readOnly: true });
const d = process.argv[1] || "2026-11-20";
console.log(d, db.prepare("SELECT src, COUNT(*) c FROM share WHERE date=? GROUP BY src").all(d));
db.close();
' -- 2026-11-20

# 3) 交叉校验 / 回归对比 / 单测
npm run reconcile          # 会联网（现抓 Tushare）并写 data/quality.json
npm run verify:origin      # 只读本地：与原站已发布序列逐点对比
npm test                   # 只读本地：10 个数据校验用例
```

---

## 9. 想改口径 / 加数据源？

1. **先写测试**：口径在 `tests/cases/caliber.mjs`，规则在 `tests/cases/rules.mjs`；新增行为先补用例。
2. 口径只允许在 `lib/pipeline.mjs`（`recompute`）里改 —— 不要在 `payloads.mjs` 或前端做二次计算，
   否则「库里的值」和「页面上的值」会各说各话。
3. 加数据源要同时处理：来源优先级（`lib/db.mjs` 的 `putShares`）、`dayinfo` 标记、`reconcile` 的对侧口径。
4. 任何口径变更都会改变已发布数值，必须在 `CHANGELOG.md` 记录并说明影响范围。

## 本文的核对状态

- 公式、精度、阈值：对照 `lib/pipeline.mjs`、`lib/aggregate.mjs`、`lib/validate.mjs`、`lib/payloads.mjs` 源码核对。
- 表结构：只读打开 `data/etf.db` 的 `sqlite_master` + `PRAGMA table_info` 实测（2026-11-21），
  确认 `series.scale/flow`、`market`、`market_type` 均已存在。
- 数据源为**两个**（上交所 + Tushare，深交所不再直连）：依据维护者 2026-11-21 的变更说明与
  `lib/payloads.mjs` 中 `meta.sources = ["上交所", "Tushare"]`。
- 净值覆盖率 96%：对最近 250 个净值日按 773 只成分逐日统计得出（均值 96.15%）。
- 非交易日脏点：实测 `nav` 表有 5 个日期不出现在 `share` 表中，`2026-03-08` 仅 1 行。
- 数据规模（交易日 1212 / 86 小类 / 773 只）与 `data/series.json` 实测一致；
  全市场“约 1953 只”来自维护者说明与 `fund` 名录（名称含 ETF）的规模量级，**未逐只核对**。
- **未复跑**：`npm run reconcile`、`npm run verify:origin`（会改写 `data/`，协同时避免互相踩踏）；
  文中关于其输出的描述来自源码与仓库既有的 `data/quality.json`。`npm test` 的用例数来自 `tests/runner.mjs` 的导入清单。
