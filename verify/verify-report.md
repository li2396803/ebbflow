# ETF 资金流向站 复刻一致性 · 独立验证报告

- 验证对象：本地复刻版 `site/`（产物 `site/index.html` + `site/charts/*.js`）
- 比对基准：原站副本 `tools/original-index.html` + `tools/original-charts/*.js`
- 验证方式：只读源码，另写脚本与浏览器截图，全部结论可重跑复现
- 验证时间：2026-11-21 11:58–12:05（Asia/Shanghai）

---

## 0. 基线与产物指纹（先确认"拿谁在比"）

| 文件 | SHA-256 | 说明 |
|---|---|---|
| `tools/original-index.html` | `2bcb01c2…45c2dc7` | 与线上 `https://etf-flow-d0j.pages.dev/index.html` **字节相同**（本次实时抓取，200 / 58705 B） |
| `tools/original-charts/3_科技.js` | `e0944472…1e4bdc8` | 与线上同名文件字节相同 |
| `tools/original-charts/9_债券.js` | `68bbab78…2ee61ff8` | 与线上同名文件字节相同 |
| `site/index.html` | `64fb3dab…944dc1` | 复刻产物（58646 B） |
| `data/series.json` | `bfd5d01e…d55623` | 1212 交易日 × 86 小类 |
| `data/last-run.json` | 内容：latestTradeDate `2026-11-20`，dates 1212，subs 86，charts 10，recomputed 1 | |

结论：**比对基准可信**——原站副本不是"记忆中的样子"，而是与线上逐字节一致（index + 抽检 2 个 charts）。

> ⚠️ 并发修改提示：验证过程中 `site/` 被重建过两次（11:58:58 全量重建、12:03:52 又跑了一次 `scripts/update.mjs`），`lib/build.mjs` 于 11:59:30 被修改。本报告全部结论对应上表 `site/index.html` = `64fb3dab…` 这一版；重建后内容哈希未变，结论仍然成立。

---

## 1. 结论总览

| 维度 | 结论 | 依据 |
|---|---|---|
| 页面结构（标题/表格/tab/卡片/CSS） | **一致**（1 处 class 书写差异，渲染等价） | §2 |
| 长期序列 c1（86×1212 = 104232 点） | **99.995% 完全一致**，5 点差 0.1，全部在最新交易日 | §3.1 |
| c2（百分比视图所用的同一份序列） | 与原站一致率同 c1；且 c1.series 与 c2.series 逐字节相等 | §3.4 |
| c3（近 7 日百分比，516 点） | **部分不一致**：180/516 点有差异，最大 14.1 个百分点 | §3.2 |
| 指标口径（小类 = ETF 份额之和；债券 ×100） | **正确**：用原始快照独立复算，原站 86/86 精确命中 | §3.3 |
| 视觉呈现 | **一致**：科技 c1/c2 图像 0 像素差；整页仅 0.45%–0.56% 像素差且只落在数字字形上 | §4 |
| 数据新鲜度 / 自更新 | **可用**：2 秒完成、可重复执行、产物幂等、文案与图表末日期一致 | §5 |

需要 Lead 处理的问题共 4 条实质项 + 3 条提示项，见 §6。

---

## 2. 静态结构对比

脚本：`verify/compare-structure.mjs`（输出 `verify/structure-out.txt`、`verify/structure-report.json`）

复现：

```bash
node verify/compare-structure.mjs
```

### 2.1 逐项结果

