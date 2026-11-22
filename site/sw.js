/* ==========================================================================
   Ebbflow service worker
   --------------------------------------------------------------------------
   构建期由 vite 插件注入版本号与预缓存清单（见 vite.config.mjs 的 ebbflow-sw）。
   策略：
   · 导航请求：network-first，离线回落到缓存的 index.html（应用壳）
   · data/**\/*.json：stale-while-revalidate（先回缓存，后台更新）
   · data/archive/*：cache-first（历史快照不可变）
   · assets/*：cache-first（文件名带内容哈希）
   ========================================================================== */
const BUILD = "e006648ffd86";
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "assets/echarts-CuWbhTCt.js",
  "assets/favicon-32-ZsoecZyu.png",
  "assets/favicon-DC2ug5o6.svg",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/icon-maskable-512.png",
  "assets/index-xc3p1b2J.js",
  "assets/parse-worker-Cf78Uxl7.js",
  "assets/style-BBcpdhvS.css",
  "assets/vendor-echarts-BcWCC1BA.js"
];

const SHELL_CACHE = `ebbflow-shell-${BUILD}`;
const DATA_CACHE = `ebbflow-data-${BUILD}`;
const ARCHIVE_CACHE = `ebbflow-archive-${BUILD}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 单个资源失败不阻断整次安装
      await Promise.all(
        PRECACHE.map((url) =>
          // 不强制 reload：允许复用页面已下载的 HTTP 缓存，避免安装期重复占带宽
          cache.add(new Request(url)).catch(() => {})
        )
      );
    })()
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, DATA_CACHE, ARCHIVE_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("ebbflow-") && !keep.has(k)).map((k) => caches.delete(k)));
      // 不用 clients.claim() 静默接管：由页面在用户确认刷新后（SKIP_WAITING）再接管
    })()
  );
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (hit) {
    network.catch(() => {});
    return hit;
  }
  const fresh = await network;
  return fresh || Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // 应用壳：新的优先，离线时回落到缓存
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put("./index.html", fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match(req)) ||
            (await cache.match("./index.html")) ||
            (await cache.match("./")) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  const path = url.pathname;
  if (/\/data\/archive\//.test(path)) {
    event.respondWith(cacheFirst(req, ARCHIVE_CACHE));
    return;
  }
  if (/\/data\//.test(path) && /\.json$/.test(path)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  if (/\/assets\//.test(path)) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }
  if (/manifest\.webmanifest$/.test(path)) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
  }
});
