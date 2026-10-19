/**
 * 账号：注册 / 登录 / 登出 / 当前用户。
 *
 * 邮箱 + 验证码 + 密码（2026-10-17 调整）。注册前必须收取并验证邮箱验证码，
 * 因此一个邮箱只会由其实际持有人创建。验证码是一次性的，十分钟过期，重发间隔一分钟。
 *
 * 注册验证和忘记密码共用一次性验证码的安全机制，但验证码按用途隔离：
 * 注册码绝不能用来修改已有账号的密码。
 *
 * 安全上刻意注意的几处：
 *   - 注册和登录的失败提示**统一措辞**，不区分"邮箱没注册"和"密码不对"，
 *     否则这个接口就成了一个查询谁注册过的工具（账号枚举）。
 *   - 登录失败按邮箱限速，防止在线暴力猜密码。
 *   - 会话 cookie 是 httpOnly（JS 读不到，防 XSS 偷令牌）+ sameSite=lax（防 CSRF）
 *     + secure（只走 HTTPS，站点已经配了证书）。
 *   - **任何分支都不把密码写进日志**，连长度都不记。
 */
import { createHmac, randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import {
  createSessionToken,
  hashPassword,
  normalizeEmail,
  validatePassword,
  verifyPassword,
} from "../../../lib/server/password";
import {
  createSession,
  createUser,
  deleteSession,
  findUserByEmail,
  findUserBySessionToken,
  resetUserPassword,
  SESSION_TTL_DAYS,
} from "../../../lib/server/user-store";
import { currentYearMonth, PLAN_LABEL, quotaViewOf } from "../../../lib/server/plan-quota";
import { membershipViewOf, syncPlanWithMembership } from "../../../lib/server/membership-store";
import {
  consumeRegistrationCode,
  discardReservedRegistrationCode,
  markRegistrationCodeSent,
  reserveRegistrationCode,
  type VerificationPurpose,
} from "../../../lib/server/registration-verification-store";
import {
  sendTemplateEmail,
  sesRegistrationConfigFromEnv,
} from "../../../lib/server/ses-mailer";

export const SESSION_COOKIE = "ic_session";

/** 登录失败限速：同一个邮箱连续失败到这个次数后，锁一段时间。 */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000;

/*
 * 失败计数放在进程内存里。**它的局限要说清楚**：重启服务器就清零，
 * 多实例部署时各算各的。对当前单机部署够用；真正要防的是撞库和分布式爆破，
 * 那需要 IP 级限速和验证码，等有真实攻击流量时再上。
 */
const failedAttempts = new Map<string, { count: number; firstFailedAt: number }>();
const REGISTRATION_CODE_PATTERN = /^\d{6}$/;

/**
 * 生产环境使用独立密钥；未设置时退回 SES 密钥（两者都在服务器环境变量，外部不可读）。
 * 测试模式才允许使用固定密钥和固定验证码，避免测试过程真的向任何邮箱发信。
 */
function registrationVerificationSecret(): string | undefined {
  const configured = process.env.AUTH_VERIFICATION_SECRET?.trim() || process.env.TENCENT_SECRET_KEY?.trim();
  if (configured) return configured;
  if (isRegistrationVerificationTestMode()) {
    return "india-compliance-test-verification-secret";
  }
  return undefined;
}

function isRegistrationVerificationTestMode(): boolean {
  return process.env.AUTH_VERIFICATION_TEST_MODE === "1"
    && REGISTRATION_CODE_PATTERN.test(process.env.AUTH_VERIFICATION_TEST_CODE ?? "");
}

function hashRegistrationCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(code, "utf8").digest("hex");
}

function newRegistrationCode(): string {
  const testCode = process.env.AUTH_VERIFICATION_TEST_CODE;
  if (isRegistrationVerificationTestMode() && testCode) return testCode;
  return String(randomInt(100_000, 1_000_000));
}

