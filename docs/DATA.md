# 数据说明 · 口径、字段与质量

本文是数据侧的「口径 + 质量 + 文件」说明书。
逐列字段字典见 [`DICTIONARY.md`](DICTIONARY.md)，HTTP/JSON 契约见 [`API.md`](API.md)，
架构与模块职责见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，分类方法见 [`CLASSIFICATION.md`](CLASSIFICATION.md)。

一句话：**看板展示的是「份额（亿份）」，不是金额**；「规模 / 净流入」是按净值折算的估算值。
两者都有明确的单位与误差来源，请勿混用。

---

## 1. 口径

### 1.1 细分行业份额（主口径）

```
细分行业值(亿份) = Σ 该小类成分 ETF 当日份额(万份) ÷ 1e4
债券小类        = 上面的值 × 100
                  # legacy 大类「9_债券」与 v2 大类「bond」都适用
                  # 债券 ETF 面值 100 元/份，跟随原看板折算口径
```

- 单位：**亿份**（交易所给「万份」，÷1e4 得亿份）。
- 库内精度 **4 位小数**（`series.val` / `series_v2.val`），展示取 1 位。
- 没有成分数据的日子写 `NULL`，**不写 0**：0 会伪造「份额归零」的断崖。
- 若某小类当天一个成分都没数据 → `NULL`（不是 0）。

### 1.2 为什么债券要 ×100

债券 ETF 面值 100 元/份，股票 ETF 通常 1 元/份。同样「1 亿份」，债券对应的资金量是 100 倍。
不折算的话债券小类的「亿份」和其他小类不在一个量级，跨大类的规模对比与排行会失真。
×100 后各列数量级对齐 —— 这是原看板的口径，本项目保持一致。

判断口径统一走 `isBondCat()`：**legacy 认 `9_债券`，v2 认 `bond`**（v3.4.0 修复，此前 v2 漏乘）。

> 注意：×100 **只作用于份额口径**。金额口径（`scale` / `flow`）本身已按净值折算，不再乘；
> 全市场总览（`market`）用自然口径，也不乘。

### 1.3 规模与净申购（估算）

```
规模(亿元)    = Σ 成分 ETF [ 份额(万份) ÷ 1e4 × 当日单位净值(元/份) ]

净申购(亿元/日) = Σ 成分 ETF [ (adjWan(份额_t) − adjWan(份额_{t−1})) ÷ 1e4 × 当日单位净值 ]
```

其中 `adjWan` 与「是否计入」有两处修正：

1. **剔除份额拆分 / 合并**：`event` 表（当前 254 起：`split` 166 / `merge` 88）记录折算事件，
   计算前把事件之前的历史份额按比例换算到**当前份额单位**，再相减 —— 否则 1:2 折算会被算成几十亿的假申购。
   份额水位本身（`series.val` / 载荷里的 `shares`）仍按原始披露值展示，不做换算。
2. **剔除上市首日**：`fund.list_date == 当日` 的成分不参与当日 `flow` —— 新发基金会一次性进几亿份，
   那是一级募集，不是日常申赎。

其它约定：

- 净值来自 Tushare `fund_nav`；**缺净值**的成分不计入 `scale` / `flow`（份额口径不受影响），
  前端抽屉里用 `navCoverage` 标注命中数/总数。
- 「净申购」是**估算**：ETF 二级买卖不改变份额，只有一级申赎才改；真实金额还受折溢价、
  申赎清单与现金差额影响。它回答的是「这段时间钱大概往哪边挪」，不是精确申赎额。
- `flow` 仅在「当日与上一交易日都有份额、且当日有净值」时有值，否则为 `null`。

### 1.4 全市场口径（`market` / `market_type`）

```
market.shares   = Σ 全部场内 ETF 份额(万份) ÷ 1e4        # 亿份，自然口径（不 ×100）
market.scale    = Σ 全部场内 ETF [份额 ÷ 1e4 × 当日净值]  # 亿元
market_type.*   = 同上，按 fund.type 分组
```

- 范围是**名录里全部场内 ETF（沪深）**，不是分类体系里的成分；交易所快照里混着的 REITs / LOF /
  普通指数基金会按名称含 `ETF` 过滤掉。
