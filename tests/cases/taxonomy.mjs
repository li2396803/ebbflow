import { test, assert, assertEq, assertMatch, assertDeepEq } from "../framework.mjs";
import { CATS, SUB, ALL_CODES, BOND_CAT } from "../../lib/taxonomy.mjs";

test("taxonomy：86 个小类 / 773 个唯一代码 / 结构完整", () => {
  const subNames = Object.keys(SUB);
  assertEq(subNames.length, 86, "细分行业数量");
  assertEq(ALL_CODES.length, 773, "标的代码数量");
  assertEq(new Set(ALL_CODES).size, 773, "标的代码不得重复");
  assertEq(CATS.length, 10, "大类数量");

  // 大类：key 唯一、label、color、subs 与 SUB 一一对应
  const catKeys = new Set();
  const catSubs = [];
  for (const cat of CATS) {
    assert(!catKeys.has(cat.key), `大类 key 重复：${cat.key}`);
    catKeys.add(cat.key);
    assertMatch(cat.color, /^#[0-9A-F]{6}$/i, `大类 ${cat.key} 颜色格式`);
    assert(cat.label && cat.label.length > 0, `大类 ${cat.key} 缺 label`);
    assert(Array.isArray(cat.subs) && cat.subs.length > 0, `大类 ${cat.key} 没有小类`);
    catSubs.push(...cat.subs);
  }
  assertEq(catSubs.length, 86, "CATS 汇总的小类数");
  assertEq(new Set(catSubs).size, 86, "小类不得重复归属多个大类");
  assertDeepEq([...catSubs].sort(), [...subNames].sort(), "CATS 的小类清单应与 SUB 完全一致");

  // 每个小类：非空、code 6 位、name 非空、颜色 #RRGGBB、cat 合法
  const seen = new Set();
  for (const [name, meta] of Object.entries(SUB)) {
    assert(catKeys.has(meta.cat), `小类 ${name} 的 cat「${meta.cat}」不在 CATS 中`);
    assertMatch(meta.color, /^#[0-9A-F]{6}$/i, `小类 ${name} 颜色格式`);
    assert(Array.isArray(meta.etfs) && meta.etfs.length > 0, `小类 ${name} 没有成分 ETF`);
    for (const e of meta.etfs) {
      assertMatch(e.code, /^\d{6}$/, `小类 ${name} 的代码`);
      assert(typeof e.name === "string" && e.name.length > 0, `小类 ${name} 的 ${e.code} 缺名称`);
      seen.add(e.code);
    }
  }
  assertEq(seen.size, 773, "成分代码去重后应为 773");
  assertDeepEq([...seen].sort(), [...ALL_CODES].sort(), "ALL_CODES 应等于全部成分代码的并集");
  assertEq(BOND_CAT, "9_债券", "债券大类 key");

  // 代码前缀：分类体系全部为沪市代码（深市快照不参与小类聚合）
  const nonSh = [...seen].filter((c) => !/^[56]/.test(c));
  assertEq(nonSh.length, 0, `出现了非沪市代码：${nonSh.slice(0, 5).join(",")}`);
});
