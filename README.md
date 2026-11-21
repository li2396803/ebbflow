# ETF 细分行业资金流向 · 本地长期运行版

把「ETF 份额（资金流向）看板」搬到自己电脑上：每天自动从**上交所 / 深交所公开接口**抓 ETF 份额，重算 86 个细分行业的资金流，生成本地静态站点，并在本机起一个 HTTP 服务随时打开看。

- 零第三方依赖，只要 Node.js ≥ 20
- 数据、站点、服务都在本机，不上传、不外传
- 支持开机自启（macOS LaunchAgent）+ 每个工作日收盘后自动更新
- 打开浏览器访问 <http://localhost:5188> 即可，断网也能看（本地已有数据）

> 本项目是对公开看板的个人本地复刻，**与原站及其作者无关**，数据仅供参考、不构成投资建议。详见文末「免责声明」。

---

## 1. 它长什么样、由什么生成

站点结构：10 个大类（宽基市场 / 风格策略 / 科技 / 制造 / 能源 / 资源 / 消费 / 医药 / 金融地产 / 债券），每个大类下 3 张图：

| 图 | 含义 |
| --- | --- |
| c1 | ETF 份额变化全景（亿份，原始值） |
| c2 | 长期份额变化率（各小类首个有效日 = 100%） |
| c3 | 近 7 个自然日内的交易日份额变化率（首个有效日 = 100%） |

另外有「各大类规模与近期区间变动」表和「细分行业近一周份额增加 / 减少 TOP 5」表。

产物全部在 `site/`，是**纯静态**的（`index.html` + `charts/*.js` + `echarts.min.js`），任何静态服务器都能托管。图表是按需动态加载 `charts/*.js` 的：本机 Chromium 实测 `file://` 直接双击也能正常出图，但 Safari 对本地脚本限制更严，**推荐**还是通过本地服务访问（还能顺带自动更新数据）。

---

## 2. 数据从哪来、什么口径

### 2.1 两个交易所接口

| 来源 | 接口 | 给的是什么 | 能回溯历史吗 |
| --- | --- | --- | --- |
| 上交所 | `query.sse.com.cn/commonQuery.do`，`sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L`，参数 `STAT_DATE=YYYY-MM-DD` | 该交易日在沪市所有 ETF 的**基金份额**（字段 `TOT_VOL`，单位**万份**） | **能**，按日期回溯任意历史交易日；非交易日返回空 |
| 深交所 | `www.szse.cn/api/report/ShowReport/data`，`CATALOGID=1105&TABKEY=tab1` | 深市基金列表的**当前规模**（字段 `dqgm`，单位**万份**） | **不能**，只有"最新交易日"这一份快照 |

### 2.2 计算口径（与原站一致）

- **单个细分行业当日值 = 该细分行业包含的全部 ETF 当日份额之和**
- 单位换算：万份 ÷ 10⁴ = **亿份**（站点上所有数字都是亿份）
- **大类「9.债券」额外 ×100**：债券 ETF 面值为 100 元/份，原站即按此折算，本项目和它保持一致
- 每个细分行业包含哪些 ETF（代码 + 名称清单）固定在 `lib/taxonomy.mjs`，86 个细分行业一一对应，改成分表就是改这个文件（它由 `tools/gen-taxonomy.mjs` 生成）

### 2.3 每天更新时的具体动作

`scripts/update.mjs` 做四件事：

1. 抓深交所**最新交易日**快照，以它的报告日作为「锚点」
2. 从锚点往前回溯 15 天，逐日抓上交所数据（已有快照的日期跳过，所以日常只多抓 1 天）
3. **只有沪深两市数据都齐的交易日才重算**，避免用半份数据覆盖历史
4. 重算序列 → 重建 `site/` → 写 `data/last-run.json`（含 `lastRunAt`、`latestTradeDate`、交易日数等）

漏跑的日子（比如连续几天没开机）不会凭空造数：会用**最近一次深交所快照做前值填充**，并在 `data/shares/<date>.json` 里标记 `estimated: true`。

