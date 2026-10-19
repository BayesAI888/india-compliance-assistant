import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StoredApprovedTerm } from "./terms-workbook";

/**
 * 运行时检索词典的存取层，仿照 knowledge-store.ts 的模式：
 * - 管理员上传并同步过词典后，写入 .local-data/terms-approved.json（可写、会变）
 * - 还没上传过的情况下，回退读取仓库自带的 config/terms.approved.json 种子文件，
 *   保证第一次启动时检索不是完全空的。
 *
 * 《产品规则表》约定：运行时词典的唯一来源应该是管理员上传的
 * 《中英文检索词典模板》，种子文件只是"还没人上传过"时的默认值，
 * 一旦管理员同步过一次，就以 .local-data 里的版本为准。
 */

export interface TermsSyncMeta {
  sourceFileName: string;
  syncedAt: string;
  totalRows: number;
  publishedCount: number;
  warnings: string[];
}

interface TermsStoreFile {
  schemaVersion: "1.0";
  meta: TermsSyncMeta;
  terms: StoredApprovedTerm[];
}

const dataDirectory = process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "terms-approved.json");
const seedPath = path.join(process.cwd(), "config", "terms.approved.json");
/**
 * 多义词表。**独立于后台同步的词典**，见下面 `mergeReadings` 的说明。
 */
const readingsPath = path.join(process.cwd(), "config", "term-readings.json");

let mutationQueue: Promise<unknown> = Promise.resolve();

function serializedMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readSeed(): Promise<StoredApprovedTerm[]> {
  try {
    const raw = await readFile(seedPath, "utf8");
    const parsed = JSON.parse(raw) as { terms?: unknown };
    return Array.isArray(parsed.terms) ? parsed.terms as StoredApprovedTerm[] : [];
  } catch {
    return [];
  }
}

async function readStoreFile(): Promise<TermsStoreFile | null> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as TermsStoreFile;
    return Array.isArray(parsed.terms) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 管理员是否已经同步过一次词典（决定用 .local-data 还是种子文件）。 */
export async function hasSyncedTerms(): Promise<boolean> {
  return (await readStoreFile()) !== null;
}

/**
 * 把 `config/term-readings.json` 里的多义词合并到词典上。
 *
 * ## 为什么多义词不放进后台同步的那份词典
 *
 * 两个原因，第二个是硬伤：
 *
 * 1. 后台词典是一张**给业务人员按行维护的 xlsx**（一词一行、一个中文对一个英文），
 *    装不下"一个词挂四个义项、每个义项带自己的触发词和检索词"这种嵌套结构。
 * 2. **每同步一次，`buildApprovedGlossary()` 会按 xlsx 逐行重建整张表**，
 *    而它的输出类型 `StoredApprovedTerm` 里**没有 readings 字段**。
 *    也就是说：多义词条目写进后台词典之后，下一次同步就被**静默删掉**了——
 *    多义词闸门失效，不报任何错，只是答案又开始悄悄改用户的问题。
 *
 * 所以改成合并：后台同步爱写什么写什么，多义词在运行时统一贴上来，冲不掉。
 *
 * 合并规则：
 *   - 词典里已有同名词条 → 只把 `readings` 挂上去，其余字段以词典为准
 *     （业务人员改的译名、法域、备注不该被这个文件覆盖）。
 *   - 词典里没有 → 整条加进去（「保证金」现在就属于这种：xlsx 里本来就没有）。
 */
function mergeReadings(
  base: StoredApprovedTerm[],
  readings: StoredApprovedTerm[],
): StoredApprovedTerm[] {
  const byName = new Map(base.map((term) => [term.term_zh, term]));
  for (const extra of readings) {
    const existing = byName.get(extra.term_zh);
    if (existing) byName.set(extra.term_zh, { ...existing, readings: extra.readings });
    else byName.set(extra.term_zh, extra);
  }
  return [...byName.values()];
}

async function readReadings(): Promise<StoredApprovedTerm[]> {
  try {
    const raw = await readFile(readingsPath, "utf8");
    const parsed = JSON.parse(raw) as { terms?: unknown };
    return Array.isArray(parsed.terms) ? parsed.terms as StoredApprovedTerm[] : [];
  } catch {
    // 文件不存在或坏了：多义词闸门整个不生效，其余照常。
    // 不抛错——多义词是增强，不该让它挡住整个检索链路。
    return [];
  }
}

export async function readApprovedGlossary(): Promise<StoredApprovedTerm[]> {
  const stored = await readStoreFile();
  const base = stored ? stored.terms : await readSeed();
  return mergeReadings(base, await readReadings());
}

export async function readTermsSyncMeta(): Promise<TermsSyncMeta | null> {
  const stored = await readStoreFile();
  return stored?.meta ?? null;
}

export async function writeApprovedGlossary(
  terms: StoredApprovedTerm[],
  meta: TermsSyncMeta,
): Promise<void> {
  return serializedMutation(async () => {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const payload: TermsStoreFile = { schemaVersion: "1.0", meta, terms };
    const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, storePath);
  });
}
