# API 与载荷契约 · ebbflow

本文档说明**本地服务端点**与**静态数据文件**的完整字段契约。
数据字典（SQLite 侧：表、列、来源、更新频率）见 [`DICTIONARY.md`](DICTIONARY.md)；
分类体系见 [`CLASSIFICATION.md`](CLASSIFICATION.md)；整体架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

- 服务：`npm start` → `http://127.0.0.1:5188`（只绑 `127.0.0.1`，无鉴权）。
- 前端取数：**静态优先**（`data/*.json`）→ 失败才回退 `/api/*`。因此同一份 `site/` 既能静态托管，
  也能在本地服务下拿到「刚更新过」的数据。
- 契约版本：**v3**（项目版本见 `site/data/signature.json` 与 `lib/signature.mjs`）。

---

## 1. 阅读前提：单位、精度、空值

| 约定 | 说明 |
| --- | --- |
| 日期 | 一律 `YYYY-MM-DD` 字符串；时间戳为 ISO 8601（UTC，带 `Z`） |
| `null` 的含义 | **当日无数据**，绝不是 0。0 会被用来表达「确实为 0」，两者不可混用 |
| 百分比字段 | 存的是**百分数数值**：`1.23` 表示 `+1.23%`，不是 `0.0123` |
| 比例字段 | 仅 `quality.summary.rates` 是 0–1 的比例（如 `1` = 100%） |
| 精度 | 载荷里图表/表格指标统一 **1 位小数**；百分比 2 位；折溢价/换手率 2 位；`series` 库内 4 位 |
| `shares` | **亿份**（成分 ETF 份额之和 ÷ 1e4）；**债券大类 ×100**（面值 100 元/份，见 §1.1） |
| `scale` | **亿元**：`Σ 成分份额(万份)/1e4 × 当日单位净值` |
| `flow` | **亿元/日**：份额净申购估算，见 §1.2 |
| `nav` / `price` | 元/份（净值）、元（收盘价） |
| `amount` | 亿元（服务端已由 Tushare 的「千元」换算） |
| `etfs` | 只数（整数） |

### 1.1 债券 ×100

债券 ETF 面值 100 元/份，股票 ETF 通常 1 元/份。为了让「亿份」在跨大类时可比较，
**份额口径**对债券大类乘 100（跟随原看板口径）。金额口径（`scale` / `flow`）已经按净值折算，不再乘。

- 适用字段：`charts-*.json` 的 `series[].shares`、`tables.*.{now,start,delta,first,last}`、
  `subs[].values/current`、`subs[].etfs[].shares/delta`。
- 不适用：`market.json`（全市场自然口径，不折算）、所有 `scale` / `flow`。
- ✅ **已修复（v3.8.0）**：此前 v2 口径的债券小类级数值漏乘 100（`recomputeAll()` 只认 `9_债券`），
  导致小类值只有成分明细合计的 1/100。现在统一走 `isBondCat()`（legacy `9_债券` / v2 `bond`），
  两套口径一致：`subs["科创债"].current` 与其 `etfs[].shares` 合计比值实测为 1.00。

### 1.2 `flow` 是「份额净申购（估算）」

```
flow(亿元/日) = Σ_成分 [ (adjWan(份额_t) − adjWan(份额_{t−1})) / 1e4 × 当日单位净值 ]
```

- **它衡量一级市场申赎**：ETF 二级买卖不改变份额，只有申购/赎回才改。所以 `flow` ≈ 净申购金额，
  不是「资金流入流出」的全部（二级买盘不会出现在这里）。
- `adjWan`：按 `event` 表（份额拆分/合并，当前 254 起）把历史份额换算到**当前份额单位**后再做差，
  剔除拆分/合并造成的假跳变；份额水位本身仍按原始披露值展示。
- 另剔除**上市首日**（`fund.list_date == 当日`）：新发基金会一次性进几亿份，那不是申赎。
- 缺当日净值的成分不计入 `flow`（`navCoverage.hit/total` 会给出覆盖情况）。
- `flow` 仅在「当日与上一交易日都有份额、且当日有净值」时有值，否则该小类当日为 `null`。

### 1.3 两套分类口径（互不覆盖）

| 口径 | 大类 | 小类 | 序列表 | 目录 | 说明 |
| --- | --- | --- | --- | --- | --- |
| **v2**（默认） | 7 | 72 | `series_v2` | `site/data/` | 指数类别 + 申万一级/主题，覆盖沪深 |
| **legacy**（兼容） | 10 | 88 | `series` | `site/data/legacy/` | 原看板 86 小类 + 深市归属，见 `CLASSIFICATION.md` |

