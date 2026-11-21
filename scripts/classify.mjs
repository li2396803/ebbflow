#!/usr/bin/env node
/**
 * 深市 ETF → 现有 86 个细分行业 归类器
 *
 * 用法：
 *   node scripts/classify.mjs            生成 data/universe.json
 *   node scripts/classify.mjs --report   额外写 data/universe-report.json，并打印摘要
 *   node scripts/classify.mjs --review   打印人工复核清单（未归类全部 + 每条规则命中数）
 *   node scripts/classify.mjs --force    忽略本地缓存，强制重新拉取 Tushare fund_basic
 *
 * V2 两层分类（7 大类 × 小类，产物 data/classification-v2.json）：
 *   node scripts/classify.mjs --v2            只跑 v2，写 classification-v2.json + 报告
 *   node scripts/classify.mjs --v2 --dry-run  只打印，不写任何文件
 *   node scripts/classify.mjs --v2 --review   额外打印排除清单与小类明细
 *
 * 口径（重要）：
 *   · 沪市 773 只成分的归属来自 lib/taxonomy.mjs（原看板口径），本脚本只读、绝不修改；
 *   · 本脚本只产出「深市 ETF → 小类」的新增归属，沿用同一套 86 个小类的名字；
 *   · 归类依据是 Tushare fund_basic 的 benchmark（业绩比较基准，含跟踪指数名）。
 *
 * 三级匹配（顺序即优先级）：
 *   1) index 级：指数指纹与某个沪市成分的指数指纹完全一致 → 直接继承该成分的小类；
 *   2) rule  级：RULES 顺序匹配（先精确后宽泛）→ 归入现有小类；
 *   3) new   级：规则命中的是 newSubs 里的新小类 → 计入 newSubs；
 *   4) 余下记 unassigned，并给出「为什么归不进去」的一句话理由。
 *
 * 只写 data/universe.json、data/universe-report.json，不改数据库、不改 taxonomy。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CATS, SUB } from "../lib/taxonomy.mjs";
import { call } from "../lib/tushare.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_FILE = path.join(ROOT, "data", "universe.json");
const REPORT_FILE = path.join(ROOT, "data", "universe-report.json");
const CACHE_FILE = path.join(os.tmpdir(), `etf-flow-fundbasic-${new Date().toISOString().slice(0, 10)}.json`);

const argv = new Set(process.argv.slice(2));
const FLAG = {
  report: argv.has("--report"),
  force: argv.has("--force"),
  review: argv.has("--review"),
  v2: argv.has("--v2"),
  dryRun: argv.has("--dry-run"),
};

/* =========================================================================
 * 1. 归一化：指数指纹 / 基金名称
 * ========================================================================= */

/** 现金/存款类成分（复合基准里的"活期存款利率(税后)×5%"），不是跟踪标的 */
const CASH_RE = /活期存款|定期存款|存款利率|货币市场|同业存单|银行活期/;

/**
 * 复合基准取「主成分」：按 + 拆分，优先取权重最大的非现金成分。
 * 例：`活期存款利率(税后)×5%+纳斯达克100指数×95%` → `纳斯达克100指数`
 *     `中证新能源汽车指数收益率×100%`               → `中证新能源汽车指数收益率`
 */
export function primaryComponent(benchmark) {
  const s = String(benchmark || "").normalize("NFKC").replace(/\s+/g, "");
  const parts = s.split(/[+＋]/).filter(Boolean);
  if (parts.length <= 1) return s;
  const parsed = parts.map((p) => {
    const m = p.match(/^(.*?)[×*](\d+(?:\.\d+)?)%$/);
    return m ? { name: m[1], w: Number(m[2]) } : { name: p, w: null };
  });
  const weighted = parsed.filter((p) => p.w != null);
  if (!weighted.length) return parsed[0].name;
  const nonCash = weighted.filter((p) => !CASH_RE.test(p.name));
  const pool = nonCash.length ? nonCash : weighted;
  pool.sort((a, b) => b.w - a.w);
  return pool[0].name;
}

/**
 * 指数指纹：把 benchmark 洗成「跟踪指数的名字」，用于 index 级严格同名匹配。
 *   创业板电池指数收益率×100%                 → 创业板电池
 *   中证港股通信息技术综合指数(港元)收益率       → 中证港股通信息技术综合
 *   经估值汇率调整后的国证港股通科技指数收益率   → 国证港股通科技
 */
export function indexFingerprint(benchmark) {
  let s = primaryComponent(benchmark);
  s = s.replace(/[×*]\s*\d+(?:\.\d+)?%/g, "");
  for (let i = 0; i < 3; i++) s = s.replace(/\([^()]*\)/g, "").replace(/（[^（）]*）/g, "");
  s = s.replace(/^经[^的]{0,24}?(?:调整|折算)(?:后)?的?/, "");
  s = s.replace(/经[^的]{0,24}?(?:调整|折算)(?:后)?的?/g, "");
  s = s
    .replace(/收益率|同期|年化|累计/g, "")
    .replace(/全收益|净价|全价|总收益|价格指数|基准价/g, "")
    .replace(/港元|人民币|美元|港币/g, "")
    .replace(/交易型开放式|证券投资基金|发起式|联接|基金|ETF|LOF/gi, "");
  s = s.replace(/指数$/, "");
  return s.trim();
}

/** 基金公司/管理人词：匹配规则前先摘掉，避免「前海开源」被区域规则 /前海/ 误命中 */
const COMPANY_RE =
  /(南方东英|兴证全球|华泰柏瑞|景顺长城|国投瑞银|工银瑞信|浦银安盛|国寿安保|光大保德信|申万菱信|中信保诚|山西证券|民生加银|方正富邦|国海富兰克林|摩根士丹利|前海开源|创金合信|红土创新|华润元大|北信瑞丰|恒生前海|合煦智远|西部利得|泰达宏利|农银汇理|金元顺安|华泰保兴|国新国证|中银证券|南方基金|东方红|易方达|天弘|富国|汇添富|博时|招商|华安|国泰|鹏华|大成|银华|华宝|永赢|建信|中欧|广发|华夏|嘉实|南方|万家|中银|平安|泰康|财通|浙商|华商|金鹰|德邦|长城|长信|融通|诺安|东财|中金|上银|鑫元|国金|华富|中加|汇安|东兴|泓德|睿远|朱雀|泉果|路博迈|贝莱德|施罗德|联博|国联|东吴|东海|湘财|嘉合|中庚|凯石|民生|鹏扬|新华|兴业|银河|摩根|中邮|长盛|九泰|太平|中航|恒越|百嘉|达诚|兴银|中融|英大|大和)/g;

/** 基金名称归一：去公司前缀 + ETF/联接/QDII/份额类别等形态词 */
export function cleanFundName(name) {
  let s = String(name || "").normalize("NFKC").replace(/\s+/g, "");
  for (let i = 0; i < 3; i++) s = s.replace(COMPANY_RE, "");
  s = s
    .replace(/交易型开放式指数证券投资基金|交易型开放式|证券投资基金|指数型发起式|发起式|指数基金/g, "")
    .replace(/ETF联接|ETF|LOF|QDII|联接/gi, "")
    .replace(/[（(](QDII|LOF)[）)]/gi, "")
    .replace(/-(A|B|C|E|I|CNY|USD)$/i, "")
    .replace(/[（(][A-Z]{2,3}[）)]$/g, "")
    .replace(/[（(]\s*[）)]/g, "")
    .trim();
  return s;
}

/* =========================================================================
 * 2. 新小类（现有 86 小类确实没有对应口径时才建）
 * ========================================================================= */

const NEW_SUBS = {
  创业板宽基: {
    cat: "1_宽基市场",
    color: "#C8562A",
    baseOn: "科创板宽基",
    reason:
      "深市 50 只创业板规模类指数 ETF（创业板指/创业板50/创业板200/创业板综合/创业板300/创业板大盘 等）" +
      "在现有 1_宽基市场 里没有对应小类：该大类只有科创板宽基与 A股/港股宽基，创业板口径整块缺失。",
  },
  海外宽基: {
    cat: "1_宽基市场",
    color: "#E8A277",
    baseOn: "港股宽基",
    reason:
      "20 只跟踪境外宽基/行业指数的 QDII ETF（纳斯达克100、标普500、MSCI美国50、日经225、德国DAX、" +
      "富时沙特阿拉伯、巴西伊博维斯帕、亚太精选等），现有 86 小类只覆盖 A 股与港股，境外市场无归属。",
  },
};

/* =========================================================================
 * 3. 规则表（顺序即优先级：先精确、后宽泛；宽泛规则一律放本段最后）
 *
 * 匹配对象是 `${指数指纹} ${清洗后的基金名}`。
 * 排序原则：先「一望即知」的专有小类（债券/境外/港股/区域），
 *           再按行业逐条收窄 → 最后才是「风格」「宽基」「含"科技/消费"的兜底」。
 * ========================================================================= */

