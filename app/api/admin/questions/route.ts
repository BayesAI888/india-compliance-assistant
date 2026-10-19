import { NextResponse } from "next/server";
import { listRecentQuestionAudits } from "../../../../lib/server/question-audit-store";
import { findUserById } from "../../../../lib/server/user-store";

function maskEmail(email: string) {
  const at = email.indexOf("@");
  if (at <= 1) return "***";
  return `${email.slice(0, 2)}***${email.slice(at)}`;
}

/**
 * 后台「问答运营台」数据源。
 *
 * proxy 已为 /api/admin/* 加上管理员认证。此接口仍按最小必要原则输出：不含上传
 * 文件原文、不含会话完整回答、不含 Cookie/密码/密钥；邮箱默认脱敏。
 */
export async function GET(request: Request) {
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.floor(rawLimit), 500)) : 100;
  try {
    const records = await listRecentQuestionAudits(limit);
    const userCache = new Map<string, string | null>();
    const userLabelOf = async (userId?: string) => {
      if (!userId) return "访客试用";
      if (!userCache.has(userId)) {
        const user = await findUserById(userId);
        userCache.set(userId, user ? maskEmail(user.email) : null);
      }
      return userCache.get(userId) ?? "已删除账号";
    };

    const questions = await Promise.all(records.map(async (record) => ({
      ...record,
      user: await userLabelOf(record.userId),
    })));
    const stats = {
      total: questions.length,
      processing: questions.filter((item) => item.status === "PROCESSING").length,
      sufficient: questions.filter((item) => item.status === "SUFFICIENT").length,
      needInformation: questions.filter((item) => item.status === "NEED_INFORMATION").length,
      unableToConfirm: questions.filter((item) => item.status === "UNABLE_TO_CONFIRM").length,
      quotaExhausted: questions.filter((item) => item.status === "QUOTA_EXHAUSTED").length,
    };
    return NextResponse.json({ questions, stats }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[admin/questions] failed to read audit records", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { error: "QUESTION_AUDIT_READ_FAILED", message: "暂时无法读取问答运营记录，请稍后重试。" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