`meta.taxonomy` 告诉你是哪一套。构建时的判定：`series_v2` 覆盖 ≥ 1000 个交易日才用 v2，否则回落 legacy
（`lib/build/site.mjs`）。两套数据在**不同目录、不同端点前缀**下，切换口径不会串数据。

---

## 2. 静态数据目录 `site/data/`

```
site/data/
├── meta.json                 站点元信息（最新交易日、区间、口径、计数、告警）
├── tables.json               首页三张表 + 全量排行
├── subs.json                 小类明细（成分 ETF + 份额序列），约 2MB，前端懒加载
├── index.json                搜索索引（小类 + ETF，含拼音首字母）
├── market.json               全市场总览（沪深 + 按基金类型），缺数据时可能不存在
├── quality.json              交叉校验摘要（+ 完整明细 detail）
├── signature.json            项目身份（project/version/author/repo/fingerprint/origin）
├── lastrun.json              本次构建时间与最新交易日（构站时写入）
├── charts-<catKey>.json      每个大类一份（v2: broad/industry/theme/...；legacy: 1_宽基市场/...）
├── archive/<YYYY-MM-DD>.json 每日轻量快照（只保留最近 120 个交易日）
└── legacy/                   同一套结构，legacy 口径
    ├── meta.json … lastrun.json
    ├── charts-<catKey>.json  （key 形如 1_宽基市场、9_债券）
    └── archive/<YYYY-MM-DD>.json
```

- `charts-<catKey>.json` 的文件名随口径变化；构建时会清掉上一版遗留的 `charts-*.json`。
- `archive/` 是**只增不减的日快照**（保留最近 120 个），记录当天的口径、计数、大类表与全市场总量。
- `market.json` 只有在 `market` 表覆盖足够（≥1000 天且深市有数据）时才生成；缺失时 `/api/market` 返回 404，
  `meta.warnings` 会多一条说明。

---

## 3. 端点总表

| 方法 | 路径 | 返回 | 口径/备注 |
| --- | --- | --- | --- |
| GET | `/api/meta` | `meta.json` | 当前口径 |
| GET | `/api/tables` | `tables.json` | 当前口径 |
| GET | `/api/charts/:catKey` | `charts-<catKey>.json` | `catKey` 须 `encodeURIComponent`（legacy 含中文） |
| GET | `/api/subs` | `subs.json` | 当前口径，约 2MB |
| GET | `/api/sub/:name` | `{name, ...subs[name]}` | 单小类；`name` 须编码；legacy 下请直接用 `subs.json` |
| GET | `/api/index` | `index.json` | 当前口径 |
| GET | `/api/market` | `market.json` | 全市场；未就绪返回 404 |
| GET | `/api/quality` | `quality.json` | 与口径无关（校验针对沪市两口径） |
| GET | `/api/status` | 动态对象 | 服务状态（内存，不读文件） |
| GET/POST | `/api/refresh` | 动态对象 | 触发一次增量更新（副作用！见 §4.10） |
| GET | `/api/legacy/<name>` | `legacy/<name>.json` | legacy 口径的 `meta`/`tables`/`subs`/`index`/`market`/`quality`/`signature`/`lastrun`/`archive/<date>` |
| GET | `/api/legacy/charts/:catKey` | `legacy/charts-<catKey>.json` | legacy 图表 |
| GET | `/data/*`、`/` | `site/` 下的静态文件 | 包含 `data/archive/*`（无 `/api/archive`） |

**通用响应头**（所有响应都带）：

| 头 | 值 |
| --- | --- |
| `X-Powered-By` | `ebbflow/<version>` |
| `X-Project-Author` | `dreemetoo` |
| `X-Project-Signature` | 16 位指纹（如 `01965be232d20323`） |
| `Access-Control-Allow-Origin` | `*` |
| `Cache-Control` | API 与 JSON 文件 `no-store`；其它静态资源 `public, max-age=60` |
| `Content-Type` | `application/json; charset=utf-8`（或对应静态类型） |

> 实现上，数据端点的 handler **不校验请求方法**（`POST /api/meta` 也会返回数据）。
> 请按上表使用；`/api/refresh` 有副作用，尤其不要用 GET 去「探测」。

---

## 4. 逐端点字段说明

### 4.1 `GET /api/meta`

站点元信息。示例（v2 口径，2026-11-20）：

```json
{
  "title": "ETF 细分行业资金流向",
  "lastTradeDate": "2026-11-20",
  "range": { "from": "2021-11-22", "to": "2026-11-20", "days": 1212 },
  "recent": { "from": "2026-11-13", "to": "2026-11-20", "days": 6 },
  "taxonomy": "v2",
  "counts": { "subs": 72, "cats": 7, "etfs": 1903 },
  "markets": { "sh": { "etfs": 1090, "covered": 951 }, "sz": { "etfs": 863, "covered": 779 } },
  "warnings": []
}
```

