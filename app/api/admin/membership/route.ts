import { NextResponse } from "next/server";
import {
  isMembershipActive,
  listAllMemberships,
  listAllOrders,
} from "../../../../lib/server/membership-store";
import { findUserById } from "../../../../lib/server/user-store";

/**
 * 管理后台「会员与订单」页签的数据源。
 *
 * 鉴权不在这里做：proxy 挡了整个 /api/admin/*（HTTP Basic Auth），
 * 这里的代码只负责把 JSON 文件里的订单和会员拼成人能看的形状——
 * 邮箱从用户表取当前值，订单里不存邮箱副本，用户改邮箱后历史订单跟着变。
 *
 * 只读。想改某个用户的会员时长，直接改服务器上的
 * `.local-data/membership-store.json`（先 cp 备份），这里不提供手改入口——
 * 后台手改和支付回调并发写同一个文件，很难不出错，出错的代价是钱。
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  try {
    const [memberships, orders] = await Promise.all([
      listAllMemberships(),
      listAllOrders(200),
    ]);

    // userId → 邮箱/套餐的快查表。文件里几百个用户也就几百次内存查找，不值得再抽象。
    const userCache = new Map<string, { email: string; plan: string } | null>();
    const userInfoOf = async (userId: string) => {
      if (!userCache.has(userId)) {
        const user = await findUserById(userId);
        userCache.set(userId, user ? { email: user.email, plan: user.plan } : null);
      }
      return userCache.get(userId) ?? null;
    };

    const membershipViews = await Promise.all(
      memberships.map(async (membership) => {
        const user = await userInfoOf(membership.userId);
        const remainingMs = new Date(membership.paidThrough).getTime() - Date.now();
        return {
          userId: membership.userId,
          email: user?.email ?? "（账号已删除）",
          plan: user?.plan ?? "—",
          active: isMembershipActive(membership),
          paidThrough: membership.paidThrough,
          daysLeft: remainingMs > 0 ? Math.ceil(remainingMs / DAY_MS) : 0,
          updatedAt: membership.updatedAt,
        };
      }),
    );

    const orderViews = await Promise.all(
      orders.map(async (order) => {
        const user = await userInfoOf(order.userId);
        return {
          outTradeNo: order.outTradeNo,
          email: user?.email ?? "（账号已删除）",
          channel: order.channel,
          months: order.months,
          amountYuan: (order.amountFen / 100).toFixed(2),
          status: order.status,
          createdAt: order.createdAt,
          paidAt: order.paidAt ?? null,
          transactionId: order.transactionId ?? null,
          failReason: order.failReason ?? null,
        };
      }),
    );

    const paidOrders = orders.filter((order) => order.status === "PAID");
    return NextResponse.json({
      memberships: membershipViews,
      orders: orderViews,
      stats: {
        activeMemberCount: memberships.filter((item) => isMembershipActive(item)).length,
        paidOrderCount: paidOrders.length,
        pendingOrderCount: orders.filter((order) => order.status === "PENDING").length,
        /** 累计已收金额（元，两位小数）。只统计 PAID，退款不在模型里（个人站长手动原路退）。 */
        totalRevenueYuan: (paidOrders.reduce((sum, order) => sum + order.amountFen, 0) / 100).toFixed(2),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取会员数据失败。";
    return NextResponse.json({ error: "MEMBERSHIP_READ_FAILED", message }, { status: 500 });
  }
}
