import { NextResponse } from "next/server";
import { identifyRequest } from "../../../lib/server/request-identity";
import {
  cancelReminder,
  createReminder,
  deadlineUtcFromIndiaDate,
  listRemindersForUser,
  MAX_ACTIVE_REMINDERS_PER_USER,
  notifyUtcFromDeadline,
} from "../../../lib/server/reminder-store";

/**
 * GET /api/reminders —— 当前账号的提醒列表。
 * POST /api/reminders —— 建提醒（action=create）/ 取消提醒（action=cancel）。
 *
 * ## 为什么必须登录
 *
 * 提醒要发到邮箱，而游客没有账号、也就没有邮箱可发。这里的门槛不是"付费墙"，
 * 是功能本身没有收件地址。
 *
 * ## 日期怎么算
 *
 * 用户只填一个日期（Notice 上写"10月20日前答复"），后端按印度当地当日 23:59 作截止，
 * 提醒时间取截止日前一天、北京时间 09:00——收信的人在中国。
 * 换算都是纯函数（reminder-store.ts），可单测，不在这里散着写。
 */

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_TITLE_LENGTH = 120;
const MAX_DETAIL_LENGTH = 500;

function badRequest(message: string) {
  return NextResponse.json({ error: "BAD_REQUEST", message }, { status: 400, headers: NO_STORE });
}

export async function GET(request: Request) {
  const identity = await identifyRequest(request);
  if (!identity.user) {
    return NextResponse.json(
      { error: "NEEDS_LOGIN", message: "登录后才能使用合规提醒——提醒要发到你账号的邮箱。" },
      { status: 401, headers: NO_STORE },
    );
  }
  return NextResponse.json(
    { reminders: await listRemindersForUser(identity.user.id) },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const identity = await identifyRequest(request);
  if (!identity.user) {
    return NextResponse.json(
      { error: "NEEDS_LOGIN", message: "登录后才能使用合规提醒——提醒要发到你账号的邮箱。" },
      { status: 401, headers: NO_STORE },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("请求内容不是合法的 JSON。");
  }

  // 取消不需要专业版：已经排好的提醒，用户想取消就该让他取消，
  // 拿"你不是专业版"拦住他不让他停掉一条提醒，是拿门槛为难人。
  if (payload.action === "cancel") {
    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) return badRequest("缺少提醒 id。");
    const cancelled = await cancelReminder(id, identity.user.id);
    return NextResponse.json(
      { ok: cancelled, reminders: await listRemindersForUser(identity.user.id) },
      { headers: NO_STORE },
    );
  }

  if (identity.user.plan !== "professional") {
    return NextResponse.json(
      {
        error: "NEEDS_UPGRADE",
        message: "合规提醒是专业版功能，每月 9.9 元（每月 30 次提问、文件分析、Word/PDF 导出与截止日提醒）。",
      },
      { status: 402, headers: NO_STORE },
    );
  }

  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const date = typeof payload.date === "string" ? payload.date.trim() : "";
  const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";

  if (!title) return badRequest("请填写这条提醒的标题，例如「GSTR-3B 月度申报」。");
  if (title.length > MAX_TITLE_LENGTH) return badRequest(`标题最多 ${MAX_TITLE_LENGTH} 个字。`);
  if (detail.length > MAX_DETAIL_LENGTH) return badRequest(`说明最多 ${MAX_DETAIL_LENGTH} 个字。`);

  const deadlineAt = deadlineUtcFromIndiaDate(date);
  if (!deadlineAt) return badRequest("截止日期格式不对，请按 年-月-日 填写，例如 2026-10-20。");
  // 已经过了的截止日：建了也是立刻发一封"你的事已经过期了"的邮件，没有意义。
  if (new Date(deadlineAt).getTime() <= Date.now()) return badRequest("这个截止日期已经过了。");

  const notifyAt = notifyUtcFromDeadline(deadlineAt);
  if (!notifyAt) return badRequest("提醒时间算不出来，请换一个截止日期再试。");

  const result = await createReminder({
    userId: identity.user.id,
    email: identity.user.email,
    deadlineAt,
    notifyAt,
    title,
    detail,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: "TOO_MANY_ACTIVE",
        message: `最多同时保留 ${MAX_ACTIVE_REMINDERS_PER_USER} 条提醒，先取消几条再建新的。`,
      },
      { status: 409, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    { reminders: await listRemindersForUser(identity.user.id) },
    { headers: NO_STORE },
  );
}
