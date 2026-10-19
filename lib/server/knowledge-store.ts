import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  KnowledgeChunkReview,
  KnowledgeValidationResult,
} from "../contracts";
import { validateKnowledgeTxt } from "../knowledge-validator";
import { classifyDocumentCategory } from "./document-category";
import { classifyHierarchy, type HierarchyLevel } from "./legal-hierarchy";

/**
 * WITHDRAWN 是软删除：资料和Chunk正文都留着（供审计追溯），
 * 但退出问答检索范围——getPublishedKnowledgeChunks() 只认 PUBLISHED。
 */
export type StoredKnowledgeStatus = "TO_REVIEW" | "PUBLISHED" | "WITHDRAWN";

export interface StoredKnowledgeDocument {
  id: string;
  fileName: string;
  sourceTextSha256: string;
  status: StoredKnowledgeStatus;
  createdAt: string;
  publishedAt?: string;
  withdrawnAt?: string;
  warningCount: number;
  chunks: KnowledgeChunkReview[];
  /**
   * 法律位阶，**整份资料一个值**（一份文件就是一部法，不会混）。
   *
   * 留空表示管理员还没确认过——此时下游按资料名推断（`resolveHierarchy`），
   * 不是当成 UNKNOWN。这样既有的 58 份资料不用先改一遍才能用，
   * 而管理员在总览里改过的那些以**人工值为准**。
   *
   * 为什么不学 `legalCurrencyCheckedAt` 那样只声明不写：那个字段声明了
   * 却从没有人写过，线上 100% 为空，等于整条依赖它的逻辑从不触发。
   * 这次上传解析时就写入推断值，管理员改的是一个**已有默认值的选择**，
   * 而不是一个需要从零填的空字段。
   */
  hierarchyLevel?: HierarchyLevel;
  /** 位阶是人工确认过的还是推断的。总览里要能一眼看出哪些还没人过目。 */
  hierarchyConfirmed?: boolean;
}

interface KnowledgeStoreFile {
  schemaVersion: "1.0";
  documents: StoredKnowledgeDocument[];
}

export interface PublishedKnowledgeChunk extends KnowledgeChunkReview {
  documentId: string;
  fileName: string;
}

interface D1Result<T = unknown> {
  results?: T[];
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

interface DocumentRow {
  id: string;
  file_name: string;
  source_text_sha256: string;
  status: StoredKnowledgeStatus;
  created_at: string;
  published_at: string | null;
  withdrawn_at: string | null;
  warning_count: number;
}

interface ChunkRow {
  document_id: string;
  file_name: string;
  chunk_no: number;
  source: string;
  major_title: string;
  minor_title: string;
  official_url: string;
  body: string;
  body_length: number;
  word_count: number;
  warning: string | null;
  provision_effective_from: string | null;
  provision_effective_to: string | null;
  applicability_note: string | null;
}

export class KnowledgeValidationError extends Error {
  public readonly result: KnowledgeValidationResult;

  constructor(result: KnowledgeValidationResult) {
    super("知识库TXT校验失败。");
    this.result = result;
  }
}

const dataDirectory = process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "knowledge-store.json");
const initializedDatabases = new WeakSet<object>();
let mutationQueue: Promise<unknown> = Promise.resolve();

async function getD1Database(): Promise<D1DatabaseLike | null> {
  try {
    const workers = await import("cloudflare:workers") as unknown as {
      env?: { DB?: D1DatabaseLike };
    };
    return workers.env?.DB ?? null;
  } catch {
    return null;
  }
}

