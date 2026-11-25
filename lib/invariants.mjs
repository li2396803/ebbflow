// 数据不变量（P0/P1）：口径一致性、覆盖度闸门、可疑跳变归因、空结果判据
//
// 设计原则：尽量做成**纯函数**（输入 = 已读出的数据），这样测试可以完全不联网、不碰真库；
// 只有 `loadShares / loadSeries / officialCounts` 这几个薄封装碰数据库。
//
// 与 lib/pipeline.mjs 的关系：
//   · `resolveMarketModes()` 是「某天某市场该用官方行还是全部行」的唯一判据，pipeline 必须用它；
//   · `numericChecks()` 用同一个口径复算，用于审计「库里的值 = 成分之和」。
import { dayCoverage } from "./db.mjs";

/** 覆盖度闸门默认参数（依据见 docs/AUDIT-PIPELINE.md §P0-1） */
export const BAND = {
  window: 20, // 近 20 个交易日
  minRatio: 0.6, // 低于中位数 60% → 残缺
  maxRatio: 2, // 高于中位数 2 倍 → 异常（重复计入/混入别的口径）
  minWindow: 5, // 历史不足 5 天不做相对判断（冷启动）
};

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/** 读某几个交易日的份额：Map<date, Map<code,{wan,src}>> */
export function loadShares(db, dates) {
  const set = dates ? new Set(dates) : null;
  const out = new Map();
  for (const r of db.prepare("SELECT date, code, wan, src FROM share").all()) {
    if (set && !set.has(r.date)) continue;
    let m = out.get(r.date);
    if (!m) out.set(r.date, (m = new Map()));
    m.set(r.code, { wan: r.wan, src: r.src });
  }
  return out;
}

/** 读派生序列表：Map<'sub|date', val>（默认 legacy 的 series，可指定 series_v2） */
export function loadSeries(db, table = "series") {
  const t = table === "series_v2" ? "series_v2" : "series";
  const out = new Map();
  for (const r of db.prepare(`SELECT sub, date, val FROM ${t}`).all()) out.set(`${r.sub}|${r.date}`, r.val);
  return out;
}

/** 从内存份额上下文统计「官方行只数」（分市场）：Map<date,{sh,sz}> */
export function officialCountsFromShares(sharesByDate) {
  const out = new Map();
  for (const [date, m] of sharesByDate) {
    let sh = 0;
    let sz = 0;
    for (const [code, r] of m) {
      if (r.src === "ts") continue;
      if (/^[56]/.test(code)) sh++;
      else sz++;
    }
    out.set(date, { sh, sz });
  }
  return out;
}

/**
 * 每个交易日、每个市场该用哪种口径：
 *   'official' = 只用交易所官方行（官方快照完整）
 *   'all'      = 用全部可用行（官方缺失或残缺，需要用 Tushare 兜底）
 *
 * 判据（不写死只数）：
 *   · 官方行数 > 0；
 *   · 且相对「近 N 个交易日官方行数的中位数」≥ minRatio（窗口不足时退化为绝对下限 minAbsolute）。
 * 这样既不会因为「某天官方接口坏了返回 0」把整个市场清零（事故 2），
 * 也不会因为「官方只抓回一半」把 Tushare 兜底行丢掉（同类路径）。
 *
 * @param {{dates:string[], official:Map<string,{sh:number,sz:number}>, opts?:object}} p
 * @returns {Map<string,{sh:"official"|"all",sz:"official"|"all",officialSh:number,officialSz:number,medSh:number|null,medSz:number|null,shRatio:number|null,szRatio:number|null,shIncomplete:boolean,szIncomplete:boolean}>}
 */
