import { test, assert, assertEq } from "../framework.mjs";
import { validateDay } from "../../lib/validate.mjs";
import { loadUniverse } from "../../lib/universe.mjs";

const { SUB, ALL_CODES } = loadUniverse();
import { flatShares, subCodes } from "../helpers.mjs";

const day = (shares, prevShares, opts) => validateDay({ date: "2026-11-20", shares, prevShares, opts });
const codeOf = (sub, i = 0) => subCodes(sub)[i];
const issuesFor = (res, code, kind) => res.issues.filter((i) => i.code === code && (!kind || i.kind === kind));

test("校验规则：3 倍单只份额跳变必须标 error", () => {
  const code = codeOf("A股大盘");
  const prev = flatShares(1000);
  const now = flatShares(1000);
  now.set(code, 3000); // 3 倍（+200%）
  const res = day(now, prev);
  const hit = issuesFor(res, code, "fund_jump");
  assertEq(hit.length, 1, `${code} 应有一条 fund_jump`);
  assertEq(hit[0].severity, "error", "3 倍跳变应为 error");
  assertEq(res.level, "error", "整体 level 应为 error");
  assertEq(res.ok, false, "ok 应为 false");
});

test("校验规则：warn 区间 / 数量级异常 / 白名单", () => {
  const code = codeOf("半导体芯片");
  const prev = flatShares(1000);

  // 1.6 倍 → warn（超过 50% 但未到 3 倍）
  const warnDay = flatShares(1000);
  warnDay.set(code, 1600);
  const w = day(warnDay, prev);
  const w1 = issuesFor(w, code, "fund_jump");
  assertEq(w1.length, 1, "1.6 倍应有一条 fund_jump");
  assertEq(w1[0].severity, "warn", "1.6 倍应为 warn");

  // 100 倍 → 数量级异常 error
  const bigDay = flatShares(1000);
  bigDay.set(code, 100000);
  const b = day(bigDay, prev);
  const b1 = issuesFor(b, code, "fund_jump_magnitude");
  assertEq(b1.length, 1, "100 倍应判 fund_jump_magnitude");
  assertEq(b1[0].severity, "error", "数量级异常应为 error");

  // 白名单（新股/新发）→ 跳过跳变判定，不产生该 code 的 error
  const wl = validateDay({ date: "2026-11-20", shares: bigDay, prevShares: prev, opts: { whitelist: [code] } });
  assertEq(issuesFor(wl, code).filter((i) => i.severity === "error").length, 0, "白名单应跳过跳变判定");
});

test("校验规则：覆盖度骤降 / 小类整段缺失 / 零负值", () => {
  const prev = flatShares(1000);

  // ① 覆盖度骤降：前一日 773 只，当日只剩 100 只
  const few = new Map([...ALL_CODES].slice(0, 100).map((c) => [c, 1000]));
  const r1 = day(few, prev);
  const drop = r1.issues.filter((i) => i.kind === "coverage_drop");
  assertEq(drop.length, 1, "应报一次覆盖度骤降");
  assertEq(drop[0].severity, "error", "覆盖度骤降应为 error");

  // ② 小类整段缺失：抽掉「船舶」全部成分
  const target = "船舶";
  const missing = flatShares(1000);
  for (const c of subCodes(target)) missing.delete(c);
  const r2 = day(missing, flatShares(1000));
  const miss = r2.issues.filter((i) => i.kind === "sub_missing" && i.code === target);
  assertEq(miss.length, 1, `「${target}」应报 sub_missing`);
  assertEq(miss[0].severity, "error", "小类缺失应为 error");

  // ③ 零值 / 负值 → error
  const z = flatShares(1000);
  z.set(codeOf("A股大盘"), 0);
  z.set(codeOf("A股中盘"), -5);
  const r3 = day(z, flatShares(1000));
  const z0 = r3.issues.filter((i) => i.kind === "fund_value" && i.code === codeOf("A股大盘"));
  const zn = r3.issues.filter((i) => i.kind === "fund_value" && i.code === codeOf("A股中盘"));
  assertEq(z0.length, 1, "零值应报 fund_value");
  assertEq(z0[0].severity, "error", "零值应为 error");
  assertEq(zn.length, 1, "负值应报 fund_value");
  assertEq(zn[0].severity, "error", "负值应为 error");

  // ④ 正常的平稳日不应报错
  const calm = validateDay({ date: "2026-11-20", shares: flatShares(1000), prevShares: flatShares(1000) });
  assertEq(calm.level, "ok", "无变化的一天应判定 ok");
  assertEq(calm.issues.filter((i) => i.severity === "error").length, 0, "无变化的一天不应有 error");
  assert(SUB[target] !== undefined, "样本小类应存在");
});
