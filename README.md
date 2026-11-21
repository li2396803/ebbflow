# ETF 细分行业资金流向 · 开源版

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen.svg)](package.json)
[![Daily Data](https://github.com/li2396803/etf-flow/actions/workflows/daily.yml/badge.svg)](https://github.com/li2396803/etf-flow/actions/workflows/daily.yml)
[![站点](https://img.shields.io/badge/online-li2396803.github.io%2Fetf--flow-1f6feb.svg)](https://li2396803.github.io/etf-flow/)

> **鸣谢｜本项目复刻自 B 站 UP 主「生炸瓜」的《ETF 细分行业资金流向》看板。**
> 9 大类 / 86 个细分行业的分类体系、「份额＝成分 ETF 之和、债券 ×100」的口径、以及看板的整体形态，都源自
> **哔哩哔哩（B站）UP 主「生炸瓜」** 的公开作品 —— 原看板的设计与制作成果归原作者所有，**没有原作就没有这个项目**。
> 这里的代码（抓取 / 存储 / 校验 / API / 前端 / CI）是独立重写的；本站与原作者无隶属、无背书关系。
> 喜欢这个看板请先去 B 站关注原作者。
>
> **免责声明｜不构成任何投资建议。** 数据来自上交所公开接口与 Tushare Pro（深市经 Tushare），可能延迟、缺失或出错；
> 「规模」「净流入」是按单位净值折算的估算值。仅供研究与技术学习，任何人据此决策风险自负。
>
> **在线站点** <https://li2396803.github.io/etf-flow/> ｜ 协议 **MIT** ｜ 仓库 <https://github.com/li2396803/etf-flow> ｜ 署名与溯源详见 [`NOTICE.md`](NOTICE.md)

一句话：把「ETF 份额（资金流向）看板」搬到自己机器上 —— 每天从**上交所 + Tushare** 两处取沪深 ETF 每日份额与净值，落进本地 SQLite，重算 **86 个细分行业 / 10 个大类**的份额序列，生成本地静态站点，并提供本地 HTTP 服务随时打开看。

- 零第三方依赖（`dependencies` 为空），只要 Node.js（需要内置 `node:sqlite`）
- 数据、库、站点、服务全在本机，不上传、不外传
- 支持三种更新入口：本地 launchd 定时、GitHub Actions 定时、服务自检自动刷新
- 双口径交叉校验：沪市以交易所官方披露为基准、Tushare 作第二来源，分歧会落到 `data/quality.json`

> 本项目是对公开看板的开源复刻，**与原站及其作者无隶属关系**（但明确鸣谢原作者）；数据仅供参考、**不构成任何投资建议**。详见文末「免责声明」与 [`NOTICE.md`](NOTICE.md)。

![全市场总览](docs/screenshot.png)

![大类走势](docs/screenshot-cat.png)

（截图来自本机 2026-11-21 实跑，1440 宽 @2x；上图为「全市场总览」，下图为「3.科技」大类视图）

---

## 界面功能

一条时间轴贯穿全站：**区间一变，KPI、图表、表格、抽屉全部联动**，并写进 URL，复制链接即可分享同一视图。

### 全市场总览
- 四个核心 KPI：全市场份额 / 规模、区间份额变化、区间净流入（逐日净流入累加，口径见悬浮说明）。
- 沪深两市 ETF 规模走势（沪 / 深 / 合计），可切「规模 ↔ 份额」；右侧是按基金类型的规模分布。
- 10 大类区间表现卡片：涨跌幅、份额变化、区间走势迷你图，点一下进入该类。
- 区间份额增加 / 减少 TOP 8，可排序、一键复制、导出 CSV。
- 已收藏的自选会固定出现在总览底部。

### 大类走势
- 8 个固定区间（近 1 月 / 3 月 / 6 月 / 1 年 / 3 年 / 5 年 / 年初至今 / 全部）+ 自定义区间。
- 四种指标：份额（亿份）、规模（亿元）、净流入（亿元/日，正红负绿）、变化率（相对区间起点或全历史）。
- 1212 个交易日的手感：滚轮缩放、拖拽平移、双击复位、底部滑块；**框选一段区间**即同步全站。
- 图例点击聚焦某个细分行业；hover 自动淡化其它线；端点标签跟随窗口末端、自动避让不重叠。
- **对数坐标**一键切换：当各小类量级差 100 倍以上时（例如半导体 vs 消费电子），线性轴会把小系列压扁。
- **对比模式**：任选 2 个小类，归一化到区间起点 = 100（净流入则比区间累计），一眼看出强弱分化。

### 我的自选
- 任意小类都能加星（导航、表格、搜索结果、详情抽屉都能点）。
- 自选页给出合计份额 / 规模 / 区间变化，以及每个小类的迷你走势卡。
- 只保存在本机 localStorage，不上传任何数据。

### 搜索与明细
- ⌘K / Ctrl+K 或 `/` 唤起命令面板：支持小类中文名、**拼音首字母模糊匹配**（`bdxt` → 半导体芯片）、ETF 代码或名称。
- 上下键选择、Enter 打开、Esc 关闭。
- 小类详情抽屉：区间表现（含 86 类中的排名）、自身走势小图、成分 ETF 表（代码/名称/市场/份额/变化/净值/规模/净流入/占本类比例，可排序）、两套 CSV 导出。

### 其它
- 深色 / 浅色 / 跟随系统三态主题，手动切换会记住。
- 色盲友好配色（蓝涨橙跌）、减少动效开关。
- 「全部 86 个小类」总表：搜索、只看净流入/净流出、按份额或金额口径、排序、CSV。
- 数据质量面板：三源交叉校验的一致率、差异天数、逐日差异样例，可下载原始 JSON。
- 移动端：底部 tab + 全屏抽屉，图表支持双指缩放，提示文案自动切换。

---

## 1. 快速开始（三步）

前提：Node.js ≥ 22.5（`node:sqlite` 需要；本文档在 **Node v26.13.0** 上验证，未在 22.x 上实测）。

```bash
# ① 克隆
git clone https://github.com/li2396803/etf-flow.git
cd etf-flow

# ② 填 token（.env 已在 .gitignore 里，不会被提交）
cp .env.example .env
#    编辑 .env，把 TUSHARE_TOKEN=your_token_here 换成真 token
#    token 获取：https://tushare.pro/user/token

# ③ 起服务
npm start        # → http://localhost:5188
```

第一次打开是**空库**，需要先把数据灌进来（二选一）：

| 方式 | 命令 | 联网 | 说明 |
| --- | --- | --- | --- |
| 全量回补 | `npm run backfill` | ✅ | 按 `ALL_CODES` 逐只抓 Tushare + 逐日抓上交所，建 5 年历史（默认从 `2021-11-22` 起，参数见 §4） |
| 只跑增量 | `npm run update` | ✅ | 只有最近 15 个交易日 + 当日；历史很短，适合先看效果 |

> 如果你从别的机器拷了 `data/etf.db` 过来，直接 `npm start` 就行，无需回补 —— 这个库是唯一需要继承的本地状态。

服务默认只监听 `127.0.0.1`（本机回环），不对外网开放。

---

## 2. 数据来源与口径

### 2.1 三个数据源

| 来源 | 接口 | 给的是什么 | 能回溯历史吗 | 本项目怎么用 |
| --- | --- | --- | --- | --- |
| **上交所** | `GET query.sse.com.cn/commonQuery.do`，`sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L`，参数 `STAT_DATE=YYYY-MM-DD`（字段 `TOT_VOL`，**万份**） | 该交易日**沪市全部 ETF** 的基金份额 | **能**，按日期回溯任意历史交易日；非交易日返回空（代码里当 `null` 跳过） | 主数据源：看板 773 只成分 ETF **全部是沪市代码**，日常近 15 日增量 + 可选全量回补都靠它 |
| ~~深交所~~ | 已弃用 | 官方 ShowReport 只有"最新交易日"快照、无历史 | 不能 | v3 起深市数据**统一由 Tushare 提供**（`fund_share` 可按 `ts_code` 回溯），代码中已无调用点 |
| **Tushare Pro** | `fund_share`：`ts_code` 单只（配 `start_date`/`end_date`）或全市场（配 `trade_date`），字段 `fd_share`，**万份、4 位小数** | **沪深两市**每日份额 | **能**，可回溯（`fund_share` 一般能查到 5 年以上，具体受账号积分影响） | ① 深市历史的**唯一**可回溯来源 ② 沪市补缺 ③ 交叉校验的高精度参照 |

上交所一次请求带 `pageHelp.pageSize=2000` 并自动取回全量（带 UA 与 Referer，不加会被拒）。Tushare 侧有**全局令牌桶 + 单次/每日预算**（`TUSHARE_RPM=120`、`TUSHARE_MAX_CALLS_PER_RUN=800`、`TUSHARE_DAILY_BUDGET=4000`），日常增量只需 2 次调用（`fund_share`/`fund_nav` 各按交易日取全市场）。

### 2.2 口径与公式

细分行业的当日值，就是它名下所有 ETF 当日份额之和：

```
细分行业值(亿份) = Σ 成分 ETF 当日份额(万份) ÷ 1e4
大类「9.债券」  = 上面的值 × 100          # 债券 ETF 面值 100 元/份，跟随原站折算口径
内部精度：round 到 4 位小数（series.val）；前端展示取 1 位
```

- 单位是**份（亿份）**，不是金额。份额变化 ≠ 资金净流入：严格说「份额变化 × 净值」才近似资金流，本项目只做份额这一层（与看板的原始口径一致）。
- 成分股名单固定在 `lib/taxonomy.mjs`：**10 个大类 / 86 个细分行业 / 773 只 ETF**（数量由 `Object.keys(SUB).length` 等算出，不是抄来的）。
- **为什么债券要 ×100**：债券 ETF 面值是 100 元/份，而股票 ETF 通常 1 元/份。不折算的话债券大类的"亿份"和其他大类不可比，×100 后各列的数量级才对齐（原站就是这么做的）。

### 2.3 来源优先级

`lib/db.mjs` 里 `src` 有三个取值：`sse` / `szse` / `ts`（`szse` 为历史遗留，新数据不再产生）。**同一 `code + date` 只保留一行**，写入时按优先级裁决：

| 来源 | 优先级 | 理由 |
| --- | --- | --- |
| `sse`、`szse` | 1（最高） | 交易所官方披露口径 |
| `ts` | 2 | 第三方加工数据，用于补缺与校验 |

低优先级来源**不会覆盖**已存在的高优先级数据；同来源重抓则更新数值（幂等覆盖）。所以"先写 Tushare、再抓到交易所"的顺序也是安全的 —— 交易所数据会盖上去，反之不会。

---

## 3. 架构

```
        上交所 commonQuery（逐日，可回溯）
        Tushare fund_nav  （按日取全市场净值）
        Tushare fund_share（逐只/逐日，可回溯）
                   │
                   │  lib/sources.mjs / lib/tushare.mjs（UA/Referer/重试/限并发）
                   ▼
          lib/pipeline.mjs  合并（按 code+date 取最高优先级）
                   │
                   ▼
   lib/db.mjs → data/etf.db  (SQLite, node:sqlite, WAL)
     fund     名录        share     原始份额（code,date,wan,src）
     series   派生序列    reconcile 交叉校验明细
     run      运行记录    meta      零碎状态
                   │
       ┌───────────┴────────────┐
       ▼                        ▼
 lib/payloads.mjs          scripts/reconcile.mjs
 派生载荷（meta/charts/     双口径交叉校验
 tables/subs/index/quality）    │
       │                        ▼
       ▼                  data/quality.json
 lib/build/site.mjs        （+ reconcile 表）
 拷贝 web/ → site/，
 写 site/data/*.json
       │
   ┌───┴────────────────────┐
   ▼                        ▼
 静态托管                server.mjs（/api/*）
 （file:// 直接打开       本地服务，默认 127.0.0.1:5188
   或任意静态服务器）     前端「静态优先、API 兜底」
```

前端（`web/app.js`）的取数策略是**静态优先**：先 fetch 同目录 `data/*.json`，失败才回退 `/api/*`。所以同一份 `site/` 既能本地起服务看，也能扔到任意静态托管（含 GitHub Pages）上只读浏览。

`data/etf.db` 是**本地缓存**：不进 git，可由「原始快照 + 接口」重建（backfill / update 见 §4）。

---

## 4. 命令参考

| 命令 | 干什么 | 联网 | 耗时 | 本次核对 |
| --- | --- | --- | --- | --- |
| `npm start` | 起本地服务（默认 5188；`PORT=8080 npm start` 换端口；加 `--no-refresh` 关掉自动刷新） | 按需* | 秒级启动 | ✅ 服务在跑（`/api/status` 可访问） |
| `npm run update` | 增量更新：Tushare 当日全市场（份额+净值） + 上交所近 15 日 → 重算 → 构站 | ✅ | 本机最近一次记录 **13.9 s**（`data/lastrun.json` 的 `ms`） | ⚠️ 未由本文档复跑（记录来自本机既有运行） |
| `npm run build` | 只用本地 `data/etf.db` 重建 `site/`，不碰网络。库为空会**退出码 1** 并提示先回补 | ❌ | 秒级 | ⚠️ 未复跑（会改写 `site/`，属他人工作区） |
| `npm run backfill` | 全量回补历史。参数：`--from 2021-11-22` `--to today` `--source ts\|sse\|both` `--limit N` `--dry-run` `--concurrency 6` `--no-resume` `--help` | ✅ | 取决于区间与积分限速（未计时） | ⚠️ 未复跑 |
| `npm run reconcile` | 双口径交叉校验（沪市交易所 vs Tushare），写 `data/quality.json` + `reconcile` 表。参数：`--days 30` `--date YYYY-MM-DD` `--tol 1` `--quiet` `--no-write` `--out file`；退出码 0/1/2 | ✅（现抓 Tushare） | 未计时 | ✅ `--help` 实测（输出即上表参数） |
| `npm test` | 数据校验测试（`node tests/runner.mjs`，用例在 `tests/cases/*.mjs`：口径、DB 优先级、校验规则、序列连续性、数值范围、交叉校验） | ❌ | 约 0.8 s | ✅ 实测通过：`10 passed, 0 failed, 0 skipped（760ms）` |
| `npm run verify:origin` | 回归校验：用自己抓的数复算，与原站已发布序列逐点对比（参数 `--json out.json`，默认写 `data/validation-origin.json`） | ❌ | 未计时 | ⚠️ 脚本存在，未复跑 |
| `bin/start.sh` / `bin/stop.sh` / `bin/status.sh` | 后台起服务 / 优雅停 / 一屏状态（含库规模） | ❌ | — | ✅ `status.sh` 实测 |
| `bin/update.sh` | 调 `npm run update`，带锁 + 失败重试一次 + 摘要，日志进 `.run/update.log` | ✅ | 同上 | ✅ `bash -n` 通过（未实跑，避免打断他人更新） |
| `bin/install-autostart.sh [--dry-run]` | 装/校验 launchd 任务 | ❌ | — | ✅ `--dry-run` 可用（未真装） |
| `bin/uninstall-autostart.sh` | 卸载两个 launchd 任务 | ❌ | — | ✅ `bash -n` 通过 |

\* `npm start`：服务启动后按"是否过期"决定要不要自动跑一次增量更新（工作日收盘后 / 数据超过 30 分钟未更新等条件，见 `server/app.mjs` 的 `isStale()`），所以它**可能**联网。

---

## 5. 自动更新：本机 launchd 与 GitHub Actions

两条线**互相独立、都幂等**，可以只开一条，也可以都开。

### 5.1 GitHub Actions（仓库替你跑）

| 工作流 | 触发 | 干什么 |
| --- | --- | --- |
| `daily.yml` | 每工作日 UTC 08:30（≈ 北京 16:30）+ 手动（可填 `lookback`） | 校验 `TUSHARE_TOKEN`（fork 未配置直接失败）→ 恢复 SQLite 缓存 → 增量更新 → `npm test` → 提交数据快照 → 部署 Pages |
| `ci.yml` | push 任意分支、PR | `npm test` → 离线 `npm run build`（有库才跑）→ 校验 `site/data/meta.json` 的 `lastTradeDate` 非空 → `site/` 与重建结果不一致只告警 |
| `pages.yml` | **仅手动** | 把 `site/` 发布到 GitHub Pages（默认不启用，见下） |

几个必须知道的点：

- **`TUSHARE_TOKEN` 必须作为仓库 Secret 注入**：`Settings → Secrets and variables → Actions → New repository secret`，名字就叫 `TUSHARE_TOKEN`。没注入时更新仍能跑，但深市历史/校验会缺失，日志里会给一条 warning。
- **SQLite 怎么跨 run 传递**：`data/etf.db` 不进 git，用 `actions/cache` 存。key 是 `etf-db-${{ github.run_id }}`（每次都是新 key，cache 不可覆盖），`restore-keys: etf-db-` 前缀回退到最近一次；保存前先 `PRAGMA wal_checkpoint(TRUNCATE)`，否则 WAL 里的最新事务会随缓存丢失。
- **提交范围**：`site`（其中 `site/data/` 与 `site/charts/` 已在 `.gitignore` 里，属于构建产物不进库）+ `data/quality.json`、`data/series.json`。`data/etf.db`、`data/shares/`、`data/lastrun.json` 同样被忽略。
- ⚠️ 因为 `site/data/` 入库这件事由 `.gitignore` 决定（当前**不入库**），`daily` 的自动提交实际上只会在前端产物（`site/index.html` 等）有变化时产生提交；想让仓库自带的 `site/` 直接可静态托管（含 GitHub Pages），需要把 `.gitignore` 里的 `site/data/` 去掉。
- **失败即失败**：`npm run update` 失败、被互斥锁跳过、`npm test` 失败，都会让 job 变红，不会"什么都没更新却提交一次空 diff"。
- **自动提交不会递归触发 workflow**：GitHub 用 `GITHUB_TOKEN` 产生的 push 事件不会再触发新的 workflow run。
- 定时任务在整点/半点附近排队严重，实际触发比 16:30 晚几分钟到几十分钟是正常的。

### 5.2 本机 launchd（macOS）

```bash
bin/install-autostart.sh --dry-run   # 只渲染模板 + plutil 校验，不动系统
bin/install-autostart.sh             # 真装（会占 5188 端口）
bin/status.sh                        # 看任务是否已加载
bin/uninstall-autostart.sh           # 卸载
```

装两个 LaunchAgent：

- `com.etfflow.server`：登录即启动服务，`KeepAlive`，挂了自动拉起
- `com.etfflow.daily`：每个工作日 **16:10** 跑 `bin/update.sh` → `npm run update`，日志 `.run/update.log`

launchd 的默认 PATH 只有 `/usr/bin:/bin:...`，找不到 Homebrew/nvm 的 node；安装脚本会把当前 node 的绝对路径和所在目录写进 plist 的 PATH 与 `ProgramArguments`，所以自启能稳定找到 node。**换了 node 版本或安装位置后要重跑一次安装脚本。**

`bin/update.sh` 的行为：`mkdir` 锁（`.run/update.lock`，死进程的残留锁会自动清）→ 调 `npm run update` → 失败**重试一次** → 打印摘要 → 全流程输出写进 `.run/update.log`（文件超 2MB 自动截断到最近 500 行）。注意 `data/.update.lock` 是 `scripts/update.mjs` 自己的进程内锁，两层锁是分开的。

### 5.3 两者关系

- 都跑同一条 `update` 流程，同一天重复跑只是把同一行数据覆盖成同样的值（幂等），不会造出假数据。
- 想**以谁为准**都行：只开 Actions（本地不开机也能留档）、只开 launchd（不依赖 GitHub）、或两者都开（互相当备份）。真同时跑到同一秒，各自的锁会让其中一个跳过，不会写坏库。
- 两边都会改 `site/`：Actions 提交的是它自己那份构建产物；本地那份改动会出现在 `git status` 里，冲突时以你手动提交的为准。

---

## 5.2 云端产物

`daily.yml` 每次跑完会把构建好的 `site/`（含 `data/*.json`）上传为 **Actions 产物**，在 Actions 运行详情页底部下载 zip 即可离线打开，或拖到任意静态托管。这也回答了"网站要不要一起搬上去"：仓库里放的是**源码 + 数据 + 构建脚本**，成品每次由 CI 产出，不把 4MB 的生成物反复塞进 git 历史。

> **关于每日提交**：只要 `data/quality.json`（含生成时间戳）或 `data/series.json`（数据变了）有变化，`daily.yml` 就会产生一次 `chore(data): 自动更新站点数据` 提交 —— 等于给数据留一条**每日快照 + 校验记录**，周末不跑，一年约 250 条，属于预期行为，不是噪音。

## 6. 数据校验（双口径交叉校验）

```bash
npm run reconcile                      # 最近 30 个交易日，容差 1%
npm run reconcile -- --days 60         # 往回看 60 个交易日
npm run reconcile -- --date 2026-11-20 # 只查某一天
npm run reconcile -- --no-write        # 只看结果，不写库/不写文件
```

它做三件事：

1. **逐只比**：把同一交易日「交易所侧（`src=sse`，`szse` 为历史遗留）」与「Tushare 侧（现抓 `shareOnDate`，拿不到才用库里的 `ts` 行）」的同 code 数值对比，按相对差分档：完全一致 / ≤0.1% / ≤1% / >1%。
2. **小类层再比**：分别用两侧份额重算 86 个小类，但**只用两侧都有值的公共成分**（`covered`），避免把"覆盖率差异"误判成"数值分歧"；同时比较方向（涨/跌）并指出哪边偏离。
3. **落盘**：先清空 `reconcile` 表（最多留 5000 行明细）再写入，并写 `data/quality.json`。

**退出码**：`0` 都在容差内；`1` 存在 >1% 分歧；`2` 无法校验（无交易日 / Tushare 不可用）。

### 怎么读 `data/quality.json`

顶层三个键：`generatedAt`、`days[]`（逐日明细）、`summary`（汇总）。

| 字段 | 含义 |
| --- | --- |
| `summary.range` | `[起始日, 结束日]` |
| `summary.compared` | 逐只比对计数：`both` / `identical` / `le0_1` / `le1` / `gt1` / `onlyExchange` / `onlyTs` / `detailCapped` |
| `summary.rates` | 各档占 `both` 的比例 |
| `summary.subs` | 小类层：`checked`（可比项）/ `inconsistent`（不一致）/ `singleSource`（只有一侧有数据） |
| `summary.tsSource` | Tushare 数据来源：`live`（现抓）/ `db`（库内）/ `unavailable` |
| `summary.worstCode` / `worstSub` | 最大分歧的 code / 小类（含偏离百分比与说明） |
| `summary.tolerance.bucket1Pct` | 判定容差（默认 0.01 = 1%） |
| `summary.diverged` / `summary.ok` | 分歧项数 / 是否全部通过 |
| `days[].perSource` | 当天各来源覆盖只数，例如 `{sse:{codes:746}, szse:{codes:0}, exchange:{codes:746}, ts:{codes:746,from:"live"}}` |
| `days[].seriesCheck[]` | 当天 86 个小类的逐项对比：`exchange`/`ts`/`covered`/`relPct`/`dirExchange`/`dirTs`/`inconsistent`/`note` |
| `days[].mismatch` | 当天超容差的明细（`count` + `byCode[]`） |

**一份实测样例**（本机当前 `data/quality.json`，2026-11-16 ~ 2026-11-20）：`compared.both = 3730`（= 746 只 × 5 天），`identical = 3730`，`gt1 = 0`，小类层 `checked = 430` 全部一致，`ok = true`。同一天 `days[].perSource.szse.codes = 0` —— 因为分类体系的 773 只成分**全是沪市代码**，深市快照不在这份比对里。

### 出现分歧意味着什么

> 以下是排查顺序，不是结论；请以 `days[]` 的具体明细为准。

1. **先看 `onlyExchange` / `onlyTs`**：一侧根本没数据（覆盖率问题），不是数值分歧。
2. **看是否是精度差**：Tushare 给 4 位小数，交易所口径取整到万份，小量级 ETF（几百万份）容易出现 ≤1% 的相对差，属于正常。
3. **看是否是同一天但不同口径**：交易所披露的是当日登记份额，Tushare 可能滞后一天或修正过历史值。
4. **>1% 且方向相反的，优先怀疑数据没更新**（节假日、接口异常、Token 限额），对照 `run` 表和 `.run/update.log`。
5. 处理原则：**不改数**。要么重跑 `npm run update` 让它自然修正，要么在 issue/笔记里记下是哪天的哪只 —— 手改 `series` 会让"数据可重建"这个前提失效。

另外还有一个独立的回归工具 `node scripts/verify-origin.mjs`：用本项目自己抓的数据复算，和**原站已发布的图表序列**逐点对比（读 `tools/original-charts/`），用来看"独立实现能不能复现原站"。它和 `reconcile` 的用途不同：前者对原站，后者对 Tushare。

---

## 7. 目录结构

```
etf-flow/
├── package.json            命令入口（start/update/build/backfill/reconcile/test/verify:origin），dependencies 为空
├── server.mjs              服务入口（默认 5188，绑定 127.0.0.1）
├── .env.example            TUSHARE_TOKEN 模板（真 token 放 .env，已 gitignore）
├── .github/workflows/
│   ├── daily.yml           每工作日自动更新 + 自动提交
│   ├── ci.yml              push/PR 校验
│   └── pages.yml           可选：发布 site/ 到 GitHub Pages（仅手动触发）
├── bin/
│   ├── start.sh / stop.sh  后台起停服务（pid → .run/server.pid，日志 → .run/server.log）
│   ├── status.sh           进程 / 自启 / 数据库规模 / 最近更新 / 访问地址
│   ├── update.sh           跑一次增量更新（锁 + 重试 + 摘要，日志 → .run/update.log）
│   └── install-autostart.sh / uninstall-autostart.sh   macOS LaunchAgent 装卸（支持 --dry-run）
├── launchd/                两个 LaunchAgent 模板（__PATH__ / __NODE__ / __NODEDIR__ 占位）
├── lib/
│   ├── sources.mjs         两个交易所接口（重试、限并发、翻页）
│   ├── tushare.mjs         Tushare Pro（fund_share / fund_basic，限速退避重试）
│   ├── db.mjs              SQLite 存储层（node:sqlite，建表、优先级合并、统计）
│   ├── pipeline.mjs        合并落库 → 重算 series（口径在这里）
│   ├── payloads.mjs        派生站点载荷（meta/charts/tables/subs/index/quality）
│   ├── build/site.mjs      构站：拷贝 web/ → site/，写 site/data/*.json
│   ├── taxonomy.mjs        10 大类 / 86 细分行业 / 773 只 ETF 的成分与配色
│   ├── validate.mjs        数据校验规则（份额合法性、序列连续性、覆盖率），被测试与回补复用
│   └── aggregate.mjs       v1 遗留聚合函数，主流程已不再使用
├── scripts/
│   ├── update.mjs          增量更新（导出 update({lookback})，CLI 默认 15 天）
│   ├── build.mjs           离线重建 site/（库为空则退出码 1）
│   ├── backfill.mjs        全量回补（--from/--to/--source/--limit/--dry-run/--concurrency/--no-resume）
│   ├── reconcile.mjs       双口径交叉校验 → data/quality.json + reconcile 表
│   └── verify-origin.mjs   与原站已发布序列的回归对比（npm run verify:origin）
├── server/app.mjs          静态托管 + /api/meta|charts|tables|subs|index|quality|status|refresh
├── web/                    前端源码（index.html / app.js / styles.css），构站时拷到 site/
├── site/                   产物：index.html、app.js、styles.css、echarts.min.js（+ data/*.json，已 gitignore）
├── data/
│   ├── etf.db              SQLite 本地缓存（gitignore，可重建）
│   ├── quality.json        交叉校验结果
│   ├── lastrun.json        最近一次更新标记（gitignore，服务用它判断是否过期）
│   ├── validation-origin.json  verify:origin 的对比结果
│   ├── series.json         v1 遗留的旧序列（主流程已不再读写）
│   └── shares/             v1 遗留每日原始快照（gitignore）
├── tools/                  抓取/解析/对比用的一次性脚本 + 原站图表副本
├── tests/                  数据校验测试：framework.mjs（断言）+ runner.mjs（入口）+ cases/*.mjs（7 个用例文件）
└── docs/                   补充文档（截图说明等）
```

`site/` 完全可由数据重建；真正需要备份的只有 `data/etf.db`（或由它导出的原始份额）。

---

## 8. 已知限制（务必读）

1. **深市数据来自 Tushare。** 深交所官方接口只有"最新交易日"快照、无历史，v3 起已不再调用；深市全部由 Tushare `fund_share`/`fund_nav` 提供。**注意**：86 个细分行业的 773 只成分目前全是沪市代码（`5xxxxx`），所以深市数据只体现在「全市场总览」与 ETF 明细里，不参与细分行业数值 —— 要把它纳入分类，需要扩 `lib/taxonomy.mjs` 的成分表。
2. **Tushare 需要 token 和积分权限。** `fund_share` 对积分有要求，积分不够会返回权限类错误（代码会按频率限制退避重试 4 次后放弃）。没有 token 时 `npm run update` 仍能跑，但深市历史、交叉校验和 4 位小数精度都用不上。
3. **SQLite 库不进 git，但新克隆能直接出图。** `data/etf.db` 是本地缓存（可重建）。新克隆没有它时，`npm run build` 会**自动用仓库自带的 `data/series.json` 引导**出一个可看的站点（份额曲线齐全；成分 ETF 明细、规模/净流入需要真实数据库，此时为空）。要补齐就联网跑 `npm run update`（增量）或 `npm run backfill`（全量回补，约 20 分钟）。CI 没有 DB 缓存时同理走引导路径。
4. **`site/data/` 不入库。** `.gitignore` 里有 `site/data/` 与 `site/charts/`，仓库自带的前端产物**没有数据文件**：直接拿去静态托管是打不开图表的，必须先跑一次 `npm run build`（或用 `daily.yml` 的缓存构建）。同理 `daily.yml` 的自动提交只在 `site/index.html` 等前端文件变化时才产生提交，见 §5.1。
5. **主口径是"份"，金额口径是估算。** 图表与表格的 `亿份` 是 ETF 份额；份额变化 ≠ 资金净流入。小类抽屉里的 **规模(亿元)** 与 **近一周净流入(亿元)** 是用 Tushare 单位净值折算的估算值（`规模 = 份额 × 净值`，`净流入 = Δ份额 × 当日净值`），净值覆盖 96%（31 只已退市/无净值披露的成分缺失，会在抽屉里标注 `navCoverage`）。债券大类 ×100 是折算口径，跨大类比规模时注意。
6. **深市与 Tushare 的关系**：本项目 773 只成分最终全部落在沪市（`5xxxxx`），深市快照目前不参与任何小类；Tushare 的价值在于**独立第二源 + 4 位小数精度 + 净值**，而不是补深市历史。
7. **原站有 2 个交易日的数据是"冻结"的**：2026-08-25 与 2026-10-28，原站当日所有小类数值都与前一日完全相同（疑似抓取失败后沿用旧值）。本项目从交易所重抓，得到的是真实值，所以这两天的曲线会与原站不同 —— 这是**我们更准**，不是回归。核对方式见 `npm run verify:origin`。
8. **`501307` 是永久空成分**：Tushare 只有 18 个季末披露、交易所交易日无数据，对「港红利股息」贡献恒为 0，保留它不影响数值。
9. **单实例、单端口、无鉴权。** 服务只监听 `127.0.0.1`，设计给本机自用；**不要**绑到 `0.0.0.0` 或做公网映射，没有登录、没有限流。
10. **开机自启是 macOS 专有。** `bin/start.sh` / `stop.sh` / `update.sh` 在 Linux 上也能用；`install-autostart.sh` 在非 Darwin 上会直接拒绝。
11. **抓取克制。** 每日一次增量 + 服务自检，并发 ≤ 6。请勿改成高频轮询，别给对方服务器添麻烦。
12. **GitHub Pages 需要付费套餐。** 私有仓库开 Pages 要 Pro/Team/Enterprise；`pages.yml` 只挂了手动触发，默认不会自己跑（见 §9 的说明，或直接看工作流文件头部注释）。
13. **前端已知妥协（v2）**：
    - 长期变化率图（c2）按**当前区间首日=100%** 展示（与原站一致：原站也是切窗口后再归一）；切到 1 年时曲线起点仍是 100%，不是"绝对涨跌"。
    - `data/subs.json` 约 1.9MB（86 个小类各自带一份日期数组），抽屉按需懒加载，本地无明显延迟；后续可把 `dates` 提到顶层复用。
    - 620px 宽的抽屉里 7 列 ETF 表需要横向滚动约 50px（`border-collapse: collapse` 下 sticky 首列在 Chrome 失效）。
    - 手机窄屏 10 条线的端标可能轻微重叠（已用 `labelLayout.shiftY` 缓解）。
    - 点图例 = 打开该小类详情（不再切换显隐），只看一条线请用抽屉里的「只看这条线」。
14. **不是投资建议。** 见文末。

---

## 9. GitHub Pages（可选，默认不开）

私有仓库的 GitHub Pages 需要账号升级到 Pro/Team/Enterprise。当前状态的核对方式：

```bash
gh api repos/li2396803/etf-flow/pages   # 404 = 还没开（也可能账号没有权限）
gh api user                             # 看 plan 字段（本机实测返回 null，无法据此判断）
```

**核对结论（本机实测）**：仓库是 `private`，`GET /repos/li2396803/etf-flow/pages` 返回 **404 Not Found**，`gh api user` 的 `plan` 为 `null`，所以**无法确认账号套餐是否支持 Pages**。因此：

- 没有盲目开启 Pages；
- `pages.yml` 只写了 `workflow_dispatch`（手动），**不会**自动跑；
- 等确认账号支持后，去 `Settings → Pages` 把 Source 设为 **GitHub Actions**，再手动跑一次该工作流即可。想做到"数据更新后自动发布"，把 `pages.yml` 里注释掉的 `push` 触发器打开。
- 另一个前提：`site/data/` 当前在 `.gitignore` 里（构建产物不入库），所以 `pages.yml` 只靠 checkout 拿不到数据。要么先在本地 `npm run build` 并把 `site/data/` 一起推送，要么把 `pages.yml` 里那段注释掉的「装 Node + 恢复 DB 缓存 + `npm run build`」打开。

---

## 10. 免责声明与许可

### 10.1 免责声明

- 数据来自上海证券交易所、深圳证券交易所的**公开**信息接口，以及 Tushare Pro（第三方，需遵守其服务条款）；本项目只做搬运、聚合与展示。
- 数据与图表**仅供参考，不构成任何投资建议、要约或推荐**；因数据延迟、缺失、口径差异或计算误差导致的任何决策后果，由使用者自行承担。
- 「规模（亿元）」「净流入（亿元）」是**按单位净值折算的估算值**，覆盖率为 96%，不等于真实申赎金额。
- 本项目与**原作者、交易所、数据服务商均无从属、背书或合作关系**；不代表原作者观点。
- 请勿用于荐股、代客理财等场景，也不要对数据源做高频抓取。

### 10.2 许可（MIT）

本仓库以 **MIT** 协议开源，见 [`LICENSE`](LICENSE)。你可以自由使用、修改、再分发（含商用），条件是**保留版权声明与许可声明**。

### 10.3 鸣谢与溯源

- **原典**：哔哩哔哩（B站）UP 主 **「生炸瓜」** 的《ETF 细分行业资金流向》看板 —— 分类体系、指标口径与看板形态的来源。
- 完整的署名、隐性标识清单、再分发要求见 [`NOTICE.md`](NOTICE.md)。
- 页面**不再使用任何水印**；对原作者的致谢改为页脚显眼的「鸣谢 / 免责声明 / 项目」三块卡片，并在 `<head>` 的 `isBasedOn` 结构化数据中标注来源。

### 10.4 隐性作者标识

本项目不加水印，但在不影响阅读的位置嵌入了我们自己的身份指纹，便于溯源任何副本（详见 `NOTICE.md` §2）：

| 位置 | 形式 |
| --- | --- |
| `<head>` | `<meta name="author">` / `generator` / `etf-flow:signature` / `etf-flow:origin` |
| HTML 注释 | `<!-- etf-flow · ... · built by li2396803 -->` |
| 结构化数据 | `application/ld+json`（`SoftwareApplication` + `isBasedOn`） |
| DOM / 运行时 | `<html data-signature="28e8c8d6199160a1">`、`window.__ETFFLOW__`、控制台 banner |
| 数据 / 接口 | `data/meta.json` 的 `signature` 字段；HTTP 头 `X-Project-Signature` |

署名常量集中在 [`lib/signature.mjs`](lib/signature.mjs)，改一处全局生效。

---

## 11. 本文件的核对记录

写这份 README 时实际做过的验证（macOS，Node **v26.13.0**，2026-11-21）：

| 项目 | 结果 |
| --- | --- |
| 数据规模口径 | ✅ 用 `node` 直接读 `lib/taxonomy.mjs`：`CATS.length = 10`、`SUB` 键 86 个、`ALL_CODES` 773 个，且**全部以 `5` 开头（纯沪市代码）** |
| 库内实际数据 | ✅ 只读打开 `data/etf.db`：3019 只名录 / 2182 只有份额 / 1258 个交易日（2021-11-22 ~ 2026-11-20）/ 713042 行原始份额 / 104232 行 series |
| `bin/status.sh` | ✅ 实跑通过，新增的"数据库规模"一节正确显示上面的数字 |
| `bash -n bin/*.sh` | ✅ 六个脚本全过 |
| `node scripts/reconcile.mjs --help` | ✅ 输出即 §4 列出的参数 |
| `npm test` | ✅ 实测通过：`10 passed, 0 failed, 0 skipped（760ms）`；测试同时报到最新交易日 2026-11-20、1212 个有数据的交易日、86 个小类 |
| `data/quality.json` | ✅ 实读现有文件：`compared.both = 3730`、`identical = 3730`、`subs.checked = 430`、`ok = true`（§6 的样例就是它） |
| 三个 workflow | ✅ `actionlint 1.7.7` 零告警；另外用 Ruby `Psych` 的 AST 单独校验了语法与 `jobs/steps/uses@ref` 骨架 |
| `bin/install-autostart.sh --dry-run` | ⚠️ 未在本轮复跑（会写临时目录但不动系统），历史可用性见 v1 README |
| `npm run update` / `backfill` / `build` / `reconcile`（实跑） | ⚠️ 未复跑：这些会改写 `data/`、`site/`（协作中），耗时与行为按源码与既有 `data/lastrun.json` 记录描述 |
| GitHub Pages 可用性 | ✅ 实测 404 / `plan = null`，结论见 §9 |

---

## 参与贡献

一句话：欢迎 Issue 与 Pull Request —— 数据口径修正、字典/文档纠错、前端可用性、工作流改进都很有价值；
不引入运行时依赖、不改抓取频率上限、不手改 `data/series.json` 的数值。

- 怎么提、代码风格、提交信息规范（Conventional Commits）、**数据类 PR 的特殊要求**：见 [`CONTRIBUTING.md`](CONTRIBUTING.md)
- 参与即代表遵守的行为准则：[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- 漏洞与密钥泄露的私密报告流程（**不要开公开 Issue**）：[`SECURITY.md`](SECURITY.md)
- 提问前先看文档与常见问题、按模板提供环境与复现步骤：[`SUPPORT.md`](SUPPORT.md)
- Issue 模板：Bug 报告 / 功能建议 / 数据问题（在仓库「New issue」里直接选）；PR 模板会在提交时自动出现。

---

## Fork 与自建部署

最完整的步骤见 **[`docs/FORK.md`](docs/FORK.md)**（含每一步的判断依据与 8 个常见坑），这里只给 5 步速览：

1. **Fork** 本仓库到自己账号；
2. 到 <https://tushare.pro> 注册，复制你的 **API token**；
3. 你的 fork → **Settings → Secrets and variables → Actions → New repository secret**，
   Name 填 `TUSHARE_TOKEN`，Value 粘贴 token；
4. 打开 **Actions** 标签页，启用工作流（fork 默认关闭）；
5. **手动跑一次 `Daily data update`**；确认通过后，去 **Settings → Pages → Source = GitHub Actions** 打开站点。

> **必须自填 `TUSHARE_TOKEN`。** 工作流第一步就是「检查 TUSHARE_TOKEN」：缺密钥会**直接失败并提示配置路径**，
> 而不是静默降级。本地没配 `.env` 时 `npm run update` 仍能跑，但只有沪市交易所口径 —— 深市数据与金额口径
> （按净值折算的规模/净流入）都依赖 Tushare。

---

## 项目状态

| 项 | 状态 |
| --- | --- |
| 版本 | **v3.0.0（进行中）** —— 产品化重构，变更见 [`CHANGELOG.md`](CHANGELOG.md) |
| 测试 | `npm test`：10 个数据校验用例；`node scripts/lint.mjs`：7 项仓库自检（语法 / 密钥 / 占位符 / 产物边界 / 数据底座） |
| 数据规模 | **1212 个交易日**（2021-11-22 ~ 2026-11-20）/ **86 个细分行业** / **773 只 ETF 成分**（9 个编号大类） |
| 全市场总览 | 另统计沪深**全部场内 ETF（约 1953 只）** 的份额与规模，与上面的 773 只分类成分是两套口径 |
| 公网站点 | <https://li2396803.github.io/etf-flow/>（每个工作日约 16:30 自动更新并发布） |
| 数据最后更新 | 见站点页脚「数据截至 / 交易日」，或 `data/quality.json` 的 `generatedAt` |
| 运行时 | Node.js **≥ 22.5**（内置 `node:sqlite`），零运行时依赖 |
| 许可 | **MIT**（见 [`LICENSE`](LICENSE)；溯源与署名见 [`NOTICE.md`](NOTICE.md)） |

> 时效说明：第 1–11 节部分表述写于 v2 时期（当时数据源为「双源」、Pages 默认不启用）。v3 起数据源为**两源（上交所 + Tushare）**
> —— 上交所（沪市官方口径）+ Tushare Pro（深市唯一来源、沪市第二参照与净值）—— 深交所官方接口因只有最新
> 快照、无法回溯，已不再调用；Pages 也已启用。以本节的描述与 [`docs/`](docs/) 为准。
