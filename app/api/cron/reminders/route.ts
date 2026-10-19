import { NextResponse } from "next/server";
import {
  claimDueReminders,
  markReminderFailed,
  markReminderSent,
} from "../../../../lib/server/reminder-store";
import { sendTemplateEmail, sesConfigFromEnv } from "../../../../lib/server/ses-mailer";

/**
 * 定时发信端点（2026-09-30 建）。
 *
 * 由服务器上的 crontab 每 5 分钟调 `scripts/send-due-reminders.mjs`，
 * 脚本再打这个接口。真正的发信逻辑全在这一层（TS 侧），脚本只管"到点戳一下"。
 *
 * ## 为什么不在应用进程里挂 setInterval
 *
 * `pm2 restart` / 每次部署都会把进程内定时器一起重置，而"该发没发"是**静默失败**——
 * 没有人会收到报错，用户只是没收到邮件，等他发现时截止日已经过了。
 * crontab 独立于应用进程：重启、部署都不影响调度，错过窗口下次扫到照样补发。
 *
 * ## 鉴权
 *
 * 必须配 `CRON_TOKEN`，请求头带 `x-cron-token`。**没配就整体不可用（503）**——
 * 默认拒绝，而不是"没配 token 谁都能打"。公网任何人打这个接口＝能触发发信。
 */

/** 印度时间没有夏令时，+05:30 固定。展示给用户看"印度当地哪天截止"。 */
const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function formatIndiaDeadline(deadlineIso: string): string {
  const ist = new Date(new Date(deadlineIso).getTime() + INDIA_OFFSET_MS);
  return `${ist.getUTCFullYear()}年${ist.getUTCMonth() + 1}月${ist.getUTCDate()}日`;
}

function daysLeftFrom(deadlineIso: string, nowMs: number): number {
  const remaining = new Date(deadlineIso).getTime() - nowMs;
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}

export async function POST(request: Request) {
  const expected = process.env.CRON_TOKEN?.trim();
  if (!expected) {
    return NextResponse.json(
      { error: "CRON_TOKEN_NOT_CONFIGURED", message: "服务器未配置 CRON_TOKEN，定时发信端点已停用。" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if ((request.headers.get("x-cron-token") ?? "").trim() !== expected) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const config = sesConfigFromEnv();
  if (!config) {
    return NextResponse.json(
      {
        error: "SES_NOT_CONFIGURED",
        message: "缺少 TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_SES_TEMPLATE_ID，无法发信。",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const due = await claimDueReminders();
  const nowMs = Date.now();

  let sent = 0;
  let failed = 0;
  const failures: Array<{ id: string; error: string }> = [];

  for (const reminder of due) {
    const deadlineText = formatIndiaDeadline(reminder.deadlineAt);
    const result = await sendTemplateEmail(config, {
      to: reminder.email,
      subject: `合规提醒：${reminder.title} 将于 ${deadlineText} 截止`,
      templateData: {
        title: reminder.title,
        deadline: `${deadlineText}（印度时间）`,
        daysLeft: String(daysLeftFrom(reminder.deadlineAt, nowMs)),
        detail: reminder.detail || "这条提醒是您在印度合规助手设置的，如需调整请登录站内「合规提醒」修改。",
      },
    });

    if (result.ok) {
      await markReminderSent(reminder.id);
      sent += 1;
    } else {
      await markReminderFailed(reminder.id, result.error);
      failed += 1;
      failures.push({ id: reminder.id, error: result.error });
      // 打印出来：pm2 logs 里要能直接看到失败原因，不然只能靠猜。
      console.error(`[reminders] 发信失败 ${reminder.id} → ${reminder.email}：${result.error}`);
    }
  }

  return NextResponse.json(
    { scanned: due.length, sent, failed, failures },
    { headers: { "Cache-Control": "no-store" } },
  );
}
