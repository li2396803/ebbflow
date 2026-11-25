# 数据与更新管线审计（P0/P1/P2）

> 角色：数据与更新管线专项。目标：把「取数 → 入库 → 重算 → 发布」做成**不会安静出错**的工程级管线。
> 本文只写**已验证**的结论；没验证的进 §7「未修/待定」。所有数字都能用 §8 的命令复现。

本文审计的基线：2026-11-25 本地库（`data/etf.db`，1,253,527 行 `share`、1,214 个交易日、88 个 legacy 小类 / 72 个 v2 小类、254 起折算事件）。

---

## 0. 结论速览

| 项 | 内容 | 状态 |
| --- | --- | --- |
| P0-1 | 覆盖度闸门改为「相对近 20 个交易日中位数」，残缺日不进轴 + 告警 + 自动修复 | ✅ 已修，有测试 |
| P0-2 | `subs / market / market_type / flow` 统一走 `resolveMarketModes()`，不再各自过滤 | ✅ 已修，有测试 |
| P0-3 | 可疑跳变（±30%）归因写入 `data/quality.json.jumps` | ✅ 已修，有测试 |
| P0-4 | 数值自洽（小类=Σ成分、market ALL=SH+SZ、债券 ×100）纳入离线审计 | ✅ 已修，审计实测 0 残差 |
| P1-5 | 深交所请求过重：发现闸门自愈路径是死代码（TDZ），已修；翻页优化未做（见 §7） | 🟡 部分 |
| P1-6 | 200+空 vs 接口坏：`assessDay()` 判据 + 哨兵/探针复用 | ✅ 已修 |
| P1-7 | Tushare 未出齐（1/32/99/1775 行）识别：探针与写入都要过覆盖门槛 | ✅ 已修，有测试 |
| P1-8 | 幂等：重算两次、导出两次字节级一致 | ✅ 有测试 |
| P1-9 | 锁：抽出 `lib/lock.mjs`（pid 存活 + 旧格式 + 超时），SQLite `busy_timeout` | ✅ 已修，有测试 |
| P1-10 | 生成物冲突：`repair-generated.mjs` + CI/日报双闸门 | ✅ 已修，有测试 |
| P2-11 | 结构化 `run` 记录（各源耗时/行数/覆盖/闸门/告警） | ✅ 已修 |
| P2-12 | `scripts/audit-data.mjs` 离线审计 + 接入 `ci.yml` | ✅ 已修 |
| P2-13 | `docs/DATA.md` 补「数据契约 + 不变量 + 故障处置」 | ✅ 已修 |

测试：`node tests/runner.mjs` → **29 passed, 0 failed, 0 skipped**（其中新增 13 个 P0/P1 用例）。

---

## P0-1 市场完整性：进轴的每一天，两市覆盖都要在合理区间

### 问题
11-24 深市整天缺失（深交所 `fetch failed`），当天只剩沪市，`大盘宽基` 496.4 → 408（**假暴跌 −17.8%**）。旧闸门是**写死的 300/300**：它只拦「少到 300 以下」，对「沪市 950 → 沪市 950 + 深市 60」这种残缺不敏感；而且阈值与年代无关（2021 年沪深合计只有 1100 只，2026 年 1750 只）。

### 证据
- 旧代码：`scripts/update.mjs` 第 2.05 步 `if (sh < 300) … if (sz >= 300) continue;`；`lib/db.mjs::tradingDates` 里 `has_ts` 退路写死 `minTsCodes = 800`。
- 现网实测：近 40 个交易日沪 947→962 只、深 772→788 只（`data/etf.db`）。写死 300 意味着**丢掉 60% 深市仍然"合格"**。

### 修法
1. `lib/db.mjs` 新增 `dayCoverage(db, {etfOnly})`（一条 SQL 聚合，按市场计数）与 `coverageBand(records, opts)`（**纯函数**）：
   - 判据 = 当日只数 / 近 `window=20` 个**已接受**交易日的中位数 ∈ `[minRatio=0.6, maxRatio=2]`；
   - 历史不足 `minWindow=5` 天时退化为绝对阈值（冷启动），不拿空历史做相对判断；
   - 某市场历史中位数为 0（早期还没有深市）→ 不做相对判断。
