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
import { fileURLToPath } from "node:url";
import { CATS, SUB } from "../lib/taxonomy.mjs";
import { call } from "../lib/tushare.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_FILE = path.join(ROOT, "data", "universe.json");
const REPORT_FILE = path.join(ROOT, "data", "universe-report.json");
const CACHE_FILE = path.join(os.tmpdir(), `etf-flow-fundbasic-${new Date().toISOString().slice(0, 10)}.json`);

const argv = new Set(process.argv.slice(2));
const FLAG = { report: argv.has("--report"), force: argv.has("--force"), review: argv.has("--review") };

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
  /(南方东英|兴证全球|华泰柏瑞|景顺长城|国投瑞银|工银瑞信|浦银安盛|国寿安保|光大保德信|申万菱信|中信保诚|民生加银|方正富邦|国海富兰克林|摩根士丹利|前海开源|创金合信|红土创新|华润元大|北信瑞丰|恒生前海|合煦智远|西部利得|泰达宏利|农银汇理|金元顺安|华泰保兴|国新国证|中银证券|南方基金|东方红|易方达|天弘|富国|汇添富|博时|招商|华安|国泰|鹏华|大成|银华|华宝|永赢|建信|中欧|广发|华夏|嘉实|南方|万家|中银|平安|泰康|财通|浙商|华商|金鹰|德邦|长城|长信|融通|诺安|东财|中金|上银|鑫元|国金|华富|中加|汇安|东兴|泓德|睿远|朱雀|泉果|路博迈|贝莱德|施罗德|联博|国联|东吴|东海|湘财|嘉合|中庚|凯石|民生|鹏扬|新华|兴业|银河|摩根|中邮|长盛|九泰|太平|中航|恒越|百嘉|达诚|兴银|中融|英大|大和)/g;

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

function unassignedReason(row, fp) {
  const bm = row.benchmark || "";
  if (!bm) return "Tushare 未提供 benchmark，无法判定跟踪指数";
  return `指数「${fp}」在现有 86 小类与规则表中均无对应口径，需人工判断`;
}

const tally = (arr) => arr.reduce((a, t) => ((a[t] = (a[t] || 0) + 1), a), {});
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
