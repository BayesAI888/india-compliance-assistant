import { NextResponse } from "next/server";
import { listConversationsForUser } from "../../../lib/server/conversation-store";
import { identifyRequest } from "../../../lib/server/request-identity";

/**
 * GET /api/conversations
 * 当前登录账号的「最近对话」列表。
 *
 * ## 为什么要有这个接口（2026-09-18）
 *
 * 在这之前，「最近对话」**只活在浏览器的 localStorage 里**。用户实测撞上了后果：
 * **同一个账号换一个浏览器登录，历史会话记录全没了**。
 *
 * 服务端其实一直存着完整对话（`conversation-store.ts`，保留 30 天），
 * 丢的只是"哪些对话是我的"这份索引——它被放在了客户端。
 * 和游客额度那个 P0 是同一个形状的错误：**该由服务端持有的东西放在了客户端手上**，
 * 区别只在于那次的后果是被人刷穿，这次的后果是用户自己丢数据。
 *
 * ## 只返回自己的
 *
 * 列表按 `userId` 过滤。游客建的对话没有 userId，不会出现在任何人的列表里——
 * 游客没有账号可绑，他们的列表仍然只能靠 localStorage，这是固有限制，不是遗漏。
 *
 * 不返回正文，只返回 id / 标题 / 时间 / 轮次：列表不需要正文，
 * 也不该顺手把几十轮问答全拖出来。点进去时由 `GET /api/chat` 单独取。
 */
export async function GET(request: Request) {
  const identity = await identifyRequest(request);
  if (!identity.user) {
    // 游客不是错误，只是没有服务端列表可给。返回空数组，让前端安静地退回本地列表。
    return NextResponse.json({ conversations: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const conversations = await listConversationsForUser(identity.user.id);
  return NextResponse.json({ conversations }, { headers: { "Cache-Control": "no-store" } });
}