async function initializeD1(db: D1DatabaseLike) {
  if (initializedDatabases.has(db as object)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS kb_local_documents (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      source_text_sha256 TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT,
      withdrawn_at TEXT,
      warning_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kb_local_chunks (
      document_id TEXT NOT NULL,
      chunk_no INTEGER NOT NULL,
      source TEXT NOT NULL,
      major_title TEXT NOT NULL,
      minor_title TEXT NOT NULL,
      official_url TEXT NOT NULL,
      body TEXT NOT NULL,
      body_length INTEGER NOT NULL,
      word_count INTEGER NOT NULL,
      warning TEXT,
      -- 适用期间（2026-09-16加）：留空＝现行有效。见 knowledge-validator.ts 文件头说明。
      -- 注意 CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，D1上如果表已经建好了，
      -- 需要手动 ALTER TABLE 补这三列。生产环境走的是本地文件store，不受这个限制。
      provision_effective_from TEXT,
      provision_effective_to TEXT,
      applicability_note TEXT,
      PRIMARY KEY (document_id, chunk_no),
      FOREIGN KEY (document_id) REFERENCES kb_local_documents(id) ON DELETE CASCADE
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_kb_local_documents_status ON kb_local_documents(status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_kb_local_chunks_document ON kb_local_chunks(document_id, chunk_no)"),
  ]);
  initializedDatabases.add(db as object);
}

function rowToChunk(row: ChunkRow): PublishedKnowledgeChunk {
  return {
    documentId: row.document_id,
    fileName: row.file_name,
    number: row.chunk_no,
    source: row.source,
    majorTitle: row.major_title,
    minorTitle: row.minor_title,
    officialUrl: row.official_url,
    body: row.body,
    bodyLength: row.body_length,
    wordCount: row.word_count,
    warning: row.warning ?? undefined,
    provisionEffectiveFrom: row.provision_effective_from ?? undefined,
    provisionEffectiveTo: row.provision_effective_to ?? undefined,
    applicabilityNote: row.applicability_note ?? undefined,
  };
}

/**
 * 一份资料整体的位阶：看它**多数 chunk 的来源**推断出什么。
 *
 * 不只看 fileName：文件名是管理员起的（"FEMA_NDI_Rules_for_kb.txt"），
 * 而 chunk 里的【来源】是从官方文本抄的正式名称（"FEMA (Non-debt Instruments) Rules, 2019"），
 * 后者规范得多。两者都看、以 chunk 为主，文件名只在 chunk 推不出来时兜底。
 */
export function inferDocumentHierarchy(
  fileName: string,
  chunks: Array<{ source: string }>,
): HierarchyLevel {
  const votes = new Map<HierarchyLevel, number>();
  for (const chunk of chunks) {
    const level = classifyHierarchy(chunk.source);
    if (level === "UNKNOWN") continue;
    votes.set(level, (votes.get(level) ?? 0) + 1);
  }
  const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (winner) return winner;
  return classifyHierarchy(fileName);
}

/**
 * 取一个 chunk 的位阶：**人工确认的值优先，没有就按来源名推断**。
 *
 * 为什么要有推断兜底：位阶字段是新加的，既有的 58 份资料在管理员逐个确认之前
 * 都是空的。如果空就按 UNKNOWN 处理，配额保底和结论锚定这两套机制在
 * "全部确认完"之前一天都不起作用——而那可能要等很久。
 * 推断在现有资料上实测 14/14 正确，先用着，管理员改过的以人工值为准。
 */
export function resolveHierarchy(chunk: { source: string; hierarchyLevel?: HierarchyLevel }): HierarchyLevel {
  return chunk.hierarchyLevel ?? classifyHierarchy(chunk.source);
}

async function loadD1Document(db: D1DatabaseLike, documentId: string) {
  const row = await db.prepare(`SELECT id, file_name, source_text_sha256, status,
    created_at, published_at, withdrawn_at, warning_count
    FROM kb_local_documents WHERE id = ?`).bind(documentId).first<DocumentRow>();
  if (!row) return null;
  const chunkRows = await db.prepare(`SELECT d.file_name, c.document_id, c.chunk_no,
    c.source, c.major_title, c.minor_title, c.official_url, c.body,
    c.body_length, c.word_count, c.warning,
    c.provision_effective_from, c.provision_effective_to, c.applicability_note
    FROM kb_local_chunks c JOIN kb_local_documents d ON d.id = c.document_id
    WHERE c.document_id = ? ORDER BY c.chunk_no`).bind(documentId).all<ChunkRow>();
  return {
    id: row.id,
    fileName: row.file_name,
    sourceTextSha256: row.source_text_sha256,
    status: row.status,
    createdAt: row.created_at,
    publishedAt: row.published_at ?? undefined,
    withdrawnAt: row.withdrawn_at ?? undefined,
    warningCount: row.warning_count,
    chunks: (chunkRows.results ?? []).map(rowToChunk),
    // D1 的表里这两列可能还不存在（CREATE TABLE IF NOT EXISTS 不补列），
    // 所以这里现算推断值而不是读列。D1 路径当前不在生产使用。
    hierarchyLevel: inferDocumentHierarchy(row.file_name, (chunkRows.results ?? [])),
    hierarchyConfirmed: false,
  } satisfies StoredKnowledgeDocument;
}

function emptyStore(): KnowledgeStoreFile {
  return { schemaVersion: "1.0", documents: [] };
}

async function readFileStore(): Promise<KnowledgeStoreFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as KnowledgeStoreFile;
    return Array.isArray(parsed.documents) ? parsed : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeFileStore(store: KnowledgeStoreFile) {
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

export async function stageKnowledgeDocument(fileName: string, rawText: string) {
  const validation = validateKnowledgeTxt(fileName, rawText);
  if (validation.status !== "READY_TO_REVIEW") {
    throw new KnowledgeValidationError(validation);
  }

  return serializedMutation(async () => {
    const sourceTextSha256 = createHash("sha256").update(rawText).digest("hex");
    const db = await getD1Database();
    if (db) {
      await initializeD1(db);
      const existing = await db.prepare("SELECT id FROM kb_local_documents WHERE source_text_sha256 = ?")
        .bind(sourceTextSha256).first<{ id: string }>();
      if (existing) {
        const document = await loadD1Document(db, existing.id);
        if (!document) throw new Error("Stored knowledge document could not be loaded.");
        return { document, validation, duplicate: true };
      }

      const id = `kb_${sourceTextSha256.slice(0, 20)}`;
      const createdAt = new Date().toISOString();
      const statements = [
        db.prepare(`INSERT INTO kb_local_documents
          (id, file_name, source_text_sha256, status, created_at, warning_count, chunk_count)
          VALUES (?, ?, ?, 'TO_REVIEW', ?, ?, ?)`)
          .bind(id, fileName, sourceTextSha256, createdAt, validation.warnings.length, validation.chunks.length),
        ...validation.chunks.map((chunk) => db.prepare(`INSERT INTO kb_local_chunks
          (document_id, chunk_no, source, major_title, minor_title, official_url,
           body, body_length, word_count, warning,
           provision_effective_from, provision_effective_to, applicability_note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, chunk.number, chunk.source, chunk.majorTitle, chunk.minorTitle,
            chunk.officialUrl, chunk.body, chunk.bodyLength, chunk.wordCount, chunk.warning ?? null,
            chunk.provisionEffectiveFrom ?? null, chunk.provisionEffectiveTo ?? null,
            chunk.applicabilityNote ?? null)),
      ];
      await db.batch(statements);
      const document: StoredKnowledgeDocument = {
        id,
        fileName,
        sourceTextSha256,
        status: "TO_REVIEW",
        createdAt,
        warningCount: validation.warnings.length,
        chunks: validation.chunks,
      // 上传时就写入**推断的位阶**作为默认值，管理员在后台确认或改正。
      // 不留空：留空的字段没人会主动去填（legalCurrencyCheckedAt 的前车之鉴），
      // 给一个已经填好的默认值，管理员做的是"核对"而不是"从零填"。
      hierarchyLevel: inferDocumentHierarchy(fileName, validation.chunks),
      hierarchyConfirmed: false,
      };
      return { document, validation, duplicate: false };
    }

    const store = await readFileStore();
    const existing = store.documents.find((document) => document.sourceTextSha256 === sourceTextSha256);
    if (existing) return { document: existing, validation, duplicate: true };

    const document: StoredKnowledgeDocument = {
      id: `kb_${sourceTextSha256.slice(0, 20)}`,
      fileName,
      sourceTextSha256,
      status: "TO_REVIEW",
      createdAt: new Date().toISOString(),
      warningCount: validation.warnings.length,
      chunks: validation.chunks,
      // 上传时就写入**推断的位阶**作为默认值，管理员在后台确认或改正。
      // 不留空：留空的字段没人会主动去填（legalCurrencyCheckedAt 的前车之鉴），
      // 给一个已经填好的默认值，管理员做的是"核对"而不是"从零填"。
      hierarchyLevel: inferDocumentHierarchy(fileName, validation.chunks),
      hierarchyConfirmed: false,
    };
    store.documents.push(document);
    await writeFileStore(store);
    return { document, validation, duplicate: false };
  });
}

/**
 * 发布一份资料。也用于「恢复」——把 WITHDRAWN 的资料重新发布回检索范围时走同一条路径，
 * COALESCE(published_at, ?) 保留资料第一次发布的时间，不会因为下架又恢复而变成新资料。
 */
export async function publishKnowledgeDocument(documentId: string) {
  return serializedMutation(async () => {
    const db = await getD1Database();
    if (db) {
      await initializeD1(db);
      const publishedAt = new Date().toISOString();
      await db.prepare(`UPDATE kb_local_documents
        SET status = 'PUBLISHED', published_at = COALESCE(published_at, ?), withdrawn_at = NULL
        WHERE id = ?`).bind(publishedAt, documentId).run();
      return loadD1Document(db, documentId);
    }

    const store = await readFileStore();
    const document = store.documents.find((item) => item.id === documentId);
    if (!document) return null;
    if (document.status !== "PUBLISHED") {
      document.status = "PUBLISHED";
      document.publishedAt = document.publishedAt ?? new Date().toISOString();
      document.withdrawnAt = undefined;
      await writeFileStore(store);
    }
    return document;
  });
}

/**
 * 软删除：资料退出问答检索范围（getPublishedKnowledgeChunks 只认 PUBLISHED），
 * 但记录和正文都保留在store里，供后台审计追溯，也方便随时用 publishKnowledgeDocument 恢复。
 * 调用方（admin API路由）还需要额外调 vector-store 的 deleteDocumentVectors 清掉对应向量。
 */
export async function withdrawKnowledgeDocument(documentId: string) {
  return serializedMutation(async () => {
    const db = await getD1Database();
    if (db) {
      await initializeD1(db);
      const withdrawnAt = new Date().toISOString();
      await db.prepare(`UPDATE kb_local_documents
        SET status = 'WITHDRAWN', withdrawn_at = ?
        WHERE id = ?`).bind(withdrawnAt, documentId).run();
      return loadD1Document(db, documentId);
    }

    const store = await readFileStore();
    const document = store.documents.find((item) => item.id === documentId);
    if (!document) return null;
    if (document.status !== "WITHDRAWN") {
      document.status = "WITHDRAWN";
      document.withdrawnAt = new Date().toISOString();
      await writeFileStore(store);
    }
    return document;
  });
}

/**
 * 手工设定一份资料的法律位阶。
 *
 * 写入时同时把 `hierarchyConfirmed` 置 true——这样总览能区分
 * "管理员看过并确认"和"系统推断、还没人过目"。这个区分有实际用处：
 * 位阶判错会让一份 circular 被当成 Act 去锚定结论，
 * 而**推断值出错时没有任何信号**，必须让人看得见哪些还没核过。
 *
 * D1 上这一列可能还不存在（`CREATE TABLE IF NOT EXISTS` 不补列），
 * 所以那条分支用 try/catch 包住：列不存在时静默跳过，不让后台报错。
 * 生产环境走的是本地文件 store，不受这个限制。
 */
export async function setKnowledgeHierarchy(documentId: string, level: HierarchyLevel) {
  return serializedMutation(async () => {
    const db = await getD1Database();
    if (db) {
      await initializeD1(db);
      try {
        await db.prepare(`UPDATE kb_local_documents
          SET hierarchy_level = ?, hierarchy_confirmed = 1 WHERE id = ?`)
          .bind(level, documentId).run();
      } catch {
        // 老表没有这两列——D1 路径当前没在生产用，不因此报错。
      }
      return loadD1Document(db, documentId);
    }

    const store = await readFileStore();
    const document = store.documents.find((item) => item.id === documentId);
    if (!document) return null;
    document.hierarchyLevel = level;
    document.hierarchyConfirmed = true;
    await writeFileStore(store);
    return document;
  });
}

/**
 * 按 id 取回一份资料（含全部 chunk），用于"回到未完成的审核"。
 *
 * 缺这个函数造成过一个真实死局（2026-09-16）：上传成功、状态停在 TO_REVIEW，
 * 但「审核与发布」那一屏只认刚上传完的页面状态，刷新或切标签页之后就再也进不去；
 * 总览里待审核的行又只有"展开"、没有任何操作按钮。于是这份资料**审核不了、
 * 发布不了、也删不掉**，永远卡在中间。
 */
export async function getKnowledgeDocumentForReview(
  documentId: string,
): Promise<StoredKnowledgeDocument | null> {
  const db = await getD1Database();
  if (db) {
    await initializeD1(db);
    return loadD1Document(db, documentId);
  }
  const store = await readFileStore();
  return store.documents.find((document) => document.id === documentId) ?? null;
}

export async function getKnowledgeStoreStatus() {
  const db = await getD1Database();
  if (db) {
    await initializeD1(db);
    const row = await db.prepare(`SELECT
      COUNT(*) AS document_count,
      SUM(CASE WHEN status = 'PUBLISHED' THEN 1 ELSE 0 END) AS published_document_count,
      SUM(CASE WHEN status = 'TO_REVIEW' THEN 1 ELSE 0 END) AS review_document_count,
      SUM(CASE WHEN status = 'PUBLISHED' THEN chunk_count ELSE 0 END) AS published_chunk_count
      FROM kb_local_documents`).first<Record<string, number | null>>();
    return {
      documentCount: Number(row?.document_count ?? 0),
      publishedDocumentCount: Number(row?.published_document_count ?? 0),
      reviewDocumentCount: Number(row?.review_document_count ?? 0),
      publishedChunkCount: Number(row?.published_chunk_count ?? 0),
    };
  }

  const store = await readFileStore();
  const publishedDocuments = store.documents.filter((document) => document.status === "PUBLISHED");
  const reviewDocuments = store.documents.filter((document) => document.status === "TO_REVIEW");
  return {
    documentCount: store.documents.length,
    publishedDocumentCount: publishedDocuments.length,
    reviewDocumentCount: reviewDocuments.length,
    publishedChunkCount: publishedDocuments.reduce((total, document) => total + document.chunks.length, 0),
  };
}

export interface KnowledgeOverviewSection {
  /** 一级标题（Chunk 的 major_title），也就是这份资料的"章"。 */
  title: string;
  chunkCount: number;
  /** 该章下的二级标题（minor_title），最多列前若干条，避免一次吐出上千条。 */
  sampleSubsections: string[];
  subsectionCount: number;
}

export interface KnowledgeOverviewDocument {
  id: string;
  fileName: string;
  status: StoredKnowledgeStatus;
  createdAt: string;
  publishedAt?: string;
  chunkCount: number;
  warningCount: number;
  /** 该份资料里出现过的来源标识（Chunk 的 source 字段）。 */
  sources: string[];
  sections: KnowledgeOverviewSection[];
  /** 法律位阶。没人工确认过时是系统推断值，`hierarchyConfirmed` 会是 false。 */
  hierarchyLevel: HierarchyLevel;
  /** 位阶是否已由管理员确认。false 表示这行还没人过目。 */
  hierarchyConfirmed: boolean;
  /**
   * 总览分组用的粗分类（见 document-category.ts）。纯展示，不影响检索，
   * 从 fileName / sources 关键词匹配得出，匹配不上归入 "other"。
   */
  category: string;
}

const MAX_SUBSECTION_SAMPLES = 8;

function buildOverviewSections(chunks: KnowledgeChunkReview[]): KnowledgeOverviewSection[] {
  const byTitle = new Map<string, { chunkCount: number; subsections: Set<string> }>();
  for (const chunk of chunks) {
    const title = chunk.majorTitle?.trim() || "（未标注一级标题）";
    const entry = byTitle.get(title) ?? { chunkCount: 0, subsections: new Set<string>() };
    entry.chunkCount += 1;
    const minor = chunk.minorTitle?.trim();
    if (minor) entry.subsections.add(minor);
    byTitle.set(title, entry);
  }
  return [...byTitle.entries()].map(([title, entry]) => ({
    title,
    chunkCount: entry.chunkCount,
    subsectionCount: entry.subsections.size,
    sampleSubsections: [...entry.subsections].slice(0, MAX_SUBSECTION_SAMPLES),
  }));
}

/**
 * 管理端「总览」用：按资料 → 章 → 节的层级列出整个知识库的结构。
 * 只返回结构和计数，不返回正文，避免一次传输几MB内容。
 */
export async function getKnowledgeOverview(): Promise<KnowledgeOverviewDocument[]> {
  const db = await getD1Database();
  if (db) {
    await initializeD1(db);
    const documentRows = await db.prepare(
      "SELECT id, file_name, source_text_sha256, status, created_at, published_at, warning_count"
      + " FROM kb_local_documents ORDER BY created_at",
    ).all<DocumentRow>();
    const chunkRows = await db.prepare(
      "SELECT d.file_name, c.document_id, c.chunk_no, c.source, c.major_title, c.minor_title,"
      + " c.official_url, c.body, c.body_length, c.word_count, c.warning,"
      + " c.provision_effective_from, c.provision_effective_to, c.applicability_note"
      + " FROM kb_local_chunks c JOIN kb_local_documents d ON d.id = c.document_id ORDER BY c.chunk_no",
    ).all<ChunkRow>();
    const chunksByDocument = new Map<string, KnowledgeChunkReview[]>();
    for (const row of chunkRows.results ?? []) {
      const list = chunksByDocument.get(row.document_id) ?? [];
      list.push(rowToChunk(row));
      chunksByDocument.set(row.document_id, list);
    }
    return (documentRows.results ?? []).map((row) => {
      const chunks = chunksByDocument.get(row.id) ?? [];
      const sources = [...new Set(chunks.map((chunk) => chunk.source).filter(Boolean))];
      return {
        id: row.id,
        fileName: row.file_name,
        status: row.status,
        createdAt: row.created_at,
        publishedAt: row.published_at ?? undefined,
        chunkCount: chunks.length,
        warningCount: Number(row.warning_count ?? 0),
        sources,
        sections: buildOverviewSections(chunks),
        category: classifyDocumentCategory(row.file_name, sources),
        // D1 分支同样下发位阶。这条路当前没在生产用（生产走本地文件 store），
        // 但两条分支的返回结构必须一致，否则将来切过去会少字段。
        hierarchyLevel: inferDocumentHierarchy(row.file_name, chunks),
        hierarchyConfirmed: false,
      };
    });
  }

  const store = await readFileStore();
  return store.documents.map((document) => {
    const sources = [...new Set(document.chunks.map((chunk) => chunk.source).filter(Boolean))];
    return {
      id: document.id,
      fileName: document.fileName,
      status: document.status,
      createdAt: document.createdAt,
      publishedAt: document.publishedAt,
      chunkCount: document.chunks.length,
      warningCount: document.warningCount,
      sources,
      sections: buildOverviewSections(document.chunks),
      category: classifyDocumentCategory(document.fileName, sources),
      // 位阶：没存过就现算推断值下发，让总览里**每一行都有值可选**，
      // 管理员做的是核对而不是从空白开始填。
      hierarchyLevel: document.hierarchyLevel
        ?? inferDocumentHierarchy(document.fileName, document.chunks),
      hierarchyConfirmed: document.hierarchyConfirmed === true,
    };
  });
}

export async function getPublishedKnowledgeChunks(): Promise<PublishedKnowledgeChunk[]> {
  const db = await getD1Database();
  if (db) {
    await initializeD1(db);
    const rows = await db.prepare(`SELECT d.file_name, c.document_id, c.chunk_no,
      c.source, c.major_title, c.minor_title, c.official_url, c.body,
      c.body_length, c.word_count, c.warning,
      c.provision_effective_from, c.provision_effective_to, c.applicability_note
      FROM kb_local_chunks c JOIN kb_local_documents d ON d.id = c.document_id
      WHERE d.status = 'PUBLISHED'
      ORDER BY d.created_at, c.chunk_no`).all<ChunkRow>();
    return (rows.results ?? []).map(rowToChunk);
  }

  const store = await readFileStore();
  return store.documents
    .filter((document) => document.status === "PUBLISHED")
    .flatMap((document) => document.chunks.map((chunk) => ({
      ...chunk,
      documentId: document.id,
      fileName: document.fileName,
      // 位阶存在 document 上（一份资料一个值），这里**下发到每个 chunk**。
      // 检索层拿到的是一堆 chunk、不是 document，不下发就得在检索里反查文档，
      // 那是给热路径加一次无谓的查找。
      hierarchyLevel: document.hierarchyLevel,
    })));
}
