# 更新日志

本文件记录对仓库结构、数据口径、命令有影响的变化。日常数据更新（`chore(data): 自动更新站点数据`）不记录。

## v3.7.0 — 表格布局全面修正 + 对比支持多选（2–8）

### 表格

- **TOP 8 双卡等宽**：区间份额增加/减少两张卡从 2:1 改为 1:1（1440px 实测 564 vs 564），≤1024px 堆叠。
- **修复「份额减少 TOP 8」取错数据**：原来按 `slice(-8)` 取到的是**增加最多**的 8 条（升序末尾），改为按变化量升序取前 8，现在正确显示 -292.4 / -290.9 / -76.4…
- **全站表格审计**：统一 `tabular-nums`（数字等宽）、表头与单元格同 padding 同对齐、行高统一 40px、百分比零值用 figure space 占位；`本类细分行业明细` 固定列宽（名称 ≥140px、数值 12ch、走势 120px 居中）。
- **明细表折叠**：默认 12 行 + 「展开全部 N 行 / 收起」，切换大类自动复位；移动端仍隐藏规模/走势列。
- 抽屉加宽 672 → 880px，11 列成分表在 1024+ 不再需要横向滚动。

### 对比多选

- 「对比」改为多选面板：搜索（中文/拼音）+ 复选框 + 大类标注 + 计数，**可选 2–8 个**（移动端 4），不足 2 个提示、第 9 个自动禁用。
- 已选为可删除 chip；3–8 条曲线统一归一化到区间起点 = 100（净申购比区间累计），图例可单独开关。
- URL `compare=a,b,c`（兼容旧 `cmp=a|b`），刷新/分享还原。

### 顺带修复

`subs.json` 顶层的 `__dates`（交易日轴）会被当成一个小类混进列表/搜索/对比面板 —— 前端加载时剥离该键，避免污染。

---

## v3.6.0 — 加载链路优化（本地 2.6×、复访 2.8×）

在 1.6Mbps / 150ms RTT 限速下实测（本地服务）：

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 首个图表出现 | 7,989 ms | **3,027 ms** |
| 复访首个图表 | 1,712 ms | **614 ms** |
| `subs.json` 传输 | 2,063 KB（未压缩） | **954 KB → 220 KB(gzip)** |
| `echarts.min.js` 传输 | 1,005 KB（未压缩） | **327 KB(gzip)** |

做法：

1. **本地服务启用 gzip**：静态资源统一走 `sendFile`，gzip 预压缩缓存（按 mtime 失效，最多 64 个），`Vary: Accept-Encoding`。
2. **ETag + 304**：重复访问不再重传（`If-None-Match` 命中直接 304）。
3. **JSON 缓存策略** `no-store` → `no-cache`：可复用 preload、复访走 304 协商；HTML/JS/CSS 走 `max-age=600`。
4. **`subs.json` 去掉重复的 `dates`**：原来每个小类都带一份 1212 天的日期数组（72 份），提到顶层 `__dates` 只留一份，体积 **2.06 MB → 954 KB**（−54%）。
5. **预加载**：`echarts.min.js` 加 `fetchpriority="high"`、`data/market.json` 加 `rel=preload`，三者并行起跑（183ms 同时开始）。

剩余瓶颈：`echarts.min.js` 仍占首屏 82% 的等待时间（327 KB gzip）。下一步可做「按需裁剪的 ECharts 自定义构建」（只保留 line/bar/tooltip/grid/dataZoom/legend，预计 327 → ~120 KB），需要引入构建期打包工具，尚未做。

---

## v3.5.2 — 移动端明细表排版 + 聚焦态去重复标注

- **移动端「本类细分行业明细」**：≤640px 隐藏「规模」「走势」两列，保留 4 列核心指标，390px 下零横向裁切；≥768px 恢复全部 6 列。
- **聚焦态移除右侧端点标注与引线**：每条线已有独立彩色坐标轴 + 图例末值，右侧引线数值重复；gutter 由 92px 收到 14px，绘图区更宽。大类多线视图仍保留标注（那里没有独立轴，需要对应关系）。
- 回归：102 项前端断言全绿（38+22+20+16+6），0 pageerror、0 HTTP≥400。

---

## v3.5.1 — 聚焦态双布局（分面 / 叠加可切换）+ 导航联动

