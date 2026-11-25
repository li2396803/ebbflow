# 更新日志

本文件记录对仓库结构、数据口径、命令有影响的变化。日常数据更新（`chore(data): 自动更新站点数据`）不记录。

## v3.11.0 — 数据管线加固：把「安静出错」变成「显式失败」

这一版没有新功能，全部是**正确性与可运维性**。起因是 11-24 的事故：深市整天缺失，站点上表现为
「大盘宽基一天跌 17.8%」，而所有任务都显示成功。

### 修掉的真 bug

- **口径不一致（影响历史数值）**：旧 `recomputeAll` 只在 subs 路径按「有官方标记就只认官方行」过滤，
  market / market_type / flow 不过滤，且官方只抓回一半时兜底行会被丢掉。
  实测旧规则在现库上**少算 748 个 (小类×日)，全部偏小，最大差 4811.97 亿份**
  （例：`环保与碳中和 2021-11-26` 旧 66.97 / 正确 113.90）。
  现在四条路径共用一份有效行集合，flow 前值同口径。修复后 series 值 **0 变化**（健康日判据等价），
  market `ALL` −0.073%（口径统一的正确代价），`etfs` 1743 → 1719。
- **死代码**：`update.mjs` 闸门里调用 `szseWrite` 早于其 `const` 定义 → `ReferenceError` 被空 `catch{}` 吞掉，
  **深交所自愈路径从未生效过**。
- **Tushare 半成品当完整**：探针原来 `if (m.size)` 会把「1 行」当 anchor 写库并进时间轴；
  现在要求 `≥ max(500, 近 20 日中位数×0.6)`，未出齐不写库、不标记、不设 anchor。

### 新增的防线

- **市场完整性闸门**：进入时间轴的每一天，沪/深覆盖须落在「近 20 个交易日中位数 × [0.6, 2]」，
  残缺日不进轴 + 显式告警 + 自动修复（Tushare 全天 → 深交所历史接口）。
- **可疑跳变归因**：`data/quality.json` 新增 `jumps`，按 split / coverage / caliber / listing /
  constituent-new / small-base / unknown 归因；168 处跳变中 `unknown` 由 79 降到 59。
- **数值自洽首次被证明**：小类 Σ 成分 = 小类值（legacy 100,295 / v2 83,796 点 maxΔ=0），
  全市场 = 沪 + 深（1,214 天）。
- **离线审计** `npm run audit`（`scripts/audit-data.mjs`，6 组 12 项，违规非零退出）接入 CI 与每日流程。
- **生成物冲突自愈** `npm run repair`（`--check` / `--fix`）：`data/series.json` 从库重建、
  `quality.json` 写合法占位，不再把 `<<<<<<<` 提交进仓库（这种事真的发生过）。
- 更新锁抽成 `lib/lock.mjs`（pid 存活 / 旧格式 / 超时，可单测），`openDb` 加 `busy_timeout=5000`。
- `run.stats` 记录各源耗时/行数/覆盖率、闸门结果、mixedDays、告警。

### 测试

`node tests/runner.mjs` → **29 passed / 0 failed**（原 16 + 新增 13 个不变量用例）。

### 已知风险（写在文档里，不粉饰）

「相对中位数」闸门对**连续多日缓慢退化**不敏感——覆盖每天掉 3–5% 时中位数会跟着下移。
根治需要交易所官方目录数作为绝对锚，目前没有这个数据源。

---

## v3.10.2 — 数据完整性闸门；深交所抓取失败的兜底；更新提前到 23:00

**这一版修的是「会安静地出错」的问题。**

- **完整性闸门**：某天只有沪市、深市几乎为空时，不再让它进时间轴。
  之前 11-24 深交所快照抓取失败（GitHub runner 上 `fetch failed`），当天只剩沪市，
  「大盘宽基」直接从 496.4 掉到 408（−17.8%）——数据缺失被显示成了资金流出。
- **缺口自愈**：缺口日先用 Tushare 全天补齐（1 次请求、最稳），再退到深交所历史区间接口；
  补完仍不足则当天不进轴，等下次运行。
- **深交所兜底**：快照失败自动改走 `scsj_fund_jjgm` 历史接口（同一份数据的另一个入口）。
- **定时**：主抓改 **23:00（北京）**——此时两家交易所当日数据都已挂出；次日 08:00 保留一次收尾，
  补齐晚间没抓全的（尤其是净值和深市）。

