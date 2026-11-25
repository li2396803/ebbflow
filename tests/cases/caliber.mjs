import { test, assertEq, assertClose } from "../framework.mjs";
import { SUB, BOND_CAT } from "../../lib/taxonomy.mjs";
import { computeDay } from "../../lib/aggregate.mjs";
import { subValues } from "../../lib/validate.mjs";
import { subCodes } from "../helpers.mjs";

// 内部分额口径（series.val）：v4 起份额不再对外展示，只用于计算净申购；
// 对外的「规模/净申购/变化率」见 tests/cases/metrics.mjs。
// 固定样本：60000 万份 = 6 亿份；债券类再 ×100
const SUB_A = "A股大盘"; // 67 只成分
const SUB_B = "信用债"; // 4 只成分，属 9_债券

test("内部分额口径：sum/1e4 与债券 ×100（series.val，不再对外展示）", () => {
  const a = subCodes(SUB_A);
  const sharesA = { [a[0]]: 10000, [a[1]]: 20000, [a[2]]: 30000 }; // 合计 60000 万份
  assertEq(computeDay([SUB_A], sharesA)[SUB_A], 6, "3 只合计 60000 万份 → 6 亿份");
  assertEq(subValues(sharesA)[SUB_A], 6, "validate.subValues 应与 computeDay 一致");

  // 单只 1 万份 → 0.0001 亿份（4 位小数口径）
  assertEq(computeDay([SUB_A], { [a[0]]: 1 })[SUB_A], 0.0001, "1 万份 → 0.0001 亿份");

  // 债券类：50000 万份 /1e4 = 5 亿份，×100 → 500
  const b = subCodes(SUB_B);
  const sharesB = { [b[0]]: 30000, [b[1]]: 20000 };
  assertEq(computeDay([SUB_B], sharesB)[SUB_B], 500, "债券小类应 ×100");
  assertEq(subValues(sharesB)[SUB_B], 500, "validate.subValues 债券小类应 ×100");

  // 9 个债券小类全部按 ×100 处理；非债券小类不放大
  const bondSubs = Object.entries(SUB).filter(([, m]) => m.cat === BOND_CAT);
  assertEq(bondSubs.length, 9, "债券小类数量");
  for (const [name, meta] of bondSubs) {
    const v = subValues({ [meta.etfs[0].code]: 10000 })[name];
    assertEq(v, 100, `债券小类 ${name} 应 ×100（1 万份→100）`);
  }
  const nonBond = Object.entries(SUB).find(([, m]) => m.cat !== BOND_CAT);
  assertEq(subValues({ [nonBond[1].etfs[0].code]: 10000 })[nonBond[0]], 1, `非债券小类 ${nonBond[0]} 不应放大`);

  // 没有任何成分有数据 → null（不是 0）
  assertEq(subValues({})[SUB_A], null, "无成分数据时应为 null");
  assertClose(computeDay([SUB_A], {})[SUB_A], 0, 1e-12, "computeDay 无数据返回 0（历史行为）");
});
