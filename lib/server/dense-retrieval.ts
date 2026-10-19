import type { PublishedKnowledgeChunk } from "./knowledge-store";
import { cosineSimilarity, embedTexts, isEmbeddingConfigured } from "./embeddings";
import { chunkVectorKey } from "./retrieval";
import { decodeVector, readVectorIndex, vectorKey } from "./vector-store";

/**
 * 查询侧的向量检索：把每个法律要件各转成一条向量，再和库里每个 Chunk 的向量算余弦相似度。
 *
 * 设计上的三个取舍：
 * 1. 按「法律要件」分别向量化，而不是整句问题一条向量——因为下游的证据配额本来就是
 *    按要件分配的，每个要件有自己的排序，命中率比一条大向量高。要件最多4个，
 *    一次批量请求就够，不会明显拖慢响应。
 * 2. 一个 Chunk 若因过长被切成多个分窗，取分窗里的最大相似度作为该 Chunk 的分数。
 * 3. 任何一步失败（没配密钥、向量没算、接口超时）都返回 undefined，
 *    让检索自动退回纯关键词——**宁可少一路召回，也不能让问答整体挂掉**。
 */
export function isHybridRetrievalEnabled() {
  const flag = process.env.HYBRID_RETRIEVAL?.trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  return isEmbeddingConfigured();
}

export async function computeDenseScores(
  chunks: PublishedKnowledgeChunk[],
  elements: string[],
  englishQuery: string,
  /** 要件标签 → 用于向量化的完整文本（中文标签 + 英文检索词）。缺省时只用标签。 */
  inputByElement?: Map<string, string>,
): Promise<Map<string, Map<string, number>> | undefined> {
  if (!isHybridRetrievalEnabled() || elements.length === 0) return undefined;

  try {
    const index = await readVectorIndex();
    if (index.size === 0) return undefined;

    // 只保留本次候选 Chunk 的向量，避免对全库做无谓的解码和计算。
    const candidates: Array<{ key: string; vectors: Float32Array[] }> = [];
    for (const chunk of chunks) {
      const entry = index.get(vectorKey(chunk.documentId, chunk.number));
      if (!entry) continue;
      candidates.push({
        key: chunkVectorKey(chunk),
        vectors: entry.windows.map((window) => decodeVector(window)),
      });
    }
    if (candidates.length === 0) return undefined;

    // 要件本身比较短，拼上英文检索句一起向量化，语义更完整。
    const inputs = elements.map((element) =>
      `${inputByElement?.get(element) ?? element}. ${englishQuery}`.trim());
    const elementVectors = await embedTexts(inputs);

    const byElement = new Map<string, Map<string, number>>();
    elements.forEach((element, position) => {
      const queryVector = elementVectors[position];
      if (!queryVector) return;
      const scores = new Map<string, number>();
      for (const candidate of candidates) {
        let best = 0;
        for (const vector of candidate.vectors) {
          const similarity = cosineSimilarity(queryVector, vector);
          if (similarity > best) best = similarity;
        }
        if (best > 0) scores.set(candidate.key, best);
      }
      if (scores.size > 0) byElement.set(element, scores);
    });

    return byElement.size > 0 ? byElement : undefined;
  } catch (error) {
    console.error(
      "[dense-retrieval] 向量检索失败，本次退回纯关键词检索：",
      error instanceof Error ? error.message : "unknown error",
    );
    return undefined;
  }
}