| 项目 | 原站 | 复刻版 | 判定 |
|---|---|---|---|
| `<title>` / `<h1>` / brand / notice | ETF 细分行业资金流向 / 同 / B站生炸瓜 / 同 | 同 | ✅ 文本全同 |
| `.sub` 数据区间文案 | `数据区间 2021-11-22 ~ 2026-11-20（1212 个交易日，最多展示 5 年）｜近期区间 2026-11-13 ~ 2026-11-20（6 个交易日）` | 同 | ✅ |
| 表 1 各大类规模 | 9 行 4 列，列名/行序/单元格 class 全同 | 同 | ✅ 结构一致；14 个单元格文本差（数据，见 §3） |
| 表 2 TOP5 增加 | 5 行 3 列 | 同 | ✅ 结构一致；2 个单元格文本差 |
| 表 3 TOP5 减少 | 5 行 3 列 | 同 | ✅ 结构一致；4 个单元格文本差 |
| tab 按钮 | 10 个，顺序 `1_宽基市场…9_债券`（含 `7_消费` 在 `7_医药` 之前），首个 active | 完全同 | ✅ |
| 区间按钮 | 3 个（1年 / 3年 active / 5年） | 同 | ✅ |
| 大类 section | 10 个，id、`h2` 文本、`border-left-color` 全部相同 | 同 | ✅ |
| 三张卡片标题 | `ETF份额变化全景分析` / `长期份额变化率（各小类首个有效日=100%）` / `近 7 个自然日内交易日份额变化率（各小类首个有效日=100%）` | 同 | ✅ |
| 卡片 chart id | `<大类>_c1/c2/c3`，10×3=30 个全同 | 同 | ✅ |
| 卡片 class | c3 为 `chart chart short` | c3 为 `chart short` | ⚠️ 差异（§6-4，渲染等价） |
| 脚本引用 | `echarts.min.js` + 2 段内联脚本 | 同 | ✅ |
| 内联 CSS | 46 条规则 | 46 条规则 | ✅ **字节级完全相同**，选择器集合与声明体全部一致 |

### 2.2 判定

- 结构层面**没有走样**：所有选择器、层级、文案、id、行序、列名一致，CSS 整块字节相同。
- 表内 20 个单元格差异全部是数值/百分比，属于数据更新与取整口径差异（§3 有分类说明），不是结构变化。
- 唯一非数据差异是 c3 卡片 class 少写一个重复的 `chart`（`chart chart short` → `chart short`）。CSS 规则是 `.chart{height:420px}` 与 `.chart.short{height:340px}`，两种写法命中完全相同，**渲染无差别**。

---

## 3. 数值对比

脚本：`verify/compare-numbers.mjs`（输出 `verify/numbers-out.txt`、`verify/numbers-report.json`）

```bash
node verify/compare-numbers.mjs
```

### 3.1 c1 长期序列（86 小类 × 1212 交易日）

| 大类 | 点数 | 完全相同 | \|Δ\|≤0.1 | 0.1<\|Δ\|≤0.5 | >0.5 |
|---|---|---|---|---|---|
| 1_宽基市场 | 8484 | 8483 | 1 | 0 | 0 |
| 2_风格策略 | 12120 | 12120 | 0 | 0 | 0 |
| 3_科技 | 12120 | 12120 | 0 | 0 | 0 |
| 4_制造 | 8484 | 8484 | 0 | 0 | 0 |
| 5_能源 | 9696 | 9695 | 1 | 0 | 0 |
| 6_资源 | 12120 | 12120 | 0 | 0 | 0 |
| 7_医药 | 8484 | 8483 | 1 | 0 | 0 |
| 7_消费 | 13332 | 13331 | 1 | 0 | 0 |
| 8_金融地产 | 8484 | 8484 | 0 | 0 | 0 |
| 9_债券 | 10908 | 10907 | 1 | 0 | 0 |
| **合计** | **104232** | **104227（99.995%）** | **5** | 0 | 0 |

5 个差异点**全部集中在 2026-11-20**（最后一个交易日，即被 `update.mjs` 用原始接口数据重算的那一天），且方向一致（复刻版高 0.1）：

```
A股中盘         @2026-11-20: 原=242     复=242.1
环保与碳中和     @2026-11-20: 原=54      复=54.1
疫苗            @2026-11-20: 原=3.7     复=3.8
养老服务         @2026-11-20: 原=2       复=2.1
可转债与可交换债  @2026-11-20: 原=5391.6  复=5391.7
```

根因已定位并证实为**双重取整**，见 §3.5。除这一天外，历史 1211 个交易日**逐点完全相同**（含空值位置，null 不一致 0）。

### 3.2 c3 近 7 日百分比（86 小类 × 6 交易日 = 516 点）

