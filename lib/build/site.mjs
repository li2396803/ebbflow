// 站点构建：数据载荷 → site/data/*.json，并把 web/ 静态资源拷到 site/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllPayloads } from "../payloads.mjs";
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

export function buildSite(db, opts = {}) {
  const t0 = Date.now();
  const p = buildAllPayloads(db, opts);
  fs.mkdirSync(DATA, { recursive: true });

  atomic(path.join(DATA, "meta.json"), JSON.stringify(p.meta, null, 1));
  atomic(path.join(DATA, "tables.json"), JSON.stringify(p.tables));
  atomic(path.join(DATA, "subs.json"), JSON.stringify(p.subs));
  atomic(path.join(DATA, "index.json"), JSON.stringify(p.index));
  atomic(path.join(DATA, "quality.json"), JSON.stringify(p.quality));
  atomic(path.join(DATA, "market.json"), JSON.stringify(p.market));
  for (const [catKey, payload] of Object.entries(p.charts)) {
    atomic(path.join(DATA, `charts-${catKey}.json`), JSON.stringify(payload));
  }
  atomic(path.join(DATA, "signature.json"), JSON.stringify(runtimeSignature(), null, 1));
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