const RULES = [
  /* ------------------------------ 9_债券 ------------------------------ */
  // 债券必须先判：否则「AAA科技创新公司债」会被"科技"吃掉、「金融债」会被"金融"吃掉
  { id: "bond-kcb", re: /科技创新公司债|科创债/, sub: "科创债", why: "AAA 科技创新公司债指数" },
  { id: "bond-policy-short", re: /(0-3|1-3)\s*年.*(国开|政策性|政金)|(国开|政策性|政金).*(0-3|1-3)\s*年/, sub: "短期利率债", why: "0-3 / 1-3 年国开、政金债" },
  { id: "bond-lgb", re: /地方政府债|地方债/, sub: "地方政府债", why: "地方政府债指数（含分省债）" },
  { id: "bond-ultra", re: /30\s*年.*国债|超长期/, sub: "超长期国债", why: "30 年期国债" },
  { id: "bond-mid", re: /金边|中期国债|5\s*年期国债|10\s*年期国债|基准做市国债/, sub: "中长期利率债", why: "中期/长端国债（金边债）" },
  { id: "bond-policy", re: /国开|政策性金融|政金/, sub: "中长期利率债", why: "国开行/政策性金融债（中久期）" },
  { id: "bond-credit", re: /信用债|基准做市公司债|做市公司债|公司债/, sub: "信用债", why: "基准做市信用债/公司债" },
  { id: "bond-cd", re: /城投债/, sub: "城投债", why: "城投债指数" },
  { id: "bond-cb", re: /可转债|可交换债|转债/, sub: "可转债与可交换债", why: "可转债/可交换债指数" },
  { id: "bond-cp", re: /短融|融资券/, sub: "短期融资券", why: "中证短融" },

  /* --------------------------- 境外（QDII） --------------------------- */
  // 只认境外市场标的；标普中国A股 / 富时中国 属于 A 股口径，不在此列
  {
    id: "overseas",
    re: /纳斯达克|标普500|MSCI美国|日经|DAX|巴西|伊博维斯帕|沙特|亚太精选|标普生物科技|标普石油天然气/,
    sub: "海外宽基",
    why: "跟踪境外宽基/行业指数的 QDII ETF，现有 86 小类无境外口径",
  },

  /* ----------------------------- 港股口径 ----------------------------- */
  // 沿用现有 86 小类的做法：港红利单列，港股行业主题并入同名 A 股小类
  { id: "hk-div", re: /港股通.*(高股息|红利|低波)|恒生.*(红利|高股息)|标普港股通低波红利/, sub: "港红利股息", why: "港股通红利/高股息/低波红利指数" },
  { id: "hk-biotech", re: /创新药/, sub: "创新药", why: "港股通创新药指数（现有创新药小类已含港股通创新药成分）" },
  { id: "hk-med", re: /恒生(生物科技|医疗保健)/, sub: "生物医药", why: "恒生生物科技指数" },
  { id: "hk-broad", re: /恒生中国企业|恒指港股通|香港恒生|恒生港股通50|港股通中国100|恒生指数/, sub: "港股宽基", why: "港股规模类宽基指数" },

  /* ------------------------------ 区域发展 ---------------------------- */
  {
    id: "region",
    re: /中关村|成渝|浙江|湖北|大湾区|雄安|京津冀|长三角|一带一路|G60|自贸区|东北振兴/,
    sub: "区域发展",
    why: "区域/园区主题指数（现有区域发展小类已含张江、杭州湾、长三角、粤港澳等）",
  },

  /* --------------------- 航空航天（必须早于「通信/科技」） --------------------- */
  // 「国证商用卫星通信产业」同时含「卫星」与「通信」，但现有 86 小类把卫星产业归在航空航天，故前置
  { id: "aero", re: /卫星|航天|航空|大飞机/, sub: "航空航天", why: "航空航天/卫星/通用航空指数" },

  /* ------------------------------ 3_科技 ------------------------------ */
  { id: "ai", re: /人工智能/, sub: "人工智能", why: "人工智能主题指数" },
  {
    id: "cloud",
    re: /云计算|大数据|数据中心|物联网|数字经济|算力|工业互联网|数据要素/,
    sub: "云计算与数据",
    why: "云计算/大数据/物联网/数字经济/算力基础设施（现有该小类已含物联网、国企数字经济）",
  },
  { id: "software", re: /软件|计算机|信息技术创新|信创|信息安全/, sub: "软件与信创", why: "软件/计算机/信创指数" },
  { id: "cons-electronics", re: /消费电子|虚拟现实/, sub: "消费电子", why: "消费电子 / VR 终端硬件主题" },
  { id: "tmt", re: /电子信息传媒|科技龙头|新一代信息技术|信息技术综合|全指信息技术/, sub: "科技综合", why: "TMT / 科技龙头 / 信息技术综合指数" },
  { id: "semi", re: /半导体|芯片|集成电路|中证电子|电子行业/, sub: "半导体芯片", why: "半导体/芯片/集成电路/电子指数" },
  { id: "telecom", re: /通信|5G|电信/, sub: "通信", why: "通信设备/通信服务/5G/电信指数" },
  { id: "media", re: /传媒|游戏|影视|文娱|动漫/, sub: "传媒游戏", why: "传媒/游戏/影视指数" },
  { id: "fintech", re: /金融科技/, sub: "金融科技", why: "金融科技主题指数" },
  { id: "tech-hk", re: /港股通科技|香港科技|恒生科技|创业板科技|科技50|科技100/, sub: "科技综合", why: "港股/创业板综合科技口径（现有科技综合已含港股通科技、科技龙头）" },
  { id: "soe-tech", re: /央企科技|国新央企科技/, sub: "科技综合", why: "央企科技引领/科技创新（与现有科技综合口径一致）" },
  { id: "internet", re: /互联网(?!医疗)/, sub: "互联网", why: "互联网主题（现有互联网小类已含港股通/海外中国互联网）" },

  /* ------------------------------ 7_医药 ------------------------------ */
  { id: "vac", re: /疫苗/, sub: "疫苗", why: "疫苗与生物技术指数" },
  { id: "biotech", re: /生物(医药|科技)/, sub: "生物医药", why: "生物医药/生物科技指数" },
  { id: "medsvc", re: /医疗保健设备与服务|医疗服务|互联网医疗/, sub: "医疗服务与互联网医疗", why: "医疗服务/医疗保健设备与服务指数" },
  { id: "device", re: /医疗器械/, sub: "医疗器械", why: "医疗器械指数" },
  { id: "tcm", re: /中药/, sub: "中药", why: "中药指数" },
  { id: "pharma", re: /医药|医疗|制药|公共卫生/, sub: "医药综合", why: "宽口径医药医疗指数" },

  /* ------------------------------ 5_能源 ------------------------------ */
  { id: "battery", re: /电池|储能/, sub: "电池", why: "电池/储能电池/新能源车电池指数" },
  { id: "solar", re: /光伏|太阳能/, sub: "光伏", why: "光伏产业指数" },
  { id: "wind", re: /风电|风能/, sub: "风电与绿色能源", why: "风电/风能指数" },
  { id: "power", re: /电力|电网|公用事业|绿电/, sub: "电力", why: "电力/电网/公用事业指数" },
  { id: "env", re: /环保|低碳|碳中和|长江保护|环境治理|节能/, sub: "环保与碳中和", why: "环保/低碳/碳中和指数" },
  { id: "nev-car", re: /新能源车|智能电动|新能源汽车/, sub: "新能源汽车", why: "新能源汽车/智能电动汽车指数" },
  { id: "nev-generic", re: /新能源|绿色能源/, sub: "新能源综合", why: "新能源综合/绿色能源指数" },

  /* ------------------------------ 4_制造 ------------------------------ */
  { id: "defense", re: /军工|国防/, sub: "国防军工", why: "军工/国防指数" },
  { id: "robot", re: /机器人|智能制造|机床|数控/, sub: "智能制造与机器人", why: "机器人/智能制造/机床指数" },
  { id: "machinery", re: /工程机械|机械设备/, sub: "工程机械", why: "工程机械/机械设备指数" },
  { id: "ship", re: /船舶/, sub: "船舶", why: "船舶产业指数" },
  { id: "auto", re: /汽车|车联网|整车|零部件/, sub: "汽车与零部件", why: "汽车/车联网/零部件指数（现有该小类已含港股通汽车）" },
  { id: "equipment", re: /装备|中证全指工业|工业指数/, sub: "高端装备", why: "装备产业/工业综合指数" },

  /* ------------------------------ 6_资源 ------------------------------ */
  { id: "rare", re: /稀有金属|稀土/, sub: "稀有金属", why: "稀有金属/稀土指数" },
  { id: "precious", re: /黄金产业|贵金属/, sub: "贵金属", why: "黄金产业股票指数（注意：不是黄金现货 ETF）" },
  { id: "metal", re: /有色金属|工业金属|矿业/, sub: "有色金属", why: "有色金属/矿业指数" },
  { id: "coal", re: /煤炭|焦煤/, sub: "煤炭", why: "煤炭指数" },
  { id: "steel", re: /钢铁/, sub: "钢铁", why: "钢铁指数" },
  { id: "chem", re: /化工|石化/, sub: "石化化工", why: "化工/石化产业指数" },
  { id: "material", re: /新材料/, sub: "新材料", why: "新材料指数" },
  { id: "oil", re: /石油|天然气|油气/, sub: "油气", why: "石油天然气/油气资源指数" },
  { id: "energy-res", re: /能源/, sub: "能源综合", why: "能源综合口径（新能源已在前面单独处理）" },
  { id: "res-generic", re: /原材料|自然资源|大宗商品/, sub: "资源综合", why: "原材料/自然资源/大宗商品综合指数" },

  /* ---------------------------- 8_金融地产 ---------------------------- */
  { id: "broker", re: /证券公司|证券行业|证券龙头|券商/, sub: "券商", why: "证券公司/证券行业指数（注意排除「证券交易所成份」）" },
  { id: "bank", re: /银行/, sub: "银行", why: "银行指数" },
  { id: "insurance", re: /保险|非银/, sub: "保险与非银", why: "保险/非银行金融指数" },
  { id: "wealth", re: /财富管理/, sub: "金融综合", why: "财富管理指数（券商/银行/保险混合）" },
  { id: "finance", re: /金融/, sub: "金融综合", why: "金融 / 金融地产综合指数" },
  { id: "realestate", re: /地产|房地产/, sub: "房地产", why: "地产/房地产指数" },
  { id: "infra", re: /基建|基础设施/, sub: "基础设施", why: "基建工程/基础设施指数" },
  { id: "building", re: /建筑材料|建材/, sub: "建筑材料", why: "建筑材料指数" },

  /* ------------------------------ 7_消费 ------------------------------ */
  { id: "livestock", re: /畜牧|养殖/, sub: "畜牧养殖", why: "畜牧养殖指数" },
  { id: "agri", re: /农业|农牧|粮食|种业|饲料/, sub: "农业", why: "农业/农牧渔/粮食产业指数" },
  { id: "appliance", re: /家电|家居|家用电器/, sub: "家电家居", why: "家电/家居家电指数" },
  { id: "food", re: /食品|饮料|白酒/, sub: "食品饮料", why: "食品饮料/饮料指数" },
  { id: "logistics", re: /运输|物流|交通|航运|港口/, sub: "交通物流", why: "运输/物流/交通指数" },
  { id: "travel", re: /旅游|酒店|免税/, sub: "旅游", why: "旅游主题指数" },
  { id: "brand", re: /品牌/, sub: "品牌消费", why: "品牌消费主题指数" },
  { id: "elderly", re: /养老/, sub: "养老服务", why: "养老产业指数" },
  { id: "edu", re: /教育/, sub: "教育", why: "教育主题指数" },
  { id: "cons-generic", re: /消费/, sub: "消费综合", why: "宽口径消费指数" },

  /* ------------------------- 2_风格策略（先于宽基） ------------------------- */
  { id: "dividend-lowvol", re: /红利低波/, sub: "红利低波", why: "红利低波动指数" },
  { id: "dividend", re: /红利|股息/, sub: "红利股息", why: "红利/高股息/股息策略指数" },
  { id: "cashflow", re: /自由现金流|现金流/, sub: "现金流策略", why: "自由现金流指数" },
  { id: "value", re: /价值/, sub: "价值策略", why: "价值/低估值策略指数（含创业板低波价值）" },
  { id: "growth", re: /成长/, sub: "成长策略", why: "成长/动量成长策略指数" },
  { id: "soe", re: /国企|央企|国资|国有企业/, sub: "央国企改革", why: "国企改革/央企/国资指数" },
  { id: "esg", re: /ESG|社会责任|公司治理|可持续发展/, sub: "ESG治理", why: "ESG/社会责任/治理指数" },
  { id: "composite", re: /等权重|小康|AH优选|新经济|央视财经/, sub: "综合策略", why: "等权/小康/AH 优选/新经济/央视财经50 等综合策略指数" },

  /* ------------------------- 1_宽基市场（最后兜底） ------------------------- */
  { id: "gem-wide", re: /^创业板|创业板50|创业板200|创业板300|创业板综合|创业板大盘|创业板中盘精选/, sub: "创业板宽基", why: "创业板规模类宽基指数" },
  {
    id: "broad-large",
    re: /沪深300|上证50|上证180|中证A50|中证A100|中证100(?!0)|深证100|深证50|深证主板50|基本面60|超大盘|MSCI中国A50/,
    sub: "A股大盘",
    why: "大盘宽基指数",
  },
  {
    id: "broad-mid",
    re: /中证500|中证800|上证380|深证300|深证成指|深圳证券交易所成份|深圳成份|中小企业|中创|民企|深证民营|基本面120|上证中盘/,
    sub: "A股中盘",
    why: "中盘宽基指数",
  },
  { id: "broad-small", re: /中证1000|中证2000|国证2000|小盘/, sub: "A股小盘", why: "小盘宽基指数" },
  { id: "broad-all", re: /中证A股|上证综合|中证全指(?!行业)|全指/, sub: "A股全指", why: "全市场综合指数" },

  /* ------------------- 宽泛兜底：任何带「科技」的综合科技指数 ------------------- */
  { id: "tech-generic", re: /科技/, sub: "科技综合", why: "宽泛兜底：名称含「科技」的综合科技指数（放在最后，避免吃掉行业专有规则）" },
];

