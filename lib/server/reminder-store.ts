/**
 * 合规提醒的存储（2026-09-30 建）。
 *
 * 和 conversation-store.ts 同构：单机 JSON 文件 + 串行写入队列防并发写坏文件，
 * 贴合腾讯云 Lighthouse 单机、无数据库依赖的部署现状。
 *
 * ## 为什么不用 db/schema.ts 里那张 reminders 表
 *
 * 那张 Postgres 表是更早的规划产物，全项目**没有任何代码读写它**（无 drizzle 连接、
 * 无 pg 驱动依赖）。现在真正跑的是本地 JSON。这里的字段尽量与它对齐，
 * 将来迁真库时改的只是读写层——但**要多带一个 `lockedAt`**（那张表里没有），
 * 原因见下面的锁说明，迁库时记得给 schema 补上这一列。
 *
 * ## 为什么要有 lockedAt 这把锁
 *
 * 发信由 crontab 每 5 分钟调一次 `scripts/send-due-reminders.mjs`，
 * 而部署、手动重试、进程卡住都可能让**两个进程同时扫到同一条到期提醒**。
 * 没有锁就会出现同一封提醒邮件发两遍——用户收到重复邮件，第一反应是系统坏了。
 *
 * 做法：抢占。扫到到期的条目后**先**把 `lockedAt` 写成当前时间落盘，
 * 下一个进程扫的时候会跳过"锁还在有效期内"的条目。
 * 锁有过期时间（LOCK_MINUTES），进程中途崩掉留下的锁不会永久堵死这条提醒。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
// 提醒的状态与视图类型放在 contracts（纯类型、无 node 依赖）——
// 前端提醒页要 import 它们，而这个文件依赖 node:fs，进不了客户端 bundle。
import type { ReminderSource, ReminderStatus, ReminderView } from "../contracts";

export type { ReminderSource, ReminderStatus, ReminderView };

export interface StoredReminder {
  id: string;
  userId: string;
  /**
   * 收件邮箱快照。发信时直接用它，不反查用户表——
   * 用户可能改邮箱、可能删账号，而已经排好的提醒该照发。
   */
  email: string;
  title: string;
  /** 邮件模板里的 {{detail}}：这条提醒讲的是什么、依据哪份文件。 */
  detail: string;
  /** 截止时刻（UTC ISO）。由印度时区当日 23:59 换算而来。 */
  deadlineAt: string;
  /** 截止时刻的时区说明，界面展示用。 */
  deadlineTimezone: string;
  /** 计划发信时刻（UTC ISO）。截止日前一天、北京时间 09:00。 */
  notifyAt: string;
  status: ReminderStatus;
  /**
   * 用户确认时间。**AI 建议的日期必须经用户确认才能建提醒**——
   * 这是建提醒的硬约束（也是 db/schema.ts 里这个字段 NOT NULL 的原因）：
   * 模型可能看错 Notice 上的日期，而一封基于错误日期的提醒邮件，
   * 比没有提醒更容易让人错过真正的截止日。
   */
  userConfirmedAt: string;
  sentAt?: string;
  retryCount: number;
  /** 发信脚本抢占锁的时间（UTC ISO）。见文件头的锁说明。 */
  lockedAt?: string;
  /** 最后一次发信失败的原因，排查用，不展示给用户。 */
  lastError?: string;
  source: ReminderSource;
  /** 来源是 Notice 时，记下那份文件，将来可回溯"这个日期是从哪份文件看来的"。 */
  sourceFileId?: string;
  createdAt: string;
  updatedAt: string;
}

interface ReminderStoreFile {
  schemaVersion: string;
  reminders: StoredReminder[];
}

const dataDirectory =
  process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "reminder-store.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

/** 单个用户最多保留多少条 ACTIVE 提醒。防刷，也给"太多提醒等于没有提醒"兜个底。 */
export const MAX_ACTIVE_REMINDERS_PER_USER = 50;

/** 发信失败最多重试几次。超了转 PAUSED，等人来看，而不是无限重试刷腾讯的接口。 */
export const MAX_SEND_RETRIES = 5;

/** 抢占锁的有效期（分钟）。比 crontab 间隔（5 分钟）留一倍余量。 */
export const LOCK_MINUTES = 10;