2. `axisDiagnostics(db)` 统一给出「轴 + 被排除日期 + 原因 + 参考中位数」；`tradingDates()` 变成它的薄封装，**API 兼容**（第二个参数仍是 `minTsCodes`，只在窗口不足/ts 退路时用）。
3. `scripts/update.mjs` 闸门改为：先诊断 → 对落在窗口内的残缺日**自动修复**（Tushare 全天 → 深交所历史接口）→ 再诊断 → 仍不合格则告警并确保不进轴（告警写进 `run.stats.gate` 与 `lastrun.json`）。

### 验证
- 测试 `tests/cases/invariants.mjs`：
  - 「60% 通过 / 59% 判残 / 2.5 倍判异常」；
  - 「阈值随历史缩放」：200/150 的小规模与 1000/800 的大规模用**同一相对口径**得到一致结论（证明没写死绝对只数）；
  - 「残缺日不进轴且给出 `sh_low` 原因 + 参考中位数」。
- 现有数据：`axisDiagnostics()` → 1,214 天在轴、76 天被排除，全部是 `ts_thin`（季末/月末非交易日），**没有**覆盖残缺日 → 本次修复对现有数据无副作用。
- 耗时：`axisDiagnostics` 330ms、ETF 口径覆盖 743ms（1.25M 行）。为避免每多一列聚合 +1.7s 的 SQLite 行为，`dayCoverage` 只做「总数 + 沪市数」两个聚合，官方行只数由调用方按需统计（见 P0-2）。

---

## P0-2 口径一致性：同一 `(code,date)` 一行，且四条路径同一判据

### 问题
旧 `recomputeAll()` 里：
- `subs` 路径：`(isSh ? useOfficialSh : useOfficialSz) && !official → continue`（**丢掉** Tushare 兜底行）；
- `market` / `market_type` 路径：不过滤，直接把 `byCode` 全部计入；
- `flow` 的前值 `prev` 也取自未过滤集合。

即「有官方标记就只认官方行」这条规则**只作用于 subs**，而它还有个更隐蔽的后果：官方快照**只抓回一半**时（不是 0），Tushare 兜底行同样被丢掉 → 系统性少算。

已在 11-24 事故里修过「官方行确实存在才启用官方口径」（`officialSh > 0`），但没有覆盖「官方存在但残缺」。

### 证据（可复算）
- 用现库数据对比「官方优先过滤」与「逐 code 优先」两种口径：**748 个 (小类×日) 不一致，且全部是新口径更大**（`newGtOld 748 / newLtOld 0`），最大差 4811.97 亿份。也就是说旧规则一直在**少算**，不是风格差异。
  - 例：`科创板宽基 2021-11-22` 旧 621.9622 / 逐 code 624.4686；`环保与碳中和 2021-11-26` 旧 66.9702 / 逐 code 113.8997（当天 SSE 只回了 365 行，深市无官方快照）。

### 修法
1. `lib/invariants.mjs::resolveMarketModes()`：**唯一判据**。逐日、逐市场决定
   - `official`：该市场官方行数 > 0 且相对近 20 日中位数 ≥ 0.6（窗口不足用 `minAbsolute=100`）；
   - `all`：官方缺失/残缺 → 用全部可用行（Tushare 兜底），并标记 `shIncomplete/szIncomplete`。
2. `lib/pipeline.mjs::recomputeAll()`：先按判据算出当天「有效行集合 `eff`」，**subs / market / market_type / flow 全部只用 `eff`**；`prev` 也改用 `eff`，避免口径切换日算出假申购。
3. 保留 `officialSh > 0` 的语义（现在由 `official` 模式隐含），11-24 的「整天归零」不会再出现。

