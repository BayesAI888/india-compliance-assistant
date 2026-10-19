/**
 * 微信支付 Native（扫码）下单与回调验签，V2 接口（2026-09-30 建）。
 *
 * ## 为什么是 V2 而不是 V3
 *
 * V3 更安全（RSA + 平台证书），但要商户 API 证书、证书序列号、平台证书下载与轮换，
 * 对一个只有单一收款场景的小站来说是不必要的复杂度。V2 用一个 API 密钥就够了，
 * 而 Native 下单、查单、回调验签这三个接口在 V2 上都是成熟稳定的。
 *
 * ## 为什么不用 SDK
 *
 * 和 ses-mailer 同样的理由：项目依赖里没有微信支付 SDK，为三个接口引入一整个 SDK
 * 意味着服务器每次 `pnpm install` 多装一批包。V2 的签名就是"排序 + 拼串 + MD5"，
 * XML 也只有一层结构，用 Node 内置能力写完不到 200 行。
 *
 * ## Native 支付怎么走完
 *
 * 1. 后端调统一下单（trade_type=NATIVE）→ 拿到 `code_url`
 * 2. 前端把 code_url 渲染成二维码，用户用微信扫码付款
 * 3. 付款后微信 POST 回调到 notify_url → 验签 → 加会员时长 → 回 SUCCESS
 * 4. 前端同时轮询查单接口（回调可能延迟，不能只等回调才更新界面）
 */
import { createHash, randomBytes } from "node:crypto";

const UNIFIED_ORDER_URL = "https://api.mch.weixin.qq.com/pay/unifiedorder";
const ORDER_QUERY_URL = "https://api.mch.weixin.qq.com/pay/orderquery";

/** 交易状态。只有 SUCCESS 才算真的收到钱。 */
export type TradeState = "SUCCESS" | "NOTPAY" | "CLOSED" | "PAYERROR" | "REFUND" | "UNKNOWN";

export interface WechatPayConfig {
  appId: string;
  mchId: string;
  /** V2 API 密钥（商户平台 → API 安全里设的那个，不是 APIv3 密钥）。 */
  apiKey: string;
  /** 支付结果回调地址，必须外网可访问、不能带参数。 */
  notifyUrl: string;
}

export function wechatPayConfigFromEnv(): WechatPayConfig | null {
  const appId = process.env.WECHAT_APP_ID?.trim();
  const mchId = process.env.WECHAT_MCH_ID?.trim();
  const apiKey = process.env.WECHAT_API_KEY?.trim();
  if (!appId || !mchId || !apiKey) return null;
  return {
    appId,
    mchId,
    apiKey,
    notifyUrl: process.env.WECHAT_NOTIFY_URL?.trim()
      || `https://${process.env.SITE_HOST?.trim() || "indiacompliance.cn"}/api/pay/wechat/notify`,
  };
}

/** 非空参数按 key 的 ASCII 升序拼成 k=v&k=v，末尾接 &key=APIKEY，再 MD5 大写。 */
export function signMd5(params: Record<string, string | number | undefined>, apiKey: string): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  parts.push(`key=${apiKey}`);
  return createHash("md5").update(parts.join("&"), "utf8").digest("hex").toUpperCase();
}

export function toXml(values: Record<string, string | number | undefined>): string {
  const body = Object.entries(values)
    .map(([key, value]) => `<${key}><![CDATA[${value ?? ""}]]></${key}>`)
    .join("");
  return `<xml>${body}</xml>`;
}

/** 只解析一层、无嵌套的微信 XML，够用且不引第三方依赖。 */
export function parseXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /<([A-Za-z0-9_]+)>(?:(?:<!\[CDATA\[(.*?)\]\]>)|(.*?))<\/\1>/g;
  for (const match of xml.matchAll(pattern)) {
    result[match[1]] = match[2] ?? match[3] ?? "";
  }
  return result;
}

function nonce(): string {
  return randomBytes(16).toString("hex");
}