| 字段 | 类型 | 单位 | 可空 | 说明 |
| --- | --- | --- | --- | --- |
| `title` | string | — | 否 | 站点标题 |
| `lastTradeDate` | string | 日期 | 是 | 最新交易日；库空时为 `null` |
| `range.from` / `range.to` | string | 日期 | 是 | 序列首/末交易日 |
| `range.days` | number | 天 | 否 | `range` 内交易日数（= 交易日轴长度） |
| `recent.from` / `recent.to` / `recent.days` | string/number | 日期/天 | 是 | 最近窗口（当前实现为最近 7 个自然日内的交易日） |
| `updatedAt` | string | ISO | 是 | 最近一次更新完成时间（`meta.updatedAt`） |
| `author` / `repo` / `license` | string | — | 否 | 来自 `lib/signature.mjs` |
| `signature` | string | — | 否 | 16 位项目指纹（稳定，不随构建变化） |
| `origin` | object | — | 否 | 溯源：`{title, author, platform, bilibili, github, note}` |
| `sources` | string[] | — | 否 | 固定 `["上交所","Tushare"]` |
| `taxonomy` | `"v2"` \| `"legacy"` | — | 否 | 当前载荷的分类口径 |
| `tagDims` | object | — | 否 | 标签维度中文名：`{index, sw, csi, theme, region, factor, bond, commodity}` |
| `categories` | array | — | 否 | `[{key, label, color, subs}]`，`subs` 为该大类小类数 |
| `metrics` | string[] | — | 否 | 固定 `["shares","scale","flow"]` |
| `metricUnits` | object | — | 否 | `{shares:"亿份", scale:"亿元", flow:"亿元"}` |
| `counts.subs` / `counts.cats` | number | 个 | 否 | 当前口径的小类/大类数 |
| `counts.etfs` | number | 只 | 否 | 当前口径涉及的**去重 ETF 代码数** |
| `markets.sh` / `markets.sz` | object | — | 否 | `{etfs: 名录内 ETF 数, covered: 最新交易日有份额的只数}` |
| `warnings` | string[] | — | 否 | 本次构建的告警（如「全市场聚合数据尚未补全」） |

### 4.2 `GET /api/tables`

首页表格与排行。示例：

```json
{
  "window": { "from": "2026-11-13", "to": "2026-11-20", "days": 6 },
  "cats": [{ "key": "industry", "label": "industry", "now": 9249.4, "start": 9398.2, "pct": -1.58, "scale": 6201.7, "flow": -153.5 }],
  "all": [{ "sub": "沪深300", "cat": "broad", "delta": 251.2, "pct": 19.37, "first": 1296.7, "last": 1547.9, "scale": 5559.8, "scaleDelta": 952.9, "flow": 1016.9 }],
  "top": [], "bottom": []
}
```

| 字段 | 类型 | 单位 | 可空 | 说明 |
| --- | --- | --- | --- | --- |
| `window.from` / `to` / `days` | string/number | 日期/天 | 否 | 统计窗口（最近 7 个自然日内的交易日） |
| `cats[]` | array | — | 否 | 大类汇总，按 `now` 降序；`label` 是**大类 key**（legacy 形如 `9.债券`，v2 为英文 key），中文名请用 `meta.categories` 映射 |
| `cats[].now` / `start` | number | 亿份 | 是 | 窗口末日 / 窗口首个有效日的份额合计 |
| `cats[].pct` | number | % | 是 | `(now−start)/start×100` |
| `cats[].scale` | number | 亿元 | 是 | 窗口末日规模（成分净值合计） |
| `cats[].flow` | number | 亿元 | 是 | 窗口内逐日 `flow` 求和 |
| `all[]` | array | — | 否 | 全部小类，按 `delta` 降序 |
| `all[].sub` / `cat` | string | — | 否 | 小类名 / 所属大类 key |
| `all[].delta` | number | 亿份 | 否 | `last − first`（债券类已 ×100） |
| `all[].pct` | number | % | 是 | 变化率 |
| `all[].first` / `last` | number | 亿份 | 否 | 窗口首个有效值 / 末日值 |
| `all[].scale` | number | 亿元 | 是 | 末日规模 |
| `all[].scaleDelta` | number | 亿元 | 是 | 末日规模 − 首日规模 |
| `all[].flow` | number | 亿元 | 是 | 窗口内 `flow` 求和；整窗无值则 `null` |
| `top` / `bottom` | array | — | 否 | `all` 的前 5 / 后 5（`bottom` 已反转，最差在前） |

