/**
 * 巡检记录与补回计数的本地持久化。
 *
 * 与 knowledge-store.ts 一样，开发环境走本地 JSON 文件；
 * 生产切换到腾讯云 PostgreSQL 时，用 db/schema.ts 里的
 * kb_inspections 与 feedback_restore_counters 两张表替换本文件的读写即可，
 * 上层 API 不需要改。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InspectableDocument, InspectionLine } from "./inspection";
import type { RestoreCounter } from "./quota-restore";
import { previousYearMonth, yearMonthOf } from "./quota-restore";

export interface InspectionRecord {
  id: string;
  documentId?: string;
  line: InspectionLine;
  domain?: string;
  fingerprintBefore?: string;
  fingerprintAfter?: string;
  changeDetected: boolean;
  conclusion: string;
  actorUserId?: string;
  createdAt: string;
}

export interface AuditRecord {
  id: string;
  action: string;
  objectType: string;
  objectId: string;
  actorUserId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface ComplianceStoreFile {
  schemaVersion: "1.4";
  documents: InspectableDocument[];
  inspections: InspectionRecord[];
  restoreCounters: Record<string, RestoreCounter[]>;
  frozenUsers: Record<string, string>;
  restoredRequests: string[];
  auditLogs: AuditRecord[];
}

const dataDirectory = process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "compliance-store.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): ComplianceStoreFile {
  return {
    schemaVersion: "1.4",
    documents: [],
    inspections: [],
    restoreCounters: {},
    frozenUsers: {},
    restoredRequests: [],
    auditLogs: [],
  };
}

async function readStore(): Promise<ComplianceStoreFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ComplianceStoreFile>;
    return { ...emptyStore(), ...parsed } as ComplianceStoreFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(store: ComplianceStoreFile) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, storePath);
}

function serialized<T>(operation: (store: ComplianceStoreFile) => Promise<T> | T): Promise<T> {
  const run = async () => {
    const store = await readStore();
    const result = await operation(store);
    await writeStore(store);
    return result;
  };
  const result = mutationQueue.then(run, run);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function listInspectableDocuments(): Promise<InspectableDocument[]> {
  const store = await readStore();
  return store.documents;
}

export async function upsertInspectableDocument(document: InspectableDocument) {
  return serialized((store) => {
    const index = store.documents.findIndex((item) => item.id === document.id);
    if (index >= 0) store.documents[index] = { ...store.documents[index], ...document };
    else store.documents.push(document);
    return store.documents.find((item) => item.id === document.id)!;
  });
}

export async function recordInspection(input: Omit<InspectionRecord, "id" | "createdAt"> & {
  /** 无变化时自动推进法律现行性核验时间。 */
  advanceCurrencyCheckedAt?: boolean;
  advanceLinkCheckedAt?: boolean;
}) {
  return serialized((store) => {
    const now = new Date().toISOString();
    const record: InspectionRecord = {
      id: randomUUID(),
      documentId: input.documentId,
      line: input.line,
      domain: input.domain,
      fingerprintBefore: input.fingerprintBefore,
      fingerprintAfter: input.fingerprintAfter,
      changeDetected: input.changeDetected,
      conclusion: input.conclusion,
      actorUserId: input.actorUserId,
      createdAt: now,
    };
    store.inspections.push(record);

    if (input.documentId) {
      const document = store.documents.find((item) => item.id === input.documentId);
      if (document) {
        if (input.advanceCurrencyCheckedAt) {
          document.legalCurrencyCheckedAt = now;
          if (input.fingerprintAfter) document.versionFingerprint = input.fingerprintAfter;
        }
        if (input.advanceLinkCheckedAt) document.linkCheckedAt = now;
      }
    }

    store.auditLogs.push({
      id: randomUUID(),
      action: "KB_INSPECTION",
      objectType: "kb_document",
      objectId: input.documentId ?? input.domain ?? "unknown",
      actorUserId: input.actorUserId,
      metadata: {
        line: input.line,
        conclusion: input.conclusion,
        changeDetected: input.changeDetected,
        fingerprintBefore: input.fingerprintBefore,
        fingerprintAfter: input.fingerprintAfter,
        advancedCurrency: Boolean(input.advanceCurrencyCheckedAt),
      },
      createdAt: now,
    });
    return record;
  });
}

export async function listInspections(limit = 100) {
  const store = await readStore();
  return store.inspections.slice(-limit).reverse();
}

/** 读取补回上下文：本月与上月计数、冻结状态、该回答是否已补回。 */
export async function readRestoreContext(userId: string, requestId: string, now = new Date()) {
  const store = await readStore();
  const month = yearMonthOf(now);
  const previous = previousYearMonth(month);
  const counters = store.restoreCounters[userId] ?? [];
  return {
    frozen: Boolean(store.frozenUsers[userId]),
    alreadyRestored: store.restoredRequests.includes(`${userId}::${requestId}`),
    currentMonth: counters.find((item) => item.yearMonth === month)
      ?? { yearMonth: month, restoredCount: 0 },
    previousMonth: counters.find((item) => item.yearMonth === previous),
  };
}

export async function commitRestore(input: {
  userId: string;
  requestId: string;
  reason: string;
  decision: string;
  restored: boolean;
  nextCounter: RestoreCounter;
  shouldFreeze: boolean;
  auditNote: string;
  operatorUserId?: string;
  originalLedgerId?: string;
}) {
  return serialized((store) => {
    const now = new Date().toISOString();
    const counters = store.restoreCounters[input.userId] ?? [];
    const index = counters.findIndex((item) => item.yearMonth === input.nextCounter.yearMonth);
    if (index >= 0) counters[index] = input.nextCounter;
    else counters.push(input.nextCounter);
    store.restoreCounters[input.userId] = counters;

    if (input.restored) {
      store.restoredRequests.push(`${input.userId}::${input.requestId}`);
    }
    if (input.shouldFreeze && !store.frozenUsers[input.userId]) {
      store.frozenUsers[input.userId] = now;
      store.auditLogs.push({
        id: randomUUID(),
        action: "RESTORE_FROZEN",
        objectType: "user",
        objectId: input.userId,
        actorUserId: input.operatorUserId,
        metadata: { reason: "连续两个自然月触及补回上限", frozenAt: now },
        createdAt: now,
      });
    }

    store.auditLogs.push({
      id: randomUUID(),
      action: "FEEDBACK_RESTORE",
      objectType: "answer_request",
      objectId: input.requestId,
      actorUserId: input.operatorUserId ?? input.userId,
      metadata: {
        decision: input.decision,
        restored: input.restored,
        reason: input.reason,
        originalLedgerId: input.originalLedgerId,
        monthlyCount: input.nextCounter.restoredCount,
        note: input.auditNote,
      },
      createdAt: now,
    });
    return { frozen: Boolean(store.frozenUsers[input.userId]) };
  });
}

/** 解除冻结，必须留审计。 */
export async function unfreezeRestore(userId: string, operatorUserId: string, note: string) {
  return serialized((store) => {
    delete store.frozenUsers[userId];
    store.auditLogs.push({
      id: randomUUID(),
      action: "RESTORE_UNFROZEN",
      objectType: "user",
      objectId: userId,
      actorUserId: operatorUserId,
      metadata: { note },
      createdAt: new Date().toISOString(),
    });
    return true;
  });
}

export async function listAuditLogs(limit = 100) {
  const store = await readStore();
  return store.auditLogs.slice(-limit).reverse();
}