- **布局开关**：聚焦且选中 ≥2 个指标时出现「分面 / 叠加」切换；**默认分面**（分面 = small multiples，业界最佳实践），叠加作为可选高级模式（N 条独立轴，选中顺序＝轴顺序，彩色刻度）。
- 选择记忆：`localStorage: ebbflow-focus-layout` + URL `layout=axes`（分面不写），两种布局共用指标选择与顺序、tooltip、滑块、brush，切换仅 setOption（46ms，实例不变）。
- **导航联动**：点小类进入聚焦时，大标题变为小类名、副标题「大类 · 单系列 · 区间」，侧栏该小类高亮并自动展开所在大类；「返回大类」恢复。
- **审计修复**：小屏口径切换溢出（320–1920 无横向滚动）、轴名角标仅在 ≤2 条轴时显示、移动端内嵌表列裁剪 + 滚动渐隐。
- 分面模式刻度治理沿用 v3.5.0（副栏 splitNumber=2 + nice 步长 + 强制含 0 + 紧凑格式）。

---

## v3.5.0 — 聚焦态改为「同 X 轴分面」，四个指标完全平等

聚焦单系列时，四个指标不再是「主指标 + 叠加」，而是**平权的多选**，纵坐标冲突用业界标准的**分面（small multiples）**解决：

- **四个指标完全平等**：点选/取消，无主次；至少保留 1 项；图例即指标开关。
- **分面布局**：主栏（55%）份额 + 规模（同选时左右双轴、轴色跟随线色）→ 副栏（25%）份额净申购柱状（0 基线）→ 副栏（20%）变化率（0 基线）。
- **共享时间轴**：X 轴与 dataZoom 只在最底栏，`axisPointer` 全栏联动，tooltip 一次列出全部已选指标。
- **刻度治理**：副栏 `splitNumber: 2` + nice 步长（1/2/2.5/5×10^k）+ 强制含 0 + 紧凑格式（1.2k），解决多轴刻度拥挤。
- URL 改为 `metric=shares,scale,flow,pct`；旧链接 `metric=shares&overlay=flow` 自动兼容。
- 移动端保留分面，每栏 ≥110px；指标上限 2 项并弹替换选择。

为什么这样设计：多指标量纲不同（亿份/亿元/亿元每日/百分比），挤在一张图里要么共用一根轴（小的被压平），要么堆多根轴（越读越乱、还制造伪相关）。Wind / 同花顺 / TradingView / Bloomberg 的通行做法都是「主图 + 副图、共享时间轴」，本项目照此实现。

---

## v3.4.0 — 行情接入（折溢价/成交额/换手率）+ 净流入口径修正 + 文档体系

### P0 数据正确性

- **行情接入**：新增 `quote` 表与 `fund_daily` 摄入（收盘价 / 涨跌幅 / 成交量 / 成交额，每交易日 1 次调用覆盖全市场）；
  `subs.json` 每只 ETF 增加 `price / premium / pctChg / amount / turnover / listDate`。
- **折溢价率**：`(收盘价 − 单位净值) / 单位净值`；**成交额**（亿元）与**换手率**（成交额/规模）同步上线。
- **净流入口径改名**：全站「净流入」→「**份额净申购**」，并注明它是估算：ETF 二级买卖不改变份额，只有一级申赎才改变。
- **上市首日剔除**：`fund.list_date` 已回填 2856/3037；新发基金上市首日的一次性份额不计入净申购。
- 与已有的**份额折算剔除**（254 起拆分/合并）共同构成净申购的三重修正。

### P2 工程质量

- `docs/API.md`（563 行）+ `docs/DICTIONARY.md`（378 行）：端点契约、载荷字段、13 张表的数据字典。
- `docs/DATA.md`、`docs/ARCHITECTURE.md` 重写；README §2/§3 更新为「两源 + 双口径」。
- **历史快照**：构建时输出 `site/data/archive/YYYY-MM-DD.json`（单日约 4KB，保留 120 个交易日）。
- **CI 冷启动加速**：`scripts/publish-db-seed.sh` 把 DB 压成 39MB 发布为 `db-seed` Release 资产；daily 工作流无缓存时自动下载，fork 不再等 30 分钟全量回补。

### 修复（文档评审挖出）

