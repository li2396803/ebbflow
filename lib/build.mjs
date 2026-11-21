// 生成同构站点：site/index.html + site/charts/*.js
import fs from "node:fs";
import path from "node:path";
import { CATS, SUB } from "./taxonomy.mjs";
import { CSS, RUNTIME_JS, BOOT_JS, H1, BRAND, NOTICE, RANGES } from "./template.mjs";
import { recentWindow, windowChanges, catScale } from "./aggregate.mjs";
import { ROOT } from "./store.mjs";

const SITE = path.join(ROOT, "site");
const C3_SEED = path.join(ROOT, "data", "c3-seed.json");

/** 播种期「近 7 日变化率」基线（原站按未取整份额算出的百分比），读不到就返回 null */
function loadC3Seed() {
  try {
    return JSON.parse(fs.readFileSync(C3_SEED, "utf8"));
  } catch {
    return null;
  }
}
const CHARTS = path.join(SITE, "charts");
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const sign = (v, d) => (v == null ? "-" : (v >= 0 ? "+" : "") + v.toFixed(d));
const cls = (v) => (v >= 0 ? "up" : "down");

/** 保留最近 5 年，避免序列无限增长 */
export function trimToFiveYears(store) {
  if (!store.dates.length) return store;
  const last = new Date(store.dates.at(-1) + "T00:00:00Z");
  const cutoff = new Date(last.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 5);
  const cut = cutoff.toISOString().slice(0, 10);
  let k = 0;
  while (k < store.dates.length && store.dates[k] < cut) k++;
  if (k === 0) return store;
  store.dates = store.dates.slice(k);
  for (const name of Object.keys(store.subs)) store.subs[name] = store.subs[name].slice(k);
  return store;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 单个大类 → charts/<key>.js */
export function buildChunk(store, cat, c3seed = loadC3Seed()) {
  const win = recentWindow(store.dates, 7);
  const dates = store.dates;
  const series = cat.subs
    .map((name) => ({ name, color: SUB[name].color, values: (store.subs[name] || []).map((v) => v) }))
    .filter((s) => s.values.some((v) => v != null));

  const shortDates = win.map((i) => dates[i]);
  const shortSeries = series.map((s) => {
    // 播种期的短期曲线精度修复：
    //   历史序列只有 1 位小数，小量级小类（如 0.2 亿份）做比值会被抹平；
    //   原站发布过「相对播种窗口首日」的百分比，用它反推同一窗口内任意两日的比值是精确的：
    //       v(d) = v(首日) × pct(d)/100     →   v(d1)/v(d2) = pct(d1)/pct(d2)
    //   因此只要窗口与播种区有交集，短期曲线就能保持原站精度，且能随窗口右移继续生效。
    const seedPct = c3seed?.subs?.[s.name];
    const seedDates = c3seed?.dates || [];
    const baseVal = seedPct ? s.values[dates.indexOf(seedDates[0])] : null;
    const valAt = (i) => {
      const k = seedPct ? seedDates.indexOf(dates[i]) : -1;
      if (k >= 0 && seedPct[k] != null && baseVal) return (baseVal * seedPct[k]) / 100;
      return s.values[i];
    };
    const vals = win.map((i) => valAt(i));
    let base = null;
    for (const v of vals) if (v != null && v > 0) { base = v; break; }
    return { name: s.name, color: s.color, values: vals.map((v) => (v == null || base == null ? null : r1((v / base) * 100))) };
  });

  const sid = (n) => JSON.stringify({ name: n.name, color: n.color, values: n.values }).replace(/"([a-z]+)":/g, "$1:");
  for (const s of series) s.values = s.values.map(r1);
  const D0 = JSON.stringify(dates);
  const D1 = JSON.stringify(shortDates);
  const S0 = "[" + series.map(sid).join(",") + "]";
  const S1 = "[" + shortSeries.map(sid).join(",") + "]";
  const k = cat.key;
  return (
    `(function(){var D0=${D0},D1=${D1},S0=${S0},S1=${S1};` +
    `window.CHARTS_DATA=window.CHARTS_DATA||{};window.CHARTS_DATA[${JSON.stringify(k)}]=` +
    `{c1:{id:${JSON.stringify(k + "_c1")},dates:D0,percent:false,showSymbol:false,series:S0},` +
    `c2:{id:${JSON.stringify(k + "_c2")},dates:D0,percent:true,showSymbol:false,series:S0},` +
    `c3:{id:${JSON.stringify(k + "_c3")},dates:D1,percent:true,shortDates:true,showSymbol:true,series:S1}};})();`
  );
}

function catTableHtml(store, win) {
  const rows = catScale(store, win);
  const body = rows
    .map((r) => `<tr><td>${esc(r.label.replace("_", "."))}</td><td>${r.now.toFixed(1)}</td><td>${r.start.toFixed(1)}</td><td class="${cls(r.pct)}">${sign(r.pct, 2)}%</td></tr>`)
    .join("");
  return `<section class="span2"><h2>各大类规模与近期区间变动（亿份）</h2><table><thead><tr><th>大类</th><th>当前总规模</th><th>区间首日规模</th><th>变动比例</th></tr></thead><tbody>${body}</tbody></table></section>`;
}

function topTableHtml(title, rows, up, key = "delta", pcKey = "pct") {
  const body = rows
    .map((r) => `<tr><td>${esc(r.sub)}</td><td class="${cls(r[key])}">${sign(r[key], 1)}</td><td class="${cls(r[pcKey])}">${sign(r[pcKey], 2)}%</td></tr>`)
    .join("");
  return `<section><h2>${title}</h2><table><thead><tr><th>细分行业</th><th>${up ? "增加量" : "减少量"}(亿份)</th><th>变动百分比</th></tr></thead><tbody>${body}</tbody></table></section>`;
}

function etfsJs() {
  const obj = {};
  for (const [name, meta] of Object.entries(SUB)) {
    obj[name] = meta.etfs.map((e) => `${e.code} ${e.name}`);
  }
  return "var ETFS = " + JSON.stringify(obj) + ";";
}

export function buildSite(store) {
  fs.mkdirSync(CHARTS, { recursive: true });
  const win = recentWindow(store.dates, 7);
  const changes = windowChanges(store, win);
  const up = [...changes].sort((a, b) => b.delta - a.delta).slice(0, 5);
  const down = [...changes].sort((a, b) => a.delta - b.delta).slice(0, 5);
  const first = store.dates[win[0]];
  const last = store.dates.at(-1);
  const sub =
    `数据区间 ${store.dates[0]} ~ ${last}（${store.dates.length} 个交易日，最多展示 5 年） ｜ ` +
    `近期区间 ${first} ~ ${last}（${win.length} 个交易日）`;

  const tabs = CATS.map((c, i) => `<button data-target="${c.key}"${i === 0 ? ' class="active"' : ""}>${esc(c.label)}</button>`).join("");
  const sections = CATS.map((c, i) => {
    const active = i === 0 ? " active" : "";
    const card = (n, title, extra) =>
      `<div class="card"><h3>${title}</h3><div class="wm">B站生炸瓜</div><div id="${c.key}_c${n}" class="chart${extra || ""}"></div></div>`;
    return (
      `<section class="cat${active}" id="${c.key}"><h2 style="border-left-color:${c.color}">${esc(c.label)}</h2>` +
      card(1, "ETF份额变化全景分析") +
      card(2, "长期份额变化率（各小类首个有效日=100%）") +
      card(3, "近 7 个自然日内交易日份额变化率（各小类首个有效日=100%）", " chart short") +
      `</section>`
    );
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETF 细分行业资金流向</title>
<script src="echarts.min.js"></script>
<style>
${CSS}
</style>
</head>
<body>
<div class="page-wm"></div>
<div class="wrap">
${H1}
<div class="sub">${sub}</div>
${BRAND}
${NOTICE}
<div class="tbl-grid">${catTableHtml(store, win)}${topTableHtml("细分行业近一周份额增加量 TOP 5", up, true)}${topTableHtml("细分行业近一周份额减少量 TOP 5", down, false)}</div>
<div class="tabs" id="tabs">${tabs}</div>
${RANGES}
${sections}
</div>
<script>
${RUNTIME_JS}
</script>
<script>
${etfsJs()}
${BOOT_JS}
</script>
</body>
</html>
`;
  const atomic = (file, data) => {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  };
  for (const c of CATS) atomic(path.join(CHARTS, `${c.key}.js`), buildChunk(store, c));
  atomic(path.join(SITE, "index.html"), html);
  return { sub, dates: store.dates.length, subs: Object.keys(SUB).length, charts: CATS.length };
}
