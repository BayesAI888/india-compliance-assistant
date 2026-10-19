/**
 * 知识库资料 下架/恢复（软删除）状态机自测。
 *
 * 单独成文件，而不是塞进 v14-rules.check.cjs：knowledge-store.ts 全是异步文件IO，
 * v14-rules.check.cjs 的 t() 断言助手是同步的，硬塞进去会破坏那边现成的183项。
 *
 * 运行前：
 *   1. 先跑一遍 v14-rules.check.cjs 里注释描述的 tsc 编译命令（现在已把
 *      lib/server/knowledge-store.ts 加进那条命令的文件列表），产出 .v14build/。
 *   2. node tests/knowledge-store.check.cjs
 *
 * 用一个临时目录当 LOCAL_KNOWLEDGE_DIR，跑完自动清理，不会碰到真实知识库文件。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-withdraw-test-"));
process.env.LOCAL_KNOWLEDGE_DIR = tempDir;

const {
  stageKnowledgeDocument,
  publishKnowledgeDocument,
  withdrawKnowledgeDocument,
  getPublishedKnowledgeChunks,
  getKnowledgeOverview,
} = require("./lib/server/knowledge-store.js");

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

const SAMPLE_TXT = `【来源】Companies Act, 2013
【大标题】CHAPTER VII
【小标题】Section 92 - Annual return
【原文链接】https://example.gov.in/companies-act.pdf

Every company shall file its annual return in the prescribed form.
-----
`;

(async () => {
  console.log("== 知识库资料下架/恢复（软删除）==");

  const staged = await stageKnowledgeDocument("company-act-s92.txt", SAMPLE_TXT);
  const documentId = staged.document.id;

  await t("刚上传时不在检索范围（还没发布）", async () => {
    const chunks = await getPublishedKnowledgeChunks();
    assert.ok(!chunks.some((c) => c.documentId === documentId));
  });

  const published = await publishKnowledgeDocument(documentId);
  await t("发布后进入检索范围", async () => {
    const chunks = await getPublishedKnowledgeChunks();
    assert.ok(chunks.some((c) => c.documentId === documentId));
  });
  await t("发布后状态是PUBLISHED", () => {
    assert.strictEqual(published.status, "PUBLISHED");
  });

  const withdrawn = await withdrawKnowledgeDocument(documentId);
  await t("下架后状态是WITHDRAWN", () => {
    assert.strictEqual(withdrawn.status, "WITHDRAWN");
  });
  await t("下架后立刻退出检索范围", async () => {
    const chunks = await getPublishedKnowledgeChunks();
    assert.ok(!chunks.some((c) => c.documentId === documentId));
  });
  await t("下架是软删除：正文和Chunk还在，能在总览里查到", async () => {
    const overview = await getKnowledgeOverview();
    const doc = overview.find((d) => d.id === documentId);
    assert.ok(doc, "总览里应该还能找到这份资料（供审计追溯）");
    assert.strictEqual(doc.status, "WITHDRAWN");
    assert.strictEqual(doc.chunkCount, 1, "Chunk没有被真的删掉");
  });
  await t("下架记录了时间", () => {
    assert.ok(typeof withdrawn.withdrawnAt === "string" && withdrawn.withdrawnAt.length > 0);
  });

  const restored = await publishKnowledgeDocument(documentId);
  await t("恢复（重新发布）后状态回到PUBLISHED", () => {
    assert.strictEqual(restored.status, "PUBLISHED");
  });
  await t("恢复后重新进入检索范围", async () => {
    const chunks = await getPublishedKnowledgeChunks();
    assert.ok(chunks.some((c) => c.documentId === documentId));
  });
  await t("恢复后withdrawnAt被清空", () => {
    assert.strictEqual(restored.withdrawnAt, undefined);
  });
  await t("恢复保留了第一次发布的时间，不当成新资料", () => {
    assert.strictEqual(restored.publishedAt, published.publishedAt);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`\n知识库下架/恢复：通过 ${pass} 项`);
  if (failed) process.exitCode = 1;
})();
