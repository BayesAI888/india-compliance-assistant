import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";

const localStoreRoot = mkdtempSync(join(tmpdir(), "india-compliance-test-"));
const localStoreDirectory = join(localStoreRoot, "private-store");
process.env.LOCAL_KNOWLEDGE_DIR = localStoreDirectory;
process.env.ADMIN_USERNAME = "test-admin";
process.env.ADMIN_PASSWORD = "test-password";
// 注册验证码测试走显式测试通道：不触网、不发真实邮件；生产环境绝不会接受该固定验证码。
process.env.AUTH_VERIFICATION_TEST_MODE = "1";
process.env.AUTH_VERIFICATION_TEST_CODE = "246810";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

async function render(path = "/", options = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html", ...(options.headers ?? {}) },
      ...options,
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function registerAndGetCookie(email) {
  const codeResponse = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "send_registration_code", email }),
  });
  assert.equal(codeResponse.status, 200);
  const response = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      action: "register",
      email,
      password: "TestPass123",
      passwordConfirmation: "TestPass123",
      verificationCode: "246810",
    }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "registration must issue a session cookie");
  return cookie;
}

test("registration requires a delivered email code and matching password confirmation", async () => {
  const email = `verified-registration-${Date.now()}@example.com`;
  const beforeCode = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      action: "register", email, password: "TestPass123", passwordConfirmation: "TestPass123", verificationCode: "246810",
    }),
  });
  assert.equal(beforeCode.status, 400);
  assert.match((await beforeCode.json()).message, /过期或不存在/);

  const sent = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "send_registration_code", email }),
  });
  assert.equal(sent.status, 200);

  const repeatedSend = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "send_registration_code", email }),
  });
  assert.equal(repeatedSend.status, 429);

  const wrongCode = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      action: "register", email, password: "TestPass123", passwordConfirmation: "TestPass123", verificationCode: "111111",
    }),
  });
  assert.equal(wrongCode.status, 400);
  assert.match((await wrongCode.json()).message, /验证码不正确/);

  const mismatch = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      action: "register", email, password: "TestPass123", passwordConfirmation: "Different123", verificationCode: "246810",
    }),
  });
  assert.equal(mismatch.status, 400);
  assert.match((await mismatch.json()).message, /密码不一致/);

  const registered = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      action: "register", email, password: "TestPass123", passwordConfirmation: "TestPass123", verificationCode: "246810",
    }),
  });
  assert.equal(registered.status, 200);
  assert.ok(registered.headers.get("set-cookie"));

  const replay = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      action: "register", email: `replay-${email}`, password: "TestPass123", passwordConfirmation: "TestPass123", verificationCode: "246810",
    }),
  });
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).message, /过期或不存在/);
});

test("password reset requires its own delivered code, revokes old sessions, and signs in with the new password", async () => {
  const email = `password-reset-${Date.now()}@example.com`;
  const oldCookie = await registerAndGetCookie(email);

  const sent = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "send_password_reset_code", email }),
  });
  assert.equal(sent.status, 200);

  const reset = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      action: "reset_password",
      email,
      password: "NewPass123",
      passwordConfirmation: "NewPass123",
      verificationCode: "246810",
    }),
  });
  assert.equal(reset.status, 200);
  const resetCookie = reset.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(resetCookie, "password reset must issue a fresh session cookie");

  const oldSession = await render("/api/auth", { headers: { accept: "application/json", cookie: oldCookie } });
  assert.equal((await oldSession.json()).user, null, "all pre-reset sessions must be revoked");

  const oldPasswordLogin = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "login", email, password: "TestPass123" }),
  });
  assert.equal(oldPasswordLogin.status, 401);

  const freshSession = await render("/api/auth", { headers: { accept: "application/json", cookie: resetCookie } });
  assert.equal((await freshSession.json()).user?.email, email);
});

test("password reset does not disclose whether an email is registered", async () => {
  const email = `unknown-reset-${Date.now()}@example.com`;
  const sent = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "send_password_reset_code", email }),
  });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).ok, true);

  const reset = await render("/api/auth", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      action: "reset_password",
      email,
      password: "NewPass123",
      passwordConfirmation: "NewPass123",
      verificationCode: "246810",
    }),
  });
  assert.equal(reset.status, 400);
  assert.match((await reset.json()).message, /过期或不可用/);
});

