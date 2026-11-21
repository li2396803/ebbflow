# 署名、来源与再分发说明（NOTICE）

## 0. 一句话

本项目是一个**独立重写**的开源实现：鸣谢原作者的分类体系与看板创意，代码与数据管道由我们自建，遵循 MIT 协议。

---

## 1. 鸣谢 · 原典（显式署名，非水印）

| 项 | 内容 |
| --- | --- |
| 作品 | 《ETF 细分行业资金流向》看板 |
| 作者 | 哔哩哔哩（B站）UP 主 **「生炸瓜」** |
| 原看板主页 | B 站：<https://space.bilibili.com/3546681834473583> ｜ GitHub：<https://github.com/ysz-xiao> |
| 本项目的继承部分 | 9 大类 / 86 个细分行业的**分类体系**（本项目在此基础上把深市 841 只 ETF 并入，新增 2 个小类，见 `docs/CLASSIFICATION.md`）；「细分行业份额 = 成分 ETF 份额之和」「债券大类 ×100」的**指标口径**；看板的整体形态、信息层级与配色布局 |
| 本项目的独立部分 | 全部代码：两源抓取（上交所 + Tushare）、SQLite 存储、校验与回归测试、HTTP API、前端重写（搜索 / 钻取抽屉 / 排行 / 导出 / 暗色 / 响应式）、CI 与文档 |

**声明**：原看板的界面设计、视觉稿与制作成果归原作者所有。本项目不含原作者的源代码分发；页面上的「鸣谢」区块与 `<head>` 中的 `isBasedOn` 结构化数据是对原作者的公开致谢与溯源。原作者与本项目无从属、背书或合作关系。

> 如果你喜欢这个看板，请先去 B 站关注并支持原作者「生炸瓜」：<https://space.bilibili.com/3546681834473583>；他的 GitHub 是 <https://github.com/ysz-xiao>。

## 2. 本项目

- 名称：**Ebbflow**（ebb & flow，潮起潮落）· ETF 细分行业资金流向
- 作者 / 维护者：**dreemetoo**（GitHub：<https://github.com/li2396803>）
- 仓库：<https://github.com/li2396803/ebbflow>
- 在线站点：<https://li2396803.github.io/ebbflow/>
- 协议：[MIT](./LICENSE)

### 隐性作者标识（用于溯源与识别副本）

本项目刻意不使用水印，改为在以下**不干扰阅读**的位置嵌入同一组身份信息，任何副本都可据此溯源：

| 位置 | 形式 |
| --- | --- |
| HTML `<head>` | `<meta name="author">`、`<meta name="generator">`、`<meta name="ebbflow:signature">`、`<meta name="ebbflow:license">`、`<meta name="ebbflow:origin">`（并保留 `etf-flow:*` 兼容键） |
| HTML 注释 | `<!-- ebbflow · ... · built by dreemetoo -->` |
| 结构化数据 | `application/ld+json`（`SoftwareApplication`，含 `author` / `license` / `codeRepository` / `isBasedOn`） |
| 运行时 | `window.__ETFFLOW__`（含 author / repo / license / fingerprint）+ 开发者控制台 banner |
| 数据载荷 | `site/data/signature.json` 与 `site/data/meta.json` 的 `author`、`repo`、`signature` 字段 |
| HTTP 响应头 | `X-Powered-By`、`X-Project-Author`、`X-Project-Signature` |

指纹 `01965be232d20323` = `sha256("ebbflow:dreemetoo:https://github.com/li2396803/ebbflow")` 的前 16 位十六进制，稳定不随构建变化。署名常量集中在 [`lib/signature.mjs`](./lib/signature.mjs)，改一处即可全局生效。

## 3. 再分发

1. 保留 [`LICENSE`](./LICENSE) 与本章 NOTICE（MIT 要求保留版权声明；署名属基本诚信）。
2. **不得**删除页面底部的「鸣谢」与「免责声明」，也不得暗示原作者或本项目的维护者为你再分发的版本背书。
3. **不得**把本项目或原看板包装成官方产品、付费产品，或用于任何形式的荐股、代客理财。

## 4. 数据与商标

- 份额、净值等原始数据版权归**上海证券交易所、Tushare** 等数据提供方（深市份额由 Tushare 提供）；本项目只做抓取与派生计算，不改变数据的权属。
- B 站 / 哔哩哔哩、上交所、深交所、Tushare 等名称与商标归各自权利人。
- 本项目的分析结果**不构成投资建议**（见 README 与页面底部的免责声明）。
