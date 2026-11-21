# web/_mock —— 前端自测用样例数据

这里的 `data/*.json` 是**按 `site/data/` 契约手写的样例**（只含 `3_科技`、`9_债券` 两个大类、19 个小类、最近 260 个交易日），
目的是让前端可以脱离真实数据独立预览 / 回归，**不是真实行情，不要提交到线上站点**。

## 单独预览

```bash
cd /tmp && rm -rf etf-preview && mkdir etf-preview && cd etf-preview
cp <repo>/web/index.html <repo>/web/app.js <repo>/web/styles.css .
cp -R <repo>/web/_mock/data .
cp <repo>/site/echarts.min.js .          # 图表库
python3 -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899/
```

> 构建时如果把整个 `web/` 拷进 `site/`，这里会变成 `site/_mock/`，不影响线上页面。
> 不想带上就构建前删掉本目录，或在拷贝时排除 `_mock`。

## 与真实数据的关系

真实数据由 `lib/build/site.mjs` 写入 `site/data/`，结构与这里完全一致；前端只认这份结构，
所以样例数据能跑通，真实数据也能跑通。字段说明见仓库 README 的「前端数据契约」一节。

## 注意

* `subs.json` 里每个小类都带一份 `dates`（契约如此），86 个小类全量时约 1.9MB。
  前端也兼容「`dates` 提到顶层、各小类共用」的结构（`rec.dates || subs.__dates || subs.dates`），
  若后续想瘦身可以直接改成顶层共用。
