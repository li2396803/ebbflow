// 本地服务：静态托管 site/，并在打开页面时自动把数据刷到最新
//
//   node server.mjs            # 前台运行（默认 http://localhost:5188）
//   PORT=8080 node server.mjs  # 指定端口
//   node server.mjs --no-refresh
//
// 自动保鲜策略：
//   · 启动时先判断数据是否过期，过期就后台刷新一次（页面不阻塞，刷新完自动生效）
//   · 每次访问首页都会检查一次（30 分钟内已刷过则跳过），刷新期间不会重复触发
//   · 进程内每 20 分钟兜底检查一次，用于长期挂着的场景
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, "site");
const MARK = path.join(ROOT, "data", "last-run.json");
const PORT = Number(process.env.PORT || 5188);
const HOST = process.env.HOST || "127.0.0.1";
const NO_REFRESH = process.argv.includes("--no-refresh");
const MIN_INTERVAL_MS = 30 * 60 * 1000; // 页面触发的最小刷新间隔
const TICK_MS = 20 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

let refreshing = false;
let lastRefreshAt = 0;
let lastError = null;

const readMark = () => {
  try {
    return JSON.parse(fs.readFileSync(MARK, "utf8"));
  } catch {
    return null;
  }
};

/** 数据是否应该刷新：距上次跑太久，或者今天收盘后还没跑过 */
function isStale() {
  if (NO_REFRESH) return false;
  const mark = readMark();
  if (!mark?.lastRunAt) return true;
  const now = new Date();
  const ranAt = new Date(mark.lastRunAt);
  const ageMs = now - ranAt;

  // 今天（本地时间）已经跑过、且晚于最近收盘时间点，就不再打扰
  const latest = mark.latestTradeDate;
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = ymd(now);
  const weekday = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const afterClose = minutes >= 16 * 60;
  const isWorkday = weekday >= 1 && weekday <= 5;
  // 盘中（09:15–15:05）不频繁打接口：只有数据已超过 20 小时没更新才刷新
  if (isWorkday && minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 5) return ageMs > 20 * 3600 * 1000;
  if (isWorkday && afterClose && latest === today) return ageMs > 6 * 3600 * 1000;
  // 周末/盘中：只要当天跑过就算新鲜
  if (ymd(ranAt) === today) return false;
  return ageMs > MIN_INTERVAL_MS;
}

async function refresh(reason) {
  if (refreshing || NO_REFRESH) return { skipped: true };
  if (Date.now() - lastRefreshAt < MIN_INTERVAL_MS) return { skipped: "too soon" };
  refreshing = true;
  lastRefreshAt = Date.now();
  const t0 = Date.now();
  try {
    const { update } = await import("./scripts/update.mjs");
    const r = await update({ quiet: true });
    lastError = null;
    console.log(`[refresh] ${reason} → 最新交易日 ${r.last}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return r;
  } catch (e) {
    lastError = String(e?.message || e);
    console.error(`[refresh] 失败：${lastError}`);
    return { error: lastError };
  } finally {
    refreshing = false;
  }
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/api/status") {
    return send(
      res,
      200,
      JSON.stringify({ refreshing, lastError, mark: readMark(), now: new Date().toISOString() }, null, 2),
      { "Content-Type": MIME[".json"] }
    );
  }
  if (pathname === "/api/refresh") {
    const r = await refresh("手动");
    return send(res, 200, JSON.stringify(r), { "Content-Type": MIME[".json"] });
  }

  // 打开页面时顺手保鲜（不阻塞响应）
  if (pathname === "/" || pathname === "/index.html") {
    if (isStale()) refresh("页面访问");
  }

  let rel = pathname === "/" ? "/index.html" : pathname;
  let file = path.normalize(path.join(SITE, rel));
  if (!file.startsWith(SITE)) return send(res, 403, "forbidden");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (rel === "/index.html") return send(res, 503, "站点还未生成，请先运行 npm run seed && npm run update", { "Content-Type": MIME[".html"] });
    return send(res, 404, "not found");
  }
  const ext = path.extname(file).toLowerCase();
  return send(res, 200, fs.readFileSync(file), { "Content-Type": MIME[ext] || "application/octet-stream" });
});

server.listen(PORT, HOST, () => {
  console.log(`ETF 资金流向（本地版）→ http://localhost:${PORT}`);
  const mark = readMark();
  if (mark?.latestTradeDate) console.log(`当前数据：最新交易日 ${mark.latestTradeDate}（${mark.dates} 个交易日）`);
  else console.log("当前还没有数据，正在拉取…");
  if (isStale()) refresh("启动");
  setInterval(() => {
    if (isStale()) refresh("定时");
  }, TICK_MS).unref();
});

const shutdown = () => {
  console.log("\n正在退出…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