---

## v3.10.1 — 按需实时报价上线

- 成分表「收盘价」列在拿到实时报价后变为**「最新价」**：深市标 `● 实时`，沪市标最近收盘日期。
- 只在本地服务（端口 5188 / `?api=1` / `<meta name="ebbflow-api">`）启用；静态托管下 0 请求、0 报错，列头维持「收盘价」。
- 60 秒缓存 + in-flight 去重，同一个小类重复打开不会重复请求；最多 40 只/次。

---

## v3.10.0 — 交易所优先取数；按需实时报价；发布时刻实测

### 取数

- **深交所快照回归**（`ShowReport/data`，CATALOGID=1105）：当日约 21:00 就有最新报告日，日常增量足够。
  另外发现深交所还有**历史区间接口**（`CATALOGID=scsj_fund_jjgm` + `txtStart/txtEnd`，可回溯到 2021），
  后续可用它把深市历史也换成官方口径。
- 沪市仍走上交所 `commonQuery.do`（`STAT_DATE` 可回溯任意交易日）。
- Tushare 只做：净值（规模/净申购的唯一来源）、名录、行情、缺口补齐与交叉校验。
- 名称仍以 Tushare 名录为准；交易所名称只在**名录尚未收录**时补空缺（不做"择优"）。

### 定时（按发布时刻）

- 上交所 **T+1 日 08:00** 发布 → 主抓：周一~周六 08:00（北京），周一那次专门接周五的数据。
- 深交所当日 21:00 有快照 → 预取：工作日 22:00（北京）。
- 新增 `scripts/probe-publish.mjs`：每次运行记录两家交易所「哪些交易日已可见」，写入 `data/publish-log.json`，
  用来实测发布时刻（尤其周五 → 周一的情形），跑一周就能给出准确时间表。

### 新功能

- `GET /api/quote?codes=159915,510300`：**按需实时报价**（最多 40 个代码）。
  深市走交易所官方接口（实时）；沪市官方实时接口不对公网开放，回落最近收盘价并标记 `realtime=false`。

---

## v3.9.2 — Windows 兼容性修复（首次启动 / 更新静默退出 / 离线构建）

来自一份 Windows 11 用户的 Bug 报告，四个根因都是平台假设：

1. **入口判断在 Windows 永远为假**：`import.meta.url === "file://" + process.argv[1]`，
   Windows 的 `F:\…\update.mjs` 与 `file:///F:/…/update.mjs` 永不相等，
   于是 `npm run update` **静默退出 0**、不写 `data/lastrun.json`，服务随后读标记文件报 `ENOENT`。
   统一改用 `lib/cli.mjs` 的 `isMain()`（`pathToFileURL(resolve(argv[1]))`），覆盖 build / update / backfill / reconcile / verify-origin。
2. **项目根目录**：`new URL(import.meta.url).pathname` 在 Windows 得到 `/F:/…`，改用 `projectRoot()`（`fileURLToPath`）。
3. **前端构建**：`execFileSync("npx", …)` 在 Windows 找不到 `npx`（需 `npx.cmd`）。
   改用 `runLocalBin()`：优先 `node_modules/.bin/vite(.cmd)`，回退 `npx(.cmd)`，Windows 自动 `shell: true`，含空格路径加引号。
4. **空库接口 500**：`lib/payloads.mjs` 从空日期数组取末值，把 `undefined` 绑定给 SQLite。
   已加空库短路与 `covered()` 防护，`meta` 新增 `initialized` 标记。

顺带修的：

- `SKIP_VITE=1` 现在是真正的「只重建数据」：不碰前端产物、不触发布局断言（离线构建场景）。
- 更新锁记录 PID：持有进程已死或旧格式锁会自动清理；被锁跳过时**显式打印原因**，不再静默 0 退出。
- 服务端在跳过更新时不再读不存在的 `lastrun.json`（此前把「跳过」误报成「失败」）。
- 静态目录包含判断改用 `path.relative`，`readData()` 增加目录逃逸校验（此前 `/api/legacy/../..` 可读到仓库文件）。
- `.env` 与若干 JSON 读取容忍 UTF-8 BOM。
- 新增 `docs/WINDOWS.md`（前置、三步开始、后台运行、任务计划程序、10 条报错对照、平台差异）。
- CI 新增 **windows-smoke** job：`npm ci` + 测试 + lint + `SKIP_VITE=1` 离线构建 + 入口判断回归。

