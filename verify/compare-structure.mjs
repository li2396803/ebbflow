// 静态结构对比：tools/original-index.html（原站副本） vs site/index.html（复刻版）
// 只读取，不写任何源码；输出结构化结论。
import fs from "node:fs";

const ORIG = "tools/original-index.html";
const REPL = "site/index.html";
const A = fs.readFileSync(ORIG, "utf8");
const B = fs.readFileSync(REPL, "utf8");

const dec = (s) =>
  String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** 从 HTML 提取可比对的结构事实 */
function extract(html) {
  const out = {};
  const first = (re) => {
    const m = html.match(re);
    return m ? m[1] : null;
  };
  out.title = dec(first(/<title>([\s\S]*?)<\/title>/));
  out.h1 = dec(first(/<h1[^>]*>([\s\S]*?)<\/h1>/));
  out.sub = dec(first(/<div class="sub">([\s\S]*?)<\/div>/));
  out.brand = dec(first(/<div class="brand">([\s\S]*?)<\/div>/));
  out.notice = dec(first(/<div class="notice">([\s\S]*?)<\/div>/));

  // ---- 首页三张表 ----
  const gridM = html.match(/<div class="tbl-grid">([\s\S]*?)<\/div>\s*<div class="tabs"/);
  const grid = gridM ? gridM[1] : "";
  out.tables = [...grid.matchAll(/<section([^>]*)>([\s\S]*?)<\/section>/g)].map((m) => {
    const attrs = m[1];
    const body = m[2];
    const h2 = dec((body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1] || "");
    const thead = (body.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || "";
    const cols = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => dec(x[1]));
    const tbody = (body.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || "";
    const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((c) => ({
        cls: (c[1].match(/class="([^"]*)"/) || [])[1] || "",
        text: dec(c[2]),
      }))
    );
    return { sectionAttrs: attrs.trim(), h2, cols, rows };
  });

  // ---- tab 按钮 ----
  const tabsM = html.match(/<div class="tabs" id="tabs">([\s\S]*?)<\/div>/);
  out.tabs = tabsM
    ? [...tabsM[1].matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
        attrs: m[1].trim(),
        target: (m[1].match(/data-target="([^"]*)"/) || [])[1] || null,
        text: dec(m[2]),
      }))
    : [];

  // ---- 区间按钮 ----
  const rangesM = html.match(/<div class="ranges" id="ranges">([\s\S]*?)<\/div>/);
  out.ranges = rangesM
    ? [...rangesM[1].matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
        years: (m[1].match(/data-years="([^"]*)"/) || [])[1] || null,
        text: dec(m[2]),
        active: /active/.test(m[1]),
      }))
    : [];

  // ---- 各大类 section + 三张卡片 ----
  out.cats = [...html.matchAll(/<section class="cat( active)?" id="([^"]+)">([\s\S]*?)<\/section>/g)].map(
    (m) => {
      const body = m[3];
      const h2m = body.match(/<h2([^>]*)>([\s\S]*?)<\/h2>/);
      const cards = [...body.matchAll(/<div class="card">([\s\S]*?)<div id="([^"]+)" class="([^"]*)"><\/div><\/div>/g)].map(
        (c) => ({
          h3: dec((c[1].match(/<h3>([\s\S]*?)<\/h3>/) || [])[1] || ""),
          wm: dec((c[1].match(/<div class="wm">([\s\S]*?)<\/div>/) || [])[1] || ""),
          chartId: c[2],
          chartClass: c[3],
        })
      );
      return {
        id: m[2],
        active: !!m[1],
        h2: dec(h2m ? h2m[2] : ""),
        h2Style: h2m ? (h2m[1].match(/style="([^"]*)"/) || [])[1] || "" : "",
        cards,
      };
    }
  );

  // ---- 脚本引用 ----
  out.scriptSrc = [...html.matchAll(/<script([^>]*)src="([^"]+)"([^>]*)>/g)].map((m) => m[2]);
  out.inlineScripts = (html.match(/<script>[\s\S]*?<\/script>/g) || []).length;

  // ---- 内联 CSS ----
  const cssM = html.match(/<style>([\s\S]*?)<\/style>/);
  out.css = cssM ? cssM[1] : "";

  return out;
}

/** 解析 CSS 为规则集（选择器 + 归一化声明体）；@media 内部规则拍平并加前缀 */
function parseCss(css) {
  const rules = [];
  let i = 0;
  let buf = "";
  let depth = 0;
  let sel = "";
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) {
        sel = buf.trim();
        buf = "";
      } else {
        buf += ch;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        rules.push({ sel, body: buf.replace(/\s+/g, "") });
        buf = "";
        sel = "";
      } else {
        buf += ch;
      }
    } else {
      buf += ch;
    }
    i++;
  }
  return rules;
}

