import type { KnowledgeChunkReview } from "../contracts";
import { MAX_INPUT_CHARS, embedTexts, isEmbeddingConfigured, splitIntoWindows } from "./embeddings";
import { getPublishedKnowledgeChunks } from "./knowledge-store";
import { encodeVector, readVectorIndex, saveDocumentVectors, vectorKey, type ChunkVectors } from "./vector-store";

/**
 * 把已发布的 Chunk 转成向量并落盘。
 *
 * 向量化的文本 = 标题 + 正文。标题（来源 / 章 / 节）信息密度很高——
 * "CHAPTER IV - SHARE CAPITAL … Section 62 - Further issue of share capital" 这一行
 * 本身就几乎回答了"增资依据哪一条"，不带进去很浪费。
 */

export interface IndexingSummary {
  processedChunks: number;
  vectorizedChunks: number;
  failedChunks: number;
  skippedExisting: number;
  model: string;
}

function embeddingInputs(chunk: { source: string; majorTitle: string; minorTitle: string; body: string }) {
  // 标题本身可能有两三百字符，必须从可用宽度里先扣掉，否则「标题+正文」会超过
  // 接口的 2000 字符上限被静默截断——截断不会报错，只会让那段内容永远检索不到。
  const rawHeading = [chunk.source, chunk.majorTitle, chunk.minorTitle].filter(Boolean).join(" · ");
  const heading = rawHeading.slice(0, Math.floor(MAX_INPUT_CHARS / 3));
  const available = MAX_INPUT_CHARS - heading.length - 2;
  return splitIntoWindows(chunk.body, available)
    .map((window) => `${heading}\n\n${window}`.slice(0, MAX_INPUT_CHARS));
}

/**
 * 给指定文档（不传则全部已发布文档）补算向量。
 * `force=false` 时跳过已经有向量的 Chunk，便于增量补算而不重复烧钱。
 */
export async function indexPublishedChunks(options: {
  documentId?: string;
  force?: boolean;
} = {}): Promise<IndexingSummary> {
  const model = process.env.EMBEDDING_MODEL?.trim() || "kinfra-text-embedding-4b";
  const summary: IndexingSummary = {
    processedChunks: 0,
    vectorizedChunks: 0,
    failedChunks: 0,
    skippedExisting: 0,
    model,
  };
  if (!isEmbeddingConfigured()) {
    throw new Error("EMBEDDING_API_KEY 未配置，无法生成向量。");
  }

  const allChunks = await getPublishedKnowledgeChunks();
  const scoped = options.documentId
    ? allChunks.filter((chunk) => chunk.documentId === options.documentId)
    : allChunks;
  if (scoped.length === 0) return summary;

  const existing = await readVectorIndex();

  // 按文档分组：向量按文档覆盖写入，避免一次失败污染其他文档已有的向量。
  const byDocument = new Map<string, typeof scoped>();
  for (const chunk of scoped) {
    byDocument.set(chunk.documentId, [...(byDocument.get(chunk.documentId) ?? []), chunk]);
  }

  for (const [documentId, chunks] of byDocument) {
    const entries: ChunkVectors[] = [];
    // 先把这份文档已有、且本次不需要重算的向量原样保留下来。
    const pending: Array<{ chunk: (typeof chunks)[number]; inputs: string[] }> = [];
    for (const chunk of chunks) {
      summary.processedChunks += 1;
      const previous = existing.get(vectorKey(documentId, chunk.number));
      if (!options.force && previous && previous.model === model && previous.windows.length > 0) {
        entries.push(previous);
        summary.skippedExisting += 1;
        continue;
      }
      pending.push({ chunk, inputs: embeddingInputs(chunk) });
    }

    if (pending.length > 0) {
      // 展平成一维再批量请求，回来按窗口数切回去。
      const flatInputs = pending.flatMap((item) => item.inputs);
      const vectors = await embedTexts(flatInputs);
      let cursor = 0;
      for (const item of pending) {
        const slice = vectors.slice(cursor, cursor + item.inputs.length);
        cursor += item.inputs.length;
        const windows = slice.filter((vector): vector is number[] => Array.isArray(vector));
        if (windows.length === 0) {
          summary.failedChunks += 1;
          continue;
        }
        entries.push({
          documentId,
          chunkNo: item.chunk.number,
          windows: windows.map((vector) => encodeVector(vector)),
          model,
          embeddedAt: new Date().toISOString(),
        });
        summary.vectorizedChunks += 1;
      }
    }

    await saveDocumentVectors(documentId, entries);
  }

  return summary;
}

/** 发布文档后自动补算向量。失败只记日志，绝不影响发布本身。 */
export async function indexAfterPublish(documentId: string): Promise<void> {
  if (!isEmbeddingConfigured()) return;
  try {
    await indexPublishedChunks({ documentId });
  } catch (error) {
    console.error(
      "[vector-indexer] 发布后生成向量失败，该文档暂时只能被关键词检索到：",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

export type { KnowledgeChunkReview };