首次播种（`npm run seed`）的 5 年历史来自仓库自带的 `tools/original-charts/*.js`（原站已发布的图表数据副本），所以**第一次不需要联网也能把历史凑齐**，只有当天之后的数据才靠接口累积。

---

## 3. 目录结构

```
etf-flow/
├── server.mjs            本地 HTTP 服务：托管 site/ + 数据过期自动刷新 + /api/status
├── package.json          命令入口（start / seed / update / build / verify），无 dependencies
├── README.md             本文件
├── .gitignore
├── bin/
│   ├── start.sh          后台启动服务（pid → .run/server.pid，日志 → .run/server.log）
│   ├── stop.sh           优雅停止（先 TERM，10 秒不退再 KILL）
│   ├── status.sh         进程 / 自启 / 最近更新 / 访问地址 一屏看完
│   ├── update.sh         跑一次增量更新，带锁 + 失败重试一次 + 摘要
│   ├── install-autostart.sh    安装开机自启 + 每日定时（支持 --dry-run 空跑校验）
│   └── uninstall-autostart.sh  卸载这两个 LaunchAgent
├── launchd/
│   ├── com.etfflow.server.plist   登录即启动、挂了自动拉起（KeepAlive）
│   └── com.etfflow.daily.plist    每个工作日 16:10 跑一次更新
├── scripts/
│   ├── seed.mjs          首次播种（读 tools/original-charts，不联网）
│   ├── update.mjs        增量更新（联网，约 5 秒）
│   └── build.mjs         只用本地数据重建站点（不联网）
├── lib/
│   ├── sources.mjs       交易所接口封装（含重试、限并发）
│   ├── aggregate.mjs     聚合计算（份额 → 细分行业 → 变化率/区间统计）
│   ├── build.mjs         生成 site/index.html 与 charts/*.js
│   ├── store.mjs         本地数据读写（原子写入 tmp + rename）
│   ├── taxonomy.mjs      86 个细分行业 ↔ ETF 清单、配色、所属大类
│   └── template.mjs      页面模板（CSS / 前端运行时代码 / 文案）
├── tools/
│   ├── original-charts/  原站 5 年图表数据副本（播种来源）
│   ├── diff-site.mjs     逐值对比自己生成的站点与原站（npm run verify）
│   └── …                 抓取/解析/校验用的一次性工具
├── site/                 产物：index.html、charts/<大类>.js、echarts.min.js
├── data/
│   ├── series.json       权威时间序列（1212 个交易日 × 86 个细分行业）
│   ├── shares/<date>.json 每日原始份额快照（万份，可审计/可重算）
│   └── last-run.json     上次运行标记（服务用它判断数据是否过期）
└── .run/                 运行时目录（自动创建）：server.pid、server.log、update.log
```

`data/` 里最值得备份的只有 `data/series.json`（+ 想留原始证据再带上 `data/shares/`）。`site/` 完全可由数据重建，`data/last-run.json` 丢了也没关系。

---

## 4. 首次使用：三步

前提：Node.js ≥ 20（本机实测 v26）。

```bash
cd /Users/lizelin/Documents/deepseek-harness/default-workspace/etf-flow

npm run seed      # ① 播种 5 年历史（读本地 tools/original-charts，不联网，实测 0.2 秒）
npm run update    # ② 抓当天/最新交易日数据并生成站点（联网，实测 4～10 秒）
npm start         # ③ 前台起服务，然后浏览器打开 http://localhost:5188
```

- 第 ③ 步是前台运行，日志直接打在终端，`Ctrl+C` 退出。想后台跑用 `bin/start.sh`（见下节）。
- 如果 `data/series.json` 已经存在（比如打包给你时就有），第 ① 步可以跳过；`npm run seed` 会覆盖播种区间，重复跑不报错。

---

## 5. 日常是怎么"自动保鲜"的

一共四层，懒人什么都不用管：

