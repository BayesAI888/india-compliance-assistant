/**
 * 向量化适配层。默认对接腾讯云 TokenHub 的 kinfra 文本向量模型。
 *
 * 走的是 OpenAI 兼容接口（Bearer 密钥），和 deepseek.ts 写法一致，
 * 换供应商只改环境变量、不用改代码。
 *
 * TokenHub 文本向量的限制（腾讯云文档 1823/133515）：
 *   - kinfra-text-embedding-0.6b → 1024 维；kinfra-text-embedding-4b → 2560 维
 *   - 单条输入不超过 2000 字符
 *   - 单次请求建议不超过 128 条
 *   - 上下文长度 32k，L2 归一化
 * 下面的分窗、分批参数就是按这几条定的。
 */

/** 只用于界面展示；真正的维度以模型实际返回为准，余弦计算不依赖这个常量。 */
export const EMBEDDING_DIMENSION = Number(process.env.EMBEDDING_DIMENSION?.trim()) || 2560;

/** 一次请求最多几条（TokenHub 建议不超过128，留余量）。 */
const BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE?.trim()) || 100;
/** 两次请求之间的最小间隔，防止触发限流。 */
const MIN_REQUEST_INTERVAL_MS = Number(process.env.EMBEDDING_MIN_INTERVAL_MS?.trim()) || 120;

/**
 * 单个分窗的字符上限。
 *
 * TokenHub 的硬限制是**单条 2000 字符**，超出会被截断。截断是最危险的失败方式——
 * 内容还在库里、界面一切正常，但那段文字永远检索不到，不会有任何报错。
 * 所以这里取 1800 留出安全余量。
 *
 * 顺带一提，窗口也不是越大越好：一个几千字符的窗口，向量是好几个主题的"平均值"，
 * 反而模糊；窗口小一些主题更集中、相似度更准，代价只是条数变多（成本和存储）。
 */
const WINDOW_CHARS = Number(process.env.EMBEDDING_WINDOW_CHARS?.trim()) || 1800;
/** 相邻分窗的重叠字符数，防止一句话正好被切断导致两边都匹配不上。 */
const WINDOW_OVERLAP_CHARS = Math.min(150, Math.floor(WINDOW_CHARS / 4));

/**
 * 单条请求内容的绝对上限。
 * TokenHub 的硬限制是 2000 字符，这里留 50 字符余量——
 * 因为实际发送的是「标题 + 正文分窗」，标题（来源·章·节）本身可能有两三百字符，
 * 只按分窗长度控制会溢出并被静默截断。
 */
export const MAX_INPUT_CHARS = Number(process.env.EMBEDDING_MAX_INPUT_CHARS?.trim()) || 1950;

export function isEmbeddingConfigured() {
  return Boolean(process.env.EMBEDDING_API_KEY?.trim());
}

/**
 * 长文本切成多个分窗。
 * 知识库里确实存在 2800、4000 词的超长 Chunk（上传时会提示"建议拆成Part"但不强制），
 * 直接送进去尾部会被静默截断，等于这部分内容永远检索不到——所以这里必须自己分窗，
 * 每个分窗单独存一条向量，检索时取最大相似度。
 */
export function splitIntoWindows(text: string, maxChars = WINDOW_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // 窗口再小也要能装下点东西，防止调用方传入过小的可用宽度导致死循环。
  const size = Math.max(200, maxChars);
  if (trimmed.length <= size) return [trimmed];

  const windows: string[] = [];
  const overlap = Math.min(WINDOW_OVERLAP_CHARS, Math.floor(size / 4));
  const step = size - overlap;
  for (let start = 0; start < trimmed.length; start += step) {
    windows.push(trimmed.slice(start, start + size));
    if (start + size >= trimmed.length) break;
  }
  return windows;
}

let lastRequestAt = 0;

async function respectRateLimit() {
  const waitFor = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (waitFor > 0) await new Promise((resolve) => setTimeout(resolve, waitFor));
  lastRequestAt = Date.now();
}

interface EmbeddingApiResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

async function embedBatch(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
  const apiKey = process.env.EMBEDDING_API_KEY?.trim();
  if (!apiKey) throw new Error("EMBEDDING_API_KEY is not configured.");
  const baseUrl = (process.env.EMBEDDING_API_BASE?.trim()
    || "https://tokenhub.tencentmaas.com/v1").replace(/\/$/, "");
  const model = process.env.EMBEDDING_MODEL?.trim() || "kinfra-text-embedding-4b";

  await respectRateLimit();
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: inputs, encoding_format: "float" }),
    signal: signal ?? AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Embedding request failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as EmbeddingApiResponse;
  const rows = payload.data ?? [];
  // 按 index 归位，不依赖返回顺序。
  const ordered: number[][] = new Array(inputs.length);
  rows.forEach((row, position) => {
    const index = typeof row.index === "number" ? row.index : position;
    if (Array.isArray(row.embedding)) ordered[index] = row.embedding;
  });
  if (ordered.some((vector) => !vector)) {
    throw new Error("Embedding response is missing vectors for some inputs.");
  }
  return ordered;
}

/**
 * 批量向量化。自动分批 + 限速；单批失败时退化为逐条重试，
 * 只有整条都失败才把这条标记为 null，让调用方决定是跳过还是报错。
 */
export async function embedTexts(
  texts: string[],
  options: { signal?: AbortSignal } = {},
): Promise<Array<number[] | null>> {
  const results: Array<number[] | null> = new Array(texts.length).fill(null);
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const slice = texts.slice(start, start + BATCH_SIZE);
    try {
      const vectors = await embedBatch(slice, options.signal);
      vectors.forEach((vector, offset) => { results[start + offset] = vector; });
    } catch {
      // 批量失败（可能是某一条内容触发了限制），逐条再试一遍，避免一条坏数据毁掉整批。
      for (let offset = 0; offset < slice.length; offset += 1) {
        try {
          const [vector] = await embedBatch([slice[offset]], options.signal);
          results[start + offset] = vector ?? null;
        } catch {
          results[start + offset] = null;
        }
      }
    }
  }
  return results;
}

/** 单条文本向量化，查询时用。失败直接抛错，由调用方降级成纯关键词检索。 */
export async function embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
  const [vector] = await embedBatch([text.slice(0, MAX_INPUT_CHARS)], signal);
  return vector;
}

/** 余弦相似度。向量已归一化时等价于点积，但这里不假设归一化。 */
export function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