test("server-renders the India compliance workspace", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /印度合规助手/);
  assert.match(html, /今天有什么可以帮到你/);
  assert.match(html, /只使用管理员审核并发布的官方资料/);
  assert.match(html, /公司设立/);
  assert.match(html, /税务 Notice/);
  assert.doesNotMatch(html, developmentPreviewMeta);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|react-loading-skeleton/);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("server-renders the administrator upload workspace", async () => {
  const response = await render("/admin", {
    headers: { authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}` },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /超级管理员后台/);
  assert.match(html, /上传官方资料TXT/);
  assert.match(html, /任何错误都会退回整份文件/);
  assert.match(html, /-----/);
});

test("administrator can inspect source governance configuration", async () => {
  const response = await render("/api/admin/sources", {
    headers: { accept: "application/json", authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}` },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.authorities.some((item) => item.id === "MCA"));
  assert.ok(payload.reviewOrder.length >= 1);

  const unauthenticated = await render("/api/admin/sources", { headers: { accept: "application/json" } });
  assert.equal(unauthenticated.status, 401);
});

test("health route reports integrations as safely unconfigured", async () => {
  const response = await render("/api/health", {
    headers: { accept: "application/json" },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "ok");
  assert.equal(payload.knowledgeBase, "awaiting_admin_upload");
  assert.equal(payload.deepSeek, "not_configured");
});

test("notice questions without published sources refuse to invent a conclusion", async () => {
  const response = await render("/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ question: "收到印度税局Notice应该怎么办？" }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.answer_status, "UNABLE_TO_CONFIRM");
  assert.equal(payload.failure_code, "INSUFFICIENT_EVIDENCE");
  assert.equal(payload.missing_information.length, 0);
  assert.equal(payload.charge_eligible, false);
});

test("income-tax questions require a transaction date, FY, or AY before answering", async () => {
  const missingTime = await render("/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ question: "印度公司的所得税税率是多少？" }),
  });
  assert.equal(missingTime.status, 200);
  const missingPayload = await missingTime.json();
  assert.equal(missingPayload.answer_status, "NEED_INFORMATION");
  assert.equal(missingPayload.failure_code, "NEED_INFO");
  assert.equal(missingPayload.clarification_kind, "INCOME_TAX_TIME");
  assert.equal(missingPayload.charge_eligible, false);

  for (const question of [
    "印度公司在2024年3月15日向中国母公司支付特许权使用费，应如何代扣所得税？",
    "印度公司 FY 2024-25 的所得税申报要求是什么？",
    "印度公司 AY 2024-25 的所得税申报要求是什么？",
    "印度公司 fy21-22 的所得税申报要求是什么？",
    "印度公司 AY 21/22 的所得税申报要求是什么？",
    "印度公司财年21-22的所得税申报要求是什么？",
    "律师费用对应的 TDS 税率是多少？交易发生在 2026年5月。",
    "律师费用对应的 TDS 税率是多少？\n\n补充的所得税适用期间：具体交易、付款或收入发生日期为 2026-10-14",
    "律师费用对应的 TDS 税率是多少？\n\n补充的所得税适用期间：具体交易、付款或收入发生日期为 2026/10/14",
    "律师费用对应的 TDS 税率是多少？\n\n补充的所得税适用期间：具体交易、付款或收入发生日期为 14/10/2026",
    "帮我找一下2026年以前关于跨国公司广告费案例",
  ]) {
    const dated = await render("/api/chat", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const payload = await dated.json();
    assert.notEqual(payload.answer_status, "NEED_INFORMATION", question);
  }
});

test("income-tax time clarification is retained in signed-in conversation history", async () => {
  const cookie = await registerAndGetCookie("income-time-history@example.com");
  const clarification = await render("/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie },
    body: JSON.stringify({ question: "律师费用对应的 TDS 税率是多少？" }),
  });
  assert.equal(clarification.status, 200);
  const answer = await clarification.json();
  assert.equal(answer.clarification_kind, "INCOME_TAX_TIME");

  const history = await render(`/api/chat?conversation_id=${encodeURIComponent(answer.conversation_id)}`, {
    headers: { accept: "application/json", cookie },
  });
  assert.equal(history.status, 200);
  const saved = await history.json();
  assert.equal(saved.turns.length, 1);
  assert.equal(saved.turns[0].question, "律师费用对应的 TDS 税率是多少？");
  assert.equal(saved.turns[0].answer.clarification_kind, "INCOME_TAX_TIME");
});

test("question operations are visible to administrators and feedback is bound to the answer owner", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerCookie = await registerAndGetCookie(`feedback-owner-${suffix}@example.com`);
  const otherCookie = await registerAndGetCookie(`feedback-other-${suffix}@example.com`);
  const answerResponse = await render("/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ question: "律师费用对应的 TDS 税率是多少？" }),
  });
  const answer = await answerResponse.json();
  assert.equal(answer.answer_status, "NEED_INFORMATION");

  const audit = await render("/api/admin/questions?limit=200", {
    headers: { accept: "application/json", authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}` },
  });
  assert.equal(audit.status, 200);
  const auditPayload = await audit.json();
  const logged = auditPayload.questions.find((item) => item.requestId === answer.request_id);
  assert.equal(logged?.status, "NEED_INFORMATION");
  assert.equal(logged?.incomeTaxTime?.targetDate, undefined);
  assert.equal(Object.hasOwn(logged ?? {}, "answer"), false);
  assert.equal(Object.hasOwn(logged ?? {}, "attachments"), false);

  const fullAnswer = await render(`/api/admin/questions/${encodeURIComponent(answer.request_id)}/answer`, {
    headers: { accept: "application/json", authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}` },
  });
  assert.equal(fullAnswer.status, 200);
  const fullAnswerPayload = await fullAnswer.json();
  assert.equal(fullAnswerPayload.answer.request_id, answer.request_id);
  assert.equal(fullAnswerPayload.viewEvents[0].adminUsername, "test-admin");
  assert.equal(fullAnswerPayload.viewEvents[0].outcome, "VIEWED");

  const unauthenticatedAudit = await render("/api/admin/questions", {
    headers: { accept: "application/json" },
  });
  assert.equal(unauthenticatedAudit.status, 401);

  const unauthenticatedFullAnswer = await render(`/api/admin/questions/${encodeURIComponent(answer.request_id)}/answer`, {
    headers: { accept: "application/json" },
  });
  assert.equal(unauthenticatedFullAnswer.status, 401);

  const anonymousFeedback = await render("/api/feedback", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ request_id: answer.request_id, reason: "这是一段足够长的匿名反馈理由" }),
  });
  assert.equal(anonymousFeedback.status, 401);

  const otherFeedback = await render("/api/feedback", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie: otherCookie },
    body: JSON.stringify({ request_id: answer.request_id, reason: "这是一段足够长的越权反馈理由" }),
  });
  assert.equal(otherFeedback.status, 404);

  const ownerFeedback = await render("/api/feedback", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ request_id: answer.request_id, reason: "这是一段足够长的本人反馈理由" }),
  });
  assert.equal(ownerFeedback.status, 200);
  const feedbackPayload = await ownerFeedback.json();
  assert.equal(feedbackPayload.decision, "NOT_CHARGED");
});

