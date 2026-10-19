/**
 * 问答运营审计记录。
 *
 * 会话历史服务于用户继续对话；本文件服务于后台排障。两者分开，才能记录额度耗尽、
 * 超范围、模型不可用等不会进入用户会话上下文的结果，又不污染下一轮的法律判断。
 *
 * 未配置 DATABASE_URL 时以单机 JSON 兼容现有部署；配置后只写 PostgreSQL。
 * 上传文件原文、Cookie、密码和任何密钥绝不写进审计记录。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import type { AnswerResponse, AnswerStatus, Citation, FailureCode } from "../contracts";
import type { ConversationTurn } from "./conversation-store";
import type { IncomeTaxTimeResolution } from "./income-tax-time";
import type { TopicRelation } from "./question-context";

export type QuestionAuditStatus = AnswerStatus | "PROCESSING" | "QUOTA_EXHAUSTED";

export interface QuestionAuditCitation {
  title: string;
  locator: string;
  authority: string;
  officialUrl: string;
}

export interface QuestionAuditRecord {
  id: string;
  requestId: string;
  conversationId: string;
  /** 未登录试用保留 undefined；后台展示时不能把空值误写成某个用户。 */
  userId?: string;
  askedAt: string;
  displayQuestion: string;
  /** 供检索/模型使用的自足问题。初始等于用户原问，追问改写后更新。 */
  selfContainedQuestion: string;
  status: QuestionAuditStatus;
  /** 已完成分析不等于已交付：额度复核可能在生成后拦住用户端返回。 */
  deliveryStatus?: "DELIVERED" | "BLOCKED_BY_QUOTA";
  failureCode?: FailureCode | "QUOTA_EXHAUSTED";
  shortConclusion?: string;
  chargeEligible?: boolean;
  usedFollowUpCredit?: boolean;
  topicRelation?: TopicRelation | "FIRST";
  rewriteLog?: ConversationTurn["rewriteLog"];
  incomeTaxTime?: IncomeTaxTimeResolution;
  citationCount: number;
  citations: QuestionAuditCitation[];
  completedAt?: string;
}

/** 管理员按需打开完整回答时留下的访问日志，不含回答正文。 */
export interface QuestionAnswerViewEvent {
  id: string;
  requestId: string;
  conversationId: string;
  adminUsername: string;
  viewedAt: string;
  outcome: "VIEWED" | "UNAVAILABLE";
}

interface QuestionAuditStoreFile {
  schemaVersion: "1.0";
  records: QuestionAuditRecord[];
}

interface QuestionAnswerViewStoreFile {
  schemaVersion: "1.0";
  events: QuestionAnswerViewEvent[];
}

export const MAX_QUESTION_AUDIT_AGE_DAYS = 90;
export const MAX_QUESTION_AUDIT_RECORDS = 10_000;
export const MAX_QUESTION_ANSWER_VIEW_EVENTS = 50_000;

const dataDirectory = process.env.LOCAL_AUDIT_DIR?.trim()
  || process.env.LOCAL_CONVERSATION_DIR?.trim()
  || process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "question-audit-store.json");
const answerViewStorePath = path.join(dataDirectory, "question-answer-view-log.json");
let mutationQueue: Promise<unknown> = Promise.resolve();
let answerViewMutationQueue: Promise<unknown> = Promise.resolve();
let postgresClient: ReturnType<typeof postgres> | undefined;
let postgresUrl: string | undefined;

/** `DATABASE_URL` 配置后，审计记录只写 PostgreSQL，不悄悄降级回本机文件。 */
function databaseClient() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return undefined;
  if (!postgresClient || postgresUrl !== url) {
    postgresClient = postgres(url, {
      max: 2,
      connect_timeout: 5,
      idle_timeout: 20,
      prepare: false,
    });
    postgresUrl = url;
  }
  return postgresClient;
}

function emptyStore(): QuestionAuditStoreFile {
  return { schemaVersion: "1.0", records: [] };
}

async function readStore(): Promise<QuestionAuditStoreFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as QuestionAuditStoreFile;
    return Array.isArray(parsed.records) ? parsed : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(store: QuestionAuditStoreFile) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, storePath);
}