/* =========================================================================
 * 4. 排除层（不是股票/债券 ETF，现有体系没有对应小类）
 * ========================================================================= */

function exclusionReason(row) {
  const inv = row.invest_type || "";
  const name = row.name || "";
  const bm = row.benchmark || "";
  if (inv === "货币型" || row.fund_type === "货币型") return "货币型（场内货币 ETF，非股票/债券 ETF）";
  if (inv === "黄金现货合约" || /上海金|黄金现货|Au99|国内黄金现货价格/.test(bm)) {
    return "黄金现货合约（跟踪金价而非股票，现有体系无对应小类）";
  }
  if (/期货/.test(inv)) return `${inv}（商品期货 ETF，非股票/债券 ETF）`;
  if (/REIT/i.test(name)) return "REITs（不动产投资信托，非股票/债券 ETF）";
  return null;
}

/**
 * 主动管理 ETF：benchmark 只是业绩比较基准，不跟踪任何指数。
 * 若按 benchmark 归入「中证800 → A股中盘」之类，会把不看指数的主动产品塞进指数行业口径，
 * 因此这里显式不归类，交人工决定（属于「看起来能归、实际口径不成立」的典型）。
 */
function selfUnassignedReason(row) {
  const name = row.name || "";
  if (/主动管理/.test(name)) {
    return "主动管理 ETF，benchmark 仅为业绩比较基准、不跟踪特定指数，无法按指数口径归入行业小类";
  }
  return null;
}

/* =========================================================================
 * 5. 取数
 * ========================================================================= */

async function loadFundBasic(force) {
  if (!force) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(cached.rows) && cached.rows.length > 3000) {
        return { rows: cached.rows, cached: true, fetchedAt: cached.fetchedAt };
      }
    } catch {}
  }
  const d = await call("fund_basic", { market: "E" }, "ts_code,name,benchmark,invest_type,fund_type,status,list_date,delist_date");
  const idx = Object.fromEntries(d.fields.map((f, i) => [f, i]));
  const rows = d.items.map((r) => Object.fromEntries(d.fields.map((f) => [f, r[idx[f]] == null ? null : r[idx[f]]])));
  const payload = { fetchedAt: new Date().toISOString(), rows };
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
  } catch {}
  return { rows, cached: false, fetchedAt: payload.fetchedAt };
}

/* =========================================================================
 * 6. 主流程
 * ========================================================================= */

const SUBS = new Set(Object.keys(SUB));
const SUB_CAT = Object.fromEntries(Object.entries(SUB).map(([s, o]) => [s, o.cat]));
const SUB_SIZE = Object.fromEntries(Object.entries(SUB).map(([s, o]) => [s, o.etfs.length]));
const SH_CODES = new Map(); // code -> sub（沪市 773 只成分，只读）
for (const [s, o] of Object.entries(SUB)) for (const e of o.etfs) SH_CODES.set(e.code, s);

function buildIndexMap(byCode) {
  /** fingerprint -> { counts: Map<sub, n>, samples: [{code,name}] } */
  const map = new Map();
  let covered = 0;
  for (const [code, sub] of SH_CODES) {
    const f = indexFingerprint(byCode.get(code)?.benchmark);
    if (!f) continue;
    covered++;
    if (!map.has(f)) map.set(f, { counts: new Map(), samples: [] });
    const rec = map.get(f);
    rec.counts.set(sub, (rec.counts.get(sub) || 0) + 1);
    if (rec.samples.length < 3) rec.samples.push({ code, name: byCode.get(code)?.name || "" });
  }
  return { map, covered };
}

function pickSubFromCounts(counts) {
  const arr = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = arr[0];
  const tied = arr.filter(([, n]) => n === top[1]);
  return { sub: top[0], ambiguous: tied.length > 1, candidates: arr };
}