- `scope ∈ SH / SZ / ALL`；三个 scope 每天各一行。
- 与细分行业口径**不可相加或互比**：一个是全市场，一个是精选成分。
- 缺净值的成分只计份额、不计规模（因此 `scale` 可能略低于真实市值）。

### 1.5 两套分类口径（互不覆盖）

| 口径 | 大类 | 小类 | 成分 ETF | 序列表 | 目录/前缀 | 定位 |
| --- | --- | --- | --- | --- | --- | --- |
| **v2**（默认） | 7 | 72 | 1903 | `series_v2` | `site/data/` · `/api/*` | 指数类别 + 申万一级/主题骨架，覆盖沪深 |
| **legacy** | 10 | 88 | 1614 | `series` | `site/data/legacy/` · `/api/legacy/*` | 原看板 86 小类（773 只沪市）+ 深市归属 |

- legacy 的 1614 = 原看板 773 只 + 深市 841 只（391 只按「同跟踪指数」、450 只按关键词规则、2 个新增小类）。
- 两套分类的 `sub` 命名与语义不同，**分别写入两张表、两个目录**，切换口径不会串数据。
- 构建时默认用 v2；`series_v2` 覆盖不足 1000 个交易日时自动回落 legacy（见 `lib/build/site.mjs`）。

---

## 2. 数据源能力矩阵

本项目只有**两个**数据源。深交所官方接口只有「当前规模」快照、无法回溯，已弃用，
深市份额与净值统一由 Tushare 提供。

| 来源 | 接口 | 字段 | 单位 | 可回溯 | 在本项目中的角色 |
| --- | --- | --- | --- | --- | --- |
| 上交所 | `query.sse.com.cn/commonQuery.do`，`sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L`，`STAT_DATE=YYYY-MM-DD` | `TOT_VOL` | 万份（整数） | ✅ 任意历史交易日 | 沪市主数据源（官方口径）；日常近 15 日增量 + 全量回补 |
| Tushare Pro | `fund_share`（按 `ts_code` 或 `trade_date`） | `fd_share` | 万份，4 位小数 | ✅ 一般 5 年以上（受积分限制） | **深市唯一来源**；沪市补缺与第二参照 |
| Tushare Pro | `fund_nav`（按 `ts_code` 或 `trade_date`） | `unit_nav` | 元/份 | ✅ | 金额口径（`scale` / `flow`） |
| Tushare Pro | `fund_daily`（按 `trade_date`，全市场） | `close / pct_chg / vol / amount` | 元 / % / 手 / 千元 | ✅ | 折溢价、成交额、换手率（`quote` 表） |
| Tushare Pro | `fund_basic`（`market="E"`） | 名称/类型/上市日 | — | — | 刷新 `fund` 名录（每周一次） |

抓取纪律（`lib/tushare.mjs`）：

| 参数 | 默认 | 环境变量 | 作用 |
| --- | --- | --- | --- |
| 每分钟调用上限 | 120 | `TUSHARE_RPM` | 全局令牌桶，跨并发共享 |
| 单次运行预算 | 800 | `TUSHARE_MAX_CALLS_PER_RUN` | 超出即停并报错，重跑可断点续抓 |
| 每日预算 | 4000 | `TUSHARE_DAILY_BUDGET` | 计数持久化在 `meta.ts:calls:<date>` |
| 重试 | 4 次 | — | 频率类错误指数退避 + 抖动 |

交易所侧：并发 ≤ 6、请求带浏览器 UA 与 Referer、单次增量只回溯最近 15 天。
**请勿改成高频轮询** —— 这是对公共接口的基本礼貌，也是本项目能长期免费运行的前提。

> 每日增量现在会顺带维护 `quote`（行情，按当日）+ `event`（折算事件，全量重算），
> 见 `scripts/update.mjs` 第 2.6 步；行情的历史回补仍可用 `node scripts/backfill-quotes.mjs`。

---

## 3. 存储与字段

库：`data/etf.db`（SQLite / WAL / `node:sqlite`，不进 git，可由接口重建）。

