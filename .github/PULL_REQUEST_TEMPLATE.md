<!--
PR 标题请写成 Conventional Commits 格式（合并时会被用作 squash 提交信息）：
  fix(pipeline): 债券大类折算只作用于份额口径
  docs(fork): 补充没有 token 时的行为说明
类型：feat / fix / data / docs / test / refactor / perf / ci / chore
-->

## 这个 PR 做了什么

<!-- 一两句话说清「改了什么」和「为什么」。不要只写「优化」「修复 bug」。 -->

## 关联

<!-- Closes #123 / Refs #456；没有关联 Issue 也没关系，说明背景即可。 -->

## 改动类型

- [ ] 数据口径 / 派生序列（`lib/pipeline.mjs`、`lib/db.mjs`、`lib/validate.mjs`）
- [ ] 数据源 / 抓取（`lib/sources.mjs`、`lib/tushare.mjs`）
- [ ] 分类体系（`lib/taxonomy.mjs`：小类 / 成分 ETF / 配色）
- [ ] 载荷契约（`lib/payloads.mjs`，破坏性）
- [ ] 前端（`web/`）
- [ ] 服务 / 构建（`server/`、`lib/build/`）
- [ ] 测试 / 工程化（`tests/`、`scripts/`、`ci`）
- [ ] 文档
- [ ] 其他

## 检查清单

- [ ] `npm test` 通过（10 个用例；请把输出贴在下面）
- [ ] `node scripts/lint.mjs` 通过（或 `npm run lint`）
- [ ] 改了 `web/` 或数据相关代码时，跑过 `npm run build` 且页面正常
- [ ] 没有提交 `.env`、`data/etf.db*`、`data/lastrun.json`、`site/data/`、`data/shares/`、`.run/`
- [ ] 没有手改 `data/series.json` 的数值（数据应由脚本产出）
- [ ] 提交信息符合 Conventional Commits；破坏性变更写了 `BREAKING CHANGE:`
- [ ] 涉及行为/口径变化时，已在 `CHANGELOG.md` 记录

## 数据类 PR 必填（涉及口径、数据源、分类体系时）

- [ ] 已贴 `npm test` 输出
- [ ] 已贴 `npm run reconcile` 摘要（含 `ok` / `diverged` / `worstCode`；无 token 时说明退出码 2）
- [ ] 说明了影响范围：哪些小类/ 大类会变、变多少（给 1–2 个具体数字）
- [ ] 说明了数据来源：接口名 + 日期（**不要贴 token**）
- [ ] 改了分类体系时，已说明：增删了哪些小类/代码、对既有小类是否有数值影响、是否需要 `npm run backfill`、`npm run verify:origin` 的结果

```text
（把 npm test / reconcile 的输出贴在这里）
```

## 截图 / 验证

<!-- 前端改动请附前后对比截图；数据改动请附关键页面或 meta.json 的变化。 -->

## 备注

<!-- 已知限制、后续计划、需要 reviewer 特别关注的地方。 -->
