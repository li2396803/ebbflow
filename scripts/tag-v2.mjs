// 多维标签：一只 ETF 同时属于「指数类别 / 申万一级 / 中证一级 / 地区 / 因子 / 主题」多个视角，
// 这是正常现象。主分类（cat+sub）只负责导航，标签负责检索与交叉分析。
//
// 权威依据：
//   · 中证行业分类（2021-12 修订）：11 个一级行业（能源/原材料/工业/可选消费/主要消费/医药卫生/金融/信息技术/通信服务/公用事业/房地产），
//     四级架构 11/35/98/260，见 https://www.cnfin.com/gs-lb/detail/20211015/3415508_1.html
//   · 申万行业分类（2021 版）：31 个一级行业
//   · 指数类别沿用 Tushare index_basic.category（中证/国证口径）：规模/行业/主题/策略/风格/债券/期货指数…
//
// 用法：node scripts/tag-v2.mjs [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const V2_FILE = path.join(ROOT, "data", "classification-v2.json");
export const OUT_FILE = path.join(ROOT, "data", "tags-v2.json");

/** 申万一级 → 中证一级（11 类）映射 */
export const SW_TO_CSI = {
  能源: "能源", 煤炭: "能源", 石油石化: "能源",
  基础化工: "原材料", 钢铁: "原材料", 有色金属: "原材料", 建筑材料: "原材料",
  机械设备: "工业", 电力设备: "工业", 国防军工: "工业", 建筑装饰: "工业", 交通运输: "工业",
  环保: "工业", 综合: "工业",
  汽车: "可选消费", 家用电器: "可选消费", 纺织服饰: "可选消费", 轻工制造: "可选消费",
  商贸零售: "可选消费", 社会服务: "可选消费",
  食品饮料: "主要消费", 农林牧渔: "主要消费", 美容护理: "主要消费",
  医药生物: "医药卫生",
  银行: "金融", 非银金融: "金融",
  电子: "信息技术", 计算机: "信息技术",
  传媒: "通信服务", 通信: "通信服务",
  公用事业: "公用事业", 房地产: "房地产",
};

const CSI_CATS = ["能源", "原材料", "工业", "可选消费", "主要消费", "医药卫生", "金融", "信息技术", "通信服务", "公用事业", "房地产"];

/** 地区（跨境维度） */
const REGION_RULES = [
  ["港股", /港股|恒生|香港|恒指|H股|中概/],
  ["美股", /纳斯达克|标普500|标普消费|标普生物|MSCI美国|道琼斯|美国50|纽交所/],
  ["日本", /日经|东证|TOPIX|日本/],
  ["欧洲", /DAX|德国|法国CAC|欧洲|英国|富时/],
  ["新兴市场", /印度|越南|巴西|沙特|东南亚|亚太|新兴/],
];

/** 因子（策略维度） */
const FACTOR_RULES = [
  ["红利", /红利|股息/],
  ["价值", /价值/],
  ["成长", /成长/],
  ["质量", /质量|基本面/],
  ["低波", /低波/],
  ["动量", /动量/],
  ["等权", /等权/],
  ["ESG", /ESG|社会责任|治理|可持续/],
];

/** 债券细分 */
const BOND_RULES = [
  ["利率债", /国债|国开|政金|地方债|政策性金融|利率债/],
  ["信用债", /信用债|公司债|企业债|城投|中高等级/],
  ["可转债", /可转债|转债/],
  ["同业存单", /存单/],
  ["综合债券", /中债综合|综合债|全债/],
];

/** 商品细分 */
const COMMODITY_RULES = [
  ["黄金", /黄金|上海金|Au99/],
  ["白银", /白银/],
  ["有色期货", /有色/],
  ["农产品", /豆粕|农产品/],
  ["能源化工", /能源化工/],
];

const pick = (rules, text) => rules.find(([, re]) => re.test(text))?.[0] ?? null;

/** 给每只 ETF 打多维标签 */
export function buildTags(classification, names = {}) {
  const tags = {};
  const subMeta = classification.subs ?? {};
  for (const [subName, def] of Object.entries(subMeta)) {
    for (const e of def.etfs ?? []) {
      const text = `${names[e.code]?.benchmark ?? ""} ${e.name ?? ""}`;
      const t = [];
      const src = String(e.src ?? "");
      if (src.startsWith("index:")) t.push(`index:${src.slice(6)}`);
      if (def.sw) t.push(`sw:${def.sw}`);
      const csi = def.sw ? SW_TO_CSI[def.sw] : null;
      if (csi && CSI_CATS.includes(csi)) t.push(`csi:${csi}`);
      if (def.cat === "theme") t.push(`theme:${subName}`);
      if (def.cat === "crossborder") {
        const r = pick(REGION_RULES, text);
        if (r) t.push(`region:${r}`);
      }
      if (def.cat === "strategy") {
        const f = pick(FACTOR_RULES, `${subName}${text}`);
        if (f) t.push(`factor:${f}`);
      }
      if (def.cat === "bond") {
        const b = pick(BOND_RULES, `${subName}${text}`);
        if (b) t.push(`bond:${b}`);
      }
      if (def.cat === "commodity") {
        const c = pick(COMMODITY_RULES, text);
        if (c) t.push(`commodity:${c}`);
      }
      if (t.length) tags[e.code] = t;
    }
  }
  return tags;
}

export function main({ dryRun = false } = {}) {
  const cls = JSON.parse(fs.readFileSync(V2_FILE, "utf8"));
  const tags = buildTags(cls);
  const dims = {};
  for (const list of Object.values(tags)) {
    for (const t of list) {
      const d = t.split(":")[0];
      dims[d] = (dims[d] || 0) + 1;
    }
  }
  const out = {
    generatedAt: new Date().toISOString(),
    basis: "中证一级(11) ← 申万一级 | 指数类别来自 index_basic.category | 地区/因子/债券/商品细分按跟踪指数与基金名称",
    csiCategories: CSI_CATS,
    swToCsi: SW_TO_CSI,
    dims,
    tags,
  };
  if (!dryRun) fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  return { codes: Object.keys(tags).length, dims, bytes: dryRun ? 0 : fs.statSync(OUT_FILE).size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = main({ dryRun: process.argv.includes("--dry-run") });
  console.log(`[tag] ${r.codes} 只 ETF 打标，维度分布：${JSON.stringify(r.dims)}${r.bytes ? `，写出 ${r.bytes} B` : "（dry-run）"}`);
}
