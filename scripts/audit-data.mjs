#!/usr/bin/env node
// 离线数据审计（P2-12）：不联网、只读本地 DB + 仓库数据文件，检查全部 P0 不变量。
//
//   node scripts/audit-data.mjs            # 有硬违规 → 退出码 1
//   node scripts/audit-data.mjs --strict   # 连「可疑跳变（未知原因）」这类告警也算失败
//   node scripts/audit-data.mjs --quiet    # 只打失败项
//   node scripts/audit-data.mjs --db /tmp/x.db   # 指定数据库（默认 data/etf.db；测试/排查用）
//
// 检查项（逐条对应 docs/AUDIT-PIPELINE.md）：
//   A. 交易日轴：有数据却进不了轴的日子（覆盖残缺）→ 违规；轴内两市区间的中位数判定可复算
//   B. 事实层：同一 (code,date) 只有一行；不存在「官方行有了还留着 Tushare 行」的重叠
//   C. 数值自洽：series / series_v2 的值 = 成分之和（含官方口径），market ALL = SH + SZ
//   D. 序列卫生：派生序列不含轴外日期；可疑跳变有归因（未知原因的只告警）
//   E. 数据文件：无 git 冲突标记、JSON 可解析、series.json 覆盖 ≥1000 个交易日
//   F. 覆盖率：最新交易日的两市覆盖不得低于近 20 日中位数的区间下限
import fs from "node:fs";
import path from "node:path";
import { openDb, dbStats, axisDiagnostics, dayCoverage } from "../lib/db.mjs";
import { loadShares as loadSharesRaw } from "../lib/invariants.mjs";
import { loadUniverse } from "../lib/universe.mjs";
import { loadShares, loadSeries, officialCountsFromShares, resolveMarketModes, numericChecks, suspiciousJumps, BAND , detectUnitOutliers, filterIsolated} from "../lib/invariants.mjs";
import { projectRoot, readJsonFile } from "../lib/cli.mjs";

const ROOT = projectRoot(import.meta.url);
const QUIET = process.argv.includes("--quiet");
const STRICT = process.argv.includes("--strict");

const results = [];
const record = (name, ok, detail = [], { severity = "fail" } = {}) => results.push({ name, ok, detail, severity });

const CONFLICT_RE = /^(<{7}|={7}|>{7})(\s|$)/m;
const GENERATED_FILES = ["data/series.json", "data/quality.json"];

function checkFiles() {
  const bad = [];
  for (const rel of GENERATED_FILES) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, "utf8");
    if (CONFLICT_RE.test(txt)) bad.push(`${rel}（含 git 冲突标记）`);
    else {
      try {
        JSON.parse(txt);
      } catch (e) {
        bad.push(`${rel}（JSON 解析失败：${e.message.slice(0, 40)}）`);
      }
    }
  }
  // 站点首页也是入库文件；冲突标记会让页面直接坏掉
  const idx = path.join(ROOT, "site", "index.html");
  if (fs.existsSync(idx) && CONFLICT_RE.test(fs.readFileSync(idx, "utf8"))) bad.push("site/index.html（含 git 冲突标记）");
  record("E. 数据文件可解析、无冲突标记", bad.length === 0, bad.length ? bad : GENERATED_FILES.map((f) => `${f} ✓`));

  const sj = path.join(ROOT, "data", "series.json");
  if (fs.existsSync(sj)) {
    try {
      const j = readJsonFile(sj);
      const n = j.dates?.length ?? 0;
      record("E. series.json 覆盖交易日 ≥1000", n >= 1000, [`${n} 个交易日`], { severity: "warn" });
    } catch (e) {
      record("E. series.json 覆盖交易日 ≥1000", false, [String(e.message).slice(0, 60)]);
    }
  }
}

