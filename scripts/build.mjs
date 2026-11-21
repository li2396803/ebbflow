import { loadSeries, saveSeries } from "../lib/store.mjs";
import { buildSite, trimToFiveYears } from "../lib/build.mjs";
const store = trimToFiveYears(loadSeries());
saveSeries(store);
const r = buildSite(store);
console.log("已生成站点：", r);
