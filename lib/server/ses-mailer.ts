/**
 * 腾讯云 SES 发信（2026-09-30 建）。
 *
 * ## 为什么自己写签名，不装官方 SDK
 *
 * 项目依赖里只有 OCR 的 tencentcloud-sdk-nodejs-ocr，没有 SES 的。
 * 为一个接口再引入一个 SDK，意味着服务器每次 `pnpm install` 要多装几十个包，
 * 而 TC3-HMAC-SHA256 签名是公开且固定的几步 HMAC，Node 内置 crypto 就能算完。
 * **少一个依赖就少一个"服务器装不上"的可能**——部署脚本已经因为环境问题栽过好几次。
 *
 * ## 签名与接口要点（照腾讯云 API 3.0 文档实现）
 *
 * - endpoint：`ses.tencentcloudapi.com`（国内站）
 * - Action：`SendEmail`，Version：`2020-10-02`
 * - 模板发信：`Template: { TemplateID, TemplateData }`，TemplateData 是 **JSON 字符串**
 * - region 必须与控制台开的地域一致（用户开的是广州 `ap-guangzhou`）
 * - 规范请求里 canonical headers 只有 `content-type` 和 `host`，顺序固定
 */
import { createHash, createHmac } from "node:crypto";

const ENDPOINT_HOST = "ses.tencentcloudapi.com";
const SERVICE = "ses";
const API_VERSION = "2020-10-02";
const ACTION = "SendEmail";
/** 规范请求里参与签名的 header，顺序和大小写都不能变。 */
const SIGNED_HEADERS = "content-type;host";
const CONTENT_TYPE = "application/json; charset=utf-8";

/** 发信所需的共同配置；验证码可直接发纯文本，不应绑死在提醒邮件模板上。 */
export interface SesSenderConfig {
  secretId: string;
  secretKey: string;
  /** 发信地址，必须是 SES 里已验证过的发信地址。 */
  fromEmail: string;
  /** 发信人别名，会显示在收件箱发件人位置。不能含冒号。 */
  fromName: string;
  region: string;
}

export interface SesConfig extends SesSenderConfig {
  /** 审核通过的邮件模板 ID（数字）。 */
  templateId: number;
}

/**
 * 从环境变量组装配置。缺任何一项都返回 null——
 * **没有配置时发信功能整体不可用，而不是拿半套配置去调接口调出一堆看不懂的错。**
 */
export function sesSenderConfigFromEnv(): SesSenderConfig | null {
  const secretId = process.env.TENCENT_SECRET_ID?.trim();
  const secretKey = process.env.TENCENT_SECRET_KEY?.trim();
  if (!secretId || !secretKey) return null;
  return {
    secretId,
    secretKey,
    fromEmail: process.env.REMINDER_FROM_EMAIL?.trim() || "noreply@indiacompliance.cn",
    fromName: process.env.REMINDER_FROM_NAME?.trim() || "印度合规助手",
    region: process.env.TENCENT_SES_REGION?.trim() || "ap-guangzhou",
  };
}

export function sesConfigFromEnv(): SesConfig | null {
  const sender = sesSenderConfigFromEnv();
  const templateId = Number.parseInt(process.env.TENCENT_SES_TEMPLATE_ID?.trim() ?? "", 10);
  if (!sender || !Number.isFinite(templateId) || templateId <= 0) return null;
  return { ...sender, templateId };
}

/**
 * 会员到期提醒用的配置。
 *
 * 和上面那份是同一套密钥，只是**允许换一个模板 ID**
 * （`TENCENT_SES_MEMBERSHIP_TEMPLATE_ID`）。没配就用提醒那套模板——
 * 两套模板的变量名故意做得一样（title / deadline / daysLeft / detail），
 * 所以代码里不用分支拼不同的变量，换模板只是换一个数字。
 */
export function sesMembershipConfigFromEnv(): SesConfig | null {
  const base = sesConfigFromEnv();
  if (!base) return null;
  const override = Number.parseInt(process.env.TENCENT_SES_MEMBERSHIP_TEMPLATE_ID?.trim() ?? "", 10);
  if (!Number.isFinite(override) || override <= 0) return base;
  return { ...base, templateId: override };
}

/**
 * 注册验证码是安全邮件，必须使用独立模板。不能复用「截止日提醒」：变量和文案都不同，
 * 更不能依赖 SES 帐号是否单独开通了 Simple 直发权限。
 */
