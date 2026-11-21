// 数据质量规则引擎（只读：不写库、不改 schema、不联网）
//
//   validateDay({date, shares, prevShares, seriesPrev, seriesNow, funds})
//     → 单日体检：单只基金跳变 / 小类聚合跳变 / 覆盖度骤降 / 小类整段缺失 / 零负值
//   validateSeries(db, SUB)
//     → 回溯整条序列：中途断裂、跳变、零负值、量级异常（限条数）
//   coverageReport(db, SUB)
//     → 各小类成分覆盖率（按年）+ 各数据源贡献量
//
// 口径与 lib/aggregate.mjs 完全一致：小类 = 成分 ETF 份额之和 ÷1e4（亿份），
// 大类 9_债券 再 ×100；内部保留 4 位小数。本模块只用来看数据是否可信。
import { loadUniverse } from "./universe.mjs";

const UNIVERSES = loadUniverse();
const SUB = UNIVERSES.SUB;
const CATS = UNIVERSES.CATS;
const ALL_CODES = UNIVERSES.ALL_CODES;
const BOND_CAT = "9_债券";
import { allDates, seriesOf } from "./db.mjs";
import * as dbApi from "./db.mjs";

/** 参与校验的标的宇宙：分类体系里的 773 只（ts 会返回大量非标的基金，忽略） */
export const UNIVERSE = new Set(ALL_CODES);

export const DEFAULTS = {
  // 单只基金相邻交易日份额倍数。默认 warn 1.5x（约 +50% / -33%）
  warnMult: 1.5,
  // 规范要求「>5 倍标 error」；这里默认取更严的 3 倍（3 倍跳变必须报错），
  // 需要放宽时显式传 opts.errorMult = 5。
  errorMult: 3,
  // 数量级异常：≥100 倍
  magnitudeMult: 100,
  // 小类环比：普通 ±20%，债券类 ±30%
  subWarnPct: 0.2,
  bondWarnPct: 0.3,
  // 覆盖度骤降阈值（相对前一日标的数）
  coverageDropPct: 0.1,
  // 单只基金份额上限（万份）：1e8 万份 = 1 万亿份，超过必然异常
  maxFundRange: 1e8,
  // 新股/新发白名单（code 列表）：命中则跳过跳变判定
  whitelist: [],
  // 单次返回的 issue 上限（避免日志/JSON 爆炸）
  maxIssues: 500,
};

const ORDER = { error: 0, warn: 1, info: 2 };
const round4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);