function emptyAnswerViewStore(): QuestionAnswerViewStoreFile {
  return { schemaVersion: "1.0", events: [] };
}

async function readAnswerViewStore(): Promise<QuestionAnswerViewStoreFile> {
  try {
    const raw = await readFile(answerViewStorePath, "utf8");
    const parsed = JSON.parse(raw) as QuestionAnswerViewStoreFile;
    return Array.isArray(parsed.events) ? parsed : emptyAnswerViewStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAnswerViewStore();
    throw error;
  }
}

async function writeAnswerViewStore(store: QuestionAnswerViewStoreFile) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${answerViewStorePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, answerViewStorePath);
}

function serializedMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function serializedAnswerViewMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = answerViewMutationQueue.then(operation, operation);
  answerViewMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function prune(records: QuestionAuditRecord[], now = new Date()): QuestionAuditRecord[] {
  const cutoff = now.getTime() - MAX_QUESTION_AUDIT_AGE_DAYS * 24 * 60 * 60 * 1000;
  return records
    .filter((record) => new Date(record.askedAt).getTime() >= cutoff)
    .sort((left, right) => right.askedAt.localeCompare(left.askedAt))
    .slice(0, MAX_QUESTION_AUDIT_RECORDS);
}

function pruneAnswerViewEvents(events: QuestionAnswerViewEvent[], now = new Date()): QuestionAnswerViewEvent[] {
  const cutoff = now.getTime() - MAX_QUESTION_AUDIT_AGE_DAYS * 24 * 60 * 60 * 1000;
  return events
    .filter((event) => new Date(event.viewedAt).getTime() >= cutoff)
    .sort((left, right) => right.viewedAt.localeCompare(left.viewedAt))
    .slice(0, MAX_QUESTION_ANSWER_VIEW_EVENTS);
}

function auditCitations(citations: Citation[]): QuestionAuditCitation[] {
  return citations.map((citation) => ({
    title: citation.display_title,
    locator: citation.locator,
    authority: citation.authority,
    officialUrl: citation.official_url,
  }));
}

function recordFromDatabase(value: unknown): QuestionAuditRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<QuestionAuditRecord>;
  return typeof record.requestId === "string" && typeof record.conversationId === "string"
    && typeof record.displayQuestion === "string" && typeof record.selfContainedQuestion === "string"
    ? record as QuestionAuditRecord
    : null;
}

