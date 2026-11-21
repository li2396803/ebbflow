// 全市场成分宇宙：在原看板的 86 个细分行业（773 只沪市成分）之上，并入深市 ETF 的归属，
// 必要时新增小类。产物由 scripts/classify.mjs 生成（data/universe.json），这里只做合并。
//
// 设计原则：
//   · 原看板的 86 个小类与沪市成分**保持不动**（回归校验 verify:origin 依赖它）
//   · 深市成分按「跟踪指数指纹 → 关键词规则 → 新增小类」三级归属
//   · data/universe.json 缺失时自动退化为只有原看板成分（安全默认）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATS as BASE_CATS, SUB as BASE_SUB, ALL_CODES as BASE_CODES } from "./taxonomy.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const UNIVERSE_FILE = path.join(ROOT, "data", "universe.json");

const marketOf = (code) => (/^[569]/.test(code) ? "SH" : "SZ");

function cloneSub(sub) {
  return {
    cat: sub.cat,
    color: sub.color,
    etfs: sub.etfs.map((e) => ({ code: e.code, name: e.name, market: marketOf(e.code) })),
  };
}

/** 读取并合并；返回 { CATS, SUB, ALL_CODES, stats } */
export function loadUniverse({ file = UNIVERSE_FILE } = {}) {
  const CATS = BASE_CATS.map((c) => ({ ...c, subs: [...c.subs] }));
  const SUB = {};
  for (const [name, sub] of Object.entries(BASE_SUB)) SUB[name] = cloneSub(sub);

  const stats = { base: BASE_CODES.length, index: 0, rule: 0, newSubs: 0, unassigned: 0, extended: false };
  let ext = null;
  try {
    ext = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { CATS, SUB, ALL_CODES: [...BASE_CODES], stats };
  }

  const assign = ext.assign ?? {};
  const newSubs = ext.newSubs ?? {};
  const names = ext.names ?? {};
  const byCode = new Map();
  for (const [name, sub] of Object.entries(SUB)) for (const e of sub.etfs) byCode.set(e.code, { sub: name, name: e.name });

  // 1) 新增小类先建好容器
  for (const [name, def] of Object.entries(newSubs)) {
    if (SUB[name]) continue; // 与原小类重名则忽略
    const cat = CATS.find((c) => c.key === def.cat);
    if (!cat) continue;
    SUB[name] = { cat: def.cat, color: def.color || "#8b949e", etfs: [] };
    cat.subs.push(name);
    stats.newSubs++;
  }

  // 2) 应用归属（只处理新代码，原 773 只不动）
  for (const [code, subName] of Object.entries(assign)) {
    if (!SUB[subName] || byCode.has(code)) continue;
    const name = names[code] || code;
    SUB[subName].etfs.push({ code, name, market: marketOf(code) });
    byCode.set(code, { sub: subName, name });
    if (ext.sources?.[code] === "index") stats.index++;
    else stats.rule++;
  }
  stats.extended = true;

  // 3) 小类内按代码排序，保证输出稳定
  for (const sub of Object.values(SUB)) sub.etfs.sort((a, b) => a.code.localeCompare(b.code));
  // 4) 去掉没有成分的小类，并同步 CATS
  for (const [name, sub] of Object.entries(SUB)) if (!sub.etfs.length) delete SUB[name];
  for (const cat of CATS) cat.subs = cat.subs.filter((n) => SUB[n]);

  return { CATS, SUB, ALL_CODES: [...byCode.keys()].sort(), stats };
}

/** 覆盖情况（给报告/接口用） */
export function universeStats(SUB) {
  let sh = 0, sz = 0;
  for (const sub of Object.values(SUB)) {
    for (const e of sub.etfs) (e.market === "SZ" ? sz++ : sh++);
  }
  return { subs: Object.keys(SUB).length, codes: sh + sz, sh, sz };
}
