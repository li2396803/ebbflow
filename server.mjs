// 本地服务入口
//   node server.mjs                # 前台运行，默认 http://localhost:5188
//   PORT=8080 node server.mjs      # 指定端口
//   node server.mjs --no-refresh   # 关闭自动刷新
import { createApp } from "./server/app.mjs";

const port = Number(process.env.PORT || 5188);
const noRefresh = process.argv.includes("--no-refresh");
const app = createApp({ port, autoRefresh: !noRefresh });
app.listen();

const shutdown = () => {
  console.log("\n正在退出…");
  app.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
