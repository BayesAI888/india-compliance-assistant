import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { EMBEDDING_DIMENSION } from "./embeddings";

/**
 * 向量的落盘存储。
 *
 * 刻意不和 knowledge-store.json 放一起：向量是可以随时重算的派生数据，
 * 和"管理员审核发布过的正文"不是一个性质，混在一起会让那份文件膨胀十几倍、
 * 也不方便出问题时单独删掉重算。
 *
 * 向量用 base64 编码的 Float32Array 存（每条约4KB），比直接存JSON数字数组小三倍左右。
 */

const dataDirectory = process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "knowledge-vectors.json");

/** 一个 Chunk 可能因为过长被切成多个分窗，每个分窗一条向量。 */
export interface ChunkVectors {
  documentId: string;
  chunkNo: number;
  /** 每个分窗一条 base64(Float32Array)。 */
  windows: string[];
  /** 生成这批向量时用的模型，换模型后必须整体重算，靠这个字段识别。 */
  model: string;
  embeddedAt: string;
}

interface VectorStoreFile {
  schemaVersion: "1.0";
  vectors: ChunkVectors[];
}

const EMPTY_STORE: VectorStoreFile = { schemaVersion: "1.0", vectors: [] };

export function encodeVector(values: number[]): string {
  const floats = Float32Array.from(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

export function decodeVector(encoded: string): Float32Array {
  const buffer = Buffer.from(encoded, "base64");
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

export function vectorKey(documentId: string, chunkNo: number): string {
  return `${documentId}::${chunkNo}`;
}

let cache: VectorStoreFile | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();

function serializedMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.catch(() => undefined);
  return result;
}

async function readStore(): Promise<VectorStoreFile> {
  if (cache) return cache;
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as VectorStoreFile;
    cache = Array.isArray(parsed?.vectors) ? parsed : EMPTY_STORE;
  } catch {
    cache = EMPTY_STORE;
  }
  return cache;
}

async function writeStore(store: VectorStoreFile) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, storePath);
  cache = store;
}

/** 读出全部向量，按 documentId::chunkNo 建索引，检索时用。 */
export async function readVectorIndex(): Promise<Map<string, ChunkVectors>> {
  const store = await readStore();
  return new Map(store.vectors.map((entry) => [vectorKey(entry.documentId, entry.chunkNo), entry]));
}

/** 覆盖式写入某一份文档的全部向量（重新发布或补算时调用）。 */
export async function saveDocumentVectors(documentId: string, entries: ChunkVectors[]): Promise<void> {
  await serializedMutation(async () => {
    const store = await readStore();
    const kept = store.vectors.filter((entry) => entry.documentId !== documentId);
    await writeStore({ schemaVersion: "1.0", vectors: [...kept, ...entries] });
  });
}

export async function deleteDocumentVectors(documentId: string): Promise<void> {
  await serializedMutation(async () => {
    const store = await readStore();
    await writeStore({
      schemaVersion: "1.0",
      vectors: store.vectors.filter((entry) => entry.documentId !== documentId),
    });
  });
}

export interface VectorCoverage {
  vectorizedChunks: number;
  documents: number;
  models: string[];
  dimension: number;
}

export async function getVectorCoverage(): Promise<VectorCoverage> {
  const store = await readStore();
  return {
    vectorizedChunks: store.vectors.length,
    documents: new Set(store.vectors.map((entry) => entry.documentId)).size,
    models: [...new Set(store.vectors.map((entry) => entry.model))],
    dimension: EMBEDDING_DIMENSION,
  };
}
