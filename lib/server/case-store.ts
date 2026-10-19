/**
 * 税务判例库的存储。和 knowledge-store.ts、conversation-store.ts 同构：
 * 单机 JSON 文件 + 串行写入队列，贴合腾讯云 Lighthouse 单机部署现状，不依赖数据库。
 *
 * 状态机和知识库资料一致：TO_REVIEW（待审核）→ PUBLISHED（已发布，进问答检索范围）
 * → WITHDRAWN（软删除，退出检索但正文还在，能恢复）。
 *
 * 和知识库资料的关键区别：案例不是切成 chunk 的正文，是九个字段的结构化记录，
 * 一条案例就是一条记录，不需要 chunk/分窗这些概念。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateCaseText, type ParsedCase } from "../case-validator";

export type StoredCaseStatus = "TO_REVIEW" | "PUBLISHED" | "WITHDRAWN";

export interface StoredCase extends ParsedCase {
  id: string;
  sourceFileName: string;
  status: StoredCaseStatus;
  createdAt: string;
  publishedAt?: string;
  withdrawnAt?: string;
}

interface CaseStoreFile {
  schemaVersion: "1.0";
  cases: StoredCase[];
}

const dataDirectory = process.env.LOCAL_CASE_DIR?.trim()
  || process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "case-store.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): CaseStoreFile {
  return { schemaVersion: "1.0", cases: [] };
}

async function readFileStore(): Promise<CaseStoreFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as CaseStoreFile;
    return Array.isArray(parsed.cases) ? parsed : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeFileStore(store: CaseStoreFile) {
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

export class CaseValidationError extends Error {
  errors: string[];
  warnings: string[];
  constructor(errors: string[], warnings: string[]) {
    super(errors.join("；") || "案例校验未通过。");
    this.errors = errors;
    this.warnings = warnings;
  }
}

/**
 * 校验并暂存一条案例草稿。按 docid 去重——同一个 Indian Kanoon 判例重复上传时，
 * 复用已有记录而不是造出两条同名不同ID的重复数据（和知识库按内容哈希去重是同一个思路，
 * 案例这边用 docid 天然就是更合适的去重键，不需要另外算哈希）。
 */
export async function stageCase(fileName: string, rawText: string): Promise<{ record: StoredCase; duplicate: boolean }> {
  const validation = validateCaseText(fileName, rawText);
  if (validation.status !== "READY_TO_REVIEW" || !validation.parsed) {
    throw new CaseValidationError(validation.errors, validation.warnings);
  }

  return serializedMutation(async () => {
    const store = await readFileStore();
    const existing = store.cases.find((item) => item.docid === validation.parsed!.docid);
    if (existing) {
      return { record: existing, duplicate: true };
    }

    const record: StoredCase = {
      ...validation.parsed!,
      id: `case_${randomUUID()}`,
      sourceFileName: fileName,
      status: "TO_REVIEW",
      createdAt: new Date().toISOString(),
    };
    store.cases.push(record);
    await writeFileStore(store);
    return { record, duplicate: false };
  });
}

export async function publishCase(id: string): Promise<StoredCase | null> {
  return serializedMutation(async () => {
    const store = await readFileStore();
    const record = store.cases.find((item) => item.id === id);
    if (!record) return null;
    if (record.status !== "PUBLISHED") {
      record.status = "PUBLISHED";
      record.publishedAt = record.publishedAt ?? new Date().toISOString();
      record.withdrawnAt = undefined;
      await writeFileStore(store);
    }
    return record;
  });
}

export async function withdrawCase(id: string): Promise<StoredCase | null> {
  return serializedMutation(async () => {
    const store = await readFileStore();
    const record = store.cases.find((item) => item.id === id);
    if (!record) return null;
    if (record.status !== "WITHDRAWN") {
      record.status = "WITHDRAWN";
      record.withdrawnAt = new Date().toISOString();
      await writeFileStore(store);
    }
    return record;
  });
}

export async function getCaseOverview(): Promise<StoredCase[]> {
  const store = await readFileStore();
  return [...store.cases].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 问答检索用：只要已发布的案例。 */
export async function getPublishedCases(): Promise<StoredCase[]> {
  const store = await readFileStore();
  return store.cases.filter((item) => item.status === "PUBLISHED");
}