export function resolveMarketModes({ dates, official, opts = {} }) {
  const window = opts.window ?? BAND.window;
  const minRatio = opts.minRatio ?? BAND.minRatio;
  const minWindow = opts.minWindow ?? BAND.minWindow;
  const minAbsolute = opts.minAbsolute ?? 100;
  const out = new Map();
  const accSh = [];
  const accSz = [];
  for (const d of dates) {
    const o = official.get(d) ?? { sh: 0, sz: 0 };
    const histSh = accSh.slice(-window);
    const histSz = accSz.slice(-window);
    const medSh = median(histSh);
    const medSz = median(histSz);
    const decide = (count, hist, med) => {
      if (!(count > 0)) return { mode: "all", ratio: null, incomplete: false };
      if (hist.length < minWindow || med == null || med <= 0) {
        return { mode: count >= minAbsolute ? "official" : "all", ratio: null, incomplete: count < minAbsolute };
      }
      const ratio = count / med;
      return { mode: ratio >= minRatio ? "official" : "all", ratio, incomplete: ratio < minRatio };
    };
    const sh = decide(o.sh, histSh, medSh);
    const sz = decide(o.sz, histSz, medSz);
    out.set(d, {
      sh: sh.mode,
      sz: sz.mode,
      officialSh: o.sh,
      officialSz: o.sz,
      medSh,
      medSz,
      shRatio: sh.ratio,
      szRatio: sz.ratio,
      shIncomplete: sh.incomplete,
      szIncomplete: sz.incomplete,
    });
    accSh.push(o.sh);
    accSz.push(o.sz);
  }
  return out;
}

/**
 * 口径一致性检查：库里的序列值必须等于「按成分重算」的值。
 * 因为每天可能有两种合法口径（官方行 / 全部行），这里两种都算，只要命中其一即通过，
 * 并统计每天实际生效的是哪种 —— 如果两种都不等，说明派生数据与事实层脱节。
 *
 * @param {{universe:{SUB:object}, dates:string[], sharesByDate:Map, stored:Map<string,number|null>, modes:Map<string,object>, isBondCat?:(c:string)=>boolean, tolerance?:number}} p
 * @returns {{checked:number, mismatches:Array, modeUse:{official:number, all:number, mixed:number}, maxAbsDiff:number}}
 */
export function numericChecks({ universe, dates, sharesByDate, stored, modes, isBondCat, tolerance = 1e-4 }) {
  const bondOf = isBondCat ?? ((cat) => cat === "9_债券" || cat === "bond");
  const mismatches = [];
  const modeUse = { official: 0, all: 0, mixed: 0 };
  let checked = 0;
  let maxAbsDiff = 0;

  const sum = (codes, day, dayMode, onlyOfficial) => {
    let s = 0;
    let hit = 0;
    for (const code of codes) {
      const r = day.get(code);
      if (!r) continue;
      if (onlyOfficial) {
        const isSh = /^[56]/.test(code);
        // 该市场当天是否在用官方口径，由 modes 决定；不用官方的市场不过滤
        const useOfficial = isSh ? dayMode?.sh === "official" : dayMode?.sz === "official";
        if (useOfficial && r.src === "ts") continue;
      }
      s += r.wan;
      hit++;
    }
    return hit ? s : null;
  };

  for (const [sub, meta] of Object.entries(universe.SUB)) {
    const codes = meta.etfs.map((e) => e.code);
    const factor = bondOf(meta.cat) ? 100 : 1;
    for (const d of dates) {
      const day = sharesByDate.get(d);
      if (!day) continue;
      const dayMode = modes?.get ? modes.get(d) : modes;
      const vals = [];
      for (const onlyOfficial of [true, false]) {
        const raw = sum(codes, day, dayMode, onlyOfficial);
        vals.push(raw == null ? null : Math.round((raw / 1e4) * factor * 1e4) / 1e4);
      }
      const expectedOfficial = vals[0];
      const expectedAll = vals[1];
      const actual = stored.has(`${sub}|${d}`) ? stored.get(`${sub}|${d}`) : null;
      if (actual == null && expectedAll == null) continue;
      checked++;
      const near = (a, b) => (a == null || b == null ? a == null && b == null : Math.abs(a - b) <= tolerance);
      const okOfficial = near(actual, expectedOfficial);
      const okAll = near(actual, expectedAll);
      if (okOfficial || okAll) {
        if (okOfficial && okAll) modeUse.mixed++;
        else if (okOfficial) modeUse.official++;
        else modeUse.all++;
        continue;
      }
      const diff = Math.abs((actual ?? 0) - (expectedAll ?? expectedOfficial ?? 0));
      maxAbsDiff = Math.max(maxAbsDiff, diff);
      if (mismatches.length < 50) {
        mismatches.push({ sub, date: d, actual, expectedOfficial, expectedAll });
      }
    }
  }
  return { checked, mismatches, modeUse, maxAbsDiff };
}

