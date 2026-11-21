// 本地服务：静态站点 + JSON API + 数据自动保鲜
//
//   GET  /api/meta              站点元信息（最新交易日、区间、来源、告警）
//   GET  /api/charts/:catKey    某大类的三张图数据（c1/c2/c3）
//   GET  /api/tables            首页三张表 + 全量排行
//   GET  /api/subs              全部细分行业明细（成分 ETF）
//   GET  /api/sub/:name         单个细分行业明细（name 需 encodeURIComponent）
//   GET  /api/index             搜索索引
//   GET  /api/quality           数据质量/交叉校验摘要
//   GET  /api/status            服务与刷新状态
//   POST /api/refresh           手动触发一次增量更新
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNATURE, FINGERPRINT } from "../lib/signature.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = path.join(ROOT, "site");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".csv": "text/csv; charset=utf-8",
};
const CACHE_TTL = 45_000;

export function createApp({ port = 5188, host = "127.0.0.1", autoRefresh = true, log = console.log } = {}) {
  let db = null;
  let cache = null;
  let refreshing = false;
  let lastRefresh = null;
  let lastError = null;

  async function getDb() {
    if (!db) db = (await import("../lib/db.mjs")).openDb();
    return db;
  }
  async function invalidate() {
    cache = null;
  }
  async function payloads() {
    if (cache && Date.now() - cache.at < CACHE_TTL) return cache.p;
    const { buildAllPayloads } = await import("../lib/payloads.mjs");
    const p = buildAllPayloads(await getDb(), { updatedAt: lastRefresh?.at });
    cache = { at: Date.now(), p };
    return p;
  }

  async function refresh(reason) {
    if (refreshing) return { skipped: "already-running" };
    refreshing = true;
    const t0 = Date.now();
    try {
      const { update } = await import("../scripts/update.mjs");
      const r = await update({ quiet: true });
      lastRefresh = { at: new Date().toISOString(), ms: Date.now() - t0, result: r };
      lastError = null;
      await invalidate();
      log(`[refresh] ${reason} → 最新交易日 ${r.last}, ${(Date.now() - t0) / 1000}s`);
      return r;
    } catch (e) {
      lastError = String(e?.message || e);
      log(`[refresh] 失败：${lastError}`);
      return { error: lastError };
    } finally {
      refreshing = false;
    }
  }

  function isStale() {
    if (!autoRefresh) return false;
    const mark = path.join(ROOT, "data", "lastrun.json");
    try {
      const j = JSON.parse(fs.readFileSync(mark, "utf8"));
      const age = Date.now() - new Date(j.at).getTime();
      const now = new Date();
      const min = now.getHours() * 60 + now.getMinutes();
      const isWorkday = now.getDay() >= 1 && now.getDay() <= 5;
      const hhmm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      if (isWorkday && min >= 9 * 60 + 15 && min < 15 * 60 + 5) return age > 20 * 3600 * 1000;
      if (j.lastTradeDate === hhmm) return age > 6 * 3600 * 1000;
      return age > 30 * 60 * 1000;
    } catch {
      return true;
    }
  }

  const baseHeaders = {
    "X-Powered-By": `${SIGNATURE.project}/${SIGNATURE.version}`,
    "X-Project-Author": SIGNATURE.author,
    "X-Project-Signature": FINGERPRINT,
  };
  const json = (res, code, obj) => {
    res.writeHead(code, { ...baseHeaders, "Content-Type": MIME[".json"], "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === "/api/status") {
        return json(res, 200, { ok: true, refreshing, lastRefresh, lastError, now: new Date().toISOString() });
      }
      if (p === "/api/refresh") {
        const r = await refresh(req.method === "POST" ? "手动" : "page");
        return json(res, 200, r);
      }
      if (p === "/api/meta") return json(res, 200, (await payloads()).meta);
      if (p === "/api/tables") return json(res, 200, (await payloads()).tables);
      if (p === "/api/subs") return json(res, 200, (await payloads()).subs);
      if (p === "/api/index") return json(res, 200, (await payloads()).index);
      if (p === "/api/quality") return json(res, 200, (await payloads()).quality);
      if (p.startsWith("/api/sub/")) {
        const name = decodeURIComponent(p.slice("/api/sub/".length));
        const subs = (await payloads()).subs;
        return subs[name] ? json(res, 200, { name, ...subs[name] }) : json(res, 404, { error: "no such sub", name });
      }
      if (p.startsWith("/api/charts/")) {
        const key = decodeURIComponent(p.slice("/api/charts/".length));
        const charts = (await payloads()).charts;
        if (!charts[key]) return json(res, 404, { error: "no such category", key, available: Object.keys(charts) });
        return json(res, 200, charts[key]);
      }
      if (p.startsWith("/api/")) return json(res, 404, { error: "unknown endpoint", path: p });

      // 静态资源
      if (p === "/" || p === "/index.html") {
        if (isStale()) refresh("页面访问");
      }
      let rel = p === "/" ? "/index.html" : p;
      const file = path.normalize(path.join(SITE, rel));
      if (!file.startsWith(SITE)) return json(res, 403, { error: "forbidden" });
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (rel === "/index.html") {
          res.writeHead(503, { "Content-Type": MIME[".html"] });
          return res.end("站点尚未构建，请先运行 npm run build");
        }
        return json(res, 404, { error: "not found", path: p });
      }
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": path.extname(file) === ".json" ? "no-store" : "public, max-age=60",
      });
      res.end(fs.readFileSync(file));
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
  });

  server.on("listening", () => {
    log(`ETF 资金流向（本地版）→ http://localhost:${port}`);
    if (isStale()) refresh("启动");
  });

  return {
    server,
    listen: () => server.listen(port, host),
    close: () => server.close(),
    refresh,
    get payloads() {
      return payloads();
    },
  };
}