| 层 | 触发时机 | 说明 |
| --- | --- | --- |
| ① 启动自检 | 服务启动时 | 数据过期（今天收盘后还没跑过）就后台刷新一次，不阻塞页面 |
| ② 打开页面 | 每次访问首页 | 再检查一次是否过期，**30 分钟内已刷过就跳过**，刷新期间不会重复触发 |
| ③ 进程内定时 | 每 20 分钟 | 兜底检查，适配长期挂机 |
| ④ 定时任务 | 每个工作日 16:10 | launchd 跑 `bin/update.sh`，收盘后把当天数据落盘（需安装开机自启，见下节） |

手动触发刷新也可以：`curl http://localhost:5188/api/refresh`，或用 `bin/update.sh`。

`/api/status` 会返回当前数据状态，字段含义：

```json
{ "refreshing": false, "lastError": null, "now": "...", "mark": { "lastRunAt": "...", "latestTradeDate": "2026-11-20", ... } }
```

---

## 6. 开机自启（macOS LaunchAgent）

装两个任务：

- `com.etfflow.server`：登录即启动服务，**KeepAlive**，进程挂了自动拉起
- `com.etfflow.daily`：每个工作日 16:10 跑一次更新，日志进 `.run/update.log`

### 安装

```bash
bin/install-autostart.sh            # 真正安装（写入 ~/Library/LaunchAgents 并 launchctl load）
bin/install-autostart.sh --dry-run  # 只渲染到临时目录 + plutil 校验，不改动系统
```

安装脚本会做这些事：检查 macOS / node 版本（≥20）→ 创建 `.run/` → 把模板里的 `__PATH__`、`__NODE__`、`__NODEDIR__` 替换成真实路径（**路径含空格也没问题**，用 node 转义、参数按 argv 传递）→ `plutil -lint` 校验 → `launchctl unload` 旧的再 `load -w` 新的。重复安装是安全的。

> 为什么需要 `__NODE__` / `__NODEDIR__`：launchd 的默认 `PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，找不到 Homebrew、`~/.local/bin`、nvm 里的 node。安装脚本会把当前 `node` 的绝对路径和所在目录写进 plist，所以自启任务能稳定找到 node。

### 确认 / 卸载

```bash
bin/status.sh                  # "开机自启：服务=已加载，每日更新=已加载"
bin/uninstall-autostart.sh     # 卸载两个任务（进程随之停止），项目文件与数据保留
```

### 注意事项

- **不要**同时用手动实例：装了自启就不要再 `bin/start.sh`，否则两个进程抢 5188 端口（`start.sh` 会提示端口占用）。
- 装了自启后 `bin/stop.sh` 停不住服务——`KeepAlive` 会立刻拉起。要停请用 `bin/uninstall-autostart.sh`（脚本里也会这样提示你）。
- 换了 node 版本 / 换了 node 安装位置（nvm、fnm、Homebrew 升级）之后，**重新跑一次** `bin/install-autostart.sh`，否则自启会找不到 node。
- 定时任务是"每个工作日"（周一至周五），**不识别节假日**：节假日跑一次也没关系，更新是幂等的，只是把同一交易日的数据再算一遍。
- 想改运行时间：改 `launchd/com.etfflow.daily.plist` 里的 `Hour`/`Minute`，再重跑安装脚本。

---

## 7. 常用命令速查

| 命令 | 作用 |
| --- | --- |
| `npm start` | 前台起服务（`Ctrl+C` 退出） |
| `npm run seed` | 首次播种 5 年历史（不联网） |
| `npm run update` | 抓数据 + 重算 + 重建站点（联网，约 5 秒） |
| `npm run build` | 只用本地数据重建站点（不联网） |
| `npm run verify` | 逐值对比自己生成的站点与原站数据，打印差异统计 |
| `bin/start.sh` | 后台起服务（`PORT=8080 bin/start.sh` 换端口） |
| `bin/stop.sh` | 停止服务 |
| `bin/status.sh` | 进程 / 自启 / 最近更新 / 访问地址 |
| `bin/update.sh` | 跑一次更新并打印摘要（带锁，失败重试一次） |
| `bin/install-autostart.sh [--dry-run]` | 安装开机自启 + 每日定时 |
| `bin/uninstall-autostart.sh` | 卸载上述任务 |

---

## 8. 常见问题

**Q1：交易所接口挂了 / 断网了怎么办？**
本地已有数据不会受影响，站点照常能看，只是不更新。`bin/update.sh` 会自动重试一次，仍失败会明确报错（退出码 1）；服务的自动刷新失败只记录在 `/api/status` 的 `lastError`，不会把站点搞坏。恢复网络后重跑一次即可。

**Q2：为什么深交所数据是"近似"的？**
深交所只发布**最新交易日**的规模快照，没有历史接口。所以：（1）历史只能从今天开始每天累积；（2）某天没跑（关机/睡眠），那天就只能用最近一次快照前值填充，并在快照文件里标 `estimated: true`。（3）某交易日只有沪深两市数据都齐才会被重算，绝不会用半份数据覆盖历史。

**Q3：端口 5188 被占用？**
`bin/start.sh` 会打印占用端口的进程；换端口 `PORT=8080 bin/start.sh`，访问 `http://localhost:8080`。注意 launchd 版固定用 5188（plist 里写死），要改就改 plist 的 `PORT` 后重装。

