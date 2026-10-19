/**
 * 用户与会话的服务器端存储。
 *
 * 和 knowledge-store / conversation-store 同构：单机 JSON 文件 + 串行写入队列，
 * 贴合腾讯云 Lighthouse 单机、暂不迁数据库的现状（2026-09-17 产品决定）。
 *
 * **这个选择的代价必须写在这里，别指望以后有人记得**：
 *   - 文件存储在并发写入下靠串行队列保证不写坏，但整个文件每次都要全量读写，
 *     用户数上千之后会明显变慢；
 *   - 单机单文件意味着**不能横向扩容**，服务器换一台就得把文件搬过去；
 *   - 没有事务，"扣额度"和"记流水"两件事之间如果进程崩了会不一致。
 *   用户量真的起来之后，这块必须迁到 PostgreSQL（项目里已经预留了 drizzle 的表结构）。
 *
 * 安全相关的处理都在 password.ts 里，这里只负责存取。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashSessionToken } from "./password";

/** 套餐。free 是注册用户的默认档，anonymous 不落库（游客没有账号）。 */
export type UserPlan = "free" | "professional";

export interface StoredUser {
  id: string;
  /** 全小写，注册时就规范化过——登录时也要用同样的方式规范化再查。 */
  email: string;
  passwordHash: string;
  plan: UserPlan;
  createdAt: string;
  /** 额度按自然月重置，这里记的是"当前统计的是哪个月"，格式 YYYY-MM。 */
  quotaYearMonth: string;
  /** 本月已用掉的提问次数。 */
  quotaUsed: number;
}

export interface StoredSession {
  /** 只存令牌的 SHA-256，原文只在登录那一刻发给浏览器，服务端不保留。 */
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface UserStoreFile {
  schemaVersion: "1.0";
  users: StoredUser[];
  sessions: StoredSession[];
}

/** 会话有效期。到期后要重新登录。 */
export const SESSION_TTL_DAYS = 30;

const dataDirectory = process.env.LOCAL_USER_DIR?.trim()
  || process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "user-store.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): UserStoreFile {
  return { schemaVersion: "1.0", users: [], sessions: [] };
}

async function readStore(): Promise<UserStoreFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as UserStoreFile;
    return Array.isArray(parsed.users) ? { ...emptyStore(), ...parsed } : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(store: UserStoreFile) {
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

/** 纯函数：清掉过期会话。导出供单测。 */
export function pruneExpiredSessions(sessions: StoredSession[], now = new Date()): StoredSession[] {
  return sessions.filter((session) => new Date(session.expiresAt).getTime() > now.getTime());
}

export async function findUserByEmail(email: string): Promise<StoredUser | undefined> {
  const store = await readStore();
  return store.users.find((user) => user.email === email);
}

/**
 * 新建用户。邮箱已存在时返回 undefined——调用方**不要**据此对外区分
 * "邮箱已注册"和"注册成功"，否则就成了一个查询谁注册过的接口（账号枚举）。
 */
export async function createUser(input: {
  email: string;
  passwordHash: string;
  yearMonth: string;
}): Promise<StoredUser | undefined> {
  return serializedMutation(async () => {
    const store = await readStore();
    if (store.users.some((user) => user.email === input.email)) return undefined;
    const user: StoredUser = {
      id: `user_${randomUUID()}`,
      email: input.email,
      passwordHash: input.passwordHash,
      plan: "free",
      createdAt: new Date().toISOString(),
      quotaYearMonth: input.yearMonth,
      quotaUsed: 0,
    };
    store.users.push(user);
    await writeStore(store);
    return user;
  });
}

/**
 * 用已验证的邮箱验证码重设密码。
 *
 * 改密后会撤销该账号在所有设备上的旧会话：否则旧手机或浏览器即使知道旧密码，
 * 仍可继续使用已经签发的 cookie。这是忘记密码流程应有的安全边界。
 */
export async function resetUserPassword(userId: string, passwordHash: string): Promise<StoredUser | undefined> {
  return serializedMutation(async () => {
    const store = await readStore();
    const user = store.users.find((item) => item.id === userId);
    if (!user) return undefined;
    user.passwordHash = passwordHash;
    store.sessions = pruneExpiredSessions(store.sessions).filter((session) => session.userId !== userId);
    await writeStore(store);
    return user;
  });
}

/** 按 id 查用户。发信、后台改档这类"只有 userId"的场景用。 */
export async function findUserById(userId: string): Promise<StoredUser | undefined> {
  const store = await readStore();
  return store.users.find((user) => user.id === userId);
}

/** 登录成功后建会话，返回要写进 cookie 的令牌原文。 */
export async function createSession(userId: string, token: string): Promise<void> {
  await serializedMutation(async () => {
    const store = await readStore();
    store.sessions = pruneExpiredSessions(store.sessions);
    const now = new Date();
    store.sessions.push({
      tokenHash: hashSessionToken(token),
      userId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    });
    await writeStore(store);
  });
}

/** 按 cookie 里的令牌找当前用户。过期或找不到都返回 undefined。 */
export async function findUserBySessionToken(token: string): Promise<StoredUser | undefined> {
  if (!token) return undefined;
  const store = await readStore();
  const tokenHash = hashSessionToken(token);
  const session = store.sessions.find((item) => item.tokenHash === tokenHash);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return undefined;
  return store.users.find((user) => user.id === session.userId);
}

/** 登出：删掉这一条会话。其他设备上的登录不受影响。 */
export async function deleteSession(token: string): Promise<void> {
  if (!token) return;
  await serializedMutation(async () => {
    const store = await readStore();
    const tokenHash = hashSessionToken(token);
    store.sessions = pruneExpiredSessions(store.sessions).filter((item) => item.tokenHash !== tokenHash);
    await writeStore(store);
  });
}

/**
 * 改套餐。**这是唯一允许改 plan 的入口**——
 * 会员购买成功时升到 professional，到期或退款时降回 free。
 *
 * 保持"有效才写"：plan 已经是对的值就不落盘，省掉一次全量写文件。
 */
export async function setUserPlan(userId: string, plan: UserPlan): Promise<StoredUser | undefined> {
  return serializedMutation(async () => {
    const store = await readStore();
    const user = store.users.find((item) => item.id === userId);
    if (!user || user.plan === plan) return user;
    user.plan = plan;
    await writeStore(store);
    return user;
  });
}

/**
 * 消耗一次额度。返回消耗后的用户，额度不足时返回 undefined（调用方据此拒绝）。
 * 跨月时自动重置计数——重置发生在"用的时候"，不需要定时任务。
 */
export async function consumeQuota(userId: string, yearMonth: string, limit: number): Promise<StoredUser | undefined> {
  return serializedMutation(async () => {
    const store = await readStore();
    const user = store.users.find((item) => item.id === userId);
    if (!user) return undefined;
    if (user.quotaYearMonth !== yearMonth) {
      user.quotaYearMonth = yearMonth;
      user.quotaUsed = 0;
    }
    if (user.quotaUsed >= limit) return undefined;
    user.quotaUsed += 1;
    await writeStore(store);
    return user;
  });
}
