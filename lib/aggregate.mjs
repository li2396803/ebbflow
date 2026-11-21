// 聚合计算：原始份额 → 各细分行业序列 → 报表口径
import { loadUniverse } from "./universe.mjs";

const UNIVERSE = loadUniverse();
const SUB = UNIVERSE.SUB;
const CATS = UNIVERSE.CATS;
const ALL_CODES = UNIVERSE.ALL_CODES;
const BOND_CAT = "9_债券";

export const round1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
export const round4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
export const round2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/** 单个细分行业在给定日期集合上的取值（亿份，1 位小数） */
export function computeSub(store, subName, sharesByDate) {
  const meta = SUB[subName];
  const factor = meta.cat === BOND_CAT ? 100 : 1;
  return store.dates.map((d) => {
    const shares = sharesByDate(d);
    if (!shares) return null;
    let sum = 0;
    let hit = 0;
    for (const e of meta.etfs) {
      const v = shares[e.code];
      if (v != null) {
        sum += v;
        hit++;
      }
    }
    return hit ? round1((sum / 1e4) * factor) : null;
  });
}

/** 某一交易日：全市场 code→万份 映射 → {细分行业: 值} */
export function computeDay(subNames, sharesByCode) {
  const out = {};
  for (const name of subNames) {
    const meta = SUB[name];
    const factor = meta.cat === BOND_CAT ? 100 : 1;
    let sum = 0;
    for (const e of meta.etfs) {
      const v = sharesByCode[e.code];
      if (v != null) sum += v;
    }
    out[name] = round4((sum / 1e4) * factor);
  }
  return out;
}

/** 近 N 个自然日内的交易日下标（含最后一天） */
export function recentWindow(dates, days = 7) {
  if (!dates.length) return [];
  const last = new Date(dates[dates.length - 1] + "T00:00:00Z");
  const cutoff = new Date(last.getTime() - days * 86400000);
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    if (new Date(dates[i] + "T00:00:00Z") >= cutoff) out.push(i);
  }
  return out;
}

/** 各小类在窗口内的变化量 / 变化率 */
export function windowChanges(store, windowIdx) {
  const first = windowIdx[0];
  const last = windowIdx[windowIdx.length - 1];
  const rows = [];
  for (const cat of CATS) {
    for (const name of cat.subs) {
      const s = store.subs[name];
      if (!s) continue;
      let a = null;
      let b = s[last];
      for (let i = first; i <= last; i++) {
        if (s[i] != null && s[i] !== 0) {
          a = s[i];
          break;
        }
      }
      if (a == null || b == null || a === 0) continue;
      rows.push({ sub: name, cat: cat.key, delta: round1(b - a), pct: round2(((b - a) / a) * 100), first: a, last: b });
    }
  }
  return rows;
}

/** 大类规模表：当前 / 区间首日 / 变动比例 */
export function catScale(store, windowIdx) {
  const first = windowIdx[0];
  const last = windowIdx[windowIdx.length - 1];
  const groups = new Map();
  for (const cat of CATS) {
    const key = cat.key.replace(/^7_消费$/, "7_医药&消费").replace(/^7_医药$/, "7_医药&消费");
    if (!groups.has(key)) groups.set(key, { key, label: key.replace(/^\d+_/, ""), subs: [] });
    groups.get(key).subs.push(...cat.subs);
  }
  const rows = [];
  for (const [key, g] of groups) {
    const sumAt = (i) => {
      let t = 0;
      let ok = false;
      for (const n of g.subs) {
        const v = store.subs[n]?.[i];
        if (v != null) {
          t += v;
          ok = true;
        }
      }
      return ok ? t : null;
    };
    const now = sumAt(last);
    const start = sumAt(first);
    if (now == null) continue;
    const pct = start ? round2(((now - start) / start) * 100) : null;
    rows.push({ key, label: key, now: round1(now), start: round1(start), pct });
  }
  rows.sort((a, b) => b.now - a.now);
  return rows;
}

/** 把 2021-11-22 这类起点裁成"最近 5 年" */
export function fiveYearStart() {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 5);
  return d.toISOString().slice(0, 10);
}
