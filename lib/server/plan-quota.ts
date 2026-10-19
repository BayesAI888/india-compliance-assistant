/**
 * 套餐与额度规则。纯函数，不碰存储、不碰网络——方便单测，
 * 也让"每个档位多少次"这条业务规则集中在一处，不散落在接口和界面里。
 *
 * 背景（2026-09-17）：在这之前，界面上的"免费额度 1/1次""升级专业版"
 * **全是前端写死的摆设**，后端一次都没有检查过。现在账号系统上来了，
 * 这些数字必须真的管用，否则就是在骗用户。
 */
import { ANONYMOUS_IP_DAILY_LIMIT } from "./anonymous-trial-store";
import type { UserPlan } from "./user-store";

/** 每个自然月的提问次数上限。改这里就等于改产品定价，别在别处再写一份。 */
export const PLAN_MONTHLY_LIMIT: Record<UserPlan, number> = {
  free: 3,
  professional: 30,
};

/** 游客（没登录）一共能试问几次。按浏览器记，清了 cookie 就能重来—— */
/*  这不是严密的风控，只是一道"先试试再注册"的门槛。真想防刷要靠账号和实名，
    而不是靠 cookie。写在这里是为了别让人误以为它拦得住有心人。 */
export const ANONYMOUS_TRIAL_LIMIT = 1;

/**
 * 不限次数的测试账号白名单（邮箱，逗号分隔，大小写和空格都不敏感）。
 *
 * 为什么用环境变量而不是在代码里写死某个邮箱、也不是去改存储里的计数：
 *
 * 1. **可撤销**：测完把服务器 `.env.local` 里那一行删掉、重启，立刻恢复正常计费。
 *    改代码要重新打包部署；改存储里的数字则会被下一次提问覆盖回去。
 * 2. **不动计费逻辑**：`applyFollowUpCharging`、`consumeQuota` 这些规则一行没改，
 *    只是这个账号的"上限"变成了无穷大。将来这些规则改了，白名单也不会跟着坏。
 * 3. **看得见**：谁被放行了写在配置里，不用翻代码或翻数据库才知道。
 *
 * ⚠️这是**给自己人测试用的后门**，不是产品功能。放进白名单的账号
 * 等于可以无限次消耗 DeepSeek 和 Indian Kanoon 的调用额度——那是真花钱的。
 * 别把客户邮箱放进来"当福利"，客户该做的是升级套餐。
 */
function unlimitedEmails(): Set<string> {
  const raw = process.env.QUOTA_UNLIMITED_EMAILS?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function hasUnlimitedQuota(email: string | undefined): boolean {
  if (!email) return false;
  return unlimitedEmails().has(email.trim().toLowerCase());
}

/** 白名单账号在界面上显示的"上限"。用一个足够大的数，而不是 Infinity——
    Infinity 序列化成 JSON 会变成 null，前端拿到 null 会把进度环算成 NaN。 */
export const UNLIMITED_QUOTA_LIMIT = 999_999;

export const PLAN_LABEL: Record<UserPlan, string> = {
  free: "免费用户",
  professional: "个人专业版",
};

/** 当前是哪个自然月，YYYY-MM。额度按这个跨月重置。 */
export function currentYearMonth(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export interface QuotaView {
  plan: UserPlan | "anonymous";
  limit: number;
  used: number;
  remaining: number;
}

/**
 * 算出要展示给用户的额度。跨月时按"已经重置"计算——
 * 存储里的计数要等下一次真的提问才会被改写，但显示上不能等到那时候才归零，
 * 否则用户月初打开会看到上个月用完的数字，以为自己不能问了。
 */
export function quotaViewOf(input: {
  plan: UserPlan;
  quotaYearMonth: string;
  quotaUsed: number;
  yearMonth?: string;
  /** 白名单测试账号的邮箱。传进来才会去查白名单。 */
  email?: string;
}): QuotaView {
  const yearMonth = input.yearMonth ?? currentYearMonth();
  const limit = hasUnlimitedQuota(input.email)
    ? UNLIMITED_QUOTA_LIMIT
    : PLAN_MONTHLY_LIMIT[input.plan];
  const used = input.quotaYearMonth === yearMonth ? input.quotaUsed : 0;
  return { plan: input.plan, limit, used, remaining: Math.max(0, limit - used) };
}

/**
 * 游客的额度视图。
 *
 * 两把锁**取更严的那把**（2026-09-18）：
 * - `cookieUsed`：这个浏览器用了几次，上限 `ANONYMOUS_TRIAL_LIMIT`（1 次）
 * - `ipUsed`：这个出口 IP 今天用了几次，上限 `ANONYMOUS_IP_DAILY_LIMIT`（5 次/天）
 *
 * 为什么取"剩余次数更少"的那把而不是相加或取平均：这两把锁挡的是不同的东西，
 * 任意一把到顶就该拦。Cookie 锁挡"同一个人反复白嫖"，IP 锁挡"脚本不带 Cookie 刷"——
 * 只要有一条成立，这次请求就不该放行。
 *
 * 展示给用户的 limit/used 跟着**更严的那把**走，界面上的数字才和实际能不能问一致。
 * 这是改造前那个教训的延续：界面说还有几次、一问却说没额度，比直接说没额度更伤信任。
 */
export function anonymousQuotaView(cookieUsed: number, ipUsed = 0): QuotaView {
  const byCookie = {
    limit: ANONYMOUS_TRIAL_LIMIT,
    used: Math.min(cookieUsed, ANONYMOUS_TRIAL_LIMIT),
    remaining: Math.max(0, ANONYMOUS_TRIAL_LIMIT - cookieUsed),
  };
  const byIp = {
    limit: ANONYMOUS_IP_DAILY_LIMIT,
    used: Math.min(ipUsed, ANONYMOUS_IP_DAILY_LIMIT),
    remaining: Math.max(0, ANONYMOUS_IP_DAILY_LIMIT - ipUsed),
  };
  const stricter = byIp.remaining < byCookie.remaining ? byIp : byCookie;
  return { plan: "anonymous", ...stricter };
}