function flattenCss(rules) {
  const out = [];
  for (const r of rules) {
    if (r.sel.startsWith("@media")) {
      const inner = parseCss(r.body.replace(/([{}])/g, "$1")); // 已去空白，保持可解析
      for (const ir of inner) out.push({ sel: r.sel + " " + ir.sel, body: ir.body });
    } else out.push(r);
  }
  return out;
}

const ea = extract(A);
const eb = extract(B);
const problems = [];
const diffs = { structural: [], dataLike: [] };

const eq = (label, a, b, kind = "structural") => {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja === jb) return true;
  diffs[kind].push({ label, original: a, replica: b });
  return false;
};

// 1. 头部文案
eq("title", ea.title, eb.title);
eq("h1", ea.h1, eb.h1);
eq("brand", ea.brand, eb.brand);
eq("notice", ea.notice, eb.notice);
// sub 含日期区间，属于数据驱动；单独判定
const subSame = ea.sub === eb.sub;

// 2. 表格结构（行数、列名、section 属性、标题）→ 结构；单元格文本 → 数据
const nTab = Math.max(ea.tables.length, eb.tables.length);
const tableReport = [];
for (let t = 0; t < nTab; t++) {
  const a = ea.tables[t];
  const b = eb.tables[t];
  const row = { index: t, title: a?.h2 ?? null };
  if (!a || !b) {
    problems.push(`第 ${t + 1} 张表只在一边存在`);
    tableReport.push({ ...row, status: "missing" });
    continue;
  }
  eq(`table[${t}].sectionAttrs`, a.sectionAttrs, b.sectionAttrs);
  eq(`table[${t}].h2`, a.h2, b.h2);
  eq(`table[${t}].cols`, a.cols, b.cols);
  eq(`table[${t}].rowCount`, a.rows.length, b.rows.length);
  const cellDiffs = [];
  const n = Math.max(a.rows.length, b.rows.length);
  for (let r = 0; r < n; r++) {
    const ra = a.rows[r] || [];
    const rb = b.rows[r] || [];
    const m = Math.max(ra.length, rb.length);
    for (let c = 0; c < m; c++) {
      const ca = ra[c];
      const cb = rb[c];
      if (!ca || !cb) {
        cellDiffs.push({ r, c, original: ca?.text ?? null, replica: cb?.text ?? null });
        continue;
      }
      if (ca.text !== cb.text || ca.cls !== cb.cls) {
        cellDiffs.push({ r, c, original: `${ca.text}[${ca.cls}]`, replica: `${cb.text}[${cb.cls}]` });
      }
    }
  }
  row.cols = a.cols;
  row.rows = a.rows.length;
  row.cellDiffs = cellDiffs.length;
  row.sampleDiffs = cellDiffs.slice(0, 8);
  row.status = cellDiffs.length ? "cell-diff(data)" : "identical";
  tableReport.push(row);
}

// 3. tab 按钮
eq("tabs.count", ea.tabs.length, eb.tabs.length);
eq("tabs.targets", ea.tabs.map((t) => t.target), eb.tabs.map((t) => t.target));
eq("tabs.texts", ea.tabs.map((t) => t.text), eb.tabs.map((t) => t.text));
eq("tabs.activeIndex", ea.tabs.findIndex((t) => /active/.test(t.attrs)), eb.tabs.findIndex((t) => /active/.test(t.attrs)));

// 4. ranges
eq("ranges", ea.ranges, eb.ranges);

// 5. 大类 section / 卡片
eq("cats.count", ea.cats.length, eb.cats.length);
eq("cats.ids", ea.cats.map((c) => c.id), eb.cats.map((c) => c.id));
eq("cats.activeIndex", ea.cats.findIndex((c) => c.active), eb.cats.findIndex((c) => c.active));
eq("cats.h2", ea.cats.map((c) => c.h2), eb.cats.map((c) => c.h2));
eq("cats.h2Style", ea.cats.map((c) => c.h2Style), eb.cats.map((c) => c.h2Style));
eq("cats.cards", ea.cats.map((c) => c.cards), eb.cats.map((c) => c.cards));

// 6. 脚本
eq("scriptSrc", ea.scriptSrc, eb.scriptSrc);
eq("inlineScripts", ea.inlineScripts, eb.inlineScripts);

// 7. CSS
const cssByteSame = ea.css === eb.css;
const ra = flattenCss(parseCss(ea.css));
const rb = flattenCss(parseCss(eb.css));
const selA = ra.map((r) => r.sel);
const selB = rb.map((r) => r.sel);
eq("css.selectors", selA, selB);
eq("css.ruleCount", ra.length, rb.length);
// 选择器可能重复出现（例如 .cat 有两条规则），必须按下标成对比较
const cssBodyDiff = [];
const cssLen = Math.min(ra.length, rb.length);
for (let i = 0; i < cssLen; i++) {
  if (ra[i].sel !== rb[i].sel || ra[i].body !== rb[i].body) cssBodyDiff.push(`${i}:${ra[i].sel}`);
}
for (let i = cssLen; i < Math.max(ra.length, rb.length); i++) cssBodyDiff.push(`${i}:${(ra[i] || rb[i]).sel}`);
if (cssBodyDiff.length) diffs.structural.push({ label: "css.ruleBodies", selectors: cssBodyDiff });

