// 站点构建：数据载荷 → site/data/*.json，并把 web/ 静态资源拷到 site/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllPayloads } from "../payloads.mjs";
import { createMetricContext } from "../metrics.mjs";
import { tradingDates } from "../db.mjs";
import { loadUniverse } from "../universe.mjs";
import * as pipelineMod from "../pipeline.mjs";
import { runLocalBin } from "../cli.mjs";
import { applySignatureHtml, runtimeSignature } from "../signature.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SITE = path.join(ROOT, "site");
const WEB = path.join(ROOT, "web");
const WEB_DIST = path.join(WEB, "dist");
/**
 * 前端产物目录：必须是 Vite 输出（带内容哈希）。
 * 缺产物时**就地补构建**，仍失败则抛错——避免静默发布「未打包版」。
 * 设 ALLOW_NO_VITE=1 可显式允许回退到源码目录（仅调试用）。
 */
function ensureDist() {
  const idx = path.join(WEB_DIST, "index.html");
  if (fs.existsSync(idx)) return WEB_DIST;
  if (process.env.ALLOW_NO_VITE === "1") return WEB;
  runLocalBin(ROOT, "vite", ["build", "--logLevel", "info"]);
  if (!fs.existsSync(idx)) throw new Error("前端构建未产出 web/dist/index.html");
  return WEB_DIST;
}
const webSource = () => ensureDist();
const DATA = path.join(SITE, "data");

const atomic = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};

function copyDir(src, dst, filter = () => true) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!filter(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) n += copyDir(s, d, filter);
    else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