/** 回调/查单返回的字段验签。sign 字段本身不参与签名，其余都参与。 */
export function verifySignature(values: Record<string, string>, apiKey: string): boolean {
  const received = values.sign ?? "";
  if (!received) return false;
  const rest = { ...values };
  delete rest.sign;
  return signMd5(rest, apiKey) === received.toUpperCase();
}

export type NativeOrderResult =
  | { ok: true; codeUrl: string; prepayId?: string }
  | { ok: false; error: string };

export async function createNativeOrder(
  config: WechatPayConfig,
  input: { outTradeNo: string; totalFen: number; description: string; clientIp: string },
): Promise<NativeOrderResult> {
  const params: Record<string, string | number> = {
    appid: config.appId,
    mch_id: config.mchId,
    nonce_str: nonce(),
    body: input.description,
    out_trade_no: input.outTradeNo,
    total_fee: input.totalFen,
    spbill_create_ip: input.clientIp,
    notify_url: config.notifyUrl,
    trade_type: "NATIVE",
  };
  params.sign = signMd5(params, config.apiKey);

  let text = "";
  try {
    const response = await fetch(UNIFIED_ORDER_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: toXml(params),
      signal: AbortSignal.timeout(15_000),
    });
    text = await response.text();
  } catch (error) {
    return { ok: false, error: `调用微信下单失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const parsed = parseXml(text);
  // return_code 是通信层结果，result_code 才是业务结果——两个都要看，
  // 只看一个会出现"通信成功但下单失败"被当成成功。
  if (parsed.return_code !== "SUCCESS") {
    return { ok: false, error: `微信通信失败：${parsed.return_msg || "无返回信息"}` };
  }
  if (parsed.result_code !== "SUCCESS") {
    return { ok: false, error: `微信下单失败 ${parsed.err_code ?? ""}：${parsed.err_code_des ?? "无描述"}` };
  }
  if (!parsed.code_url) return { ok: false, error: "微信没返回 code_url，无法生成二维码" };
  return { ok: true, codeUrl: parsed.code_url, prepayId: parsed.prepay_id };
}

export type QueryResult =
  | { ok: true; tradeState: TradeState; transactionId?: string; paidAt?: string }
  | { ok: false; error: string };

/**
 * 查单。前端轮询用，也用于"回调迟迟不来"时兜底确认。
 *
 * 注意：**只有 trade_state=SUCCESS 才算支付成功**。NOTPAY 表示用户还没付，
 * 不能因为接口调通了就当付过。
 */
export async function queryOrder(
  config: WechatPayConfig,
  outTradeNo: string,
): Promise<QueryResult> {
  const params: Record<string, string | number> = {
    appid: config.appId,
    mch_id: config.mchId,
    out_trade_no: outTradeNo,
    nonce_str: nonce(),
  };
  params.sign = signMd5(params, config.apiKey);

  let text = "";
  try {
    const response = await fetch(ORDER_QUERY_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: toXml(params),
      signal: AbortSignal.timeout(15_000),
    });
    text = await response.text();
  } catch (error) {
    return { ok: false, error: `查询微信订单失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const parsed = parseXml(text);
  if (parsed.return_code !== "SUCCESS") {
    return { ok: false, error: `微信通信失败：${parsed.return_msg || "无返回信息"}` };
  }
  if (parsed.result_code !== "SUCCESS") {
    return { ok: false, error: `查单失败 ${parsed.err_code ?? ""}：${parsed.err_code_des ?? "无描述"}` };
  }
  const tradeState = (parsed.trade_state ?? "UNKNOWN") as TradeState;
  return {
    ok: true,
    tradeState,
    transactionId: parsed.transaction_id,
    paidAt: parsed.time_end,
  };
}

/** 回给微信的应答。必须回 SUCCESS，否则微信会一直重发回调（最多 15 次）。 */
export const WECHAT_SUCCESS_XML = "<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>";
export const WECHAT_FAIL_XML = "<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[处理失败]]></return_msg></xml>";