> 份额类字段（`now/start/first/last/delta`）在债券小类已 ×100 —— legacy（`9_债券`）与 v2（`bond`）都适用（v3.8.0 起一致）。

### 4.3 `GET /api/charts/:catKey`

每个大类一份三指标并列的序列。示例：

```json
{
  "cat": "broad", "label": "宽基", "color": "#D16F3F",
  "dates": ["2021-11-22", "..."],
  "series": [{ "name": "大盘宽基", "color": "#1C2392",
               "shares": [419.8, "..."], "scale": [900.1, "..."], "flow": [1.2, "..."]] }]
}
```

| 字段 | 类型 | 单位 | 可空 | 说明 |
| --- | --- | --- | --- | --- |
| `cat` | string | — | 否 | 大类 key（与文件名/URL 一致） |
| `label` / `color` | string | — | 否 | 大类中文名 / 主色 |
| `dates` | string[] | 日期 | 否 | 交易日轴；所有 `series[].*` 数组与它**等长、逐位对齐** |
| `series[]` | array | — | 否 | 该大类下**有份额数据**的小类 |
| `series[].name` / `color` | string | — | 否 | 小类名 / 线色 |
| `series[].shares` | (number\|null)[] | 亿份 | 是 | 份额（债券类已 ×100），1 位小数 |
| `series[].scale` | (number\|null)[] | 亿元 | 是 | 规模 |
| `series[].flow` | (number\|null)[] | 亿元/日 | 是 | 当日份额净申购估算 |

> **v3 变更**：服务端不再输出 `c1/c2/c3` 三套归一序列，归一化（长期 100 基准、窗口 100 基准）在前端完成。
> 若你依赖旧字段，请改用 `shares`/`scale`/`flow` 自行归一。

### 4.4 `GET /api/subs`

全部小类明细（前端懒加载，约 2MB）。`subs` 是**以小类名为键的对象**：

```json
{
  "__dates": ["2021-11-22", "..."],
  "大盘宽基": {
    "cat": "broad", "color": "#1C2392",
    "values": [419.8, "..."],
    "current": 493.6,
    "scale": 1133.9, "flow": 227.11,
    "navCoverage": { "hit": 87, "total": 100 },
    "etfs": [{ "code": "510050", "name": "华夏上证50ETF", "tags": ["index:规模指数"],
               "market": "SH", "shares": 241.34, "delta": 79.35,
               "nav": 2.9, "price": 2.9, "premium": -0.14, "pctChg": 0.59,
               "amount": 243.38, "turnover": 34.72, "listDate": "2005-02-23",
               "scale": 700.9, "flow": 230.46 }]
  }
}
```

顶层键 `__dates` 是**交易日轴**（只存一份，各小类不再重复）。它不是小类名：
前端加载时先取出并剥离，再当作「小类字典」使用，避免混入列表、搜索与对比面板。

小类级字段：

| 字段 | 类型 | 单位 | 可空 | 说明 |
| --- | --- | --- | --- | --- |
| `cat` / `color` | string | — | 否 | 所属大类 key / 线色 |
| `__dates`（顶层） | string[] | 日期 | 否 | 交易日轴，与 `meta.range` 一致；平铺在对象顶层，键名不是小类 |
| `values` | (number\|null)[] | 亿份 | 是 | 该小类份额序列（债券类已 ×100），1 位小数 |
| `current` | number | 亿份 | 是 | 末日值（= `values.at(-1)`） |
| `scale` | number | 亿元 | 是 | 末日规模：Σ 有净值成分的 `份额×净值` |
| `flow` | number | 亿元/日 | 是 | 末日净申购（各成分日流量之和） |
| `navCoverage.hit` | number | 只 | 否 | 同时有份额与净值的成分数 |
| `navCoverage.total` | number | 只 | 否 | 该小类成分总数 |
| `etfs[]` | array | — | 否 | 成分明细，按 `scale ?? shares` 降序 |

成分（`etfs[]`）字段：

| 字段 | 类型 | 单位 | 可空 | 说明 |
| --- | --- | --- | --- | --- |
| `code` / `name` | string | — | 否 | 6 位代码 / 简称 |
| `tags` | string[] | — | 否 | 多维标签，形如 `"index:规模指数"`、`"region:港股"`；维度中文名见 `meta.tagDims` |
| `market` | `"SH"` \| `"SZ"` | — | 否 | 交易所（名录优先，缺失时按代码前缀推断） |
| `shares` | number | 亿份 | 是 | 末日份额（**每个成分也按债券 ×100**） |
| `delta` | number | 亿份 | 是 | 末日 − 窗口首日 |
| `nav` | number | 元/份 | 是 | 末日单位净值 |
| `price` | number | 元 | 是 | 末日收盘价（来自 `quote`） |
| `premium` | number | % | 是 | 折溢价率 = `(price − nav)/nav × 100` |
| `pctChg` | number | % | 是 | 当日涨跌幅（Tushare `fund_daily.pct_chg` 原值） |
| `amount` | number | 亿元 | 是 | 当日成交额（千元 ÷ 1e5） |
| `turnover` | number | % | 是 | 换手率估算 = `成交额 / 规模 × 100` |
| `listDate` | string | 日期 | 是 | 上市日（用于标记新发；缺失为 `null`） |
| `scale` | number | 亿元 | 是 | 末日规模 = `份额(万份)/1e4 × nav` |
| `flow` | number | 亿元/日 | 是 | 末日净申购（已剔除拆分/合并与上市首日） |

