/**
 * 用户上传Notice/合同/申报文件的私有存储。
 *
 * 按《产品规则表 V1.4》："上传Notice/合同/申报文件……本人可上传和删除"、
 * "文件只对上传者和有审计授权的超级管理员可见；不得进入公共知识库"。
 *
 * 上传接口要求登录。附件绑定到当前账号的会话，/api/chat 先校验会话归属，再按
 * conversation_id 和 attachment_id 的对应关系读取；不属于当前账号会话的附件一律
 * 当成不存在。这样账号身份和附件归属使用同一份判据，ID 不再充当访问凭证。
 *
 * 和 conversation-store.ts 同构：单机JSON文件 + 串行写入队列防并发写坏文件。
 * 提取出的原文和Notice事实都算敏感内容，产品规则表要求"不在普通日志中记录
 * 用户上传文件全文；敏感字段脱敏"——这个文件里任何调用方要打日志，只能打
 * 文件名/状态/错误类型，不能打 extractedText 或 noticeFacts 的内容。
 *
 * 尚未落地（如实记录，产品规则表本身也把下面这些列为待定问题）：
 *   1. 管理员审计视图——现在只有存储，没有管理后台的查看/审计入口。
 *   2. 保存期限策略——产品规则表把"用户上传文件的保存期限、用户注销后的删除
 *      时限"列为待定问题，这里先比照 conversation-store.ts 的 30 天不活跃清理，
 *      不是正式定案的策略，产品定下来之后要回来改这个常量。
 *   3. "本人可删除"——目前没有对应的删除接口，只有巡检式的过期清理。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtractedNoticeFacts } from "./notice-extract";

export interface StoredAttachment {
  id: string;
  conversationId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  status: "EXTRACTED" | "UNSUPPORTED" | "FAILED";
  /** 提取失败/格式不支持时的原因，直接展示给用户，不含文件正文。 */
  errorMessage?: string;
  /** 私有：提取出的原文。不进公共知识库，不出现在普通日志里。 */
  extractedText?: string;
  /** 从原文提炼出的Notice事实，仅 status==="EXTRACTED" 时有意义。 */
  noticeFacts?: ExtractedNoticeFacts;
}

interface AttachmentStoreFile {
  schemaVersion: "1.0";
  attachments: StoredAttachment[];
}

/** 占位默认值，产品规则表把"保存期限"列为待定问题，这里先比照会话存储的做法。 */
export const MAX_ATTACHMENT_AGE_DAYS = 30;

const dataDirectory = process.env.LOCAL_ATTACHMENT_DIR?.trim()
  || process.env.LOCAL_CONVERSATION_DIR?.trim()
  || process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "attachment-store.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): AttachmentStoreFile {
  return { schemaVersion: "1.0", attachments: [] };
}

async function readFileStore(): Promise<AttachmentStoreFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as AttachmentStoreFile;
    return Array.isArray(parsed.attachments) ? parsed : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeFileStore(store: AttachmentStoreFile) {
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

/** 纯函数，独立于文件IO，方便单测：把超过保留期的附件过滤掉。 */
export function pruneExpiredAttachments(
  attachments: StoredAttachment[],
  now: Date = new Date(),
  maxAgeDays: number = MAX_ATTACHMENT_AGE_DAYS,
): StoredAttachment[] {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  return attachments.filter((item) => new Date(item.createdAt).getTime() >= cutoff);
}

export async function saveAttachment(
  input: Omit<StoredAttachment, "id" | "createdAt">,
): Promise<StoredAttachment> {
  return serializedMutation(async () => {
    const store = await readFileStore();
    store.attachments = pruneExpiredAttachments(store.attachments);
    const attachment: StoredAttachment = {
      ...input,
      id: `att_${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    store.attachments.push(attachment);
    await writeFileStore(store);
    return attachment;
  });
}

/**
 * 只有 conversationId 匹配才返回——不属于这个会话的附件当成不存在。
 * 传入的 attachmentIds 顺序不保证被保留（按存储内部顺序返回），调用方如果
 * 需要按用户上传顺序展示，自己再排一次序。
 */
export async function getAttachmentsForConversation(
  conversationId: string,
  attachmentIds: string[],
): Promise<StoredAttachment[]> {
  if (attachmentIds.length === 0) return [];
  const store = await readFileStore();
  const idSet = new Set(attachmentIds);
  return store.attachments.filter((item) => idSet.has(item.id) && item.conversationId === conversationId);
}
