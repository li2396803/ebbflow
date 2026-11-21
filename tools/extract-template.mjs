// 从原站 HTML 中把 CSS 与内联脚本原样抽出，生成 lib/template.mjs
import fs from "node:fs";
const h = fs.readFileSync("tools/original-index.html", "utf8");

const css = h.slice(h.indexOf("<style>") + 7, h.indexOf("</style>")).trim();
// 三个内联脚本
const scripts = [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length < 2) throw new Error("脚本块数量异常: " + scripts.length);
const runtimeJs = scripts[0].trim();
const dataJs = scripts[1];
const bootJs = dataJs.slice(dataJs.indexOf("window._etfs = ETFS;")).trim();

// 顶部文案与 tabs/ranges 骨架
const wrapStart = h.indexOf('<div class="wrap">');
const h1 = h.slice(h.indexOf("<h1>"), h.indexOf("</h1>") + 5);
const subTpl = '<div class="sub">__SUBTITLE__</div>';
const brand = h.slice(h.indexOf('<div class="brand">'), h.indexOf("</div>", h.indexOf('<div class="brand">')) + 6);
const notice = h.slice(h.indexOf('<div class="notice">'), h.indexOf("</div>", h.indexOf('<div class="notice">')) + 6);
const tabsStart = h.indexOf('<div class="tabs" id="tabs">');
const tabsEnd = h.indexOf("</div>", tabsStart) + 6;
const rangesStart = h.indexOf('<div class="ranges" id="ranges">');
const rangesEnd = h.indexOf("</div>", rangesStart) + 6;
const ranges = h.slice(rangesStart, rangesEnd);

const out = `// 自动生成（tools/extract-template.mjs）——来自原站的样式与运行期脚本，逐字节保留
export const CSS = ${JSON.stringify(css)};
export const RUNTIME_JS = ${JSON.stringify(runtimeJs)};
export const BOOT_JS = ${JSON.stringify(bootJs)};
export const H1 = ${JSON.stringify(h1)};
export const SUB_TPL = ${JSON.stringify(subTpl)};
export const BRAND = ${JSON.stringify(brand)};
export const NOTICE = ${JSON.stringify(notice)};
export const RANGES = ${JSON.stringify(ranges)};
`;
fs.mkdirSync("lib", { recursive: true });
fs.writeFileSync("lib/template.mjs", out);
console.log("CSS", css.length, "| runtime", runtimeJs.length, "| boot", bootJs.length, "| ranges ok", ranges.length > 50);