| 表 | 一句话 | 关键列 | 详见 |
| --- | --- | --- | --- |
| `fund` | 场内基金名录 | `code, name, type, market, list_date` | [`DICTIONARY.md` §2](DICTIONARY.md) |
| `share` | 每只每日份额（事实层） | `code, date, wan, src` | §3 |
| `nav` | 单位净值 | `code, date, nav` | §4 |
| `quote` | 行情（收盘/涨跌/量/额） | `code, date, close, pct_chg, vol, amount` | §5 |
| `series` | legacy 口径派生序列 | `sub, date, val, scale, flow` | §6 |
| `series_v2` | v2 口径派生序列 | `sub, date, val, scale, flow` | §7 |
| `market` | 全市场聚合（SH/SZ/ALL） | `date, scope, shares, scale, etfs` | §8 |
| `market_type` | 按基金类型聚合 | `date, type, shares, scale, etfs` | §9 |
| `event` | 份额拆分/合并事件 | `code, date, kind, ratio` | §10 |
| `reconcile` | 交叉校验明细（每次清空重写） | `date, sub, code, a, b, note` | §11 |
| `run` | 运行台账 | `at, kind, ok, stats, err` | §12 |
| `dayinfo` | 当日来源覆盖标记 | `date, has_sse, has_szse, has_ts` | §13 |
| `meta` | 键值状态 | `k, v`（JSON 字符串） | §14 |

两条容易踩的细节：

- **交易日轴由 `dayinfo.has_sse=1` 决定**（`tradingDates()`），不是 `share` 里出现过的所有日期：
  Tushare 会在季末/非交易日披露份额，那些日期不进入看板序列（`share` 有 1288 个日期，序列轴 1212 天）。
- **来源优先级**：`sse`（=1）> `ts`（=2）；同 `(code,date)` 只保留一行，低优先级不覆盖高优先级。
  `szse` 仅旧库历史残留，新流程不再写入。

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

`npm test` 覆盖了代表性用例（口径、DB 优先级、跳变、白名单、覆盖度骤降、断裂检测、交叉校验分档），
任何一条被改坏都会让 CI 变红。

---

## 5. 交叉校验（沪市两口径）

数据源只有两个，校验比较的是**同一天的两种口径**：交易所（`src=sse`，官方披露）
vs Tushare（`src=ts`；优先现抓，拿不到才用库里的行）。深市没有交易所侧可比，不在逐只比对范围内。

`npm run reconcile` 做两件事：

1. **逐只比**：同一交易日逐 code 对比，按相对差分档：完全一致（< 1e-6）/ ≤ 0.1% / ≤ 1% / > 1%。
2. **小类层再比**：分别用两侧份额重算小类，但**只用两侧都有值的公共成分**（`covered`），
   避免把「覆盖率差异」误判成「数值分歧」；同时比较方向并指出谁偏离。

**退出码**：`0` 都在容差内 / `1` 存在 >1% 分歧 / `2` 无法校验（无交易日或 Tushare 不可用）。

> 旧库若残留 `src='szse'` 行，校验侧会把它并入「交易所侧」参与比对 —— 兼容行为，不影响新数据判断。

产出 `data/quality.json`（同时被适配进 `site/data/quality.json` 供前端展示），关键字段：

| 字段 | 含义 |
| --- | --- |
| `summary.compared.both` | 两侧都有值的 code-day 对数（如 746 只 × 5 天 = 3730） |
| `summary.compared.identical / le0_1 / le1 / gt1` | 分档计数 |
| `summary.subs.checked / inconsistent / singleSource` | 小类层可比项 / 不一致项 / 单侧有数据项 |
| `summary.tsSource` | Tushare 数据来源：`live` / `db` / `unavailable` |
| `summary.dateAxis` | 交易日轴口径（`tradingOnly`）与参与比对的日数 |
| `summary.worstCode / worstSub` | 最大分歧对象及说明 |
| `summary.ok` | 全部通过为 `true` |
| `days[]` | 逐日明细：`perSource`、`mismatch.byCode[]`、`seriesCheck[]` |

**出现分歧时的处理顺序**：先看 `onlyExchange`/`onlyTs`（覆盖率问题）→ 再看是否精度差（小盘 ETF 常见）
→ 再看是否有半天口径差（Tushare 修正过历史）→ 最后怀疑没更新（对照 `run` 表与 `.run/update.log`）。
**原则：不改数。** 手改 `series` 会让「数据可重建」的前提失效。