function fallbackHtml(meta) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${meta.title}</title>
<style>body{font:14px/1.7 "PingFang SC","Microsoft YaHei",sans-serif;max-width:880px;margin:60px auto;padding:0 20px;color:#1f2328}
code{background:#f6f8fa;padding:2px 6px;border-radius:4px}</style></head><body>
<h1>${meta.title}</h1>
<p>数据区间 ${meta.range.from} ~ ${meta.range.to}（${meta.range.days} 个交易日），最新交易日 <b>${meta.lastTradeDate}</b>。</p>
<p>前端资源（<code>web/</code>）尚未就绪，当前为兜底页；数据已生成在 <code>site/data/</code>。</p>
</body></html>`;
}

/** 把一份载荷写到指定目录 */
function writeTree(dir, p) {
  fs.mkdirSync(dir, { recursive: true });
  atomic(path.join(dir, "meta.json"), JSON.stringify(p.meta, null, 1));
  atomic(path.join(dir, "tables.json"), JSON.stringify(p.tables));
  atomic(path.join(dir, "subs.json"), JSON.stringify(p.subs));
  atomic(path.join(dir, "index.json"), JSON.stringify(p.index));
  atomic(path.join(dir, "quality.json"), JSON.stringify(p.quality));
  if (p.market) atomic(path.join(dir, "market.json"), JSON.stringify(p.market));
  else {
    const f = path.join(dir, "market.json");
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    p.meta.warnings = [...(p.meta.warnings ?? []), "全市场聚合数据尚未补全（market.json 暂缺）"];
    atomic(path.join(dir, "meta.json"), JSON.stringify(p.meta, null, 1));
  }
  // v4：逐 ETF 区间指标按大类拆文件（页面只加载当前大类那一份）
  const RANGES = path.join(dir, "etf-ranges");
  if (p.etfRanges && Object.keys(p.etfRanges).length) {
    fs.mkdirSync(RANGES, { recursive: true });
    const keepRanges = new Set();
    for (const [catKey, payload] of Object.entries(p.etfRanges)) {
      const name = `${catKey}.json`;
      keepRanges.add(name);
      atomic(path.join(RANGES, name), JSON.stringify(payload));
    }
    for (const f of fs.readdirSync(RANGES)) if (!keepRanges.has(f)) fs.rmSync(path.join(RANGES, f), { force: true });
  }

  // 清掉上一版遗留的分片（catKey 变了会留下死文件）
  const keep = new Set(Object.keys(p.charts).map((k) => `charts-${k}.json`));
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith("charts-") && !keep.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  for (const [catKey, payload] of Object.entries(p.charts)) {
    atomic(path.join(dir, `charts-${catKey}.json`), JSON.stringify(payload));
  }
  atomic(path.join(dir, "signature.json"), JSON.stringify(runtimeSignature(), null, 1));

  // 历史快照：按日期存档一份「轻量看板」，用于回看某天的口径与总量；只保留最近 120 个交易日
  try {
    const ARCH = path.join(dir, "archive");
    fs.mkdirSync(ARCH, { recursive: true });
    const day = p.meta?.lastTradeDate;
    if (day) {
      const snap = {
        date: day,
        taxonomy: p.meta.taxonomy,
        counts: p.meta.counts,
        categories: p.meta.categories,
        cats: p.tables?.cats ?? [],
        market: p.market
          ? {
              date: p.market.dates.slice(-1)[0],
              total: { shares: p.market.total.shares.slice(-1)[0], scale: p.market.total.scale.slice(-1)[0] },
              byType: p.market.byType,
            }
          : null,
      };
      atomic(path.join(ARCH, `${day}.json`), JSON.stringify(snap));
      const files = fs.readdirSync(ARCH).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 120))) fs.rmSync(path.join(ARCH, f), { force: true });
    }
  } catch {
    /* 快照失败不影响主构建 */
  }
}

export function buildSite(db, opts = {}) {
  const t0 = Date.now();
  // skipWeb：只重建 data/*.json，前端产物沿用仓库里已提交的 site/
  // （Windows 用户没装 node_modules 时用 SKIP_VITE=1，走的就是这条路）
  const skipWeb = opts.skipWeb === true || process.env.SKIP_VITE === "1";
  const U2 = loadUniverse({ taxonomy: "v2" });
  const UL = loadUniverse({ taxonomy: "legacy" });
  // v2 只有在序列覆盖足够时才作为默认口径（CI 冷启动/部分回补时可能残缺）
  let v2Dates = 0;
  if (U2.stats?.taxonomy === "v2") {
    try {
      v2Dates = db.prepare("SELECT COUNT(DISTINCT date) n FROM series_v2").get()?.n ?? 0;
    } catch {
      v2Dates = 0;
    }
  }
  let useV2 = U2.stats?.taxonomy === "v2" && v2Dates >= 1000;
  // 自愈：v2 序列条数明显少于「小类数 × 交易日」时，说明这库的 series_v2 是旧的/残缺的，就地重算
  if (useV2) {
    try {
      const expect = Object.keys(U2.SUB).length * v2Dates;
      const have = db.prepare("SELECT COUNT(*) n FROM series_v2 WHERE val IS NOT NULL").get()?.n ?? 0;
      if (have < expect * 0.99) {
        const { recomputeAll } = pipelineMod;
        // 先备份：重算中途抛错时回滚，避免留下空表 → 站点静默回落到 legacy 口径
        const backup = db.prepare("SELECT sub, date, val, scale, flow, coverage FROM series_v2").all();
        try {
          db.exec("DELETE FROM series_v2");
          recomputeAll(db, { universe: U2, legacy: false });
          v2Dates = db.prepare("SELECT COUNT(DISTINCT date) n FROM series_v2").get()?.n ?? v2Dates;
        } catch (e) {
          if (backup.length) {
            db.exec("DELETE FROM series_v2");
            const put = db.prepare("INSERT OR REPLACE INTO series_v2(sub,date,val,scale,flow,coverage) VALUES(?,?,?,?,?,?)");
            for (const r of backup) put.run(r.sub, r.date, r.val ?? null, r.scale ?? null, r.flow ?? null, r.coverage ?? null);
          }
          throw e;
        }
      }
    } catch (e) {
      useV2 = false;
    }
  }

  // v4：份额/净值上下文（1.25M 行，约 4s）只建一次，v2 与 legacy 两棵树共用
  let metricCtx = null;
  try {
    const axisDates = tradingDates(db);
    if (axisDates.length) metricCtx = createMetricContext(db, axisDates);
  } catch {
    metricCtx = null; // 老库/空库：交给 buildAllPayloads 自己建（或跳过区间指标）
  }

  // 默认树：v2（若 v2 分类未生成则回落 legacy）
  // SUB_SERIES=all 会把逐日规模序列也塞进 subs（gzip 1.48×）；默认 flow：
  // 规模序列以 charts-<cat>.json 为唯一来源（同一份 1 位小数数据），subs 只带净申购（0.76×）。
  const subsSeries = process.env.SUB_SERIES || "flow";
  const p = useV2
    ? buildAllPayloads(db, { ...opts, universe: U2, table: "series_v2", metricCtx, subsSeries })
    : buildAllPayloads(db, { ...opts, universe: UL, table: "series", metricCtx, subsSeries });
  writeTree(DATA, p);

  // legacy 树（切换开关用）
  let legacyInfo = null;
  try {
    const pL = buildAllPayloads(db, { ...opts, universe: UL, table: "series", metricCtx, subsSeries });
    writeTree(path.join(DATA, "legacy"), pL);
    legacyInfo = { taxonomy: "legacy", subs: pL.meta.counts.subs, cats: pL.meta.counts.cats };
  } catch (e) {
    legacyInfo = { error: String(e.message || e).slice(0, 80) };
  }
  atomic(
    path.join(DATA, "lastrun.json"),
    JSON.stringify({ at: new Date().toISOString(), lastTradeDate: p.meta.lastTradeDate, ms: Date.now() - t0 })
  );

  // 清理旧版（v1）遗留的分片目录，避免静态目录里留死文件
  const legacyCharts = path.join(SITE, "charts");
  if (fs.existsSync(legacyCharts)) fs.rmSync(legacyCharts, { recursive: true, force: true });

  // 先镜像清理：删掉 site/ 里已不存在于 web/ 的旧文件（保留 data/、echarts.min.js 与签名注入后的 index.html）
  const KEEP = new Set(["data", "echarts.min.js", "assets"]);
  const wanted = new Set();
  const walk = (dir, rel = "") => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else wanted.add(r);
    }
  };
  const SRC = skipWeb ? null : webSource();
  if (SRC) walk(SRC);
  const prune = (dir, rel = "") => {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && KEEP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!wanted.has(r.replace(/\/$/, "")) && ![...wanted].some((w) => w.startsWith(r + "/"))) {
          fs.rmSync(full, { recursive: true, force: true });
          n++;
        } else n += prune(full, r);
      } else if (!wanted.has(r)) {
        fs.rmSync(full, { force: true });
        n++;
      }
    }
    return n;
  };
  const pruned = skipWeb ? 0 : prune(SITE);

  const copied = SRC ? copyDir(SRC, SITE, (name) => !name.startsWith("_") && !name.startsWith(".")) : 0;

  // 兜底：Vite 的 publicDir 拷贝在不同版本/环境下可能落空，这里把 web/public 直接同步到站点根
  // （sw.js / manifest / PWA 图标都是“必须在站点根”的文件）
  try {
    // 只补缺失文件，不能覆盖 dist 里已注入版本号/清单的 sw.js
    const pub = path.join(WEB, "public");
    if (pub && fs.existsSync(pub)) {
      const walkPub = (dir, rel = "") => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          const src = path.join(dir, e.name);
          const dst = path.join(SITE, r);
          if (e.isDirectory()) { walkPub(src, r); continue; }
          if (!fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
        }
      };
      walkPub(pub);
    }
  } catch {}


  // 构建产物带内容哈希：清掉 site/assets 里已不存在于最新产物的旧文件，
  // 避免旧 chunk 残留（以及 preload 命中过期文件导致重复下载）。
  try {
    const distAssets = path.join(WEB_DIST, "assets");
    const siteAssets = path.join(SITE, "assets");
    if (fs.existsSync(distAssets) && fs.existsSync(siteAssets)) {
      const keep = new Set(fs.readdirSync(distAssets));
      for (const f of fs.readdirSync(siteAssets)) {
        if (!keep.has(f)) fs.rmSync(path.join(siteAssets, f), { force: true });
      }
    }
  } catch {}

  // 用最新 dist 里的 chunk 名做 preload（不要从 site/assets 里猜，那里可能还有旧文件）
  let echartsChunks = [];
  try {
    const distAssets = path.join(WEB_DIST, "assets");
    if (fs.existsSync(distAssets)) {
      echartsChunks = fs
        .readdirSync(distAssets)
        .filter((f) => /^(echarts|vendor-echarts)-[\w-]+\.js$/.test(f))
        .sort((a, b) => (a.startsWith("vendor") ? 1 : 0) - (b.startsWith("vendor") ? 1 : 0));
    }
  } catch {}

  // 构建产物：给 ECharts 相关 chunk 加 modulepreload（动态 import 的入口 + 共享 core）
  try {
    const idxFile = path.join(SITE, "index.html");
    if (echartsChunks.length && fs.existsSync(idxFile)) {
      let html = fs.readFileSync(idxFile, "utf8");
      const links = echartsChunks
        .filter((f) => !html.includes(f))
        .map((f) => `<link rel="modulepreload" href="assets/${f}" crossorigin>`)
        .join("");
      if (links) {
        html = html.replace("</head>", `${links}</head>`);
        atomic(idxFile, html);
      }
    }
  } catch {}

  // ESM 的 import 是「串行发现」的：main.js 解析完才会发现 7 个依赖，形成请求瀑布。
  // 构建时把 web/js 下所有模块写进 <link rel="modulepreload">，浏览器一开始就并行拉取。
  try {
    const jsDir = path.join(SITE, "js");
    if (jsDir && fs.existsSync(jsDir)) {
      const mods = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js")).sort();
      const links = mods.map((f) => `<link rel="modulepreload" href="js/${f}">`).join("");
      const idxFile = path.join(SITE, "index.html");
      let html = fs.existsSync(idxFile) ? fs.readFileSync(idxFile, "utf8") : "";
      if (html && !html.includes("modulepreload")) {
        html = html.replace("</head>", `${links}</head>`);
        atomic(idxFile, html);
      }
    }
  } catch {}

  // 把项目身份注入首页（meta / JSON-LD / 注释 / 页脚占位）
  const idxFile = path.join(SITE, "index.html");
  if (fs.existsSync(idxFile)) {
    const raw = fs.readFileSync(idxFile, "utf8");
    const stamped = applySignatureHtml(raw);
    if (stamped !== raw) atomic(idxFile, stamped);
  }
  // 硬校验：站点根必须是「打包版」布局（index.html 引 assets/，且没有 css/ js/ 源码目录）
  try {
    const idx = path.join(SITE, "index.html");
    const html = fs.existsSync(idx) ? fs.readFileSync(idx, "utf8") : "";
    const packaged = /assets\/index-[\w-]+\.js/.test(html);
    const strayDirs = ["css", "js"].filter((d) => fs.existsSync(path.join(SITE, d)));
    if ((!packaged || strayDirs.length) && !skipWeb) {
      throw new Error(`站点布局异常：packaged=${packaged} stray=${strayDirs.join(",")}（应为 Vite 打包产物）`);
    }
  } catch (e) {
    if (process.env.ALLOW_NO_VITE !== "1") throw e;
  }

  const hasWeb = fs.existsSync(path.join(SITE, "index.html"));
  if (!hasWeb) atomic(path.join(SITE, "index.html"), fallbackHtml(p.meta));

  return {
    taxonomy: p.meta.taxonomy,
    legacy: legacyInfo,
    lastTradeDate: p.meta.lastTradeDate,
    dates: p.meta.range.days,
    subs: p.meta.counts.subs,
    cats: p.meta.counts.cats,
    etfs: p.meta.counts.etfs,
    webFiles: copied,
    prunedStale: pruned,
    usedFallbackHtml: !hasWeb,
    ms: Date.now() - t0,
  };
}
