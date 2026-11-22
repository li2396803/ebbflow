// Vite 构建：把 web/ 打成带内容哈希的产物，输出到 web/dist（再由 lib/build/site.mjs 拷进 site/）。
// 目标：ES2019（Chrome 63+/Safari 12+/Firefox 67+ 都能开），避免把现代语法直接丢给旧浏览器。
import { defineConfig } from "vite";
import { resolve } from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const ROOT = process.cwd();

/**
 * Service Worker 构建插件：
 * · public/ 里的静态文件先被 vite 原样拷到 dist（manifest / sw.js / icons）
 * · 构建结束后把 dist 里的产物清单与内容哈希注入 sw.js，避免手写缓存清单过期
 */
function serviceWorkerPlugin() {
  return {
    name: "ebbflow-sw",
    apply: "build",
    closeBundle() {
      const dist = resolve(ROOT, "web/dist");
      const template = resolve(ROOT, "web/public/sw.js");
      if (!fs.existsSync(dist) || !fs.existsSync(template)) return;

      const assetsDir = resolve(dist, "assets");
      const assets = fs.existsSync(assetsDir)
        ? fs
            .readdirSync(assetsDir)
            .filter((f) => /\.(js|css|png|svg|jpg|jpeg|webp|woff2?)$/.test(f))
            .sort()
            .map((f) => `assets/${f}`)
        : [];
      const precache = ["./", "./index.html", "./manifest.webmanifest", ...assets];

      // 版本 = 预缓存清单 + 入口文件内容哈希，任何构建变化都会换 cache 名
      const hash = crypto.createHash("sha256");
      hash.update(precache.join("\n"));
      try {
        hash.update(fs.readFileSync(resolve(dist, "index.html")));
      } catch {}
      const build = hash.digest("hex").slice(0, 12);

      const out = fs
        .readFileSync(template, "utf8")
        .replace(/__BUILD__/g, build)
        .replace("__PRECACHE_ARRAY__", JSON.stringify(precache, null, 2));
      fs.writeFileSync(resolve(dist, "sw.js"), out);
    },
  };
}

export default defineConfig({
  root: resolve("web"),
  base: "./", // GitHub Pages 子路径托管，必须相对
  publicDir: resolve("web/public"), // manifest / sw.js / PWA 图标
  build: {
    outDir: resolve("web/dist"),
    emptyOutDir: true,
    target: "es2019",
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 4096,
    rollupOptions: {
      input: resolve("web/index.html"),
      output: {
        // ECharts 单独成 chunk：首屏并行下载，命中缓存后复访几乎零成本
        manualChunks(id) {
          if (id.includes("node_modules/echarts") || id.includes("node_modules/zrender")) return "echarts";
          return undefined;
        },
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  plugins: [serviceWorkerPlugin()],
  esbuild: { legalComments: "none" },
});
