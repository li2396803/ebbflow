// 站点构建：数据载荷 → site/data/*.json，并把 web/ 静态资源拷到 site/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllPayloads } from "../payloads.mjs";
import { loadUniverse } from "../universe.mjs";
import * as pipelineMod from "../pipeline.mjs";
import { applySignatureHtml, runtimeSignature } from "../signature.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SITE = path.join(ROOT, "site");
const WEB = path.join(ROOT, "web");
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
        db.exec("DELETE FROM series_v2");
        recomputeAll(db, { universe: U2, legacy: false });
        v2Dates = db.prepare("SELECT COUNT(DISTINCT date) n FROM series_v2").get()?.n ?? v2Dates;
      }
    } catch (e) {
      useV2 = false;
    }
  }

  // 默认树：v2（若 v2 分类未生成则回落 legacy）
  const p = useV2
    ? buildAllPayloads(db, { ...opts, universe: U2, table: "series_v2" })
    : buildAllPayloads(db, { ...opts, universe: UL, table: "series" });
  writeTree(DATA, p);

  // legacy 树（切换开关用）
  let legacyInfo = null;
  try {
    const pL = buildAllPayloads(db, { ...opts, universe: UL, table: "series" });
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
  const KEEP = new Set(["data", "echarts.min.js"]);
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
  walk(WEB);
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
  const pruned = prune(SITE);

  const copied = copyDir(WEB, SITE, (name) => !name.startsWith("_") && !name.startsWith("."));
  // 把项目身份注入首页（meta / JSON-LD / 注释 / 页脚占位）
  const idxFile = path.join(SITE, "index.html");
  if (fs.existsSync(idxFile)) {
    const raw = fs.readFileSync(idxFile, "utf8");
    const stamped = applySignatureHtml(raw);
    if (stamped !== raw) atomic(idxFile, stamped);
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