test("sensitive local data is created with private permissions", () => {
  assert.equal(statSync(localStoreDirectory).mode & 0o777, 0o700);
  for (const name of ["user-store.json", "registration-verification-store.json", "conversation-store.json", "question-audit-store.json", "question-answer-view-log.json"]) {
    assert.equal(statSync(join(localStoreDirectory, name)).mode & 0o777, 0o600, name);
  }
});

test("anonymous conversations cannot be reopened with a conversation id", async () => {
  const answerResponse = await render("/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ question: "印度公司必须有印度股东吗？" }),
  });
  assert.equal(answerResponse.status, 200);
  const answer = await answerResponse.json();

  const historyResponse = await render(`/api/chat?conversation_id=${encodeURIComponent(answer.conversation_id)}`, {
    headers: { accept: "application/json" },
  });
  assert.equal(historyResponse.status, 404);
});

test("file upload requires a logged-in account", async () => {
  const response = await render("/api/attachments", { method: "POST", headers: { accept: "application/json" } });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error, "LOGIN_REQUIRED");
});

test("an administrator can sync a validated terms workbook", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("词典主表");
  sheet.addRows([
    ["term_id", "zh_term", "en_canonical", "domain", "workflow_status"],
    ["TERM-1", "商品及服务税", "Goods and Services Tax", "GST", "PUBLISHED"],
  ]);
  const bytes = await workbook.xlsx.writeBuffer();
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    "terms.xlsx",
  );

  const response = await render("/api/admin/terms", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}`,
    },
    body: form,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.synced, true);
  assert.equal(payload.termCount, 1);
});

test("a signed-in user cannot read or reuse another user's conversation", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerCookie = await registerAndGetCookie(`owner-${suffix}@example.com`);
  const otherCookie = await registerAndGetCookie(`other-${suffix}@example.com`);

  const ownerAnswer = await render("/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ question: "印度公司必须有印度股东吗？" }),
  });
  assert.equal(ownerAnswer.status, 200);
  const ownerPayload = await ownerAnswer.json();

  const ownHistory = await render(`/api/chat?conversation_id=${encodeURIComponent(ownerPayload.conversation_id)}`, {
    headers: { accept: "application/json", cookie: ownerCookie },
  });
  assert.equal(ownHistory.status, 200);

  const otherHistory = await render(`/api/chat?conversation_id=${encodeURIComponent(ownerPayload.conversation_id)}`, {
    headers: { accept: "application/json", cookie: otherCookie },
  });
  assert.equal(otherHistory.status, 404);

  const otherReuse = await render("/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie: otherCookie },
    body: JSON.stringify({ question: "继续解释", conversation_id: ownerPayload.conversation_id }),
  });
  assert.equal(otherReuse.status, 404);
});

test("chat rejects an overlong question before processing it", async () => {
  const response = await render("/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ question: "a".repeat(2_001) }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, "QUESTION_TOO_LONG");
});

test("the app refuses to invent legal conclusions before knowledge is published", async () => {
  const response = await render("/api/chat", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}`,
    },
    body: JSON.stringify({ question: "印度公司必须有印度股东吗？" }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.answer_status, "UNABLE_TO_CONFIRM");
  assert.equal(payload.failure_code, "INSUFFICIENT_EVIDENCE");
  assert.equal(payload.citations.length, 0);
  assert.equal(payload.charge_eligible, false);
});

