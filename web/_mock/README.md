# web/_mock —— 前端自测用样例数据

这里的 `data/*.json` 是**按 `site/data/` 契约手写的样例**（只含 `3_科技`、`9_债券` 两个大类、19 个小类、最近 260 个交易日），
目的是让前端可以脱离真实数据独立预览 / 回归，**不是真实行情，不要当成线上数据**。
样例里的净值是按 ETF 代码尾号造出来的，所以金额口径只保证形状与降级路径正确，数字本身无意义。

## 单独预览

```bash
cd /tmp && rm -rf etf-preview && mkdir etf-preview && cd etf-preview
cp <repo>/web/index.html <repo>/web/app.js <repo>/web/styles.css .
cp -R <repo>/web/_mock/data .
cp <repo>/site/echarts.min.js .          # 图表库
python3 -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899/
```

> 构建时 `web/` 下 `_` 开头的目录会被忽略，所以 `_mock/`（以及 `_shots/`）不会进 `site/`。

## 覆盖的字段

样例已包含全部可空字段，便于验证降级逻辑：

* `subs.json`：`scale` / `flow` / `navCoverage`，ETF 项里的 `nav` / `navPrev` / `scale` / `flow`
* `tables.json` 的 `all[]`：`scale` / `flow`
* `meta.json`：`metrics` / `metricUnits`

把 `metrics` 删掉、或把 `subs.json` 里的 `scale`/`flow`/`nav*` 摘掉，前端会自动回到「只有份额口径」的界面
（4 个 KPI、4 列 ETF 表、排行抽屉没有口径切换）——这条降级路径已经验证过。

## 注意

`subs.json` 里每个小类都带一份 `dates`（契约如此），86 个小类全量时约 1.9MB。
前端也兼容「`dates` 提到顶层、各小类共用」的结构（`rec.dates || subs.__dates || subs.dates`），
若后续想瘦身可以直接改成顶层共用，前端不用改。