---

## 6. 数据文件与构建产物

### 6.1 源文件（`data/`）

| 文件 | 入库 | 说明 |
| --- | --- | --- |
| `data/etf.db` | ❌ gitignore | SQLite 本地缓存，可重建；CI 用 cache 或 Release 种子（`scripts/publish-db-seed.sh`） |
| `data/series.json` | ✅ | legacy 口径序列导出：冷启动底座 + 回归基线，≥ 1000 个交易日（`scripts/lint.mjs` 强制检查） |
| `data/quality.json` | ✅ | 最近一次交叉校验结果（每日流水线刷新） |
| `data/validation-origin.json` | ✅ | `npm run verify:origin` 与原站的对比结果 |
| `data/universe.json` / `universe-report.json` | ✅ | legacy 宇宙：深市归属（指数指纹/关键词/新增小类）与生成报告 |
| `data/classification-v2.json` / `classification-v2-report.json` | ✅ | v2 分类（7 大类 / 72 小类 / 1903 只）与生成报告 |
| `data/tags-v2.json` | ✅ | 多维标签（指数类别/申万/中证/主题/地区/因子/债券/商品），供成分明细展示 |
| `data/lastrun.json` | ❌ gitignore | 本机最近一次更新标记（服务据此判断是否过期） |
| `data/shares/<date>.json` | ❌ gitignore | v1 遗留每日快照，主流程不再写入 |

### 6.2 产物（`site/data/`，构建生成、不入库）

```
meta.json  tables.json  subs.json  index.json  market.json  quality.json
signature.json  lastrun.json  charts-<catKey>.json
archive/<YYYY-MM-DD>.json          # 最近 120 个交易日的轻量快照
legacy/                            # 同构的 legacy 口径子树（含自己的 archive/）
```

- `charts-<catKey>.json` 的 key 随口径变化：v2 为 `broad/industry/…`，legacy 为 `1_宽基市场/9_债券`。
- `legacy/` 是**完整的一套**（meta/tables/subs/index/market/quality/signature/lastrun/charts/archive），
  供页面切换口径与 `/api/legacy/*` 使用。
- 字段级说明见 [`API.md`](API.md) §2–§4。

---

## 7. 已知偏差与解释

> 读数之前应该知道的事。和别的平台对不上时，先来这里对一遍。

1. **原站有 2 个交易日的数据是冻结的**：`2026-08-25` 与 `2026-10-28`，原站所有小类数值与前一日完全相同
   （疑似抓取失败后沿用旧值）。本项目从交易所重抓，得到真实值，所以这两天的曲线会与原站不同 ——
   **这是我们更准，不是回归**。核对方式：`npm run verify:origin`。
2. **`501307` 是永久空成分**：Tushare 只有 18 个季末披露、交易所交易日无数据，对「港红利股息」贡献恒为 0。
   保留它不影响数值，属于分类体系的既定事实。
3. **净值覆盖率视口径而定**（最近 120 个净值日均值）：原看板 773 只沪市成分约 **98%**；
   legacy 1614 只约 **91%**；v2 1903 只约 **85%**（深市与新发基金的历史净值回补尚未覆盖全）。
   缺净值的成分不计入 `scale` / `flow`，份额口径不受影响。
4. **`nav` 表里有少量非交易日行**：例如 `2026-03-08`（周日）只有 1 行净值。这是数据源侧的脏点，
   **不进入序列轴**（序列轴只取 `dayinfo.has_sse=1` 的日期），也不影响展示数值。重跑回补会再次写回，不建议手工清理。
5. **份额 ≠ 资金流**：份额是「份数」。`flow` 已按 §1.3 做折算/上市首日修正，但仍是估算，
   不含折溢价与申赎清单效应。
6. **两套口径别混用**：`market.json` 统计全部场内 ETF（自然口径），`subs`/`charts` 统计当前分类的成分
   （份额口径，债券 ×100）。两者的数字不能相加。
