/**
 * 密码哈希与会话令牌。
 *
 * 用 Node 自带的 `crypto.scrypt`，**不引入任何新依赖**——bcrypt/argon2 都要编译原生模块，
 * 这个项目在依赖安装上已经踩过坑（见操作手册第0步：npm装依赖会直接崩），
 * 不值得为了密码哈希再冒一次风险。scrypt 是内存困难函数，是密码存储的正经选择，
 * 不是 MD5/SHA 那种一秒能算几亿次的普通摘要。
 *
 * 几条不能省的纪律：
 *   1. **绝不存明文密码**，也绝不把密码写进任何日志。
 *   2. 每个用户一个随机 salt，避免同样的密码算出同样的哈希（彩虹表）。
 *   3. 比对用 `timingSafeEqual`，不用 `===`——后者的比较耗时和匹配了多少字节有关，
 *      理论上能被用来逐字节猜测。
 *   4. 哈希串里带上算法和参数，将来要升级强度时能识别老记录、在用户下次登录时静默升级。
 *
 * 会话令牌同理：发给浏览器的是随机原文，**存储里只留它的 SHA-256**。
 * 这样即使存储文件泄露，拿到的也是一堆没法直接用来冒充登录的哈希。
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/*
 * 自己包一层 Promise 而不用 util.promisify：promisify 会挑中不带 options 的那个重载，
 * 于是传 { N, r, p } 会被 TypeScript 判成"多传了一个参数"。参数必须能传，
 * 否则就退化成 Node 的默认强度（N=16384 恰好是默认值，但 r/p 和将来调参都依赖它）。
 */
function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/** scrypt 参数。N 越大越慢越安全；16384 在服务器上约几十毫秒，是常见取值。 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** 密码最短长度。太短的密码再好的哈希也救不了。 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * 密码是否可用。返回错误原因（中文）或 undefined。
 * 纯函数，导出供单测和前端复用同一套口径——避免"前端说可以、后端说不行"。
 */
export function validatePassword(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 位。`;
  if (password.length > 200) return "密码太长了。";
  // 只有一种字符类型的密码（纯数字、纯字母）太容易被猜到。
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((pattern) => pattern.test(password)).length;
  if (classes < 2) return "密码需要同时包含字母和数字（或符号）。";
  return undefined;
}

/** 邮箱是否像个邮箱。刻意宽松——真正的验证只能靠发信，而现在还没有邮件服务。 */
export function normalizeEmail(email: string): string | undefined {
  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) || trimmed.length > 254) return undefined;
  return trimmed;
}

/** 算出可以直接落盘的哈希串：`scrypt$N$r$p$saltHex$hashHex`。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * 校验密码。任何解析失败一律返回 false，**不抛异常**——
 * 存储里有一条坏记录不应该让整个登录接口崩掉，也不应该把细节漏给调用方。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltHex, hashHex] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const expected = Buffer.from(hashHex, "hex");
    if (expected.length !== KEY_LENGTH) return false;
    const key = await scrypt(password, Buffer.from(saltHex, "hex"), KEY_LENGTH, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** 发给浏览器的会话令牌原文。只在登录那一刻出现一次，服务端不保存它。 */
export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 落盘用的令牌指纹。存储里只有这个，拿不回原文。 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
