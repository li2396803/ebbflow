const H={Referer:"https://www.szse.cn/","User-Agent":"Mozilla/5.0 (Macintosh)"};
async function page(n){
  const u=`https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1105&TABKEY=tab1&PAGENO=${n}`;
  const r=await fetch(u,{headers:H}); return r.json();
}
const first=await page(1);
const meta=first[0].metadata;
console.log("name",meta.name,"pagesize",meta.pagesize,"pagecount",meta.pagecount,"recordcount",meta.recordcount);
let rows=first[0].data||[];
for(let p=2;p<=meta.pagecount;p++){ const j=await page(p); rows.push(...(j[0].data||[])); }
console.log("rows",rows.length);
const strip=s=>String(s??"").replace(/<[^>]+>/g,"").trim();
const parsed=rows.map(r=>({
  code:strip(r.sys_key), name:strip(r.jjjcurl), cls:strip(r.jjlb), inv:strip(r.tzlb),
  gm:parseFloat(strip(r.dqgm).replace(/,/g,""))
}));
console.log("sample:",JSON.stringify(parsed.slice(0,2)));
console.log("cls values:",[...new Set(parsed.map(p=>p.cls))]);
console.log("etf-like codes:",parsed.filter(p=>/^(15|16|18)/.test(p.code)).length);
(await import("node:fs")).writeFileSync("data/_probe_szse.json",JSON.stringify(parsed));
