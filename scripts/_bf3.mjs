import { openDb, putNav } from "../lib/db.mjs";
import { navOnDate } from "../lib/tushare.mjs";
const db = openDb();
const dates = db.prepare("SELECT DISTINCT date FROM dayinfo WHERE has_sse=1 ORDER BY date").all().map(r=>r.date);
const counts = dates.map(d => ({ d, n: db.prepare("SELECT COUNT(*) n FROM nav WHERE date=?").get(d).n }));
const med = counts.map(x=>x.n).sort((a,b)=>a-b)[Math.floor(counts.length/2)];
const todo = counts.filter(x => x.n < med * 0.9).map(x=>x.d);
console.log("仍需补:", todo.length, "天 | 中位数", med);
let filled=0, done=0;
for (const d of todo) {
  try { const m = await navOnDate(d); if (m.size) { putNav(db, [...m].map(([c,v])=>[c,d,v])); filled += m.size; } done++; }
  catch(e) { if (/上限/.test(e.message)) { console.log("触及上限，已处理", done); break; } }
  if (done % 100 === 0 && done) console.log(`进度 ${done}/${todo.length}`);
}
console.log("本轮补写", filled, "行，处理", done, "天");
db.close();