async function main() {
  const { rows, cached, fetchedAt } = await loadFundBasic(FLAG.force);
  const byCode = new Map(rows.map((r) => [String(r.ts_code).slice(0, 6), r]));
  const { map: idxMap, covered: shWithIndex } = buildIndexMap(byCode);

  const szEtfs = rows
    .filter((r) => String(r.ts_code).endsWith(".SZ") && /ETF/i.test(r.name || ""))
    .sort((a, b) => String(a.ts_code).localeCompare(String(b.ts_code)));

  const assign = {}; // 6 位代码 -> 小类
  const tiers = {}; // 6 位代码 -> index|rule|new
  const excluded = {};
  const unassigned = [];
  const conflicts = [];
  const ruleHits = new Map(); // rule id -> [{code,name}]
  const subAdded = new Map(); // sub -> [{code,tier}]

  for (const row of szEtfs) {
    const code = String(row.ts_code).slice(0, 6);
    const name = row.name || "";
    const bm = row.benchmark || "";
    const fp = indexFingerprint(bm);

    const excl = exclusionReason(row);
    if (excl) {
      excluded[code] = excl;
      continue;
    }

    const sticky = selfUnassignedReason(row);
    if (sticky) {
      unassigned.push({ code, name, benchmark: bm, indexFingerprint: fp, reason: sticky });
      continue;
    }

    // ---- 1) index 级：与沪市成分指数指纹完全同名 ----
    const hit = fp ? idxMap.get(fp) : null;
    if (hit) {
      const { sub, ambiguous, candidates } = pickSubFromCounts(hit.counts);
      if (ambiguous) {
        conflicts.push({
          code,
          name,
          indexFingerprint: fp,
          candidates: candidates.map(([s, n]) => `${s}(${n})`),
          picked: sub,
          note: "指数指纹同时命中多个小类，按沪市成分数多者归属，请人工确认",
        });
      }
      assign[code] = sub;
      tiers[code] = "index";
      continue;
    }

    // ---- 2) rule 级 / 3) new 级 ----
    const subject = `${fp} ${cleanFundName(name)}`;
    let matched = null;
    for (const rule of RULES) {
      if (rule.re.test(subject)) {
        matched = rule;
        break;
      }
    }
    if (matched) {
      assign[code] = matched.sub;
      tiers[code] = SUBS.has(matched.sub) ? "rule" : "new";
      if (!ruleHits.has(matched.id)) ruleHits.set(matched.id, []);
      ruleHits.get(matched.id).push({ code, name });
      continue;
    }

    // ---- 4) unassigned ----
    unassigned.push({ code, name, benchmark: bm, indexFingerprint: fp, reason: unassignedReason(row, fp) });
  }

  for (const [code, sub] of Object.entries(assign)) {
    if (!subAdded.has(sub)) subAdded.set(sub, []);
    subAdded.get(sub).push({ code, tier: tiers[code] });
  }

  /* ------------------------------ 自检 ------------------------------ */
  const badSubs = [...new Set(Object.values(assign))].filter((s) => !SUBS.has(s) && !NEW_SUBS[s]);
  if (badSubs.length) throw new Error(`归到了不存在的 小类: ${badSubs.join(",")}`);
  const shCollision = Object.keys(assign).filter((c) => SH_CODES.has(c));
  if (shCollision.length) throw new Error(`assign 里出现沪市成分代码: ${shCollision.join(",")}`);
  const badCat = Object.values(NEW_SUBS).filter((n) => !CATS.some((c) => c.key === n.cat));
  if (badCat.length) throw new Error("新小类所属大类不存在");
  const dupCode = Object.keys(assign).filter((c) => c in excluded);
  if (dupCode.length) throw new Error(`assign/excluded 重复: ${dupCode.join(",")}`);

  const ruleZeroHitCount = RULES.filter((r) => !(ruleHits.get(r.id) || []).length).length;
  const counts = { index: 0, rule: 0, new: 0, unassigned: unassigned.length };
  for (const t of Object.values(tiers)) counts[t]++;
  counts.szEtfTotal = szEtfs.length;
  counts.excluded = Object.keys(excluded).length;
  counts.classifiable = counts.szEtfTotal - counts.excluded;
  counts.assigned = counts.index + counts.rule + counts.new;
  counts.coverage = +(counts.assigned / counts.classifiable).toFixed(4);
  counts.coverageOfAll = +(counts.assigned / counts.szEtfTotal).toFixed(4);
  counts.delisted = szEtfs.filter((r) => r.delist_date).length;

  /* ------------------------------ universe.json ------------------------------ */
  // names / sources 是给 lib/universe.mjs 合并时用的（否则深市成分只有代码没有名称、也分不清归属层级）
  const names = Object.fromEntries(Object.keys(assign).map((c) => [c, byCode.get(c)?.name || c]));
  const sources = Object.fromEntries(Object.entries(tiers));

  const universe = {
    generatedAt: new Date().toISOString(),
    assign: sortObj(assign),
    names: sortObj(names),
    sources: sortObj(sources),
    newSubs: Object.fromEntries(
      Object.entries(NEW_SUBS).map(([s, meta]) => [
        s,
        { cat: meta.cat, color: meta.color, baseOn: meta.baseOn, reason: meta.reason, count: (subAdded.get(s) || []).length },
      ])
    ),
    excluded: sortObj(excluded),
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(universe, null, 2) + "\n");

  /* --------------------------------- 报告 --------------------------------- */
  const subIncrements = [...subAdded.entries()]
    .map(([sub, list]) => {
      const before = SUB_SIZE[sub] ?? 0;
      return {
        sub,
        cat: SUB_CAT[sub] || NEW_SUBS[sub]?.cat || "",
        before,
        added: list.length,
        after: before + list.length,
        tiers: tally(list.map((x) => x.tier)),
        isNew: !SUBS.has(sub),
      };
    })
    .sort((a, b) => b.added - a.added);

  const ruleTable = RULES.map((r) => ({
    id: r.id,
    sub: r.sub,
    pattern: String(r.re),
    why: r.why,
    hits: (ruleHits.get(r.id) || []).length,
    examples: (ruleHits.get(r.id) || []).slice(0, 5).map((x) => `${x.code} ${x.name}`),
  }));

  const report = {
    generatedAt: universe.generatedAt,
    source: {
      benchmark: "Tushare fund_basic(market=E) · benchmark / invest_type",
      taxonomy: "lib/taxonomy.mjs（86 小类 / 773 只沪市成分，只读）",
      fetchedAt,
      fromCache: cached,
      shComponents: SH_CODES.size,
      shComponentsWithIndex: shWithIndex,
      szEtfRows: counts.szEtfTotal,
      szDelisted: counts.delisted,
      distinctSzIndexFingerprints: new Set(szEtfs.map((r) => indexFingerprint(r.benchmark)).filter(Boolean)).size,
    },
    counts,
    verdicts: {
      tierMeaning: {
        index: "指数指纹与沪市成分完全同名，直接继承该成分的小类",
        rule: "命中 RULES 关键词规则，归入现有 86 小类之一",
        new: "命中 RULES 但目标是 newSubs 里的新增小类",
        unassigned: "既不匹配指数指纹也不匹配任何规则，交人工判断",
      },
      ruleZeroHitNote:
        "零命中规则有意保留：这些主题的指数在沪市已有同名成分，当前全部由 index 级承接；" +
        "保留规则是为了深市后续新发同主题 ETF、或沪市该指数退市后仍有兜底。",
    },
    conflicts,
    unassignedTotal: unassigned.length,
    unassigned,
    unassignedByReason: tally(unassigned.map((u) => u.reason.slice(0, 24))),
    ruleTable,
    ruleZeroHit: ruleTable.filter((r) => r.hits === 0).map((r) => r.id),
    subIncrements,
    subIncrementsTop20: subIncrements.slice(0, 20),
    newSubs: universe.newSubs,
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + "\n");

  /* -------------------------------- 终端输出 -------------------------------- */
  console.log(`深市 ETF：${counts.szEtfTotal} 只（可归类 ${counts.classifiable}，排除 ${counts.excluded}）`);
  console.log(
    `index ${counts.index} / rule ${counts.rule} / new ${counts.new} / unassigned ${counts.unassigned}  ` +
      `→ 覆盖率 ${(counts.coverage * 100).toFixed(2)}%（占 ${counts.szEtfTotal} 全量 ${(counts.coverageOfAll * 100).toFixed(2)}%）`
  );
  console.log(`冲突 ${conflicts.length} 条；新增小类 ${Object.keys(NEW_SUBS).length} 个；规则 ${RULES.length} 条（零命中 ${ruleZeroHitCount} 条，均为被 index 级覆盖的兜底）`);
  console.log(`写出 ${path.relative(ROOT, OUT_FILE)}（${fs.statSync(OUT_FILE).size} B）、${path.relative(ROOT, REPORT_FILE)}`);
  console.log(`Top 增量小类：`);
  for (const s of subIncrements.slice(0, 10)) {
    console.log(`  ${s.sub.padEnd(12, " ")} ${String(s.cat).padEnd(12, " ")} +${String(s.added).padStart(3)}  (${s.before} → ${s.after})`);
  }

  if (ruleTable.some((r) => r.hits === 0)) {
    console.log(`零命中规则：${ruleTable.filter((r) => r.hits === 0).map((r) => r.id).join(", ")}`);
  }

  if (FLAG.review) {
    console.log(`\n===== 人工复核清单 =====`);
    console.log(`\n-- 未归类（${unassigned.length} 只）--`);
    for (const u of unassigned) console.log(`${u.code} ${u.name} | 指纹=${u.indexFingerprint} | ${u.reason}`);
    console.log(`\n-- 每条规则命中数（${ruleTable.length} 条）--`);
    for (const r of ruleTable) console.log(`${String(r.hits).padStart(4)}  ${r.id.padEnd(18, " ")} → ${r.sub}`);
    console.log(`\n-- 冲突（${conflicts.length}）--`);
    for (const c of conflicts) console.log(`${c.code} ${c.name} ${JSON.stringify(c.candidates)} → ${c.picked}`);
  }
}

/* =========================================================================
 * 7. V2 两层分类：7 大类（宽基/行业/主题/策略风格/债券/跨境/商品）× 小类
 *
 *  第一层 = ETF 产品/指数类别（对标 Wind / 同花顺的一级分类）
 *  第二层 = 小类；industry 的第二层严格用申万一级 31 行业名
 *
 * 用法：node scripts/classify.mjs --v2 [--report] [--review] [--force] [--dry-run]
 * ========================================================================= */

const V2_OUT = path.join(ROOT, "data", "classification-v2.json");
const V2_REPORT = path.join(ROOT, "data", "classification-v2-report.json");
const IDX_CACHE = path.join(os.tmpdir(), `etf-flow-indexbasic-${new Date().toISOString().slice(0, 10)}.json`);

const V2_CATS = [
  { key: "broad", label: "宽基", color: "#D16F3F", desc: "规模指数：沪深300/中证500/1000/2000、创业板、科创板、A500、全指、港股宽基、海外宽基" },
  { key: "industry", label: "行业", color: "#3F70D1", desc: "申万一级 31 行业口径的行业指数 ETF" },
  { key: "theme", label: "主题", color: "#B23FB2", desc: "跨行业主题：人工智能、半导体芯片、机器人、新能源车、航空航天…" },
  { key: "strategy", label: "策略风格", color: "#B8A02A", desc: "红利/低波/价值/成长/现金流/ESG/等权" },
  { key: "bond", label: "债券", color: "#2FA8A0", desc: "利率债/信用债/可转债/科创债/地方债" },
  { key: "crossborder", label: "跨境", color: "#3E9E5A", desc: "跟踪境外行业/主题指数的 ETF（港股通 QDII 等）；境外宽基归 宽基" },
  { key: "commodity", label: "商品", color: "#8C6A2F", desc: "黄金现货、商品期货（豆粕/有色/能源化工）" },
];
const V2_CAT_BY_KEY = Object.fromEntries(V2_CATS.map((c) => [c.key, c]));

