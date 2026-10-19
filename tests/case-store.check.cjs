/**
 * 税务案例库存取自测：暂存（含校验失败/docid去重）、发布/下架状态机、总览与已发布列表。
 *
 * 单独成文件，而不是塞进 v14-rules.check.cjs：case-store.ts 全是异步文件IO，
 * v14-rules.check.cjs 的 t() 断言助手是同步的（和 knowledge-store.check.cjs 同样的理由）。
 *
 * 运行前：
 *   1. 先跑一遍 v14-rules.check.cjs 头部注释里的 tsc 编译命令（已把
 *      lib/case-validator.ts、lib/server/case-store.ts 加进那条命令的文件列表），产出 .v14build/。
 *   2. node tests/case-store.check.cjs
 *
 * 用一个临时目录当 LOCAL_CASE_DIR，跑完自动清理，不会碰到真实案例库文件。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "case-store-test-"));
process.env.LOCAL_CASE_DIR = tempDir;

const {
  stageCase,
  publishCase,
  withdrawCase,
  getCaseOverview,
  getPublishedCases,
  CaseValidationError,
} = require("./lib/server/case-store.js");

let pass = 0;
let failed = false;
async function t(name, f) {
  try {
    await f();
    console.log("  ✓", name);
    pass++;
  } catch (e) {
    console.log("  ✗", name, "->", e.message);
    failed = true;
  }
}

const SAMPLE_MD = (docid, caseName) => `# 税务判例结构化记录（草稿，待人工审核）

**案件名称**：${caseName}

**法院与年份**：ITAT Delhi, 2019

**IndianKanoon文档ID**：${docid}

**争议税种以及主管税局**：所得税（转让定价）— 印度所得税局

**税局主张（Revenue's Position）**：
1. AMP支出构成向关联方提供的国际交易

**企业抗辩方向（Assessee's Argument）**：
1. AMP支出是境内经营决策，不构成国际交易

**最终裁定结果**：
1. 支持纳税人，撤销转让定价调整

**证据支撑要点**：
1. 缺乏关联方之间存在AMP安排的协议证据

**印度数据库链接**：https://indiankanoon.org/doc/${docid}/

---

## 对中资企业的参考价值

供参考。
`;

const BROKEN_MD = `# 税务判例结构化记录（草稿，待人工审核）

**法院与年份**：ITAT Delhi, 2019
`;

(async () => {
  console.log("== 税务案例库：暂存/发布/下架 ==");

  await t("校验失败的草稿会抛 CaseValidationError，不会写入store", async () => {
    await assert.rejects(
      () => stageCase("broken.md", BROKEN_MD),
      (error) => {
        assert.ok(error instanceof CaseValidationError);
        assert.ok(error.errors.length > 0);
        return true;
      },
    );
  });

  const staged = await stageCase("samsung.md", SAMPLE_MD("135502389", "Samsung India Electronics Pvt Ltd vs Acit"));
  await t("暂存成功后状态是TO_REVIEW", () => {
    assert.strictEqual(staged.record.status, "TO_REVIEW");
    assert.strictEqual(staged.duplicate, false);
  });

  await t("刚暂存时不在已发布列表里", async () => {
    const published = await getPublishedCases();
    assert.ok(!published.some((c) => c.id === staged.record.id));
  });

  await t("同一个docid重复上传会复用已有记录，不产生重复数据", async () => {
    const again = await stageCase("samsung-copy.md", SAMPLE_MD("135502389", "Samsung India Electronics Pvt Ltd vs Acit"));
    assert.strictEqual(again.duplicate, true);
    assert.strictEqual(again.record.id, staged.record.id);
    const overview = await getCaseOverview();
    assert.strictEqual(overview.filter((c) => c.docid === "135502389").length, 1);
  });

  const published = await publishCase(staged.record.id);
  await t("发布后状态是PUBLISHED", () => {
    assert.strictEqual(published.status, "PUBLISHED");
  });
  await t("发布后进入已发布列表", async () => {
    const list = await getPublishedCases();
    assert.ok(list.some((c) => c.id === staged.record.id));
  });

  const withdrawn = await withdrawCase(staged.record.id);
  await t("下架后状态是WITHDRAWN", () => {
    assert.strictEqual(withdrawn.status, "WITHDRAWN");
  });
  await t("下架后立刻退出已发布列表", async () => {
    const list = await getPublishedCases();
    assert.ok(!list.some((c) => c.id === staged.record.id));
  });
  await t("下架是软删除：记录还在总览里，字段没丢", async () => {
    const overview = await getCaseOverview();
    const record = overview.find((c) => c.id === staged.record.id);
    assert.ok(record, "总览里应该还能找到这条案例（供审计追溯）");
    assert.strictEqual(record.status, "WITHDRAWN");
    assert.strictEqual(record.caseName, "Samsung India Electronics Pvt Ltd vs Acit");
  });

  const restored = await publishCase(staged.record.id);
  await t("恢复（重新发布）后状态回到PUBLISHED", () => {
    assert.strictEqual(restored.status, "PUBLISHED");
  });
  await t("恢复后保留了第一次发布的时间，不当成新案例", () => {
    assert.strictEqual(restored.publishedAt, published.publishedAt);
  });
  await t("恢复后withdrawnAt被清空", () => {
    assert.strictEqual(restored.withdrawnAt, undefined);
  });

  await t("操作不存在的id返回null，不抛异常", async () => {
    assert.strictEqual(await publishCase("case_not_exist"), null);
    assert.strictEqual(await withdrawCase("case_not_exist"), null);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`\n税务案例库：通过 ${pass} 项`);
  if (failed) process.exitCode = 1;
})();