test("an administrator can stage and publish validated knowledge", async () => {
  const text = `【来源】CGST Act\n【大标题】CHAPTER VII\n【小标题】Section 31 - Tax invoice\n【原文链接】https://www.indiacode.nic.in/example\n\nA registered person supplying taxable goods shall issue a tax invoice.\n-----`;
  const stageResponse = await render("/api/admin/knowledge", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}`,
    },
    body: JSON.stringify({ action: "stage", fileName: "CGST-test.txt", text }),
  });
  assert.equal(stageResponse.status, 201);
  const staged = await stageResponse.json();
  assert.equal(staged.status, "TO_REVIEW");
  assert.equal(staged.chunkCount, 1);

  const publishResponse = await render("/api/admin/knowledge", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}`,
    },
    body: JSON.stringify({ action: "publish", documentId: staged.documentId }),
  });
  assert.equal(publishResponse.status, 200);
  const published = await publishResponse.json();
  assert.equal(published.status, "PUBLISHED");

  const healthResponse = await render("/api/health", {
    headers: { accept: "application/json" },
  });
  const health = await healthResponse.json();
  assert.equal(health.knowledgeBase, "published");
  assert.equal(health.publishedChunks, 1);
});

test("reviewed homepage answers are admin-editable and bypass only the model call", async () => {
  const adminHeaders = {
    accept: "application/json",
    authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}`,
  };
  const listResponse = await render("/api/admin/featured-answers", { headers: adminHeaders });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  const company = listed.records.find((item) => item.id === "company-incorporation");
  assert.ok(company?.answer);
  assert.equal(company.fresh, true);
  assert.equal(company.answer.evidence_sufficiency, "FULL");
  const advertisingCases = listed.records.find((item) => item.id === "cross-border-advertising-cases");
  assert.equal(advertisingCases?.enabled, true);
  assert.equal(advertisingCases?.question, "帮我找一下2026年以前关于跨国公司广告费案例");
  assert.equal(advertisingCases?.answer?.evidence_sufficiency, "FULL");
  assert.equal(advertisingCases?.answer?.related_cases?.length, 3);

  const editedConclusion = "标准缓存测试：境外股东不当然需要印度股东，但居民董事和外资准入仍须核对。";
  const updateResponse = await render("/api/admin/featured-answers", {
    method: "PUT",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      id: company.id,
      enabled: true,
      reviewed: true,
      text: {
        shortConclusion: editedConclusion,
        assumptions: company.answer.assumptions,
        mandatoryTexts: company.answer.action_steps.filter((step) => step.kind === "MANDATORY").map((step) => step.text),
        practicalTexts: company.answer.action_steps.filter((step) => step.kind === "PRACTICAL").map((step) => step.text),
        risks: company.answer.risks_and_exceptions,
      },
    }),
  });
  assert.equal(updateResponse.status, 200);

  const cookie = await registerAndGetCookie(`featured-answer-${Date.now()}@example.com`);
  const answerResponse = await render("/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie },
    body: JSON.stringify({ question: "在印度设立企业必须有印度人参股吗？" }),
  });
  assert.equal(answerResponse.status, 200);
  assert.equal(answerResponse.headers.get("x-answer-cache"), "FEATURED");
  const answer = await answerResponse.json();
  assert.equal(answer.short_conclusion, editedConclusion);
  assert.equal(answer.evidence_sufficiency, "FULL");
  assert.equal(answer.evidence_gap, undefined);
  assert.equal(answer.citations.length, 3);

  const caseCookie = await registerAndGetCookie(`featured-case-${Date.now()}@example.com`);
  const caseResponse = await render("/api/chat", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie: caseCookie },
    body: JSON.stringify({ question: "帮我找一下2026年以前关于跨国公司广告费案例" }),
  });
  assert.equal(caseResponse.status, 200);
  assert.equal(caseResponse.headers.get("x-answer-cache"), "FEATURED");
  const caseAnswer = await caseResponse.json();
  assert.equal(caseAnswer.answer_status, "SUFFICIENT");
  assert.equal(caseAnswer.evidence_sufficiency, "FULL");
  assert.equal(caseAnswer.evidence_gap, undefined);
  assert.equal(caseAnswer.case_led, true);
  assert.equal(caseAnswer.related_cases.length, 3);
  assert.equal(caseAnswer.citations.length, 3);
});