/** 申万一级 31 行业（对应 index_basic 的 801010.SI … ） */
const SW_L1 = [
  "农林牧渔", "基础化工", "钢铁", "有色金属", "电子", "家用电器", "食品饮料", "纺织服饰", "轻工制造",
  "医药生物", "公用事业", "交通运输", "房地产", "商贸零售", "社会服务", "综合", "建筑材料", "建筑装饰",
  "电力设备", "国防军工", "计算机", "传媒", "通信", "银行", "非银金融", "汽车", "机械设备", "煤炭",
  "石油石化", "环保", "美容护理",
];

/** 第二层小类定义（顺序即大类内的展示顺序） */
const V2_SUBS = [
  // ---- broad ----
  { sub: "沪深300", cat: "broad" },
  { sub: "中证500", cat: "broad" },
  { sub: "中证1000", cat: "broad" },
  { sub: "中证2000", cat: "broad" },
  { sub: "中证A500", cat: "broad" },
  { sub: "大盘宽基", cat: "broad" },
  { sub: "中盘宽基", cat: "broad" },
  { sub: "A股全指", cat: "broad" },
  { sub: "创业板宽基", cat: "broad" },
  { sub: "科创板宽基", cat: "broad" },
  { sub: "沪深港宽基", cat: "broad" },
  // ---- industry（申万一级）----
  { sub: "银行", cat: "industry", sw: "银行" },
  { sub: "非银金融", cat: "industry", sw: "非银金融" },
  { sub: "医药生物", cat: "industry", sw: "医药生物" },
  { sub: "食品饮料", cat: "industry", sw: "食品饮料" },
  { sub: "农林牧渔", cat: "industry", sw: "农林牧渔" },
  { sub: "家用电器", cat: "industry", sw: "家用电器" },
  { sub: "汽车", cat: "industry", sw: "汽车" },
  { sub: "电力设备", cat: "industry", sw: "电力设备" },
  { sub: "公用事业", cat: "industry", sw: "公用事业" },
  { sub: "交通运输", cat: "industry", sw: "交通运输" },
  { sub: "房地产", cat: "industry", sw: "房地产" },
  { sub: "建筑装饰", cat: "industry", sw: "建筑装饰" },
  { sub: "建筑材料", cat: "industry", sw: "建筑材料" },
  { sub: "机械设备", cat: "industry", sw: "机械设备" },
  { sub: "国防军工", cat: "industry", sw: "国防军工" },
  { sub: "计算机", cat: "industry", sw: "计算机" },
  { sub: "传媒", cat: "industry", sw: "传媒" },
  { sub: "通信", cat: "industry", sw: "通信" },
  { sub: "电子", cat: "industry", sw: "电子" },
  { sub: "有色金属", cat: "industry", sw: "有色金属" },
  { sub: "石油石化", cat: "industry", sw: "石油石化" },
  { sub: "基础化工", cat: "industry", sw: "基础化工" },
  { sub: "环保", cat: "industry", sw: "环保" },
  { sub: "社会服务", cat: "industry", sw: "社会服务" },
  // ---- theme ----
  { sub: "人工智能", cat: "theme" },
  { sub: "半导体芯片", cat: "theme" },
  { sub: "机器人", cat: "theme" },
  { sub: "新能源车", cat: "theme" },
  { sub: "云计算与数据", cat: "theme" },
  { sub: "科技综合", cat: "theme" },
  { sub: "互联网", cat: "theme" },
  { sub: "金融科技", cat: "theme" },
  { sub: "航空航天", cat: "theme" },
  { sub: "央国企改革", cat: "theme" },
  { sub: "区域发展", cat: "theme" },
  { sub: "金融地产", cat: "theme" },
  { sub: "消费综合", cat: "theme" },
  // ---- strategy ----
  { sub: "红利股息", cat: "strategy" },
  { sub: "红利低波", cat: "strategy" },
  { sub: "价值策略", cat: "strategy" },
  { sub: "成长策略", cat: "strategy" },
  { sub: "现金流策略", cat: "strategy" },
  { sub: "ESG治理", cat: "strategy" },
  { sub: "综合策略", cat: "strategy" },
  { sub: "质量策略", cat: "strategy" },
  // ---- bond ----
  { sub: "利率债", cat: "bond" },
  { sub: "信用债", cat: "bond" },
  { sub: "科创债", cat: "bond" },
  { sub: "地方债", cat: "bond" },
  // ---- crossborder ----
  { sub: "港股科技", cat: "crossborder" },
  { sub: "港股互联网", cat: "crossborder" },
  { sub: "港股医药", cat: "crossborder" },
  { sub: "港股消费", cat: "crossborder" },
  { sub: "港股金融", cat: "crossborder" },
  { sub: "港股红利", cat: "crossborder" },
  { sub: "港股汽车", cat: "crossborder" },
  { sub: "海外行业", cat: "crossborder" },
  { sub: "港股宽基", cat: "crossborder" },
  { sub: "海外宽基", cat: "crossborder" },
  // ---- commodity ----
  { sub: "黄金", cat: "commodity" },
  { sub: "商品期货", cat: "commodity" },
];
const V2_SUB_DEF = Object.fromEntries(V2_SUBS.map((s) => [s.sub, s]));

/* ------------------------------ 匹配表 ------------------------------ */

/** 商品：现货黄金 / 商品期货（黄金股不在此列，走行业「有色金属」） */
function v2Commodity(meta) {
  const it = meta.invest_type || "";
  const bm = meta.benchmark || "";
  const nm = meta.name || "";
  if (it === "黄金现货合约" || /上海金|黄金现货|Au99|国内黄金现货/.test(bm)) return "黄金";
  if (/期货/.test(it) || /期货/.test(nm) || /豆粕|白银期货|能源化工|有色金属期货/.test(bm)) return "商品期货";
  return null;
}

/** 债券：基金类型/名称/基准任一命中 */
function v2IsBond(meta) {
  if (meta.fund_type === "债券型") return true;
  if (/债/.test(meta.fp || "")) return true;
  if (/债/.test(meta.name || "")) return true;
  return false;
}
const V2_BOND = [
  { sub: "科创债", re: /科技创新公司债|科创债/ },
  { sub: "地方债", re: /地方政府债|地方债/ },
  { sub: "利率债", re: /国债|国开|政策性金融|政金|金边|利率债|中期票据/ },
  { sub: "信用债", re: /信用债|公司债|城投|短融|融资券|做市|金融债|企债|产业债|可转债|可交换债|转债/ },
];

/** 跨境：跟踪境外指数（沪港深是 A+HK 混合，不算纯境外；恒生A股 系列也不算） */
function v2IsOverseas(meta) {
  const fp = meta.fp || "";
  const nm = meta.name || "";
  const s = `${fp} ${nm}`;
  if (/沪港深/.test(fp)) return false;
  if (/A股/.test(fp)) return false;
  if (/标普中国新经济|国企开放共赢|富时中国A股|标普中国A股|MSCI中国A股|中证海外中国互联网30/.test(fp)) return false;
  if (/港股|恒生|香港|恒指|H股/.test(s)) return true;
  if (/纳斯达克|标普500|标普生物科技|标普石油天然气|标普消费精选|MSCI美国|日经|DAX|德国|法国|欧洲|沙特|巴西|亚太|印度|越南|美国50|全球中国|东南亚|新交所/.test(s)) return true;
  return false;
}
const V2_CROSSBORDER = [
  { sub: "港股互联网", re: /港股通互联网|恒生互联网科技业|海外中国互联网/ },
  { sub: "港股科技", re: /港股通.*科技|恒生科技|香港科技|港股通信息技术|恒生港股通科技|中国科技/ },
  { sub: "港股医药", re: /港股通(创新药|医疗|医药|生物)|恒生.*(生物科技|医疗保健|创新药|医药)|香港(创新药|医疗|医药)/ },
  { sub: "港股消费", re: /港股通消费|恒生消费/ },
  { sub: "港股金融", re: /港股通内地金融|港股通非银|港股通金融|香港银行|港股通内地银行/ },
  { sub: "港股红利", re: /港股通.*(高股息|红利|低波)|恒生.*(红利|高股息)|标普港股通低波红利|港股通中国内地企业红利/ },
  { sub: "港股汽车", re: /港股通汽车/ },
  { sub: "海外行业", re: /标普生物科技|标普石油天然气|标普消费精选|纳斯达克科技|纳斯达克生物科技|新交所|东南亚|全球中国|中国教育主题/ },
  // 境外宽基也是跨境（对标万得分类）；放在最后，保证行业/主题优先
  { sub: "港股宽基", re: /港股通50|恒生指数|恒生中国企业|恒指港股通|香港恒生|港股通中国100|恒生中国30|港股通精选100|上证港股通|沪深港300|恒生$/ },
  { sub: "海外宽基", re: /纳斯达克|标普500|MSCI美国|日经|DAX|美国50|沙特|巴西|亚太精选|富时亚太|法国CAC|道琼斯|东证|TOPIX|亚洲精选/ },
];

/** 主题（跨行业强主题，先于行业判定，避免「半导体」被算进电子） */
const V2_THEME = [
  { sub: "人工智能", kw: "人工智能", re: /人工智能/ },
  { sub: "半导体芯片", kw: "半导体/芯片", re: /半导体|芯片|集成电路/ },
  { sub: "机器人", kw: "机器人/智能制造", re: /机器人|智能制造|机床|数控/ },
  { sub: "新能源车", kw: "新能源车", re: /新能源车(?!电池)|智能电动|新能源汽车(?!电池)/ },
  { sub: "云计算与数据", kw: "云计算/大数据/物联网", re: /云计算|大数据|物联网|数字经济|算力|工业互联网|数据要素/ },
  { sub: "互联网", kw: "互联网", re: /互联网(?!医疗)/ },
  { sub: "金融科技", kw: "金融科技", re: /金融科技/ },
  // 金融地产是银行+非银+地产的复合行业，申万无对应一级行业 → 归主题
  { sub: "金融地产", kw: "金融地产综合", re: /金融地产/ },
  { sub: "航空航天", kw: "卫星/航天/航空", re: /卫星|航天|航空/ },
  { sub: "科技综合", kw: "科技综合/TMT", re: /电子信息传媒|信息技术综合|全指信息技术|新一代信息技术|科技龙头|科技50|科技100|研发创新|先进制造|专精特新|新兴产业|科技/ },
  { sub: "消费综合", kw: "消费综合", re: /消费(?!电子)/ },
];