export function sesRegistrationConfigFromEnv(): SesConfig | null {
  const sender = sesSenderConfigFromEnv();
  const templateId = Number.parseInt(process.env.TENCENT_SES_REGISTRATION_TEMPLATE_ID?.trim() ?? "", 10);
  if (!sender || !Number.isFinite(templateId) || templateId <= 0) return null;
  return { ...sender, templateId };
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function hmacSha256(key: Buffer | string, payload: string): Buffer {
  return createHmac("sha256", key).update(payload, "utf8").digest();
}

/**
 * 腾讯云 SES 对带别名的发件人地址要求严格使用 `显示名 <邮箱>`。
 * 之前少了尖括号，部分账号会被 SendEmail 直接拒绝；这里集中格式化，模板邮件和
 * 未来的其他事务邮件不会再次各自拼出不同格式。
 */
export function senderAddress(config: Pick<SesSenderConfig, "fromName" | "fromEmail">): string {
  const email = config.fromEmail.trim();
  const name = config.fromName.trim();
  if (!name || /<[^>]+>$/.test(email)) return email;
  return `${name} <${email}>`;
}

/**
 * TC3-HMAC-SHA256 签名。
 * 步骤：规范请求串 → 待签串 → 用密钥派生出的 signing key 做 HMAC → 拼 Authorization。
 */
function buildAuthorization(config: SesSenderConfig, payload: string, timestamp: number): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalRequest = [
    "POST",
    "/",
    "",
    `content-type:${CONTENT_TYPE}\nhost:${ENDPOINT_HOST}\n`,
    SIGNED_HEADERS,
    sha256Hex(payload),
  ].join("\n");

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const secretDate = hmacSha256(`TC3${config.secretKey}`, date);
  const secretService = hmacSha256(secretDate, SERVICE);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = hmacSha256(secretSigning, stringToSign).toString("hex");

  return `TC3-HMAC-SHA256 Credential=${config.secretId}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;
}

export interface SendTemplateEmailInput {
  to: string;
  subject: string;
  /** 模板变量。键名对应模板里的 {{key}}，值一律转成字符串。 */
  templateData: Record<string, string>;
}

export type SendTemplateEmailResult =
  | { ok: true; messageId?: string }
  | { ok: false; error: string };

async function sendEmailPayload(config: SesSenderConfig, payload: string): Promise<SendTemplateEmailResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  let response: Response;
  let text = "";
  try {
    response = await fetch(`https://${ENDPOINT_HOST}/`, {
      method: "POST",
      headers: {
        "Content-Type": CONTENT_TYPE,
        Host: ENDPOINT_HOST,
        "X-TC-Action": ACTION,
        "X-TC-Version": API_VERSION,
        "X-TC-Region": config.region,
        "X-TC-Timestamp": String(timestamp),
        Authorization: buildAuthorization(config, payload, timestamp),
      },
      body: payload,
      signal: AbortSignal.timeout(15_000),
    });
    text = await response.text();
  } catch (error) {
    // 网络层失败要带上原因：签名错、密钥错、超时，排查时第一眼就要看得出是哪一类。
    return { ok: false, error: `调用 SES 失败：${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: { Response?: { Error?: { Code?: string; Message?: string }; MessageId?: string } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { ok: false, error: `SES 返回无法解析（HTTP ${response.status}）：${text.slice(0, 200)}` };
  }

  const apiError = parsed.Response?.Error;
  if (apiError) return { ok: false, error: `SES ${apiError.Code ?? "Error"}：${apiError.Message ?? "未知错误"}` };
  if (!response.ok) return { ok: false, error: `SES HTTP ${response.status}：${text.slice(0, 200)}` };
  return { ok: true, messageId: parsed.Response?.MessageId };
}

/**
 * 用模板发一封邮件。
 *
 * `TriggerType: 1`＝触发类即时邮件。提醒邮件必须按时到，
 * 不能走营销类的慢通道（默认 0 是非触发类）。
 */
export async function sendTemplateEmail(
  config: SesConfig,
  input: SendTemplateEmailInput,
): Promise<SendTemplateEmailResult> {
  const payload = JSON.stringify({
    FromEmailAddress: senderAddress(config),
    Destination: [input.to],
    Subject: input.subject,
    Template: {
      TemplateID: config.templateId,
      TemplateData: JSON.stringify(input.templateData),
    },
    TriggerType: 1,
  });
  return sendEmailPayload(config, payload);
}