> 行情相关字段（`price/premium/pctChg/amount/turnover`）依赖 `quote` 表：**每日增量会更新当日行情**
> （`update` 第 2.6 步），更早的历史用 `npm run quotes`（`scripts/backfill-quotes.mjs`）回补。未回补的日期这些字段为 `null`。

### 4.5 `GET /api/sub/:name`

单小类便捷端点：返回 `{ "name": "<小类名>", ...该小类对象 }`（字段同 §4.4）。
`name` 必须 `encodeURIComponent`。不存在时：

```json
{ "error": "no such sub", "name": "不存在的名字" }   // 404
```

> 该端点只读当前口径的 `subs.json`；**legacy 口径没有对应路由**（`/api/legacy/sub/...` 会落到
> 「按文件名取 legacy 载荷」的逻辑并 404）。切到 legacy 时前端直接用 `subs.json` 做本地索引。

### 4.6 `GET /api/index`

搜索索引。示例：

```json
{
  "subs": [{ "name": "大盘宽基", "cat": "broad", "label": "宽基", "pinyin": "dpkj" }],
  "etfs": [{ "code": "159136", "name": "广发中证A50ETF", "market": "SZ", "subs": ["大盘宽基"] }]
}
```

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `subs[].name/cat/label` | string | 否 | 小类名 / 大类 key / 大类中文名 |
| `subs[].pinyin` | string | 否 | 小类名拼音首字母（如 `dpkj`），用于搜索 |
| `etfs[].code/name/market` | string | 否 | ETF 代码 / 简称 / 市场 |
| `etfs[].subs` | string[] | 否 | 该 ETF 所属的全部小类（可多个） |

### 4.7 `GET /api/market`

全市场总览（沪深全部场内 ETF，**自然口径、不债券 ×100**）。示例：

```json
{
  "dates": ["2021-11-22", "..."],
  "sh":   { "shares": [], "scale": [], "etfs": 951 },
  "sz":   { "shares": [], "scale": [], "etfs": 779 },
  "total":{ "shares": [], "scale": [], "etfs": 1730 },
  "byType": [{ "type": "股票型", "shares": 34920.6, "scale": 33389.6, "etfs": 1633 }],
  "asOf": "2026-11-20",
  "unit": { "shares": "亿份", "scale": "亿元" },
  "note": "全市场口径统计全部场内 ETF（含深市），不做债券 ×100 折算……"
}
```

| 字段 | 类型 | 单位 | 可空 | 说明 |
| --- | --- | --- | --- | --- |
| `dates` | string[] | 日期 | 否 | 交易日轴 |
| `sh` / `sz` / `total` | object | — | 否 | `{shares[], scale[], etfs}`，数组与 `dates` 等长 |
| `sh.shares` / `sz.shares` / `total.shares` | (number\|null)[] | 亿份 | 是 | 当日有份额数据的 ETF 份额合计（自然口径） |
| `sh.scale` / `sz.scale` / `total.scale` | (number\|null)[] | 亿元 | 是 | 规模合计（缺净值的成分按 0 计入份额、不计规模） |
| `sh.etfs` / `sz.etfs` / `total.etfs` | number | 只 | 否 | **最新交易日**有份额的 ETF 只数（不是名录总数；名录数见 `meta.markets`） |
| `byType[]` | array | — | 否 | 最新交易日按基金类型聚合：`{type, shares, scale, etfs}` |
| `asOf` | string | 日期 | 否 | `byType` 与 `etfs` 对应的交易日 |
| `unit` | object | — | 否 | 固定 `{shares:"亿份", scale:"亿元"}` |
| `note` | string | — | 否 | 口径说明（前端会展示） |

> 数据未就绪（`market` 表不足 1000 天或缺深市数据）时：静态文件不生成，`/api/market` 返回
> `404 {"error":"market not ready"}`。

### 4.8 `GET /api/quality`

交叉校验摘要（沪市交易所 vs Tushare），字段与 `data/quality.json` 同源。示例：