1. **v2 债券大类小类值未 ×100** —— `factor` 只判 legacy 的 `9_债券`，v2 的 `bond` 落空，科创债 33.5 → 3345.6。
2. **新库缺 `fund.list_date`** —— `CREATE TABLE` 未建列且无迁移，新建库会直接抛错；已补幂等 ALTER。
3. **`event`/`quote` 未进每日流水** —— `detectShareEvents` 无调用点、行情只靠手动回补；现每日增量维护。
4. **`server/app.mjs` 的 `get payloads()`** 调用了未定义函数，访问即 ReferenceError。

---

## v3.3.0 — 六项体验修复 + 高分离度配色

1. **加载竞态**：失败的请求不再污染 inflight；网络错误自动重试 1 次；切换口径时在途响应按口径丢弃；数据就绪前交互统一拦截。
2. **大类即合并视图**：点大类直接看该类全部小类的多线图，不再强制先进入单系列聚焦。
3. **指标按钮多选**：删掉聚焦态额外那行，四个指标按钮本身即可多选（实心＝主指标，描边+✓＝叠加）。
4. **配色重做**：数据层生成高分离度色板（Okabe–Ito + 色相环贪心），同一大类最小 ΔE 从 3.6 提升到 9.7–144，白底对比度 ≥3:1；默认 Top 12 + 「其他」聚合，hover 其余淡化。
5. **标签↔曲线**：端点标签按 y 排序、同色引线、折点避让，双向 hover 联动。
6. **聚焦内嵌成分表**：单系列聚焦时图表下方直接显示该小类成分 ETF 明细（可排序、CSV、分页）。

---

## v3.2.0 — 指标叠加、分类体系 v2、双口径并存

### 分类体系 v2（两层，可按口径切换）

- **大类 = 指数类别**（对标万得/中证）：宽基 / 行业 / 主题 / 策略风格 / 债券 / 跨境 / 商品。
- **小类 = 申万一级 24 个行业**（31 个一级行业里 24 个有 ETF 覆盖）+ 主题清单 + 规模/策略/债券/跨境细分，共 **72 小类 / 1903 只 ETF**，纳入率 **97.49%**。
- 归类依据逐条可追溯：`index_basic.category`（71.46% 命中）→ 申万名称映射 → 主题关键词 → v1 规则兜底；`src` 字段标注每条来源。
- 三处口径决定：境外宽基归「跨境」（对标万得）、金融地产入「主题」（申万无综合行业）、质量/基本面等因子指数入「策略风格」。
- 排除 49 只：货币型 30 + 主动管理 19（只披露业绩比较基准，不跟踪指数）。
- 旧口径完整保留：`site/data/legacy/` + `series_v2` 独立表，页面右上角一键切换。

### 单系列指标叠加

- 聚焦某小类后，可叠加规模 / 净流入 / 变化率；左轴金额、右轴百分比、净流入固定柱状并独占金额轴。
- URL 参数 `overlay=scale,flow,pct` 往返一致；切换 22–30ms。

### 工程

- `lib/universe.mjs` 双口径；`pipeline/payloads/aggregate` 全部按 universe 参数化；`rebuild` 一次算两套序列。
- 新增 `/api/legacy/*` 路由；构建输出双树（`site/data` 与 `site/data/legacy`）。
- v2 序列覆盖不足时自动回落 legacy，避免发布残缺数据。

---

## v3.1.0 — 全市场口径、更名 Ebbflow、服务异步化

### 数据

- **纳入深市**：深市 864 只 ETF 按「同跟踪指数 → 关键词规则 → 新增小类」三级归类，覆盖 98.94%（850 只可归类）；
  9 只主动管理 ETF 因只披露业绩比较基准、不跟踪指数，暂不归属（`data/universe.json` 可复现，方法见 `docs/CLASSIFICATION.md`）。
- **新增 2 个小类**（均在 1_宽基市场）：`创业板宽基`（50 只）、`海外宽基`（纳斯达克100/标普500/日经225/DAX 等 20 只）。
  合并后为 **88 个细分行业 / 1614 只 ETF**（沪 773 + 深 841）。
- **看板口径变为沪深合并**：`份额 = Σ 成分 ETF 份额`（深市同样计入），债券大类仍 ×100。
  原看板的 86 个细分行业 / 773 只沪市成分**冻结**在 `lib/taxonomy.mjs`，供回归校验使用
  （`npm run verify:origin` 改为按沪市子集重算后比对：95,389 点 99.83% 一致）。