7. **债券 ×100**：跨大类比规模时记得这是折算口径，不是真实份额；`scale` / `flow` / `market` 不受影响。
8. **精度差异**：交易所给整数万份、Tushare 给 4 位小数。小量级 ETF 容易出现 ≤1% 的相对差，
   属正常范围（`reconcile` 的 0.1%/1% 分档就是为此设计的）。
9. **旧库里的 `src='szse'` 行**：v3 之前抓的深交所快照，新流程不再写入。不影响展示数值；
   如需清理：`DELETE FROM share WHERE src='szse'; UPDATE dayinfo SET has_szse=0;`。
10. **行情（`quote`）历史仍在回补**：每日增量只补「当日」，更早的日期靠
    `node scripts/backfill-quotes.mjs`。未回补日期的 `price/premium/pctChg/amount/turnover` 为 `null`，
    其余口径不受影响。
11. **深市已参与看板**：legacy（88 小类 / 1614 只）与 v2（72 小类 / 1903 只）都包含深市成分；
    只有原看板基线 773 只仍全部是沪市代码（用于 `verify:origin` 回归校验）。

---

## 8. 自查命令（只读，可随时跑）

```bash
# 1) 库规模、口径与时间范围
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/etf.db", { readOnly: true });
const q = (s) => db.prepare(s).get();
console.log("名录", q("SELECT COUNT(*) c FROM fund").c,
            "有份额", q("SELECT COUNT(DISTINCT code) c FROM share").c,
            "份额日期", q("SELECT COUNT(DISTINCT date) c FROM share").c,
            "序列轴", q("SELECT COUNT(DISTINCT date) c FROM series_v2").c);
console.log("legacy 小类", q("SELECT COUNT(DISTINCT sub) s FROM series").s,
            "v2 小类", q("SELECT COUNT(DISTINCT sub) s FROM series_v2").s);
console.log("行情日期", q("SELECT COUNT(DISTINCT date) c FROM quote").c,
            "折算事件", q("SELECT COUNT(*) c FROM event").c);
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

# 3) 校验 / 回归 / 单测
npm run reconcile          # 联网（现抓 Tushare）并写 data/quality.json
npm run verify:origin      # 只读本地：与原站已发布序列逐点对比
npm test                   # 只读本地：10 个数据校验用例
```

---

## 9. 想改口径 / 加数据源？

1. **先写测试**：口径在 `tests/cases/caliber.mjs`，规则在 `tests/cases/rules.mjs`；新增行为先补用例。
2. 口径只允许在 `lib/pipeline.mjs`（`recomputeAll`）里改 —— 不要在 `payloads.mjs` 或前端做二次计算，
   否则「库里的值」和「页面上的值」会各说各话。
3. 改分类：v2 走 `scripts/classify.mjs` + `scripts/tag-v2.mjs` 生成 `data/classification-v2.json` / `tags-v2.json`；
   legacy 走 `data/universe.json`（`lib/universe.mjs` 合并）。两套都要过 `npm test` 与 `verify:origin`。
4. 加数据源要同时处理：来源优先级（`putShares`）、`dayinfo` 标记、`reconcile` 的对侧口径、`validate` 规则。
5. 任何口径变更都会改变已发布数值，必须在 `CHANGELOG.md` 记录并说明影响范围。

---

## 本文的核对状态

- 公式（份额/规模/净申购、事件折算、上市首日剔除）：对照 `lib/pipeline.mjs::recomputeAll`、
  `detectShareEvents`、`lib/payloads.mjs` 源码核对（含 v3.4.0 的 `isBondCat` 修复）。
- 表结构：以 `docs/DICTIONARY.md` 为准（该文由 `PRAGMA table_info` 实测生成），本文只列摘要。
- 两套口径规模（7/72/1903、10/88/1614）：`node -e` 读 `lib/universe.mjs` 的 `loadUniverse()` 实测。
- 净值覆盖率（98% / 91% / 85%）：对最近 120 个净值日按各口径代码集合逐日统计的均值。
- 事件数（254 = split 166 + merge 88）、行情覆盖（当前约 297 个交易日）：只读查库实测。
- **未复跑**：`npm run reconcile`、`npm run verify:origin`、`npm run update`（会联网并改写 `data/`）；
  相关描述来自源码与仓库既有 `data/quality.json`、`run` 表记录。