async function pruneDatabaseRecords(client: NonNullable<ReturnType<typeof databaseClient>>) {
  const cutoff = new Date(Date.now() - MAX_QUESTION_AUDIT_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await client`DELETE FROM question_audit_records WHERE asked_at < ${cutoff}`;
  await client`
    DELETE FROM question_audit_records
    WHERE request_id IN (
      SELECT request_id FROM question_audit_records
      ORDER BY asked_at DESC
      OFFSET ${MAX_QUESTION_AUDIT_RECORDS}
    )
  `;
  await client`DELETE FROM question_answer_view_events WHERE viewed_at < ${cutoff}`;
}

async function insertDatabaseRecord(record: QuestionAuditRecord) {
  const client = databaseClient();
  if (!client) return false;
  await client`
    INSERT INTO question_audit_records (
      request_id, conversation_id, user_id, asked_at, status, delivery_status,
      failure_code, completed_at, record
    ) VALUES (
      ${record.requestId}, ${record.conversationId}, ${record.userId ?? null},
      ${record.askedAt}, ${record.status}, ${record.deliveryStatus ?? null},
      ${record.failureCode ?? null}, ${record.completedAt ?? null}, ${client.json(record)}
    )
    ON CONFLICT (request_id) DO UPDATE SET
      conversation_id = EXCLUDED.conversation_id,
      user_id = EXCLUDED.user_id,
      asked_at = EXCLUDED.asked_at,
      status = EXCLUDED.status,
      delivery_status = EXCLUDED.delivery_status,
      failure_code = EXCLUDED.failure_code,
      completed_at = EXCLUDED.completed_at,
      record = EXCLUDED.record
  `;
  await pruneDatabaseRecords(client);
  return true;
}

async function readDatabaseRecord(requestId: string) {
  const client = databaseClient();
  if (!client) return null;
  const rows = await client<{ record: unknown }[]>`
    SELECT record FROM question_audit_records WHERE request_id = ${requestId} LIMIT 1
  `;
  return recordFromDatabase(rows[0]?.record);
}

export async function getQuestionAuditByRequestId(requestId: string): Promise<QuestionAuditRecord | null> {
  const client = databaseClient();
  if (client) return readDatabaseRecord(requestId);
  const store = await readStore();
  return store.records.find((record) => record.requestId === requestId) ?? null;
}

export async function recordQuestionAnswerView(input: {
  requestId: string;
  conversationId: string;
  adminUsername: string;
  outcome: QuestionAnswerViewEvent["outcome"];
}): Promise<QuestionAnswerViewEvent> {
  const event: QuestionAnswerViewEvent = {
    id: `qview_${randomUUID()}`,
    requestId: input.requestId,
    conversationId: input.conversationId,
    adminUsername: input.adminUsername,
    viewedAt: new Date().toISOString(),
    outcome: input.outcome,
  };
  const client = databaseClient();
  if (client) {
    await client`
      INSERT INTO question_answer_view_events (
        id, request_id, conversation_id, admin_username, viewed_at, outcome
      ) VALUES (
        ${event.id}, ${event.requestId}, ${event.conversationId}, ${event.adminUsername},
        ${event.viewedAt}, ${event.outcome}
      )
    `;
    const cutoff = new Date(Date.now() - MAX_QUESTION_AUDIT_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await client`DELETE FROM question_answer_view_events WHERE viewed_at < ${cutoff}`;
    return event;
  }

  return serializedAnswerViewMutation(async () => {
    const store = await readAnswerViewStore();
    store.events = pruneAnswerViewEvents([event, ...store.events], new Date(event.viewedAt));
    await writeAnswerViewStore(store);
    return event;
  });
}

export async function listQuestionAnswerViews(requestId: string, limit = 20): Promise<QuestionAnswerViewEvent[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const client = databaseClient();
  if (client) {
    return client<QuestionAnswerViewEvent[]>`
      SELECT
        id,
        request_id AS "requestId",
        conversation_id AS "conversationId",
        admin_username AS "adminUsername",
        viewed_at AS "viewedAt",
        outcome
      FROM question_answer_view_events
      WHERE request_id = ${requestId}
      ORDER BY viewed_at DESC
      LIMIT ${boundedLimit}
    `;
  }
  const store = await readAnswerViewStore();
  return pruneAnswerViewEvents(store.events)
    .filter((event) => event.requestId === requestId)
    .slice(0, boundedLimit);
}

export async function beginQuestionAudit(input: {
  requestId: string;
  conversationId: string;
  userId?: string;
  displayQuestion: string;
  selfContainedQuestion: string;
}) {
  const askedAt = new Date().toISOString();
  const record: QuestionAuditRecord = {
    id: `qlog_${randomUUID()}`,
    requestId: input.requestId,
    conversationId: input.conversationId,
    ...(input.userId ? { userId: input.userId } : {}),
    askedAt,
    displayQuestion: input.displayQuestion,
    selfContainedQuestion: input.selfContainedQuestion,
    status: "PROCESSING",
    citationCount: 0,
    citations: [],
  };
  if (await insertDatabaseRecord(record)) return record;

  return serializedMutation(async () => {
    const store = await readStore();
    store.records = prune([record, ...store.records], new Date(askedAt));
    await writeStore(store);
    return record;
  });
}

export async function completeQuestionAudit(input: {
  requestId: string;
  response: AnswerResponse;
  selfContainedQuestion: string;
  topicRelation: TopicRelation | "FIRST";
  rewriteLog?: ConversationTurn["rewriteLog"];
  incomeTaxTime?: IncomeTaxTimeResolution;
  usedFollowUpCredit?: boolean;
  deliveryStatus?: "DELIVERED" | "BLOCKED_BY_QUOTA";
}) {
  if (databaseClient()) {
    const databaseRecord = await readDatabaseRecord(input.requestId);
    if (!databaseRecord) return null;
    databaseRecord.selfContainedQuestion = input.selfContainedQuestion;
    databaseRecord.status = input.response.answer_status;
    databaseRecord.deliveryStatus = input.deliveryStatus ?? "DELIVERED";
    databaseRecord.failureCode = input.response.failure_code;
    databaseRecord.shortConclusion = input.response.short_conclusion;
    databaseRecord.chargeEligible = input.response.charge_eligible;
    databaseRecord.usedFollowUpCredit = input.usedFollowUpCredit ?? false;
    databaseRecord.topicRelation = input.topicRelation;
    databaseRecord.rewriteLog = input.rewriteLog;
    databaseRecord.incomeTaxTime = input.incomeTaxTime;
    databaseRecord.citationCount = input.response.citations.length;
    databaseRecord.citations = auditCitations(input.response.citations);
    databaseRecord.completedAt = new Date().toISOString();
    await insertDatabaseRecord(databaseRecord);
    return databaseRecord;
  }

  return serializedMutation(async () => {
    const store = await readStore();
    const record = store.records.find((item) => item.requestId === input.requestId);
    if (!record) return null;
    record.selfContainedQuestion = input.selfContainedQuestion;
    record.status = input.response.answer_status;
    record.deliveryStatus = input.deliveryStatus ?? "DELIVERED";
    record.failureCode = input.response.failure_code;
    record.shortConclusion = input.response.short_conclusion;
    record.chargeEligible = input.response.charge_eligible;
    record.usedFollowUpCredit = input.usedFollowUpCredit ?? false;
    record.topicRelation = input.topicRelation;
    record.rewriteLog = input.rewriteLog;
    record.incomeTaxTime = input.incomeTaxTime;
    record.citationCount = input.response.citations.length;
    record.citations = auditCitations(input.response.citations);
    record.completedAt = new Date().toISOString();
    store.records = prune(store.records);
    await writeStore(store);
    return record;
  });
}

export async function markQuestionAuditQuotaExhausted(input: {
  requestId: string;
  selfContainedQuestion: string;
  topicRelation?: TopicRelation | "FIRST";
}) {
  if (databaseClient()) {
    const databaseRecord = await readDatabaseRecord(input.requestId);
    if (!databaseRecord) return null;
    databaseRecord.selfContainedQuestion = input.selfContainedQuestion;
    databaseRecord.status = "QUOTA_EXHAUSTED";
    databaseRecord.deliveryStatus = "BLOCKED_BY_QUOTA";
    databaseRecord.failureCode = "QUOTA_EXHAUSTED";
    databaseRecord.shortConclusion = "用户额度已用完，未调用检索或问答服务。";
    databaseRecord.chargeEligible = false;
    databaseRecord.topicRelation = input.topicRelation;
    databaseRecord.completedAt = new Date().toISOString();
    await insertDatabaseRecord(databaseRecord);
    return databaseRecord;
  }

  return serializedMutation(async () => {
    const store = await readStore();
    const record = store.records.find((item) => item.requestId === input.requestId);
    if (!record) return null;
    record.selfContainedQuestion = input.selfContainedQuestion;
    record.status = "QUOTA_EXHAUSTED";
    record.deliveryStatus = "BLOCKED_BY_QUOTA";
    record.failureCode = "QUOTA_EXHAUSTED";
    record.shortConclusion = "用户额度已用完，未调用检索或问答服务。";
    record.chargeEligible = false;
    record.topicRelation = input.topicRelation;
    record.completedAt = new Date().toISOString();
    store.records = prune(store.records);
    await writeStore(store);
    return record;
  });
}

/** 管理后台只读最近记录；默认不向前端传附件原文或完整回答。 */
export async function listRecentQuestionAudits(limit = 100): Promise<QuestionAuditRecord[]> {
  const client = databaseClient();
  if (client) {
    const rows = await client<{ record: unknown }[]>`
      SELECT record FROM question_audit_records
      ORDER BY asked_at DESC
      LIMIT ${Math.max(1, Math.min(limit, 500))}
    `;
    return rows
      .map((row) => recordFromDatabase(row.record))
      .filter((record): record is QuestionAuditRecord => Boolean(record));
  }
  const store = await readStore();
  return prune(store.records).slice(0, Math.max(1, Math.min(limit, 500)));
}