### 验证
- 测试：「官方不完整 → 退回全部行」（`official 300/900` → `mode=all` + `shIncomplete=true`）；
- 测试：「subs 与 market 用同一份有效行」：构造 120 只官方 + 1 只仅 Tushare 的日子 → `series` 与 `market.SH` 都只算官方行（120 只）；构造官方整日缺失 → 两者都退回 Tushare（3 只、`etfs=3`）。
- 对现有数据的影响（在 DB 拷贝上跑 `recomputeAll`）：**legacy / v2 序列 0 个值变化**（因为现网官方快照都完整，判据等价于旧行为）；`market` 因同样遵守官方口径：
  - `ALL.shares` 35868.9546 → **35842.6064**（−26.35 亿份，−0.073%）；
  - `ALL.etfs` 1743 → **1719**（少掉的 24 只是只有 Tushare 行、官方快照未覆盖的沪市货币 ETF）；
  - 这是「market 与 subs 口径一致」的代价，量级 0.07%，且方向正确（官方口径）。
- `mixedDays = 0`：现网没有任何一天触发「有官方标记但退回全部行」，即修复是**防御性**的。

---

## P0-3 连续性：可疑跳变要能被查到原因

### 问题
`lib/validate.mjs::validateSeries` 只输出「第 X 天跳了 Y%」，没有归因；`data/quality.json` 里也查不到。运维看到 `+37323%` 无法判断是新成分、拆分还是抓错。

### 证据
现库跑 ±30% 阈值：**168 处**跳变；其中典型：
- `中长期利率债 2022-08-08` +37323.78%：前一天 21.4345 → 8021.6003，原因是新成分 `159649`（800,016 万份）**首次出现在该小类**；
- `疫苗 2023-02-22` +485.61%：同样由 `159657` 等深市成分首次出现造成；
- 这类「小基数 × 新成分」的百分比没有信息量，必须标出来源，否则会被当成数据错误。

### 修法
`lib/invariants.mjs::suspiciousJumps()`：逐小类扫序列，超阈值时按证据归因（优先级从强到弱）：
1. `split` —— 当日有成分的 `event`（拆分/合并）记录；
2. `coverage` —— 当日两市覆盖相对前一日 <80% 或 >120%；
3. `caliber` —— 当日市场口径模式切换（`official ↔ all`）；
4. `listing` —— 有成分 `fund.list_date == 当日`；
5. `constituent-new` —— 传入 `sharesByDate` 时，当日有成分**首次出现**（新增/回填）；
6. `small-base` —— 前值 < 该小类中位数的 5%（百分比被放大）；
7. `unknown` —— 以上都不成立 → `severity: "warn"`，留给人工。

`scripts/reconcile.mjs` 把结果写进 `data/quality.json.jumps`（`{thresholdPct, total, unknown, items[:30]}`），`lib/payloads.mjs::buildQuality` 透传到 `site/data/quality.json`。

### 验证
- 测试三例：拆分事件 → `split`；覆盖率塌陷 → `coverage`；无证据 → `unknown`（且为 warn）。
- 现库：168 处跳变，归因后 `unknown` 从 79 降到 **59**（其余为拆分 2 / 覆盖率 / 新成分 / 小基数）。审计把它作为**告警**而非硬失败（合理：ETF 份额一天翻倍是真事）。

---

## P0-4 数值自洽

### 问题
没有任何自动检查保证「库里的 `series.val` 真的等于成分之和」。`scale/flow`、`market`、债券 ×100 三处口径一旦漂移，页面照旧发布。

### 证据
用新写的 `numericChecks()` 复核现库：**legacy 100,295 个 (小类×日)、v2 83,796 个，maxΔ = 0**；`market` 1,214 天全部 `ALL = SH + SZ`（容差 2e-4：三个数各自按 4 位小数舍入的最大累计误差）。说明当前派生数据与事实层一致 —— 但这是**第一次**有工具证明它。

### 修法
`lib/invariants.mjs::numericChecks()`：按与 pipeline 相同的两种合法口径（`official` / `all`）分别重算，命中其一即通过，并统计实际生效口径；两种都不等 → 记为残差（附 `actual/expectedOfficial/expectedAll`，便于定位是口径问题还是脏数据）。`scripts/audit-data.mjs` 对 `series` 与 `series_v2` 各跑一遍，并检查 `market` 三条恒等式（份额、只数）。