| 大类 | 点数 | 相同 | ≤0.1 | 0.1–0.5 | >0.5 | 最大偏差 |
|---|---|---|---|---|---|---|
| 1_宽基市场 | 42 | 31 | 5 | 6 | 0 | 0.30 |
| 2_风格策略 | 60 | 45 | 8 | 4 | 3 | 1.00 |
| 3_科技 | 60 | 45 | 12 | 3 | 0 | 0.30 |
| 4_制造 | 42 | 23 | 4 | 12 | 3 | 1.00 |
| 5_能源 | 48 | 25 | 9 | 4 | 10 | **14.10** |
| 6_资源 | 60 | 35 | 9 | 7 | 9 | 3.50 |
| 7_医药 | 42 | 22 | 2 | 10 | 8 | 2.40 |
| 7_消费 | 66 | 34 | 10 | 6 | 16 | 5.30 |
| 8_金融地产 | 42 | 26 | 9 | 4 | 3 | 1.90 |
| 9_债券 | 54 | 50 | 4 | 0 | 0 | 0.10 |
| **合计** | **516** | **336（65.1%）** | **72** | **56** | **52** | **14.10** |

**这与"只有 0.1~0.3 的精度差"的既有说法不符**：>0.5 个百分点有 52 点，最大 14.1 个百分点。

最典型：`5_能源 / 风电与绿色能源`（只有 1 只 ETF `562010`）

```
日期        原站 c3   复刻 c3
2026-11-16   85.9     100.0    Δ14.1
2026-11-17   85.9     100.0    Δ14.1
2026-11-18   90.6     100.0    Δ 9.4
2026-11-19   90.6     100.0    Δ 9.4
2026-11-20   90.6      95.0    Δ 4.4
```

用原始快照复算该 ETF 的份额（亿份）：`0.212987 / 0.182987 / 0.182987 / 0.192987 / 0.192987 / 0.192987`，以首个有效日为 100% → `100 / 85.9 / 85.9 / 90.6 / 90.6 / 90.6`，**与原站完全一致**。

复刻版则是在"已取整到 1 位小数"的序列（0.2/0.2/0.2/0.2/0.2/0.2）上算百分比，于是全部塌成 100%。根因明确：**c3 的百分比用 1 位小数序列计算，而非原始未取整值**。小规模小类（<1 亿份）因此误差被放大。
（注意：这条不必然影响视觉一致性——见 §4，`3_科技` 的 c3 图像差 3.77% 像素，整体版式不变。）

### 3.3 指标口径复算（不使用任何已有代码路径）

脚本：`verify/recompute-subs.mjs`（输出 `verify/recompute-out.txt`、`verify/recompute-report.json`）

```bash
node verify/recompute-subs.mjs
```

直接用 `data/shares/<date>.json` 的原始份额（万份）重算"小类 = 其全部 ETF 份额之和 ÷1e4（亿份），`9.债券` ×100"：

- 抽查 `A股大盘`(67只) / `半导体芯片`(33只) / `可转债与可交换债`(2只) × 12 个原始快照日 = **36 点，35 点与两份产物同时精确相等**；唯一 1 点即 §3.5 的双重取整（5391.6 → 5391.7）。
- 2026-11-20（沪深两市齐全）复算**全部 86 个小类**：**原站 86/86 全部等于 `round1(原始和)`；复刻版 81/86 相等**，差的 5 个就是 §3.1 那 5 个。
- 附带发现（非缺陷）：19 个小类在交易所快照里缺少个别 ETF 代码（如 `A股大盘` 缺 3/67、`A股中盘` 缺 2/27）。这些代码在复算时不计入，结果仍与原站逐点相同，说明原站同样不把它们计入（已退市/停牌标的），口径一致。

手算示例（`可转债与可交换债`，债券类 ×100）：

```
511380 博时中证可转债及可交换债   456208.67 万份
511180 海富通上证投资级可转债及…   82955.97 万份
合计 539164.64 万份 = 53.916464 亿份
×100（债券面值折算） = 5391.6464 → 保留 1 位 = 5391.6   ← 原站
复刻版输出 5391.7                                        ← 双重取整
```

同时验证了 `9.债券` 的 ×100 折算方向正确（若用 ×1，数值会差 100 倍，显然不符）。

### 3.4 同一 data 文件的内部一致性

两边的 10 个 data 文件全部满足（脚本 `internalIssues = 0`）：

