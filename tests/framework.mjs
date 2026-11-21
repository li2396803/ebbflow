// 零依赖断言框架（tests/runner.mjs 的实现核心）
//
//   test(name, fn)            注册用例（fn 可 async）
//   skip(name, reason)        注册跳过的用例
//   skipNow(reason)           在用例内部跳过（抛出 Skip，由框架捕获）
//   note(msg)                 收集一条补充说明，跑完统一打印
//   assert / assertEq / ...   断言
//   runAll()                  顺序执行并打印，返回进程退出码
//
// 输出控制在几十行内：每个用例一行，失败才多打几行原因。

const registry = [];
const notes = [];

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}
export class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.name = "Skip";
  }
}

export function test(name, fn) {
  registry.push({ name, fn });
}
export function skip(name, reason) {
  registry.push({ name, reason, skipped: true });
}
export function skipNow(reason) {
  throw new Skip(reason);
}
export function note(msg) {
  if (notes.length < 8) notes.push(String(msg));
}

const fmt = (v) => {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean" || v == null) return String(v);
  try {
    const s = JSON.stringify(v);
    return s && s.length > 120 ? `${s.slice(0, 117)}…` : s;
  } catch {
    return String(v);
  }
};
const tail = (msg, n = 160) => (String(msg).length > n ? `${String(msg).slice(0, n)}…` : String(msg));

export function assert(cond, msg = "断言失败") {
  if (!cond) throw new AssertionError(msg);
}
export function assertEq(actual, expected, msg = "值不相等") {
  if (!Object.is(actual, expected)) throw new AssertionError(`${msg}：期望 ${fmt(expected)}，实际 ${fmt(actual)}`);
}
export function assertNotEq(actual, unexpected, msg = "值不应相等") {
  if (Object.is(actual, unexpected)) throw new AssertionError(`${msg}：实际 ${fmt(actual)}`);
}
export function assertClose(actual, expected, eps = 1e-6, msg = "数值不在容差内") {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps)
    throw new AssertionError(`${msg}：期望 ${fmt(expected)} ± ${eps}，实际 ${fmt(actual)}`);
}
export function assertDeepEq(actual, expected, msg = "结构不相等") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new AssertionError(`${msg}：期望 ${tail(b)}，实际 ${tail(a)}`);
}
export function assertMatch(str, re, msg = "格式不匹配") {
  if (!re.test(String(str))) throw new AssertionError(`${msg}：${fmt(str)} 不匹配 ${re}`);
}
export function assertThrows(fn, re, msg = "应当抛错") {
  let thrown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  if (!thrown) throw new AssertionError(`${msg}：没有抛错`);
  if (re && !re.test(String(thrown.message))) throw new AssertionError(`${msg}：错误信息不匹配 ${re}（实际 ${fmt(thrown.message)}）`);
  return thrown;
}
export function assertIncludes(arr, value, msg = "未包含期望元素") {
  if (!Array.isArray(arr) || !arr.some((x) => Object.is(x, value) || JSON.stringify(x) === JSON.stringify(value)))
    throw new AssertionError(`${msg}：${fmt(value)} 不在 ${fmt(arr)}`);
}

const ms = (t) => `${t}ms`;

export async function runAll({ title = "etf-flow 数据质量测试" } = {}) {
  const t0 = Date.now();
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];
  console.log(title);
  for (const [i, c] of registry.entries()) {
    const label = `[${i + 1}/${registry.length}] ${c.name}`;
    if (c.skipped) {
      skipped++;
      console.log(`  - ${label} → SKIP（${c.reason}）`);
      continue;
    }
    const t = Date.now();
    try {
      await c.fn();
      passed++;
      console.log(`  ✓ ${label}（${ms(Date.now() - t)}）`);
    } catch (e) {
      if (e instanceof Skip) {
        skipped++;
        console.log(`  - ${label} → SKIP（${e.message}）`);
        continue;
      }
      failed++;
      failures.push({ name: c.name, msg: tail(e?.message || e) });
      console.log(`  ✗ ${label}（${ms(Date.now() - t)}）`);
    }
  }
  for (const f of failures) {
    console.log(`    ↳ ${f.name}：${f.msg}`);
  }
  for (const n of notes) console.log(`  · ${n}`);
  const total = Date.now() - t0;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped（${total}ms）`);
  return failed === 0 ? 0 : 1;
}

export function registrySize() {
  return registry.length;
}
