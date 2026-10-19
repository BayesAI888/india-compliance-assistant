import { NextResponse } from "next/server";
import {
  evaluateRestore,
  MONTHLY_RESTORE_LIMIT,
} from "../../../lib/server/quota-restore";
import { commitRestore, readRestoreContext } from "../../../lib/server/compliance-store";
import { findAnswerRequestForUser } from "../../../lib/server/conversation-store";
import { identifyRequest } from "../../../lib/server/request-identity";

/**
 * POST /api/feedback
 * 用户对已扣次回答提交“答案有问题”反馈。
 *
 * 《产品规则表 V1.4》§2.2：
 *  - 原因去除空格后须超过 10 个中文字符；
 *  - 同一回答最多补回 1 次；
 *  - 同一账号每自然月最多补回 3 次，达到上限后仍受理反馈但不再补回；
 *  - 连续两个自然月触顶则冻结补回能力并转人工复核；
 *  - 补回不改余额，只生成与原扣次流水互相引用的补回流水。
 */

interface FeedbackBody {
  request_id?: string;
  reason?: string;
}

export async function POST(request: Request) {
  const identity = await identifyRequest(request);
  if (!identity.user) {
    return NextResponse.json(
      { error: "LOGIN_REQUIRED", message: "请登录后再提交回答反馈。" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: FeedbackBody;
  try {
    body = (await request.json()) as FeedbackBody;
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式无效。" }, { status: 400 });
  }

  const requestId = body.request_id?.trim();
  const reason = body.reason?.trim() ?? "";
  if (!requestId) {
    return NextResponse.json(
      { error: "REQUEST_ID_REQUIRED", message: "缺少要反馈的回答标识。" },
      { status: 400 },
    );
  }

  // 身份、回答归属与是否实际扣次均由服务端历史记录决定。客户端只能说明
  // “哪一条回答”和“为什么有问题”，无权替自己或他人指定用户、额度或流水。
  const original = await findAnswerRequestForUser(identity.user.id, requestId);
  if (!original) {
    return NextResponse.json(
      { error: "ANSWER_NOT_FOUND", message: "没有找到可反馈的回答，或该回答已过期。" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const now = new Date();
  const context = await readRestoreContext(identity.user.id, requestId, now);
  const result = evaluateRestore(reason, {
    originalCharged: original.turn.chargeEligible,
    alreadyRestored: context.alreadyRestored,
    frozen: context.frozen,
    currentMonth: context.currentMonth,
    previousMonth: context.previousMonth,
  }, now);

  const committed = await commitRestore({
    userId: identity.user.id,
    requestId,
    reason,
    decision: result.decision,
    restored: result.restored,
    nextCounter: result.nextCounter,
    shouldFreeze: result.shouldFreeze,
    auditNote: result.auditNote,
  });

  return NextResponse.json({
    decision: result.decision,
    restored: result.restored,
    // 反馈永远受理并记录，即使不补回。
    feedback_recorded: true,
    message: result.userMessage,
    monthly_limit: MONTHLY_RESTORE_LIMIT,
    monthly_used: result.nextCounter.restoredCount,
    restore_frozen: committed.frozen,
  }, { headers: { "Cache-Control": "no-store" } });
}