/**
 * 可疑跳变归因（相邻交易日环比超过阈值）。
 * 归因顺序：份额折算 → 覆盖率变化 → 口径切换 → 上市首日 → 未知。
 *
 * @param {object} db
 * @param {{universe:{SUB:object}, table?:string, thresholdPct?:number, dates?:string[], modes?:Map}} opts
 * @returns {Array<{sub:string,date:string,prev:string,prevVal:number,val:number,pct:number,reasons:string[],severity:"warn"|"info"}>}
 */
export function suspiciousJumps(db, opts = {}) {
  const universe = opts.universe;
  if (!universe) throw new Error("suspiciousJumps 需要 universe（{SUB}）");
  const table = opts.table === "series_v2" ? "series_v2" : "series";
  const threshold = opts.thresholdPct ?? 30;
  const dateFilter = opts.dates ? new Set(opts.dates) : null;
  const modes = opts.modes ?? null;

  const eventDates = new Map(); // date -> Set(code)
  try {
    for (const r of db.prepare("SELECT code, date FROM event").all()) {
      let s = eventDates.get(r.date);
      if (!s) eventDates.set(r.date, (s = new Set()));
      s.add(r.code);
    }
  } catch {}
  const listDates = new Map();
  try {
    for (const r of db.prepare("SELECT code, list_date FROM fund WHERE list_date IS NOT NULL").all()) listDates.set(r.code, r.list_date);
  } catch {}
  const cov = opts.coverage ?? dayCoverage(db);
  const prevCov = new Map();
  {
    const sorted = [...cov.keys()].sort();
    for (let i = 1; i < sorted.length; i++) prevCov.set(sorted[i], cov.get(sorted[i - 1]));
  }

  // 可选：把当日份额映射传进来，用来识别「新成分首次出现」与「小基数跳变」；
  // 不传时退化为只看全市场覆盖率（仍可用，只是归因粗一点）。
  const sharesByDate = opts.sharesByDate ?? null;

  const rows = db.prepare(`SELECT sub, date, val FROM ${table} ORDER BY sub, date`).all();
  const bySub = new Map();
  for (const r of rows) {
    if (dateFilter && !dateFilter.has(r.date)) continue;
    let a = bySub.get(r.sub);
    if (!a) bySub.set(r.sub, (a = []));
    a.push(r);
  }

  const out = [];
  for (const [sub, list] of bySub) {
    const meta = universe.SUB[sub];
    if (!meta) continue;
    const codes = new Set(meta.etfs.map((e) => e.code));
    const vals = [];
    let prevCodesWithData = null;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev.val == null || cur.val == null || !(prev.val > 0)) continue;
      const pct = ((cur.val - prev.val) / prev.val) * 100;
      if (Math.abs(pct) < threshold) continue;
      const reasons = [];
      const ev = eventDates.get(cur.date);
      if (ev && [...codes].some((c) => ev.has(c))) reasons.push("split");
      const c0 = prevCov.get(cur.date);
      const c1 = cov.get(cur.date);
      if (c0 && c1) {
        const shDrop = c0.sh > 0 ? c1.sh / c0.sh : 1;
        const szDrop = c0.sz > 0 ? c1.sz / c0.sz : 1;
        if (shDrop < 0.8 || szDrop < 0.8) reasons.push("coverage");
        else if (shDrop > 1.2 || szDrop > 1.2) reasons.push("coverage");
      }
      if (modes) {
        const mp = modes.get(prev.date);
        const mc = modes.get(cur.date);
        if (mp && mc && (mp.sh !== mc.sh || mp.sz !== mc.sz)) reasons.push("caliber");
      }
      if ([...codes].some((c) => listDates.get(c) === cur.date)) reasons.push("listing");

      // 成分集合变化 / 小基数：需要 sharesByDate 才能判断
      if (sharesByDate) {
        const setOn = (date) => {
          const day = sharesByDate.get(date);
          const hit = new Set();
          if (day) for (const c of codes) if (day.get(c)?.wan != null) hit.add(c);
          return hit;
        };
        const nowSet = setOn(cur.date);
        if (prevCodesWithData && nowSet.size !== prevCodesWithData.size) {
          const added = [...nowSet].filter((c) => !prevCodesWithData.has(c));
          if (added.length) reasons.push("constituent-new");
          // 成分数变了（增或减）：小类值跟着跳是「当日有数据的成分数变化」，
          // 不是资金进出，也不该算未知原因。减小的最常见场景是新成分尚未纳入披露。
          reasons.push(prevCodesWithData.size > nowSet.size ? "sub-coverage" : "constituent-new");
        }
        prevCodesWithData = nowSet;
        // 小基数：前值不到该小类中位数的 5%，百分比会被放大成几万 %
        vals.push(cur.val);
        const med = median(vals);
        if (med > 0 && prev.val < med * 0.05) reasons.push("small-base");
      }

      // 大额申赎：变动集中在少数成分的真实份额变化上，属于真实资金进出而非数据问题。
      // 判据：两日都有数据的成分里，|Δ| 前 3 名占全部 |Δ| 的 80% 以上，且发生变化的成分 ≤5 只。
      if (sharesByDate) {
        const dayPrev = sharesByDate.get(prev.date);
        const dayCur = sharesByDate.get(cur.date);
        if (dayPrev && dayCur) {
          const deltas = [];
          for (const c of codes) {
            const a = dayPrev.get(c)?.wan;
            const b = dayCur.get(c)?.wan;
            if (a != null && b != null) deltas.push(Math.abs(b - a));
          }
          const total = deltas.reduce((x, y) => x + y, 0);
          const moved = deltas.filter((x) => x > 0).length;
          deltas.sort((x, y) => y - x);
          const top3 = deltas.slice(0, 3).reduce((x, y) => x + y, 0);
          if (total > 0 && moved <= 5 && top3 / total >= 0.8) reasons.push("large-flow");
        }
      }

      if (!reasons.length) reasons.push("unknown");
      out.push({
        sub,
        date: cur.date,
        prev: prev.date,
        prevVal: prev.val,
        val: cur.val,
        pct: Math.round(pct * 100) / 100,
        reasons,
        severity: reasons.includes("unknown") ? "warn" : "info",
      });
    }
  }
  out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  return out;
}

/**
 * 一次抓取结果的体检：'ok' / 'partial'（未出齐）/ 'empty_suspect'（可疑的 200+空）/ 'empty_expected'（本就没有数据）
 * @param {{rows:number, expected?:number|null, minRatio?:number}} p
 */
export function assessDay({ rows, expected = null, minRatio = 0.6 } = {}) {
  if (rows == null || rows < 0) return "unknown";
  if (rows === 0) {
    if (expected == null || expected <= 0) return "empty_expected";
    return "empty_suspect";
  }
  if (expected == null || expected <= 0) return "ok";
  return rows / expected >= minRatio ? "ok" : "partial";
}

/** 覆盖度闸门：逐日判定（供告警/审计复用 db.coverageBand 的语义） */
export { dayCoverage };