```json
{
  "generatedAt": "2026-11-21T12:25:41.919Z",
  "summary": { "checked": 3730, "agree": 3730, "disagree": 0,
               "onlyExchange": 0, "onlyTs": 3800,
               "rates": { "identical": 1, "le0_1": 0, "le1": 0, "gt1": 0 },
               "subs": { "checked": 430, "inconsistent": 0, "singleSource": 10 },
               "worstSub": { "sub": "科创板宽基", "relPct": 0, "note": "一致（偏离 0%，公共成分 75 只）" },
               "ok": true, "range": ["2026-11-16", "2026-11-20"] },
  "days": [{ "date": "2026-11-16", "count": 0, "samples": [] }],
  "detail": { "…": "完整的 data/quality.json（含逐日逐 code 明细）" }
}
```

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `generatedAt` | string | 是 | 校验生成时间 |
| `summary.checked` | number | 否 | 逐只可比对的 code-day 对数 |
| `summary.agree` / `disagree` | number | 否 | 完全一致 / 有分歧的数量 |
| `summary.onlyExchange` / `onlyTs` | number | 否 | 只有一侧有数据的数量（覆盖问题，不是数值分歧） |
| `summary.rates` | object | 是 | 各档占 `checked` 的比例（0–1） |
| `summary.subs` | object | 是 | 小类层：`{checked, inconsistent, singleSource}` |
| `summary.worstSub` | object | 是 | 偏离最大的小类 `{sub, relPct, note}` |
| `summary.ok` | boolean | 是 | 全部通过 |
| `summary.range` | string[2] | 是 | 参与的日期区间 |
| `days[]` | array | 否 | 逐日摘要：`{date, count, samples[]}`，`samples` 为最多 6 条 `"代码 交易所=… / tushare=…"` 文本 |
| `detail` | object | 否 | 原始 `data/quality.json` 全文（`generatedAt/days/summary`），字段见 `DATA.md` |

### 4.9 `GET /api/status`

服务状态（内存，不读数据文件）：

```json
{ "ok": true, "refreshing": false,
  "lastRefresh": { "at": "2026-11-21T12:30:00.000Z", "ms": 16158, "result": { "last": "2026-11-20" } },
  "lastError": null, "now": "2026-11-21T12:40:00.000Z" }
```

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `ok` | boolean | 否 | 固定 `true`（能返回即服务活着） |
| `refreshing` | boolean | 否 | 是否正在跑更新（子进程） |
| `lastRefresh` | object | 是 | 本次进程内最近一次刷新：`{at, ms, result:{last}}`；从未刷新为 `null` |
| `lastError` | string | 是 | 最近一次刷新失败原因 |
| `now` | string | 否 | 服务器当前时间 |

> 前端只用它判断「本地服务是否可用」（决定刷新按钮是否出现），不依赖具体字段。

### 4.10 `GET` / `POST` /api/refresh

触发一次**真实的数据更新**（子进程跑 `scripts/update.mjs`，会联网、写库、重建 `site/`）。

| 情况 | 响应 |
| --- | --- |
| 成功 | `200 {"last":"2026-11-20"}`（更新后的最新交易日） |
| 已有刷新在跑 | `200 {"skipped":"already-running"}` |
| 失败 | `200 {"error":"..."}`（**注意：HTTP 仍是 200**，靠 `error` 字段判断） |

- 前端用 **POST**。虽然实现上 GET 也会触发，但 GET 有副作用不符合语义，别这么用。
- 页面首次访问（`/` 或 `/index.html`）时，若 `data/lastrun.json` 判定「数据过期」，服务会自动触发一次刷新
  （`server/app.mjs` 的 `isStale()`）；`npm start --no-refresh` 可关闭。

### 4.11 `GET /api/legacy/<name>` 与 `/api/legacy/charts/<catKey>`

legacy 口径的「按文件名取数」，直接映射到 `site/data/legacy/`：

| 请求 | 实际文件 |
| --- | --- |
| `/api/legacy/meta` | `legacy/meta.json` |
| `/api/legacy/tables` `subs` `index` `market` `quality` `signature` `lastrun` | 同名 `.json` |
| `/api/legacy/charts/1_%E5%AE%BD%E5%9F%BA%E5%B8%82%E5%9C%BA` | `legacy/charts-1_宽基市场.json` |
| `/api/legacy/archive/2026-11-20` | `legacy/archive/2026-11-20.json` |

错误：图表缺失 `{"error":"no legacy chart","key":"charts/…"}`；其它缺失
`{"error":"no legacy payload","name":"…"}`（均为 404）。