/** 已发送/已取消的提醒保留多久后清理。比对话的 30 天长——用户可能回头查"提醒发过没"。 */
const MAX_FINISHED_AGE_DAYS = 180;

function emptyStore(): ReminderStoreFile {
  return { schemaVersion: "1.0", reminders: [] };
}

async function readFileStore(): Promise<ReminderStoreFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as ReminderStoreFile;
    return Array.isArray(parsed.reminders) ? parsed : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeFileStore(store: ReminderStoreFile) {
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

/**
 * 印度时区当日 23:59（+05:30）→ UTC ISO 字符串。
 *
 * 用户只填一个日期（Notice 上写的"10月20日前答复"），时间按印度当地当日截止算——
 * 印度没有夏令时，+05:30 是固定的，可以直接拼字符串交给 Date 解析。
 * 日期非法返回 null，由调用方转成 400，不要在这里编一个日期出来。
 */
export function deadlineUtcFromIndiaDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;
  const parsed = new Date(`${date.trim()}T23:59:59+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * 计划发信时刻：截止日往前一天、北京时间 09:00（+08:00）→ UTC ISO。
 *
 * 为什么按北京时间而不是印度时间：收信的人在中国，"上午9点收到提醒"才有意义；
 * 按印度时间 9 点发，中国这边是早上 11 点半，还算能用，但按中国时间更贴合。
 * 中国同样没有夏令时，+08:00 固定。
 */
export function notifyUtcFromDeadline(deadlineUtcIso: string): string | null {
  const deadline = new Date(deadlineUtcIso);
  if (Number.isNaN(deadline.getTime())) return null;
  // 用 UTC 日期往前推一天（截止日本身是印度日期换算来的，这里取它的 UTC 日历日即可）。
  const previousDay = new Date(deadline.getTime() - 24 * 60 * 60 * 1000);
  const day = previousDay.toISOString().slice(0, 10);
  const parsed = new Date(`${day}T09:00:00+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** 纯函数：清掉过期已完成（已发/已取消）的提醒。ACTIVE 的一律保留。 */
export function pruneFinishedReminders(
  reminders: StoredReminder[],
  now: Date = new Date(),
  maxAgeDays: number = MAX_FINISHED_AGE_DAYS,
): StoredReminder[] {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  return reminders.filter((reminder) => {
    if (reminder.status === "ACTIVE" || reminder.status === "PAUSED") return true;
    return new Date(reminder.updatedAt).getTime() >= cutoff;
  });
}

export function toReminderView(reminder: StoredReminder): ReminderView {
  return {
    id: reminder.id,
    title: reminder.title,
    detail: reminder.detail,
    deadlineAt: reminder.deadlineAt,
    deadlineTimezone: reminder.deadlineTimezone,
    notifyAt: reminder.notifyAt,
    status: reminder.status,
    source: reminder.source,
    createdAt: reminder.createdAt,
  };
}

export interface CreateReminderInput {
  userId: string;
  email: string;
  /** Already-UTC ISO string，由 deadlineUtcFromIndiaDate 算好。 */
  deadlineAt: string;
  notifyAt: string;
  title: string;
  detail: string;
  source?: ReminderSource;
  sourceFileId?: string;
}

export type CreateReminderResult =
  | { ok: true; reminder: StoredReminder }
  | { ok: false; reason: "TOO_MANY_ACTIVE" };

export async function createReminder(input: CreateReminderInput): Promise<CreateReminderResult> {
  return serializedMutation(async () => {
    const store = await readFileStore();
    store.reminders = pruneFinishedReminders(store.reminders);
    const activeCount = store.reminders.filter(
      (item) => item.userId === input.userId && item.status === "ACTIVE",
    ).length;
    if (activeCount >= MAX_ACTIVE_REMINDERS_PER_USER) return { ok: false, reason: "TOO_MANY_ACTIVE" };

    const now = new Date().toISOString();
    const reminder: StoredReminder = {
      id: `rem_${randomUUID()}`,
      userId: input.userId,
      email: input.email,
      title: input.title,
      detail: input.detail,
      deadlineAt: input.deadlineAt,
      deadlineTimezone: "Asia/Kolkata",
      notifyAt: input.notifyAt,
      status: "ACTIVE",
      // 建的时候就是"用户刚刚确认过"——这条路径只由用户主动提交触发。
      userConfirmedAt: now,
      retryCount: 0,
      source: input.source ?? "MANUAL",
      ...(input.sourceFileId ? { sourceFileId: input.sourceFileId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    store.reminders.push(reminder);
    await writeFileStore(store);
    return { ok: true, reminder };
  });
}

/** 某个账号的提醒，最近的截止日在前。 */
export async function listRemindersForUser(userId: string): Promise<ReminderView[]> {
  if (!userId) return [];
  const store = await readFileStore();
  return store.reminders
    .filter((reminder) => reminder.userId === userId && reminder.status !== "CANCELLED")
    .sort((a, b) => a.deadlineAt.localeCompare(b.deadlineAt))
    .map(toReminderView);
}

/** 取消。只认自己的——id 是 UUID，但归属必须校验，否则改个 id 就能取消别人的提醒。 */
export async function cancelReminder(id: string, userId: string): Promise<boolean> {
  return serializedMutation(async () => {
    const store = await readFileStore();
    const reminder = store.reminders.find((item) => item.id === id && item.userId === userId);
    if (!reminder || reminder.status === "CANCELLED" || reminder.status === "SENT") return false;
    reminder.status = "CANCELLED";
    reminder.updatedAt = new Date().toISOString();
    await writeFileStore(store);
    return true;
  });
}

/**
 * 扫出到期的提醒并**抢占**（写 lockedAt 落盘）。
 *
 * 抢占后这些条目不再进入下一次扫描的结果，直到锁过期。
 * 调用方（发信脚本）拿到后必须显式 markSent 或 markFailed 收尾——
 * 崩溃留下的锁会在 LOCK_MINUTES 分钟后自动失效，那条提醒会被重新扫到。
 */
export async function claimDueReminders(
  now: Date = new Date(),
  limit = 20,
): Promise<StoredReminder[]> {
  return serializedMutation(async () => {
    const store = await readFileStore();
    const nowMs = now.getTime();
    const lockExpiryMs = LOCK_MINUTES * 60 * 1000;
    const due = store.reminders.filter((reminder) => {
      if (reminder.status !== "ACTIVE") return false;
      if (new Date(reminder.notifyAt).getTime() > nowMs) return false;
      if (!reminder.lockedAt) return true;
      // 锁还新鲜＝别的进程正在发；锁过期了＝上次那个进程没收尾，重新拿。
      return nowMs - new Date(reminder.lockedAt).getTime() > lockExpiryMs;
    }).slice(0, limit);

    const lockedAt = now.toISOString();
    for (const reminder of due) {
      reminder.lockedAt = lockedAt;
      reminder.updatedAt = lockedAt;
    }
    if (due.length > 0) await writeFileStore(store);
    return due;
  });
}

/** 发信成功。清掉锁，落 sentAt。 */
export async function markReminderSent(id: string): Promise<void> {
  await serializedMutation(async () => {
    const store = await readFileStore();
    const reminder = store.reminders.find((item) => item.id === id);
    if (!reminder) return;
    const now = new Date().toISOString();
    reminder.status = "SENT";
    reminder.sentAt = now;
    reminder.lockedAt = undefined;
    reminder.lastError = undefined;
    reminder.updatedAt = now;
    await writeFileStore(store);
  });
}

/**
 * 发信失败。清掉锁让它可以被重新扫到，重试计数 +1；
 * 超过 MAX_SEND_RETRIES 转 PAUSED——不再自动重试，留着等人来看日志，
 * 而不是对着一个必然失败的收件地址反复调用腾讯接口。
 */
export async function markReminderFailed(id: string, error: string): Promise<void> {
  await serializedMutation(async () => {
    const store = await readFileStore();
    const reminder = store.reminders.find((item) => item.id === id);
    if (!reminder) return;
    const now = new Date().toISOString();
    reminder.retryCount += 1;
    reminder.lockedAt = undefined;
    reminder.lastError = error.slice(0, 500);
    reminder.status = reminder.retryCount >= MAX_SEND_RETRIES ? "PAUSED" : "ACTIVE";
    reminder.updatedAt = now;
    await writeFileStore(store);
  });
}
