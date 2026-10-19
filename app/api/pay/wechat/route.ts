/**
 * 微信 Native（扫码）支付：下单与查单。
 *
 * - POST：建订单 → 调统一下单 → 把 `code_url` 给前端渲染成二维码
 * - GET ：前端轮询这笔订单付了没有
 *
 * 为什么**一定要有查单**：支付结果通知可能延迟、可能被挡，
 * 而用户正盯着二维码页面看。只等通知的话，用户付完钱界面还停在"待支付"，
 * 他会以为付了没到账，然后重复付款。
 */
import { NextResponse } from "next/server";
import { readCookie, SESSION_COOKIE } from "../../../../lib/server/request-identity";
import { findUserBySessionToken } from "../../../../lib/server/user-store";
import { clientIpFromRequest, pollOrder, startCheckout } from "../../../../lib/server/checkout";
import { findOrderByOutTradeNo, planOptionOf } from "../../../../lib/server/membership-store";

export async function POST(request: Request) {
  const user = await findUserBySessionToken(readCookie(request, SESSION_COOKIE));
  if (!user) return NextResponse.json({ message: "请先登录后再购买。" }, { status: 401 });

  let months: number;
  try {
    const body = await request.json() as { months?: number };
    months = Number(body.months);
  } catch {
    return NextResponse.json({ message: "请求格式无效。" }, { status: 400 });
  }
  if (!planOptionOf(months)) return NextResponse.json({ message: "没有这个套餐档位。" }, { status: 400 });

  const result = await startCheckout({
    userId: user.id,
    channel: "WECHAT",
    months,
    clientIp: clientIpFromRequest(request),
  });
  if (!result.ok) return NextResponse.json({ message: result.message }, { status: result.status });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const user = await findUserBySessionToken(readCookie(request, SESSION_COOKIE));
  if (!user) return NextResponse.json({ message: "请先登录。" }, { status: 401 });

  const outTradeNo = new URL(request.url).searchParams.get("order")?.trim() ?? "";
  if (!outTradeNo) return NextResponse.json({ message: "缺少订单号。" }, { status: 400 });

  // 只能查自己的订单——订单号里带的是流水，不校验归属就成了"查任意订单状态"的接口。
  const order = await findOrderByOutTradeNo(outTradeNo);
  if (!order || order.userId !== user.id) return NextResponse.json({ message: "订单不存在。" }, { status: 404 });

  return NextResponse.json(await pollOrder(outTradeNo), { headers: { "Cache-Control": "no-store" } });
}
