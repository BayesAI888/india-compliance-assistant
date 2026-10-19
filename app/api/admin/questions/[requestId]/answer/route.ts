import { NextResponse } from "next/server";
import {
  getQuestionAuditByRequestId,
  listQuestionAnswerViews,
  recordQuestionAnswerView,
} from "../../../../../../lib/server/question-audit-store";
import { getConversation } from "../../../../../../lib/server/conversation-store";

const REQUEST_ID_PATTERN = /^req_\d+_[a-f0-9-]{8,}$/i;

/**
 * 管理员按需查看单条完整回答。
 *
 * `/api/admin/*` 已由 proxy 的 Basic Auth 保护。本接口仍不把回答混进运营列表，
 * 只有管理员主动点开时才读取会话存档，并在成功/不可用两种结果下都留访问日志。
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await context.params;
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return NextResponse.json({ error: "INVALID_REQUEST_ID", message: "回答标识格式无效。" }, { status: 400 });
  }

  const audit = await getQuestionAuditByRequestId(requestId);
  if (!audit) {
    return NextResponse.json({ error: "ANSWER_NOT_FOUND", message: "未找到这条问答记录。" }, { status: 404 });
  }

  // proxy 已核验这一个环境变量对应的 Basic Auth。日志使用服务端配置值，绝不信任
  // 客户端额外提交的用户名字段。
  const adminUsername = process.env.ADMIN_USERNAME ?? "configured-admin";
  const conversation = await getConversation(audit.conversationId);
  const turn = conversation?.turns.find((item) => item.requestId === requestId);
  const outcome = turn?.answer ? "VIEWED" : "UNAVAILABLE" as const;

  let viewEvent;
  try {
    viewEvent = await recordQuestionAnswerView({
      requestId,
      conversationId: audit.conversationId,
      adminUsername,
      outcome,
    });
  } catch (error) {
    console.error("[admin/questions] failed to record full-answer access", error instanceof Error ? error.message : "unknown error");
    // 查看记录失败时不下发正文，避免出现“看过了却没有留下审计痕迹”。
    return NextResponse.json(
      { error: "ANSWER_ACCESS_AUDIT_FAILED", message: "暂时无法记录本次查看，请稍后重试。" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!turn?.answer) {
    return NextResponse.json(
      { error: "ANSWER_UNAVAILABLE", message: "这条回答已过期或属于旧版记录，无法读取完整内容。" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json({
    answer: turn.answer,
    viewedAt: viewEvent.viewedAt,
    viewEvents: await listQuestionAnswerViews(requestId),
  }, { headers: { "Cache-Control": "no-store" } });
}