- 明确排除：货币型 3 只、黄金现货 8 只、商品期货 3 只（不属于股票/债券 ETF 体系）。

### 品牌

- 项目更名为 **Ebbflow**（*ebb & flow*，潮起潮落 —— 资金在 ETF 里流入流出）。
- 作者昵称改为 **dreemetoo**（GitHub 仍 `li2396803`）；署名指纹更新为 `01965be232d20323`。
- 新 Logo：靛蓝渐变圆角 + 双波浪 + 薄荷色光点（`web/assets/logo.svg`，含 favicon）。
- 鸣谢补全链接：B 站 <https://space.bilibili.com/3546681834473583> ｜ GitHub <https://github.com/ysz-xiao>。
- 页面 meta 键名迁移到 `ebbflow:*`（保留 `etf-flow:*` 兼容旧版前端）。

### 架构

- **本地服务真异步**：`/api/*` 改为直接读取构站产物（首次请求 2.8s → 2~8ms），
  数据刷新改为**子进程**执行 —— 实测 22.6s 的更新期间 `/api/meta` 仍在 1~3ms 响应，事件循环不再被同步 SQLite/重算阻塞。
- 新模块 `lib/universe.mjs`：合并冻结的原看板口径与深市归属，pipeline / payloads / aggregate / validate / reconcile 全部走它。

### 修复

- 端点标签不再压住曲线右段；取消滚轮/拖拽隐式改区间（只保留预设、滑块、框选、双击复位）。
- `subs.json` 改为按需懒加载，首屏只加载 meta + market + 当前大类图表。
- 修正 CI 冷启动时「名录为空导致 Tushare 回补 0 只」与「市场聚合只覆盖沪市」的问题。

---

## v3.0.0 — 产品化重构（进行中）

状态：数据层与工程化已完成，前端重构在收尾；发布前会把本节整理成正式条目。

### 数据层

- **深市数据改由 Tushare 同步**：深交所官方接口只有「最新交易日」一份快照、无法回溯历史，
  已**移除对深交所接口的调用**（`update` 不再使用 `fetchSzseLatest`），深市份额与净值统一走 Tushare `fund_share` / `fund_nav`。
  数据源从「三源」收敛为**两源**：上交所（沪市官方口径）+ Tushare（深市唯一来源、沪市第二参照）。
  交叉校验相应从「三源」改为**沪市两口径比对**（交易所 vs Tushare），`data/quality.json` 的字段结构不变。
- **抓取限流与预算**（`lib/tushare.mjs`）：全局令牌桶 `TUSHARE_RPM`（默认 120 次/分钟，跨并发共享）、
  单次运行上限 `TUSHARE_MAX_CALLS_PER_RUN`（默认 800）、每日预算 `TUSHARE_DAILY_BUDGET`（默认 4000，
  计数持久化在 SQLite `meta` 的 `ts:calls:<日期>`）；超限**明确报错并停止**，重跑可断点续抓。
- **数据覆盖扩大**：回补范围从分类体系的 773 只扩大到**全部场内 ETF（沪深，约 1953 只）**；
  新增 `market` / `market_type` 两张聚合表与对应载荷 `market.json`（沪深两市合计 + 按基金类型）。
  分类体系（86 个小类 / 773 只沪市成分）的看板数值口径不变。
- **金额口径落库**：`series` 新增 `scale`（规模，亿元 = Σ 份额 × 当日净值）与 `flow`（净流入，亿元 = Σ Δ份额 × 当日净值）；
  净值来自 Tushare `fund_nav`，覆盖率约 96%，缺净值的成分不计入金额合计。
- **库结构演进式迁移**：`ALTER TABLE ... ADD COLUMN` / `CREATE TABLE IF NOT EXISTS`，打开旧库自动升级，不需要清库。
- **fork 安全**：`daily.yml` 第一步改为「检查 TUSHARE_TOKEN」，缺失时用 `::error::` 明确指出「fork 需自填密钥」
  并让 job 失败（不再静默降级）。

### 前端

- **完全重构**：多指标切换（份额 / 规模 / 净流入）、自选列表、图表拖动框选区间、移动端布局与交互重做。
- 取数仍为「静态优先、API 兜底」，同一份 `site/` 既能静态托管也能本地起服务。

### 开源工程化

- 新增社区文档：[`CONTRIBUTING.md`](CONTRIBUTING.md)、[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)、
  [`SECURITY.md`](SECURITY.md)、[`SUPPORT.md`](SUPPORT.md)。
