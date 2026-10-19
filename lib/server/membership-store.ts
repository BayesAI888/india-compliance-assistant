/**
 * 会员有效期与购买订单（2026-09-30）。
 *
 * ## 为什么是"买会员时长"而不是"自动续费"
 *
 * 自动续费（微信委托代扣 / 支付宝商家扣款）要多申请一层产品权限，
 * 还要做扣款前 24 小时通知、扣款调度、失败重试、显著解约入口——
 * 而 9.9 元的小额订阅最容易招来"怎么又扣我钱"的投诉，微信还按投诉率考核账期。
 * 改成买时长之后，链路只剩：**下单 → 付款 → 回调 → 加时长**。
 *
 * ## 套餐由什么决定
 *
 * **由 `paidThrough`（会员有效期到什么时候）决定，不再看 user.plan 的静态值。**
 * 购买成功 → 延长 paidThrough、user.plan 置 professional；
 * 每次请求时惰性检查一次，过期就把 user.plan 降回 free（见 request-identity 的调用处）。
 * 惰性降级不需要额外的定时任务：定时任务漏跑一天，用户就多白嫖一天；
 * 而每次请求都判一次，过期那一刻起就是免费的，不会多给。
 *
 * ## 幂等是这里的生命线
 *
 * 支付平台会**重复发回调**（没收到成功响应就重发，微信最多 15 次）。
 * 加时长必须只在订单第一次从 PENDING 变 PAID 时做一次——
 * 否则一次付款被加两次时长，等于白送一个月。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { findUserById, setUserPlan, type StoredUser } from "./user-store";

export type PayChannel = "WECHAT" | "ALIPAY";
export type OrderStatus = "PENDING" | "PAID" | "FAILED" | "EXPIRED";

/** 一个用户一条：会员有效期到什么时候。没有记录＝从来没买过。 */
export interface StoredMembership {
  userId: string;
  /** 会员有效期截止（UTC ISO）。> now 就是专业版。 */
  paidThrough: string;
  /**
   * 已经发过续费提醒的档位 → 发信时刻（UTC ISO）。key 是"到期前 N 天"。
   * 有这个 key 就表示那一档发过了，**不再重发**——
   * 到期提醒一天扫一次，没有这个标记会天天发，用户三天收到三封一模一样的邮件。
   */
  renewalNotices?: Record<string, string>;
  /** 续费提醒连续失败的次数。达到 MAX_RENEWAL_NOTICE_ATTEMPTS 就停手。 */
  renewalNoticeAttempts?: number;
  /** 最后一次发信失败的原因，排查用，不展示给用户。 */
  renewalNoticeError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredOrder {
  id: string;
  userId: string;
  channel: PayChannel;
  /** 商户订单号，我们自己生成；回调和查单都靠它定位。 */
  outTradeNo: string;
  /** 渠道侧流水号，对账用。 */
  transactionId?: string;
  /** 金额（分）。 */
  amountFen: number;
  /** 买了几个月。 */
  months: number;
  status: OrderStatus;
  paidAt?: string;
  failReason?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 在售套餐。**改这里等于改价目表**，界面上的价格也从这里出，不在别处再写一份。
 * 时长按"月 = 30 天"算，不按自然月——跨月时不会出现多一天少一天的争议。
 */
export const PLAN_OPTIONS: Array<{ months: number; priceFen: number; label: string }> = [
  { months: 1, priceFen: 990, label: "1 个月" },
  { months: 3, priceFen: 2700, label: "3 个月" },
  { months: 12, priceFen: 9900, label: "12 个月" },
];

/** 一个月按多少天算。 */
export const DAYS_PER_MONTH = 30;

/** 订单多久没支付就算作废（分钟）。超时后不再接受这笔订单的回调。 */
export const ORDER_TIMEOUT_MINUTES = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 到期前几天发续费提醒。**必须升序**，一次只发最紧迫的那一档。
 *
 * 为什么不是"每天提醒一次直到续费"：9.9 元的小额订阅，
 * 天天发催续费邮件，用户第一反应是"这站天天给我发垃圾邮件"，
 * 退订比续费快得多。只在 7 天和 3 天两个点各触一次。
 */
export const RENEWAL_NOTICE_DAYS = [3, 7];

/** 同一档提醒最多重试几次。超了就停手，把原因留在日志里等人来看——不是无限重试刷接口。 */
export const MAX_RENEWAL_NOTICE_ATTEMPTS = 3;

interface MembershipStoreFile {
  schemaVersion: string;
  memberships: StoredMembership[];
  orders: StoredOrder[];
}

const dataDirectory =
  process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "membership-store.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): MembershipStoreFile {
  return { schemaVersion: "1.0", memberships: [], orders: [] };
}

async function readFileStore(): Promise<MembershipStoreFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as MembershipStoreFile;
    if (!Array.isArray(parsed.memberships) || !Array.isArray(parsed.orders)) return emptyStore();
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeFileStore(store: MembershipStoreFile) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, storePath);
}

function serializedMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** 纯函数：这条会员记录此刻有没有效。 */
export function isMembershipActive(
  membership: StoredMembership | undefined,
  now: Date = new Date(),
): boolean {
  if (!membership) return false;
  return new Date(membership.paidThrough).getTime() > now.getTime();
}

/** 纯函数：从某个起点往后加 N 个月。起点取"现在"和"已有有效期"里更晚的那个。 */
export function addMonths(from: Date, months: number): string {
  return new Date(from.getTime() + months * DAYS_PER_MONTH * 24 * 60 * 60 * 1000).toISOString();
}

export async function getMembership(userId: string): Promise<StoredMembership | null> {
  const store = await readFileStore();
  return store.memberships.find((item) => item.userId === userId) ?? null;
}

/** 按 months 找套餐。找不到的档位一律拒绝——价格只能来自 PLAN_OPTIONS，不接受客户端传金额。 */
export function planOptionOf(months: number) {
  return PLAN_OPTIONS.find((option) => option.months === months);
}

export interface CreateOrderResult {
  order: StoredOrder;
  /** 给渠道用的订单号，32 字符内、只含字母数字。 */
  outTradeNo: string;
}

export async function createOrder(input: {
  userId: string;
  channel: PayChannel;
  months: number;
}): Promise<CreateOrderResult | null> {
  const plan = planOptionOf(input.months);
  // 档位不存在就返回 null，让上层报 400。绝不按"客户端传的金额"下单——
  // 那是把定价权交给了不可信的输入。
  if (!plan) return null;
  return serializedMutation(async () => {
    const store = await readFileStore();
    const now = new Date().toISOString();
    const order: StoredOrder = {
      id: `ord_${randomUUID()}`,
      userId: input.userId,
      channel: input.channel,
      outTradeNo: `M${Date.now()}${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      amountFen: plan.priceFen,
      months: plan.months,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    };
    store.orders.push(order);
    await writeFileStore(store);
    return { order, outTradeNo: order.outTradeNo };
  });
}

export async function findOrderByOutTradeNo(outTradeNo: string): Promise<StoredOrder | null> {
  const store = await readFileStore();
  return store.orders.find((item) => item.outTradeNo === outTradeNo) ?? null;
}

/**
 * 标记订单已支付并延长会员有效期。
 *
 * **返回 false 表示这笔订单之前已经处理过了**（重复回调），此时**不会再加时长**——
 * 幂等就靠这一个返回值，调用方不需要自己再去判断状态。
 */
export async function payOrder(outTradeNo: string, transactionId?: string): Promise<boolean> {
  return serializedMutation(async () => {
    const store = await readFileStore();
    const order = store.orders.find((item) => item.outTradeNo === outTradeNo);
    if (!order) return false;
    if (order.status === "PAID") return false;

    const now = new Date();
    const nowIso = now.toISOString();
    order.status = "PAID";
    order.paidAt = nowIso;
    if (transactionId) order.transactionId = transactionId;
    order.updatedAt = nowIso;

    // 续费要从"现在"和"已有有效期"里更晚的那个往后加——
    // 没到期就再买一个月，不该把剩下那几天吃掉。
    const existing = store.memberships.find((item) => item.userId === order.userId);
    const base = existing && new Date(existing.paidThrough).getTime() > now.getTime()
      ? new Date(existing.paidThrough)
      : now;
    const paidThrough = addMonths(base, order.months);

    if (existing) {
      existing.paidThrough = paidThrough;
      existing.updatedAt = nowIso;
      // 续费＝进入一个新的计费周期，之前那几封"到期提醒"的记账要清零，
      // 否则下一轮周期永远不会再提醒（reminder key 还留着）。
      existing.renewalNotices = undefined;
      existing.renewalNoticeAttempts = undefined;
      existing.renewalNoticeError = undefined;
    } else {
      store.memberships.push({
        userId: order.userId,
        paidThrough,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
    await writeFileStore(store);
    return true;
  });
}

export async function failOrder(outTradeNo: string, reason: string): Promise<void> {
  await serializedMutation(async () => {
    const store = await readFileStore();
    const order = store.orders.find((item) => item.outTradeNo === outTradeNo);
    if (!order || order.status === "PAID") return;
    order.status = "FAILED";
    order.failReason = reason.slice(0, 500);
    order.updatedAt = new Date().toISOString();
    await writeFileStore(store);
  });
}

export interface MembershipView {
  /** 此刻是不是专业版。 */
  active: boolean;
  /** 有效期到什么时候。从来没买过时没有值。 */
  paidThrough?: string;
  /** 还剩几天（向上取整，0 表示今天到期）。 */
  daysLeft: number;
}

/** 给用户看的会员状态。 */
export async function membershipViewOf(userId: string): Promise<MembershipView> {
  const membership = await getMembership(userId);
  if (!membership) return { active: false, daysLeft: 0 };
  const remainingMs = new Date(membership.paidThrough).getTime() - Date.now();
  return {
    active: remainingMs > 0,
    paidThrough: membership.paidThrough,
    daysLeft: remainingMs > 0 ? Math.ceil(remainingMs / (24 * 60 * 60 * 1000)) : 0,
  };
}

/**
 * 把账号的 `plan` 和会员有效期对齐（**惰性降级**，每次请求都跑）。
 *
 * 为什么不用定时任务每天扫一遍：定时任务漏跑一天，用户就多白嫖一天；
 * 而每次请求判一次，过期那一刻起就是免费的。代价只是每次请求多读一个小文件。
 *
 * **只有买过会员的账号才会被降级**。没有会员记录的账号 plan 保持原样——
 * 那是手工开通的（比如测试账号），不该被这条逻辑改回免费版。
 */
export async function syncPlanWithMembership(user: StoredUser): Promise<StoredUser> {
  const membership = await getMembership(user.id);
  if (!membership) return user;
  const expired = !isMembershipActive(membership);
  const target = expired ? "free" : "professional";
  if (user.plan === target) return user;
  return (await setUserPlan(user.id, target)) ?? user;
}

/**
 * 纯函数：这条会员记录此刻**时间上**够格的档位（"还剩 N 天"已到点）。
 *
 * 只看时间，**不看发没发过**。claim 和 rollback 共用这一个判据：
 * 两者必须落在同一批档位上，否则"claim 时占了位、rollback 时撤不掉"——
 * 撤不掉就等于失败一次这一档永久作废，重试机制形同虚设。
 *
 * 判定是"剩余时间 <= N 天"而不是"剩余时间 == N 天"——
 * 定时任务一天只跑一次，不可能正好落在整数天上，等号会大量漏发。
 */
export function qualifyingRenewalMilestones(
  membership: StoredMembership,
  nowMs: number = Date.now(),
): number[] {
  const remaining = new Date(membership.paidThrough).getTime() - nowMs;
  // 已经过期的不催：降级由惰性检查处理，再发一封"您已到期"只是添堵。
  if (remaining <= 0) return [];
  return RENEWAL_NOTICE_DAYS.filter((days) => remaining <= days * DAY_MS);
}

/**
 * 纯函数：够格**且还没发过**的档位。这是"该不该发"的答案。
 *
 * 和 {@link qualifyingRenewalMilestones} 的区别只在于过滤掉已发过的——
 * 回滚时要的是前者（把刚占的位撤掉），发信时要的是这个（不重复发）。
 */
export function dueRenewalMilestones(
  membership: StoredMembership,
  nowMs: number = Date.now(),
): number[] {
  return qualifyingRenewalMilestones(membership, nowMs).filter(
    (days) => !membership.renewalNotices?.[String(days)],
  );
}

export interface DueRenewalNotice {
  userId: string;
  /** 收件邮箱。从用户表取**当前**邮箱——续费提醒不是排期邮件，改过邮箱就该发到新邮箱。 */
  email: string;
  paidThrough: string;
  /** 还剩几天（向上取整）。 */
  daysLeft: number;
  /** 这一封属于"到期前 N 天"那一档。 */
  milestoneDays: number;
}

/**
 * 扫出该发续费提醒的会员，**并当场把所有该发的档位标记为"已占位"**。
 *
 * 为什么要一次把所有合格档位都标记掉：假设剩余 2 天，7 天档和 3 天档都合格，
 * 只标记 3 天档的话，明天剩下的还是 2 天，就会补发一封"还剩 7 天"的邮件——
 * 过期前收到一封七天前就该到的邮件，比不发更让人困惑。
 * 所以：**只发最紧迫的那一档，其余合格档位一并作废。**
 */
export async function claimDueRenewalNotices(
  now: Date = new Date(),
  limit = 20,
): Promise<DueRenewalNotice[]> {
  return serializedMutation(async () => {
    const store = await readFileStore();
    const nowMs = now.getTime();
    const iso = now.toISOString();
    const due: DueRenewalNotice[] = [];

    for (const membership of store.memberships) {
      if (due.length >= limit) break;
      const milestones = dueRenewalMilestones(membership, nowMs);
      if (milestones.length === 0) continue;
      if ((membership.renewalNoticeAttempts ?? 0) >= MAX_RENEWAL_NOTICE_ATTEMPTS) continue;
      const user = await findUserById(membership.userId);
      // 账号已经删掉了：没有收件人，跳过（不占位，免得白占一个名额）。
      if (!user) continue;

      membership.renewalNotices = { ...(membership.renewalNotices ?? {}) };
      for (const days of milestones) membership.renewalNotices[String(days)] = iso;
      membership.updatedAt = iso;

      due.push({
        userId: membership.userId,
        email: user.email,
        paidThrough: membership.paidThrough,
        daysLeft: Math.ceil((new Date(membership.paidThrough).getTime() - nowMs) / DAY_MS),
        milestoneDays: Math.min(...milestones),
      });
    }

    if (due.length > 0) await writeFileStore(store);
    return due;
  });
}

/** 发信成功：占位转为正式记录，失败计数清零。 */
export async function markRenewalNoticeSent(userId: string, now: Date = new Date()): Promise<void> {
  await serializedMutation(async () => {
    const store = await readFileStore();
    const membership = store.memberships.find((item) => item.userId === userId);
    if (!membership) return;
    membership.renewalNoticeAttempts = undefined;
    membership.renewalNoticeError = undefined;
    membership.updatedAt = now.toISOString();
    await writeFileStore(store);
  });
}

/**
 * 发信失败：把刚才占的位撤掉，让明天的扫描重新扫到并重试。
 *
 * 撤的是"此刻所有时间上够格的档位"（{@link qualifyingRenewalMilestones}），
 * **不能**用 dueRenewalMilestones——那个会过滤掉已发过的，
 * 而刚 claim 完这批档位恰恰都已经被标成已发，用它算出来是空集，一个都撤不掉。
 * 两次调用之间剩余时间只会变短，够格档位只会变多不会变少，这里撤得干净。
 */
export async function rollbackRenewalNotice(userId: string, error: string): Promise<void> {
  await serializedMutation(async () => {
    const store = await readFileStore();
    const membership = store.memberships.find((item) => item.userId === userId);
    if (!membership) return;
    for (const days of qualifyingRenewalMilestones(membership)) {
      delete membership.renewalNotices?.[String(days)];
    }
    if (membership.renewalNotices && Object.keys(membership.renewalNotices).length === 0) {
      membership.renewalNotices = undefined;
    }
    membership.renewalNoticeAttempts = (membership.renewalNoticeAttempts ?? 0) + 1;
    membership.renewalNoticeError = error.slice(0, 500);
    membership.updatedAt = new Date().toISOString();
    await writeFileStore(store);
  });
}

export async function listOrdersForUser(userId: string, limit = 20): Promise<StoredOrder[]> {
  const store = await readFileStore();
  return store.orders
    .filter((item) => item.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** 管理端用：全部会员记录（最近更新的在前）。 */
export async function listAllMemberships(): Promise<StoredMembership[]> {
  const store = await readFileStore();
  return [...store.memberships].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 管理端用：全部订单（新的在前）。 */
export async function listAllOrders(limit = 200): Promise<StoredOrder[]> {
  const store = await readFileStore();
  return store.orders
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