### 验证
`node scripts/audit-data.mjs` → `C. legacy 序列 = 成分之和`、`C. v2 序列 = 成分之和`、`C. market ALL = SH + SZ` 全部 ✓；把测试库故意改坏一个值 → 审计退出码 1（见 §8 手工复现）。

---

## P1-5 深交所：请求过重与「自愈路径是死代码」

### 问题与证据
1. 11-24 事故根因之一是深交所接口每页 20 行、全市场要 55 次请求，连续请求被限流。
2. 复核闸门时发现：`scripts/update.mjs` 第 2.05 步在 `const szseWrite` **定义之前**调用它（第 2.1 步才定义）→ 抛 `ReferenceError`，但外层是空 `catch {}` → **深交所自愈分支一直是死代码**，从来没执行过。
3. 深交所还有两个入口：`fetchSzseSnapshot()`（最新报告日，55 页）与 `fetchSzseHistory(date)`（按日期区间查询，同样分页）。日常增量已按 v3 设计改为「深市份额统一走 Tushare（1 次调用覆盖全市场）」，官方深交所接口只作为**校验/兜底**。

### 修法
- 把 `szseWrite()` 提前到闸门之前定义，闸门里的调用改为真实可用（并带 `markDaySource`）。
- 深交所只在两种情况下被调用：① 快照日期不早于已知最新交易日；② 闸门修复兜底。两者都只在**其它路径失败**时发生。

### 验证
- 代码审读 + `node --check` + 现有测试全部通过；闸门修复路径在测试库上以 `szse` 兜底跑通（`gate.repaired` 记录 `via`）。
- **未做**：没有实测「更大 page size / 区间一次取多日」能否减少请求数（见 §7）。

---

## P1-6 空结果 vs 接口坏

### 问题
交易所接口「今天没数据」和「接口坏了」都是 HTTP 200 + 空结果，旧代码无法区分（只在 `sseDays === 0` 时用「Tushare 有 ≥800 只」猜一次）。

### 修法
- `lib/invariants.mjs::assessDay({rows, expected, minRatio})` → `ok / partial / empty_suspect / empty_expected`；
- `scripts/update.mjs` 的哨兵改成「用近 20 日中位数 × 0.6（冷启动下限 500）作 expected」，判为可疑才兜底并告警；
- 「空」的判据统一：**同一个日期，另一个源有量级可比的数据 → 可疑；两边都没有 → 本当没有**。

### 验证
测试：`assessDay(0, 1700) = empty_suspect`、`(0, null) = empty_expected`、`(99, 1700) = partial`、`(1775, 1700) = ok`。

---

## P1-7 Tushare 当天不全

### 问题
实测出现过 1 / 32 / 99 / 1775 行。旧探针 `if (m.size)` 会把「1 行」当成当天快照的 anchor 并写库，随后时间轴多出一个几乎空的交易日。

### 修法
`scripts/update.mjs` 探针改为：
```
floor = max(500, round(近 20 日中位数 × 0.6))
state = assessDay({rows: m.size, expected: floor, minRatio: 1})
state !== 'ok' → 不写 share、不写 nav、不标 has_ts、不设 anchor，只记告警
```
写入时同步 `markDaySource(db, d, "ts")`（旧代码漏标，导致 `tradingDates` 的 Tushare 退路无法生效）。

### 验证
测试：1700 只基准下，1/32/99 行判 `partial`，1775 行判 `ok`。`run.stats.sources.ts = {rows, expected, skipped[]}` 可事后核对。

---

## P1-8 幂等

### 问题
同一份数据跑两次，派生数据与站点 JSON 应字节级一致（时间戳除外），否则 git 天天产生无意义 diff，也掩盖真实变化。