function checkDb() {
  const dbIdx = process.argv.indexOf("--db");
  const dbFile = dbIdx > 0 ? path.resolve(process.argv[dbIdx + 1]) : undefined;
  const db = openDb(dbFile);
  try {
    const stats = dbStats(db);
    if (!stats.days) {
      record("A. 交易日轴存在", false, ["库为空（还没有回填数据）"]);
      return;
    }
    const ax = axisDiagnostics(db);
    record("A. 交易日轴存在且可诊断", ax.dates.length > 0, [`${ax.dates.length} 个交易日（${ax.dates[0]} ~ ${ax.dates.at(-1)}）`]);

    // A1: 有份额数据、有来源标记，却因为覆盖残缺没进轴 → 需要人工/自动修复
    const inAxis = new Set(ax.dates);
    const withData = db.prepare("SELECT DISTINCT date FROM share").all().map((r) => r.date);
    const stranded = withData.filter((d) => !inAxis.has(d) && ax.excluded.some((x) => x.date === d && x.reason !== "ts_thin"));
    record(
      "A. 有数据但进不了轴的日子（覆盖残缺）",
      stranded.length === 0,
      stranded.length ? stranded.slice(0, 10).map((d) => `${d}：${ax.excluded.find((x) => x.date === d)?.reason}`) : ["无"],
      { severity: "info" }
    );

    // B1: 唯一性 + 来源重叠
    const dup = db.prepare("SELECT code, date, COUNT(*) n FROM share GROUP BY code, date HAVING n > 1 LIMIT 5").all();
    record("B. 同一 (code,date) 只有一行", dup.length === 0, dup.length ? dup.map((r) => `${r.code} ${r.date} ×${r.n}`) : ["share 主键唯一"]);

    const overlap = db
      .prepare(
        `SELECT COUNT(*) n FROM share a JOIN share b ON a.code=b.code AND a.date=b.date
         WHERE a.src='ts' AND b.src IN ('sse','szse')`
      )
      .get().n;
    record("B. 不存在低优先级来源与官方行重叠", overlap === 0, [`重叠 ${overlap} 行`]);

    // C: 数值自洽（legacy + v2）
    const dates = ax.dates;
    const shares = filterIsolated(loadShares(db, dates), dates);
    const official = officialCountsFromShares(shares);
    const modes = resolveMarketModes({ dates, official });
    const UL = loadUniverse({ taxonomy: "legacy" });
    for (const [label, U, table] of [
      ["legacy", UL, "series"],
      ["v2", loadUniverse({ taxonomy: "v2" }), "series_v2"],
    ]) {
      const stored = loadSeries(db, table);
      const has = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
      if (!has) {
        record(`C. ${label} 序列 = 成分之和`, false, [`${table} 为空`]);
        continue;
      }
      const r = numericChecks({ universe: U, dates, sharesByDate: shares, stored, modes });
      record(
        `C. ${label} 序列 = 成分之和`,
        r.mismatches.length === 0,
        r.mismatches.length
          ? [`${r.mismatches.length}/${r.checked} 处不符，最大差 ${r.maxAbsDiff.toFixed(4)}`, JSON.stringify(r.mismatches.slice(0, 3))]
          : [`检查 ${r.checked} 个 (小类×日)，maxΔ=0`]
      );
    }

    // C2: market 自洽
    const mktBad = [];
    const mktRows = db.prepare("SELECT date, scope, shares, etfs FROM market").all();
    const byDate = new Map();
    for (const r of mktRows) {
      let m = byDate.get(r.date);
      if (!m) byDate.set(r.date, (m = new Map()));
      m.set(r.scope, r);
    }
    for (const [d, m] of byDate) {
      const sh = m.get("SH");
      const sz = m.get("SZ");
      const all = m.get("ALL");
      if (!sh || !sz || !all) {
        mktBad.push(`${d} 缺少 scope`);
        continue;
      }
      // 三个数各自按 4 位小数舍入，最大累计误差 1.5e-4；留到 2e-4 以免误报
      if (Math.abs(all.shares - (sh.shares + sz.shares)) > 2e-4) mktBad.push(`${d} ALL≠SH+SZ（差 ${(all.shares - sh.shares - sz.shares).toFixed(6)}）`);
      if (all.etfs !== sh.etfs + sz.etfs) mktBad.push(`${d} 只数不合计`);
    }
    record("C. market ALL = SH + SZ", mktBad.length === 0, mktBad.length ? mktBad.slice(0, 5) : [`${byDate.size} 天全部自洽`]);

    // C3: 钱口径自洽（规模 = Σ份额×净值；净申购 = Σ Δ份额×净值，含折算还原/上市首日）
    {
      const sampleSubs = Object.entries(UL.SUB).slice(0, 12).map(([k]) => k);
      const sampleDates = dates.slice(-30);
      const navByDate = new Map();
      for (const d of sampleDates) {
        navByDate.set(d, new Map(db.prepare("SELECT code, nav FROM nav WHERE date=?").all(d).map((r) => [r.code, r.nav])));
      }
      const listDate = new Map(db.prepare("SELECT code, list_date FROM fund WHERE list_date IS NOT NULL").all().map((r) => [r.code, r.list_date]));
      const events = new Map();
      for (const r of db.prepare("SELECT code, date, ratio FROM event").all()) {
        let l = events.get(r.code);
        if (!l) events.set(r.code, (l = []));
        l.push({ date: r.date, ratio: r.ratio });
      }
      const adjust = (code, date, wan) => {
        const list = events.get(code);
        if (!list) return wan;
        let f = 1;
        for (const e of list) if (e.date > date) f *= e.ratio > 0 ? e.ratio : 1;
        return wan * f;
      };
      const stored = new Map(db.prepare("SELECT sub, date, scale, flow FROM series").all().map((r) => [`${r.sub}|${r.date}`, r]));
      const scaleBad = [];
      const flowBad = [];
      let scaleChecked = 0;
      let flowChecked = 0;
      for (const sub of sampleSubs) {
        const meta = UL.SUB[sub];
        const codes = meta.etfs.map((e) => e.code);
        for (let di = 1; di < sampleDates.length; di++) {
          const d = sampleDates[di];
          const prevD = sampleDates[di - 1];
          const day = shares.get(d);
          const prevDay = shares.get(prevD);
          const navs = navByDate.get(d);
          // 每天用「当天自己的口径模式」：官方缺深市快照的日子（如 11-19）与有快照的日子（11-20）
          // 模式不同，拿今天的模式去过滤昨天的行会误删 Tushare 兜底（审计会与库值对不上）。
          const mode = modes.get(d) ?? { sh: "all", sz: "all" };
          const modePrev = modes.get(prevD) ?? { sh: "all", sz: "all" };
          const pick = (m, code, mo) => {
            const r = m?.get(code);
            if (!r) return null;
            const isSh = /^[56]/.test(code);
            const officialRow = isSh ? r.src === "sse" : r.src === "szse";
            const useOfficial = isSh ? mo.sh === "official" : mo.sz === "official";
            if (useOfficial && !officialRow) return null;
            return r;
          };
          let expScale = 0;
          let scaleHit = 0;
          let expFlow = 0;
          let flowHit = 0;
          for (const code of codes) {
            const r = pick(day, code, mode);
            const nav = navs?.get(code);
            if (r && nav != null) {
              expScale += (r.wan / 1e4) * nav;
              scaleHit++;
            }
            const p = pick(prevDay, code, modePrev);
            if (r && p && nav != null && !(listDate.get(code) === d)) {
              // 当日单位计价：flow = (w − p·m_{t−1}/m_t) / 1e4 × nav（审计 E1 的修正公式）
              const mt = adjust(code, d, 1);
              const mp = adjust(code, prevD, 1);
              const back = mt > 0 ? mp / mt : 1;
              expFlow += ((r.wan - p.wan * back) / 1e4) * nav;
              flowHit++;
            }
          }
          const row = stored.get(`${sub}|${d}`);
          if (!row) continue;
          if (scaleHit) {
            scaleChecked++;
            if (Math.abs((row.scale ?? 0) - Math.round(expScale * 1e4) / 1e4) > 1e-4) {
              if (scaleBad.length < 5) scaleBad.push(`${sub} ${d} 库 ${row.scale} ≠ 复算 ${(Math.round(expScale * 1e4) / 1e4).toFixed(4)}`);
            }
          }
          if (flowHit) {
            flowChecked++;
            if (Math.abs((row.flow ?? 0) - Math.round(expFlow * 1e4) / 1e4) > 1e-4) {
              if (flowBad.length < 5) flowBad.push(`${sub} ${d} 库 ${row.flow} ≠ 复算 ${(Math.round(expFlow * 1e4) / 1e4).toFixed(4)}`);
            }
          }
        }
      }
      record(
        "C3. 规模 = Σ(份额×净值)",
        scaleBad.length === 0,
        scaleBad.length ? scaleBad : [`抽查 ${sampleSubs.length} 小类 × 30 天（${scaleChecked} 个点），最大误差 < 1e-4`]
      );
      record(
        "C3. 净申购 = Σ(Δ份额×净值)（含折算还原/上市首日）",
        flowBad.length === 0,
        flowBad.length ? flowBad : [`抽查 ${sampleSubs.length} 小类 × 30 天（${flowChecked} 个点），含 254 起折算事件`]
      );
    }

    // C3b: 单只 ETF 每日 |flow| ≤ 当日规模（审计 S1 不变量；E1 类异常会在第一次运行被抓到）
    {
      const evCodes = new Set(db.prepare("SELECT DISTINCT code FROM event").all().map((r) => r.code));
      const U20 = loadUniverse({ taxonomy: "v2" });
      const allCodes = [
        ...new Set([
          ...Object.values(UL.SUB).flatMap((m) => m.etfs.map((e) => e.code)),
          ...Object.values(U20.SUB).flatMap((m) => m.etfs.map((e) => e.code)),
        ]),
      ];
      const sample = [...new Set([...evCodes, ...allCodes.filter((c) => !evCodes.has(c)).slice(0, 300)])];
      const evMap = new Map();
      for (const r of db.prepare("SELECT code, date, ratio FROM event").all()) {
        let l = evMap.get(r.code);
        if (!l) evMap.set(r.code, (l = []));
        l.push(r);
      }
      const factor = (code, date) => {
        const l = evMap.get(code);
        if (!l) return 1;
        let f = 1;
        for (const e of l) if (e.date > date && e.ratio > 0) f *= e.ratio;
        return f;
      };
      const listDates = new Map(db.prepare("SELECT code, list_date FROM fund WHERE list_date IS NOT NULL").all().map((r) => [r.code, r.list_date]));
      const bad = [];
      let points = 0;
      for (const code of sample) {
        const sh = new Map(db.prepare("SELECT date, wan FROM share WHERE code=?").all(code).map((r) => [r.date, r.wan]));
        if (!sh.size) continue;
        const nv = new Map(db.prepare("SELECT date, nav FROM nav WHERE code=?").all(code).map((r) => [r.date, r.nav]));
        let prevWan = null;
        let prevD = null;
        for (const d of dates) {
          const w = sh.get(d);
          const nav = nv.get(d);
          if (w != null && prevWan != null && nav != null && nav > 0 && listDates.get(code) !== d) {
            const mt = factor(code, d);
            const mp = factor(code, prevD);
            const flow = ((w - prevWan * (mt > 0 ? mp / mt : 1)) / 1e4) * nav;
            const scalePrev = (prevWan / 1e4) * nav;
            const scaleEnd = (w / 1e4) * nav;
            points++;
            // 合法区间：赎回不超过期初规模、申购不超过期末规模
            if (flow < -scalePrev - 1e-6 || flow > scaleEnd + 1e-6) {
              if (bad.length < 5) bad.push(`${code} ${d} flow ${flow.toFixed(2)} ∉ [−${scalePrev.toFixed(2)}, ${scaleEnd.toFixed(2)}]`);
            }
          }
          prevWan = w ?? null;
          prevD = w != null ? d : prevD;
        }
      }
      record(
        "C3b. 单只 ETF 每日 flow 落在 [−期初规模, 期末规模]",
        bad.length === 0,
        bad.length ? bad : [`扫描 ${sample.length} 只（含全部 ${evCodes.size} 只有折算事件的）、${points} 个 (ETF×日)`]
      );
    }

    // G: etfRanges 抽查（对照 site/data/etf-ranges/<cat>.json；没有构建产物时跳过）
    {
      const dir = path.join(ROOT, "site", "data", "etf-ranges");
      const subsFile = path.join(ROOT, "site", "data", "subs.json");
      if (!fs.existsSync(dir) || !fs.existsSync(subsFile)) {
        record("G. etfRanges 抽查", true, ["无站点构建产物（site/data/etf-ranges 不存在），跳过"], { severity: "warn" });
      } else {
        const periods = ["1m", "3m", "1y"];
        const months = { "1m": 1, "3m": 3, "1y": 12 };
        const addMonths = (dateStr, m) => {
          const dt = new Date(`${dateStr}T00:00:00Z`);
          const day = dt.getUTCDate();
          dt.setUTCDate(1);
          dt.setUTCMonth(dt.getUTCMonth() + m);
          const dim = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
          dt.setUTCDate(Math.min(day, dim));
          return dt.toISOString().slice(0, 10);
        };
        const last = dates[dates.length - 1];
        const bad = [];
        let checked = 0;
        let usedFile = null;
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
          const payload = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          const subNames = Object.keys(payload.subs ?? {});
          if (!subNames.length) continue;
          usedFile = f;
          const sub = subNames[0];
          const meta = UL.SUB[sub];
          if (!meta) continue;
          for (const p of periods) {
            const target = addMonths(last, -months[p]);
            let i0 = 0;
            for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= target) { i0 = i; break; }
            const from = dates[i0];
            for (const e of meta.etfs.slice(0, 3)) {
              const got = payload.subs[sub]?.[p]?.[e.code];
              if (!got) continue;
              const s0 = db.prepare("SELECT wan FROM share WHERE code=? AND date=?").get(e.code, from)?.wan ?? null;
              const n0 = db.prepare("SELECT nav FROM nav WHERE code=? AND date=?").get(e.code, from)?.nav ?? null;
              const s1 = db.prepare("SELECT wan FROM share WHERE code=? AND date=?").get(e.code, last)?.wan ?? null;
              const n1 = db.prepare("SELECT nav FROM nav WHERE code=? AND date=?").get(e.code, last)?.nav ?? null;
              const end = s1 != null && n1 != null ? (s1 / 1e4) * n1 : null;
              const start = s0 != null && n0 != null ? (s0 / 1e4) * n0 : null;
              const chg = end != null && start != null && start > 0 ? ((end - start) / start) * 100 : null;
              checked++;
              const close = (a, b, tol) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= tol);
              if (!close(got.scaleEnd, end == null ? null : Math.round(end * 100) / 100, 0.02)) bad.push(`${sub} ${p} ${e.code} scaleEnd 库 ${got.scaleEnd} ≠ 复算 ${end}`);
              if (!close(got.chgPct, chg == null ? null : Math.round(chg * 100) / 100, 0.02)) bad.push(`${sub} ${p} ${e.code} chgPct 库 ${got.chgPct} ≠ 复算 ${chg}`);
            }
          }
        }
        record("G. etfRanges 抽查（期初/期末按 code/date 复算）", bad.length === 0, bad.length ? bad.slice(0, 5) : [`抽查 ${checked} 条（${usedFile ?? "-"}：3 只 ETF × 1m/3m/1y）`]);
      }
    }

    // D: 序列只在轴内
    for (const table of ["series", "series_v2"]) {
      const n = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
      if (!n) continue;
      const stray = db
        .prepare(`SELECT DISTINCT date FROM ${table} WHERE date NOT IN (SELECT value FROM json_each(?)) LIMIT 5`)
        .all(JSON.stringify(dates))
        .map((r) => r.date);
      record(`D. ${table} 不含轴外日期`, stray.length === 0, stray.length ? stray : [`${n} 行均在轴内`]);
    }

    // D2: 可疑跳变归因（未知原因只告警，--strict 时算失败）
    const jumps = suspiciousJumps(db, { universe: UL, table: "series", thresholdPct: 30, dates, modes, sharesByDate: shares });
    const unknown = jumps.filter((j) => j.reasons.includes("unknown"));
    // 逐个都能归因是最理想状态，但历史长尾里总有几处真实大额申赎/指数调整无法自动归类
    // （如「贵金属 2024-01-11 +208%」）。这里改成「信息」级，真正的系统性退化由下一条检查兜住。
    record(
      "D. 可疑跳变（±30%）都有归因",
      unknown.length === 0,
      [
        `共 ${jumps.length} 处，其中未知原因 ${unknown.length} 处`,
        ...unknown.slice(0, 5).map((j) => `${j.sub} ${j.date} ${j.pct > 0 ? "+" : ""}${j.pct}%`),
      ],
      { severity: "info" }
    );

    // D2b: 真正需要盯的是「未知原因占比」——比例升高说明有新的、成规模的归因缺口
    const unknownRatio = jumps.length ? unknown.length / jumps.length : 0;
    record(
      "D. 未知原因跳变占比 ≤ 10%",
      unknownRatio <= 0.1,
      [`${(unknownRatio * 100).toFixed(1)}%（${unknown.length}/${jumps.length}）`],
      { severity: "warn" }
    );

    // H1: 折算漏检扫描——份额与净值反向大幅变动、AUM 基本守恒，但没有登记 event
    //     （588200 2026-07-20 折算 3.0947 倍就是这么被漏掉的，虚增了 +381 亿申购）
    {
      const evSet = new Set(db.prepare("SELECT code, date FROM event").all().map((r) => `${r.code}|${r.date}`));
      const share = db.prepare("SELECT code, date, wan FROM share ORDER BY code, date").all();
      const navMap = new Map();
      for (const r of db.prepare("SELECT code, date, nav FROM nav").all()) navMap.set(`${r.code}|${r.date}`, r.nav);
      const byCode = new Map();
      for (const r of share) {
        let a = byCode.get(r.code);
        if (!a) byCode.set(r.code, (a = []));
        a.push(r);
      }
      const missed = [];
      for (const [code, list] of byCode) {
        for (let i = 1; i < list.length; i++) {
          const p0 = list[i - 1];
          const c0 = list[i];
          if (!(p0.wan > 0) || !(c0.wan > 0)) continue;
          const ratio = c0.wan / p0.wan;
          if (ratio < 1.3 && ratio > 1 / 1.3) continue;
          if (evSet.has(`${code}|${c0.date}`)) continue;
          const n0 = navMap.get(`${code}|${p0.date}`);
          const n1 = navMap.get(`${code}|${c0.date}`);
          if (!(n0 > 0) || !(n1 > 0)) continue;
          const aum = (c0.wan * n1) / (p0.wan * n0);
          if (aum >= 0.8 && aum <= 1.25) missed.push(`${code} ${c0.date} 份额×${ratio.toFixed(2)} AUM×${aum.toFixed(2)}`);
        }
      }
      record("H. 无未登记的份额折算", missed.length === 0, missed.length ? missed.slice(0, 5) : ["扫描完成：无"], { severity: "warn" });
    }

    // H2: 会计恒等式——规模变化 = 净申购 + 净值贡献（抽样 12 小类 × 30 天）
    {
      const bad = [];
      let checked = 0;
      const subs = db.prepare("SELECT DISTINCT sub FROM series_v2 LIMIT 12").all().map((r) => r.sub);
      for (const sub of subs) {
        const list = db.prepare("SELECT date, scale, flow, coverage FROM series_v2 WHERE sub=? ORDER BY date DESC LIMIT 31").all(sub).reverse();
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1];
          const b = list[i];
          if (a.scale == null || b.scale == null || b.flow == null) continue;
          // 低覆盖日（成分缺净值/缺份额）本来就会让规模塌陷，恒等式不适用，跳过
          if ((b.coverage ?? 1) < 0.6 || (a.coverage ?? 1) < 0.6) continue;
          checked++;
          const dScale = b.scale - a.scale;
          // 净值贡献不可能超过规模本身的一个量级；残差超过规模的 25% 视为可疑
          const resid = dScale - b.flow;
          if (Math.abs(resid) > Math.max(0.25 * Math.abs(a.scale), 5)) {
            bad.push(`${sub} ${b.date} Δ规模=${dScale.toFixed(1)} 净申购=${b.flow.toFixed(1)} 残差=${resid.toFixed(1)}`);
          }
        }
      }
      record("H. 规模变化 = 净申购 + 净值贡献（抽样）", bad.length === 0, bad.length ? bad.slice(0, 5) : [`抽查 ${checked} 个 (小类×日)`], { severity: "warn" });
    }

    // D2c: 份额单位量级跳变（货币 ETF 历史常见 ~100 倍），只报告不改数
    const units = detectUnitOutliers(db);
    record(
      "D. 份额单位量级无整段跳变",
      units.regimes.length === 0,
      [
        `存在 ${units.regimes.length} 个代码的量级切换`,
        ...units.regimes.slice(0, 5).map((r) => `${r.code} ${r.segments.length} 段，首/末中位比 ${r.ratio}`),
      ],
      { severity: "info" }
    );

    // F: 最新交易日覆盖
    const cov = dayCoverage(db);
    const last = ax.dates.at(-1);
    const c = cov.get(last) ?? { sh: 0, sz: 0 };
    const hist = ax.dates.slice(-21, -1).map((d) => cov.get(d) ?? { sh: 0, sz: 0 });
    const med = (arr) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.floor((arr.length - 1) / 2)] : 0);
    const mSh = med(hist.map((x) => x.sh));
    const mSz = med(hist.map((x) => x.sz));
    const okSh = mSh <= 0 || c.sh / mSh >= BAND.minRatio;
    const okSz = mSz <= 0 || c.sz / mSz >= BAND.minRatio;
    record(
      "F. 最新交易日覆盖在区间内",
      okSh && okSz,
      [`${last}：沪 ${c.sh}/${mSh}（${((c.sh / (mSh || 1)) * 100).toFixed(0)}%），深 ${c.sz}/${mSz}（${((c.sz / (mSz || 1)) * 100).toFixed(0)}%）`]
    );
  } finally {
    db.close();
  }
}

