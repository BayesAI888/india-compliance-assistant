/**
 * 附件私有存储自测：保存、按会话ID隔离读取、过期清理。
 *
 * 单独成文件，理由和 conversation-store.check.cjs 一样：这里全是异步文件IO，
 * v14-rules.check.cjs 的 t() 断言助手是同步的。
 *
 * 运行前：先跑一遍 v14-rules.check.cjs 文件头注释里的 tsc 编译命令
 * （已经把 lib/server/attachment-store.ts 加进那条命令的文件列表），产出 .v14build/。
 * 运行：node tests/attachment-store.check.cjs
 *
 * 用临时目录当 LOCAL_ATTACHMENT_DIR，跑完自动清理，不会碰到真实上传数据。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-store-test-"));
process.env.LOCAL_ATTACHMENT_DIR = tempDir;

const {
  saveAttachment,
  getAttachmentsForConversation,
  pruneExpiredAttachments,
} = require("./lib/server/attachment-store.js");

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

function baseAttachment(overrides = {}) {
  return {
    conversationId: "conv_a",
    fileName: "notice.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    status: "EXTRACTED",
    extractedText: "原文内容",
    noticeFacts: { authority: "GST局", allegations: [] },
    ...overrides,
  };
}

(async () => {
  console.log("== 附件私有存储 ==");

  const saved = await saveAttachment(baseAttachment());
  await t("saveAttachment返回带id和createdAt的完整记录", () => {
    assert.ok(saved.id.startsWith("att_"));
    assert.ok(saved.createdAt);
    assert.strictEqual(saved.fileName, "notice.pdf");
  });

  await t("同一会话内能按id读到刚保存的附件", async () => {
    const found = await getAttachmentsForConversation("conv_a", [saved.id]);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].id, saved.id);
    assert.strictEqual(found[0].noticeFacts.authority, "GST局");
  });

  await t("不属于这个会话的attachment_id读不到——隔离边界", async () => {
    const found = await getAttachmentsForConversation("conv_b", [saved.id]);
    assert.strictEqual(found.length, 0);
  });

  await t("attachmentIds为空数组时直接返回空，不查文件", async () => {
    const found = await getAttachmentsForConversation("conv_a", []);
    assert.deepStrictEqual(found, []);
  });

  const unsupported = await saveAttachment(baseAttachment({
    fileName: "notice.jpg",
    mimeType: "image/jpeg",
    status: "UNSUPPORTED",
    extractedText: undefined,
    noticeFacts: undefined,
    errorMessage: "图片格式暂不支持自动识别",
  }));
  await t("UNSUPPORTED状态的附件也能存取，errorMessage原样保留", async () => {
    const found = await getAttachmentsForConversation("conv_a", [unsupported.id]);
    assert.strictEqual(found[0].status, "UNSUPPORTED");
    assert.strictEqual(found[0].errorMessage, "图片格式暂不支持自动识别");
    assert.strictEqual(found[0].noticeFacts, undefined);
  });

  await t("一次能读多个attachment_id，各自归属正确的会话", async () => {
    const found = await getAttachmentsForConversation("conv_a", [saved.id, unsupported.id, "att_does_not_exist"]);
    assert.strictEqual(found.length, 2);
  });

  await t("过期清理：超过保留天数的附件被过滤掉，未过期的保留", () => {
    const now = new Date("2026-09-15T00:00:00.000Z");
    const fresh = { id: "a", createdAt: "2026-09-10T00:00:00.000Z" };
    const stale = { id: "b", createdAt: "2026-07-01T00:00:00.000Z" };
    const kept = pruneExpiredAttachments([fresh, stale], now, 30);
    assert.deepStrictEqual(kept.map((item) => item.id), ["a"]);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`\n附件私有存储：通过 ${pass} 项`);
  if (failed) process.exitCode = 1;
})();
