# 更新日志

本文件记录对仓库结构、数据口径、命令有影响的变化。日常数据更新（`chore(data): 自动更新站点数据`）不记录。

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
