/**
 * 从一个请求里认出"这是谁"，以及他还剩多少额度。
 *
 * 抽出来单独放，是因为 /api/chat 和 /api/auth 都要用同一套口径——
 * 界面上显示的剩余次数和实际能不能问，必须来自同一处计算，
 * 否则又会出现"界面说还有2次、一问就说没额度"这种自相矛盾（这正是改造前的状态：
 * 界面上的额度是前端写死的，后端根本不检查）。
 */
import { NextResponse } from "next/server";
import { findUserBySessionToken, type StoredUser } from "./user-store";
import { syncPlanWithMembership } from "./membership-store";
import {
  ANONYMOUS_IP_DAILY_LIMIT,
  clientIpFrom,
  getIpTrialUsed,
  isTrustworthyClientIp,
} from "./anonymous-trial-store";
import {
  anonymousQuotaView,
  ANONYMOUS_TRIAL_LIMIT,
  currentYearMonth,
  quotaViewOf,
  type QuotaView,
} from "./plan-quota";

export const SESSION_COOKIE = "ic_session";
/** 游客已试问次数。放 cookie 里，清掉就能重来——见 plan-quota.ts 里的说明，这不是风控。 */
export const TRIAL_COOKIE = "ic_trial";

export function readCookie(request: Request, name: string): string {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

export interface RequestIdentity {
  user?: StoredUser;
  /** 这次请求的客户端 IP，可信时才有值（见 anonymous-trial-store.ts）。用于事后计数。 */
  clientIp?: string;
  /** 这个 IP 今天已经试问了几次。没有可信 IP 时恒为 0。 */
  ipTrialUsed: number;
  /** 游客已经试问了几次（登录用户恒为0，不看这个值）。 */
  anonymousUsed: number;
  quota: QuotaView;
}

export async function identifyRequest(request: Request): Promise<RequestIdentity> {
  const found = await findUserBySessionToken(readCookie(request, SESSION_COOKIE));
  if (found) {
    // 会员到期在这里**顺手降级**，不需要额外的定时任务：每次请求都判一次，
    // 过期那一刻起就是免费的，不会多给一天。
    const user = await syncPlanWithMembership(found);
    return { user, anonymousUsed: 0, ipTrialUsed: 0, quota: quotaViewOf(user) };
  }

  const raw = Number.parseInt(readCookie(request, TRIAL_COOKIE), 10);
  const anonymousUsed = Number.isFinite(raw) && raw > 0 ? raw : 0;

  /*
   * 游客额度的第二把锁：**服务端按 IP 计数**（2026-09-18 修的 P0 漏洞）。
   *
   * 原来游客额度只存在 Cookie 里，服务端拿不到 Cookie 就当"新访客"放行——
   * 于是不带 Cookie 直连 `/api/chat` 每次都是全新额度，6 线程能把 100 题跑完，
   * 付费墙形同虚设。**计数的唯一副本在客户端手上，客户端就能随时清零。**
   *
   * 现在两把锁任意一把到上限就拦：Cookie 管"同一个浏览器"，IP 管"同一个出口"。
   * IP 不可信（nginx 没配 X-Forwarded-For，全都是 127.0.0.1）时 IP 锁整体让开——
   * 宁可退回修复前的状态，也不能把所有访客算进同一个计数器互相挤掉。
   */
  const ip = clientIpFrom(request.headers);
  const clientIp = isTrustworthyClientIp(ip) ? ip : undefined;
  const ipTrialUsed = clientIp ? await getIpTrialUsed(clientIp) : 0;

  return {
    anonymousUsed,
    clientIp,
    ipTrialUsed,
    quota: anonymousQuotaView(anonymousUsed, ipTrialUsed),
  };
}

/** 游客试问计数 +1 的 Set-Cookie。登录用户不用这个，他们的额度记在账号上。 */
export function trialCookie(used: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  // 一年——只是个"用过几次"的计数，不是敏感信息，但同样不让 JS 读，减少被脚本刷的便利。
  return `${TRIAL_COOKIE}=${used}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 60 * 60}${secure}`;
}

/** 额度用完时的统一响应。文案区分游客和登录用户——他们该做的事不一样。 */
export function quotaExhaustedResponse(identity: RequestIdentity) {
  const isAnonymous = !identity.user;
  return NextResponse.json({
    error: "QUOTA_EXHAUSTED",
    message: isAnonymous
      // 文案按**实际拦住他的那把锁**说：被 IP 锁拦住时说成"你这个浏览器用完了"，
      // 用户清了 Cookie 发现还是不行，会以为是系统坏了。
      ? (identity.ipTrialUsed >= ANONYMOUS_IP_DAILY_LIMIT
        ? `这个网络今天的试用次数已经用完，注册一个账号可以继续提问。`
        : `试用的 ${ANONYMOUS_TRIAL_LIMIT} 次已经用完，注册一个账号可以继续提问。`)
      : `本月 ${identity.quota.limit} 次提问额度已经用完，下个月 1 日自动恢复。`,
    quota: identity.quota,
    needs_login: isAnonymous,
  }, { status: 402, headers: { "Cache-Control": "no-store" } });
}

export { currentYearMonth };
