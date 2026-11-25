// 测试入口：node tests/runner.mjs
//
// 框架本体在 tests/framework.mjs（零依赖断言），用例在 tests/cases/*.mjs。
// 每个用例一行输出；失败时多打一行原因；退出码 0=全过，1=有失败。
import { runAll } from "./framework.mjs";

// 用例模块在 import 时自注册（顺序即执行顺序）
import "./cases/taxonomy.mjs";
import "./cases/caliber.mjs";
import "./cases/db-priority.mjs";
import "./cases/rules.mjs";
import "./cases/series.mjs";
import "./cases/range.mjs";
import "./cases/reconcile.mjs";
import "./cases/invariants.mjs";
import "./cases/metrics.mjs";
import "./cases/platform.mjs";
import "./cases/exchange.mjs";

export * from "./framework.mjs";

const code = await runAll({ title: "Ebbflow 数据质量与校验层 · 测试" });
process.exit(code);
