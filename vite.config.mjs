// Vite 构建：把 web/ 打成带内容哈希的产物，输出到 web/dist（再由 lib/build/site.mjs 拷进 site/）。
// 目标：ES2019（Chrome 63+/Safari 12+/Firefox 67+ 都能开），避免把现代语法直接丢给旧浏览器。
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve("web"),
  base: "./", // GitHub Pages 子路径托管，必须相对
  publicDir: false, // 静态图片由站点构建统一拷贝（web/assets）
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
  esbuild: { legalComments: "none" },
});
