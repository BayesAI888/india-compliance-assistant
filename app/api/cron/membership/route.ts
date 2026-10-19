import { NextResponse } from "next/server";
import {
  claimDueRenewalNotices,
  PLAN_OPTIONS,
  markRenewalNoticeSent,
  rollbackRenewalNotice,
} from "../../../../lib/server/membership-store";
import { sendTemplateEmail, sesMembershipConfigFromEnv } from "../../../../lib/server/ses-mailer";

/**
 * 会员到期续费提醒（2026-10-12 建）。
 *
 * ## 为什么是"发邮件提醒"而不是"自动扣款"
 *
 * 自动续费要多申请一层产品权限（微信委托代扣、支付宝商家扣款各审一次），
 * 还要做扣款前 24 小时通知、扣款调度、失败重试停扣、显著解约入口，
 * 而小额订阅最容易招来"怎么又扣我钱"的投诉。改成买时长之后，
 * 续费这一步由**用户自己点**——本端点只负责在到期前把话带到。
 *
 * ## 调度
 *
 * 由 crontab 每天一次调 `scripts/send-membership-notices.mjs`，脚本再打这个接口。
 * 一天一次够了（提醒档位是 7 天 / 3 天，不是按小时算的），
 * 和合规提醒那条每 5 分钟的 cron 分开，**互不拖累**：邮件通道出问题也只影响一类。
 *
 * ## 鉴权
 *
 * 必须配 `CRON_TOKEN`，请求头带 `x-cron-token`。**没配就整体不可用（503）**——
 * 默认拒绝，而不是"没配 token 谁都能打"。公网任何人打这个接口＝能触发发信。
 */

/** 北京时间。到期时间是 UTC 瞬间，但给用户看要落在他熟悉的时区里。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatBeijingDate(iso: string): string {
  const beijing = new Date(new Date(iso).getTime() + BEIJING_OFFSET_MS);
  return `${beijing.getUTCFullYear()}年${beijing.getUTCMonth() + 1}月${beijing.getUTCDate()}日`;
}

function siteHost(): string {
  const raw = process.env.SITE_HOST?.trim() || "indiacompliance.cn";
  return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** 续费档位的一句话说明。价格只从 PLAN_OPTIONS 出，不在这里另写一份。 */
function planSummary(): string {
  return PLAN_OPTIONS.map((option) => `${option.label} ${(option.priceFen / 100).toFixed(2)} 元`).join(" / ");
}

export async function POST(request: Request) {
  const expected = process.env.CRON_TOKEN?.trim();
  if (!expected) {
    return NextResponse.json(
      { error: "CRON_TOKEN_NOT_CONFIGURED", message: "服务器未配置 CRON_TOKEN，续费提醒端点已停用。" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if ((request.headers.get("x-cron-token") ?? "").trim() !== expected) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const config = sesMembershipConfigFromEnv();
  if (!config) {
    return NextResponse.json(
      {
        error: "SES_NOT_CONFIGURED",
        message: "缺少 TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_SES_TEMPLATE_ID，无法发信。",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const due = await claimDueRenewalNotices();
  const host = siteHost();

  let sent = 0;
  let failed = 0;
  const failures: Array<{ userId: string; error: string }> = [];

  for (const notice of due) {
    const expireText = formatBeijingDate(notice.paidThrough);
    const result = await sendTemplateEmail(config, {
      to: notice.email,
      subject: `您的印度合规助手专业版将在 ${expireText} 到期（还剩 ${notice.daysLeft} 天）`,
      templateData: {
        title: "印度合规助手·专业版会员",
        deadline: `${expireText}（北京时间）`,
        daysLeft: String(notice.daysLeft),
        detail:
          `您的专业版会员有效期到 ${expireText}（北京时间）为止，还剩 ${notice.daysLeft} 天。`
          + `到期后账号将自动转为免费版（每日提问额度与专业版不同），已保存的对话和资料不会丢失。`
          + `如需继续使用专业版，登录后打开「我的 → 会员」即可续费：${planSummary()}。`
          + `会员时长从当前有效期往后叠加，提前续费不会浪费已购天数。`
          + `（续费入口：https://${host} ）`,
      },
    });

    if (result.ok) {
      await markRenewalNoticeSent(notice.userId);
      sent += 1;
    } else {
      // 撤掉占位＝明天这一档会重新扫到并重试；连续失败到上限后自动停手。
      await rollbackRenewalNotice(notice.userId, result.error);
      failed += 1;
      failures.push({ userId: notice.userId, error: result.error });
      console.error(`[membership] 续费提醒发信失败 ${notice.userId} → ${notice.email}：${result.error}`);
    }
  }

  return NextResponse.json(
    { scanned: due.length, sent, failed, failures },
    { headers: { "Cache-Control": "no-store" } },
  );
}