async function sendVerificationCodeEmail(email: string, code: string, purpose: VerificationPurpose) {
  // 测试构建才会注入此开关；生产 .env.local 不包含它，也没有任何接口可以开启它。
  if (isRegistrationVerificationTestMode()) {
    return { ok: true } as const;
  }
  // 注册与重置密码共用同一份「账号安全验证码」模板；验证码本身仍按用途隔离。
  const config = sesRegistrationConfigFromEnv();
  if (!config) return { ok: false, error: "not_configured" } as const;
  return sendTemplateEmail(config, {
    to: email,
    subject: purpose === "PASSWORD_RESET" ? "【印度合规助手】重置密码验证码" : "【印度合规助手】注册验证码",
    templateData: { code, minutes: "10" },
  });
}

function isLockedOut(email: string): boolean {
  const record = failedAttempts.get(email);
  if (!record) return false;
  if (Date.now() - record.firstFailedAt > LOCKOUT_MS) {
    failedAttempts.delete(email);
    return false;
  }
  return record.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(email: string) {
  const record = failedAttempts.get(email);
  if (!record || Date.now() - record.firstFailedAt > LOCKOUT_MS) {
    failedAttempts.set(email, { count: 1, firstFailedAt: Date.now() });
    return;
  }
  record.count += 1;
}

function readSessionToken(request: Request): string {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  // Secure 在本地 http://localhost 开发时会让 cookie 存不下，所以按环境决定。
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

/**
 * 返回给前端的账号信息。
 *
 * 这里也要走一次会员同步，否则会出现"会员昨天到期了，界面上还写着专业版"——
 * 用户以为自己能用，一问才发现额度只有 3 次。界面上的套餐必须和真实权限同源。
 */
async function userPayload(user: Awaited<ReturnType<typeof findUserByEmail>>) {
  if (!user) return null;
  const synced = await syncPlanWithMembership(user);
  const membership = await membershipViewOf(synced.id);
  return {
    email: synced.email,
    plan: synced.plan,
    plan_label: PLAN_LABEL[synced.plan],
    quota: quotaViewOf(synced),
    membership: {
      active: membership.active,
      paidThrough: membership.paidThrough ?? null,
      daysLeft: membership.daysLeft,
    },
  };
}

/** GET /api/auth —— 当前登录的是谁。没登录返回 user: null，不是错误。 */
export async function GET(request: Request) {
  const user = await findUserBySessionToken(readSessionToken(request));
  return NextResponse.json({ user: await userPayload(user) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let payload: {
    action?: string;
    email?: string;
    password?: string;
    passwordConfirmation?: string;
    verificationCode?: string;
  };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ message: "请求格式无效。" }, { status: 400 });
  }

  const action = payload.action;

  if (action === "logout") {
    await deleteSession(readSessionToken(request));
    return NextResponse.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
  }

  const email = normalizeEmail(payload.email ?? "");
  const password = payload.password ?? "";
  if (!email) return NextResponse.json({ message: "请填写正确的邮箱地址。" }, { status: 400 });

  if (action === "send_registration_code") {
    // 注册页可以明说已注册，避免用户傻等验证码后才发现应该去登录。
    if (await findUserByEmail(email)) {
      return NextResponse.json({ message: "这个邮箱已经注册过了，直接登录即可。" }, { status: 409 });
    }
    const secret = registrationVerificationSecret();
    if (!secret) {
      return NextResponse.json({ message: "验证码邮件暂时不可用，请稍后再试。" }, { status: 503 });
    }
    const code = newRegistrationCode();
    const reservation = await reserveRegistrationCode({
      email,
      purpose: "REGISTRATION",
      codeHash: hashRegistrationCode(code, secret),
    });
    if (!reservation.ok) {
      return NextResponse.json(
        { message: `验证码已发送，请 ${reservation.retryAfterSeconds} 秒后再试。`, retry_after_seconds: reservation.retryAfterSeconds },
        { status: 429 },
      );
    }
    const sent = await sendVerificationCodeEmail(email, code, "REGISTRATION");
    if (!sent.ok) {
      await discardReservedRegistrationCode(email, "REGISTRATION", reservation.deliveryId);
      // 只记录供应商错误码，不记录邮箱、验证码或任何密码；访客页面不应看到云服务内部细节。
      console.error(`[auth] registration verification email failed: ${sent.error}`);
      return NextResponse.json({ message: "验证码邮件暂时发送失败，请稍后再试。" }, { status: 503 });
    }
    const marked = await markRegistrationCodeSent(email, "REGISTRATION", reservation.deliveryId);
    if (!marked) {
      return NextResponse.json({ message: "验证码邮件状态确认失败，请稍后重新发送。" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, expires_in_seconds: 10 * 60, resend_after_seconds: 60 });
  }

  if (action === "send_password_reset_code") {
    const secret = registrationVerificationSecret();
    if (!secret) {
      return NextResponse.json({ message: "验证码邮件暂时不可用，请稍后再试。" }, { status: 503 });
    }

    // 忘记密码时不能告诉访客「这个邮箱是否注册过」，否则接口可被用来枚举账号。
    // 对未知邮箱仍返回相同成功提示，但不会真的发信。
    const user = await findUserByEmail(email);
    if (!user) {
      return NextResponse.json({ ok: true, expires_in_seconds: 10 * 60, resend_after_seconds: 60 });
    }

    const code = newRegistrationCode();
    const reservation = await reserveRegistrationCode({
      email,
      purpose: "PASSWORD_RESET",
      codeHash: hashRegistrationCode(code, secret),
    });
    if (!reservation.ok) {
      return NextResponse.json(
        { message: `验证码已发送，请 ${reservation.retryAfterSeconds} 秒后再试。`, retry_after_seconds: reservation.retryAfterSeconds },
        { status: 429 },
      );
    }
    const sent = await sendVerificationCodeEmail(email, code, "PASSWORD_RESET");
    if (!sent.ok) {
      await discardReservedRegistrationCode(email, "PASSWORD_RESET", reservation.deliveryId);
      console.error(`[auth] password reset verification email failed: ${sent.error}`);
      return NextResponse.json({ message: "验证码邮件暂时发送失败，请稍后再试。" }, { status: 503 });
    }
    const marked = await markRegistrationCodeSent(email, "PASSWORD_RESET", reservation.deliveryId);
    if (!marked) {
      return NextResponse.json({ message: "验证码邮件状态确认失败，请稍后重新发送。" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, expires_in_seconds: 10 * 60, resend_after_seconds: 60 });
  }

  if (action === "register") {
    const passwordProblem = validatePassword(password);
    if (passwordProblem) return NextResponse.json({ message: passwordProblem }, { status: 400 });
    if (password !== (payload.passwordConfirmation ?? "")) {
      return NextResponse.json({ message: "两次输入的密码不一致。" }, { status: 400 });
    }
    const verificationCode = payload.verificationCode?.trim() ?? "";
    if (!REGISTRATION_CODE_PATTERN.test(verificationCode)) {
      return NextResponse.json({ message: "请输入邮箱里收到的 6 位验证码。" }, { status: 400 });
    }
    if (await findUserByEmail(email)) {
      return NextResponse.json({ message: "这个邮箱已经注册过了，直接登录即可。" }, { status: 409 });
    }
    const secret = registrationVerificationSecret();
    if (!secret) return NextResponse.json({ message: "验证码服务暂时不可用，请稍后再试。" }, { status: 503 });
    const codeResult = await consumeRegistrationCode({
      email,
      purpose: "REGISTRATION",
      codeHash: hashRegistrationCode(verificationCode, secret),
    });
    if (codeResult !== "VALID") {
      const message = codeResult === "WRONG"
        ? "验证码不正确，请重新输入。"
        : codeResult === "TOO_MANY_ATTEMPTS"
          ? "验证码尝试次数过多，请重新发送。"
          : codeResult === "NOT_DELIVERED"
            ? "验证码正在发送，请稍等后再试。"
            : "验证码已过期或不存在，请重新发送。";
      return NextResponse.json({ message }, { status: 400 });
    }

    const user = await createUser({
      email,
      passwordHash: await hashPassword(password),
      yearMonth: currentYearMonth(),
    });
    if (!user) {
      // 邮箱已存在。这里可以明说——注册场景下用户本来就需要知道"换一个邮箱或去登录"，
      // 藏着反而没法用。真正要防账号枚举的是**登录**那条路。
      return NextResponse.json({ message: "这个邮箱已经注册过了，直接登录即可。" }, { status: 409 });
    }

    const token = createSessionToken();
    await createSession(user.id, token);
    return NextResponse.json({ user: await userPayload(user) }, {
      headers: { "Set-Cookie": sessionCookie(token, SESSION_TTL_DAYS * 24 * 60 * 60) },
    });
  }

  if (action === "reset_password") {
    const passwordProblem = validatePassword(password);
    if (passwordProblem) return NextResponse.json({ message: passwordProblem }, { status: 400 });
    if (password !== (payload.passwordConfirmation ?? "")) {
      return NextResponse.json({ message: "两次输入的密码不一致。" }, { status: 400 });
    }
    const verificationCode = payload.verificationCode?.trim() ?? "";
    if (!REGISTRATION_CODE_PATTERN.test(verificationCode)) {
      return NextResponse.json({ message: "请输入邮箱里收到的 6 位验证码。" }, { status: 400 });
    }
    const secret = registrationVerificationSecret();
    if (!secret) return NextResponse.json({ message: "验证码服务暂时不可用，请稍后再试。" }, { status: 503 });
    const codeResult = await consumeRegistrationCode({
      email,
      purpose: "PASSWORD_RESET",
      codeHash: hashRegistrationCode(verificationCode, secret),
    });
    if (codeResult !== "VALID") {
      const message = codeResult === "WRONG"
        ? "验证码不正确，请重新输入。"
        : codeResult === "TOO_MANY_ATTEMPTS"
          ? "验证码尝试次数过多，请重新发送。"
          : codeResult === "NOT_DELIVERED"
            ? "验证码正在发送，请稍等后再试。"
            : "验证码已过期或不可用，请重新发送。";
      return NextResponse.json({ message }, { status: 400 });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      // 不泄露账号是否存在；验证码已一次性作废，访客只能重新走标准流程。
      return NextResponse.json({ message: "验证码已过期或不可用，请重新发送。" }, { status: 400 });
    }
    const reset = await resetUserPassword(user.id, await hashPassword(password));
    if (!reset) return NextResponse.json({ message: "重置密码失败，请稍后再试。" }, { status: 503 });

    const token = createSessionToken();
    await createSession(reset.id, token);
    return NextResponse.json({ user: await userPayload(reset) }, {
      headers: { "Set-Cookie": sessionCookie(token, SESSION_TTL_DAYS * 24 * 60 * 60) },
    });
  }

  if (action === "login") {
    if (isLockedOut(email)) {
      return NextResponse.json(
        { message: "登录失败次数过多，请10分钟后再试。" },
        { status: 429 },
      );
    }

    const user = await findUserByEmail(email);
    // ⚠注意这里的写法：**先查用户、再验密码，两条失败路径给完全一样的提示**。
    // 如果分开提示（"该邮箱未注册" / "密码错误"），任何人都能拿这个接口
    // 批量测试哪些邮箱在这里注册过。
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) {
      recordFailure(email);
      return NextResponse.json({ message: "邮箱或密码不对。" }, { status: 401 });
    }

    failedAttempts.delete(email);
    const token = createSessionToken();
    await createSession(user.id, token);
    return NextResponse.json({ user: await userPayload(user) }, {
      headers: { "Set-Cookie": sessionCookie(token, SESSION_TTL_DAYS * 24 * 60 * 60) },
    });
  }

  return NextResponse.json({ message: "不支持的操作。" }, { status: 400 });
}
