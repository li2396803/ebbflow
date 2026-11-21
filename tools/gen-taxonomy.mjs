// 从原站产物提取：86 小类 → 标的清单、配色、所属大类
import fs from "node:fs";
import { parseChunk, parseIndexTaxonomy } from "./parse-chunks.mjs";

const tax = parseIndexTaxonomy("tools/original-index.html");
const cats = []; // [{key, id, label}]
const html = fs.readFileSync("tools/original-index.html", "utf8");
for (const m of html.matchAll(/<section class="cat[^"]*" id="([^"]+)"><h2 style="border-left-color:(#[0-9A-Fa-f]{6})">([^<]+)<\/h2>/g)) {
  cats.push({ key: m[1], color: m[2], label: m[3] });
}
const out = { generatedFrom: "etf-flow-d0j.pages.dev", cats: [], sub: {} };
const perCat = {};
for (const f of fs.readdirSync("tools/original-charts")) {
  const D = parseChunk("tools/original-charts/" + f);
  const key = Object.keys(D)[0];
  (perCat[key] ??= []);
  for (const s of D[key].c1.series) perCat[key].push({ name: s.name, color: s.color });
}
for (const c of cats) {
  const subs = perCat[c.key] || [];
  out.cats.push({ key: c.key, id: c.key.replace(/^\d+_/, ""), label: c.label, color: c.color, subs: subs.map((s) => s.name) });
  for (const s of subs) {
    out.sub[s.name] = { cat: c.key, color: s.color, etfs: tax[s.name].map((e) => ({ code: e.slice(0, 6), name: e.slice(7) })) };
  }
}
fs.mkdirSync("lib", { recursive: true });
const js = `// 自动生成（tools/gen-taxonomy.mjs），请勿手改
// 86 个细分行业 → ETF 标的清单 / 配色 / 所属大类
export const CATS = ${JSON.stringify(out.cats, null, 1)};

export const SUB = ${JSON.stringify(out.sub, null, 1)};

export const ALL_CODES = [...new Set(Object.values(SUB).flatMap((s) => s.etfs.map((e) => e.code)))];
export const BOND_CAT = "9_债券";
`;
fs.writeFileSync("lib/taxonomy.mjs", js);
console.log("小类:", Object.keys(out.sub).length, "| 大类:", out.cats.length, "| 去重标的:", new Set(Object.values(out.sub).flatMap(s=>s.etfs.map(e=>e.code))).size);
console.log("大类:", out.cats.map(c=>`${c.label}(${c.subs.length})`).join(" "));