> 该分支是**通配**的：只要 `legacy/` 下有同名文件就能读。当前口径（v2）**没有**同等的通配端点，
> 只实现了 §3 表里列出的固定路径；`/api/signature`、`/api/archive/<date>` 未实现，
> 请直接取静态文件 `data/signature.json`、`data/archive/<date>.json`。

### 4.12 日快照 `archive/<YYYY-MM-DD>.json`

```json
{
  "date": "2026-11-20", "taxonomy": "v2",
  "counts": { "subs": 72, "cats": 7, "etfs": 1903 },
  "categories": [{ "key": "broad", "label": "宽基", "color": "#D16F3F", "subs": 11 }],
  "cats": [{ "key": "industry", "label": "industry", "now": 9249.4, "start": 9398.2, "pct": -1.58, "scale": 6201.7, "flow": -153.5 }],
  "market": { "date": "2026-11-20", "total": { "shares": 35508.9, "scale": 47351.1 }, "byType": [] }
}
```

| 字段 | 说明 |
| --- | --- |
| `date` / `taxonomy` / `counts` / `categories` | 当天构建时的口径与规模 |
| `cats[]` | 当天 `tables.cats` 的副本（字段同 §4.2） |
| `market` | 全市场最后一日快照；`market.json` 缺失时为 `null` |

保留策略：只保留最近 **120** 个交易日的文件（构站时清理更早的）。
获取方式：静态 `data/archive/<date>.json`（或 legacy 的 `/api/legacy/archive/<date>`）。

### 4.13 静态文件与错误码

- 非 API 路径按 `site/` 目录读取；目录穿越（规范化后不在 `site/` 下）返回 `403`。
- 站点尚未构建时访问 `/` 返回 `503` 与纯文本 `站点尚未构建，请先运行 npm run build`。
- 其它不存在的静态路径返回 `404 {"error":"not found","path":"/..."}`。
- `/api/*` 未命中任何规则：`404 {"error":"unknown endpoint","path":"/api/..."}`。
- 处理过程中的异常：`500 {"error":"<message>"}`。

### 4.14 静态辅助文件：`signature.json` / `lastrun.json`

这两个文件**只在静态目录里**（没有 `/api/signature`、`/api/lastrun` 路由；legacy 下可用
`/api/legacy/signature`、`/api/legacy/lastrun` 间接读到）。

`signature.json`：

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `project` / `version` | string | 否 | 项目标识与版本（如 `ebbflow` / `3.1.0`） |
| `author` / `repo` / `license` | string | 否 | 作者 / 仓库地址 / 协议 |
| `fingerprint` | string | 否 | 16 位稳定指纹（= HTTP 头 `X-Project-Signature`） |
| `origin` | object | 否 | 溯源：`{title, author, platform, bilibili, github, note}` |

`lastrun.json`（构站时写入，用于判断数据新鲜度）：

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `at` | string | 否 | 本次构建的 ISO 时间 |
| `lastTradeDate` | string | 是 | 构建时的最新交易日 |
| `ms` | number | 否 | 构建耗时（毫秒） |

> 注意区分 `site/data/lastrun.json`（构站产物，每次 build 覆盖）与仓库根的 `data/lastrun.json`
> （更新流程产物：`{at, lastTradeDate, dates, ms, warnings}`，被 gitignore，服务用它判断是否过期）。

---

## 5. 前端如何取数（`web/js/api.js`）

理解这一层，能解释「为什么有的端点没有 API 实现也能工作」：

| 数据 | 静态路径 | API 回退 |
| --- | --- | --- |
| 当前口径 `meta/tables/subs/index/quality/market/signature` | `data/<key>.json` | `/api/<key>`（`signature` 无实现，静态优先不会走到） |
| 当前口径图表 | `data/charts-<catKey>.json` | `/api/charts/<catKey>` |
| legacy 口径全部 | `data/legacy/<key>.json` | `/api/legacy/<key>` 或 `/api/legacy/charts/<catKey>` |
| 日快照 | `data/archive/<date>.json` | 无（纯静态） |

- 静态先试 → 失败（网络错误/超时重试一次；4xx 不重试）→ 再试 API；两条都失败进入错误态，不会白屏。
- 切换口径时缓存按口径隔离（`v2::key` / `legacy::key`），并用 `stale` 标记丢弃过期响应。
- `subs.json` 约 2MB，进入「小类明细」时才加载。

---

## 6. 自查命令