---

## v3.9.1 — 默认视角调整

- **默认区间改为「近一年」**：新访客第一眼看到 243 个交易日，而不是 24 个，趋势更完整。
- **图表默认「叠加」布局**：多指标时一张图多条独立坐标轴；想逐项看清各指标的独立刻度，一键切「分面」。
- 其它：README 引言重写（少一点说明文，多一点"它在干什么"），站点 description 同步。

---

## v3.9.0 — 前端架构升级：Vite 构建、ECharts 按需、PWA 与渐进增强

依赖不再是零（用户批准）：新增 `vite`、`typescript`、`echarts@5.5.0`（与线上副本同版本）。

### 构建

- **Vite 构建**：ES2019 目标、`base: "./"`（Pages 子路径可用）、产物内容哈希、ECharts 独立 chunk。
  应用 JS 从 8 个请求合并为 1 个（336KB → 51KB gzip），CSS 4 → 1。
- **ECharts 按需构建**：`web/js/vendor-echarts.js` 只注册 line/bar 与用到的组件，
  1.0MB → 568KB 原始、330KB → **175KB**（brotli）。
- `chart.js` 改为动态 `import()` 加载瘦身版，失败回退注入 `echarts.min.js`。
- 构建后给 ECharts chunk 注入 `modulepreload`，并清理 `site/assets` 里过期哈希文件（此前会导致重复下载 190KB）。

### PWA

- `web/public/sw.js`：应用壳预缓存 13 项、`data/*.json` stale-while-revalidate、`data/archive/*` cache-first、
  旧 cache 自动清理；`skipWaiting` 仅在用户点击「新版本已就绪」后触发。
- `manifest.webmanifest` + 192/512/maskable 图标；本地默认不注册（`?sw=1` 启用）。
- 离线时顶部徽标显示「离线（缓存）」，恢复联网自动还原。

### 渐进增强

- **View Transitions** 包裹视图切换（`prefers-reduced-motion` 时跳过）。
- **Speculation Rules**：同源内链 prerender/prefetch。
- **Web Worker** 解析大于 64KB 的 JSON（`subs.json` 约 950KB），失败或超时 5s 回退主线程。
- 长表格 `content-visibility: auto`。

### 类型

- `jsconfig.json` + `globals.d.ts`；`util / ui / chart / views / main` 五个模块开启 `// @ts-check` 并补 JSDoc，`npm run typecheck` 0 error。

### 实测（1.6 Mbps / 150 ms RTT）

| 指标 | v3.8 | v3.9 |
|---|---|---|
| 首屏首个图表 | 3.03 s | **1.79 s** |
| 复访首个图表 | 0.62 s | **0.45 s** |
| ECharts 传输 | 330 KB | **175 KB** |
| 应用 JS 请求数 | 8 | **1** |

---

## v3.8.0 — 大类配色、走势满格、对比预选、加载再优化

### 界面

- **大类配色重做**：7 大类改为色相均分的强分离配色（橙/蓝/紫/绿/青/玫红/橄榄），两两最小 ΔE 30.3 → 33.8，白底对比均 ≥3.0。
- **修复大类圆点同色**：侧栏与卡片圆点原本取「首位小类色」，导致 7 个大类全是同一个蓝；改为统一以 `meta.categories` 为准。
- **走势 sparkline 满格**：SVG 从固定 76px 改为填满单元格（实测 277/285px，左右各留 4px），`non-scaling-stroke` 保证线宽不随拉伸变粗；表格改自动布局，名称列 150px、数值列按内容、走势列吃剩余。
- **对比默认预选**：聚焦某小类时打开对比面板自动勾选当前小类；大类视图则预选该类规模最大的小类；URL 已带 `compare=` 时以 URL 为准。
- 对比面板：已选 chip 加与曲线同色圆点，选项右侧显示当前规模。

### 加载

- 本地服务支持 **brotli**（br 优先、gzip 回退）：echarts 334→310KB、subs 212KB。
- 构建注入 **modulepreload**，消除 ESM 串行发现的请求瀑布。
- 修复 `subs.__dates` 被当成小类混入列表/搜索/对比面板。

---

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
