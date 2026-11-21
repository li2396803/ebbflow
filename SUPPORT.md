# 获取帮助

先花 30 秒做三件事，能解决大部分问题：

```bash
node -v                 # 必须 ≥ 22.5（内置 node:sqlite）
npm test                # 10 个数据校验用例，应全绿
node scripts/lint.mjs   # 仓库自检（或 npm run lint）
```

然后按下面的「先看文档」定位：

| 你的问题 | 先看 |
| --- | --- |
| 怎么装、怎么跑起来 | [`README.md`](README.md) §1 快速开始、§4 命令参考 |
| 数据口径、单位、为什么对不上 | [`docs/DATA.md`](docs/DATA.md) §1、§7 已知偏差 |
| Fork 后没有数据 / Actions 不跑 / Pages 404 | [`docs/FORK.md`](docs/FORK.md) §8 常见问题 |
| 想改代码、加小类、加数据源 | [`docs/DEVELOPING.md`](docs/DEVELOPING.md) |
| 架构与设计取舍 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |

---

## 去哪里提问

### 1. GitHub Issues —— 缺陷与数据问题（推荐）

- **Bug / 崩溃 / 页面错乱**：用 [bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.yml)。
- **数据数值不对 / 某天缺失 / 和其他平台不一致**：用 [数据问题模板](.github/ISSUE_TEMPLATE/data_issue.yml)。
  这个模板会要求你填「小类 / 日期 / 期望值 / 实际值 / `quality.json` 片段」，因为缺了这些基本无法定位。
- **新功能想法**：用 [功能建议模板](.github/ISSUE_TEMPLATE/feature_request.yml)。

写之前搜一下已有 Issue（关键词：小类名、日期、报错原文），避免重复。

### 2. Discussions —— 使用问答与想法交流

设计上，**「怎么用 / 为什么这样设计 / 有没有更好的做法」** 这类开放讨论放
[Discussions](https://github.com/li2396803/ebbflow/discussions) 更合适。

> ⚠️ 当前状态：仓库**尚未开启** Discussions（GitHub 的 `has_discussions = false`）。
> 未开启时该链接会 404 —— 请先用 Issues，或在 Issue 里说明「希望开 Discussions」。
> 维护者开启后（Settings → General → Features → Discussions）本节会更新。

### 3. Security —— 漏洞与凭据泄露

**不要**开公开 Issue。走 [`SECURITY.md`](SECURITY.md) 里的私密通道（Security → Report a vulnerability）。

### 4. 不要在这些地方提问

- 别人的 PR / Issue 评论里「搭车」问无关问题；
- 私信维护者要 token、要数据、要「帮我看看这只 ETF」；
- 任何渠道请求**投资建议、个股/ETF 推荐、买卖点** —— 本项目不做，也不会回答。

---

## 提问时请提供

一条高质量的 Issue 至少包含：

1. **环境**：操作系统、`node -v`、浏览器与版本；是自己 `npm start` 还是看公网站点。
2. **你做了什么**：完整命令（例如 `npm run update`），以及是否配置了 `TUSHARE_TOKEN`。
   **不要贴 token 本身**，只说「已配置 / 未配置」。
3. **完整输出**：报错前后的日志（`npm run update` 的输出、`.run/update.log` 尾部、
   Actions 运行日志的相关片段）。截断的「报错了」无法定位。
4. **期望 vs 实际**：数据问题请给出小类名、日期、期望值、实际值，以及
   `data/quality.json` 里对应那天的 `days[].seriesCheck[]` 片段。
5. **可复现性**：能稳定复现吗？换个日期/换台机器是否一样？
6. **截图**（前端问题）：控制台报错与页面表现。

模板里已经把这些做成了必填项；如果某项确实拿不到，写明原因即可。

---

## 响应预期

- 这是**单人维护**的开源项目，没有 SLA。维护者会尽量在 3 个工作日内回应，节假日与忙季可能更久。
- 纯文档纠错通常最快；数据口径类问题需要复算，会慢一些。
- 如果 Issue 缺少必要信息，维护者可能会打上 `needs-info` 并等待补充；
  两周无回应会自动关闭（随时可以补充信息后重开）。

---

## 常见问题速查

| 现象 | 结论 |
| --- | --- |
| 没有 `TUSHARE_TOKEN` | 本地仍能跑（只有沪市交易所口径，金额口径与交叉校验不可用）；**GitHub Actions 会直接失败**并在报错里提示如何配置。见 `docs/FORK.md` §5.1 |
| `npm run update` 返回 `{ skipped: "locked" }` | 已有另一个更新在跑，或 `data/.update.lock` 残留 |
| 页面没有图表 | `site/data/` 是构建产物、不入库；先 `npm run build` |
| 只有两条曲线和原站不一样 | `2026-08-25`、`2026-10-28` 原站数据冻结，本项目是重抓的真实值，见 `docs/DATA.md` §7 |
| 金额口径和份额口径对不上 | 前者按净值折算（亿元），后者是份额（亿份），不是同一维度；另注意全市场总览（约 1953 只）与 773 只分类成分是两套口径 |
| 站点 Pages 404 | Pages 的 Source 要设成 **GitHub Actions**，且部署 job 成功 |

---

本项目**不提供投资建议**。数据来自公开接口与第三方服务，仅供参考；据此决策的后果由使用者自行承担。
