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
import { spawn } from "node:child_process";
import zlib from "node:zlib";
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
const DATA_DIR = path.join(SITE, "data");

/** 数据文件缓存（按 mtime 失效）：/api/* 直接复用构站产物，避免每次请求都跑同步 SQLite */
const fileCache = new Map();
const gzCache = new Map(); // path -> { mtimeMs, raw, gz }

/** 发送文件：支持 gzip 预压缩缓存 + ETag/304 + 长缓存，本地加载快 2~3 倍 */
async function sendFile(req, res, file, { cacheControl = "public, max-age=600", extra = {} } = {}) {
  try {
    const st = await fs.promises.stat(file);
    const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": cacheControl });
      return res.end();
    }
    let hit = gzCache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      const raw = await fs.promises.readFile(file);
      const compressible = /\.(json|js|css|svg|html|txt)$/i.test(file);
      const gz = compressible ? zlib.gzipSync(raw, { level: 6 }) : null;
      hit = { mtimeMs: st.mtimeMs, raw, gz };
      gzCache.set(file, hit);
      if (gzCache.size > 64) gzCache.delete(gzCache.keys().next().value);
    }
    const accept = String(req.headers["accept-encoding"] || "");
    const useGz = hit.gz && /gzip/.test(accept);
    const body = useGz ? hit.gz : hit.raw;
    const headers = {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
      ETag: etag,
      "Cache-Control": cacheControl,
      "Access-Control-Allow-Origin": "*",
      Vary: "Accept-Encoding",
      ...extra,
    };
    if (useGz) headers["Content-Encoding"] = "gzip";
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, baseHeaders);
    res.end("not found");
  }
}

async function readData(name, dir = DATA_DIR) {
  const f = path.join(dir, name + ".json");
  try {
    const st = await fs.promises.stat(f);
    const hit = fileCache.get(name);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.buf;
    const buf = await fs.promises.readFile(f);
    fileCache.set(name, { mtimeMs: st.mtimeMs, buf });
    return buf;
  } catch {
    return null;
  }
}

async function readJson(name, dir) {
  const buf = await readData(name, dir);
  if (!buf) return null;
  if (buf.parsed !== undefined) return buf.parsed;
  try {
    const obj = JSON.parse(buf.toString("utf8"));
    buf.parsed = obj;
    return obj;
  } catch {
    return null;
  }
}

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
  /** 兜底：数据文件缺失时（比如刚 clone 还没构站）才回落到动态构建 */
  async function payloadsFallback() {
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
      // 用子进程跑更新：重算是最长 20s 的同步 SQLite 工作，放在主进程会卡住所有请求
      const r = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(ROOT, "scripts", "update.mjs")], {
          cwd: ROOT,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d) => { out += d.toString(); });
        child.stderr.on("data", (d) => { out += d.toString(); });
        child.on("close", (code) => {
          const last = out.trim().split("\n").filter(Boolean).slice(-1)[0] || "";
          resolve({ code, last, out });
        });
        child.on("error", (e) => resolve({ code: -1, last: String(e.message), out }));
      });
      if (r.code !== 0) throw new Error(r.last || `update 退出码 ${r.code}`);
      const mark = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "lastrun.json"), "utf8"));
      lastRefresh = { at: new Date().toISOString(), ms: Date.now() - t0, result: { last: mark.lastTradeDate } };
      lastError = null;
      await invalidate();
      log(`[refresh] ${reason} → 最新交易日 ${mark.lastTradeDate}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { last: mark.lastTradeDate };
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
  const sendRaw = (res, code, buf) => {
    res.writeHead(code, { ...baseHeaders, "Content-Type": MIME[".json"], "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    res.end(buf);
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
      // 旧口径（legacy）数据：/api/legacy/<name>
      if (p.startsWith("/api/legacy/")) {
        const name = p.slice("/api/legacy/".length);
        const LEGACY = path.join(DATA_DIR, "legacy");
        if (name.startsWith("charts/")) {
          const b = await readData(`charts-${decodeURIComponent(name.slice(7))}`, LEGACY);
          return b ? sendRaw(res, 200, b) : json(res, 404, { error: "no legacy chart", key: name });
        }
        const b = await readData(name, LEGACY);
        return b ? sendRaw(res, 200, b) : json(res, 404, { error: "no legacy payload", name });
      }

      // 数据端点：优先直接读构站产物（零计算、按 mtime 缓存），缺失时才回落到动态构建
      if (p === "/api/meta") {
        const b = await readData("meta");
        if (b) return sendRaw(res, 200, b);
        return json(res, 200, (await payloadsFallback()).meta);
      }
      if (p === "/api/tables") {
        const b = await readData("tables");
        if (b) return sendRaw(res, 200, b);
        return json(res, 200, (await payloadsFallback()).tables);
      }
      if (p === "/api/market") {
        const b = await readData("market");
        if (b) return sendRaw(res, 200, b);
        const m = (await payloadsFallback()).market;
        return m ? json(res, 200, m) : json(res, 404, { error: "market not ready" });
      }
      if (p === "/api/subs") {
        const b = await readData("subs");
        if (b) return sendRaw(res, 200, b);
        return json(res, 200, (await payloadsFallback()).subs);
      }
      if (p === "/api/index") {
        const b = await readData("index");
        if (b) return sendRaw(res, 200, b);
        return json(res, 200, (await payloadsFallback()).index);
      }
      if (p === "/api/quality") {
        const b = await readData("quality");
        if (b) return sendRaw(res, 200, b);
        return json(res, 200, (await payloadsFallback()).quality);
      }
      if (p.startsWith("/api/sub/")) {
        const name = decodeURIComponent(p.slice("/api/sub/".length));
        const subs = (await readJson("subs")) ?? (await payloadsFallback()).subs;
        return subs && subs[name] ? json(res, 200, { name, ...subs[name] }) : json(res, 404, { error: "no such sub", name });
      }
      if (p.startsWith("/api/charts/")) {
        const key = decodeURIComponent(p.slice("/api/charts/".length));
        const b = await readData(`charts-${key}`);
        if (b) return sendRaw(res, 200, b);
        const charts = (await payloadsFallback()).charts;
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
      // 静态资源统一走 sendFile：gzip + ETag/304 + 缓存
      return sendFile(req, res, file, {
        cacheControl: path.extname(file) === ".json" ? "no-cache" : "public, max-age=600",
        extra: baseHeaders,
      });
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
      return payloadsFallback();
    },
  };
}