/** 申万一级行业关键词（顺序=优先级，先专有后宽泛） */
const V2_INDUSTRY = [
  { sw: "非银金融", re: /证券公司|证券行业|证券龙头|券商|保险|非银|非银行|多元金融|金融(?!科技)/ },
  { sw: "银行", re: /银行/ },
  { sw: "建筑材料", re: /建筑材料|建材|水泥/ },
  { sw: "建筑装饰", re: /基建|建筑装饰|建筑工程/ },
  { sw: "有色金属", re: /新能源金属/ },
  { sw: "电力设备", re: /光伏|电池|储能|风电|风能|绿色能源|电网设备|电力设备|输变电|新能源/ },
  { sw: "公用事业", re: /电力|公用事业|水务|燃气|绿电/ },
  { sw: "交通运输", re: /运输|物流|交通|航运|港口|机场|高速公路/ },
  { sw: "房地产", re: /地产|房地产/ },
  { sw: "机械设备", re: /工程机械|机械设备|中证全指工业|中证500工业|工业指数|装备|机械/ },
  { sw: "国防军工", re: /军工|国防|船舶/ },
  { sw: "计算机", re: /软件|计算机|信息技术应用创新|信创|信息安全|网络安全|信息技术/ },
  { sw: "传媒", re: /传媒|游戏|影视|文娱|动漫/ },
  { sw: "通信", re: /通信|5G|电信|光模块/ },
  { sw: "电子", re: /消费电子|电子|元件|光学/ },
  { sw: "有色金属", re: /有色金属|工业金属|矿业|稀土|稀有金属|黄金产业|贵金属|大宗商品|自然资源/ },
  { sw: "石油石化", re: /石油|天然气|油气|石化产业|煤炭|焦煤|能源/, mergeNote: "煤炭并入石油石化（能源类）" },
  { sw: "基础化工", re: /化工|石化|新材料|原材料/ },
  { sw: "有色金属", re: /钢铁/, mergeNote: "钢铁（深市仅 1 只）并入有色金属" },
  { sw: "环保", re: /环保|低碳|碳中和|长江保护|环境治理|节能/ },
  { sw: "社会服务", re: /旅游|酒店|餐饮|免税|教育|养老/ },
  { sw: "食品饮料", re: /食品|饮料|白酒|酒类|中证酒/ },
  { sw: "农林牧渔", re: /农业|农牧|畜牧|养殖|种业|粮食|饲料/ },
  { sw: "家用电器", re: /家电|家用电器|家居/ },
  { sw: "汽车", re: /汽车|零部件|车联网|智能驾驶|自动驾驶/ },
  { sw: "医药生物", re: /医药|医疗|生物|中药|疫苗|制药|创新药|健康/ },
  { sw: "纺织服饰", re: /纺织|服装/ },
  { sw: "轻工制造", re: /轻工|造纸|包装/ },
  { sw: "商贸零售", re: /商贸|零售|百货/ },
  { sw: "美容护理", re: /美容|化妆品|护理/ },
];

/** 策略风格 */
const V2_STRATEGY = [
  { sub: "质量策略", re: /质量|基本面/ },
  { sub: "红利低波", re: /红利低波|低波动/ },
  { sub: "红利股息", re: /红利|高股息|股息/ },
  { sub: "现金流策略", re: /自由现金流|现金流/ },
  { sub: "价值策略", re: /价值/ },
  { sub: "成长策略", re: /成长/ },
  { sub: "ESG治理", re: /ESG|社会责任|公司治理|可持续发展/ },
  { sub: "综合策略", re: /等权重|小康|AH优选|央视财经|新经济|周期行业50|非周期行业|核心竞争力/ },
];

/** 宽基（最后兜底；规模指数命名沿用，碎片已合并） */
const V2_BROAD = [
  { sub: "沪深300", re: /沪深300/ },
  { sub: "中证500", re: /中证500|中证小盘500/ },
  { sub: "中证1000", re: /中证1000/ },
  { sub: "中证2000", re: /中证2000|国证2000/ },
  { sub: "中证A500", re: /中证A500/ },
  { sub: "创业板宽基", re: /^创业板|创业板(50|200|300|综合|大盘)|创业板中盘精选/ },
  { sub: "科创板宽基", re: /科创(板|50|100|200|综指)|双创|科创创业50/ },
  { sub: "沪深港宽基", re: /沪港深(500|300)/ },
  { sub: "大盘宽基", re: /上证50|上证180|上证380|中证A50|中证A100|中证100|深证100|深证50|深证300|深证主板50|深证成指|基本面|MSCI中国A|富时中国A50|超大盘|超级大盘|上证市值100/ },
  { sub: "中盘宽基", re: /中证800|上证中盘|中证700|上证580/ },
  { sub: "A股全指", re: /中证全指|中证A股|上证综合|上证综指|国证A指|央视财经|民企|民营企业|中证流通/ },
];

/** 「晚段主题」：必须在策略之后（否则央企红利会被算成央国企改革） */
const V2_THEME_LATE = [
  { sub: "央国企改革", kw: "央企/国企改革", re: /国企改革|央企|国资|国有企业/ },
  { sub: "区域发展", kw: "区域主题", re: /中关村|成渝|浙江|湖北|大湾区|雄安|京津冀|长三角|一带一路|G60|自贸区|东北振兴|福建50|北京50|杭州湾|张江|上海改革/ },
];

/* --------------------- 旧 88 小类 → V2 小类（对照表） --------------------- */
const V1_TO_V2 = {
  科创板宽基: { cat: "broad", sub: "科创板宽基" },
  A股全指: { cat: "broad", sub: "A股全指" },
  A股大盘: { cat: "broad", sub: "大盘宽基" },
  A股中盘: { cat: "broad", sub: "中盘宽基" },
  A股小盘: { cat: "broad", sub: "中证1000" },
  沪深港宽基: { cat: "broad", sub: "沪深港宽基" },
  港股宽基: { cat: "broad", sub: "港股宽基" },
  创业板宽基: { cat: "broad", sub: "创业板宽基" },
  海外宽基: { cat: "broad", sub: "海外宽基" },
  红利股息: { cat: "strategy", sub: "红利股息" },
  港红利股息: { cat: "crossborder", sub: "港股红利" },
  价值策略: { cat: "strategy", sub: "价值策略" },
  红利低波: { cat: "strategy", sub: "红利低波" },
  现金流策略: { cat: "strategy", sub: "现金流策略" },
  成长策略: { cat: "strategy", sub: "成长策略" },
  央国企改革: { cat: "theme", sub: "央国企改革" },
  ESG治理: { cat: "strategy", sub: "ESG治理" },
  区域发展: { cat: "theme", sub: "区域发展" },
  综合策略: { cat: "strategy", sub: "综合策略" },
  人工智能: { cat: "theme", sub: "人工智能" },
  软件与信创: { cat: "industry", sub: "计算机", sw: "计算机" },
  科技综合: { cat: "theme", sub: "科技综合" },
  半导体芯片: { cat: "theme", sub: "半导体芯片" },
  互联网: { cat: "theme", sub: "互联网" },
  金融科技: { cat: "theme", sub: "金融科技" },
  云计算与数据: { cat: "theme", sub: "云计算与数据" },
  通信: { cat: "industry", sub: "通信", sw: "通信" },
  消费电子: { cat: "industry", sub: "电子", sw: "电子" },
  传媒游戏: { cat: "industry", sub: "传媒", sw: "传媒" },
  汽车与零部件: { cat: "industry", sub: "汽车", sw: "汽车" },
  工程机械: { cat: "industry", sub: "机械设备", sw: "机械设备" },
  船舶: { cat: "industry", sub: "国防军工", sw: "国防军工" },
  航空航天: { cat: "theme", sub: "航空航天" },
  智能制造与机器人: { cat: "theme", sub: "机器人" },
  高端装备: { cat: "industry", sub: "机械设备", sw: "机械设备" },
  国防军工: { cat: "industry", sub: "国防军工", sw: "国防军工" },
  电力: { cat: "industry", sub: "公用事业", sw: "公用事业" },
  电池: { cat: "industry", sub: "电力设备", sw: "电力设备" },
  光伏: { cat: "industry", sub: "电力设备", sw: "电力设备" },
  新能源综合: { cat: "industry", sub: "电力设备", sw: "电力设备" },
  公用事业: { cat: "industry", sub: "公用事业", sw: "公用事业" },
  风电与绿色能源: { cat: "industry", sub: "电力设备", sw: "电力设备" },
  环保与碳中和: { cat: "industry", sub: "环保", sw: "环保" },
  新能源汽车: { cat: "theme", sub: "新能源车" },
  有色金属: { cat: "industry", sub: "有色金属", sw: "有色金属" },
  稀有金属: { cat: "industry", sub: "有色金属", sw: "有色金属" },
  新材料: { cat: "industry", sub: "基础化工", sw: "基础化工" },
  油气: { cat: "industry", sub: "石油石化", sw: "石油石化" },
  贵金属: { cat: "industry", sub: "有色金属", sw: "有色金属" },
  能源综合: { cat: "industry", sub: "石油石化", sw: "石油石化" },
  石化化工: { cat: "industry", sub: "基础化工", sw: "基础化工" },
  钢铁: { cat: "industry", sub: "有色金属", sw: "有色金属" },
  煤炭: { cat: "industry", sub: "石油石化", sw: "石油石化" },
  资源综合: { cat: "industry", sub: "有色金属", sw: "有色金属" },
  食品饮料: { cat: "industry", sub: "食品饮料", sw: "食品饮料" },
  家电家居: { cat: "industry", sub: "家用电器", sw: "家用电器" },
  畜牧养殖: { cat: "industry", sub: "农林牧渔", sw: "农林牧渔" },
  农业: { cat: "industry", sub: "农林牧渔", sw: "农林牧渔" },
  消费综合: { cat: "theme", sub: "消费综合" },
  交通物流: { cat: "industry", sub: "交通运输", sw: "交通运输" },
  旅游: { cat: "industry", sub: "社会服务", sw: "社会服务" },
  品牌消费: { cat: "theme", sub: "消费综合" },
  养老服务: { cat: "industry", sub: "社会服务", sw: "社会服务" },
  教育: { cat: "industry", sub: "社会服务", sw: "社会服务" },
  白酒: { cat: "industry", sub: "食品饮料", sw: "食品饮料" },
  医药综合: { cat: "industry", sub: "医药生物", sw: "医药生物" },
  创新药: { cat: "industry", sub: "医药生物", sw: "医药生物" },
  生物医药: { cat: "industry", sub: "医药生物", sw: "医药生物" },
  医疗器械: { cat: "industry", sub: "医药生物", sw: "医药生物" },
  疫苗: { cat: "industry", sub: "医药生物", sw: "医药生物" },
  中药: { cat: "industry", sub: "医药生物", sw: "医药生物" },
  医疗服务与互联网医疗: { cat: "industry", sub: "医药生物", sw: "医药生物" },
  券商: { cat: "industry", sub: "非银金融", sw: "非银金融" },
  保险与非银: { cat: "industry", sub: "非银金融", sw: "非银金融" },
  金融综合: { cat: "industry", sub: "非银金融", sw: "非银金融" },
  银行: { cat: "industry", sub: "银行", sw: "银行" },
  建筑材料: { cat: "industry", sub: "建筑材料", sw: "建筑材料" },
  基础设施: { cat: "industry", sub: "建筑装饰", sw: "建筑装饰" },
  房地产: { cat: "industry", sub: "房地产", sw: "房地产" },
  科创债: { cat: "bond", sub: "科创债" },
  信用债: { cat: "bond", sub: "信用债" },
  短期利率债: { cat: "bond", sub: "利率债" },
  超长期国债: { cat: "bond", sub: "利率债" },
  中长期利率债: { cat: "bond", sub: "利率债" },
  短期融资券: { cat: "bond", sub: "信用债" },
  可转债与可交换债: { cat: "bond", sub: "信用债" },
  地方政府债: { cat: "bond", sub: "地方债" },
  城投债: { cat: "bond", sub: "信用债" },
};