**Q4：数据会不会外传？**
不会。服务只监听 `127.0.0.1`（本机回环），默认不对外开放；数据只写在本机 `data/` 和 `site/`。唯一的对外网络请求是**读取**交易所公开接口。

**Q5：想换电脑 / 备份？**
整个目录拷走即可；最小备份是 `data/series.json`（想留原始证据再加 `data/shares/`）。到新机器上装好 Node ≥ 20，`npm run build` 重建站点再 `npm start`。注意别把旧机器的 `~/Library/LaunchAgents/com.etfflow.*.plist` 直接拷过去（里面写死了旧路径），要用 `bin/install-autostart.sh` 重新安装。

**Q6：想清空重来？**
删掉 `data/series.json`（和 `data/shares/`），然后 `npm run seed && npm run update`。注意：**深交所的历史丢失后无法找回**，只能从当天重新累积。

**Q7：日志在哪？**
`.run/server.log`（服务）、`.run/update.log`（定时更新，装了自启才有）。`tail -f .run/server.log` 看着最直观。

**Q8：为什么页面水印写着"B站生炸瓜"？**
页面模板沿用了原站的样式与**原作者署名水印**，本站点只是本地复刻数据，署名版权归原作者；如不想保留可改 `lib/template.mjs` 里的 `BRAND`。

---

## 9. 已知限制（务必读）

1. **份额曲线（c1）与原站的差异只有四舍五入级别。** 实测 `npm run verify`：104,232 个数据点中 5 个相差 0.1（出现在最新一个交易日——本项目用当天抓到的原始万份数据重算，比原站发布时的深交所快照更新，属于更"新"而非更"错"）。近 7 日变化率（c3）在播种窗口内**与原站逐点一致**。
   说明：播种来的历史序列只有 1 位小数，直接拿来做比值会把量级很小的细分行业（≤7 亿份，如"风电与绿色能源"）的变化抹平，实测会让 c3 最大偏离 14 个百分点。因此 `data/c3-seed.json` 保留了原站已发布的 c3 百分比（相对播种窗口首日），`lib/build.mjs` 用它反推出**同一窗口内任意两日的比值**——`v(d) = v(首日) × pct(d)/100`，所以 `v(d1)/v(d2) = pct(d1)/pct(d2)`，与基准日取哪天无关。这样即使窗口逐日右移，短期曲线仍保持原站精度（实测：窗口从 11-13~11-20 右移到 11-16~11-23 后，风电与绿色能源仍为 100/100/105.5/105.5/105.5，与 85.9→90.6 的真实涨幅一致）。窗口完全滑出播种期的日子按"当日份额 ÷ 窗口首个有效日份额"自算，而此时序列已是交易所原始精度。

   另外，首页「各大类规模」表的**区间首日规模**列是把 9 个已取整小类相加得来，播种窗口内可能比原站差 ≤0.5 亿份（比例列相应差 ≤0.02 个百分点）；同样是窗口滑过播种期后自动消失。