- 新增 [`docs/`](docs/)：`ARCHITECTURE.md`（数据流与设计取舍）、`DATA.md`（口径与字段字典）、
  `FORK.md`（fork 后 6 步自建部署）、`DEVELOPING.md`（本地开发与改造指引）。
- 新增 GitHub 协作模板：Issue 模板（Bug / 功能 / **数据问题**）、PR 模板、`config.yml`、`FUNDING.yml`（默认不启用）。
- 新增零依赖自检 [`scripts/lint.mjs`](scripts/lint.mjs)：裸 `debugger`、明文 token、`.mjs` 语法、
  前端占位符、`site/` 入库白名单、`data/series.json` 交易日数。
- 新增 `.editorconfig`、`.nvmrc`（`22`）。

### 兼容性

- 看板口径、`data/series.json` 的结构（`dates` + `subs`）不变。
- `npm` 命令入口不变；`package.json` 的 `engines.node` 已是 `>=22.5`，并新增 `lint` 脚本。
- 旧库中残留的 `src='szse'` 行不再产生，但保留读取兼容，不影响任何展示数值。

## v2.1.0 — 开源、署名与去水印

### 变更

- **开源**：仓库协议定为 **MIT**（`LICENSE`），仓库转为 **public**。
- **署名**：新增 `NOTICE.md`（署名/来源/再分发说明）；README 顶部加入显眼的**鸣谢**与**免责声明**；页面页脚新增「鸣谢 / 免责声明 / 项目」三块卡片。
  - 鸣谢对象：**哔哩哔哩（B站）UP 主「生炸瓜」** 的《ETF 细分行业资金流向》看板 —— 分类体系、指标口径与看板形态的来源。
- **去水印**：移除整页平铺水印（`.page-wm`）、每张图表内的水印（`.wm`）与顶栏品牌字样；`site/` 产物与水印相关样式/文本均已清空。
- **隐性作者标识**（替代水印，见 `lib/signature.mjs`）：`<meta author/generator/etf-flow:signature/etf-flow:origin>`、HTML 注释、`application/ld+json`（含 `isBasedOn`）、`<html data-signature>`、`window.__ETFFLOW__` + 控制台 banner、`data/meta.json` 与 `data/signature.json` 的 `signature` 字段、HTTP 头 `X-Powered-By` / `X-Project-Author` / `X-Project-Signature`。
  - 指纹：`28e8c8d6199160a1`（`sha256("etf-flow:li2396803:<repo>")` 前 16 位，稳定）。
- **页脚数据**：新增「数据截至 / 交易日 / 覆盖」实时信息；顶栏右上角改为「⌥ 开源 · MIT」项目链接。
- `docs/screenshot.png` 更新为**无水印**版本；新增 `tools/README.md` 说明保留原看板副本的用途（回归校验 + 署名溯源，不参与渲染）。

### 兼容性

- 数据口径、命令、接口均无破坏性变更。

---

## v2.0.0 — 三源数据管道重构（进行中）

状态：三源管道、站点、服务、测试与 CI 均已落地；`npm test` 实测 10 个用例全过（约 0.8 s）。

### 新增

