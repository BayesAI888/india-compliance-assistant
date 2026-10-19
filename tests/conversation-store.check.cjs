/**
 * 多轮对话会话存储自测：创建/复用会话、追加轮次、20轮截断、免费追问计数、过期清理。
 *
 * 单独成文件，理由和 knowledge-store.check.cjs 一样：这里全是异步文件IO，
 * v14-rules.check.cjs 的 t() 断言助手是同步的。
 *
 * 运行前：先跑一遍 v14-rules.check.cjs 文件头注释里的 tsc 编译命令
 * （已经把 lib/server/conversation-store.ts 加进那条命令的文件列表），产出 .v14build/。
 * 运行：node tests/conversation-store.check.cjs
 *
 * 用临时目录当 LOCAL_CONVERSATION_DIR，跑完自动清理，不会碰到真实会话数据。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-store-test-"));
process.env.LOCAL_CONVERSATION_DIR = tempDir;

const {
  createConversation,
  getConversation,
  getOrCreateConversation,
  getLastTurn,
  appendTurn,
  pruneExpiredConversations,
  MAX_TURNS_PER_CONVERSATION,
} = require("./lib/server/conversation-store.js");

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

function baseTurn(overrides = {}) {
  return {
    rawQuestion: "问题",
    selfContainedQuestion: "问题",
    shortConclusion: "结论",
    mandatoryFirstSentences: [],
    citedLaws: [],
    relatedCases: [],
    attachmentIds: [],
    answer: undefined,
    answerStatus: "SUFFICIENT",
    chargeEligible: true,
    topicRelation: "FIRST",
    usedFollowUpCredit: false,
    ...overrides,
  };
}

(async () => {
  console.log("== 多轮对话会话存储 ==");

  const ownerId = "user_owner";
  const conversation = await createConversation(undefined, ownerId);
  await t("新建会话：初始没有轮次、免费额度未用", () => {
    assert.strictEqual(conversation.turns.length, 0);
    assert.strictEqual(conversation.freeFollowUpsUsed, 0);
  });

  await t("getOrCreateConversation带已存在的ID：只有本人可复用", async () => {
    const reused = await getOrCreateConversation(conversation.id, ownerId);
    assert.strictEqual(reused.id, conversation.id);
  });

  await t("getOrCreateConversation带他人ID：拒绝复用", async () => {
    const reused = await getOrCreateConversation(conversation.id, "user_other");
    assert.strictEqual(reused, null);
  });

  await t("getOrCreateConversation带不存在的ID：新建一个，不是复用", async () => {
    const created = await getOrCreateConversation("conv_does_not_exist", ownerId);
    assert.notStrictEqual(created.id, "conv_does_not_exist");
  });

  await t("getOrCreateConversation不带ID：新建", async () => {
    const created = await getOrCreateConversation(undefined, ownerId);
    assert.ok(created.id.startsWith("conv_"));
  });

  await appendTurn(conversation.id, baseTurn({ rawQuestion: "首问", selfContainedQuestion: "首问" }));
  await t("appendTurn后能读到刚追加的轮次", async () => {
    const loaded = await getConversation(conversation.id);
    assert.strictEqual(loaded.turns.length, 1);
    assert.strictEqual(getLastTurn(loaded).rawQuestion, "首问");
  });

  await appendTurn(conversation.id, baseTurn({
    rawQuestion: "追问1", selfContainedQuestion: "自包含追问1",
    topicRelation: "CONTINUATION", usedFollowUpCredit: true,
  }));
  await t("消耗一次免费追问额度后，计数器+1", async () => {
    const loaded = await getConversation(conversation.id);
    assert.strictEqual(loaded.freeFollowUpsUsed, 1);
  });

  await appendTurn(conversation.id, baseTurn({
    rawQuestion: "新话题", selfContainedQuestion: "新话题",
    topicRelation: "NEW_TOPIC", usedFollowUpCredit: false,
  }));
  await t("新话题不消耗免费额度，计数器不变", async () => {
    const loaded = await getConversation(conversation.id);
    assert.strictEqual(loaded.freeFollowUpsUsed, 1);
  });

  for (let i = 0; i < MAX_TURNS_PER_CONVERSATION + 5; i += 1) {
    await appendTurn(conversation.id, baseTurn({
      rawQuestion: `第${i}轮`, selfContainedQuestion: `第${i}轮`,
    }));
  }
  await t(`超过${MAX_TURNS_PER_CONVERSATION}轮时只保留最近的，更早的被截断`, async () => {
    const loaded = await getConversation(conversation.id);
    assert.strictEqual(loaded.turns.length, MAX_TURNS_PER_CONVERSATION);
    // 最后一条应该是循环里最后追加的第 MAX_TURNS_PER_CONVERSATION+4 轮。
    assert.strictEqual(getLastTurn(loaded).rawQuestion, `第${MAX_TURNS_PER_CONVERSATION + 4}轮`);
  });

  await t("Notice附件ID随轮次存下来，供下一轮追问继承（真实事故：追问时Notice信息丢了）", async () => {
    const noticeConversation = await createConversation();
    await appendTurn(noticeConversation.id, baseTurn({
      rawQuestion: "收到这个notice应该怎么办？",
      selfContainedQuestion: "收到这个notice应该怎么办？",
      attachmentIds: ["att_1", "att_2"],
    }));
    const loaded = await getConversation(noticeConversation.id);
    assert.deepStrictEqual(getLastTurn(loaded).attachmentIds, ["att_1", "att_2"]);
  });

  await t("appendTurn对不存在的会话ID返回null，不报错", async () => {
    const result = await appendTurn("conv_does_not_exist", baseTurn());
    assert.strictEqual(result, null);
  });

  await t("过期清理：超过保留天数的会话被过滤掉，未过期的保留", () => {
    const now = new Date("2026-09-10T00:00:00.000Z");
    const fresh = { id: "a", updatedAt: "2026-09-05T00:00:00.000Z", turns: [], createdAt: "", freeFollowUpsUsed: 0 };
    const stale = { id: "b", updatedAt: "2026-07-01T00:00:00.000Z", turns: [], createdAt: "", freeFollowUpsUsed: 0 };
    const kept = pruneExpiredConversations([fresh, stale], now, 30);
    assert.deepStrictEqual(kept.map((c) => c.id), ["a"]);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });

// ============================================================
// 对话归属：列表跟着账号走，别人读不到
// ============================================================
const { canReadConversation, listConversationsForUser } =
  require("./lib/server/conversation-store.js");
const newConv = createConversation;

await t("有主的对话只有本人能读", async () => {
  const owned = { userId: "user_a" };
  assert.strictEqual(canReadConversation(owned, "user_a"), true);
  assert.strictEqual(canReadConversation(owned, "user_b"), false, "别人不能读");
  assert.strictEqual(canReadConversation(owned, undefined), false, "游客也不能读");
});

await t("无主的对话沿用原口径——ID 本身就是通行证", async () => {
  // 游客没有账号可以绑，不这样他自己都读不回来；ID 是 UUID，猜不到。
  const anonymous = {};
  assert.strictEqual(canReadConversation(anonymous, undefined), true);
  assert.strictEqual(canReadConversation(anonymous, "user_a"), true);
});

await t("真实事故：列表按账号查，换浏览器也能拿回来", async () => {
  // 2026-09-18：同一账号换浏览器登录，历史会话记录全没了——
  // 因为列表只活在 localStorage 里。现在它跟着账号走。
  const mine = await newConv(undefined, "user_a");
  const theirs = await newConv(undefined, "user_b");
  await appendTurn(mine.id, baseTurn({ rawQuestion: "我问的问题" }), "我的话题");
  await appendTurn(theirs.id, baseTurn({ rawQuestion: "别人问的问题" }), "别人的话题");

  const list = await listConversationsForUser("user_a");
  assert.strictEqual(list.length, 1, "只该看到自己的");
  assert.strictEqual(list[0].id, mine.id);
  assert.strictEqual(list[0].title, "我的话题");
  assert.strictEqual(list[0].turnCount, 1);
});

await t("没有轮次的空对话不进列表", async () => {
  await newConv(undefined, "user_c");
  assert.deepStrictEqual(await listConversationsForUser("user_c"), [],
    "点了新建但一个问题都没问，不该在列表里留一条空的");
});

await t("标题只在首问写入，追问不覆盖", async () => {
  const conv = await newConv(undefined, "user_d");
  await appendTurn(conv.id, baseTurn({ rawQuestion: "第一问" }), "原标题");
  await appendTurn(conv.id, baseTurn({ rawQuestion: "追问" }), "追问生成的标题");
  const list = await listConversationsForUser("user_d");
  assert.strictEqual(list[0].title, "原标题", "标题是话题的名字，不是最后一问的名字");
  assert.strictEqual(list[0].turnCount, 2);
});

console.log(`\n多轮对话会话存储：通过 ${pass} 项`);
  if (failed) process.exitCode = 1;
})();