/** 份额值统一成 number：支持 number / "123" / {wan, src} */
export function wanOf(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object") return wanOf(v.wan);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map / 普通对象 / Map 风格迭代器 → Map<code, 万份> */
export function toShareMap(input) {
  const out = new Map();
  if (!input) return out;
  const entries = input instanceof Map ? input.entries() : Object.entries(input);
  for (const [code, v] of entries) {
    const n = wanOf(v);
    if (n != null) out.set(String(code), n);
  }
  return out;
}

/** 某日份额 → 各小类值（亿份，4 位小数）；没有任何成分有数据时为 null */
export function subValues(shares, subMap = SUB) {
  const m = shares instanceof Map ? shares : toShareMap(shares);
  const out = {};
  for (const sub of Object.keys(subMap)) {
    const meta = subMap[sub];
    const factor = meta.cat === BOND_CAT ? 100 : 1;
    let sum = 0;
    let hit = 0;
    for (const e of meta.etfs) {
      const v = m.get(e.code);
      if (v != null) {
        sum += v;
        hit++;
      }
    }
    out[sub] = hit ? round4((sum / 1e4) * factor) : null;
  }
  return out;
}

const fmtMult = (m) => `${m >= 1 ? m.toFixed(2) : (1 / m).toFixed(2)}${m >= 1 ? "x" : "x（缩水）"}`;
const clip = (arr, n = 6) => (arr.length <= n ? arr.join(",") : `${arr.slice(0, n).join(",")}…共 ${arr.length} 只`);

/**
 * 单日体检。
 * @param {object} p
 * @param {string} [p.date]        交易日（仅用于回显/消息）
 * @param {Map|object} p.shares     当日 code→万份
 * @param {Map|object} [p.prevShares] 上一交易日 code→万份（缺省则跳过环比类规则）
 * @param {object} [p.seriesPrev]   上一交易日 小类→值；缺省由 prevShares 现算
 * @param {object} [p.seriesNow]    当日 小类→值；缺省由 shares 现算
 * @param {Map|object} [p.funds]    code→{name}，仅用于消息
 * @param {object} [p.opts]         覆盖 DEFAULTS
 * @returns {{ok:boolean, level:'ok'|'warn'|'error', date:string|null, issues:Array, truncated:boolean, stats:object}}
 */
export function validateDay({ date = null, shares, prevShares, seriesPrev, seriesNow, funds, opts } = {}) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const now = toShareMap(shares);
  const prev = toShareMap(prevShares);
  const nameOf = (code) => {
    const f = funds instanceof Map ? funds.get(code) : funds?.[code];
    return f?.name ? `${code} ${f.name}` : code;
  };
  const issues = [];
  const add = (code, kind, severity, message, extra) =>
    issues.push({ code: code ?? null, kind, message, severity, ...(extra || {}) });

  // ── 1. 单只基金 ───────────────────────────────────────────────
  const whitelist = new Set(o.whitelist);
  const newCodes = [];
  const missingCodes = [];
  let codesNow = 0;
  let codesPrev = 0;
  for (const code of UNIVERSE) {
    const hasPrev = prev.has(code);
    if (hasPrev) codesPrev++;
    if (!now.has(code)) {
      if (hasPrev) missingCodes.push(code);
      continue;
    }
    codesNow++;
    const v = now.get(code);
    if (!Number.isFinite(v)) {
      add(code, "fund_value", "error", `${nameOf(code)} 份额非数值：${v}`);
      continue;
    }
    if (v <= 0) {
      add(code, "fund_value", "error", `${nameOf(code)} 份额非正：${v} 万份`);
      continue;
    }
    if (v > o.maxFundRange) {
      add(code, "fund_range", "error", `${nameOf(code)} 份额量级异常：${v} 万份（> ${o.maxFundRange}）`);
    }
    if (!hasPrev) {
      newCodes.push(code);
      continue;
    }
    const p = prev.get(code);
    if (!(p > 0)) continue; // 前值为空/0 的情况由前一日的日检负责
    if (whitelist.has(code)) continue;
    const mult = v / p;
    const detail = { prev: p, now: v, mult: round4(mult) };
    if (mult >= o.magnitudeMult || mult <= 1 / o.magnitudeMult) {
      add(code, "fund_jump_magnitude", "error", `${nameOf(code)} 份额量级跳变：${p} → ${v}（${fmtMult(mult)}）`, detail);
    } else if (mult >= o.errorMult || mult <= 1 / o.errorMult) {
      add(code, "fund_jump", "error", `${nameOf(code)} 份额跳变：${p} → ${v}（${fmtMult(mult)}）`, detail);
    } else if (mult >= o.warnMult || mult <= 1 / o.warnMult) {
      add(code, "fund_jump", "warn", `${nameOf(code)} 份额波动：${p} → ${v}（${fmtMult(mult)}）`, detail);
    }
  }
  if (prev.size && newCodes.length) {
    add(null, "fund_new", "info", `${newCodes.length} 只成分当日有新值而前一日无值（新股/新发，已跳过跳变判定）：${clip(newCodes)}`);
  }

  // ── 2. 覆盖度 ─────────────────────────────────────────────────
  if (codesPrev > 0 && codesNow < codesPrev) {
    const drop = (codesPrev - codesNow) / codesPrev;
    if (drop > o.coverageDropPct) {
      add(
        null,
        "coverage_drop",
        "error",
        `覆盖度骤降：前一日 ${codesPrev} 只有数，当日 ${codesNow} 只（-${(drop * 100).toFixed(1)}%，阈值 ${(o.coverageDropPct * 100).toFixed(0)}%）` +
          (missingCodes.length ? `；缺 ${clip(missingCodes)}` : "")
      );
    }
  }

  // ── 3. 小类聚合 ───────────────────────────────────────────────
  const sNow = seriesNow ?? subValues(now);
  const sPrev = seriesPrev ?? (prev.size ? subValues(prev) : {});
  let subsNow = 0;
  let subsPrev = 0;
  for (const sub of Object.keys(SUB)) {
    const b = sNow[sub] ?? null;
    const a = sPrev[sub] ?? null;
    if (b != null) subsNow++;
    if (a != null) subsPrev++;
    if (b == null) {
      // 一个成分都没有数据：要么真的没标的（早期日期），要么抓取残缺
      const miss = SUB[sub].etfs.filter((e) => !now.has(e.code)).length;
      add(sub, "sub_missing", "error", `小类「${sub}」当日 0 个成分有数据（${miss}/${SUB[sub].etfs.length} 缺失）`);
      continue;
    }
    if (!Number.isFinite(b) || b <= 0) {
      add(sub, "sub_value", "error", `小类「${sub}」聚合值非正：${b}`);
      continue;
    }
    if (a == null || !(a > 0)) continue;
    const pct = (b - a) / a;
    const lim = SUB[sub].cat === BOND_CAT ? o.bondWarnPct : o.subWarnPct;
    if (Math.abs(pct) > lim) {
      add(
        sub,
        "sub_jump",
        "warn",
        `小类「${sub}」环比 ${(pct * 100).toFixed(2)}%（${a} → ${b}，阈值 ±${(lim * 100).toFixed(0)}%）`,
        { pct: round4(pct), prev: a, now: b, cat: SUB[sub].cat }
      );
    }
  }

  // ── 4. 排序与截断 ─────────────────────────────────────────────
  issues.sort((x, y) => ORDER[x.severity] - ORDER[y.severity] || String(x.code ?? "").localeCompare(String(y.code ?? "")));
  const level = issues.some((i) => i.severity === "error")
    ? "error"
    : issues.some((i) => i.severity === "warn")
      ? "warn"
      : "ok";
  const truncated = issues.length > o.maxIssues;
  const byKind = {};
  for (const i of issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  return {
    ok: level !== "error",
    level,
    date,
    issues: truncated ? issues.slice(0, o.maxIssues) : issues,
    truncated,
    stats: { codesNow, codesPrev, newFunds: newCodes.length, subsNow, subsPrev, byKind },
  };
}

/**
 * 序列断裂检测：返回首个非空值之后「断了又接上」的区间；首段 null 允许。
 * @param {Array<{date:string,val:number|null}>} rows 按日期升序
 * @returns {{gaps:Array<{from:string,to:string,days:number}>, tail:object|null}}
 */
export function findGaps(rows) {
  const gaps = [];
  let seen = false;
  let inGap = false;
  let gapStart = null;
  let gapDays = 0;
  for (const r of rows) {
    const has = r.val != null;
    if (!has) {
      if (seen) {
        if (!inGap) {
          inGap = true;
          gapStart = r.date;
          gapDays = 0;
        }
        gapDays++;
      }
    } else {
      if (inGap) {
        gaps.push({ from: gapStart, to: r.date, days: gapDays });
        inGap = false;
      }
      seen = true;
    }
  }
  return { gaps, tail: inGap ? { from: gapStart, days: gapDays } : null };
}

/**
 * 回溯整条序列体检（series 表）。逐指标：断裂 / 跳变 / 零负值 / 量级。
 * @param {object} db openDb() 句柄
 * @param {object} subMap 细分行业表（默认 SUB）
 * @param {object} [opts] {maxIssues=200, perSub=4, subWarnPct, bondWarnPct, maxValue=1e6}
 */
export function validateSeries(db, subMap = SUB, opts = {}) {
  const o = {
    maxIssues: 200,
    perSub: 4,
    subWarnPct: DEFAULTS.subWarnPct,
    bondWarnPct: DEFAULTS.bondWarnPct,
    maxValue: 1e6,
    ...opts,
  };
  const dates = allDates(db);
  const issues = [];
  const perSubSummary = {};
  let points = 0;
  let truncated = false;
  const push = (sub, kind, severity, message, extra) => {
    const s = perSubSummary[sub] ?? (perSubSummary[sub] = { issues: 0, byKind: {} });
    s.issues++;
    s.byKind[kind] = (s.byKind[kind] || 0) + 1;
    if (s.issues > o.perSub) {
      truncated = true;
      return;
    }
    if (issues.length >= o.maxIssues) {
      truncated = true;
      return;
    }
    issues.push({ code: sub, sub, kind, severity, message, ...(extra || {}) });
  };

  for (const sub of Object.keys(subMap)) {
    const rows = seriesOf(db, sub);
    if (!rows.length) continue;
    points += rows.length;
    const lim = subMap[sub].cat === BOND_CAT ? o.bondWarnPct : o.subWarnPct;
    const { gaps, tail } = findGaps(rows);
    for (const g of gaps) {
      push(sub, "series_gap", "warn", `小类「${sub}」序列断裂：${g.from} ~ ${g.to}（${g.days} 个交易日无数据后又恢复）`, g);
    }
    if (tail) {
      push(sub, "series_tail_gap", "warn", `小类「${sub}」序列末尾缺数据：自 ${tail.from} 起 ${tail.days} 个交易日无值`, tail);
    }
    let prev = null;
    for (const r of rows) {
      if (r.val == null) continue;
      const v = r.val;
      if (!Number.isFinite(v) || v < 0 || v >= o.maxValue) {
        push(sub, "series_value", "error", `小类「${sub}」${r.date} 数值越界：${v}（要求 0 ≤ v < ${o.maxValue}）`, { date: r.date, val: v });
      }
      if (prev && prev.val > 0 && v >= 0) {
        const pct = (v - prev.val) / prev.val;
        if (Math.abs(pct) > lim) {
          push(
            sub,
            "series_jump",
            "warn",
            `小类「${sub}」${prev.date}→${r.date} 跳变 ${(pct * 100).toFixed(2)}%（${prev.val} → ${v}）`,
            { from: prev.date, to: r.date, pct: round4(pct) }
          );
        }
      }
      prev = r;
    }
  }

  issues.sort((x, y) => ORDER[x.severity] - ORDER[y.severity] || String(x.code).localeCompare(String(y.code)));
  const level = issues.some((i) => i.severity === "error")
    ? "error"
    : issues.some((i) => i.severity === "warn")
      ? "warn"
      : "ok";
  const byKind = {};
  for (const i of issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
  return {
    ok: level !== "error",
    level,
    scanned: { subs: Object.keys(subMap).length, dates: dates.length, points },
    issues,
    truncated,
    byKind,
    bySub: perSubSummary,
  };
}

/**
 * 覆盖率报告：每个小类的成分覆盖率（按年）+ 各源贡献量。
 * @param {object} db
 * @param {object} subMap 默认 SUB
 * @param {object} [opts] {lowRate=0.8}
 */
export function coverageReport(db, subMap = SUB, opts = {}) {
  const o = { lowRate: 0.8, ...opts };
  const dates = allDates(db);
  const yearOf = (d) => String(d).slice(0, 4);
  const years = [...new Set(dates.map(yearOf))].sort();

  // 一次读全表，按日期聚合出「当日有份额的 code 集合」
  const byDate = new Map();
  for (const r of db.prepare("SELECT date, code FROM share").all()) {
    let s = byDate.get(r.date);
    if (!s) byDate.set(r.date, (s = new Set()));
    s.add(r.code);
  }

  const subs = Object.keys(subMap);
  const acc = new Map(); // sub → year → {days, hitDays, hits, total}
  for (const sub of subs) {
    const m = new Map();
    for (const y of years) m.set(y, { days: 0, hitDays: 0, hits: 0, total: 0 });
    acc.set(sub, m);
  }
  const universeHits = new Map(); // date → 当日有份额的宇宙标的数
  for (const d of dates) {
    const present = byDate.get(d) ?? new Set();
    const y = yearOf(d);
    for (const sub of subs) {
      const etfs = subMap[sub].etfs;
      let hit = 0;
      for (const e of etfs) if (present.has(e.code)) hit++;
      const a = acc.get(sub).get(y);
      a.days++;
      a.hits += hit;
      a.total += etfs.length;
      if (hit) a.hitDays++;
    }
    if (!universeHits.has(d)) {
      let n = 0;
      for (const c of UNIVERSE) if (present.has(c)) n++;
      universeHits.set(d, n);
    }
  }

  const lastDate = dates.at(-1) ?? null;
  const lastPresent = lastDate ? (byDate.get(lastDate) ?? new Set()) : new Set();
  const bySub = subs.map((sub) => {
    const etfs = subMap[sub].etfs;
    const byYear = {};
    let hits = 0;
    let total = 0;
    for (const y of years) {
      const a = acc.get(sub).get(y);
      hits += a.hits;
      total += a.total;
      byYear[y] = {
        days: a.days,
        hitDays: a.hitDays,
        hits: a.hits,
        slots: a.total,
        rate: a.total ? round4(a.hits / a.total) : null,
      };
    }
    const curHit = etfs.filter((e) => lastPresent.has(e.code)).length;
    return {
      sub,
      cat: subMap[sub].cat,
      etfs: etfs.length,
      current: { covered: curHit, rate: etfs.length ? round4(curHit / etfs.length) : null },
      overall: { hits, slots: total, rate: total ? round4(hits / total) : null },
      byYear,
    };
  });

  // 各源贡献量（行数 / 涉及标的 / 覆盖天数，按年切分）
  const srcRows = db
    .prepare("SELECT substr(date,1,4) AS y, src, COUNT(*) AS n FROM share GROUP BY y, src")
    .all();
  const srcCodes = db
    .prepare("SELECT src, COUNT(DISTINCT code) AS codes, COUNT(DISTINCT date) AS days, COUNT(*) AS rows FROM share GROUP BY src")
    .all();
  const bySource = srcCodes
    .map((r) => ({
      src: r.src,
      rows: r.rows,
      codes: r.codes,
      days: r.days,
      byYear: Object.fromEntries(srcRows.filter((x) => x.src === r.src).map((x) => [x.y, x.n])),
    }))
    .sort((a, b) => b.rows - a.rows);
  const totalRows = bySource.reduce((s, x) => s + x.rows, 0);
  for (const s of bySource) s.share = totalRows ? round4(s.rows / totalRows) : 0;

  // 交易日口径：优先用 db.tradingDates()（dayinfo.has_sse=1，天然排除 Tushare 的季末/周末披露）
  let tradeSet = null;
  try {
    if (typeof dbApi.tradingDates === "function") {
      const td = dbApi.tradingDates(db);
      if (td.length) tradeSet = new Set(td);
    }
  } catch {}

  const overallRate = bySub.reduce((s, x) => s + (x.overall.hits ?? 0), 0) /
    Math.max(1, bySub.reduce((s, x) => s + (x.overall.slots ?? 0), 0));
  const curHits = bySub.reduce((s, x) => s + x.current.covered, 0);
  const curSlots = bySub.reduce((s, x) => s + x.etfs, 0);
  const currentRate = curSlots ? curHits / curSlots : null;
  const low = bySub.filter((x) => (x.overall.rate ?? 0) < o.lowRate).sort((a, b) => a.overall.rate - b.overall.rate);

  // 日期轴体检：非交易日混入（周末）与覆盖度骤降（抓取残缺/回填污染）
  const isWeekend = (d) => {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    return w === 0 || w === 6;
  };
  const nonTradingDays = dates
    .filter((d) => (tradeSet ? !tradeSet.has(d) : isWeekend(d)))
    .map((d) => ({ date: d, codes: universeHits.get(d) ?? 0 }));
  const thinDays = [];
  for (let i = 1; i < dates.length; i++) {
    const a = universeHits.get(dates[i - 1]) ?? 0;
    const b = universeHits.get(dates[i]) ?? 0;
    if (a > 0 && (a - b) / a > DEFAULTS.coverageDropPct) {
      thinDays.push({ date: dates[i], prev: dates[i - 1], codes: b, prevCodes: a });
    }
  }
  thinDays.sort((x, y) => (y.prevCodes - y.codes) - (x.prevCodes - x.codes));

  return {
    generatedAt: new Date().toISOString(),
    dates: { from: dates[0] ?? null, to: lastDate, count: dates.length, years },
    bySub,
    bySource,
    summary: {
      overallRate: round4(overallRate),
      currentRate: currentRate == null ? null : round4(currentRate),
      currentDate: lastDate,
      subs: bySub.length,
      subsBelow: low.length,
      lowRateThreshold: o.lowRate,
      worst: low.slice(0, 10).map((x) => ({ sub: x.sub, rate: x.overall.rate })),
      sources: bySource.map((s) => `${s.src}:${s.rows}`),
      tradingDays: tradeSet ? tradeSet.size : null,
      nonTrading: {
        count: nonTradingDays.length,
        sample: nonTradingDays.slice(0, 10),
        basis: tradeSet ? "dayinfo.has_sse" : "周末推断",
      },
      thinDays: { count: thinDays.length, sample: thinDays.slice(0, 10) },
    },
  };
}

/** 打印用的一行摘要（CLI 复用，不含长表格） */
export function coverageLine(rep) {
  const s = rep.summary;
  const worst = s.worst.slice(0, 3).map((x) => `${x.sub} ${(x.rate * 100).toFixed(0)}%`).join("，");
  const cur = s.currentRate == null ? "—" : `${(s.currentRate * 100).toFixed(1)}%`;
  return (
    `当日 ${cur}（${s.currentDate ?? "-"}）｜全历史 ${(s.overallRate * 100).toFixed(1)}%` +
    `（${s.subs} 个小类 / ${s.subsBelow} 个低于 ${(s.lowRateThreshold * 100).toFixed(0)}%，最低 ${worst || "—"}）` +
    `｜源 ${s.sources.join(" ")}｜非交易日混入 ${s.nonTrading.count} 天，覆盖骤降 ${s.thinDays.count} 天`
  );
}

export { CATS };