- **第三个数据源 Tushare Pro**（`lib/tushare.mjs`）：`fund_share` 取沪深两市每日份额（`fd_share`，万份、4 位小数），可按 `ts_code` 回溯；`fund_basic` 刷新名录。token 从 `TUSHARE_TOKEN` 环境变量或项目根 `.env` 读取。
- **SQLite 存储层**（`lib/db.mjs`，`node:sqlite`，零依赖，WAL）：表 `fund` / `share(code,date,wan,src)` / `series(sub,date,val)` / `reconcile` / `run` / `meta`。库文件 `data/etf.db` 作为**本地缓存**，已 gitignore。
- **来源优先级合并**（`lib/pipeline.mjs` + `putShares`）：同一 `code+date` 只保留一行，交易所（`sse`/`szse`，优先级 1）不会被 Tushare（`ts`，优先级 2）覆盖。
- **三源交叉校验**（`scripts/reconcile.mjs`）：逐只对比 + 小类层公共成分对比，分档 一致 / ≤0.1% / ≤1% / >1%，产出 `data/quality.json` 与 `reconcile` 表，退出码 0/1/2。
- **全量回补**（`scripts/backfill.mjs`）：`--source ts|sse|both`，支持断点续跑（`meta['bf:tsDone']`）、`--dry-run`、`--limit`、`--concurrency`。
- **回归校验**（`scripts/verify-origin.mjs`，`npm run verify:origin`）：用自建数据复算，与原站已发布序列逐点对比，结果写 `data/validation-origin.json`。
- **零依赖测试**（`tests/framework.mjs` + `tests/runner.mjs` + `tests/cases/*.mjs`）：7 个用例文件覆盖口径、DB 来源优先级、校验规则、序列连续性、数值范围、交叉校验分档。
- **站点载荷与前端源码分离**：`lib/payloads.mjs` 产出 `meta/charts/tables/subs/index/quality`，`lib/build/site.mjs` 把 `web/`（`index.html`/`app.js`/`styles.css`）拷进 `site/` 并写 `site/data/*.json`。前端取数**静态优先、`/api/*` 兜底**。
- **本地服务重构**（`server/app.mjs`）：`/api/meta|charts/:cat|tables|subs|sub/:name|index|quality|status`，`POST /api/refresh` 手动触发更新；默认绑定 `127.0.0.1:5188`。
- **GitHub Actions**：`daily.yml`（每工作日 UTC 08:30 增量更新 + SQLite 缓存 + 自动提交 `site/`）、`ci.yml`（push/PR 校验）、`pages.yml`（可选 Pages，仅手动触发）。
- **仓库工程化**：`.gitattributes`（统一 LF、二进制标记）、`docs/`、`CHANGELOG.md`、`LICENSE`（个人自用声明）。
  `.gitignore` 追加：`data/lastrun.json`、`data/etf.db*`、`site/data/`、`site/charts/`、`*.tmp`（后两项由 v2 站点产物约定引入，`site/data/` 属构建产物不入库）。

### 变化

- 口径不变：细分行业值 = 成分 ETF 当日份额之和 ÷ 1e4（亿份），大类 `9_债券` 再 ×100，内部 4 位小数、展示 1 位。
- `data/series.json` 从"权威数据"降级为 **v1 遗留**（主流程不再读写），权威数据改为 `data/etf.db` 的 `series` 表。
- 更新标记文件：`data/last-run.json` → **`data/lastrun.json`**（`bin/status.sh`、`bin/update.sh` 两个名字都兼容读取；两者都已 gitignore）。
- `bin/update.sh` 改为调 `npm run update`，全流程输出追加到 `.run/update.log`（超 2MB 自动截断）；对 launchd 的 `StandardOutPath` 做了去重，不会出现每行两遍。
- `bin/status.sh` 新增"数据库规模"一节（只读打开 `data/etf.db`，输出名录数 / 有份额代码数 / 交易日区间 / 原始行数 / 派生行数）。
- 脚本里的 Node 版本要求由 ≥ 20 调整为 **≥ 22.5**（`node:sqlite`）。
- v1 的 `npm run seed`、`npm run verify`（`tools/diff-site.mjs`）连同 `lib/{store,template,build}.mjs`、`scripts/seed.mjs`、`tools/diff-site.mjs` 等文件一并移除；回归对比改由 `npm run verify:origin` 承担。

### 已知缺口

- `lib/aggregate.mjs`、`data/series.json`、`data/shares/` 仍为 v1 遗留，主流程不再使用（后者仅作历史留档）。
- 分类体系 773 只成分全为沪市代码，深交所数据暂不参与看板数值。
- `site/data/` 不入库（构建产物），仓库自带的 `site/` 无法直接静态托管，需要先 `npm run build`。
- `package.json` 的 `engines.node` 仍写着 `>=20`，实际需要 ≥ 22.5（`node:sqlite`）。

## v1.x — 双源本地版

- 上交所（可按 `STAT_DATE` 回溯）+ 深交所（仅最新快照）双源，`data/series.json` 存序列，`data/shares/<date>.json` 存每日原始快照。
- 首次播种从 `tools/original-charts/*.js`（原站发布的图表数据副本）取 5 年历史，`data/c3-seed.json` 保留原站 c3 百分比以维持短期曲线精度。
- 页面由 `lib/template.mjs` 生成 `site/index.html` + `site/charts/<大类>.js`（按需动态加载）。
- macOS LaunchAgent：登录自启服务（KeepAlive）+ 每工作日 16:10 定时更新。
