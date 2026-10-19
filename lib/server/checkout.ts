/**
 * 下单与到账确认的共享服务层（2026-10-12 建）。
 *
 * 支付路由只是薄薄一层 HTTP，真正的动作在这里——
 * **下单、查单、到账加会员只有一份实现**，不会出现多处对同一份订单数据的
 * 理解不一致（比如一边认为"通知到了就算付过"，另一边认为"必须查单确认"）。
 *
 * 2026-10-12 起只保留微信 Native 扫码一个渠道（运营决策：只申请微信商户号）。
 */
import {
  createOrder,
  findOrderByOutTradeNo,
  ORDER_TIMEOUT_MINUTES,
  payOrder,
  planOptionOf,
  type PayChannel,
} from "./membership-store";
import { setUserPlan } from "./user-store";
import { clientIpFrom } from "./anonymous-trial-store";
import { createNativeOrder, queryOrder as queryWechatOrder, wechatPayConfigFromEnv } from "./wechat-pay";

/** 商品名，微信下单的 body 用这个。 */
export const PRODUCT_NAME = "印度合规助手·专业版";

export type StartCheckoutResult =
  | {
      ok: true;
      outTradeNo: string;
      months: number;
      amountFen: number;
      /** 微信：把这个字符串渲染成二维码给用户扫。 */
      codeUrl: string;
    }
  | { ok: false; status: number; message: string };

/**
 * 建订单 + 向微信下单。
 *
 * 金额**只来自 PLAN_OPTIONS**，不接受客户端传的任何金额——
 * 否则等于把定价权交给了浏览器，9.9 元能被改成 0.01 元。
 */
export async function startCheckout(input: {
  userId: string;
  channel: PayChannel;
  months: number;
  clientIp: string;
}): Promise<StartCheckoutResult> {
  if (input.channel !== "WECHAT") {
    return { ok: false, status: 400, message: "仅支持微信支付。" };
  }
  const plan = planOptionOf(input.months);
  if (!plan) return { ok: false, status: 400, message: "没有这个套餐档位。" };

  const created = await createOrder({ userId: input.userId, channel: input.channel, months: plan.months });
  if (!created) return { ok: false, status: 500, message: "创建订单失败，请重试。" };

  const config = wechatPayConfigFromEnv();
  // 没配置就明确报"未开通"，而不是让用户在二维码那一步才发现付不了——
  // 那会让人以为是自己网络坏了。
  if (!config) return { ok: false, status: 503, message: "微信支付尚未开通。" };
  const native = await createNativeOrder(config, {
    outTradeNo: created.outTradeNo,
    totalFen: plan.priceFen,
    description: `${PRODUCT_NAME} ${plan.label}`,
    clientIp: input.clientIp,
  });
  if (!native.ok) return { ok: false, status: 502, message: native.error };
  return { ok: true, outTradeNo: created.outTradeNo, months: plan.months, amountFen: plan.priceFen, codeUrl: native.codeUrl };
}

/**
 * 确认到账并延长会员。
 *
 * **返回 false 表示这笔已经处理过了**（重复通知 / 重复查单）。
 * 加时长只发生在订单第一次从 PENDING 变 PAID 的那一刻，这是防重复入账的唯一开关。
 */
export async function confirmPaid(outTradeNo: string, transactionId?: string): Promise<boolean> {
  const order = await findOrderByOutTradeNo(outTradeNo);
  if (!order) return false;
  const firstTime = await payOrder(outTradeNo, transactionId);
  if (!firstTime) return false;
  await setUserPlan(order.userId, "professional");
  return true;
}

/** 订单是不是已经超时未付。只用于提示，不写回存储——见 timeout 说明。 */
function isTimedOut(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() > ORDER_TIMEOUT_MINUTES * 60 * 1000;
}

export interface PollResult {
  paid: boolean;
  expired: boolean;
  status: string;
  message?: string;
}

/**
 * 主动查渠道确认有没有付钱。**不能只依赖异步通知**：
 * 通知可能延迟、可能被防火墙挡掉，而用户正在页面上盯着看——
 * 没收到通知就一直显示"待支付"，用户会以为付了钱没到账。
 */
export async function pollOrder(outTradeNo: string): Promise<PollResult> {
  const order = await findOrderByOutTradeNo(outTradeNo);
  if (!order) return { paid: false, expired: true, status: "NOT_FOUND", message: "订单不存在。" };
  if (order.status === "PAID") return { paid: true, expired: false, status: "PAID" };

  // 超时只在**展示层**提示，不把订单改成 EXPIRED：
  // 用户可能刚好在超时后付了款，那时通知到达仍要能正常加会员。
  const expired = isTimedOut(order.createdAt);

  const config = wechatPayConfigFromEnv();
  if (!config) return { paid: false, expired, status: "NOT_CONFIGURED", message: "微信支付未开通。" };
  const result = await queryWechatOrder(config, outTradeNo);
  if (!result.ok) return { paid: false, expired, status: "PENDING", message: result.error };
  if (result.tradeState === "SUCCESS") {
    await confirmPaid(outTradeNo, result.transactionId);
    return { paid: true, expired: false, status: "PAID" };
  }
  return { paid: false, expired, status: result.tradeState };
}

/**
 * 微信下单要求传真实客户端 IP，所以复用 anonymous-trial-store 里那个（已处理反向代理头）。
 * 取不到时给 127.0.0.1：**下单接口宁可 IP 不准也不能失败**，
 * 这个字段只用于风控统计，不是支付凭据。
 */
export function clientIpFromRequest(request: Request): string {
  return clientIpFrom(request.headers) || "127.0.0.1";
}
