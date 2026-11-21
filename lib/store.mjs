// 本地数据仓库
//  data/series.json        各细分行业的权威时间序列（种子来自原站快照，之后每个交易日追加）
//  data/shares/<date>.json 当日全市场原始份额快照（万份），用于审计与重算
import fs from "node:fs";
import path from "node:path";

export const ROOT = new URL("..", import.meta.url).pathname;
export const DATA_DIR = path.join(ROOT, "data");
export const SHARES_DIR = path.join(DATA_DIR, "shares");
const SERIES_FILE = path.join(DATA_DIR, "series.json");

export function loadSeries() {
  if (!fs.existsSync(SERIES_FILE)) return { dates: [], subs: {}, meta: {} };
  const raw = JSON.parse(fs.readFileSync(SERIES_FILE, "utf8"));
  raw.dates ??= [];
  raw.subs ??= {};
  raw.meta ??= {};
  return raw;
}

/** 保证每个细分行业数组长度与 dates 一致（缺的补 null） */
export function normalize(store) {
  const n = store.dates.length;
  for (const [k, arr] of Object.entries(store.subs)) {
    if (!Array.isArray(arr)) {
      store.subs[k] = new Array(n).fill(null);
      continue;
    }
    if (arr.length > n) store.subs[k] = arr.slice(0, n);
    else if (arr.length < n) store.subs[k] = arr.concat(new Array(n - arr.length).fill(null));
  }
  return store;
}

export function saveSeries(store) {
  store = normalize(store);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 按日期升序写入，保持稳定 diff
  const sorted = [...store.dates].sort();
  const out = { dates: sorted, subs: store.subs, meta: store.meta };
  const tmp = SERIES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, SERIES_FILE);
}

export function loadDayShares(date) {
  const f = path.join(SHARES_DIR, `${date}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function saveDayShares(date, payload) {
  fs.mkdirSync(SHARES_DIR, { recursive: true });
  const f = path.join(SHARES_DIR, `${date}.json`);
  fs.writeFileSync(f, JSON.stringify(payload));
}

export function listShareDates() {
  if (!fs.existsSync(SHARES_DIR)) return [];
  return fs
    .readdirSync(SHARES_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

/** 把某一交易日的各小类值写入序列（同日重复写入会被覆盖） */
export function upsertDay(store, date, subValues) {
  const i = store.dates.indexOf(date);
  if (i >= 0) {
    for (const [k, v] of Object.entries(subValues)) if (store.subs[k]) store.subs[k][i] = v;
    return;
  }
  store.dates.push(date);
  store.dates.sort();
  const idx = store.dates.indexOf(date);
  for (const [k, series] of Object.entries(store.subs)) {
    series.splice(idx, 0, Object.hasOwn(subValues, k) ? subValues[k] : null);
  }
}

export function ensureSubs(store, subNames) {
  for (const name of subNames) store.subs[name] ??= [];
}