### 修法 / 验证
- 测试：`recomputeAll()` 两次 → `series` / `market` / `market_type` 三表内容完全一致；`exportSeriesJson()` 两次 → 文件字节级一致（导出已按小类名排序、无时间戳）。
- 站点载荷侧：`site/data/*.json` 由 `buildAllPayloads` 从数据库派生。`SKIP_VITE=1 node scripts/build.mjs` 连跑两次后 `diff -r`：**唯一差异是 `site/data/lastrun.json` 的 `at`/`ms`**（运行标记，本就被 gitignore），其余 JSON 字节级一致。

---

## P1-9 锁与并发

### 问题
`scripts/update.mjs` 里的锁逻辑与主流程混在一起，无法单测；CI 与本地并发、SIGINT 残留都只能靠「等 15 分钟」。

### 修法
- 抽出 `lib/lock.mjs`：目录锁（`mkdir` 原子）+ `pid`/`startedAt` 文件；判定顺序：死进程 → 旧格式过期 → 超时；拒绝时返回 pid 与已持有时长。
- `lib/db.mjs` 打开连接时加 `PRAGMA busy_timeout = 5000`：WAL 下允许「单写多读」，本地与 CI 同时跑时写冲突会等 5 秒而不是立刻 `SQLITE_BUSY`。
- 锁目录仍在 `.gitignore`（`data/.update.lock/`），不会进仓库。

### 验证
测试：同进程重复抢锁被拒（pid 存活）→ 释放后成功；死 pid（999999）锁被清理并说明原因；旧格式无 pid 且 >2 分钟被清理。

---

## P1-10 生成物冲突（`<<<<<<<` 被提交）

### 问题
`data/series.json` 曾被 `<<<<<<<` 提交进仓库（2026-11 事故），整个 JSON 失效；`data/quality.json`、`site/*` 同理。根因：这些是**生成物**，却按文本参与三方合并；CI 里虽然有 `git checkout --theirs`，但只在 rebase 冲突分支生效，且没有任何「提交前校验」。

### 修法
1. `scripts/repair-generated.mjs`：
   - `--check`：扫描 `data/series.json / data/quality.json / data/validation-origin.json / site/index.html` 的冲突标记，有则退出 1；
   - `--fix`：能本地确定性重建的就重建（`series.json ← series 表`，要求 ≥1000 个交易日）；由联网流水线产生的（`quality.json`）先尝试 `git show HEAD:…` 取完整版本，再不行写**合法占位**并提示下次 reconcile 覆盖；前端产物只报错不猜（交给 `npm run build`）。
2. `ci.yml`：在「单元测试与自检」与「校验站点产物」两处各跑一次 `--check` → 冲突标记永远进不了 master。
3. `update.yml`：提交前跑 `--fix`；rebase 冲突解决后再跑一次 `--fix` 并重新 `git add`，失败则 job 失败。

### 验证
测试：临时目录写入带 `<<<<<<<` 的 `series.json` → `--check` 退出 1 且指出文件；`--fix` 在「无库、git 也拿不到完整版本」时退出 1 并**保持原文件不变**（不写半截 JSON）；干净 JSON → 退出 0。

---

## P2-11 结构化运行台账

`run.stats` 新增：
```jsonc
{
  "sources": {
    "ts":    { "ms": 0, "date": "…", "rows": 1755, "expected": 1740, "skipped": [{ "date": "…", "rows": 1, "state": "partial" }] },
    "sse":   { "ms": 0, "days": 12, "requested": 15 },
    "szse":  { "ms": 0, "info": { "date": "…", "count": 1042 } },
    "quotes":{ "ms": 0 }
  },
  "gate": { "checked": 15, "repaired": [], "excluded": [], "alerts": [] },
  "mixedDays": 0,
  "alerts": [{ "severity": "warn", "message": "…" }]
}
```
`data/lastrun.json` 同步写 `sources / gate / mixedDays / warnings`（仍被 gitignore）。

---

## P2-12 离线审计