```bash
# 服务起来了吗
curl -s localhost:5188/api/status | python3 -m json.tool

# 最新交易日与口径
curl -s localhost:5188/api/meta | python3 -c 'import json,sys;m=json.load(sys.stdin);print(m["lastTradeDate"], m["taxonomy"], m["counts"])'

# 某大类（legacy 的中文 key 要编码）
curl -s "localhost:5188/api/charts/industry" | head -c 200
curl -s "localhost:5188/api/legacy/charts/1_%E5%AE%BD%E5%9F%BA%E5%B8%82%E5%9C%BA" | head -c 200

# 单小类 / 全市场 / 质量
curl -s "localhost:5188/api/sub/%E5%A4%A7%E7%9B%98%E5%AE%BD%E5%9F%BA" | head -c 300
curl -s localhost:5188/api/market | head -c 200
curl -s localhost:5188/api/quality | python3 -c 'import json,sys;q=json.load(sys.stdin);print(q["summary"]["ok"], q["summary"]["checked"])'

# 不启服务，直接看静态产物
node -e 'const m=require("./site/data/meta.json");console.log(m.taxonomy,m.lastTradeDate,m.counts)'
```

---

## 7. 已知问题与已修复项

### 7.1 已修复（v3.8.0 · 提交 `d23203a`）

| 问题 | 修复方式 | 现在怎么验证 |
| --- | --- | --- |
| v2 债券小类级数值未 ×100，与成分明细差约 100 倍 | `lib/pipeline.mjs` 改用 `isBondCat()`（同时认 `9_债券` 与 `bond`） | `subs["科创债"].current` 与其 `etfs[].shares` 合计比值 = 1.00 |
| 新库缺 `fund.list_date` 列，`upsertFunds()` / `buildSubs()` 报 `no column named list_date` | `openDb()` 增加幂等迁移 `ALTER TABLE fund ADD COLUMN list_date TEXT` | 空库启动后 `PRAGMA table_info(fund)` 含该列 |
| `event` / `quote` 不在每日流程：折算检测与行情只在手动脚本里 | `scripts/update.mjs` 第 2.6 步每日常规执行 `ingestQuotes()` + `detectShareEvents()` + `putEvents()` | 更新日志出现「行情：N 天 / M 行」「份额折算事件：K 起」 |
| `server/app.mjs` 的 `get payloads()` 调用未定义函数（潜在 `ReferenceError`） | 改为 `return payloadsFallback()` | 访问 `/api/*` 的数据端点正常返回 |

### 7.2 仍存在 / 设计如此

1. **`tables.cats[].label` 不是中文**：v2 下等于大类 key（`industry`），legacy 下是 `9.债券` 形式。
   中文名请查 `meta.categories`。
2. **`/api/sub/:name` 仅当前口径**；legacy 没有对应路由（见 §4.5），前端在 legacy 下用
   `subs.json` 做本地索引。
3. **`/api/signature`、`/api/archive/<date>` 未实现**；只有静态文件（见 §4.11 末尾）。
   前端是静态优先，不受影响。
4. **`/api/refresh` 失败时 HTTP 仍是 200**，必须检查响应体里的 `error` 字段。
5. **行情历史覆盖不全**：每日增量只补「当日」，更早日期需要 `scripts/backfill-quotes.mjs`。
   当前约 297 个交易日有行情；未覆盖日期的 `price/premium/pctChg/amount/turnover` 为 `null`。

---

## 本文的核对状态

- 端点、状态码、响应头、错误文案：逐行对照 `server/app.mjs`（2026-11-21 20:4x），未起服务实跑全部请求。
- 字段名与形状：对照 `lib/payloads.mjs`、`lib/build/site.mjs`，并用 `site/data/*.json` 的真实样例核对
  （示例值取自 2026-11-20 构建产物）。
- 债券 ×100：v3.8.0 修复后用 `site/data/subs.json` 复测，bond 与非 bond 的「小类值 / 成分合计」比值均为 1.00。
- `quote` 字段单位：用 `close × vol / 10 ≈ amount`（误差 0.4%）确认 `vol` 为「手」、`amount` 为「千元」。
- 未实跑：`/api/refresh`（会触发联网更新）、`/api/status` 的运行时字段（示例为结构说明）。

## v4.0.0 契约变更

- `GET /api/subs` 与 `site/data/subs.json`：
  - 新增 `flowSeries`（亿元/日）、`coverage`（0..1）、`currentScale`；
  - **不再下发** `scaleSeries`（改从 `charts-<cat>.json` 的 `series[].scale` 取）；
  - `values` 恒为 `null` 并带 `valuesDeprecated: true`（份额已下线）。
- `GET /api/charts/:cat` 与 `site/data/charts-<cat>.json`：`series[]` 为 `name,color,scale,flow`，`unit: "亿元"`。
- 新增 `site/data/etf-ranges/<cat>.json`：
  `{ cat, periods: ["1m","3m","6m","1y","3y","5y"], unit, subs: { 小类: { period: { code: { chgPct, flow, scaleEnd } } } } }`
- `GET /api/tables`：排行改为区间规模变化额，`pct` 为规模变化率。