- `c1.series` 与 `c2.series` **完全相同**（c2 只是 `percent:true` 的同一份数据，符合原站设计）；
- `c2.percent === true`、`c3.percent === true`、`c3.shortDates === true`；
- `c3.dates` 恰好是 `c1.dates` 的**末尾 6 个交易日**（2026-11-13 … 2026-11-20），且两边日期数组逐项相等；
- 小类集合与顺序、配色 `color` 全部相同（86 个）。

### 3.5 双重取整根因（可用一行验证）

`lib/aggregate.mjs: computeDay()` 用 `round2` 落库，`lib/build.mjs: buildChunk()` 再 `r1` 取整到 1 位，构成双重取整；原站是单次 `round1`。原始数据恰好落在 .xx5 边界时就 +0.1：

```bash
node --input-type=module -e '
import fs from "node:fs";
import { SUB, BOND_CAT } from "./lib/taxonomy.mjs";
const day = JSON.parse(fs.readFileSync("data/shares/2026-11-20.json","utf8"));
const sh = { ...day.sse, ...day.szse };
for (const sub of ["A股中盘","环保与碳中和","养老服务","疫苗","可转债与可交换债"]) {
  const m = SUB[sub], f = m.cat === BOND_CAT ? 100 : 1;
  let s = 0; for (const e of m.etfs) { const v = sh[e.code]; if (v != null) s += v; }
  const exact = (s / 1e4) * f;
  console.log(sub, exact.toFixed(6),
    "一次取整", Math.round(exact*10)/10,
    "两次取整", Math.round(Math.round(exact*100)/100*10)/10);
}'
```

输出确认：`A股中盘 242.049563 → 242 / 242.1`、`可转债 5391.646400 → 5391.6 / 5391.7`（一次取整 = 原站，两次取整 = 复刻版）。

---

## 4. 视觉对比