/* ------------------------------ 工具 ------------------------------ */

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return ("#" + to(r) + to(g) + to(b)).toUpperCase();
}

function shadeHex(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const target = t > 0 ? 255 : 0;
  const a = Math.abs(t);
  r = Math.round(r + (target - r) * a);
  g = Math.round(g + (target - g) * a);
  b = Math.round(b + (target - b) * a);
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * 大类内取不同明度的颜色：把大类主色的 HSL 拆开，按小类序号在 30%~72% 明度区间均匀铺开，
 * 并做 ±3° 的色相微扰 + 轻微饱和度扰动，保证同一大类内不撞色、且与相邻大类色系区分。
 */
function v2Colors() {
  const out = {};
  for (const cat of V2_CATS) {
    const list = V2_SUBS.filter((s) => s.cat === cat.key);
    const { h, s } = hexToHsl(cat.color);
    const n = list.length;
    list.forEach((sub, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const L = 0.3 + t * 0.42;
      const S = Math.min(0.88, Math.max(0.32, s + ((i % 3) - 1) * 0.07));
      const H = (h + ((i % 4) - 1.5) * 3 + 360) % 360;
      out[sub.sub] = hslToHex(H, S, L);
    });
  }
  return out;
}

function firstMatch(table, subject, key) {
  for (const r of table) if (r.re.test(subject)) return r;
  return null;
}

/* ------------------------------ 取指数库 ------------------------------ */

async function loadIndexBasic(force) {
  if (!force) {
    try {
      const c = JSON.parse(fs.readFileSync(IDX_CACHE, "utf8"));
      if (Array.isArray(c.rows) && c.rows.length > 5000) return { rows: c.rows, cached: true, fetchedAt: c.fetchedAt };
    } catch {}
  }
  const rows = [];
  for (const market of ["SSE", "SZSE", "CSI", "SW"]) {
    const d = await call("index_basic", { market }, "ts_code,name,market,publisher,category,base_date,list_date");
    const idx = Object.fromEntries(d.fields.map((f, i) => [f, i]));
    for (const r of d.items) {
      rows.push({
        ts_code: r[idx.ts_code],
        name: r[idx.name],
        market: r[idx.market],
        publisher: r[idx.publisher],
        category: r[idx.category],
        qmarket: market,
      });
    }
  }
  const payload = { fetchedAt: new Date().toISOString(), rows };
  try { fs.writeFileSync(IDX_CACHE, JSON.stringify(payload)); } catch {}
  return { rows, cached: false, fetchedAt: payload.fetchedAt };
}

/** 指数名 → category：把 ETF 的指数指纹与指数库做「包含匹配」，取最长命中 */
function buildIndexMatcher(rows) {
  const seen = new Map();
  for (const r of rows) {
    if (!r.name) continue;
    const key = String(r.name).replace(/[ⅠⅡ]/g, "").replace(/\(全\)|（全）/g, "").replace(/指数$/, "").trim();
    if (key.length < 3) continue;
    if (/^[A-Z]{1,6}\d|EUR|USD|HKD|GBP|JPY|CNY/.test(key)) continue; // 外币/变体
    if (!seen.has(key)) seen.set(key, { name: key, category: r.category, code: r.ts_code, raw: r.name, qmarket: r.qmarket });
  }
  const list = [...seen.values()].sort((a, b) => b.name.length - a.name.length);
  return (fp) => {
    if (!fp) return null;
    for (const n of list) if (fp.includes(n.name)) return n;
    return null;
  };
}

/* ------------------------------ 主判定 ------------------------------ */

function v2Decide(meta, idx) {
  const subj = `${meta.fp} ${meta.clean}`;
  const idxCat = idx?.category || null;

  // 0) 货币 / 主动管理 —— v2 的 7 大类不含货币；主动管理无跟踪指数
  if (meta.invest_type === "货币型" || meta.fund_type === "货币型") {
    return { excluded: "货币型 ETF（v2 的 7 大类不含货币）" };
  }
  if (/主动管理/.test(meta.name)) {
    return { excluded: "主动管理 ETF，benchmark 仅为业绩比较基准、不跟踪指数" };
  }
  // 1) 商品
  const comm = v2Commodity(meta);
  if (comm) return { cat: "commodity", sub: comm, src: comm === "黄金" ? "commodity:黄金现货" : "commodity:商品期货", route: "商品" };

  // 2) 债券
  if (v2IsBond(meta)) {
    const b = firstMatch(V2_BOND, subj);
    if (b) return { cat: "bond", sub: b.sub, src: `bond:${b.sub}`, route: "债券" };
  }
  // 3) 跨境（境外行业/主题；境外宽基留给 broad）
  if (v2IsOverseas(meta)) {
    const cb = firstMatch(V2_CROSSBORDER, subj);
    if (cb) return { cat: "crossborder", sub: cb.sub, src: `crossborder:${cb.sub}`, route: "跨境" };
  }
  // 3.5) 医药生物：单行业医药类要先于「科技」判定（否则「疫苗与生物科技」会被算进科技综合）
  if (/疫苗|生物(医药|科技)|医药|医疗|中药|制药|创新药/.test(subj)) {
    return { cat: "industry", sub: "医药生物", sw: "医药生物", src: "sw:医药生物", route: "行业" };
  }
  // 4) 主题（强主题，先于行业）
  const th = firstMatch(V2_THEME, subj);
  if (th) return { cat: "theme", sub: th.sub, src: `theme:${th.kw}`, route: "主题" };

  // 5) 行业（申万一级）
  const ind = firstMatch(V2_INDUSTRY, subj);
  if (ind) return { cat: "industry", sub: ind.sw, sw: ind.sw, src: `sw:${ind.sw}`, route: "行业" };

  // 6) 策略风格
  const st = firstMatch(V2_STRATEGY, subj);
  if (st) {
    const src = idxCat === "策略指数" || idxCat === "风格指数" ? `index:${idxCat}` : "rule";
    return { cat: "strategy", sub: st.sub, src, route: "策略" };
  }

  // 7) 晚段主题（央国企/区域），必须在策略之后
  const late = firstMatch(V2_THEME_LATE, subj);
  if (late) return { cat: "theme", sub: late.sub, src: `theme:${late.kw}`, route: "主题" };

  // 8) 宽基
  const bd = firstMatch(V2_BROAD, subj);
  if (bd) return { cat: "broad", sub: bd.sub, src: idxCat === "规模指数" ? "index:规模指数" : "rule", route: "宽基" };

  // 9) 兜底：沿用 v1 规则 → 旧小类 → V2 映射
  const v1 = firstMatch(RULES, subj);
  if (v1) {
    const map = V1_TO_V2[v1.sub];
    if (map) return { cat: map.cat, sub: map.sub, sw: map.sw, src: "rule", route: "兜底", v1sub: v1.sub };
  }
  // 10) 不纳入
  return { excluded: v2ExcludedReason(meta, idxCat) };
}

function v2ExcludedReason(meta, idxCat) {
  if (/主动管理/.test(meta.name)) return "主动管理 ETF，无跟踪指数，无法按指数口径归类";
  if (!meta.benchmark) return "Tushare 未提供 benchmark，无法判定跟踪指数";
  if (idxCat === "综合指数") return `综合指数「${meta.fp}」无主导行业，不纳入`;
  return `指数「${meta.fp}」在指数库与关键词表中均无对应口径（${idxCat || "指数库未收录"}）`;
}

/* ------------------------------ 运行 ------------------------------ */

async function runV2() {
  const [{ rows: fbRows, cached: fbCached, fetchedAt: fbAt }, { rows: idxRows, cached: idxCached, fetchedAt: idxAt }] =
    await Promise.all([loadFundBasic(FLAG.force), loadIndexBasic(FLAG.force)]);

  const byCode = new Map(fbRows.map((r) => [String(r.ts_code).slice(0, 6), r]));
  const idxMatch = buildIndexMatcher(idxRows);
  const etfs = fbRows
    .filter((r) => /ETF/i.test(r.name || ""))
    .sort((a, b) => String(a.ts_code).localeCompare(String(b.ts_code)));

  const colors = v2Colors();
  const subs = {};
  for (const s of V2_SUBS) subs[s.sub] = { cat: s.cat, color: colors[s.sub], sw: s.sw ?? null, etfs: [] };
  const excluded = {};
  const srcAll = [];
  const idxCatHits = [];
  const decisions = new Map(); // code -> {cat, sub, src, route}

  for (const row of etfs) {
    const code = String(row.ts_code).slice(0, 6);
    const meta = {
      code,
      name: row.name || "",
      benchmark: row.benchmark || "",
      invest_type: row.invest_type || "",
      fund_type: row.fund_type || "",
      fp: indexFingerprint(row.benchmark),
      clean: cleanFundName(row.name),
      market: /^[569]/.test(code) ? "SH" : "SZ",
    };
    const idxHit = idxMatch(meta.fp);
    if (idxHit) idxCatHits.push(idxHit.category);
    const d = v2Decide(meta, idxHit);
    if (d.excluded) {
      excluded[code] = d.excluded;
      decisions.set(code, { excluded: d.excluded });
      continue;
    }
    if (!subs[d.sub]) throw new Error(`未定义的 v2 小类: ${d.sub} (${code} ${meta.name})`);
    subs[d.sub].etfs.push({ code, name: meta.name, market: meta.market, src: d.src });
    srcAll.push(String(d.src).split(":")[0]);
    decisions.set(code, d);
  }

  // 去掉空小类
  for (const [k, v] of Object.entries(subs)) if (!v.etfs.length) delete subs[k];
  const catOrder = Object.fromEntries(V2_CATS.map((c, i) => [c.key, i]));
  const subsSorted = Object.fromEntries(
    Object.entries(subs).sort((a, b) => catOrder[a[1].cat] - catOrder[b[1].cat] || b[1].etfs.length - a[1].etfs.length)
  );

  const included = Object.values(subs).reduce((n, s) => n + s.etfs.length, 0);
  const out = {
    generatedAt: new Date().toISOString(),
    taxonomy: "v2",
    basis: "index_basic.category + 申万一级名称映射 + 主题关键词 + v1 规则兜底",
    cats: V2_CATS.map((c) => ({ key: c.key, label: c.label, color: c.color, desc: c.desc })),
    subs: subsSorted,
    excluded: sortObj(excluded),
  };

  /* -------- 报告 -------- */
  const catSummary = V2_CATS.map((c) => {
    const list = Object.entries(subsSorted).filter(([, v]) => v.cat === c.key);
    return {
      key: c.key,
      label: c.label,
      subs: list.length,
      etfs: list.reduce((n, [, v]) => n + v.etfs.length, 0),
      subNames: list.map(([k]) => k),
    };
  });

  const perSub = Object.entries(subsSorted).map(([name, v]) => {
    const dist = tally(v.etfs.map((e) => String(e.src).split(":")[0]));
    const detail = tally(v.etfs.map((e) => e.src));
    return { sub: name, cat: v.cat, sw: v.sw, etfs: v.etfs.length, srcDist: dist, srcDetail: detail };
  });

  // 旧 88 小类（taxonomy 773 + universe.json 的深市 assign）→ 新小类
  const oldSub = new Map();
  for (const [s, o] of Object.entries(SUB)) for (const e of o.etfs) oldSub.set(e.code, s);
  try {
    const uni = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "universe.json"), "utf8"));
    for (const [code, s] of Object.entries(uni.assign || {})) if (!oldSub.has(code)) oldSub.set(code, s);
  } catch {}
  const crosswalkMap = new Map();
  let noOld = 0;
  for (const [code, d] of decisions) {
    if (d.excluded) continue;
    const o = oldSub.get(code);
    if (!o) { noOld++; continue; }
    const key = `${o} → ${d.sub}`;
    if (!crosswalkMap.has(key)) crosswalkMap.set(key, { from: o, to: d.sub, cat: d.cat, codes: [] });
    crosswalkMap.get(key).codes.push(code);
  }
  const crosswalk = [...crosswalkMap.values()].sort((a, b) => b.codes.length - a.codes.length)
    .map((x) => ({ from: x.from, to: x.to, cat: x.cat, count: x.codes.length }));

  const swStandalone = perSub.filter((s) => s.cat === "industry").map((s) => ({ sub: s.sub, etfs: s.etfs }));
  const swMerged = SW_L1.filter((n) => !subs[n]).map((n) => {
    const via = V1_TO_V2[n] || null;
    return { sw: n, mergedInto: via ? via.sub : "（无 ETF 覆盖，未使用）" };
  });

  const report = {
    generatedAt: out.generatedAt,
    taxonomy: "v2",
    source: {
      fundBasic: { rows: fbRows.length, cached: fbCached, fetchedAt: fbAt },
      indexBasic: { rows: idxRows.length, cached: idxCached, fetchedAt: idxAt },
    },
    coverage: {
      etfTotal: etfs.length,
      included,
      excluded: Object.keys(excluded).length,
      rate: +(included / etfs.length).toFixed(4),
      sh: Object.values(subs).reduce((n, s) => n + s.etfs.filter((e) => e.market === "SH").length, 0),
      sz: Object.values(subs).reduce((n, s) => n + s.etfs.filter((e) => e.market === "SZ").length, 0),
    },
    cats: catSummary,
    perSub,
    swL1: { total: 31, standalone: swStandalone, merged: swMerged },
    srcKinds: tally(srcAll),
    indexCoverage: {
      note: "ETF 的指数指纹能在 index_basic（SSE/SZSE/CSI/SW）里命中指数全名的比例，对应用户提到的「指数名包含匹配」口径",
      total: etfs.length,
      matched: idxCatHits.length,
      rate: +(idxCatHits.length / etfs.length).toFixed(4),
      byCategory: tally(idxCatHits),
    },
    excludedList: Object.entries(excluded).map(([code, reason]) => ({
      code,
      name: byCode.get(code)?.name || "",
      benchmark: byCode.get(code)?.benchmark || "",
      reason,
    })),
    crosswalk: { note: "旧 88 小类（taxonomy 773 只 + data/universe.json 深市 assign）→ v2 小类", rows: crosswalk, oldOnly: noOld },
  };

  if (!FLAG.dryRun) {
    fs.mkdirSync(path.dirname(V2_OUT), { recursive: true });
    fs.writeFileSync(V2_OUT, JSON.stringify(out, null, 2) + "\n");
    fs.writeFileSync(V2_REPORT, JSON.stringify(report, null, 2) + "\n");
  }

  console.log(`[v2] ETF 全量 ${etfs.length} 只：纳入 ${included}，排除 ${Object.keys(excluded).length}，纳入率 ${(included / etfs.length * 100).toFixed(2)}%`);
  for (const c of catSummary) console.log(`  ${c.label.padEnd(5, " ")} ${String(c.subs).padStart(2)} 小类 / ${String(c.etfs).padStart(4)} 只`);
  console.log(`[v2] 沪 ${out.subs && Object.values(subs).reduce((n, s) => n + s.etfs.filter((e) => e.market === "SH").length, 0)} / 深 ${Object.values(subs).reduce((n, s) => n + s.etfs.filter((e) => e.market === "SZ").length, 0)}`);
  console.log(`[v2] 申万 31 行业：单列 ${swStandalone.length} 个；未单列 ${swMerged.length} 个`);
  console.log(`[v2] src 分布：${JSON.stringify(tally(srcAll))}`);
  if (FLAG.dryRun) console.log("[v2] --dry-run：未写文件");
  else console.log(`[v2] 写出 ${path.relative(ROOT, V2_OUT)}（${fs.statSync(V2_OUT).size} B）、${path.relative(ROOT, V2_REPORT)}`);

  if (FLAG.review) {
    console.log(`\n[v2] 排除清单（${Object.keys(excluded).length}）`);
    for (const [code, r] of Object.entries(excluded)) console.log(`  ${code} ${byCode.get(code)?.name || ""} | ${r}`);
    console.log(`\n[v2] 小类明细（${Object.keys(subsSorted).length}）`);
    for (const s of perSub) console.log(`  ${s.cat.padEnd(11, " ")} ${s.sub.padEnd(12, " ")} ${String(s.etfs).padStart(4)}  ${JSON.stringify(s.srcDist)}`);
  }
}

function unassignedReason(row, fp) {
  const bm = row.benchmark || "";
  if (!bm) return "Tushare 未提供 benchmark，无法判定跟踪指数";
  return `指数「${fp}」在现有 86 小类与规则表中均无对应口径，需人工判断`;
}

const tally = (arr) => arr.reduce((a, t) => ((a[t] = (a[t] || 0) + 1), a), {});
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  (FLAG.v2 ? runV2() : main()).catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
}
