import { test, assert, assertEq, assertClose } from "../framework.mjs";
import { classifyPair, relDiff, compareCodes, compareSubs, subCommon } from "../../scripts/reconcile.mjs";
import { subCodes } from "../helpers.mjs";

test("交叉校验：分档、逐 code 比对与小类公共成分比对（偏离方指认）", () => {
  // ① 分档：完全一致 / ≤0.1% / ≤1% / >1%
  assertEq(classifyPair(100, 100).bucket, "identical", "完全一致");
  assertEq(classifyPair(100, 100.05).bucket, "le0.1", "0.05% 应落在 ≤0.1%");
  assertEq(classifyPair(100, 100.5).bucket, "le1", "0.5% 应落在 ≤1%");
  assertEq(classifyPair(100, 103).bucket, "gt1", "3% 应为 >1%");
  assertEq(classifyPair(103, 100).bucket, "gt1", "反向偏离同样 >1%");

  // ② 相对差以交易所（官方口径）为分母
  assertClose(relDiff(1000, 1030), 0.03, 1e-12, "ts 高于交易所 3%");
  assertClose(relDiff(1000, 970), 0.03, 1e-12, "ts 低于交易所 3%");
  assertEq(relDiff(0, 5), 1, "交易所为 0 时退回 |ts| 作分母（|5-0|/5 = 1）");

  // ③ 逐 code：2 只公共，1 只一致、1 只偏离
  const [c1, c2] = subCodes("A股大盘");
  const ex = new Map([
    [c1, 1000],
    [c2, 2000],
  ]);
  const src = new Map([
    [c1, "sse"],
    [c2, "sse"],
  ]);
  const ts = new Map([
    [c1, 1000],
    [c2, 2060],
  ]);
  const { stats, detail } = compareCodes(ex, src, ts);
  assertEq(stats.both, 2, "公共 code 数");
  assertEq(stats.identical, 1, "完全一致数");
  assertEq(stats.gt1, 1, ">1% 分歧数");
  assertEq(detail.length, 1, "明细条数");
  assertEq(detail[0].code, c2, "明细应是偏离的那只");
  assertEq(detail[0].src, "sse", "明细应标注交易所侧来源");
  assertClose(detail[0].relPct, 3, 1e-9, "明细相对差 %");

  // 只有一侧有数据的代码计入缺失，不算分歧
  const { stats: s2 } = compareCodes(new Map([[c1, 100]]), new Map([[c1, "sse"]]), new Map([[c2, 200]]));
  assertEq(s2.onlyExchange, 1, "只有交易所");
  assertEq(s2.onlyTs, 1, "只有 ts");
  assertEq(s2.both, 0, "无公共代码");

  // ④ 小类层：只用公共成分，债券小类 ×100 一并验证
  const bondSub = "可转债与可交换债";
  const [b1, b2] = subCodes(bondSub);
  const ex2 = new Map([
    [b1, 10000],
    [b2, 10000],
  ]);
  const ts2 = new Map([
    [b1, 11000],
    [b2, 10000],
  ]);
  const cm = subCommon(bondSub, ex2, ts2);
  assertEq(cm.n, 2, "公共成分数");
  assertClose(cm.a, 200, 1e-9, "交易所侧 20000 万份 → 200（×100）");
  assertClose(cm.b, 210, 1e-9, "ts 侧 21000 万份 → 210（×100）");

  const rows = compareSubs(ex2, ts2);
  assertEq(rows.length, 86, "小类层应覆盖全部 86 项");
  const row = rows.find((r) => r.sub === bondSub);
  assert(row, "应包含债券小类那一行");
  assertEq(row.status, "both", "两侧都有数据");
  assertEq(row.inconsistent, true, "5% 偏离应判不一致");
  assertClose(row.relPct, 5, 1e-9, "偏离 5%");
  assertEq(row.deviant, "ts", "以交易所为基准，偏离方应是 ts");

  // 只有一侧有数据 → single-source，不判不一致
  const onlyEx = compareSubs(ex2, new Map());
  const r2 = onlyEx.find((r) => r.sub === bondSub);
  assertEq(r2.status, "single-source", "单源应标记 single-source");
  assertEq(r2.inconsistent, false, "单源不应判不一致");
});