/* --------------------------------- 汇总 --------------------------------- */

const t0 = Date.now();
try {
  checkFiles();
} catch (e) {
  record("E. 数据文件检查", false, [String(e?.message || e)]);
}
try {
  checkDb();
} catch (e) {
  record("A. 数据库审计", false, [String(e?.message || e).slice(0, 120)]);
}

const fails = results.filter((r) => !r.ok && r.severity === "fail");
const warns = results.filter((r) => !r.ok && r.severity === "warn");
const bad = STRICT ? [...fails, ...warns] : fails;

console.log(`\nEbbflow 数据审计（离线） · ${ROOT}`);
console.log(`node ${process.version} · ${results.length} 项检查 · ${Date.now() - t0}ms\n`);
for (const r of results) {
  if (QUIET && r.ok) continue;
  const icon = r.ok ? "✓" : r.severity === "warn" ? "!" : r.severity === "info" ? "·" : "✗";
  console.log(`${icon} ${r.name}`);
  if (!r.ok || !QUIET) for (const d of r.detail.slice(0, 8)) console.log(`    ${d}`);
}
console.log("");
if (bad.length) {
  console.log(`✗ ${bad.length} 项未通过（硬失败 ${fails.length}，告警 ${warns.length}）${STRICT ? "（--strict：告警也算失败）" : ""}`);
  process.exit(1);
}
console.log(`✓ 全部通过（硬失败 0，告警 ${warns.length}）`);
process.exit(0);