// ---------------- 输出 ----------------
const ok = (b) => (b ? "OK  " : "DIFF");
console.log("=".repeat(72));
console.log("静态结构对比：" + ORIG + "  vs  " + REPL);
console.log("=".repeat(72));
console.log(`\n[头部]\n  ${ok(JSON.stringify(ea.title) === JSON.stringify(eb.title))} title  原:${ea.title} 复:${eb.title}`);
console.log(`  ${ok(ea.h1 === eb.h1)} h1     "${ea.h1}"`);
console.log(`  ${ok(ea.brand === eb.brand)} brand  "${ea.brand}"`);
console.log(`  ${ok(ea.notice === eb.notice)} notice ${ea.notice === eb.notice ? "一致" : "不一致"}`);
console.log(`  ${ok(subSame)} sub    原:${ea.sub}\n          复:${eb.sub}`);

console.log("\n[首页三张表]");
for (const r of tableReport) {
  console.log(`  #${r.index + 1} ${r.title ?? "(缺失)"} → ${r.status} | 行数 ${r.rows} | 列 ${JSON.stringify(r.cols)} | 单元格差异 ${r.cellDiffs}`);
  for (const d of r.sampleDiffs || []) console.log(`       r${d.r}c${d.c}: 原 ${d.original} → 复 ${d.replica}`);
}

console.log(`\n[tabs] 原 ${ea.tabs.length} 个 / 复 ${eb.tabs.length} 个`);
console.log("  原:", ea.tabs.map((t) => `${t.target}=${t.text}`).join(" | "));
console.log("  复:", eb.tabs.map((t) => `${t.target}=${t.text}`).join(" | "));

console.log(`\n[ranges] 原 ${ea.ranges.length} 复 ${eb.ranges.length}:`, JSON.stringify(eb.ranges));

console.log(`\n[大类 section] 原 ${ea.cats.length} 复 ${eb.cats.length}`);
for (let i = 0; i < Math.max(ea.cats.length, eb.cats.length); i++) {
  const a = ea.cats[i];
  const b = eb.cats[i];
  if (!a || !b) { console.log(`  #${i + 1} 仅一边存在`); continue; }
  const sameCards = JSON.stringify(a.cards) === JSON.stringify(b.cards);
  console.log(`  #${i + 1} id=${b.id} h2="${b.h2}" 卡片${sameCards ? "一致" : "不一致"} 色=${b.h2Style}`);
  if (!sameCards) console.log(`      原:${JSON.stringify(a.cards)}\n      复:${JSON.stringify(b.cards)}`);
}

console.log(`\n[脚本] src=${JSON.stringify(eb.scriptSrc)} 内联脚本数 原 ${ea.inlineScripts} 复 ${eb.inlineScripts}`);

console.log(`\n[CSS] 字节级相同: ${cssByteSame ? "是" : "否"}`);
console.log(`  规则数 原 ${ra.length} 复 ${rb.length}；选择器集合一致: ${JSON.stringify(selA) === JSON.stringify(selB) ? "是" : "否"}`);
if (JSON.stringify(selA) !== JSON.stringify(selB)) {
  const onlyA = selA.filter((s) => !selB.includes(s));
  const onlyB = selB.filter((s) => !selA.includes(s));
  console.log("  仅原站:", onlyA);
  console.log("  仅复刻:", onlyB);
}
if (cssBodyDiff.length) console.log("  声明体不同的选择器:", cssBodyDiff);

console.log("\n" + "=".repeat(72));
console.log("结构差异（应视为走样）:", diffs.structural.length);
for (const d of diffs.structural) console.log("  -", d.label, "=>", JSON.stringify(d).slice(0, 400));
console.log("表内文本差异（数据更新导致，非结构）:", tableReport.reduce((s, r) => s + r.cellDiffs, 0));
console.log("=".repeat(72));

const verdict =
  diffs.structural.length === 0 && tableReport.every((r) => r.status !== "missing")
    ? "结构一致（仅表内数值/区间文案随数据变化）"
    : "存在结构差异，见上";
console.log("结论:", verdict);

fs.writeFileSync(
  "verify/structure-report.json",
  JSON.stringify(
    {
      original: ORIG,
      replica: REPL,
      cssByteSame,
      subSame,
      originalSub: ea.sub,
      replicaSub: eb.sub,
      structuralDiffs: diffs.structural,
      tables: tableReport,
      tabs: { count: eb.tabs.length, targets: eb.tabs.map((t) => t.target), texts: eb.tabs.map((t) => t.text) },
      ranges: eb.ranges,
      cats: eb.cats,
      css: { rules: rb.length, selectorsSame: JSON.stringify(selA) === JSON.stringify(selB), bodyDiffs: cssBodyDiff },
      verdict,
    },
    null,
    2
  )
);
console.log("\n已写出 verify/structure-report.json");
