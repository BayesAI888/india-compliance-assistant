/**
 * 账号邮箱验证码的服务端状态。
 *
 * 验证码不能放在浏览器、cookie 或日志里：浏览器可被篡改，cookie 会被用户复制，日志又会
 * 把一次性凭证变成长期凭证。这里仅保存验证码的 HMAC 指纹，并以 0600 文件权限落盘。
 *
 * 当前部署是单机 JSON store，沿用 user-store 的串行写入模式；这样 pm2 重启后验证码还在，
 * 不会发生「邮箱已收到码，服务器刚好重启就永远无法注册」的情况。
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000;
export const REGISTRATION_CODE_RESEND_MS = 60 * 1000;
export const REGISTRATION_CODE_MAX_ATTEMPTS = 5;

export type VerificationPurpose = "REGISTRATION" | "PASSWORD_RESET";

interface RegistrationVerification {
  email: string;
  /** 注册和重置密码的验证码必须隔离，不能拿注册验证码去改已有账号的密码。 */
  purpose: VerificationPurpose;
  /** HMAC-SHA-256 指纹，绝不保存六位验证码原文。 */
  codeHash: string;
  /** 发送流程的内部凭证；仅用于把「已请求」和「已送入 SES」绑定起来。 */
  deliveryId: string;
  deliveryState: "PENDING" | "SENT";
  sentAt: string;
  expiresAt: string;
  attempts: number;
}

interface RegistrationVerificationFile {
  schemaVersion: "1.0";
  verifications: RegistrationVerification[];
}

const dataDirectory = process.env.LOCAL_USER_DIR?.trim()
  || process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "registration-verification-store.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): RegistrationVerificationFile {
  return { schemaVersion: "1.0", verifications: [] };
}

function isRecord(value: unknown): value is RegistrationVerification {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RegistrationVerification>;
  return typeof item.email === "string"
    // 旧版注册记录没有 purpose；读取时会安全地迁移为 REGISTRATION。
    && (item.purpose === undefined || item.purpose === "REGISTRATION" || item.purpose === "PASSWORD_RESET")
    && typeof item.codeHash === "string"
    && typeof item.deliveryId === "string"
    && (item.deliveryState === "PENDING" || item.deliveryState === "SENT")
    && typeof item.sentAt === "string"
    && typeof item.expiresAt === "string"
    && Number.isInteger(item.attempts);
}

async function readStore(): Promise<RegistrationVerificationFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RegistrationVerificationFile>;
    return {
      ...emptyStore(),
      ...parsed,
      verifications: Array.isArray(parsed.verifications)
        ? parsed.verifications.filter(isRecord).map((item) => ({ ...item, purpose: item.purpose ?? "REGISTRATION" }))
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(store: RegistrationVerificationFile) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, storePath);
}

function serializedMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function pruneExpired(records: RegistrationVerification[], now: number): RegistrationVerification[] {
  return records.filter((record) => new Date(record.expiresAt).getTime() > now);
}

function hashesMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export type ReserveRegistrationCodeResult =
  | { ok: true; deliveryId: string }
  | { ok: false; retryAfterSeconds: number };

/**
 * 先占住一个发送位，再调 SES。这样两个并发点击不会给同一邮箱连发两封。
 * PENDING 状态不能拿来注册；只有 SES 接收成功后 markRegistrationCodeSent 才会放行。
 */
export async function reserveRegistrationCode(input: {
  email: string;
  purpose: VerificationPurpose;
  codeHash: string;
  now?: Date;
}): Promise<ReserveRegistrationCodeResult> {
  return serializedMutation(async () => {
    const now = input.now?.getTime() ?? Date.now();
    const store = await readStore();
    store.verifications = pruneExpired(store.verifications, now);
    const existing = store.verifications.find((record) => record.email === input.email && record.purpose === input.purpose);
    if (existing) {
      const elapsed = now - new Date(existing.sentAt).getTime();
      if (elapsed < REGISTRATION_CODE_RESEND_MS) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((REGISTRATION_CODE_RESEND_MS - elapsed) / 1000)) };
      }
      store.verifications = store.verifications.filter((record) => record.email !== input.email);
    }

    const deliveryId = randomUUID();
    store.verifications.push({
      email: input.email,
      purpose: input.purpose,
      codeHash: input.codeHash,
      deliveryId,
      deliveryState: "PENDING",
      sentAt: new Date(now).toISOString(),
      expiresAt: new Date(now + REGISTRATION_CODE_TTL_MS).toISOString(),
      attempts: 0,
    });
    await writeStore(store);
    return { ok: true, deliveryId };
  });
}

export async function markRegistrationCodeSent(
  email: string,
  purpose: VerificationPurpose,
  deliveryId: string,
): Promise<boolean> {
  return serializedMutation(async () => {
    const now = Date.now();
    const store = await readStore();
    store.verifications = pruneExpired(store.verifications, now);
    const record = store.verifications.find(
      (item) => item.email === email && item.purpose === purpose && item.deliveryId === deliveryId,
    );
    if (!record) {
      await writeStore(store);
      return false;
    }
    record.deliveryState = "SENT";
    await writeStore(store);
    return true;
  });
}

/** SES 未接受时撤掉 PENDING 记录，用户不必无意义地等一分钟才能重试。 */
export async function discardReservedRegistrationCode(
  email: string,
  purpose: VerificationPurpose,
  deliveryId: string,
): Promise<void> {
  await serializedMutation(async () => {
    const store = await readStore();
    const next = store.verifications.filter(
      (item) => !(item.email === email && item.purpose === purpose && item.deliveryId === deliveryId && item.deliveryState === "PENDING"),
    );
    if (next.length === store.verifications.length) return;
    store.verifications = next;
    await writeStore(store);
  });
}

export type ConsumeRegistrationCodeResult =
  | "VALID"
  | "MISSING_OR_EXPIRED"
  | "NOT_DELIVERED"
  | "TOO_MANY_ATTEMPTS"
  | "WRONG";

/**
 * 校验并一次性消耗验证码。正确码会先从 store 删除，再由调用方建用户；
 * 同一邮箱的两个并发注册请求因此最多有一个能走到建号步骤。
 */
export async function consumeRegistrationCode(input: {
  email: string;
  purpose: VerificationPurpose;
  codeHash: string;
  now?: Date;
}): Promise<ConsumeRegistrationCodeResult> {
  return serializedMutation(async () => {
    const now = input.now?.getTime() ?? Date.now();
    const store = await readStore();
    store.verifications = pruneExpired(store.verifications, now);
    const record = store.verifications.find((item) => item.email === input.email && item.purpose === input.purpose);
    if (!record) {
      await writeStore(store);
      return "MISSING_OR_EXPIRED";
    }
    if (record.deliveryState !== "SENT") return "NOT_DELIVERED";
    if (record.attempts >= REGISTRATION_CODE_MAX_ATTEMPTS) return "TOO_MANY_ATTEMPTS";
    if (hashesMatch(record.codeHash, input.codeHash)) {
      store.verifications = store.verifications.filter((item) => item !== record);
      await writeStore(store);
      return "VALID";
    }
    record.attempts += 1;
    await writeStore(store);
    return record.attempts >= REGISTRATION_CODE_MAX_ATTEMPTS ? "TOO_MANY_ATTEMPTS" : "WRONG";
  });
}