`node scripts/audit-data.mjs [--strict] [--quiet]`，6 组检查（A 交易轴、B 事实层唯一性/优先级、C 数值自洽、D 序列卫生与跳变归因、E 数据文件可解析/无冲突标记、F 最新交易日覆盖），硬失败退出 1、告警退出 0（`--strict` 时告警也失败）。当前实测：**全部通过，1 条告警（59 处未知原因跳变）**；耗时 **11.7s**（1.25M 行 share + 约 18 万次双口径复算），CI 里只在有 DB 缓存时跑。

接入 `ci.yml`（有 DB 缓存时）与 `update.yml`（每日更新后、提交前）。

---

## 7. 未修 / 待定（明确说明原因）

| 项 | 现状 | 原因 |
| --- | --- | --- |
| 深交所翻页优化（更大 page size / 区间一次多日） | **未做** | 日常增量已不走深交所（深市份额由 Tushare 一次覆盖全市场），深交所仅作校验/兜底；而该接口的 page size 上限与区间查询行为**无法离线验证**，在没实测前不动，避免把它改成另一个坑。闸门兜底已有 55 页上限保护（`Math.min(pagecount, 200)`）。 |
| 未知原因跳变 59 处 | **保留告警** | 都是真实的大额申赎/未登记折算（如 `贵金属 2024-01-11 +208%`），无法从现有数据判定对错；按「不改数」原则留 warn 给人工。 |
| `verify-origin.mjs` 的口径 | **未改** | 它按「沪市 + 官方行」复算以对齐原站，是回归基线；pipeline 改的是 subs/market 的**一致性**，对健康日数值无影响（已实测 0 变化）。两者目的不同，刻意不合并。 |
| 端到端 `npm run update` | **未跑** | 会联网并改写 `data/`（含被 git 跟踪的 `data/series.json`）；本次用「DB 拷贝上重算 + 离线审计 + 单测」验证，真实流水线行为需 lead 在有 token 的环境跑一次确认。 |
| 覆盖度闸门的「渐进式退化」 | **已知局限** | 中位数是相对值：如果覆盖连续多天缓慢下滑，中位数会跟着下移，band 可能放行。缓解：`minRatio` 对**已接受**交易日取样 + 冷启动绝对下限 500；如需更强保证，应引入「交易所官方目录数」作为绝对锚（需要新数据源，未做）。 |
| `data/quality.json` 的 `jumps` 只覆盖 reconcile 窗口 | **设计如此** | 该文件由 `npm run reconcile --days N` 生成；全量跳变以 `audit-data.mjs`（D 组）为准。 |

---

## 8. 复现命令

```bash
# 1) 全量测试（含 13 个新不变量用例；不联网、用临时库）
node tests/runner.mjs

# 2) 离线审计（硬失败退出 1；--strict 连告警也失败）
node scripts/audit-data.mjs

# 3) 生成物冲突
node scripts/repair-generated.mjs          # 检查
node scripts/repair-generated.mjs --fix    # 能重建的自动重建

# 4) 交易轴与覆盖（看被排除的日子与原因）
node --input-type=module -e '
import { openDb, axisDiagnostics } from "./lib/db.mjs";
const db = openDb();
const ax = axisDiagnostics(db);
console.log("轴", ax.dates.length, "被排除", ax.excluded.length, ax.excluded.slice(0,3));
db.close();'

# 5) 口径一致性的影响（在拷贝上重算，不动真库）
cp data/etf.db /tmp/probe.db
node --input-type=module -e '
import { openDb } from "./lib/db.mjs";
import { recomputeAll } from "./lib/pipeline.mjs";
import { loadSeries } from "./lib/invariants.mjs";
const db = openDb("/tmp/probe.db");
const before = loadSeries(db, "series");
const r = recomputeAll(db);
const after = loadSeries(db, "series");
let changed = 0; for (const [k,v] of before) if ((v??null)!==(after.get(k)??null)) changed++;
console.log("series changed", changed, "mixedDays", r.mixedDays);
db.close();'

# 6) 站点幂等（两次构建对比；时间戳字段除外）
SKIP_VITE=1 node scripts/build.mjs && cp -r site/data /tmp/d1
SKIP_VITE=1 node scripts/build.mjs && diff -r /tmp/d1 site/data | head
```
