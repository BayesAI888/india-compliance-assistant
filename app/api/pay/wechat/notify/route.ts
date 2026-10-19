/**
 * POST /api/pay/wechat/notify —— 微信支付结果通知。
 *
 * ## 三条必须做对的规矩
 *
 * 1. **先验签再信内容**。签不过一律拒绝，后面的字段一个都不看——
 *    否则任何人发个 POST 就能给自己加会员（订单号是他自己编的）。
 * 2. **处理完必须回 SUCCESS 的 XML**。回别的、或者超时，微信会当作失败
 *    并在 24 小时内重发最多 15 次。业务上"加会员失败"也要回 SUCCESS：
 *    那是我们的故障，应该去查日志，而不是让微信一直重发刷我们。
 *    所以只有**验签失败**才回 FAIL（那说明请求不是微信发的）。
 * 3. **幂等**。confirmPaid 返回 false 表示这笔已经处理过了，此时直接回 SUCCESS。
 */
import { parseXml, verifySignature, WECHAT_FAIL_XML, WECHAT_SUCCESS_XML, wechatPayConfigFromEnv } from "../../../../../lib/server/wechat-pay";
import { confirmPaid } from "../../../../../lib/server/checkout";

export async function POST(request: Request) {
  const config = wechatPayConfigFromEnv();
  if (!config) return new Response(WECHAT_FAIL_XML, { status: 503, headers: { "Content-Type": "text/xml" } });

  const body = await request.text();
  const values = parseXml(body);
  if (!verifySignature(values, config.apiKey)) {
    console.warn("[pay/wechat] 回调验签失败", values.return_code ?? "", values.out_trade_no ?? "");
    return new Response(WECHAT_FAIL_XML, { headers: { "Content-Type": "text/xml" } });
  }

  // return_code 是通信层，result_code 是业务层。只有两层都 SUCCESS 才是真的付到了钱。
  if (values.return_code !== "SUCCESS" || values.result_code !== "SUCCESS") {
    return new Response(WECHAT_SUCCESS_XML, { headers: { "Content-Type": "text/xml" } });
  }

  const outTradeNo = values.out_trade_no ?? "";
  if (!outTradeNo) return new Response(WECHAT_SUCCESS_XML, { headers: { "Content-Type": "text/xml" } });

  try {
    const firstTime = await confirmPaid(outTradeNo, values.transaction_id);
    console.log(`[pay/wechat] ${outTradeNo} ${firstTime ? "已入账" : "重复通知，已跳过"}`);
  } catch (error) {
    // 记下来等人来查，但**不要回 FAIL**——回 FAIL 只会让微信反复重发同一笔。
    console.error(`[pay/wechat] ${outTradeNo} 入账失败：`, error);
  }
  return new Response(WECHAT_SUCCESS_XML, { headers: { "Content-Type": "text/xml" } });
}
