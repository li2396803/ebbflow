// 汉字 → 拼音首字母（覆盖 86 个细分行业名与常见 ETF 名称用字）
// 数据不足时前端仍可回退到自己的表；本模块只用于生成 index.json 的 pinyin 字段。
export const PY_PAIRS = "与y业y中z事s云y互h交j产c人r件j价j企q伏f传c低d体t保b信x债z值z光g全q公g养y军j农n创c利l制z券q力l务w化h区q医y半b发f可k合h和h品p商s器q国g地d城c域y基j备b大d天t央y媒m子z家j宽k导d小x居j展z属s工g府f建j息x戏x成c房f技j投t指z换h据j改g政z教j数s料l新x方f施s旅l智z有y服f期q机j材c板b械x殖z气q池c汽q沪h油y治z波b流l消x深s港g游y源y炭t煤m片p牌p牧m物w率l环h现x理l生s用y电d畜c略l疗l疫y白b盘p短d石s础c碳t科k稀x程c空k端d筑z策c算s红h综z绿l网w老l联l股g育y能n航h舶b船c色s芯x苗m药y融r行x装z计j设s贵g费f资z超c车c转z软r通t造z部b酒j金j钢g铁t银y长z防f险x零l非f革g风f食s饮y高g";

const MAP = new Map();
for (let i = 0; i + 1 < PY_PAIRS.length; i += 2) MAP.set(PY_PAIRS[i], PY_PAIRS[i + 1]);

/** 取字符串的拼音首字母（非汉字原样保留小写，其它符号忽略） */
export function pinyinInitials(text) {
  let out = "";
  for (const ch of String(text || "")) {
    if (MAP.has(ch)) out += MAP.get(ch);
    else if (/[A-Za-z0-9]/.test(ch)) out += ch.toLowerCase();
  }
  return out;
}

/** 同时给出首字母串与逐字首字母数组，便于前端做高亮 */
export function pinyinParts(text) {
  return [...String(text || "")].map((ch) => (MAP.has(ch) ? MAP.get(ch) : /[A-Za-z0-9]/.test(ch) ? ch.toLowerCase() : ""));
}