2. **深交所历史不可回溯。** 只能从你开始跑的那天起一天天累积；没跑的日子是前值填充（`estimated`），不是真实值。
3. **只保留最近 5 年**（`lib/build.mjs` 的 `trimToFiveYears`），更早的会被裁掉以控制文件体积。
4. **上交所按日回溯**，节假日返回空，会被自然跳过；因此"交易日"完全由接口结果决定，不由日历推断。
5. **债券大类 ×100** 是跟随原站的折算口径（债券 ETF 面值 100 元），不是原始份额数字，跨大类比较规模时注意这一点。
6. **单实例、单端口、无鉴权**：这是给自己用的本机工具，不要暴露到公网。
7. **开机自启是 macOS 专有**（launchd）。`bin/start.sh / stop.sh / update.sh` 在 Linux 上也能用，`install-autostart.sh` 会直接拒绝非 Darwin 系统。
8. 抓取频率克制（每日 1 次增量 + 启动/页面触发），请不要改成高频轮询，避免给对方服务器添麻烦。

---

## 10. 免责声明

- 数据来自上海证券交易所、深圳证券交易所的**公开**信息接口，本项目只做搬运、聚合与展示。
- 数据与图表**仅供参考，不构成任何投资建议**；因数据延迟、缺失、口径差异或计算误差导致的任何决策后果，由使用者自行承担。
- 本项目是对公开看板的个人本地复刻，**与原站及其作者没有任何关系**，未获其授权或背书；页面模板保留了原作者的署名水印，相关版权归原作者所有。
- 请勿用于商业用途、二次分发或大规模抓取。

---

## 11. 本文件的实测记录

写这份 README 时实际跑过的命令与结果（macOS，Node v26.13.0）：

| 命令 | 结果 |
| --- | --- |
| `npm run seed` | ✅ 1212 个交易日（2021-11-22 → 2026-11-20），86 个细分行业（在临时副本中跑，避免覆盖现有数据） |
| `npm run update` / `bin/update.sh` | ✅ 约 4～10 秒，最新交易日 2026-11-20，摘要正常输出，退出码 0 |
| `bin/update.sh`（模拟 launchd 最小环境 `env -i`） | ✅ 通过（plist 的 PATH 里含 node 目录，能找到 node） |
| `bin/update.sh`（故意让 node 不可用） | ✅ 如实失败：重试一次后报错并退出 1，未伪造成功 |
| `npm run build` | ✅ 重建 1212 交易日 / 86 细分行业 / 10 图表 |
| `npm run verify` | ✅ 104,232 点差 5 个（最大 0.1）；c3 统计见「已知限制」 |
| `npm start` | ✅ 首页 HTTP 200 |
| `bin/start.sh` / `bin/status.sh` / `bin/stop.sh` | ✅ 启动→幂等再启动→状态→停止 全链路通过（在 5199 端口测，未影响 5188 实例） |
| `bin/install-autostart.sh --dry-run` | ✅ 两个模板渲染成功、`plutil -lint` 通过、含空格路径也正确 |
| `bin/uninstall-autostart.sh` | ✅ 未安装时安全退出 0，未改动系统 |
| `plutil -lint launchd/*.plist` | ✅ 两个模板均 OK |
| `bash -n bin/*.sh` | ✅ 6 个脚本语法均通过 |
| `node -e "JSON.parse(fs.readFileSync('package.json'))"` | ✅ 通过 |
| **`bin/install-autostart.sh`（真实安装）** | ⚠️ **未实测**：会真实写入 `~/Library/LaunchAgents` 并在 5188 起常驻服务，为避免与当前正在联调的实例抢端口，只验证到 `--dry-run`。首次真实安装后请用 `bin/status.sh` 确认显示「服务=已加载」。 |
