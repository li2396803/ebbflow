// 解析原站 charts/*.js（在原站 JS 沙箱中执行，取回 window.CHARTS_DATA）
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

export function parseChunk(file) {
  const code = fs.readFileSync(file, "utf8");
  const sandbox = { window: {}, document: undefined };
  sandbox.window.addEventListener = () => {};
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { timeout: 10000 });
  return sandbox.window.CHARTS_DATA;
}

export function parseIndexTaxonomy(file) {
  const html = fs.readFileSync(file, "utf8");
  const m = html.match(/var ETFS = (\{[\s\S]*?\});\s*window\._etfs/);
  if (!m) throw new Error("ETFS not found");
  return JSON.parse(m[1]);
}

if ((await import("../lib/cli.mjs")).isMain(import.meta.url)) {
  const dir = process.argv[2] || "tools/original-charts";
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const D = parseChunk(path.join(dir, f));
    const cid = Object.keys(D)[0];
    const c1 = D[cid].c1;
    console.log(
      cid,
      "| dates:", c1.dates.length,
      c1.dates[0], "→", c1.dates.at(-1),
      "| series:", c1.series.length,
      "| c3 pts:", D[cid].c3.dates.length
    );
  }
}
