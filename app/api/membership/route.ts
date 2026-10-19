/**
 * GET /api/membership —— 会员状态、在售套餐、最近的购买记录。
 *
 * 套餐档位**从服务端的 PLAN_OPTIONS 下发**，前端不再自己写一份价目表——
 * 改价只要改一处，不会出现"页面写 9.9、实际扣 19.9"这种事故。
 */
import { NextResponse } from "next/server";
import { readCookie, SESSION_COOKIE } from "../../../lib/server/request-identity";
import { findUserBySessionToken } from "../../../lib/server/user-store";
import {
  listOrdersForUser,
  membershipViewOf,
  PLAN_OPTIONS,
  syncPlanWithMembership,
} from "../../../lib/server/membership-store";

export async function GET(request: Request) {
  const user = await findUserBySessionToken(readCookie(request, SESSION_COOKIE));
  if (!user) return NextResponse.json({ message: "请先登录。" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const synced = await syncPlanWithMembership(user);
  const membership = await membershipViewOf(user.id);
  const orders = await listOrdersForUser(user.id, 10);

  return NextResponse.json({
    plan: synced.plan,
    membership,
    plans: PLAN_OPTIONS.map((option) => ({
      months: option.months,
      priceFen: option.priceFen,
      label: option.label,
      priceYuan: option.priceFen / 100,
      /** 折合每月多少钱，用来在界面上说明"买 12 个月更划算"。 */
      perMonthYuan: Math.round((option.priceFen / option.months) / 10) / 10,
    })),
    orders: orders.map((order) => ({
      outTradeNo: order.outTradeNo,
      channel: order.channel,
      amountFen: order.amountFen,
      months: order.months,
      status: order.status,
      paidAt: order.paidAt ?? null,
      createdAt: order.createdAt,
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}