方法：`python3 -m http.server`（8801 服务 `site/`，8802 服务原站副本临时目录 `/tmp/etf-orig-site`，echarts 由 `site/echarts.min.js` 复制、charts 来自 `tools/original-charts`，**未改动 site/**）+ playwright（`playwright-cli`）1440×900、DPR 1、同一浏览器，同一脚本流程：滚动触发 echarts 懒加载 → 回顶部 → 截图。

页面布局事实采集（`getBoundingClientRect` / `getComputedStyle`）：**11 项全部相同，差异 0 项**
`bodyH=2201`、`tabs` 10 项文案、`activeSections`、`canvasCount=6`、30 个 `.chart` 盒模型（如 `3_科技_c1 1138×420`、`3_科技_c3 1138×340`）、首表 `562×483/9 行`、`fontFamily="Microsoft YaHei","PingFang SC",sans-serif`、`bodyBg=rgb(255,255,255)`、`h1=22px`、active tab 背景 `rgb(31,111,235)`。

像素差（Pillow `ImageChops.difference`）：

| 截图（`verify/shots/`） | 尺寸 | 变化像素 | 比例 | 备注 |
|---|---|---|---|---|
| `tech-c1-orig.png` / `tech-c1-repl.png` | 1138×421 | **0** | **0.0000%** | 3.科技 c1 **字节级相同**（同 SHA-256） |
| `tech-c2-orig.png` / `tech-c2-repl.png` | 1138×421 | **0** | **0.0000%** | 3.科技 c2 **字节级相同**（同 SHA-256 `07f96349…`） |
| `tech-c3-orig.png` / `tech-c3-repl.png` | 1138×341 | 14619 | 3.7672% | 3.科技 c3 曲线位置随百分比差异移动（§3.2） |
| `home-viewport-orig/repl.png` | 1440×900 | 3039 | 0.2345% | 差异区 bbox (405,231)-(1264,647)，即表格数字 |
| `home-full-orig/repl.png` | 1440×2201 | 14181 | 0.4474% | 同上 + 首图曲线 |
| `tech-viewport-orig/repl.png` | 1440×900 | 3039 | 0.2345% | 同首页视口（顶部内容相同） |
| `tech-full-orig/repl.png` | 1440×2201 | 17658 | 0.5571% | 含 c3 图表区域 |

辅助文件：`verify/shots/diff-home-viewport.png`、`verify/shots/diff-tech-full.png`（差异像素二值化，可见差异只落在数字字形与 c3 折线上）、`verify/shots/tables-crop-orig.png` / `tables-crop-repl.png`（表格区域裁切）。

> `verify/shots/` 下的 `local_*.png`、`origin_home.png`、`origin_tech.png` 是验证期间其他成员留下的截图，不属于本次证据；本报告只引用上表列出的 `*-orig.png` / `*-repl.png` / `diff-*.png` / `tables-crop-*.png`。

**人工目视确认**（`home-viewport-orig.png` 与 `tech-full-repl.png`）：配色（蓝底 active tab、红涨绿跌）、卡片圆角/边框、字体层级、水印、图例换行、endLabel 白底标签、表格斑马线全部一致；可见差别仅为数字末位（16325.5 vs 16325.4、+19.23% vs +19.21%）。

---

## 5. 数据新鲜度与自更新检查

### 5.1 元信息

- `data/last-run.json`：`latestTradeDate=2026-11-20`、`dates=1212`、`subs=86`、`charts=10`、`recomputed=1`、`sub` 文案与页面一致。
- `data/series.json` meta：`seededAt=2026-11-21T03:58:11Z`，`seedSource="etf-flow-d0j.pages.dev/charts/*.js"`（历史序列来自原站；最近 12 天有原始快照 `data/shares/*.json`）。
- 快照覆盖：2026-11-05 … 2026-11-20 共 12 个交易日；其中只有 2026-11-20 同时有沪（927 只）与深（1088 只），其余 11 天仅沪市。

### 5.2 运行 `node scripts/update.mjs`

为不改动交付物，在**逐字节相同的副本** `/tmp/etf-run` 中执行（`rsync -a` 复制，排除 `verify/`、`.playwright-cli`）：

```bash
cd /tmp/etf-run && node scripts/update.mjs
```

| 项 | 结果 |
|---|---|
| 退出码 | 0（两次均 0） |
| 耗时 | **2 秒**（run1 04:02:54、run2 04:02:58） |
| 日志 | `深交所 报告日 2026-11-20，1088 个标的` / `完成：最新交易日 2026-11-20（本次重算 1 天），1212 个交易日 / 10 个大类` |
| 幂等性 | 两次运行后 `site/index.html`、`data/series.json`、10 个 `site/charts/*.js` 的 SHA-256 **完全一致** |
| 与运行前对比 | `site/index.html`、`data/series.json` 运行前后**字节未变**（数据已是最新交易日，重算结果确定） |
| 文案 vs 图表末日期 | `index.html` 的 `数据区间 … ~ 2026-11-20` 与 10 个 charts 的 `D0` 末值唯一为 `2026-11-20` → **一致** |
| 真实目录复跑 | 12:03:52 生产目录也执行过一次（非我所为），`site/index.html` 与 `data/series.json` 内容哈希不变 → 幂等在生产目录同样成立 |

补充观察（不影响结论）：
- 每次运行会重写 `data/shares/2026-11-20.json` 的 `szseFetchedAt`（时间戳字段），因此**快照文件字节会变**，但派生产物不变。
- `data/` 下残留 `_probe_szse.json`（101 KB，探测用），运行不依赖它。

---

## 6. 需要 Lead 修的问题清单（按严重程度）

> 状态更新：**P1 / P2 / P4 / P5 已于第二轮修复并复核通过**，本节保留为第一轮的原始记录；最新结论与边界条件见文末「修复复核（第二轮）」。P3（首页表末位差）与 P7 仍作为已知精度限制保留。

### P1【中】「近 7 日百分比」c3 用 1 位小数序列计算，小规模小类最大误差 14.1 个百分点

- 现象：`5_能源/风电与绿色能源` c3 原站 `100/85.9/85.9/90.6/90.6/90.6`，复刻 `100/100/100/100/100/95`；全站 52 个点偏差 >0.5pp。
- 根因：`data/series.json` 的值是 1 位小数（种子即如此），`buildChunk()` 直接在其上算 `v/base*100`；原站用未取整原始份额算百分比。
- 证据：用 `data/shares/*.json` 复算 `562010` 得 0.212987/0.182987/0.182987/0.192987…，百分比恰好复现原站 100/85.9/85.9/90.6/90.6/90.6。
- 可行修法（不改原站版式）：窗口内 6 天的原始份额本地都有（沪市全有），对"全部标的都在沪市"的小类，c3 直接用原始未取整和计算；或让 series 内部保留更高精度、仅在渲染时取 1 位。
- 复现：
  ```bash
  node verify/compare-numbers.mjs | grep -A6 "合计 c3"
  node --input-type=module -e '
  import fs from "node:fs";
  const codes=["562010"];
  const ds=["2026-11-13","2026-11-16","2026-11-17","2026-11-18","2026-11-19","2026-11-20"];
  const v=ds.map(d=>{const j=JSON.parse(fs.readFileSync(`data/shares/${d}.json`,"utf8"));const sh={...j.sse,...j.szse};return codes.reduce((a,c)=>a+(sh[c]??0),0)/1e4;});
  console.log(v.map(x=>x.toFixed(6)).join(" "));
  console.log(v.map(x=>(x/v[0]*100).toFixed(1)).join(" "));'
  ```

### P2【低】最新交易日 5 个小类 c1 偏高 0.1（双重取整）

- 现象：见 §3.1 五例；原站 86/86 = `round1(原始和)`，复刻 81/86。
- 根因：`lib/aggregate.mjs computeDay()` 用 `round2` 落库，`lib/build.mjs buildChunk()` 再 `r1`。
- 修法：`computeDay()` 直接用 `round1`（或存原始精度、渲染时取整一次）。
- 复现：§3.5 的一行脚本。

### P3【低】首页三张表 20 个单元格 0.1~0.2 偏差（合计口径与取整）

- 现象：大类表 14 处（如 `区间首日规模 16325.5 → 16325.4`、`当前总规模 5635.9 → 5636.0`）、TOP5 增 2 处、TOP5 减 4 处。
- 根因：原站大类合计/区间变动用**未取整**的原始值先加后取整；复刻用已取整的 1 位小数小类值相加（实测 2026-11-13 债券：小类 1 位小数之和 16325.40，原站表 16325.5）。
- 影响：仅末位差，可接受；若要完全对齐，需在聚合层保留更高精度。
- 复现：`node tools/verify-tables.mjs`（注意该脚本本身有 P5 的列错位 bug，需先修）

### P4【低】c3 卡片 class 写法与原站不同（渲染等价）

- `site/index.html` 中 `<div id="…_c3" class="chart short">`，原站为 `class="chart chart short"`。
- 影响：无（`.chart{height:420px}` + `.chart.short{height:340px}` 命中相同）。若要求字节级同构，可在 `build.mjs` 里改成 `chart chart short`。
- 复现：`node verify/compare-structure.mjs | grep -A3 "大类 section"`

### P5【提示】`tools/verify-tables.mjs` 自身列错位，产生 9/9 假报警

- 该脚本把 `o[2]`（区间首日规模）当成"变动比例"比较，故大类表永远 9 行全 XX；TOP5 表的列对得上，但那 6 个 XX 也只是 0.1~0.2 的末位差（P3）。
- 结论：**不要据此认为表格差异严重**；修复方式是把比较对象改成 `o[3]`。
- 复现：`node tools/verify-tables.mjs`

### P6【提示】`data/_probe_szse.json` 是探测残留（101 KB），建议删除或移入 `tools/`。

### P7【提示】更新会改写 `data/shares/*.json` 的时间戳字段，导致 `data/` 目录非幂等；若按"目录级 diff"判断更新是否变化会误报。产物（`site/`、`series.json`）是幂等的。

---

## 7. 未覆盖项（如实声明）

- **移动端/响应式**（`@media(max-width:760px)` 分支）未截图验证。
- **交互行为**：hover 图例触发 ETF 浮层、tooltip、`1年/3年/5年` 区间切换、tab 切换后图表 resize，只做了 DOM 结构核对与静态截图，未做交互级 A/B。
- **其余 7 个大类的图表渲染**只做了数值与数据文件对比（`3_科技` 与首页做了截图/像素级）。
- **全历史 1212 个交易日的原始数据复算**：本地原始快照只有 12 天，其余 1200 天只能依赖"原站种子 = 原站数值"这一事实（已逐点比对，无差异）。
- **更新流程的边界场景**：新交易日首次运行、周末/节假日、深交所接口失败或返回旧数据、断网重试，均未构造验证（只验证了"当日已最新"的正常路径）。
- **线上原站的运行时行为**（如懒加载失败兜底、`IntersectionObserver` 边界）未做端到端验证。

---

## 附录 A：本次新增的验证脚本与产物

| 文件 | 作用 |
|---|---|
| `verify/compare-structure.mjs` | HTML 结构对比（标题/表格/tab/卡片/CSS 规则集） |
| `verify/compare-numbers.mjs` | c1/c2/c3 差异分布 + 文件内部一致性 |
| `verify/recompute-subs.mjs` | 用原始份额独立复算口径（3 个抽查小类 + 86 小类全量） |
| `verify/structure-report.json`、`numbers-report.json`、`recompute-report.json` | 机读结论 |
| `verify/structure-out.txt`、`numbers-out.txt`、`recompute-out.txt` | 脚本原始输出 |
| `verify/shots/*.png` | 原站/复刻截图与像素差图（见 §4 表） |

全部脚本只读 `site/`、`tools/`、`data/`、`lib/`，未修改任何源码。

## 附录 B：一键复现

```bash
cd etf-flow
node verify/compare-structure.mjs     # 结构
node verify/compare-numbers.mjs       # 数值
node verify/recompute-subs.mjs        # 口径复算

# 视觉（需两个静态服务；原站副本放临时目录）
mkdir -p /tmp/etf-orig-site && cp tools/original-index.html /tmp/etf-orig-site/index.html
cp site/echarts.min.js /tmp/etf-orig-site/ && cp -r tools/original-charts /tmp/etf-orig-site/charts
python3 -m http.server 8801 --directory site &
python3 -m http.server 8802 --directory /tmp/etf-orig-site &

# 更新（在副本里跑，避免动交付物）
rsync -a --exclude verify --exclude .playwright-cli ./ /tmp/etf-run/
cd /tmp/etf-run && node scripts/update.mjs && node scripts/update.mjs
```

---

# 修复复核（第二轮，2026-11-21 12:06–12:09）

复核对象（Lead 的修复版）：

| 文件 | SHA-256 |
|---|---|
| `site/index.html` | `6f0f509f…8b36d3` |
| `data/series.json` | `60109b28…7cd0b8` |
| `data/c3-seed.json` | `12e09f8e…ee537a` |

结论：**P1 / P2 / P4 / P5 四项均已修好，本轮四项问询全部为"是"**。但 P1 的修法有一个仅对当前快照成立的边界，见文末"遗留风险"。

## a) c1 与 c3 是否 0 差异 —— 是

用我自己的独立脚本（不复用 Lead 的 `diff-site.mjs`）：

```bash
node verify/compare-numbers.mjs | grep "合计"
```

```
合计 c1: 点数 104232｜完全相同 104232（100.00%）｜|Δ|≤0.1 0｜…｜max|Δ| 0.0000
合计 c2: 点数 104232｜完全相同 104232（100.00%）｜|Δ|≤0.1 0｜…｜max|Δ| 0.0000
合计 c3: 点数  516｜完全相同  516（100.00%）｜|Δ|≤0.1 0｜0.1<|Δ|≤0.5 0｜>0.5 0｜max|Δ| 0.0000
内部一致性/结构问题: 0
```

第一轮的 c1 是 104227/104232、c3 是 336/516；现在**两个维度都逐点相等**，`internalIssues`（c1≡c2、c3 日期 = D0 末尾）仍为 0。

> 一处表述需要校正：`node tools/diff-site.mjs` 打印的"对比 104232 个数据点"只统计 c1（c3 的差异是逐行打印、不进 `total/diff` 计数）。所以"104232 / 差异 0"并不能证明 c3；c3 的证据是"0 行 `c3 ` 前缀输出"＋我上面 516/516 的独立统计。两者结论一致。

## b) 最新交易日那 5 个小类是否已与原站一致 —— 是，5/5

```bash
node -e '…'  # 见 verify/recompute-out.txt 中 2026-11-20 段
```

| 小类 | 原站 @2026-11-20 | 复刻 @2026-11-20 | 判定 |
|---|---|---|---|
| A股中盘 | 242 | 242 | ✅（原 242.1） |
| 环保与碳中和 | 54 | 54 | ✅（原 54.1） |
| 疫苗 | 3.7 | 3.7 | ✅（原 3.8） |
| 养老服务 | 2 | 2 | ✅（原 2.1） |
| 可转债与可交换债 | 5391.6 | 5391.6 | ✅（原 5391.7） |

更强的一步：用原始份额独立复算 2026-11-20 **全部 86 个小类**，与两份产物比对 → `与两份产物都不一致 0 个`；抽查的 3 个小类 × 12 个快照日 = **36 点，不一致 0 点**（第一轮是 35/36）。
与 `round4` 落库 + `r1` 渲染的口径相符（等价于对未取整值取 1 位），P2 根因消除。

## c) c3 卡片 class 是否为 `chart chart short` —— 是

```bash
grep -o 'class="chart[^"]*"' site/index.html | sort | uniq -c
#   10 class="chart chart short"
#   20 class="chart"
```

10 个大类 × 1 张 c3 卡片全部为 `chart chart short`，与原站一致；结构脚本的 `cats.cards` 差异已归零，`结构差异（应视为走样）: 0`。

## d) 首页「各大类规模」表 —— 当前总规模 9/9 一致；区间首日 max 0.40（≤0.5）

独立逐列比对（新脚本 `verify/check-table-fix.mjs`，直接解析两份 HTML 的表格单元格）：

```bash
node verify/check-table-fix.mjs
```

```
当前总规模列不一致行数: 0 / 9（含行标签不一致）
区间首日规模列 max|Δ| = 0.40   变动比例列 max|Δ| = 0.02 pp
```

- 「当前总规模」列 **9/9 完全相同**（第一轮 1.宽基市场 5635.9→5636.0 的偏差已随 P2 消失）；
- 「区间首日规模」9 行均有末位差，最大 **0.40**（7.医药&消费 2370.9 vs 2371.3），其余 0.1–0.2；
- 「变动比例」最大 **0.02 pp**（4.制造 −0.10% vs −0.12%）。

`tools/verify-tables.mjs` 的列错位已修好：代码现在比较 `o[1]/o[2]/o[3]` 三列（`当前总规模 / 区间首日规模 / 变动比例`），不再是旧的"把 o[2] 当 pct"。剩下的 9 行 `XX` 是真实的末位差（即上面的 0.40 与 0.02pp），不是脚本 bug。TOP5 两张表仍有 6 处末位差（0.1–0.2），同源。

## 遗留风险（P1 修法的边界，建议记入 README 已知限制）

`buildChunk()` 只在「近 7 日窗口**完全落在** `data/c3-seed.json` 的 6 个日期内」时沿用原站百分比，否则回落到"用 1 位小数序列自算"。当前窗口 2026-11-13…2026-11-20 恰好被 seed 覆盖，所以一致；**下一个交易日窗口右移后会立刻走 fallback**。实测（只读调用 `buildChunk(store, cat, null)` 强制 fallback）：

```
风电与绿色能源  原站 c3 : 100,85.9,85.9,90.6,90.6,90.6
                当前产物(用 seed): 100,85.9,85.9,90.6,90.6,90.6
                fallback(不用 seed): 100,100,100,100,100,96.5
```

即 `data/series.json` 的历史值仍是 1 位小数（末 6 日实测 `0.2 0.2 0.2 0.2 0.2 0.193`），fallback 会把 14pp 级误差带回来。两条可选改法：
1. 每次 `update.mjs` 追加当日 c3 真实百分比到 `c3-seed`（用当日原始份额算，而非用 series 的 1 位小数），让 seed 随窗口一起滚动；
2. 或让 `series.json` 的历史值也保留 `round4` 精度（仅在渲染 c1 时取 1 位），使 fallback 本身足够准。

## 本轮未覆盖

- 上述 fallback 的**实际触发**（下一交易日窗口右移）未构造运行，只用强制 fallback 做了等价性验证。
- 复核期间 `data/shares/` 曾被并发重建（12:07 时 `2026-11-17.json` 一度缺失，导致抽点数从 36 变 33，12:08 恢复）；本轮所有数字取 12:09 的稳定状态。

