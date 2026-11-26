// 交易所公开接口
//  · 上交所：ETF 规模（基金份额，万份）支持按 STAT_DATE 回溯任意历史交易日
//  · 深交所：基金列表「当前规模（万份）」，仅提供最新交易日快照
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

async function getJson(url, headers, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30000);
      const res = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 上交所某交易日的 ETF 份额快照：{ code: 万份 }；非交易日/无数据返回 null */
export async function fetchSseDay(date) {
  const url =
    "http://query.sse.com.cn/commonQuery.do?isPagination=true&pageHelp.pageSize=2000" +
    "&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1" +
    "&sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L&STAT_DATE=" + date;
  const j = await getJson(url, {
    Referer: "http://www.sse.com.cn/market/funddata/volumn/etfvolumn/",
    "User-Agent": UA,
  });
  const rows = j?.result;
  if (!Array.isArray(rows) || !rows.length) return null;
  const out = {};
  const names = {};
  for (const r of rows) {
    const code = String(r.SEC_CODE ?? "").trim();
    const v = num(r.TOT_VOL);
    if (code && v != null) out[code] = v;
    const nm = String(r.SEC_NAME ?? "").trim();
    if (code && nm) names[code] = nm;
  }
  const d = String(rows[0].STAT_DATE ?? "").slice(0, 10);
  return { date: d || date, shares: out, names };
}

// 说明：深交所官方接口只提供「最新交易日」快照、无历史，因此自 v3 起不再调用；
// 深市数据统一由 Tushare 抓取（见 lib/tushare.mjs）。`dayinfo.has_szse` 与
// `share.src='szse'` 仅用于兼容历史数据，合并逻辑保留。


/**
 * 深交所「基金规模」快照（该接口只提供最新报告日，无历史）。
 * 日常增量足够：历史由 Tushare 回补，之后每天只补当天那一行。
 * @returns {Promise<{date: string, shares: Record<string, number>, count: number}>}
 */
export async function fetchSzseSnapshot({ budgetMs = 8000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const base =
    "https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1105&TABKEY=tab1&PAGENO=";
  const headers = { Referer: "https://www.szse.cn/", "User-Agent": UA };
  const first = await getJson(base + 1, headers);
  const meta = first?.[0]?.metadata;
  if (!meta) throw new Error("深交所返回结构异常");
  const pages = Math.min(Number(meta.pagecount) || 1, 200);
  let rows = first[0].data ?? [];
  for (let p = 2; p <= pages; p++) {
    // 深交所每页 20 行、全市场 55 页，runner 上常被限流；超出预算直接放弃，
    // 深市份额日常由 Tushare 一次覆盖全市场，没必要在这里烧 20 秒。
    if (Date.now() > deadline) throw new Error(`深交所快照超时（>${budgetMs}ms，已翻 ${p - 1}/${pages} 页）`);
    const j = await getJson(base + p, headers);
    rows = rows.concat(j?.[0]?.data ?? []);
  }
  const strip = (s) => String(s ?? "").replace(/<[^>]+>/g, "").trim();
  const out = {};
  const names = {};
  const listDates = {};
  for (const r of rows) {
    const code = strip(r.sys_key);
    if (!/^\d{6}$/.test(code)) continue;
    const v = num(strip(r.dqgm));
    if (v != null) out[code] = v;
    const nm = strip(r.jjjcurl);
    if (nm) names[code] = nm;
    const ld = strip(r.ssrq).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ld)) listDates[code] = ld;
  }
  // ⚠ 深交所快照的 metadata.subname 是「查询日/报告日」，里面的数据却是**上一交易日**的。
  // 实测 2026-11-26 报告日返回的 159915 = 5488645（正是 11-25 的值）。
  // 所以这里把 reportDate 与数据日分开，调用方必须按 prevTradingDay(reportDate) 落库。
  const reportDate = String(meta.subname ?? "").trim().slice(0, 10);
  return { date: reportDate, reportDate, shares: out, names, listDates, count: rows.length };
}


/**
 * 深交所「基金规模」按日期区间查询（历史接口，可回溯到 2021）。
 * 比快照稳：既能补当天，也能补「某天没抓成功」的缺口。
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<{date: string, shares: Record<string, number>, names: Record<string,string>, listDates: Record<string,string>}>}
 */
export async function fetchSzseHistory(date) {
  const base =
    "https://www.szse.cn/api/report/ShowReport/data?CATALOGID=scsj_fund_jjgm&SHOWTYPE=JSON" +
    `&TABKEY=tab1&jjlb=ETF&txtStart=${date}&txtEnd=${date}&random=0.1&PAGENO=`;
  const headers = { Referer: "https://www.szse.cn/", "User-Agent": UA };
  const j = await getJson(base + 1, headers);
  const meta = j?.[0]?.metadata;
  if (!meta) return null;
  const pages = Math.min(Number(meta.pagecount) || 1, 300);
  let rows = j[0].data ?? [];
  for (let p = 2; p <= pages; p++) {
    const k = await getJson(base + p, headers);
    rows = rows.concat(k?.[0]?.data ?? []);
  }
  const shares = {}, names = {}, listDates = {};
  for (const r of rows) {
    const code = String(r.fund_code ?? "").trim();
    if (!/^\d{6}$/.test(code)) continue;
    const v = num(String(r.current_size ?? "").replace(/,/g, ""));
    if (v != null) shares[code] = v;
    const nm = String(r.security_short_name ?? "").trim();
    if (nm) names[code] = nm;
  }
  return { date, shares, names, listDates };
}

/** 生成区间内的候选交易日（跳过周末；节假日由接口空结果自然过滤） */
export function candidateDates(from, to) {
  const out = [];
  const d = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (d <= end) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** 限定并发地批量执行 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (e) {
          out[idx] = { error: String(e?.message || e) };
        }
      }
    })
  );
  return out;
}
